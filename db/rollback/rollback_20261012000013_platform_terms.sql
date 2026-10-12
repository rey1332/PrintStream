-- Rollback for 20261012000013_platform_terms.sql.
-- Run only after redeploying an app version from before this change.
--
-- Removes the Terms & Conditions requirement and DROPS every version and
-- every acceptance record. Export them first — they are proof of what each
-- account accepted:
--   \copy (select * from etna_platform.terms_versions) to 'terms_versions.csv' csv header
--   \copy (select * from etna_platform.terms_acceptances order by id) to 'terms_acceptances.csv' csv header
-- The security log entries stay.

BEGIN;

-- As in 20261001000000_erp_mfa_recovery.sql.
CREATE OR REPLACE FUNCTION public.erp_check_request()
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF current_setting('request.path', true) = '/rpc/erp_mfa_use_recovery_code' THEN
    RETURN;
  END IF;
  IF NOT public.erp_mfa_satisfied() THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
END;
$$;

-- As in 20261012000012_platform_admin_users_workspaces.sql.
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
    'PASSWORD_RESET_COMPLETED', 'PASSWORD_RESET_FAILED',
    'MFA_FACTOR_ADDED', 'MFA_FACTOR_REMOVED', 'MFA_CHALLENGE_SUCCEEDED', 'MFA_CHALLENGE_FAILED',
    'MFA_RATE_LIMITED', 'ADMIN_REAUTHENTICATED', 'ADMIN_REAUTH_FAILED'
  ) THEN
    RAISE EXCEPTION 'Unknown sign-in event %', p_event_type USING ERRCODE = '22023';
  END IF;
  PERFORM etna_platform._log(p_event_type, p_outcome, 'user', p_user_id, p_email, NULL, p_metadata,
    p_user_id, p_email, p_session_id, p_ip, p_user_agent);
END;
$$;

DROP FUNCTION IF EXISTS etna_platform.admin_terms_list();
DROP FUNCTION IF EXISTS etna_platform.admin_terms_get(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_terms_save(UUID, TEXT, JSONB);
DROP FUNCTION IF EXISTS etna_platform.admin_terms_delete(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_terms_publish(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_terms_pending(INTEGER, INTEGER);
DROP FUNCTION IF EXISTS etna_platform.admin_user_terms(UUID);
DROP FUNCTION IF EXISTS etna_platform.terms_current();
DROP FUNCTION IF EXISTS etna_platform.terms_status(UUID);
DROP FUNCTION IF EXISTS etna_platform.terms_accept(UUID, UUID, TEXT, UUID, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS etna_platform._terms_pending(UUID);
DROP FUNCTION IF EXISTS etna_platform._current_terms_id();
DROP FUNCTION IF EXISTS etna_platform._people_count();

DROP TABLE IF EXISTS etna_platform.terms_acceptances;
DROP TABLE IF EXISTS etna_platform.terms_versions;
DROP FUNCTION IF EXISTS etna_platform._terms_acceptances_guard();
DROP FUNCTION IF EXISTS etna_platform._terms_versions_guard();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA etna_platform FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') THEN
    GRANT EXECUTE ON FUNCTION etna_platform.log_auth_event(TEXT, TEXT, UUID, TEXT, UUID, TEXT, TEXT, JSONB) TO etna_auth;
  END IF;
END;
$$;

COMMIT;
