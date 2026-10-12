-- Platform administration (ETNA staff) and the security event log.
--
-- 1. etna_platform.admins: who may open the internal admin panel (/admin), with
--    one of three roles: super_admin (everything, manages admins), support
--    (helps users) and auditor (reads the logs). Separate from workspace roles:
--    being the owner of an ERP never makes anyone a platform admin.
-- 2. etna_platform.security_events: one append-only record per sign-in,
--    account and admin event. No application role can update or delete it; a
--    trigger refuses UPDATE, DELETE and TRUNCATE even for the schema owner,
--    except through etna_admin.purge_security_events() (retention). Rows have
--    no foreign keys, so the history outlives accounts and workspaces. Kept
--    forever unless a retention period is set
--    (etna_admin.set_security_log_retention).
-- 3. auth.sessions.reauthenticated_at: when the session last re-entered a
--    two-factor code. Sensitive admin actions need one in the last 10 minutes.
-- 4. The etna_admin.* account functions (pgAdmin / command line) now write a
--    security event for everything they change, and new owner-only functions
--    grant and revoke platform admin roles (the first super admin is made this
--    way: scripts/admin/users.mjs grant-admin).
--
-- The schema is not `public`, so nothing here is reachable through /api/data.
-- Signed-in users can call only my_admin_role() and the admin_* functions,
-- which check the caller's admin role, a two-factor session and (for changes)
-- a fresh re-authentication themselves. The sign-in server (etna_auth) can
-- only add sign-in events through log_auth_event().
--
-- Rollback: db/rollback/rollback_20261012000011_platform_admin_security_log.sql

CREATE SCHEMA IF NOT EXISTS etna_platform;
REVOKE ALL ON SCHEMA etna_platform FROM PUBLIC;
GRANT USAGE ON SCHEMA etna_platform TO authenticated;

-- ─── 1. Platform admins ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS etna_platform.admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'support', 'auditor')),
  -- NULL = granted from the command line / pgAdmin.
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. Security events ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS etna_platform.security_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  event_type TEXT NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  outcome TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure')),
  -- user = the account itself, admin = a platform admin in the panel,
  -- cli = the schema owner (pgAdmin, scripts/admin/users.mjs), system = ETNA.
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'admin', 'cli', 'system')),
  actor_user_id UUID,
  actor_email TEXT CHECK (char_length(actor_email) <= 320),
  target_user_id UUID,
  target_email TEXT CHECK (char_length(target_email) <= 320),
  workspace_id UUID,
  session_id UUID,
  ip TEXT CHECK (char_length(ip) <= 64),
  user_agent TEXT CHECK (char_length(user_agent) <= 400),
  -- Never passwords, codes, tokens or secrets.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 8192)
);

CREATE INDEX IF NOT EXISTS security_events_time_idx ON etna_platform.security_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS security_events_actor_idx ON etna_platform.security_events (actor_user_id, id DESC) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS security_events_target_idx ON etna_platform.security_events (target_user_id, id DESC) WHERE target_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS security_events_type_idx ON etna_platform.security_events (event_type, id DESC);
CREATE INDEX IF NOT EXISTS security_events_workspace_idx ON etna_platform.security_events (workspace_id, id DESC) WHERE workspace_id IS NOT NULL;

