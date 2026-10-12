-- Rollback for 20261012000016_erp_party_balances.sql.
-- Run only after redeploying an app version from before this change (which
-- shows the old, typed-in balance columns again).

BEGIN;
DROP FUNCTION IF EXISTS public.erp_party_balances(UUID, TEXT, UUID[]);
COMMIT;
