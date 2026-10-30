-- Row-level security that checks a member's rights once per query, not once
-- per row.
--
-- The workspace policies read `erp_can_read(workspace_id, area)` and
-- `erp_has_permission(workspace_id, permission)`. Both depend on the row's
-- workspace, so PostgreSQL ran them for every row it looked at: a list of an
-- ERP with 100 000 customers spent about 1.7 s in the policy alone, for the
-- page and again for its count, and every search, sort and "delete all" paid
-- the same.
--
-- * erp_readable_workspace_ids(area) / erp_permitted_workspace_ids(permission):
--   the workspaces where the signed-in user passes erp_can_read /
--   erp_has_permission. Only a workspace where the user has a role can pass
--   (erp_workspace_role: an active membership, or a platform staff session),
--   so those are the candidates; each is checked with the same function as
--   before, so roles, custom roles, suspensions and the two-factor rule
--   decide exactly as they did.
-- * Each policy written `erp_can_read(<x>.workspace_id, '<area>')` (or
--   erp_has_permission) becomes `<x>.workspace_id = ANY ((SELECT
--   erp_readable_workspace_ids('<area>'))::uuid[])`: an uncorrelated sub-select,
--   evaluated once per statement, that the workspace_id indexes can use.
--   Policies whose area is computed per row (erp_fulfillment_events) are
--   left as they are.
-- * A bare `auth.uid()` in a policy is inlined into a parse of the JSON
--   claims for every row (130 ms on 100 000 suppliers); it becomes
--   `(SELECT auth.uid())`, evaluated once, as most policies already write it.
-- * etna_meta.rls_policies_20261030071607: every policy expression as it was,
--   so the rollback puts them back exactly.
--
-- Rollback: db/rollback/rollback_20261030071607_rls_workspace_sets.sql

BEGIN;

CREATE OR REPLACE FUNCTION public.erp__candidate_workspace_ids()
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
  SELECT COALESCE(array_agg(DISTINCT c.workspace_id), '{}')
    FROM (
      SELECT m.workspace_id FROM public.erp_workspace_members m
       WHERE m.user_id = auth.uid() AND m.status = 'active'
      UNION ALL
      SELECT s.workspace_id FROM etna_platform.staff_access_sessions s
       WHERE s.admin_id = auth.uid() AND s.ended_at IS NULL
         AND s.ends_at > now() AND s.starts_at <= now()
    ) c;
$$;

CREATE OR REPLACE FUNCTION public.erp_readable_workspace_ids(p_area TEXT)
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(w), '{}')
    FROM unnest(public.erp__candidate_workspace_ids()) AS w
   WHERE public.erp_can_read(w, p_area);
$$;

CREATE OR REPLACE FUNCTION public.erp_permitted_workspace_ids(p_permission TEXT)
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(w), '{}')
    FROM unnest(public.erp__candidate_workspace_ids()) AS w
   WHERE public.erp_has_permission(w, p_permission);
$$;

REVOKE ALL ON FUNCTION public.erp__candidate_workspace_ids() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_readable_workspace_ids(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_permitted_workspace_ids(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_readable_workspace_ids(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_permitted_workspace_ids(TEXT) TO authenticated;

-- Run again, it keeps the expressions saved the first time.
CREATE SCHEMA IF NOT EXISTS etna_meta;
CREATE TABLE IF NOT EXISTS etna_meta.rls_policies_20261030071607 (
  schemaname NAME NOT NULL,
  tablename NAME NOT NULL,
  policyname NAME NOT NULL,
  qual TEXT,
  with_check TEXT,
  PRIMARY KEY (schemaname, tablename, policyname)
);
REVOKE ALL ON etna_meta.rls_policies_20261030071607 FROM PUBLIC;
INSERT INTO etna_meta.rls_policies_20261030071607
  SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies
   WHERE schemaname = 'public'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION pg_temp.rls_sets(expr TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(regexp_replace(regexp_replace(expr,
    'erp_can_read\(((?:[a-z_]+\.)?workspace_id), (''[a-z_.]+''::text)\)',
    '(\1 = ANY ((SELECT erp_readable_workspace_ids(\2))::uuid[]))', 'g'),
    'erp_has_permission\(((?:[a-z_]+\.)?workspace_id), (''[a-z_.]+''::text)\)',
    '(\1 = ANY ((SELECT erp_permitted_workspace_ids(\2))::uuid[]))', 'g'),
    '(?<!SELECT )auth\.uid\(\)', '(SELECT auth.uid() AS uid)', 'g');
$$;

DO $$
DECLARE
  p RECORD;
  new_qual TEXT;
  new_check TEXT;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies
     WHERE schemaname = 'public'
  LOOP
    new_qual := pg_temp.rls_sets(p.qual);
    new_check := pg_temp.rls_sets(p.with_check);
    IF new_qual IS DISTINCT FROM p.qual THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', p.policyname, p.schemaname, p.tablename, new_qual);
    END IF;
    IF new_check IS DISTINCT FROM p.with_check THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', p.policyname, p.schemaname, p.tablename, new_check);
    END IF;
  END LOOP;
END;
$$;

-- The lists sort newest first within an ERP.
CREATE INDEX IF NOT EXISTS idx_erp_customers_ws_created ON public.erp_customers (workspace_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_erp_suppliers_ws_created ON public.erp_suppliers (workspace_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_erp_products_ws_created ON public.erp_products (workspace_id, created_at DESC, id);

COMMIT;
