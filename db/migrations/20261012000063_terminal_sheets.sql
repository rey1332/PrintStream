-- TERMINAL spreadsheets online (P2, read): Google Sheets and Excel workbooks
-- in OneDrive / SharePoint as a connection (kind 'sheets').
--
-- * The connection holds how to sign in: Google by a link anyone may view
--   (nothing to keep) or a service account the sheet is shared with (its JSON
--   key, sealed); Microsoft by an app registration with Files.Read.All
--   (client credentials, the secret sealed).
-- * Each sync reads one tab, optionally one range, under a header row
--   (ps_syncs.source: {mode: 'sheet', url, sheet, range, header_row, key};
--   object 'sheet'). With a key column rows are updated in place; a run that
--   reads exactly what the last one did leaves the dataset as it is.
-- * Syncing needs 'integrations.use', like every other source.
--
-- Rollback: db/rollback/rollback_20261012000063_terminal_sheets.sql

ALTER TABLE public.ps_connections DROP CONSTRAINT IF EXISTS ps_connections_kind_check;
ALTER TABLE public.ps_connections ADD CONSTRAINT ps_connections_kind_check
  CHECK (kind IN ('accurate', 'jurnal', 'odoo', 'sap_b1', 'postgres', 'rest', 'web', 'mcp', 'sheets'));

-- A sync of one table or query of a database, one endpoint of an API, one
-- source of a website, an MCP tool or resource, or one tab of a spreadsheet.
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
  IF mode IS NULL OR NOT ((c.kind = 'postgres' AND mode IN ('table', 'query')) OR (c.kind = 'rest' AND mode = 'rest') OR (c.kind = 'web' AND mode = 'web') OR (c.kind = 'mcp' AND mode = 'mcp') OR (c.kind = 'sheets' AND mode = 'sheet')) THEN
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
  IF mode = 'mcp' THEN
    IF COALESCE(p_source ->> 'what', '') NOT IN ('tool', 'resource') OR COALESCE(p_source ->> 'name', '') = '' THEN
      RAISE EXCEPTION 'An MCP sync names its tool or resource' USING ERRCODE = '22023';
    END IF;
    -- A tool only once it is approved, as the server describes it now.
    IF p_source ->> 'what' = 'tool' AND NOT EXISTS (
      SELECT 1 FROM public.ps_mcp_tools t
       WHERE t.connection_id = c.id AND t.name = p_source ->> 'name' AND t.approved_hash = t.schema_hash) THEN
      RAISE EXCEPTION 'Approve the tool first' USING ERRCODE = 'P0001', HINT = 'mcpToolUnapproved';
    END IF;
  END IF;
  IF mode = 'sheet' AND char_length(COALESCE(p_source ->> 'url', '')) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'A spreadsheet sync names its sheet' USING ERRCODE = '22023';
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
