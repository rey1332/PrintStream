-- Reports computed in the database.
--
-- ERP → Reports loaded every transaction, invoice, payment and product into
-- the browser (1,000 rows per request, as many requests as needed) and added
-- them up there. With hundreds of weighbridge tickets a day that becomes slow
-- on laptops and unusable on phones. erp_reports_summary() returns the same
-- figures, already totalled: invoices by status, payments in and out, money
-- per month, expenses by category, and stock per product (at most 500,
-- largest value first). Amounts are in the ERP's base currency.
--
-- SECURITY INVOKER: row-level security applies, so the figures cover exactly
-- the rows the caller may read.
--
-- Rollback: db/rollback/rollback_20261012000017_erp_reports_summary.sql

CREATE OR REPLACE FUNCTION public.erp_reports_summary(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  result JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Choose an ERP' USING ERRCODE = '22023';
  END IF;

  WITH inv AS (
    SELECT i.status::TEXT AS status, i.voided_at IS NOT NULL OR i.status = 'void' AS is_void,
           COALESCE(i.base_total, i.total * COALESCE(NULLIF(i.fx_rate, 0), 1)) AS base
      FROM public.erp_invoices i
     WHERE i.workspace_id = p_workspace_id
  ),
  pay AS (
    SELECT to_char(p.payment_date, 'YYYY-MM') AS month, p.payment_type::TEXT AS kind,
           COALESCE(p.base_amount, p.amount * COALESCE(NULLIF(p.fx_rate, 0), 1)) AS base
      FROM public.erp_payments p
     WHERE p.workspace_id = p_workspace_id AND p.voided_at IS NULL
  ),
  txn AS (
    SELECT to_char(t.transaction_date, 'YYYY-MM') AS month, t.transaction_type::TEXT AS kind,
           t.category, t.amount
      FROM public.erp_transactions t
     WHERE t.workspace_id = p_workspace_id
  )
  SELECT jsonb_build_object(
    'counts', jsonb_build_object(
      'invoices', (SELECT count(*) FROM inv),
      'payments', (SELECT count(*) FROM public.erp_payments p WHERE p.workspace_id = p_workspace_id),
      'transactions', (SELECT count(*) FROM txn),
      'products', (SELECT count(*) FROM public.erp_products p WHERE p.workspace_id = p_workspace_id)),
    'revenue', COALESCE((SELECT sum(base) FROM inv WHERE NOT is_void), 0),
    'incoming', COALESCE((SELECT sum(base) FROM pay WHERE kind = 'incoming'), 0),
    'outgoing', COALESCE((SELECT sum(base) FROM pay WHERE kind = 'outgoing'), 0),
    'invoice_status', COALESCE((
      SELECT jsonb_object_agg(s.status, jsonb_build_object('count', s.n, 'total', s.total))
        FROM (SELECT status, count(*) AS n, sum(base) AS total FROM inv GROUP BY status) s), '{}'::jsonb),
    'monthly_payments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('month', m.month, 'income', m.income, 'expense', m.expense) ORDER BY m.month)
        FROM (SELECT month,
                     COALESCE(sum(base) FILTER (WHERE kind = 'incoming'), 0) AS income,
                     COALESCE(sum(base) FILTER (WHERE kind = 'outgoing'), 0) AS expense
                FROM pay GROUP BY month) m), '[]'::jsonb),
    'monthly_transactions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('month', m.month, 'income', m.income, 'expense', m.expense) ORDER BY m.month)
        FROM (SELECT month,
                     COALESCE(sum(amount) FILTER (WHERE kind = 'income'), 0) AS income,
                     COALESCE(sum(amount) FILTER (WHERE kind = 'expense'), 0) AS expense
                FROM txn GROUP BY month) m), '[]'::jsonb),
    'expense_categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('category', c.category, 'amount', c.amount) ORDER BY c.amount DESC)
        FROM (SELECT category, sum(amount) AS amount FROM txn WHERE kind = 'expense' GROUP BY category) c), '[]'::jsonb),
    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'sku', p.sku, 'category', p.category, 'unit', p.unit,
               'stock', p.current_stock, 'purchase_price', p.purchase_price,
               'min_stock', p.min_stock, 'max_stock', p.max_stock,
               'value', round(p.current_stock * p.purchase_price, 2)) ORDER BY p.current_stock * p.purchase_price DESC, p.name)
        FROM (SELECT * FROM public.erp_products x WHERE x.workspace_id = p_workspace_id
               ORDER BY x.current_stock * x.purchase_price DESC, x.name LIMIT 500) p), '[]'::jsonb))
  INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_reports_summary(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_reports_summary(UUID) TO authenticated;
