-- Rollback for 20261012000000_erp_dashboard_metrics.sql.
-- Safe at any time: without the function the dashboards add the rows up in
-- the browser, as before.

BEGIN;

DROP FUNCTION IF EXISTS public.erp_dashboard_metrics(UUID);

COMMIT;
