-- ─── No self sign-up, enforced in the database ──────────────────────────────
-- Accounts are created only by an administrator (scripts/admin/users.mjs or
-- etna_admin.create_user, both as the schema owner). The web app never creates
-- one: /api/auth has no sign-up action, and anon/authenticated have no rights
-- on auth.users (db/bootstrap/0000_postgres_bootstrap.sql).
--
-- The bootstrap still granted INSERT on auth.users to `etna_auth`, the role the
-- sign-in server connects as. Nothing uses it, so it is removed: even a flaw in
-- the web server cannot create an account. etna_auth keeps SELECT and UPDATE
-- (sign-in time, password change).
--
-- Workspace invitations / access codes are unaffected: they add an existing,
-- signed-in account to a workspace and never create accounts.
--
-- Only on the plain-PostgreSQL schema (no-op where the role does not exist).
-- Existing accounts, invitations and data are not touched.
--
-- Rollback: db/rollback/rollback_20261003000000_auth_no_self_signup.sql

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') AND to_regclass('auth.users') IS NOT NULL THEN
    REVOKE INSERT ON auth.users FROM etna_auth;
  END IF;
END;
$$;
