-- ─── ETNA on plain PostgreSQL: roles and the `auth` schema ────────────────────
-- Applied ONCE, before supabase/migrations/*, and ONLY on a database that is
-- not a Supabase project (scripts/db/migrate.mjs refuses Supabase databases).
-- See docs/BACKEND_MIGRATION.md §2.
--
-- It provides exactly what the ETNA migrations expect from Supabase, so they
-- run unchanged:
--   * roles `anon` and `authenticated`, with Supabase's default privileges on
--     new objects in `public` (row-level security then restricts rows);
--   * `extensions.pgcrypto` (extensions.digest / gen_random_bytes);
--   * `auth.users`, `auth.mfa_factors`, `auth.uid()`, `auth.jwt()`.
-- Plus what the new backend needs: `auth.sessions`, `auth.login_attempts`,
-- and the application roles described below.
--
-- `auth.users` deliberately has no Supabase-internal columns (instance_id,
-- aud, tokens, …). The first ETNA migration tries to create a demo account
-- with a known password using those columns; on this schema that insert fails
-- and is skipped (it runs in an exception block), so no demo account exists.
--
-- Roles are created without LOGIN and without passwords. An administrator
-- enables login and sets passwords outside source control, e.g.
--   ALTER ROLE etna_app  LOGIN PASSWORD '…';
--   ALTER ROLE etna_auth LOGIN PASSWORD '…';
-- Run this file (and all migrations) as the role that should own the schema.

-- ─── Roles ────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  -- The application server. It has no privileges of its own: every request
  -- runs inside a transaction with SET LOCAL ROLE authenticated (or anon) and
  -- the user's claims, so row-level security always applies. Without that
  -- step its queries are denied (fail closed). Never a superuser, never
  -- BYPASSRLS, owns nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_app') THEN
    CREATE ROLE etna_app NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  -- The sign-in layer: sessions, password hashes and 2FA secrets only.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') THEN
    CREATE ROLE etna_auth NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END;
$$;

-- etna_app may switch to anon/authenticated but does not inherit their rights.
GRANT anon, authenticated TO etna_app;

-- ─── Extensions ───────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated;

-- ─── Default privileges (as on Supabase) ─────────────────────────────────────
-- Objects the migrations create in `public` are usable by anon/authenticated;
-- RLS policies and the migrations' own REVOKEs decide what is allowed.

GRANT USAGE ON SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;

-- ─── auth schema ──────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, etna_auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  -- bcrypt ($2a$/$2b$), compatible with hashes exported from Supabase Auth.
  encrypted_password TEXT,
  raw_user_meta_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  email_confirmed_at TIMESTAMPTZ,
  -- Sign-in blocked until this time (admin lock); NULL = not blocked.
  banned_until TIMESTAMPTZ,
  last_sign_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email_key ON auth.users (lower(email));

-- Authenticator devices (TOTP). The secret is encrypted by the application
-- (AES-256-GCM); the database never sees it in plain text.
CREATE TABLE IF NOT EXISTS auth.mfa_factors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  friendly_name TEXT,
  factor_type TEXT NOT NULL DEFAULT 'totp' CHECK (factor_type = 'totp'),
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'verified')),
  secret_enc TEXT,
  -- Last accepted time step, so a code cannot be replayed.
  last_used_step BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_mfa_factors_user_idx ON auth.mfa_factors (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS auth_mfa_factors_name_key ON auth.mfa_factors (user_id, friendly_name);

-- Server-side sessions: the cookie holds a random token, only its SHA-256
-- hash is stored, so a database leak does not expose usable sessions.
CREATE TABLE IF NOT EXISTS auth.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  aal TEXT NOT NULL DEFAULT 'aal1' CHECK (aal IN ('aal1', 'aal2')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth.sessions (user_id);

-- Failed sign-in attempts, for rate limiting and lockout.
CREATE TABLE IF NOT EXISTS auth.login_attempts (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  ip TEXT,
  succeeded BOOLEAN NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_login_attempts_email_idx ON auth.login_attempts (lower(email), attempted_at DESC);
CREATE INDEX IF NOT EXISTS auth_login_attempts_ip_idx ON auth.login_attempts (ip, attempted_at DESC);

-- Only the sign-in layer touches these tables directly. The ETNA migrations'
-- SECURITY DEFINER functions (owned by the schema owner) still read them.
REVOKE ALL ON auth.users, auth.mfa_factors, auth.sessions, auth.login_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON auth.users TO etna_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.mfa_factors, auth.sessions TO etna_auth;
GRANT SELECT, INSERT, DELETE ON auth.login_attempts TO etna_auth;
GRANT USAGE ON SEQUENCE auth.login_attempts_id_seq TO etna_auth;

-- ─── Claims ───────────────────────────────────────────────────────────────────
-- The server sets `request.jwt.claims` (JSON: sub, email, aal, role) with
-- set_config(..., true) at the start of each transaction — the same setting
-- PostgREST used — so every existing policy and function keeps working.

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(auth.jwt() ->> 'sub', '')::uuid;
$$;

GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid() TO anon, authenticated, etna_auth;
