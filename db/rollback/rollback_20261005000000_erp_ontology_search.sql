-- Rollback for 20261005000000_erp_ontology_search.sql.
-- Run only after redeploying an app version without ERP → Search.
-- Removes the search function, the search indexes and the access log (its
-- entries are deleted: export them first if they are needed), and restores
-- the original form of the two order-line policies. The pg_trgm extension is
-- left installed (other objects may use it); drop it by hand if not.

BEGIN;

DROP FUNCTION IF EXISTS public.erp_ontology_search(UUID, TEXT, TEXT[], UUID, UUID, INTEGER, TEXT[], DATE, DATE, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.erp_log_access(UUID, TEXT, TEXT[], UUID, INTEGER);
DROP TABLE IF EXISTS public.erp_access_log;

ALTER POLICY "users_manage_own_erp_purchase_order_items" ON public.erp_purchase_order_items
  USING (purchase_order_id IN (SELECT id FROM public.erp_purchase_orders WHERE user_id = auth.uid()))
  WITH CHECK (purchase_order_id IN (SELECT id FROM public.erp_purchase_orders WHERE user_id = auth.uid()));
ALTER POLICY "users_manage_own_erp_sales_order_items" ON public.erp_sales_order_items
  USING (sales_order_id IN (SELECT id FROM public.erp_sales_orders WHERE user_id = auth.uid()))
  WITH CHECK (sales_order_id IN (SELECT id FROM public.erp_sales_orders WHERE user_id = auth.uid()));

DROP INDEX IF EXISTS
  public.idx_erp_suppliers_search_trgm, public.idx_erp_customers_search_trgm, public.idx_erp_products_search_trgm,
  public.idx_erp_purchase_orders_search_trgm, public.idx_erp_sales_orders_search_trgm, public.idx_erp_invoices_search_trgm,
  public.idx_erp_payments_search_trgm, public.idx_erp_transactions_search_trgm, public.idx_erp_journal_entries_search_trgm,
  public.idx_erp_gl_accounts_search_trgm, public.idx_erp_stock_movements_search_trgm, public.idx_erp_fulfillment_events_search_trgm,
  public.idx_erp_suppliers_ws_name, public.idx_erp_customers_ws_name, public.idx_erp_products_ws_name,
  public.idx_erp_purchase_orders_ws_date, public.idx_erp_sales_orders_ws_date, public.idx_erp_invoices_ws_date,
  public.idx_erp_payments_ws_date, public.idx_erp_transactions_ws_date, public.idx_erp_stock_movements_ws_date,
  public.idx_erp_fulfillment_events_ws_kind, public.idx_erp_gl_accounts_ws_code,
  public.idx_erp_invoices_customer_id, public.idx_erp_purchase_order_items_product, public.idx_erp_sales_order_items_product,
  public.idx_erp_fulfillment_event_lines_product, public.idx_erp_stock_movements_product, public.idx_erp_journal_entries_source_id,
  public.idx_erp_payments_transaction_id, public.idx_erp_transactions_source_payment;

COMMIT;
