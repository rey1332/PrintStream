-- Rollback for 20261012000042_terminal_db_sources.sql.
-- Database connections and their syncs are removed; the datasets the syncs
-- filled stay.

BEGIN;
DROP FUNCTION IF EXISTS public.ps_create_source_sync(UUID, JSONB, TEXT, TEXT, JSONB);
DELETE FROM public.ps_syncs WHERE source IS NOT NULL;
DELETE FROM public.ps_connections WHERE kind = 'postgres';
DELETE FROM public.ps_jobs WHERE kind = 'connector.describe';
DROP INDEX IF EXISTS public.ps_syncs_erp_object;
ALTER TABLE public.ps_syncs ADD CONSTRAINT ps_syncs_connection_id_object_key UNIQUE (connection_id, object);
ALTER TABLE public.ps_syncs DROP COLUMN IF EXISTS label;
ALTER TABLE public.ps_syncs DROP COLUMN IF EXISTS source;
ALTER TABLE public.ps_connections DROP CONSTRAINT IF EXISTS ps_connections_kind_check;
ALTER TABLE public.ps_connections ADD CONSTRAINT ps_connections_kind_check
  CHECK (kind IN ('accurate', 'jurnal', 'odoo', 'sap_b1'));
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
    WHEN 'connector.test' THEN 'integrations.use'
    WHEN 'connector.sync' THEN 'integrations.use'
    WHEN 'connector.oauth' THEN 'integrations.manage'
    ELSE NULL
  END;
$$;
REVOKE ALL ON FUNCTION public.ps_job_permission(TEXT) FROM PUBLIC, anon, authenticated;
COMMIT;
