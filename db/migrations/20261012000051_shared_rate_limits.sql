-- Request limits kept in the database, for limits that are not about a
-- signed-in user (those use public.api_rate_limit_hit): today the checks of
-- one-time password links, per client address.
--
-- Before this, the sign-in server counted these in its own memory: a restart
-- reset them, and with several app servers (or a restarted one) each counted
-- alone. The count now lives here and holds for every server.
--
-- Only on the plain-PostgreSQL schema (no-op where the auth roles do not
-- exist). Rollback: db/rollback/rollback_20261012000051_shared_rate_limits.sql

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') AND to_regclass('auth.users') IS NOT NULL THEN
    CREATE TABLE IF NOT EXISTS auth.request_limits (
      bucket TEXT NOT NULL CHECK (char_length(bucket) BETWEEN 1 AND 64),
      key TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 128),
      window_start TIMESTAMPTZ NOT NULL,
      hits INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (bucket, key, window_start)
    );
    CREATE INDEX IF NOT EXISTS auth_request_limits_window_idx ON auth.request_limits (window_start);

    REVOKE ALL ON auth.request_limits FROM PUBLIC, anon, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth.request_limits TO etna_auth;
  END IF;
END;
$$;
