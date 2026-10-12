-- Rollback for 20261012000008_erp_list_summaries.sql.
-- Run only after redeploying an app version from before paged document lists.

BEGIN;

DROP FUNCTION IF EXISTS public.erp_list_summary(UUID, TEXT);

COMMIT;
