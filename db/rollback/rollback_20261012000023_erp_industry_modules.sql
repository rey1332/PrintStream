-- Rollback for 20261012000023_erp_industry_modules.sql.
-- Run only after redeploying an app version from before this change.
-- Roll back the modules' own migrations (weighbridge, production, equipment) first.

BEGIN;
DROP FUNCTION IF EXISTS public.erp_create_erp_v2(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.erp_set_workspace_industry(UUID, TEXT, TEXT[]);
DROP FUNCTION IF EXISTS public.erp_my_workspace_modules();
DROP FUNCTION IF EXISTS public.erp__require_module(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp__module_on(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp__industry_modules(TEXT);
ALTER TABLE public.erp_workspaces DROP COLUMN IF EXISTS modules, DROP COLUMN IF EXISTS industry;
COMMIT;
