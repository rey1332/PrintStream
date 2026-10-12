-- Rollback for 20261011000000_erp_security_hardening.sql.
-- Run only after redeploying an app version from before this change (one
-- that still calls erp_delete_all_data / erp_delete_all_transactions from the
-- browser).
--
-- Restores: EXECUTE on every non-extension public function for signed-in
-- users, the old reset functions for them, and the default grants on new
-- functions. Not restored: anonymous access beyond erp_check_request (it was
-- never needed), so this rollback stays safer than the original state.

BEGIN;

DROP FUNCTION IF EXISTS public.erp_reset_workspace(UUID, TEXT);

DO $$
DECLARE fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn.sig);
  END LOOP;
END;
$$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC;

COMMIT;
