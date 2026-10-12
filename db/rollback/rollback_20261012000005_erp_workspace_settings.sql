-- Rollback for 20261012000005_erp_workspace_settings.sql.
-- Run only after redeploying an app version from before settings per ERP.
-- Settings saved per ERP stay in their tables.

BEGIN;

DROP FUNCTION IF EXISTS public.erp_workspace_settings_set(UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_workspace_settings_get(UUID);

COMMIT;
