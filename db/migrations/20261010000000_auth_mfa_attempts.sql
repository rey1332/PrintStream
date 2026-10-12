-- Two-factor code attempts, for a lockout like the one on passwords.
--
-- Before this, /api/auth/verify accepted unlimited guesses: anyone holding a
-- password could try every six-digit code. The sign-in server
-- (src/server/auth/service.ts, verifyFactor) now records each check here and
-- refuses further codes after 5 failures in 15 minutes for the account.
--
-- Only on the plain-PostgreSQL schema (no-op where the auth roles do not
-- exist). Rollback: db/rollback/rollback_20261010000000_auth_mfa_attempts.sql

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') AND to_regclass('auth.users') IS NOT NULL THEN
    CREATE TABLE IF NOT EXISTS auth.mfa_attempts (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      succeeded BOOLEAN NOT NULL,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS auth_mfa_attempts_user_idx ON auth.mfa_attempts (user_id, attempted_at DESC);

    REVOKE ALL ON auth.mfa_attempts FROM PUBLIC, anon, authenticated;
    GRANT SELECT, INSERT, DELETE ON auth.mfa_attempts TO etna_auth;
    GRANT USAGE ON SEQUENCE auth.mfa_attempts_id_seq TO etna_auth;
  END IF;
END;
$$;
