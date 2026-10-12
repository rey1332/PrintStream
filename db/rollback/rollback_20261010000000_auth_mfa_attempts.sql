-- Rollback for 20261010000000_auth_mfa_attempts.sql.
-- Run only after redeploying an app version from before the two-factor
-- lockout (that version does not use the table). Drops the attempt history.

BEGIN;

DROP TABLE IF EXISTS auth.mfa_attempts;

COMMIT;
