-- Rollback for 20261012000051_shared_rate_limits.sql.
-- Run only after redeploying an app version from before shared request
-- limits (that version counts in memory). Drops the counts.

BEGIN;

DROP TABLE IF EXISTS auth.request_limits;

COMMIT;
