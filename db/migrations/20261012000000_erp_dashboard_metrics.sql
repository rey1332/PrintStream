-- Dashboard metrics computed in the database.
--
-- The dashboards (home and ERP) used to load every invoice, payment, product
-- and purchase order (with its lines) into the browser and add them up there,
-- every 30 seconds. This function returns the same figures in one call. It
-- runs with the caller's rights (SECURITY INVOKER), so row-level security
-- decides which rows count, exactly as for the browser's own reads.
--
-- The definitions mirror computeFinancialMetrics in src/app/erp/lib/erpRules.ts;
-- tests/db/dashboardMetrics.test.mjs checks both give the same numbers.
--
-- Scope: p_workspace_id when given, else the caller's own rows (user_id), as
-- the app's readScope().

CREATE OR REPLACE FUNCTION public.erp_dashboard_metrics(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH
  pay AS (
    SELECT p.payment_type, p.invoice_id, p.purchase_order_id, COALESCE(p.amount, 0) AS amount,
           COALESCE(p.base_amount, COALESCE(p.amount, 0) * CASE WHEN p.fx_rate > 0 THEN p.fx_rate ELSE 1 END) AS base
    FROM public.erp_payments p
    WHERE p.voided_at IS NULL
      AND (CASE WHEN p_workspace_id IS NULL THEN p.user_id = auth.uid() ELSE p.workspace_id = p_workspace_id END)
  ),
  cash AS (
    SELECT COALESCE(sum(base) FILTER (WHERE payment_type = 'incoming'), 0) AS cash_in,
           COALESCE(sum(base) FILTER (WHERE payment_type <> 'incoming'), 0) AS cash_out
    FROM pay
  ),
  paid_invoice AS (
    SELECT invoice_id, sum(amount) AS paid FROM pay
    WHERE payment_type = 'incoming' AND invoice_id IS NOT NULL GROUP BY invoice_id
  ),
  paid_po AS (
    SELECT purchase_order_id, sum(amount) AS paid FROM pay
    WHERE payment_type <> 'incoming' AND purchase_order_id IS NOT NULL GROUP BY purchase_order_id
  ),
  inv AS (
    SELECT
      COALESCE(sum(COALESCE(i.base_total, COALESCE(i.total, 0) * CASE WHEN i.fx_rate > 0 THEN i.fx_rate ELSE 1 END)), 0) AS revenue,
      COALESCE(sum(greatest(0, COALESCE(i.total, 0) - COALESCE(pi.paid, 0)) * CASE WHEN i.fx_rate > 0 THEN i.fx_rate ELSE 1 END), 0) AS receivable
    FROM public.erp_invoices i
    LEFT JOIN paid_invoice pi ON pi.invoice_id = i.id
    WHERE i.status IS DISTINCT FROM 'void'
      AND (CASE WHEN p_workspace_id IS NULL THEN i.user_id = auth.uid() ELSE i.workspace_id = p_workspace_id END)
  ),
  po AS (
    SELECT o.id, o.status, CASE WHEN o.fx_rate > 0 THEN o.fx_rate ELSE 1 END AS rate,
           COALESCE(pp.paid, 0) AS paid,
           CASE WHEN lines.n = 0 THEN COALESCE(o.total, 0) ELSE lines.ordered END AS ordered,
           CASE WHEN lines.n = 0 THEN (CASE WHEN o.status = 'received' THEN COALESCE(o.total, 0) ELSE 0 END)
                ELSE lines.received END AS received
    FROM public.erp_purchase_orders o
    LEFT JOIN paid_po pp ON pp.purchase_order_id = o.id
    CROSS JOIN LATERAL (
      SELECT count(*) AS n,
             COALESCE(sum(greatest(0, COALESCE(it.qty, 0)) * COALESCE(it.price, 0)), 0)
               * (1 + COALESCE(o.tax_rate, 0) / 100.0) AS ordered,
             COALESCE(sum(
               CASE WHEN it.qty_received IS NULL
                    THEN (CASE WHEN o.status = 'received' THEN greatest(0, COALESCE(it.qty, 0)) ELSE 0 END)
                    ELSE least(greatest(0, COALESCE(it.qty, 0)), greatest(0, it.qty_received)) END
               * COALESCE(it.price, 0)), 0) * (1 + COALESCE(o.tax_rate, 0) / 100.0) AS received
      FROM public.erp_purchase_order_items it
      WHERE it.purchase_order_id = o.id
    ) lines
    WHERE o.status IN ('approved', 'received')
      AND (CASE WHEN p_workspace_id IS NULL THEN o.user_id = auth.uid() ELSE o.workspace_id = p_workspace_id END)
  ),
  payables AS (
    SELECT COALESCE(sum(greatest(0, received - paid) * rate), 0) AS payable,
           COALESCE(sum(greatest(0, paid - received) * rate), 0) AS prepayments,
           COALESCE(sum(greatest(0, ordered - received) * rate) FILTER (WHERE status = 'approved'), 0) AS committed
    FROM po
  ),
  stock AS (
    SELECT COALESCE(sum(COALESCE(pr.current_stock, 0) * COALESCE(NULLIF(pr.avg_cost, 0), NULLIF(pr.purchase_price, 0), 0)), 0) AS value
    FROM public.erp_products pr
    WHERE (CASE WHEN p_workspace_id IS NULL THEN pr.user_id = auth.uid() ELSE pr.workspace_id = p_workspace_id END)
  )
  SELECT jsonb_build_object(
    'cashIn', round(cash.cash_in, 2),
    'cashOut', round(cash.cash_out, 2),
    'netCash', round(cash.cash_in - cash.cash_out, 2),
    'invoicedRevenue', round(inv.revenue, 2),
    'accountsReceivable', round(inv.receivable, 2),
    'accountsPayable', round(payables.payable, 2),
    'committedPurchases', round(payables.committed, 2),
    'supplierPrepayments', round(payables.prepayments, 2),
    'inventoryValue', round(stock.value, 2),
    'totalRevenue', round(cash.cash_in, 2),
    'totalExpenses', round(cash.cash_out, 2),
    'cashBalance', round(cash.cash_in - cash.cash_out, 2)
  )
  FROM cash, inv, payables, stock;
$$;

REVOKE ALL ON FUNCTION public.erp_dashboard_metrics(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_dashboard_metrics(UUID) TO authenticated;
