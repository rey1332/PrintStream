-- Rollback for 20261012000048_terminal_mcp.sql.
-- MCP connections, their tools and syncs are removed; the datasets they filled stay.

BEGIN;
DROP FUNCTION IF EXISTS ps_worker.mcp_tools_seen(UUID, JSONB);
DROP FUNCTION IF EXISTS ps_worker.mcp_tool_approved(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.ps_approve_mcp_tool(UUID, BOOLEAN);
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
  IF mode IS NULL OR NOT ((c.kind = 'postgres' AND mode IN ('table', 'query')) OR (c.kind = 'rest' AND mode = 'rest') OR (c.kind = 'web' AND mode = 'web')) THEN
    RAISE EXCEPTION 'Not a source of this connection' USING ERRCODE = '22023';
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
  IF mode = 'rest' THEN
    IF COALESCE(p_source ->> 'path', '') !~ '^/' OR COALESCE(p_source ->> 'method', '') NOT IN ('GET', 'POST') THEN
      RAISE EXCEPTION 'An endpoint sync names its method and path' USING ERRCODE = '22023';
    END IF;
    -- POST as query: for those who manage connections, with two-factor.
    IF p_source ->> 'method' = 'POST' THEN
      PERFORM public.ps__require_connection_manager(c.workspace_id);
    END IF;
  END IF;
  IF mode = 'web' AND COALESCE(p_source ->> 'format', '') NOT IN ('table', 'list', 'jsonld', 'feed', 'json', 'csv', 'xml') THEN
    RAISE EXCEPTION 'A website sync names what it reads' USING ERRCODE = '22023';
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

DROP TABLE IF EXISTS public.ps_mcp_tools;
DELETE FROM public.ps_syncs s USING public.ps_connections c WHERE s.connection_id = c.id AND c.kind = 'mcp';
DELETE FROM public.ps_connections WHERE kind = 'mcp';
ALTER TABLE public.ps_connections DROP CONSTRAINT IF EXISTS ps_connections_kind_check;
ALTER TABLE public.ps_connections ADD CONSTRAINT ps_connections_kind_check
  CHECK (kind IN ('accurate', 'jurnal', 'odoo', 'sap_b1', 'postgres', 'rest', 'web'));
COMMIT;
