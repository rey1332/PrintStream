-- ─── Financial records change only through ERP actions ──────────────────────
-- Invoices, payments, cash transactions, stock movements, orders and their
-- lines could still be deleted or edited directly through the API by their
-- owner (legacy "users manage own rows" policies). An accountant must be able
-- to rely on these records: corrections are voids/reversals made by the ERP
-- functions, which keep the audit trail consistent.
--
--   • DELETE (and TRUNCATE) is revoked from API roles on financial tables.
--   • Direct UPDATE by an API role is rejected by a trigger. ERP functions run
--     as their owner (SECURITY DEFINER) and bookkeeping triggers run nested,
--     so both keep working unchanged.
--
-- Master data (customers, suppliers, products) is unchanged.
-- Rollback: supabase/snippets/rollback_20260928000000_erp_financial_immutability.sql

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'erp_invoices', 'erp_payments', 'erp_transactions', 'erp_stock_movements',
    'erp_sales_orders', 'erp_sales_order_items', 'erp_purchase_orders', 'erp_purchase_order_items',
    'erp_fulfillment_events', 'erp_fulfillment_event_lines', 'erp_stock_reservations'
  ] LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON public.%I FROM PUBLIC, anon, authenticated', target);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_guard_financial_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- current_user is the API role only for a request that updates the table
  -- directly; ERP functions run as their owner. pg_trigger_depth() > 1 means
  -- the update comes from another table's bookkeeping trigger.
  IF current_user IN ('authenticated', 'anon') AND pg_trigger_depth() = 1
     AND current_setting('erp.maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Financial records can only be changed through ERP actions (void, reverse or cancel)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_guard_financial_update() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'erp_invoices', 'erp_payments', 'erp_transactions', 'erp_stock_movements',
    'erp_sales_orders', 'erp_sales_order_items', 'erp_purchase_orders', 'erp_purchase_order_items',
    'erp_fulfillment_events', 'erp_fulfillment_event_lines'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_erp_guard_financial_update ON public.%I', target);
    EXECUTE format(
      'CREATE TRIGGER trg_erp_guard_financial_update BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.erp_guard_financial_update()', target);
  END LOOP;
END;
$$;
