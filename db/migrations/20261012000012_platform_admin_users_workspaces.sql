-- Admin panel, phase 2: managing accounts and workspaces (ERPs).
--
-- 1. Workspace suspension (etna_platform.workspace_suspensions). While a
--    workspace is suspended, erp_workspace_role() returns NULL for everyone,
--    so every row-level policy and ERP function that checks a role or a
--    permission refuses it: nobody can read or change its data. Members keep
--    their accounts unless the admin also chose to disable them.
--    erp_my_suspended_workspaces() lets the app explain why.
-- 2. One-time password links (etna_platform.password_links): an admin creates
--    a reset link (24 hours) or, for a new account, an invite link (72 hours).
--    The app generates the token; only its SHA-256 hash reaches the database.
--    A link works once; a newer link, a completed reset or the user's own
--    password change cancels the others. No temporary passwords.
-- 3. Admin functions to list and inspect accounts and workspaces, and to
--    disable / enable accounts, end sessions, reset two-factor, create
--    accounts, and suspend / reactivate workspaces. All need a two-factor
--    session; changes also need a fresh re-authentication. Support may act on
--    ordinary accounts; only super admins may act on other admins' accounts
--    or suspend workspaces; nobody disables or resets themselves.
-- 4. The security log filter gains user and workspace, and the sign-in server
--    may record completed and failed password resets.
--
-- Internal "container" accounts that back ERPs created from Add modules
-- (raw_user_meta_data.etna_kind = 'erp_container') are not people and are
-- left out of the account list.
--
-- Rollback: db/rollback/rollback_20261012000012_platform_admin_users_workspaces.sql

-- ─── 1. Suspensions ───────────────────────────────────────────────────────────

-- No foreign keys: the history stays if a workspace or an admin account goes.
CREATE TABLE IF NOT EXISTS etna_platform.workspace_suspensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 3 AND 500),
  suspended_by UUID,
  suspended_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Accounts this suspension disabled (offered for re-enabling on reactivation).
  disabled_user_ids UUID[] NOT NULL DEFAULT '{}',
  lifted_by UUID,
  lifted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_suspensions_active_key
  ON etna_platform.workspace_suspensions (workspace_id) WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS workspace_suspensions_workspace_idx
  ON etna_platform.workspace_suspensions (workspace_id, suspended_at DESC);

-- As in 20260926010000_erp_workspaces.sql, plus: no role in a suspended workspace.
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
    AND m.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM etna_platform.workspace_suspensions s
       WHERE s.workspace_id = p_workspace_id AND s.lifted_at IS NULL
    );
$$;

-- Row-level security has older permissive policies that let an account reach
-- its own rows by user_id (e.g. "manage own"), without asking for a role. A
-- RESTRICTIVE policy is ANDed with all of them, so a suspended workspace's
-- rows are closed whatever else allows them. On every table with a
-- workspace_id and row-level security, except the membership list itself.
-- (Rows without a workspace are not affected.)
--
-- The policy compares each row with one list, worked out once per query
-- (the "(SELECT ...)" makes it an init plan, like the existing
-- "(SELECT auth.uid())"): the suspended workspaces the caller belongs or
-- belonged to — the only ones whose rows any policy could give them.
CREATE OR REPLACE FUNCTION public.erp_suspended_workspace_ids()
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(DISTINCT s.workspace_id), '{}')
    FROM etna_platform.workspace_suspensions s
    JOIN public.erp_workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = auth.uid()
   WHERE s.lifted_at IS NULL;
$$;

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
       AND c.relname <> 'erp_workspace_members'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.%I', t.relname);
    EXECUTE format(
      'CREATE POLICY erp_workspace_not_suspended ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[])) '
      'WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))',
      t.relname);
  END LOOP;
END;
$$;

-- The caller's workspaces that are suspended (the reason stays with ETNA).
CREATE OR REPLACE FUNCTION public.erp_my_suspended_workspaces()
RETURNS TABLE (workspace_id UUID)
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
  RETURN QUERY
  SELECT m.workspace_id
    FROM public.erp_workspace_members m
    JOIN etna_platform.workspace_suspensions s ON s.workspace_id = m.workspace_id AND s.lifted_at IS NULL
   WHERE m.user_id = auth.uid() AND m.status = 'active';
END;
$$;

-- ─── 2. Password links ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS etna_platform.password_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('reset', 'invite')),
  -- SHA-256 of the token, hex. The token itself is never stored.
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS password_links_user_idx ON etna_platform.password_links (user_id, created_at DESC);

