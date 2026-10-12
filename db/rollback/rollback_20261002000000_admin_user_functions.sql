-- Rollback for 20261002000000_admin_user_functions.sql.
-- Removes the SQL admin helpers only; accounts and passwords are untouched.
-- Account management then goes through scripts/admin/users.mjs.
BEGIN;
DROP SCHEMA IF EXISTS etna_admin CASCADE;
COMMIT;
