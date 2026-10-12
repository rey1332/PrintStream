-- Rollback for 20261012000022_erp_role_two_factor.sql.
-- Two-factor is then required only in ERPs whose Owner switched it on.

BEGIN;
CREATE OR REPLACE FUNCTION public.erp_workspace_mfa_ok(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT NOT w.require_mfa OR public.erp_session_aal() = 'aal2'
                   FROM public.erp_workspaces w WHERE w.id = p_workspace_id), true);
$$;
DROP FUNCTION IF EXISTS public.erp_my_mfa_required_workspaces();
DROP FUNCTION IF EXISTS public.erp__role_needs_mfa(UUID);
COMMIT;
