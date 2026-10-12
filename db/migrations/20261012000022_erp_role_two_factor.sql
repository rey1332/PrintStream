-- Two-factor is required for Owners, Admins and Finance of shared ERPs.
--
-- Until now two-factor was required only where an Owner switched it on for
-- the whole ERP (erp_workspaces.require_mfa). Owners, Admins and Finance can
-- move money, change members and see everything, so they now always need a
-- session verified with a second factor in an ERP that other people use:
-- a created ERP (from Add modules) or a personal ERP shared with at least one
-- other member. A personal ERP used alone is unchanged, so staff who only
-- work in someone else's ERP as Sales or Inventory are not forced to set up
-- two-factor for their own empty ERP.
--
-- Without that session the database gives the member nothing in that ERP
-- (every role and read check goes through erp_workspace_mfa_ok).
-- erp_my_mfa_required_workspaces() tells the app which ERPs ask for it, so it
-- can say so instead of showing empty pages.
--
-- Rollback: db/rollback/rollback_20261012000022_erp_role_two_factor.sql

-- Does the caller's role in this ERP require two-factor?
CREATE OR REPLACE FUNCTION public.erp__role_needs_mfa(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT public.erp_workspace_role(w.id) IN ('owner', 'admin', 'finance')
           -- Not the caller's own personal ERP (a created ERP belongs to an internal owner).
           AND (NOT (w.is_personal AND w.owner_id = auth.uid()) OR EXISTS (
             SELECT 1 FROM public.erp_workspace_members m
              WHERE m.workspace_id = w.id AND m.status = 'active' AND m.user_id <> auth.uid()))
      FROM public.erp_workspaces w WHERE w.id = p_workspace_id), false);
$$;

-- As in 20260928010000_erp_security_workspace.sql, plus the role rule.
CREATE OR REPLACE FUNCTION public.erp_workspace_mfa_ok(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.erp_session_aal() = 'aal2'
      OR COALESCE((SELECT NOT w.require_mfa AND NOT public.erp__role_needs_mfa(w.id)
                     FROM public.erp_workspaces w WHERE w.id = p_workspace_id), true);
$$;

-- The caller's ERPs that need a two-factor session the current one is not.
CREATE OR REPLACE FUNCTION public.erp_my_mfa_required_workspaces()
RETURNS TABLE (workspace_id UUID, by_role BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF public.erp_session_aal() = 'aal2' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT m.workspace_id, public.erp__role_needs_mfa(m.workspace_id)
    FROM public.erp_workspace_members m
    JOIN public.erp_workspaces w ON w.id = m.workspace_id
   WHERE m.user_id = auth.uid() AND m.status = 'active'
     AND (w.require_mfa OR public.erp__role_needs_mfa(m.workspace_id));
END;
$$;

REVOKE ALL ON FUNCTION public.erp__role_needs_mfa(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_my_mfa_required_workspaces() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_my_mfa_required_workspaces() TO authenticated;