REVOKE ALL ON etna_platform.workspace_suspensions, etna_platform.password_links
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION etna_platform._create_password_link(p_user_id UUID, p_token_hash TEXT, p_purpose TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  link etna_platform.password_links;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid link' USING ERRCODE = '22023';
  END IF;
  UPDATE etna_platform.password_links SET revoked_at = now()
   WHERE user_id = p_user_id AND used_at IS NULL AND revoked_at IS NULL;
  INSERT INTO etna_platform.password_links (user_id, purpose, token_hash, created_by, expires_at)
  VALUES (p_user_id, p_purpose, p_token_hash, auth.uid(),
          now() + CASE p_purpose WHEN 'invite' THEN interval '72 hours' ELSE interval '24 hours' END)
  RETURNING * INTO link;
  RETURN jsonb_build_object('link_id', link.id, 'purpose', link.purpose, 'expires_at', link.expires_at);
END;
$$;

-- For the sign-in server: is this link usable, and for whom?
CREATE OR REPLACE FUNCTION etna_platform.password_link_check(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
BEGIN
  RETURN (
    SELECT jsonb_build_object('user_id', l.user_id, 'email', u.email, 'purpose', l.purpose, 'expires_at', l.expires_at)
      FROM etna_platform.password_links l
      JOIN auth.users u ON u.id = l.user_id
     WHERE l.token_hash = p_token_hash AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > now()
  );
END;
$$;

-- Uses the link (once) and cancels the account's other open links.
CREATE OR REPLACE FUNCTION etna_platform.password_link_use(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  link etna_platform.password_links;
  address TEXT;
BEGIN
  UPDATE etna_platform.password_links l SET used_at = now()
   WHERE l.token_hash = p_token_hash AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > now()
  RETURNING l.* INTO link;
  IF link.id IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE etna_platform.password_links SET revoked_at = now()
   WHERE user_id = link.user_id AND id <> link.id AND used_at IS NULL AND revoked_at IS NULL;
  SELECT u.email INTO address FROM auth.users u WHERE u.id = link.user_id;
  RETURN jsonb_build_object('user_id', link.user_id, 'email', address, 'purpose', link.purpose, 'link_id', link.id);
END;
$$;

-- The user changed their own password: links an admin made earlier stop working.
CREATE OR REPLACE FUNCTION etna_platform.password_links_revoke(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE etna_platform.password_links SET revoked_at = now()
   WHERE user_id = p_user_id AND used_at IS NULL AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- As in 20261012000011, plus the two password-reset events.
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

-- ─── 3. Helpers ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION etna_platform._is_container(p_meta JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(p_meta ->> 'etna_kind', '') = 'erp_container';
$$;

-- The account an admin acts on: must exist and be a person; acting on another
-- platform admin needs a super admin; on oneself only where p_allow_self.
-- Returns the e-mail address.
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

CREATE OR REPLACE FUNCTION etna_platform._end_sessions(p_user_id UUID, p_session_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE auth.sessions SET revoked_at = now()
   WHERE user_id = p_user_id AND revoked_at IS NULL AND (p_session_id IS NULL OR id = p_session_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform._last_activity(p_workspace_id UUID)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT max(a.created_at) FROM public.erp_audit_log a WHERE a.workspace_id = p_workspace_id;
$$;

-- ─── 4. Reading accounts and workspaces (every admin role) ────────────────────

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

CREATE OR REPLACE FUNCTION etna_platform.admin_user_detail(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  account auth.users;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  SELECT * INTO account FROM auth.users u WHERE u.id = p_user_id;
  IF account.id IS NULL OR etna_platform._is_container(account.raw_user_meta_data) THEN
    RAISE EXCEPTION 'No such account' USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object(
    'user', jsonb_build_object(
      'user_id', account.id,
      'email', account.email,
      'full_name', COALESCE(account.raw_user_meta_data ->> 'full_name', ''),
      'created_at', account.created_at,
      'last_sign_in_at', account.last_sign_in_at,
      'disabled', COALESCE(account.banned_until > now(), false),
      'disabled_until', account.banned_until,
      'has_password', account.encrypted_password IS NOT NULL,
      'admin_role', etna_platform._role_of(account.id)
    ),
    'mfa', jsonb_build_object(
      'devices', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', f.id, 'name', f.friendly_name, 'status', f.status, 'created_at', f.created_at) ORDER BY f.created_at)
          FROM auth.mfa_factors f WHERE f.user_id = account.id), '[]'::jsonb),
      'recovery_codes_left', (SELECT count(*) FROM public.erp_mfa_recovery_codes r WHERE r.user_id = account.id AND r.used_at IS NULL)
    ),
    'sessions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', s.id, 'aal', s.aal, 'created_at', s.created_at, 'last_seen_at', s.last_seen_at,
               'expires_at', s.expires_at, 'ip', s.ip, 'user_agent', s.user_agent) ORDER BY s.last_seen_at DESC)
        FROM auth.sessions s
       WHERE s.user_id = account.id AND s.revoked_at IS NULL AND s.expires_at > now()), '[]'::jsonb),
    'workspaces', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'workspace_id', w.id, 'name', w.name, 'is_personal', w.is_personal AND w.owner_id = account.id,
               'role', m.role, 'status', m.status, 'joined_at', m.joined_at, 'removed_at', m.removed_at,
               'suspended', EXISTS (SELECT 1 FROM etna_platform.workspace_suspensions x WHERE x.workspace_id = w.id AND x.lifted_at IS NULL))
             ORDER BY m.status, w.name)
        FROM public.erp_workspace_members m
        JOIN public.erp_workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = account.id), '[]'::jsonb),
    'password_links', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', l.id, 'purpose', l.purpose, 'created_at', l.created_at, 'expires_at', l.expires_at,
               'used_at', l.used_at, 'revoked_at', l.revoked_at, 'created_by_email', c.email) ORDER BY l.created_at DESC)
        FROM (SELECT * FROM etna_platform.password_links pl WHERE pl.user_id = account.id ORDER BY pl.created_at DESC LIMIT 10) l
        LEFT JOIN auth.users c ON c.id = l.created_by), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_list_workspaces(
  p_query TEXT DEFAULT NULL,
  p_filter TEXT DEFAULT 'all',
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  workspace_id UUID, name TEXT, owner_email TEXT, is_personal BOOLEAN, members INTEGER,
  created_at TIMESTAMPTZ, last_activity TIMESTAMPTZ, suspended BOOLEAN, total BIGINT
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
  IF p_filter IS NULL OR p_filter NOT IN ('all', 'suspended', 'shared', 'personal') THEN
    RAISE EXCEPTION 'Unknown filter' USING ERRCODE = '22023';
  END IF;
  IF needle IS NOT NULL THEN
    pattern := '%' || replace(replace(replace(left(needle, 320), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;
  RETURN QUERY
  WITH spaces AS (
    SELECT w.id AS wid, w.name AS wname,
           -- An ERP created from Add modules belongs to a container account: show its creator.
           COALESCE(creator.email, owner_user.email) AS who,
           w.is_personal AS personal, w.created_at AS created,
           (SELECT count(*) FROM public.erp_workspace_members m WHERE m.workspace_id = w.id AND m.status = 'active')::int AS n_members,
           EXISTS (SELECT 1 FROM etna_platform.workspace_suspensions s WHERE s.workspace_id = w.id AND s.lifted_at IS NULL) AS is_suspended
      FROM public.erp_workspaces w
      LEFT JOIN auth.users owner_user ON owner_user.id = w.owner_id
      LEFT JOIN auth.users creator ON creator.id = w.created_by
     WHERE needle IS NULL OR lower(w.name) LIKE pattern OR lower(COALESCE(creator.email, owner_user.email, '')) LIKE pattern
  ),
  chosen AS (
    SELECT sp.*, count(*) OVER () AS n_total
      FROM spaces sp
     WHERE p_filter = 'all'
        OR (p_filter = 'suspended' AND sp.is_suspended)
        OR (p_filter = 'shared' AND NOT sp.personal)
        OR (p_filter = 'personal' AND sp.personal)
     ORDER BY sp.created DESC, sp.wid
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT c.wid, c.wname, c.who, c.personal, c.n_members, c.created,
         etna_platform._last_activity(c.wid), c.is_suspended, c.n_total
    FROM chosen c
   ORDER BY c.created DESC, c.wid;
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_workspace_detail(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  w public.erp_workspaces;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  SELECT * INTO w FROM public.erp_workspaces x WHERE x.id = p_workspace_id;
  IF w.id IS NULL THEN
    RAISE EXCEPTION 'No such workspace' USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object(
    'workspace', jsonb_build_object(
      'workspace_id', w.id,
      'name', w.name,
      'is_personal', w.is_personal,
      'owner_email', COALESCE((SELECT u.email FROM auth.users u WHERE u.id = w.created_by),
                              (SELECT u.email FROM auth.users u WHERE u.id = w.owner_id)),
      'created_at', w.created_at,
      'require_mfa', w.require_mfa,
      'last_activity', etna_platform._last_activity(w.id),
      'suspended', EXISTS (SELECT 1 FROM etna_platform.workspace_suspensions s WHERE s.workspace_id = w.id AND s.lifted_at IS NULL)
    ),
    'members', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', m.user_id, 'email', u.email, 'full_name', COALESCE(u.raw_user_meta_data ->> 'full_name', ''),
               'role', m.role, 'status', m.status, 'joined_at', m.joined_at, 'removed_at', m.removed_at,
               'disabled', COALESCE(u.banned_until > now(), false),
               'is_container', etna_platform._is_container(u.raw_user_meta_data))
             ORDER BY m.status, CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.email)
        FROM public.erp_workspace_members m
        JOIN auth.users u ON u.id = m.user_id
       WHERE m.workspace_id = w.id), '[]'::jsonb),
    'suspensions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', s.id, 'reason', s.reason, 'suspended_at', s.suspended_at,
               'suspended_by_email', (SELECT u.email FROM auth.users u WHERE u.id = s.suspended_by),
               'disabled_members', cardinality(s.disabled_user_ids),
               'lifted_at', s.lifted_at,
               'lifted_by_email', (SELECT u.email FROM auth.users u WHERE u.id = s.lifted_by))
             ORDER BY s.suspended_at DESC)
        FROM etna_platform.workspace_suspensions s WHERE s.workspace_id = w.id), '[]'::jsonb)
  );
