-- ─── Account administration from SQL (pgAdmin) ─────────────────────────────
-- Additive. Lets an administrator manage sign-in accounts with plain SQL in
-- pgAdmin instead of scripts/admin/users.mjs:
--
--   select * from etna_admin.create_user('ana@company.com', 'Ana');   -- temporary password returned once
--   select * from etna_admin.users;                                    -- accounts, 2FA devices, sessions
--   select * from etna_admin.set_password('ana@company.com');          -- new temporary password, sessions ended
--   select etna_admin.reset_mfa('ana@company.com');                    -- lost phone, no recovery code
--   select etna_admin.lock_user('ana@company.com');  / unlock_user(...)
--   select etna_admin.revoke_sessions('ana@company.com');
--
-- Passwords are stored as bcrypt hashes (pgcrypto, cost 12) — the format the
-- app checks. Leaving the password out generates a random temporary one, so
-- no password appears in the query text (pgAdmin keeps a query history).
--
-- Only the schema owner and superusers can use these: the schema and every
-- function are closed to PUBLIC, and the app roles (etna_app, etna_auth,
-- anon, authenticated) have no access. The functions run with the caller's
-- rights (no SECURITY DEFINER).
--
-- Rollback: db/rollback/rollback_20261002000000_admin_user_functions.sql

CREATE SCHEMA IF NOT EXISTS etna_admin;
REVOKE ALL ON SCHEMA etna_admin FROM PUBLIC;

CREATE OR REPLACE FUNCTION etna_admin._user_id(p_email TEXT)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = auth, pg_temp
AS $$
DECLARE
  found UUID;
BEGIN
  SELECT u.id INTO found FROM auth.users u WHERE lower(u.email) = lower(trim(p_email));
  IF found IS NULL THEN
    RAISE EXCEPTION 'No account for %', p_email USING ERRCODE = 'P0002';
  END IF;
  RETURN found;
END;
$$;

CREATE OR REPLACE FUNCTION etna_admin._password(p_password TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = extensions, pg_temp
AS $$
DECLARE
  chosen TEXT := COALESCE(p_password, translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/=', '-_'));
BEGIN
  IF length(chosen) < 10 THEN
    RAISE EXCEPTION 'Passwords need at least 10 characters' USING ERRCODE = '22023';
  END IF;
  RETURN chosen;
END;
$$;

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

-- Overview for pgAdmin (only on the ETNA auth schema, which has sessions).
DO $$
BEGIN
  IF to_regclass('auth.sessions') IS NULL THEN
    RAISE NOTICE 'auth.sessions not found; etna_admin.users view not created';
    RETURN;
  END IF;
  EXECUTE $view$
    CREATE OR REPLACE VIEW etna_admin.users AS
    SELECT u.email,
           u.raw_user_meta_data ->> 'full_name' AS full_name,
           u.created_at,
           u.last_sign_in_at,
           COALESCE(u.banned_until > now(), false) AS locked,
           (SELECT count(*) FROM auth.mfa_factors f WHERE f.user_id = u.id AND f.status = 'verified')::int AS devices_2fa,
           (SELECT count(*) FROM auth.sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now())::int AS active_sessions
      FROM auth.users u
     ORDER BY u.created_at
  $view$;
  REVOKE ALL ON etna_admin.users FROM PUBLIC;
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA etna_admin FROM PUBLIC;
