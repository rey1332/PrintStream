-- Fixed search_path on the last two SECURITY DEFINER functions without one.
--
-- handle_new_user() and erp_invoice_to_transaction() are trigger functions
-- (nobody may call them directly), but they run as their owner, so they now
-- resolve names in public only, like every other SECURITY DEFINER function.
-- tests/db/securityHardening.test.mjs keeps it that way.
--
-- Rollback: db/rollback/rollback_20261012000050_definer_search_path.sql

ALTER FUNCTION public.handle_new_user() SET search_path = public;
ALTER FUNCTION public.erp_invoice_to_transaction() SET search_path = public;