END;
$$;

-- ─── 5. Changing accounts (super admin, support; fresh re-authentication) ─────

CREATE OR REPLACE FUNCTION etna_platform.admin_disable_user(p_user_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin', 'support'], true);
  address TEXT := etna_platform._target(p_user_id, caller_role, false);
  ended INTEGER;
BEGIN
  IF char_length(trim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Give a reason' USING ERRCODE = '22023';
  END IF;
  UPDATE auth.users SET banned_until = 'infinity', updated_at = now() WHERE id = p_user_id;
  ended := etna_platform._end_sessions(p_user_id);
  UPDATE etna_platform.password_links SET revoked_at = now()
   WHERE user_id = p_user_id AND used_at IS NULL AND revoked_at IS NULL;
  PERFORM etna_platform._log('USER_DISABLED', 'success', 'admin', p_user_id, address, NULL,
    jsonb_build_object('reason', left(trim(p_reason), 500), 'sessions_ended', ended));
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_enable_user(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin', 'support'], true);
  address TEXT := etna_platform._target(p_user_id, caller_role, false);
BEGIN
  UPDATE auth.users SET banned_until = NULL, updated_at = now() WHERE id = p_user_id;
  PERFORM etna_platform._log('USER_ENABLED', 'success', 'admin', p_user_id, address, NULL, '{}'::jsonb);
END;
$$;

-- One session (p_session_id) or all of them.
CREATE OR REPLACE FUNCTION etna_platform.admin_end_sessions(p_user_id UUID, p_session_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin', 'support'], true);
  address TEXT := etna_platform._target(p_user_id, caller_role, true);
  ended INTEGER;
BEGIN
  ended := etna_platform._end_sessions(p_user_id, p_session_id);
  PERFORM etna_platform._log('SESSIONS_REVOKED', 'success', 'admin', p_user_id, address, NULL,
    jsonb_build_object('sessions_ended', ended, 'session_id', p_session_id));
  RETURN ended;
END;
$$;

-- p_token_hash: SHA-256 (hex) of the token the app put in the link.
CREATE OR REPLACE FUNCTION etna_platform.admin_create_reset_link(p_user_id UUID, p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin', 'support'], true);
  address TEXT := etna_platform._target(p_user_id, caller_role, false);
  link JSONB;
BEGIN
  link := etna_platform._create_password_link(p_user_id, p_token_hash, 'reset');
  PERFORM etna_platform._log('ADMIN_PASSWORD_RESET_INITIATED', 'success', 'admin', p_user_id, address, NULL,
    jsonb_build_object('link_id', link ->> 'link_id', 'expires_at', link ->> 'expires_at'));
  RETURN link;
END;
$$;

-- Lost authenticator and recovery codes. p_verification: how the person's
-- identity was checked outside ETNA (kept in the security log).
CREATE OR REPLACE FUNCTION etna_platform.admin_reset_mfa(p_user_id UUID, p_verification TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin', 'support'], true);
  address TEXT := etna_platform._target(p_user_id, caller_role, false);
  removed INTEGER;
  ended INTEGER;
BEGIN
  IF char_length(trim(COALESCE(p_verification, ''))) < 10 THEN
    RAISE EXCEPTION 'Describe how the person was verified' USING ERRCODE = '22023';
  END IF;
  DELETE FROM auth.mfa_factors WHERE user_id = p_user_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  DELETE FROM public.erp_mfa_recovery_codes WHERE user_id = p_user_id;
  ended := etna_platform._end_sessions(p_user_id);
  PERFORM etna_platform._log('MFA_RESET', 'success', 'admin', p_user_id, address, NULL,
    jsonb_build_object('devices_removed', removed, 'sessions_ended', ended, 'verification', left(trim(p_verification), 500)));
  RETURN removed;
END;
$$;

-- A new account without a password, and its invite link (72 hours).
CREATE OR REPLACE FUNCTION etna_platform.admin_create_user(p_email TEXT, p_full_name TEXT, p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  address TEXT := trim(COALESCE(p_email, ''));
  new_id UUID;
  link JSONB;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support'], true);
  IF address !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' OR char_length(address) > 254 THEN
    RAISE EXCEPTION 'Give a valid e-mail address' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(address)) THEN
    RAISE EXCEPTION 'An account with this e-mail address already exists' USING ERRCODE = '23505';
  END IF;
  -- The existing triggers on auth.users create the profile and personal workspace.
  INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
  VALUES (address, NULL,
          jsonb_build_object('full_name', COALESCE(NULLIF(left(trim(p_full_name), 120), ''), split_part(address, '@', 1))),
          now())
  RETURNING id INTO new_id;
  link := etna_platform._create_password_link(new_id, p_token_hash, 'invite');
  PERFORM etna_platform._log('USER_CREATED', 'success', 'admin', new_id, address, NULL,
    jsonb_build_object('invite_link_id', link ->> 'link_id', 'expires_at', link ->> 'expires_at'));
  RETURN link || jsonb_build_object('user_id', new_id);
END;
$$;

-- ─── 6. Workspaces (super admin; fresh re-authentication) ─────────────────────

-- p_disable_members: also disable every active member's account (except
-- platform admins and the caller) and end their sessions.
CREATE OR REPLACE FUNCTION etna_platform.admin_suspend_workspace(p_workspace_id UUID, p_reason TEXT, p_disable_members BOOLEAN DEFAULT false)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  disabled UUID[] := '{}';
  member RECORD;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin'], true);
  IF NOT EXISTS (SELECT 1 FROM public.erp_workspaces w WHERE w.id = p_workspace_id) THEN
    RAISE EXCEPTION 'No such workspace' USING ERRCODE = 'P0002';
  END IF;
  IF char_length(trim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Give a reason' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM etna_platform.workspace_suspensions s WHERE s.workspace_id = p_workspace_id AND s.lifted_at IS NULL) THEN
    RAISE EXCEPTION 'This workspace is already suspended' USING ERRCODE = 'P0001', HINT = 'already';
  END IF;

  IF p_disable_members THEN
    FOR member IN
      SELECT u.id, u.email
        FROM public.erp_workspace_members m
        JOIN auth.users u ON u.id = m.user_id
       WHERE m.workspace_id = p_workspace_id AND m.status = 'active'
         AND u.id <> auth.uid()
         AND NOT etna_platform._is_container(u.raw_user_meta_data)
         AND etna_platform._role_of(u.id) IS NULL
         AND NOT COALESCE(u.banned_until > now(), false)
    LOOP
      UPDATE auth.users SET banned_until = 'infinity', updated_at = now() WHERE id = member.id;
      PERFORM etna_platform._end_sessions(member.id);
      disabled := disabled || member.id;
      PERFORM etna_platform._log('USER_DISABLED', 'success', 'admin', member.id, member.email, p_workspace_id,
        jsonb_build_object('reason', left(trim(p_reason), 500), 'via', 'workspace_suspension'));
    END LOOP;
  END IF;

  INSERT INTO etna_platform.workspace_suspensions (workspace_id, reason, suspended_by, disabled_user_ids)
  VALUES (p_workspace_id, left(trim(p_reason), 500), auth.uid(), disabled);
  PERFORM etna_platform._log('WORKSPACE_SUSPENDED', 'success', 'admin', NULL, NULL, p_workspace_id,
    jsonb_build_object('reason', left(trim(p_reason), 500), 'members_disabled', cardinality(disabled)));
  RETURN cardinality(disabled);
END;
$$;

-- p_enable_members: re-enable the accounts the suspension disabled.
CREATE OR REPLACE FUNCTION etna_platform.admin_reactivate_workspace(p_workspace_id UUID, p_enable_members BOOLEAN DEFAULT false)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  suspension etna_platform.workspace_suspensions;
  enabled INTEGER := 0;
  member RECORD;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin'], true);
  UPDATE etna_platform.workspace_suspensions s SET lifted_at = now(), lifted_by = auth.uid()
   WHERE s.workspace_id = p_workspace_id AND s.lifted_at IS NULL
  RETURNING s.* INTO suspension;
  IF suspension.id IS NULL THEN
    RAISE EXCEPTION 'This workspace is not suspended' USING ERRCODE = 'P0002';
  END IF;

  IF p_enable_members THEN
    FOR member IN
      SELECT u.id, u.email FROM auth.users u
       WHERE u.id = ANY(suspension.disabled_user_ids) AND u.banned_until IS NOT NULL
    LOOP
      UPDATE auth.users SET banned_until = NULL, updated_at = now() WHERE id = member.id;
      enabled := enabled + 1;
      PERFORM etna_platform._log('USER_ENABLED', 'success', 'admin', member.id, member.email, p_workspace_id,
        jsonb_build_object('via', 'workspace_reactivation'));
    END LOOP;
  END IF;

  PERFORM etna_platform._log('WORKSPACE_REACTIVATED', 'success', 'admin', NULL, NULL, p_workspace_id,
    jsonb_build_object('members_enabled', enabled));
  RETURN enabled;
END;
$$;

-- ─── 7. Security log: filter by account or workspace ──────────────────────────

DROP FUNCTION IF EXISTS etna_platform.admin_security_events(BIGINT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION etna_platform.admin_security_events(
  p_before_id BIGINT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_event_type TEXT DEFAULT NULL,
  p_query TEXT DEFAULT NULL,
  p_outcome TEXT DEFAULT NULL,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_workspace_id UUID DEFAULT NULL
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
     AND (p_user_id IS NULL OR e.target_user_id = p_user_id OR e.actor_user_id = p_user_id)
     AND (p_workspace_id IS NULL OR e.workspace_id = p_workspace_id)
     AND (needle IS NULL
          OR lower(e.actor_email) LIKE pattern
          OR lower(e.target_email) LIKE pattern
          OR e.ip = needle)
   ORDER BY e.id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$$;

-- ─── 8. Grants ────────────────────────────────────────────────────────────────

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA etna_platform FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_my_suspended_workspaces() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_suspended_workspace_ids() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.erp_my_suspended_workspaces() TO authenticated;
-- Evaluated by the row-level policies above, as the signed-in user.
GRANT EXECUTE ON FUNCTION public.erp_suspended_workspace_ids() TO authenticated;

GRANT EXECUTE ON FUNCTION etna_platform.admin_security_events(BIGINT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_list_users(TEXT, TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_user_detail(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_list_workspaces(TEXT, TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_workspace_detail(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_disable_user(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_enable_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_end_sessions(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_create_reset_link(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_reset_mfa(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_create_user(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_suspend_workspace(UUID, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_reactivate_workspace(UUID, BOOLEAN) TO authenticated;
-- Re-granted after the REVOKE above (unchanged from 20261012000011).
GRANT EXECUTE ON FUNCTION etna_platform.my_admin_role() TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_list_admins() TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_set_role(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_revoke_role(TEXT) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') THEN
    GRANT EXECUTE ON FUNCTION etna_platform.log_auth_event(TEXT, TEXT, UUID, TEXT, UUID, TEXT, TEXT, JSONB) TO etna_auth;
    GRANT EXECUTE ON FUNCTION etna_platform.password_link_check(TEXT) TO etna_auth;
    GRANT EXECUTE ON FUNCTION etna_platform.password_link_use(TEXT) TO etna_auth;
    GRANT EXECUTE ON FUNCTION etna_platform.password_links_revoke(UUID) TO etna_auth;
  END IF;
END;
$$;
