-- Rollback for 20261012000017_erp_reports_summary.sql.
-- Run only after redeploying an app version from before this change.

BEGIN;
DROP FUNCTION IF EXISTS public.erp_reports_summary(UUID);
COMMIT;
