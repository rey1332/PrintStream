-- Rollback for 20260930000000_erp_inventory_costing.sql. Removes warehouses,
-- transfers, moving-average cost and purchase tax. Purchase order totals
-- already including tax are kept as they are.
BEGIN;
DROP TRIGGER IF EXISTS trg_erp_wh_product_stock ON public.erp_products;
DROP FUNCTION IF EXISTS public.erp_transfer_stock(UUID, UUID, UUID, INTEGER, TEXT);
DROP FUNCTION IF EXISTS public.erp_create_warehouse(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.erp_wh__on_product_stock();
DROP FUNCTION IF EXISTS public.erp_wh__apply(UUID, UUID, INTEGER);
DROP FUNCTION IF EXISTS public.erp_wh__resync(UUID);
DROP FUNCTION IF EXISTS public.erp_wh__default(UUID);
DROP TABLE IF EXISTS public.erp_stock_transfers;
DROP TABLE IF EXISTS public.erp_warehouse_stock;
DROP TABLE IF EXISTS public.erp_warehouses;

DROP TRIGGER IF EXISTS trg_erp_purchase_tax ON public.erp_purchase_orders;
DROP FUNCTION IF EXISTS public.erp_apply_purchase_tax();
DROP FUNCTION IF EXISTS public.erp_set_purchase_tax_rate(UUID, NUMERIC);
ALTER TABLE public.erp_purchase_orders DROP CONSTRAINT IF EXISTS erp_purchase_orders_tax_check;
ALTER TABLE public.erp_purchase_orders DROP COLUMN IF EXISTS tax_amount, DROP COLUMN IF EXISTS tax_rate;
ALTER TABLE public.erp_accounting_settings DROP CONSTRAINT IF EXISTS erp_accounting_settings_purchase_tax_check;
ALTER TABLE public.erp_accounting_settings DROP COLUMN IF EXISTS purchase_tax_rate;

DROP TRIGGER IF EXISTS trg_erp_products_initial_cost ON public.erp_products;
DROP FUNCTION IF EXISTS public.erp_products_initial_cost();
DROP TRIGGER IF EXISTS trg_erp_update_average_cost ON public.erp_fulfillment_event_lines;
DROP TRIGGER IF EXISTS trg_erp_fulfillment_line_cost ON public.erp_fulfillment_event_lines;
DROP FUNCTION IF EXISTS public.erp_update_average_cost();
DROP FUNCTION IF EXISTS public.erp_fulfillment_line_cost();
-- erp_gl__post_fulfillment / erp_gl__on_stock_movement / erp_accounting_settings_get:
-- re-run 20260929000000 and 20260929010000 to restore their earlier versions.
DROP FUNCTION IF EXISTS public.erp__unit_cost(UUID) CASCADE;
ALTER TABLE public.erp_fulfillment_event_lines DROP COLUMN IF EXISTS unit_cost;
ALTER TABLE public.erp_products DROP COLUMN IF EXISTS avg_cost;
COMMIT;
