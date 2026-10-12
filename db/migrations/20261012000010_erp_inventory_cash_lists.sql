-- Inventory and cash flow load one page at a time.
--
-- 1. erp_inventory_stock: every product with its reserved and available stock,
--    its value at moving-average cost and whether it needs reordering, so the
--    inventory list and the reorder list can be paged and searched by the
--    database. The same rules as the app had: unit cost is the moving-average
--    cost, else the purchase price; a product needs reordering when what is
--    available (on hand minus reserved) is at or below its minimum; the
--    suggested quantity fills it back up to its maximum.
-- 2. erp_inventory_summary: figures above the inventory page.
-- 3. erp_cash_flow_summary: money in and out per month for the cash flow
--    charts, from recorded payments (voided ones left out) in the ERP's base
--    currency. Before, the browser added up payment amounts as they were
--    entered, mixing currencies.
--
-- SECURITY INVOKER throughout: row-level security applies, so the figures
-- cover exactly the rows the caller may see.
--
-- Rollback: db/rollback/rollback_20261012000010_erp_inventory_cash_lists.sql

CREATE OR REPLACE VIEW public.erp_inventory_stock
WITH (security_invoker = true) AS
SELECT
  p.id,
  p.user_id,
  p.workspace_id,
  p.name,
  p.sku,
  p.category,
  p.created_at,
  p.current_stock,
  p.min_stock,
  p.max_stock,
  COALESCE(NULLIF(p.avg_cost, 0), NULLIF(p.purchase_price, 0), 0)::NUMERIC(15,4) AS unit_cost,
  COALESCE(r.reserved, 0)::INTEGER AS reserved,
  (p.current_stock - COALESCE(r.reserved, 0))::INTEGER AS available,
  round(p.current_stock * COALESCE(NULLIF(p.avg_cost, 0), NULLIF(p.purchase_price, 0), 0), 2) AS stock_value,
  (p.current_stock - COALESCE(r.reserved, 0)) <= p.min_stock AS needs_reorder,
  GREATEST(0, p.max_stock - p.current_stock + COALESCE(r.reserved, 0))::INTEGER AS suggested_qty
FROM public.erp_products p
LEFT JOIN (
  SELECT product_id, SUM(qty_open) AS reserved
  FROM public.erp_stock_reservations
  WHERE status = 'active'
  GROUP BY product_id
) r ON r.product_id = p.id;

REVOKE ALL ON public.erp_inventory_stock FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_inventory_stock TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_inventory_summary(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  result JSONB;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'Choose an ERP' USING ERRCODE = '22023'; END IF;

  SELECT jsonb_build_object(
    'products', count(*),
    'stock_value', COALESCE(sum(s.stock_value), 0),
    'reorder_count', count(*) FILTER (WHERE s.needs_reorder),
    'movements', (SELECT count(*) FROM public.erp_stock_movements m WHERE m.workspace_id = p_workspace_id))
  INTO result
  FROM public.erp_inventory_stock s
  WHERE s.workspace_id = p_workspace_id;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_inventory_summary(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_inventory_summary(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_cash_flow_summary(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  result JSONB;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'Choose an ERP' USING ERRCODE = '22023'; END IF;

  WITH pay AS (
    SELECT to_char(p.payment_date, 'YYYY-MM') AS month,
           p.payment_type::TEXT AS kind,
           COALESCE(p.base_amount, p.amount * COALESCE(NULLIF(p.fx_rate, 0), 1)) AS base
    FROM public.erp_payments p
    WHERE p.workspace_id = p_workspace_id AND p.voided_at IS NULL
  )
  SELECT jsonb_build_object(
    'income', COALESCE((SELECT sum(base) FROM pay WHERE kind = 'incoming'), 0),
    'expense', COALESCE((SELECT sum(base) FROM pay WHERE kind = 'outgoing'), 0),
    'payments', (SELECT count(*) FROM pay),
    'transactions', (SELECT count(*) FROM public.erp_transactions t WHERE t.workspace_id = p_workspace_id),
    'monthly', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('month', m.month, 'income', m.income, 'expense', m.expense)
                       ORDER BY m.month)
      FROM (SELECT month,
                   COALESCE(sum(base) FILTER (WHERE kind = 'incoming'), 0) AS income,
                   COALESCE(sum(base) FILTER (WHERE kind = 'outgoing'), 0) AS expense
            FROM pay GROUP BY month) m), '[]'::jsonb))
  INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_cash_flow_summary(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_cash_flow_summary(UUID) TO authenticated;
