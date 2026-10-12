-- Rollback for 20261003000000_auth_no_self_signup.sql.
-- Gives the sign-in role back the INSERT right on auth.users it had from the
-- bootstrap. The app still has no sign-up action; accounts are untouched.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') AND to_regclass('auth.users') IS NOT NULL THEN
    GRANT INSERT ON auth.users TO etna_auth;
  END IF;
END;
$$;
COMMIT;
