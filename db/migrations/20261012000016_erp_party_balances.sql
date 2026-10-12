-- Customer and supplier balances calculated from the documents.
--
-- erp_customers.balance and erp_suppliers.balance were only set by the form
-- and the CSV import; nothing kept them up to date, so the lists showed
-- numbers that had nothing to do with invoices and payments. The app now
-- shows what erp_party_balances() calculates, in the base currency:
--   customers: open invoices (total − paid), and how much of it is overdue;
--   suppliers: approved or received purchase orders not yet paid.
-- The old columns stay (nothing reads them any more) so no data is lost.
--
-- SECURITY INVOKER: row-level security decides which documents count, so a
-- role that cannot read invoices gets no customer balances.
--
-- Rollback: db/rollback/rollback_20261012000016_erp_party_balances.sql

CREATE OR REPLACE FUNCTION public.erp_party_balances(p_workspace_id UUID, p_kind TEXT, p_ids UUID[])
RETURNS TABLE (party_id UUID, outstanding NUMERIC, overdue NUMERIC, open_documents INTEGER)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Choose an ERP' USING ERRCODE = '22023';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'Ask for at most 500 customers or suppliers at a time' USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'customers' THEN
    RETURN QUERY
    WITH open_invoices AS (
      SELECT i.customer_id, i.due_date,
             round(GREATEST(i.total - i.amount_paid, 0) * COALESCE(NULLIF(i.fx_rate, 0), 1), 2) AS open_base
        FROM public.erp_invoices i
       WHERE i.workspace_id = p_workspace_id
         AND i.customer_id = ANY (p_ids)
         AND i.status <> 'void' AND i.voided_at IS NULL
    )
    SELECT o.customer_id, sum(o.open_base), COALESCE(sum(o.open_base) FILTER (WHERE o.due_date < CURRENT_DATE), 0),
           count(*)::INTEGER
      FROM open_invoices o
     WHERE o.open_base > 0
     GROUP BY o.customer_id;
  ELSIF p_kind = 'suppliers' THEN
    RETURN QUERY
    WITH open_orders AS (
      SELECT o.supplier_id,
             round(GREATEST(o.total - COALESCE((
               SELECT sum(p.amount) FROM public.erp_payments p
                WHERE p.purchase_order_id = o.id AND p.voided_at IS NULL), 0), 0)
               * COALESCE(NULLIF(o.fx_rate, 0), 1), 2) AS open_base
        FROM public.erp_purchase_orders o
       WHERE o.workspace_id = p_workspace_id
         AND o.supplier_id = ANY (p_ids)
         AND o.status IN ('approved', 'received')
    )
    SELECT o.supplier_id, sum(o.open_base), 0::NUMERIC, count(*)::INTEGER
      FROM open_orders o
     WHERE o.open_base > 0
     GROUP BY o.supplier_id;
  ELSE
    RAISE EXCEPTION 'Unknown kind %', p_kind USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_party_balances(UUID, TEXT, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_party_balances(UUID, TEXT, UUID[]) TO authenticated;
