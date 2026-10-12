-- Rollback for 20261012000010_erp_inventory_cash_lists.sql.
-- Run only after redeploying an app version from before paged inventory and cash flow.

BEGIN;

DROP FUNCTION IF EXISTS public.erp_cash_flow_summary(UUID);
DROP FUNCTION IF EXISTS public.erp_inventory_summary(UUID);
DROP VIEW IF EXISTS public.erp_inventory_stock;

COMMIT;
