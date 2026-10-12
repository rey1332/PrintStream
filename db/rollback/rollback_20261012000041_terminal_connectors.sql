-- Rollback for 20261012000041_terminal_connectors.sql.
-- Connections, their encrypted secrets and syncs are removed; the datasets the
-- syncs filled stay.

BEGIN;
DROP FUNCTION IF EXISTS etna_platform.admin_connector_private_hosts();
DROP FUNCTION IF EXISTS etna_platform.admin_set_connector_private_hosts(TEXT[]);
DROP FUNCTION IF EXISTS ps_worker.sync_fired(UUID, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS ps_worker.due_syncs(INTEGER);
DROP FUNCTION IF EXISTS ps_worker.sync_finished(UUID, BOOLEAN, JSONB, BOOLEAN, INTEGER, INTEGER, TEXT);
DROP FUNCTION IF EXISTS ps_worker.sync_get(UUID);
DROP FUNCTION IF EXISTS ps_worker.connection_update(UUID, TEXT, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS ps_worker.connection_get(UUID);
DROP FUNCTION IF EXISTS public.ps_delete_sync(UUID);
DROP FUNCTION IF EXISTS public.ps_set_sync(UUID, BOOLEAN, TEXT, JSONB, TEXT, TIMESTAMPTZ, INTEGER);
DROP FUNCTION IF EXISTS public.ps_create_sync(UUID, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.ps_delete_connection(UUID);
DROP FUNCTION IF EXISTS public.ps_save_connection(UUID, UUID, TEXT, TEXT, JSONB, TEXT);
DROP FUNCTION IF EXISTS public.ps__require_connection_manager(UUID);
DROP TABLE IF EXISTS public.ps_syncs;
DROP TABLE IF EXISTS etna_platform.connection_secrets;
DROP TABLE IF EXISTS public.ps_connections;
DELETE FROM public.ps_jobs WHERE kind IN ('connector.test', 'connector.sync', 'connector.oauth');
CREATE OR REPLACE FUNCTION public.ps_job_permission(p_kind TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_kind
    WHEN 'dataset.provision' THEN 'datasets.schema'
    WHEN 'dataset.alter' THEN 'datasets.schema'
    WHEN 'dataset.delete' THEN 'datasets.delete'
    WHEN 'dataset.export' THEN 'datasets.export'
    WHEN 'import.analyze' THEN 'datasets.import'
    WHEN 'import.commit' THEN 'datasets.import'
    WHEN 'pipeline.run' THEN 'pipelines.run'
    ELSE NULL
  END;
$$;
ALTER TABLE etna_platform.settings DROP COLUMN IF EXISTS connector_private_hosts;
COMMIT;
