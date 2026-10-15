-- Rollback for 20261012000052_session_limits.sql.
-- Run only after redeploying an app version from before per-role session
-- limits. Every session then has the 12-hour limit again.

BEGIN;

DROP FUNCTION IF EXISTS etna_platform.session_idle_class(UUID);
ALTER TABLE IF EXISTS auth.sessions DROP COLUMN IF EXISTS shared;

COMMIT;
