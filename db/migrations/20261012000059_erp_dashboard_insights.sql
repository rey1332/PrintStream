-- Figures for the ERP dashboard's receivables, revenue and trend widgets.
--
-- One call returns what the dashboard draws beside erp_dashboard_metrics:
-- receivables (balance due, past due, aging buckets), credit exposure over
-- each customer's limit, revenue of the last 12 months, the top 10 products
-- and customers by revenue, and revenue / cash in / cash out per month.
--
-- SECURITY INVOKER: row-level security decides which rows count, exactly as
-- for the caller's own reads (a role that cannot read invoices gets zeros).
-- Scope: p_workspace_id when given, else the caller's own rows (user_id), as
-- erp_dashboard_metrics.
--
-- Definitions (all amounts in the base currency, rounded to cents):
--   open balance   invoice total minus its non-voided incoming payments (as
--                  erp_dashboard_metrics' accountsReceivable), times its rate
--   past due       open balance of invoices whose due date has passed
--   aging          open balances by days past due: not yet due, 1-30, 31-60,
--                  61-90, over 90
--   credit         per customer with a limit, open balance plus completed
--                  weighbridge tickets not invoiced yet (erp__customer_exposure)
--                  minus the limit, when positive
--   revenue        invoice total minus its tax (net of tax), by invoice date,
--                  void invoices excluded; products from invoice lines (net
--                  subtotals; invoices made before lines existed have none)
--   cash in / out  non-voided payments, incoming / other, by payment date
-- The 12 months are the current calendar month and the 11 before it.

CREATE OR REPLACE FUNCTION public.erp_dashboard_insights(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH
  win AS (
    SELECT (date_trunc('month', CURRENT_DATE) - interval '11 months')::date AS since
  ),
  inv AS (
    SELECT i.id, i.customer_id, i.customer_name, i.invoice_date, i.due_date,
           COALESCE(i.total, 0) AS total, COALESCE(i.tax_amount, 0) AS tax,
           CASE WHEN i.fx_rate > 0 THEN i.fx_rate ELSE 1 END AS rate
    FROM public.erp_invoices i
    WHERE i.status IS DISTINCT FROM 'void' AND i.voided_at IS NULL
      AND (CASE WHEN p_workspace_id IS NULL THEN i.user_id = auth.uid() ELSE i.workspace_id = p_workspace_id END)
  ),
  pay AS (
    SELECT p.payment_type, p.invoice_id, p.payment_date, COALESCE(p.amount, 0) AS amount,
           COALESCE(p.base_amount, COALESCE(p.amount, 0) * CASE WHEN p.fx_rate > 0 THEN p.fx_rate ELSE 1 END) AS base
    FROM public.erp_payments p
    WHERE p.voided_at IS NULL
      AND (CASE WHEN p_workspace_id IS NULL THEN p.user_id = auth.uid() ELSE p.workspace_id = p_workspace_id END)
  ),
  paid AS (
    SELECT invoice_id, sum(amount) AS paid FROM pay
    WHERE payment_type = 'incoming' AND invoice_id IS NOT NULL GROUP BY invoice_id
  ),
  open_inv AS (
    SELECT v.customer_id, v.customer_name, CURRENT_DATE - v.due_date AS late,
           round(greatest(0, v.total - COALESCE(pd.paid, 0)) * v.rate, 2) AS open
    FROM inv v LEFT JOIN paid pd ON pd.invoice_id = v.id
  ),
  due AS (
    SELECT * FROM open_inv WHERE open > 0
  ),
  receivables AS (
    SELECT COALESCE(sum(open), 0) AS balance_due,
           COALESCE(sum(open) FILTER (WHERE late > 0), 0) AS past_due,
           count(*) AS open_invoices,
           count(*) FILTER (WHERE late > 0) AS invoices_past_due,
           count(DISTINCT COALESCE(customer_id::text, lower(btrim(customer_name)))) FILTER (WHERE late > 0) AS customers_past_due,
           COALESCE(sum(open) FILTER (WHERE late <= 0), 0) AS a_current,
           COALESCE(sum(open) FILTER (WHERE late BETWEEN 1 AND 30), 0) AS a_30,
           COALESCE(sum(open) FILTER (WHERE late BETWEEN 31 AND 60), 0) AS a_60,
           COALESCE(sum(open) FILTER (WHERE late BETWEEN 61 AND 90), 0) AS a_90,
           COALESCE(sum(open) FILTER (WHERE late > 90), 0) AS a_over
    FROM due
  ),
  tickets AS (
    SELECT t.customer_id, sum(COALESCE(t.amount, 0)) AS amount
    FROM public.erp_weigh_tickets t
    WHERE t.status = 'completed' AND t.invoice_id IS NULL AND t.customer_id IS NOT NULL
      AND (CASE WHEN p_workspace_id IS NULL THEN t.user_id = auth.uid() ELSE t.workspace_id = p_workspace_id END)
    GROUP BY t.customer_id
  ),
  exposure AS (
    SELECT c.id, c.credit_limit,
           COALESCE((SELECT sum(d.open) FROM due d WHERE d.customer_id = c.id), 0)
             + COALESCE((SELECT k.amount FROM tickets k WHERE k.customer_id = c.id), 0) AS exposure
    FROM public.erp_customers c
    WHERE c.credit_limit IS NOT NULL
      AND (CASE WHEN p_workspace_id IS NULL THEN c.user_id = auth.uid() ELSE c.workspace_id = p_workspace_id END)
  ),
  credit AS (
    SELECT COALESCE(sum(greatest(0, exposure - credit_limit)), 0) AS over_limit,
           count(*) FILTER (WHERE exposure > credit_limit) AS customers_over,
           count(*) AS customers_with_limit
    FROM exposure
  ),
  recent AS (
    SELECT v.* FROM inv v, win WHERE v.invoice_date >= win.since
  ),
  revenue AS (
    SELECT COALESCE(round(sum((total - tax) * rate), 2), 0) AS revenue, count(*) AS invoices FROM recent
  ),
  top_products AS (
    SELECT l.product_id AS id, COALESCE(max(pr.name), max(l.description)) AS name,
           round(sum(l.subtotal * r.rate), 2) AS revenue, sum(l.qty) AS qty
    FROM recent r
    JOIN public.erp_invoice_lines l ON l.invoice_id = r.id
    LEFT JOIN public.erp_products pr ON pr.id = l.product_id
    WHERE l.product_id IS NOT NULL
    GROUP BY l.product_id
    ORDER BY revenue DESC, name
    LIMIT 10
  ),
  top_customers AS (
    SELECT max(r.customer_id::text) AS id,
           COALESCE(max(c.name), max(r.customer_name)) AS name,
           round(sum((r.total - r.tax) * r.rate), 2) AS revenue, count(*) AS invoices
    FROM recent r
    LEFT JOIN public.erp_customers c ON c.id = r.customer_id
    GROUP BY COALESCE(r.customer_id::text, lower(btrim(r.customer_name)))
    ORDER BY revenue DESC, name
    LIMIT 10
  ),
  months AS (
    SELECT m::date AS month FROM win, generate_series(win.since, date_trunc('month', CURRENT_DATE)::date, interval '1 month') m
  ),
  monthly AS (
    SELECT to_char(ms.month, 'YYYY-MM') AS month,
           COALESCE((SELECT round(sum((r.total - r.tax) * r.rate), 2) FROM recent r
                      WHERE date_trunc('month', r.invoice_date) = ms.month), 0) AS revenue,
           COALESCE((SELECT round(sum(p.base), 2) FROM pay p
                      WHERE p.payment_type = 'incoming' AND date_trunc('month', p.payment_date) = ms.month), 0) AS cash_in,
           COALESCE((SELECT round(sum(p.base), 2) FROM pay p
                      WHERE p.payment_type <> 'incoming' AND date_trunc('month', p.payment_date) = ms.month), 0) AS cash_out
    FROM months ms
  )
  SELECT jsonb_build_object(
    'asOf', CURRENT_DATE,
    'since', win.since,
    'receivables', jsonb_build_object(
      'balanceDue', rc.balance_due,
      'pastDue', rc.past_due,
      'openInvoices', rc.open_invoices,
      'invoicesPastDue', rc.invoices_past_due,
      'customersPastDue', rc.customers_past_due
    ),
    'aging', jsonb_build_object(
      'current', rc.a_current, 'days30', rc.a_30, 'days60', rc.a_60, 'days90', rc.a_90, 'over90', rc.a_over
    ),
    'credit', jsonb_build_object(
      'overLimit', round(cr.over_limit, 2),
      'customersOver', cr.customers_over,
      'customersWithLimit', cr.customers_with_limit
    ),
    'revenue', jsonb_build_object('total', rv.revenue, 'invoices', rv.invoices),
    'topProducts', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'revenue', revenue, 'qty', qty)
                                              ORDER BY revenue DESC, name) FROM top_products), '[]'::jsonb),
    'topCustomers', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'revenue', revenue, 'invoices', invoices)
                                               ORDER BY revenue DESC, name) FROM top_customers), '[]'::jsonb),
    'months', (SELECT jsonb_agg(jsonb_build_object('month', month, 'revenue', revenue, 'cashIn', cash_in, 'cashOut', cash_out)
                                ORDER BY month) FROM monthly)
  )
  FROM win, receivables rc, credit cr, revenue rv;
$$;

REVOKE ALL ON FUNCTION public.erp_dashboard_insights(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_dashboard_insights(UUID) TO authenticated;
