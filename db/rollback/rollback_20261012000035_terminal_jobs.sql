-- Rollback for 20261012000035_terminal_jobs.sql.
-- Run only after redeploying an app version from before this change, with
-- the worker stopped. Queued and finished jobs, schedules and chains are
-- removed; nothing they produced is touched.

BEGIN;
DROP FUNCTION IF EXISTS public.ps_delete_trigger(UUID);
DROP FUNCTION IF EXISTS public.ps_save_trigger(UUID, UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.ps_delete_schedule(UUID);
DROP FUNCTION IF EXISTS public.ps_save_schedule(UUID, TEXT, JSONB, TEXT, TIMESTAMPTZ, BOOLEAN);
DROP FUNCTION IF EXISTS public.ps_cancel_job(UUID);
DROP FUNCTION IF EXISTS public.ps_enqueue_job(UUID, TEXT, JSONB, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.ps_job_permission(TEXT);
DROP SCHEMA IF EXISTS ps_worker CASCADE;
DROP TABLE IF EXISTS etna_platform.worker_status;
DROP TABLE IF EXISTS public.ps_triggers;
DROP TABLE IF EXISTS public.ps_schedules;
DROP TABLE IF EXISTS public.ps_jobs;
REVOKE ALL ON FUNCTION etna_platform.purge_by_retention() FROM etna_worker;
REVOKE ALL ON FUNCTION etna_platform.ensure_data_access_partitions(INTEGER) FROM etna_worker;
REVOKE ALL ON FUNCTION etna_platform.record_storage_measure(UUID, BIGINT, BIGINT, BIGINT) FROM etna_worker;
REVOKE ALL ON FUNCTION etna_platform.measure_erp_estimate() FROM etna_worker;
REVOKE ALL ON FUNCTION etna_platform.run_workspace_deletion(UUID) FROM etna_worker;
REVOKE ALL ON FUNCTION etna_platform.log_data_access_system(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB) FROM etna_worker;
REVOKE USAGE ON SCHEMA etna_platform FROM etna_worker;
REVOKE anon, authenticated FROM etna_worker;
-- The role itself stays (other databases on the server may use it); drop it by hand if unused:
--   DROP ROLE etna_worker;
COMMIT;
