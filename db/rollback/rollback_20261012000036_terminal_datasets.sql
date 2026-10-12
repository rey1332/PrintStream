-- Rollback for 20261012000036_terminal_datasets.sql.
-- Run only after redeploying an app version from before this change, with
-- the worker stopped. EVERY dataset and its rows are dropped: export what you
-- need first.

BEGIN;
DROP FUNCTION IF EXISTS ps_worker.refresh_dataset_sizes();
DROP FUNCTION IF EXISTS ps_worker.dataset_failed(UUID, TEXT);
DROP FUNCTION IF EXISTS ps_worker.identity(UUID);
DROP SCHEMA IF EXISTS ps_admin CASCADE;
DROP SCHEMA IF EXISTS ps_data CASCADE;
DROP FUNCTION IF EXISTS public.ps_record_lineage(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, UUID);
DROP FUNCTION IF EXISTS public.ps_rows_delete(UUID, BIGINT[]);
DROP FUNCTION IF EXISTS public.ps_row_update(UUID, BIGINT, JSONB);
DROP FUNCTION IF EXISTS public.ps_rows_undo_source(UUID, TEXT);
DROP FUNCTION IF EXISTS public.ps_rows_finish_replace(UUID, TEXT);
DROP FUNCTION IF EXISTS public.ps_rows_write(UUID, JSONB, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.ps__writable(UUID, TEXT);
DROP FUNCTION IF EXISTS public.ps__columns(UUID);
DROP FUNCTION IF EXISTS public.ps__count_rows(UUID, INTEGER);
DROP FUNCTION IF EXISTS public.ps__set_dataset_state(UUID, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.ps_set_item_access(TEXT, UUID, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.ps_delete_dataset(UUID);
DROP FUNCTION IF EXISTS public.ps_alter_dataset(UUID, JSONB);
DROP FUNCTION IF EXISTS public.ps_create_dataset(UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.ps__validate_columns(JSONB);
DROP TABLE IF EXISTS public.ps_lineage_edges;
DROP TABLE IF EXISTS public.ps_item_grants;
DROP TABLE IF EXISTS public.ps_dataset_versions;
DROP TABLE IF EXISTS public.ps_dataset_columns;
DROP TABLE IF EXISTS public.ps_datasets;
DROP FUNCTION IF EXISTS public.ps_can_access_dataset(UUID, TEXT);
DROP FUNCTION IF EXISTS public.ps_can_unmask(UUID);
DROP FUNCTION IF EXISTS public.ps_mask_text(TEXT);
DROP FUNCTION IF EXISTS public.ps_sql_type(TEXT);
DROP FUNCTION IF EXISTS public.ps_op_permission(TEXT);
DELETE FROM public.ps_jobs WHERE kind IN ('dataset.provision', 'dataset.alter', 'dataset.purge');
REVOKE ALL ON FUNCTION public.erp_has_permission(UUID, TEXT) FROM etna_ddl;
REVOKE USAGE ON SCHEMA public FROM etna_ddl;
-- The role stays (other databases on the server may use it); drop it by hand if unused:
--   DROP ROLE etna_ddl;
COMMIT;
