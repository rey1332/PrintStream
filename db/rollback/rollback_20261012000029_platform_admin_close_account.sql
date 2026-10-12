-- Rollback for 20261012000029_platform_admin_close_account.sql.
-- Run only after redeploying an app version from before this change.
--
-- Closed accounts stay closed: their details were replaced and they cannot
-- sign in (blocked, no password). Without the closed_accounts list they show
-- as disabled, and nothing stops an admin from enabling one or sending it a
-- password link, so do not. Ownership transfers stay as they are. Security
-- log entries stay.

BEGIN;

DROP FUNCTION IF EXISTS etna_platform.admin_list_users(TEXT, TEXT, INTEGER, INTEGER, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_transfer_ownership(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_user_closure(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_close_account(UUID, TEXT, TEXT);

DO $$
DECLARE
  body TEXT := pg_get_functiondef('etna_platform.admin_workspace_detail(uuid)'::regprocedure);
  added TEXT := '''transferable'', EXISTS (SELECT 1 FROM auth.users u WHERE u.id = w.owner_id AND etna_platform._is_container(u.raw_user_meta_data)),' || chr(10) || '      ';
BEGIN
  IF position(added IN body) > 0 THEN
    EXECUTE replace(body, added, '');
  END IF;
END;
$$;

-- As in 20261012000012_platform_admin_users_workspaces.sql.
CREATE OR REPLACE FUNCTION etna_platform._target(p_user_id UUID, p_caller_role TEXT, p_allow_self BOOLEAN)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  address TEXT;
  meta JSONB;
BEGIN
  SELECT u.email, u.raw_user_meta_data INTO address, meta FROM auth.users u WHERE u.id = p_user_id;
  IF address IS NULL OR etna_platform._is_container(meta) THEN
    RAISE EXCEPTION 'No such account' USING ERRCODE = 'P0002';
  END IF;
  IF p_user_id = auth.uid() AND NOT p_allow_self THEN
    RAISE EXCEPTION 'Not on your own account' USING ERRCODE = 'P0001', HINT = 'self';
  END IF;
  IF etna_platform._role_of(p_user_id) IS NOT NULL AND p_caller_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Only a super admin may act on an admin account' USING ERRCODE = '42501', HINT = 'not_admin';
  END IF;
  RETURN address;
END;
$$;

-- As in 20261012000012_platform_admin_users_workspaces.sql.
CREATE OR REPLACE FUNCTION etna_platform.admin_list_users(
  p_query TEXT DEFAULT NULL,
  p_filter TEXT DEFAULT 'all',
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  user_id UUID, email TEXT, full_name TEXT, created_at TIMESTAMPTZ, last_sign_in_at TIMESTAMPTZ,
  disabled BOOLEAN, mfa_enrolled BOOLEAN, active_sessions INTEGER, workspaces INTEGER,
  admin_role TEXT, total BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  needle TEXT := NULLIF(lower(trim(COALESCE(p_query, ''))), '');
  pattern TEXT;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  IF p_filter IS NULL OR p_filter NOT IN ('all', 'disabled', 'no_mfa', 'admins') THEN
    RAISE EXCEPTION 'Unknown filter' USING ERRCODE = '22023';
  END IF;
  IF needle IS NOT NULL THEN
    pattern := '%' || replace(replace(replace(left(needle, 320), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;
  RETURN QUERY
  WITH people AS (
    SELECT u.id AS uid, u.email AS address, COALESCE(u.raw_user_meta_data ->> 'full_name', '') AS name,
           u.created_at AS created, u.last_sign_in_at AS last_in,
           COALESCE(u.banned_until > now(), false) AS is_disabled,
           EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = u.id AND f.status = 'verified') AS has_mfa,
           (SELECT count(*) FROM auth.sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now())::int AS n_sessions,
           (SELECT count(*) FROM public.erp_workspace_members m WHERE m.user_id = u.id AND m.status = 'active')::int AS n_workspaces,
           a.role AS role_name
      FROM auth.users u
      LEFT JOIN etna_platform.admins a ON a.user_id = u.id
     WHERE NOT etna_platform._is_container(u.raw_user_meta_data)
       AND (needle IS NULL OR lower(u.email) LIKE pattern
            OR lower(COALESCE(u.raw_user_meta_data ->> 'full_name', '')) LIKE pattern)
  )
  SELECT p.uid, p.address, p.name, p.created, p.last_in, p.is_disabled, p.has_mfa, p.n_sessions,
         p.n_workspaces, p.role_name, count(*) OVER ()
    FROM people p
   WHERE p_filter = 'all'
      OR (p_filter = 'disabled' AND p.is_disabled)
      OR (p_filter = 'no_mfa' AND NOT p.has_mfa)
      OR (p_filter = 'admins' AND p.role_name IS NOT NULL)
   ORDER BY p.created DESC, p.uid
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;
REVOKE ALL ON FUNCTION etna_platform.admin_list_users(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION etna_platform.admin_list_users(TEXT, TEXT, INTEGER, INTEGER) TO authenticated;

DROP FUNCTION IF EXISTS etna_platform._is_closed(UUID);
DROP TABLE IF EXISTS etna_platform.closed_accounts;

COMMIT;
