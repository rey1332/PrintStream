-- Rollback for 20260928000000_erp_financial_immutability.sql: restores direct
-- delete/update of financial records by their owner through the API.
BEGIN;
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
  END LOOP;
  FOREACH target IN ARRAY ARRAY[
    'erp_invoices', 'erp_payments', 'erp_transactions', 'erp_stock_movements',
    'erp_sales_orders', 'erp_sales_order_items', 'erp_purchase_orders', 'erp_purchase_order_items',
    'erp_fulfillment_events', 'erp_fulfillment_event_lines', 'erp_stock_reservations'
  ] LOOP
    EXECUTE format('GRANT DELETE ON public.%I TO authenticated', target);
  END LOOP;
END;
$$;
DROP FUNCTION IF EXISTS public.erp_guard_financial_update();
COMMIT;
