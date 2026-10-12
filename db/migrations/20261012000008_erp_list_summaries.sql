-- Summaries above the document lists (invoices, payments, sales and purchase
-- orders), computed by the database so the lists can load one page at a time.
--
-- The same rules as the app (src/app/erp/lib/erpRules.ts): an invoice is paid
-- when at most a cent is left, partly paid when more than a cent was paid,
-- overdue when it is not paid and its due date has passed; void invoices and
-- voided payments are left out. Amounts are in the ERP's base currency (the
-- document's amount times its rate).
--
-- SECURITY INVOKER: row-level security applies, so the figures cover exactly
-- the rows the caller may see.
--
-- Rollback: db/rollback/rollback_20261012000008_erp_list_summaries.sql

CREATE OR REPLACE FUNCTION public.erp_list_summary(p_workspace_id UUID, p_kind TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  ws UUID := p_workspace_id;
  result JSONB;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF ws IS NULL THEN RAISE EXCEPTION 'Choose an ERP' USING ERRCODE = '22023'; END IF;

  IF p_kind = 'invoices' THEN
    WITH x AS (
      SELECT i.due_date,
             (i.status = 'void' OR i.voided_at IS NOT NULL) AS is_void,
             CASE WHEN i.amount_paid >= i.total - 0.01 THEN 'paid'
                  WHEN i.amount_paid > 0.01 THEN 'partially_paid' ELSE 'unpaid' END AS state,
             GREATEST(i.total - i.amount_paid, 0) * COALESCE(NULLIF(i.fx_rate, 0), 1) AS open_base,
             i.total * COALESCE(NULLIF(i.fx_rate, 0), 1) AS total_base
      FROM public.erp_invoices i
      WHERE i.workspace_id = ws
    ), live AS (SELECT * FROM x WHERE NOT is_void)
    SELECT jsonb_build_object(
      'count', (SELECT count(*) FROM x),
      'open_count', count(*) FILTER (WHERE state <> 'paid'),
      'open_amount', COALESCE(sum(open_base) FILTER (WHERE state <> 'paid'), 0),
      'partial_count', count(*) FILTER (WHERE state = 'partially_paid'),
      'partial_amount', COALESCE(sum(open_base) FILTER (WHERE state = 'partially_paid'), 0),
      'overdue_count', count(*) FILTER (WHERE state <> 'paid' AND due_date < CURRENT_DATE),
      'overdue_amount', COALESCE(sum(open_base) FILTER (WHERE state <> 'paid' AND due_date < CURRENT_DATE), 0),
      'paid_count', count(*) FILTER (WHERE state = 'paid'),
      'paid_amount', COALESCE(sum(total_base) FILTER (WHERE state = 'paid'), 0),
      'aging_current', COALESCE(sum(open_base) FILTER (WHERE state <> 'paid' AND due_date >= CURRENT_DATE), 0),
      'aging_1_30', COALESCE(sum(open_base) FILTER (WHERE state <> 'paid' AND due_date < CURRENT_DATE
                                                     AND CURRENT_DATE - due_date <= 30), 0),
      'aging_31_60', COALESCE(sum(open_base) FILTER (WHERE state <> 'paid' AND CURRENT_DATE - due_date BETWEEN 31 AND 60), 0),
      'aging_61', COALESCE(sum(open_base) FILTER (WHERE state <> 'paid' AND CURRENT_DATE - due_date > 60), 0))
    INTO result FROM live;

  ELSIF p_kind = 'payments' THEN
    SELECT jsonb_build_object(
      'count', count(*),
      'incoming_count', count(*) FILTER (WHERE p.voided_at IS NULL AND p.payment_type = 'incoming'),
      'outgoing_count', count(*) FILTER (WHERE p.voided_at IS NULL AND p.payment_type = 'outgoing'),
      'incoming', COALESCE(sum(COALESCE(p.base_amount, p.amount * COALESCE(NULLIF(p.fx_rate, 0), 1)))
                    FILTER (WHERE p.voided_at IS NULL AND p.payment_type = 'incoming'), 0),
      'outgoing', COALESCE(sum(COALESCE(p.base_amount, p.amount * COALESCE(NULLIF(p.fx_rate, 0), 1)))
                    FILTER (WHERE p.voided_at IS NULL AND p.payment_type = 'outgoing'), 0))
    INTO result
    FROM public.erp_payments p WHERE p.workspace_id = ws;

  ELSIF p_kind IN ('sales_orders', 'purchase_orders') THEN
    EXECUTE format($q$
      SELECT jsonb_build_object(
        'count', (SELECT count(*) FROM public.%1$I o WHERE o.workspace_id = $1),
        'live_total', (SELECT COALESCE(sum(COALESCE(o.base_total, o.total)), 0)
                       FROM public.%1$I o WHERE o.workspace_id = $1 AND o.status::TEXT <> 'cancelled'),
        'by_status', COALESCE((SELECT jsonb_object_agg(s.status, jsonb_build_object('count', s.n, 'total', s.total))
          FROM (SELECT o.status::TEXT AS status, count(*) AS n, sum(COALESCE(o.base_total, o.total)) AS total
                FROM public.%1$I o WHERE o.workspace_id = $1 GROUP BY o.status) s), '{}'::jsonb))
    $q$, 'erp_' || p_kind) INTO result USING ws;

  ELSE
    RAISE EXCEPTION 'Unknown list' USING ERRCODE = '22023';
  END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_list_summary(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_list_summary(UUID, TEXT) TO authenticated;
