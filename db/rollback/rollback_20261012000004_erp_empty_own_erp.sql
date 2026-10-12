-- Rollback for 20261012000004_erp_empty_own_erp.sql.
-- Run only after redeploying an app version from before emptying an ERP.
-- ERPs already emptied stay empty.

BEGIN;

DROP FUNCTION IF EXISTS public.erp_empty_erp(UUID);

COMMIT;
