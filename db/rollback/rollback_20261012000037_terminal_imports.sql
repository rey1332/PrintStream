-- Rollback for 20261012000037_terminal_imports.sql.
-- Run only after redeploying an app version from before this change, with
-- the worker stopped. Import records and rejected rows are removed; the
-- uploaded files stay in the companies' imports folders (delete them by hand).

BEGIN;
DROP FUNCTION IF EXISTS ps_worker.import_file_removed(UUID);
DROP FUNCTION IF EXISTS ps_worker.import_files_to_remove(INTEGER);
DROP FUNCTION IF EXISTS ps_worker.import_finished(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS ps_worker.import_restart(UUID);
DROP FUNCTION IF EXISTS ps_worker.import_progress(UUID, INTEGER, INTEGER, JSONB);
DROP FUNCTION IF EXISTS ps_worker.import_analyzed(UUID, JSONB, INTEGER);
DROP FUNCTION IF EXISTS ps_worker.import_get(UUID);
DROP FUNCTION IF EXISTS public.ps_cancel_import(UUID);
DROP FUNCTION IF EXISTS public.ps_commit_import(UUID, JSONB);
DROP FUNCTION IF EXISTS public.ps_reanalyze_import(UUID, JSONB);
DROP FUNCTION IF EXISTS public.ps_create_import(UUID, UUID, TEXT, TEXT, BIGINT);
DROP TABLE IF EXISTS public.ps_import_rejects;
DROP TABLE IF EXISTS public.ps_imports;
DROP FUNCTION IF EXISTS public.ps_can_see_import(UUID, UUID);
DELETE FROM public.ps_jobs WHERE kind IN ('import.analyze', 'import.commit');
REVOKE ALL ON FUNCTION etna_platform.storage_state(UUID) FROM etna_worker;
COMMIT;
