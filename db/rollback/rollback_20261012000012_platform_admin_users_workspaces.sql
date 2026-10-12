-- Rollback for 20261012000012_platform_admin_users_workspaces.sql.
-- Run only after redeploying an app version from before this change.
--
-- Lifts every workspace suspension (the workspaces become usable again; the
-- accounts a suspension disabled stay disabled — enable them with
-- scripts/admin/users.mjs unlock), cancels all open password links, and
-- restores the functions as of 20261012000011. Security log entries stay.

BEGIN;

-- As in 20260926010000_erp_workspaces.sql.
CREATE OR REPLACE FUNCTION public.erp_workspace_role(p_workspace_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.role
  FROM public.erp_workspace_members m
  WHERE m.workspace_id = p_workspace_id
    AND m.user_id = auth.uid()
    AND m.status = 'active';
$$;

DROP FUNCTION IF EXISTS public.erp_my_suspended_workspaces();

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'erp_workspace_not_suspended'
  LOOP
    EXECUTE format('DROP POLICY erp_workspace_not_suspended ON public.%I', t.tablename);
  END LOOP;
END;
$$;
DROP FUNCTION IF EXISTS public.erp_suspended_workspace_ids();

DROP FUNCTION IF EXISTS etna_platform.admin_list_users(TEXT, TEXT, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS etna_platform.admin_user_detail(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_list_workspaces(TEXT, TEXT, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS etna_platform.admin_workspace_detail(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_disable_user(UUID, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_enable_user(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_end_sessions(UUID, UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_create_reset_link(UUID, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_reset_mfa(UUID, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_create_user(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_suspend_workspace(UUID, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS etna_platform.admin_reactivate_workspace(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS etna_platform.password_link_check(TEXT);
DROP FUNCTION IF EXISTS etna_platform.password_link_use(TEXT);
DROP FUNCTION IF EXISTS etna_platform.password_links_revoke(UUID);
DROP FUNCTION IF EXISTS etna_platform._create_password_link(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS etna_platform._target(UUID, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS etna_platform._end_sessions(UUID, UUID);
DROP FUNCTION IF EXISTS etna_platform._last_activity(UUID);
DROP FUNCTION IF EXISTS etna_platform._is_container(JSONB);
DROP FUNCTION IF EXISTS etna_platform.admin_security_events(BIGINT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID);

DROP TABLE IF EXISTS etna_platform.password_links;
DROP TABLE IF EXISTS etna_platform.workspace_suspensions;

-- As in 20261012000011_platform_admin_security_log.sql.
CREATE OR REPLACE FUNCTION etna_platform.admin_security_events(
  p_before_id BIGINT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_event_type TEXT DEFAULT NULL,
  p_query TEXT DEFAULT NULL,
  p_outcome TEXT DEFAULT NULL,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT, occurred_at TIMESTAMPTZ, event_type TEXT, outcome TEXT, actor_kind TEXT,
  actor_user_id UUID, actor_email TEXT, target_user_id UUID, target_email TEXT,
  workspace_id UUID, session_id UUID, ip TEXT, user_agent TEXT, metadata JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  needle TEXT := NULLIF(lower(trim(COALESCE(p_query, ''))), '');
  pattern TEXT;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  IF needle IS NOT NULL THEN
    pattern := '%' || replace(replace(replace(left(needle, 320), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;
  RETURN QUERY
  SELECT e.id, e.occurred_at, e.event_type, e.outcome, e.actor_kind, e.actor_user_id, e.actor_email,
         e.target_user_id, e.target_email, e.workspace_id, e.session_id, e.ip, e.user_agent, e.metadata
    FROM etna_platform.security_events e
   WHERE (p_before_id IS NULL OR e.id < p_before_id)
     AND (p_event_type IS NULL OR e.event_type = p_event_type)
     AND (p_outcome IS NULL OR e.outcome = p_outcome)
     AND (p_from IS NULL OR e.occurred_at >= p_from)
     AND (p_to IS NULL OR e.occurred_at < p_to)
     AND (needle IS NULL
          OR lower(e.actor_email) LIKE pattern
          OR lower(e.target_email) LIKE pattern
          OR e.ip = needle)
   ORDER BY e.id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.log_auth_event(
  p_event_type TEXT,
  p_outcome TEXT,
  p_user_id UUID,
  p_email TEXT,
  p_session_id UUID,
  p_ip TEXT,
  p_user_agent TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
BEGIN
  IF p_event_type NOT IN (
    'LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'LOGIN_RATE_LIMITED', 'LOGOUT',
    'PASSWORD_CHANGED', 'PASSWORD_CHANGE_FAILED', 'PASSWORD_CHECK_FAILED',
    'MFA_FACTOR_ADDED', 'MFA_FACTOR_REMOVED', 'MFA_CHALLENGE_SUCCEEDED', 'MFA_CHALLENGE_FAILED',
    'MFA_RATE_LIMITED', 'ADMIN_REAUTHENTICATED', 'ADMIN_REAUTH_FAILED'
  ) THEN
    RAISE EXCEPTION 'Unknown sign-in event %', p_event_type USING ERRCODE = '22023';
  END IF;
  PERFORM etna_platform._log(p_event_type, p_outcome, 'user', p_user_id, p_email, NULL, p_metadata,
    p_user_id, p_email, p_session_id, p_ip, p_user_agent);
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA etna_platform FROM PUBLIC;
GRANT EXECUTE ON FUNCTION etna_platform.my_admin_role() TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_list_admins() TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_set_role(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_revoke_role(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_security_events(BIGINT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') THEN
    GRANT EXECUTE ON FUNCTION etna_platform.log_auth_event(TEXT, TEXT, UUID, TEXT, UUID, TEXT, TEXT, JSONB) TO etna_auth;
  END IF;
END;
$$;

COMMIT;
