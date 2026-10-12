-- Rollback for 20261012000040_company_export.sql.
-- Export records are removed; export files stay in the companies' artifacts
-- folders (they go with the company's deletion, or delete them by hand).

BEGIN;
DROP FUNCTION IF EXISTS public.erp_company_export_file(UUID);
DROP FUNCTION IF EXISTS public.erp_company_exports(UUID);
DROP FUNCTION IF EXISTS public.erp_request_company_export(UUID);
DROP FUNCTION IF EXISTS public.erp__export_window_open(UUID);
DROP FUNCTION IF EXISTS ps_admin.export_dataset_rows(UUID, BIGINT, INTEGER);
DROP FUNCTION IF EXISTS ps_worker.export_finished(UUID, TEXT, TEXT, BIGINT, TEXT);
DROP FUNCTION IF EXISTS ps_worker.export_datasets(UUID);
DROP FUNCTION IF EXISTS ps_worker.export_rows(UUID, TEXT, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS ps_worker.export_tables();
DROP FUNCTION IF EXISTS ps_worker.export_get(UUID);
DROP TABLE IF EXISTS etna_platform.workspace_exports;
DELETE FROM public.ps_jobs WHERE kind = 'workspace.export';
REVOKE SELECT ON etna_platform.workspace_terminations FROM etna_ddl;
REVOKE USAGE ON SCHEMA etna_platform FROM etna_ddl;
COMMIT;
