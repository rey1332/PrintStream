-- Rollback for 20261012000011_platform_admin_security_log.sql.
-- Run only after redeploying an app version from before this change (one
-- that does not read auth.sessions.reauthenticated_at or call etna_platform).
--
-- Drops the platform admin roles and the security event log WITH ALL ITS
-- EVENTS — export them first if they are needed:
--   \copy (select * from etna_platform.security_events order by id) to 'security_events.csv' csv header
-- Restores the etna_admin account functions without event logging.

BEGIN;

DROP FUNCTION IF EXISTS etna_admin.log_event(TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS etna_admin.grant_platform_admin(TEXT, TEXT);
DROP FUNCTION IF EXISTS etna_admin.revoke_platform_admin(TEXT);
DROP FUNCTION IF EXISTS etna_admin.set_security_log_retention(INTEGER);
DROP FUNCTION IF EXISTS etna_admin.purge_security_events();

-- As in 20261002000000_admin_user_functions.sql.
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
BEGIN
  UPDATE auth.users SET encrypted_password = extensions.crypt(chosen, extensions.gen_salt('bf', 12)), updated_at = now()
   WHERE id = target;
  -- A new password ends every existing sign-in.
  UPDATE auth.sessions SET revoked_at = now() WHERE user_id = target AND revoked_at IS NULL;
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
  ended INTEGER;
BEGIN
  UPDATE auth.sessions SET revoked_at = now() WHERE user_id = etna_admin._user_id(p_email) AND revoked_at IS NULL;
  GET DIAGNOSTICS ended = ROW_COUNT;
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
END;
$$;

CREATE OR REPLACE FUNCTION etna_admin.unlock_user(p_email TEXT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = auth, pg_temp
AS $$
BEGIN
  UPDATE auth.users SET banned_until = NULL, updated_at = now() WHERE id = etna_admin._user_id(p_email);
END;
$$;

DROP FUNCTION IF EXISTS etna_admin._log(TEXT, UUID, JSONB);
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA etna_admin FROM PUBLIC;

DROP SCHEMA IF EXISTS etna_platform CASCADE;

DO $$
BEGIN
  IF to_regclass('auth.sessions') IS NOT NULL THEN
    ALTER TABLE auth.sessions DROP COLUMN IF EXISTS reauthenticated_at;
  END IF;
END;
$$;

COMMIT;
