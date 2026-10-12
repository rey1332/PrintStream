-- Rollback for 20261012000046_terminal_rest_tunnels.sql.
-- REST connections and their syncs are removed (the datasets they filled
-- stay), and so are the companies' tunnel entries.

BEGIN;
DROP FUNCTION IF EXISTS etna_platform.admin_network_allowlist();
DROP FUNCTION IF EXISTS etna_platform.admin_add_network_allow(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_remove_network_allow(UUID);
DROP TABLE IF EXISTS etna_platform.network_allowlist;

CREATE OR REPLACE FUNCTION ps_worker.connection_get(p_connection_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform, pg_temp
AS $$
  SELECT to_jsonb(c) || jsonb_build_object(
           'secret', (SELECT s.ciphertext FROM etna_platform.connection_secrets s WHERE s.connection_id = c.id),
           'private_hosts', (SELECT to_jsonb(st.connector_private_hosts) FROM etna_platform.settings st WHERE st.id),
           'terminal_on', public.ps__terminal_on(c.workspace_id))
    FROM public.ps_connections c WHERE c.id = p_connection_id;
$$;

DELETE FROM public.ps_syncs s USING public.ps_connections c WHERE s.connection_id = c.id AND c.kind = 'rest';
DELETE FROM public.ps_connections WHERE kind = 'rest';
ALTER TABLE public.ps_connections DROP CONSTRAINT IF EXISTS ps_connections_kind_check;
ALTER TABLE public.ps_connections ADD CONSTRAINT ps_connections_kind_check
  CHECK (kind IN ('accurate', 'jurnal', 'odoo', 'sap_b1', 'postgres'));

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
COMMIT;