CREATE OR REPLACE FUNCTION etna_platform._security_events_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('etna.security_log_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'The security log is append-only' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS security_events_append_only ON etna_platform.security_events;
CREATE TRIGGER security_events_append_only
  BEFORE UPDATE OR DELETE ON etna_platform.security_events
  FOR EACH ROW EXECUTE FUNCTION etna_platform._security_events_guard();

DROP TRIGGER IF EXISTS security_events_no_truncate ON etna_platform.security_events;
CREATE TRIGGER security_events_no_truncate
  BEFORE TRUNCATE ON etna_platform.security_events
  FOR EACH STATEMENT EXECUTE FUNCTION etna_platform._security_events_guard();

-- Retention: NULL = keep forever (the default).
CREATE TABLE IF NOT EXISTS etna_platform.settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  security_log_retention_days INTEGER CHECK (security_log_retention_days IS NULL OR security_log_retention_days >= 30),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO etna_platform.settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

REVOKE ALL ON etna_platform.admins, etna_platform.security_events, etna_platform.settings
  FROM PUBLIC, anon, authenticated;

-- ─── 3. Re-authentication time on sessions ────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('auth.sessions') IS NOT NULL THEN
    ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS reauthenticated_at TIMESTAMPTZ;
  END IF;
END;
$$;

-- ─── 4. Internal helpers (not callable by any app role) ───────────────────────

-- Writes one event. Actor, session, IP and user agent default to the request:
-- the claims set by the server (sub, sid) and request.ip / request.user_agent,
-- which the admin service sets for its own transactions.
CREATE OR REPLACE FUNCTION etna_platform._log(
  p_event_type TEXT,
  p_outcome TEXT,
  p_actor_kind TEXT,
  p_target_user_id UUID,
  p_target_email TEXT,
  p_workspace_id UUID,
  p_metadata JSONB,
  p_actor_user_id UUID DEFAULT NULL,
  p_actor_email TEXT DEFAULT NULL,
  p_session_id UUID DEFAULT NULL,
  p_ip TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  actor UUID := COALESCE(p_actor_user_id, auth.uid());
  actor_address TEXT := p_actor_email;
  new_id BIGINT;
BEGIN
  IF actor_address IS NULL AND actor IS NOT NULL THEN
    SELECT u.email INTO actor_address FROM auth.users u WHERE u.id = actor;
  END IF;
  INSERT INTO etna_platform.security_events (
    event_type, outcome, actor_kind, actor_user_id, actor_email, target_user_id, target_email,
    workspace_id, session_id, ip, user_agent, metadata
  ) VALUES (
    p_event_type,
    p_outcome,
    p_actor_kind,
    actor,
    left(actor_address, 320),
    p_target_user_id,
    left(p_target_email, 320),
    p_workspace_id,
    COALESCE(p_session_id, NULLIF(auth.jwt() ->> 'sid', '')::uuid),
    left(COALESCE(p_ip, NULLIF(current_setting('request.ip', true), '')), 64),
    left(COALESCE(p_user_agent, NULLIF(current_setting('request.user_agent', true), '')), 400),
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

-- The caller's platform admin role, or NULL.
CREATE OR REPLACE FUNCTION etna_platform._role_of(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
BEGIN
  RETURN (SELECT a.role FROM etna_platform.admins a WHERE a.user_id = p_user_id);
END;
$$;

-- Raises unless the caller is a platform admin with one of p_roles, in a
-- two-factor (aal2) session, and — when p_fresh — re-entered a two-factor code
-- in this session within the last 10 minutes.
CREATE OR REPLACE FUNCTION etna_platform._require_admin(p_roles TEXT[], p_fresh BOOLEAN)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  caller UUID := auth.uid();
  caller_role TEXT;
  current_sid UUID := NULLIF(auth.jwt() ->> 'sid', '')::uuid;
BEGIN
  caller_role := etna_platform._role_of(caller);
  IF caller IS NULL OR caller_role IS NULL OR NOT caller_role = ANY(p_roles) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501', HINT = 'not_admin';
  END IF;
  IF COALESCE(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  IF p_fresh AND NOT EXISTS (
    SELECT 1 FROM auth.sessions s
     WHERE s.id = current_sid AND s.user_id = caller AND s.revoked_at IS NULL
       AND s.reauthenticated_at > now() - interval '10 minutes'
  ) THEN
    RAISE EXCEPTION 'Confirm with a two-factor code first' USING ERRCODE = '42501', HINT = 'reauth_required';
  END IF;
  RETURN caller_role;
END;
$$;

-- ─── 5. Functions for signed-in users (the admin panel) ───────────────────────

CREATE OR REPLACE FUNCTION etna_platform.my_admin_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
BEGIN
  RETURN etna_platform._role_of(auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_list_admins()
RETURNS TABLE (
  user_id UUID, email TEXT, full_name TEXT, role TEXT, granted_at TIMESTAMPTZ,
  granted_by_email TEXT, mfa_enrolled BOOLEAN, last_sign_in_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  RETURN QUERY
  SELECT a.user_id, u.email, COALESCE(u.raw_user_meta_data ->> 'full_name', ''), a.role, a.granted_at,
         g.email,
         EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = a.user_id AND f.status = 'verified'),
         u.last_sign_in_at
    FROM etna_platform.admins a
    JOIN auth.users u ON u.id = a.user_id
    LEFT JOIN auth.users g ON g.id = a.granted_by
   ORDER BY CASE a.role WHEN 'super_admin' THEN 0 WHEN 'support' THEN 1 ELSE 2 END, u.email;
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_set_role(p_email TEXT, p_role TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  caller UUID := auth.uid();
  target UUID;
  target_address TEXT;
  previous TEXT;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin'], true);
  IF p_role IS NULL OR p_role NOT IN ('super_admin', 'support', 'auditor') THEN
    RAISE EXCEPTION 'Unknown admin role' USING ERRCODE = '22023';
  END IF;
  SELECT u.id, u.email INTO target, target_address FROM auth.users u WHERE lower(u.email) = lower(trim(COALESCE(p_email, '')));
  IF target IS NULL THEN
    RAISE EXCEPTION 'No account for that e-mail address' USING ERRCODE = 'P0002';
  END IF;
  -- Nobody changes their own role, so a super admin always remains.
  IF target = caller THEN
    RAISE EXCEPTION 'You cannot change your own admin role' USING ERRCODE = 'P0001', HINT = 'self';
  END IF;
  SELECT a.role INTO previous FROM etna_platform.admins a WHERE a.user_id = target FOR UPDATE;
  IF previous IS NOT DISTINCT FROM p_role THEN
    RETURN p_role;
  END IF;
  INSERT INTO etna_platform.admins (user_id, role, granted_by)
  VALUES (target, p_role, caller)
  ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = now();
  PERFORM etna_platform._log(
    CASE WHEN previous IS NULL THEN 'ADMIN_ROLE_GRANTED' ELSE 'ADMIN_ROLE_CHANGED' END,
    'success', 'admin', target, target_address, NULL,
    jsonb_build_object('role', p_role, 'previous_role', previous)
  );
  RETURN p_role;
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_revoke_role(p_email TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  caller UUID := auth.uid();
  target UUID;
  target_address TEXT;
  previous TEXT;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin'], true);
  SELECT u.id, u.email INTO target, target_address FROM auth.users u WHERE lower(u.email) = lower(trim(COALESCE(p_email, '')));
  IF target IS NULL THEN
    RAISE EXCEPTION 'No account for that e-mail address' USING ERRCODE = 'P0002';
  END IF;
  IF target = caller THEN
    RAISE EXCEPTION 'You cannot change your own admin role' USING ERRCODE = 'P0001', HINT = 'self';
  END IF;
  DELETE FROM etna_platform.admins a WHERE a.user_id = target RETURNING a.role INTO previous;
  IF previous IS NULL THEN
    RAISE EXCEPTION 'That account is not an admin' USING ERRCODE = 'P0002';
  END IF;
  PERFORM etna_platform._log('ADMIN_ROLE_REVOKED', 'success', 'admin', target, target_address, NULL,
    jsonb_build_object('previous_role', previous));
END;
$$;

-- Newest first, keyset-paged by id (p_before_id = the last id already shown).
-- p_query matches part of the actor or target e-mail, or an exact IP address.
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

-- ─── 6. For the sign-in server (etna_auth) ────────────────────────────────────

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

-- ─── 7. Command line / pgAdmin (schema owner only) ────────────────────────────

-- Who ran it, as far as the database knows: the login role and the program.
CREATE OR REPLACE FUNCTION etna_admin._log(p_event_type TEXT, p_target UUID, p_metadata JSONB DEFAULT '{}'::jsonb)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = auth, pg_temp
AS $$
BEGIN
  PERFORM etna_platform._log(
    p_event_type, 'success', 'cli', p_target,
    (SELECT u.email FROM auth.users u WHERE u.id = p_target), NULL,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('db_role', session_user::text,
      'program', NULLIF(current_setting('application_name', true), '')),
    NULL, 'db:' || session_user::text
  );
END;
$$;

-- For scripts/admin/users.mjs, which changes accounts with its own SQL.
CREATE OR REPLACE FUNCTION etna_admin.log_event(p_event_type TEXT, p_email TEXT, p_metadata JSONB DEFAULT '{}'::jsonb)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = auth, pg_temp
AS $$
BEGIN
  IF p_event_type NOT IN (
    'USER_CREATED', 'ADMIN_PASSWORD_SET', 'SESSIONS_REVOKED', 'MFA_RESET', 'USER_DISABLED', 'USER_ENABLED'
  ) THEN
    RAISE EXCEPTION 'Unknown account event %', p_event_type USING ERRCODE = '22023';
  END IF;
  PERFORM etna_admin._log(p_event_type, etna_admin._user_id(p_email), p_metadata);
END;
$$;

CREATE OR REPLACE FUNCTION etna_admin.grant_platform_admin(p_email TEXT, p_role TEXT DEFAULT 'super_admin')
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = auth, pg_temp
AS $$
DECLARE
  target UUID := etna_admin._user_id(p_email);
  previous TEXT;
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('super_admin', 'support', 'auditor') THEN
    RAISE EXCEPTION 'Role must be super_admin, support or auditor' USING ERRCODE = '22023';
  END IF;
  SELECT a.role INTO previous FROM etna_platform.admins a WHERE a.user_id = target FOR UPDATE;
  IF previous IS NOT DISTINCT FROM p_role THEN
    RETURN p_role;
  END IF;
  INSERT INTO etna_platform.admins (user_id, role, granted_by)
  VALUES (target, p_role, NULL)
  ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = NULL, updated_at = now();
  PERFORM etna_admin._log(CASE WHEN previous IS NULL THEN 'ADMIN_ROLE_GRANTED' ELSE 'ADMIN_ROLE_CHANGED' END,
    target, jsonb_build_object('role', p_role, 'previous_role', previous));
  RETURN p_role;
END;
$$;

CREATE OR REPLACE FUNCTION etna_admin.revoke_platform_admin(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = auth, pg_temp
AS $$
DECLARE
  target UUID := etna_admin._user_id(p_email);
  previous TEXT;
BEGIN
  DELETE FROM etna_platform.admins a WHERE a.user_id = target RETURNING a.role INTO previous;
  IF previous IS NULL THEN
    RETURN false;
  END IF;
  PERFORM etna_admin._log('ADMIN_ROLE_REVOKED', target, jsonb_build_object('previous_role', previous));
  RETURN true;
END;
$$;

-- Retention in days (at least 30), or NULL to keep the security log forever.
CREATE OR REPLACE FUNCTION etna_admin.set_security_log_retention(p_days INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = auth, pg_temp
AS $$
DECLARE
  previous INTEGER;
BEGIN
  SELECT s.security_log_retention_days INTO previous FROM etna_platform.settings s WHERE s.id FOR UPDATE;
  UPDATE etna_platform.settings SET security_log_retention_days = p_days, updated_at = now() WHERE id;
  PERFORM etna_admin._log('SECURITY_LOG_RETENTION_CHANGED', NULL,
    jsonb_build_object('days', p_days, 'previous_days', previous));
END;
$$;

-- Deletes events older than the retention period; does nothing while it is
-- "forever". The purge itself is recorded.
CREATE OR REPLACE FUNCTION etna_admin.purge_security_events()
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = auth, pg_temp
AS $$
DECLARE
  keep_days INTEGER;
  removed INTEGER;
BEGIN
  SELECT s.security_log_retention_days INTO keep_days FROM etna_platform.settings s WHERE s.id;
  IF keep_days IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM set_config('etna.security_log_purge', 'on', true);
  DELETE FROM etna_platform.security_events WHERE occurred_at < now() - make_interval(days => keep_days);
  GET DIAGNOSTICS removed = ROW_COUNT;
  PERFORM set_config('etna.security_log_purge', 'off', true);
  PERFORM etna_admin._log('SECURITY_LOG_PURGED', NULL, jsonb_build_object('removed', removed, 'retention_days', keep_days));
  RETURN removed;
END;
$$;

-- The account functions from 20261002000000_admin_user_functions, unchanged
-- except that each now records what it did.

CREATE OR REPLACE FUNCTION etna_admin.create_user(p_email TEXT, p_full_name TEXT DEFAULT NULL, p_password TEXT DEFAULT NULL)
RETURNS TABLE (email TEXT, temporary_password TEXT)
LANGUAGE plpgsql
SET search_path = auth, extensions, pg_temp
AS $$
DECLARE
  address TEXT := trim(COALESCE(p_email, ''));
  chosen TEXT;
BEGIN
  IF address !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'Give a valid e-mail address' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(address)) THEN
    RAISE EXCEPTION 'An account for % already exists', address USING ERRCODE = '23505';
  END IF;
  chosen := etna_admin._password(p_password);
  -- The existing triggers on auth.users create the profile and personal workspace.
  INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
  VALUES (
    address,
    extensions.crypt(chosen, extensions.gen_salt('bf', 12)),
    jsonb_build_object('full_name', COALESCE(NULLIF(trim(p_full_name), ''), split_part(address, '@', 1))),
    now()
  );
  PERFORM etna_admin._log('USER_CREATED', etna_admin._user_id(address),
    jsonb_build_object('temporary_password', p_password IS NULL));
  email := address;
  temporary_password := CASE WHEN p_password IS NULL THEN chosen END;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION etna_admin.set_password(p_email TEXT, p_password TEXT DEFAULT NULL)
RETURNS TABLE (email TEXT, temporary_password TEXT)
LANGUAGE plpgsql
SET search_path = auth, extensions, pg_temp
AS $$
DECLARE
  target UUID := etna_admin._user_id(p_email);
  chosen TEXT := etna_admin._password(p_password);
  ended INTEGER;
BEGIN
  UPDATE auth.users SET encrypted_password = extensions.crypt(chosen, extensions.gen_salt('bf', 12)), updated_at = now()
   WHERE id = target;
  -- A new password ends every existing sign-in.
  UPDATE auth.sessions SET revoked_at = now() WHERE user_id = target AND revoked_at IS NULL;
  GET DIAGNOSTICS ended = ROW_COUNT;
  PERFORM etna_admin._log('ADMIN_PASSWORD_SET', target,
    jsonb_build_object('temporary_password', p_password IS NULL, 'sessions_ended', ended));
  email := trim(p_email);
  temporary_password := CASE WHEN p_password IS NULL THEN chosen END;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION etna_admin.revoke_sessions(p_email TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = auth, pg_temp
AS $$
DECLARE
  target UUID := etna_admin._user_id(p_email);
  ended INTEGER;
BEGIN
  UPDATE auth.sessions SET revoked_at = now() WHERE user_id = target AND revoked_at IS NULL;
  GET DIAGNOSTICS ended = ROW_COUNT;
  PERFORM etna_admin._log('SESSIONS_REVOKED', target, jsonb_build_object('sessions_ended', ended));
  RETURN ended;
END;
$$;

-- Lost authenticator and no recovery code. Confirm the person's identity out
-- of band first, and keep a record of who asked and how they were verified.
CREATE OR REPLACE FUNCTION etna_admin.reset_mfa(p_email TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = auth, public, pg_temp
AS $$
DECLARE
  target UUID := etna_admin._user_id(p_email);
  removed INTEGER;
BEGIN
  DELETE FROM auth.mfa_factors WHERE user_id = target;
  GET DIAGNOSTICS removed = ROW_COUNT;
  DELETE FROM public.erp_mfa_recovery_codes WHERE user_id = target;
  UPDATE auth.sessions SET revoked_at = now() WHERE user_id = target AND revoked_at IS NULL;
  PERFORM etna_admin._log('MFA_RESET', target, jsonb_build_object('devices_removed', removed));
  RETURN removed;
END;
$$;

CREATE OR REPLACE FUNCTION etna_admin.lock_user(p_email TEXT, p_until TIMESTAMPTZ DEFAULT '9999-12-31T00:00:00Z')
RETURNS VOID
LANGUAGE plpgsql
SET search_path = auth, pg_temp
AS $$
DECLARE
  target UUID := etna_admin._user_id(p_email);
BEGIN
  UPDATE auth.users SET banned_until = p_until, updated_at = now() WHERE id = target;
  UPDATE auth.sessions SET revoked_at = now() WHERE user_id = target AND revoked_at IS NULL;
  PERFORM etna_admin._log('USER_DISABLED', target, jsonb_build_object('until', p_until));
END;
$$;

CREATE OR REPLACE FUNCTION etna_admin.unlock_user(p_email TEXT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = auth, pg_temp
AS $$
DECLARE
  target UUID := etna_admin._user_id(p_email);
BEGIN
  UPDATE auth.users SET banned_until = NULL, updated_at = now() WHERE id = target;
  PERFORM etna_admin._log('USER_ENABLED', target);
END;
$$;

-- ─── 8. Grants ────────────────────────────────────────────────────────────────

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA etna_platform FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA etna_admin FROM PUBLIC;

GRANT EXECUTE ON FUNCTION etna_platform.my_admin_role() TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_list_admins() TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_set_role(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_revoke_role(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_security_events(BIGINT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') THEN
    GRANT USAGE ON SCHEMA etna_platform TO etna_auth;
    GRANT EXECUTE ON FUNCTION etna_platform.log_auth_event(TEXT, TEXT, UUID, TEXT, UUID, TEXT, TEXT, JSONB) TO etna_auth;
  END IF;
END;
$$;
