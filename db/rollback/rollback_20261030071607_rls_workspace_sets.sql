-- Rollback for 20261030071607_rls_workspace_sets.sql: every policy gets back
-- the expression it had (saved by the migration in
-- etna_meta.rls_policies_20261030071607), then the workspace-set functions
-- and the newest-first indexes go.
-- Run only after redeploying an app version from before this change.

BEGIN;

DO $$
DECLARE
  p RECORD;
BEGIN
  FOR p IN
    SELECT o.schemaname, o.tablename, o.policyname, o.qual, o.with_check,
           c.qual AS cur_qual, c.with_check AS cur_check
      FROM etna_meta.rls_policies_20261030071607 o
      JOIN pg_policies c USING (schemaname, tablename, policyname)
  LOOP
    IF p.qual IS DISTINCT FROM p.cur_qual THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', p.policyname, p.schemaname, p.tablename, p.qual);
    END IF;
    IF p.with_check IS DISTINCT FROM p.cur_check THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', p.policyname, p.schemaname, p.tablename, p.with_check);
    END IF;
  END LOOP;
END;
$$;

DROP TABLE etna_meta.rls_policies_20261030071607;

DROP FUNCTION IF EXISTS public.erp_readable_workspace_ids(TEXT);
DROP FUNCTION IF EXISTS public.erp_permitted_workspace_ids(TEXT);
DROP FUNCTION IF EXISTS public.erp__candidate_workspace_ids();

DROP INDEX IF EXISTS public.idx_erp_customers_ws_created;
DROP INDEX IF EXISTS public.idx_erp_suppliers_ws_created;
DROP INDEX IF EXISTS public.idx_erp_products_ws_created;

COMMIT;
