-- Rollback for 20261012000050_definer_search_path.sql.
-- Run only after redeploying an app version from before this change.

BEGIN;
ALTER FUNCTION public.handle_new_user() RESET search_path;
ALTER FUNCTION public.erp_invoice_to_transaction() RESET search_path;
COMMIT;
