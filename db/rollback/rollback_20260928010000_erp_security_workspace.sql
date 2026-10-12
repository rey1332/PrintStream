-- Rollback for 20260928010000_erp_security_workspace.sql.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    ALTER ROLE authenticator RESET pgrst.db_pre_request;
    NOTIFY pgrst, 'reload config';
  END IF;
END;
$$;

-- erp_has_permission without the workspace two-factor requirement (as in 20260926010000).
CREATE OR REPLACE FUNCTION public.erp_has_permission(p_workspace_id UUID, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(p_permission = ANY(public.erp_role_permissions(public.erp_workspace_role(p_workspace_id))), false);
$$;

DROP FUNCTION IF EXISTS public.api_rate_limit_hit(TEXT, INTEGER, INTEGER);
DROP TABLE IF EXISTS public.api_rate_limits;
DROP FUNCTION IF EXISTS public.erp_rename_workspace(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_set_workspace_require_mfa(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.erp_list_workspace_member_security(UUID);
DROP FUNCTION IF EXISTS public.erp_workspace_security(UUID);
DROP FUNCTION IF EXISTS public.erp_workspace_mfa_ok(UUID);
ALTER TABLE public.erp_workspaces DROP COLUMN IF EXISTS require_mfa;
DROP FUNCTION IF EXISTS public.erp_check_request();
DROP FUNCTION IF EXISTS public.erp_mfa_satisfied();
DROP FUNCTION IF EXISTS public.erp_mfa_enrolled(UUID);
DROP FUNCTION IF EXISTS public.erp_session_aal();
COMMIT;
