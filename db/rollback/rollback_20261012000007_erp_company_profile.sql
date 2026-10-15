-- Rollback for 20261012000007_erp_company_profile.sql.
-- Run only after redeploying an app version from before company profiles.
-- Company profiles (and logos) are removed.

BEGIN;

-- Emptying an ERP without the profile (as in 20261012000004_erp_empty_own_erp.sql).
DO $$
BEGIN
  -- Line endings as in the files the function came from (CRLF on Windows checkouts).
  EXECUTE replace(replace(pg_get_functiondef('public.erp_empty_erp(uuid)'::regprocedure), E'\r\n', E'\n'),
    E'\n  DELETE FROM public.erp_company_profiles x WHERE x.workspace_id = w.id;', '');
END;
$$;

DROP FUNCTION IF EXISTS public.erp_company_profile_set(UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_company_profile_get(UUID);
DROP TABLE IF EXISTS public.erp_company_profiles;

COMMIT;
