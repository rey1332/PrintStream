-- TERMINAL database sources (P2): another PostgreSQL database as a connection
-- (kind 'postgres'), synced table by table, or through a read-only query,
-- into datasets.
--
-- * A sync of a database keeps what it reads in ps_syncs.source:
--   {mode: 'table', schema, table} or {mode: 'query', sql}, plus the key
--   column (rows are updated by it) and the "changed" column (incremental
--   reads), both optional. ps_syncs.object is then 'table' or 'query', and a
--   connection can have many.
-- * Syncing a table needs 'integrations.use', like an ERP list. A query is
--   any SQL the database accepts in a read-only transaction, so it needs
--   'integrations.manage' and a two-factor sign-in, and the audit log keeps it.
-- * The app's worker connects through the same guard as for ERPs (public
--   addresses only unless ETNA allows the host; TLS unless the host is an
--   allowed internal one) and reads in read-only transactions with time limits.
--
-- Rollback: db/rollback/rollback_20261012000042_terminal_db_sources.sql

ALTER TABLE public.ps_connections DROP CONSTRAINT IF EXISTS ps_connections_kind_check;
ALTER TABLE public.ps_connections ADD CONSTRAINT ps_connections_kind_check
  CHECK (kind IN ('accurate', 'jurnal', 'odoo', 'sap_b1', 'postgres'));

ALTER TABLE public.ps_syncs ADD COLUMN IF NOT EXISTS source JSONB
  CHECK (source IS NULL OR (jsonb_typeof(source) = 'object' AND pg_column_size(source) <= 24576));
ALTER TABLE public.ps_syncs ADD COLUMN IF NOT EXISTS label TEXT
  CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 200);
ALTER TABLE public.ps_syncs DROP CONSTRAINT IF EXISTS ps_syncs_connection_id_object_key;
-- One sync per ERP list; a database can have any number.
CREATE UNIQUE INDEX IF NOT EXISTS ps_syncs_erp_object ON public.ps_syncs (connection_id, object) WHERE source IS NULL;

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
    WHEN 'connector.describe' THEN 'integrations.use'
    ELSE NULL
  END;
$$;
REVOKE ALL ON FUNCTION public.ps_job_permission(TEXT) FROM PUBLIC, anon, authenticated;

-- A sync of one table or query of a database connection into a new dataset
-- (columns as the worker described them, types as the user chose).
CREATE OR REPLACE FUNCTION public.ps_create_source_sync(
  p_connection_id UUID, p_source JSONB, p_label TEXT, p_dataset_name TEXT, p_columns JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.ps_connections;
  mode TEXT := p_source ->> 'mode';
  ds UUID;
  sync UUID;
BEGIN
  SELECT * INTO c FROM public.ps_connections x WHERE x.id = p_connection_id;
  IF c.id IS NULL OR NOT public.erp_has_permission(c.workspace_id, 'integrations.use') THEN
    RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002';
  END IF;
  IF c.kind <> 'postgres' OR mode IS NULL OR mode NOT IN ('table', 'query') THEN
    RAISE EXCEPTION 'Not a database source' USING ERRCODE = '22023';
  END IF;
  IF mode = 'table' AND (COALESCE(p_source ->> 'schema', '') = '' OR COALESCE(p_source ->> 'table', '') = '') THEN
    RAISE EXCEPTION 'A table sync names its schema and table' USING ERRCODE = '22023';
  END IF;
  IF mode = 'query' THEN
    -- Any read-only SQL: for those who manage connections, with two-factor.
    PERFORM public.ps__require_connection_manager(c.workspace_id);
    IF char_length(COALESCE(p_source ->> 'sql', '')) NOT BETWEEN 1 AND 20000 THEN
      RAISE EXCEPTION 'The query is empty or too long' USING ERRCODE = '22023';
    END IF;
  END IF;
  ds := public.ps_create_dataset(c.workspace_id, p_dataset_name, c.name, 'Synced from ' || c.name || ' (' || left(btrim(p_label), 200) || ')', p_columns);
  INSERT INTO public.ps_syncs (workspace_id, connection_id, object, source, label, dataset_id, run_as, run_as_aal, created_by)
  VALUES (c.workspace_id, c.id, mode, p_source, left(btrim(p_label), 200), ds, auth.uid(), public.erp_session_aal(), auth.uid())
  RETURNING id INTO sync;
  UPDATE public.ps_datasets SET erp_area = NULL WHERE id = ds;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (c.workspace_id, auth.uid(), 'sync.added', jsonb_build_object('sync_id', sync, 'connection_id', c.id, 'object', mode, 'source', p_source, 'dataset_id', ds));
  RETURN sync;
END;
$$;
REVOKE ALL ON FUNCTION public.ps_create_source_sync(UUID, JSONB, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_create_source_sync(UUID, JSONB, TEXT, TEXT, JSONB) TO authenticated;
