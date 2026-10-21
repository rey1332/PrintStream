-- Rollback for 20261012000059_erp_dashboard_insights.sql.
-- Safe at any time: without the function the dashboard shows its other
-- widgets and an empty state for receivables, revenue and trends.

BEGIN;

DROP FUNCTION IF EXISTS public.erp_dashboard_insights(UUID);

COMMIT;
