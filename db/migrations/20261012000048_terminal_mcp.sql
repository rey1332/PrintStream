-- TERMINAL remote MCP (P2, read): an MCP server as a connection (kind 'mcp').
--
-- * The connection is the server's Streamable HTTP address and its sign-in.
--   The worker lists the server's tools into ps_mcp_tools with a fingerprint
--   (a hash of the name, description, input schema and hints).
-- * A tool may be called only after a member who manages connections, signed
--   in with two-factor, approved it (ps_approve_mcp_tool), and only while its
--   fingerprint is the one approved: a server that changes a tool's
--   description or schema loses the approval until someone approves it again.
--   Approvals are kept in the audit log. P2 approves tools for reading only
--   (risk tier "read"); tools that act come with the approvals of phase 4.
-- * A sync calls one approved tool with fixed arguments, or reads one
--   resource (ps_syncs.source: {mode: 'mcp', what, name, arguments, records,
--   key}; object 'mcp'); the result is stored as data with its provenance.
--   Tool descriptions are shown as quoted text, never used as instructions.
--
-- Rollback: db/rollback/rollback_20261012000048_terminal_mcp.sql

ALTER TABLE public.ps_connections DROP CONSTRAINT IF EXISTS ps_connections_kind_check;
ALTER TABLE public.ps_connections ADD CONSTRAINT ps_connections_kind_check
  CHECK (kind IN ('accurate', 'jurnal', 'odoo', 'sap_b1', 'postgres', 'rest', 'web', 'mcp'));

CREATE TABLE IF NOT EXISTS public.ps_mcp_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.ps_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name ~ '^[A-Za-z0-9_./-]{1,128}$'),
  title TEXT CHECK (title IS NULL OR char_length(title) <= 200),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 4000),
  input_schema JSONB CHECK (input_schema IS NULL OR pg_column_size(input_schema) <= 32768),
  read_only BOOLEAN,
  schema_hash TEXT NOT NULL CHECK (schema_hash ~ '^[0-9a-f]{64}$'),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_hash TEXT CHECK (approved_hash IS NULL OR approved_hash ~ '^[0-9a-f]{64}$'),
  approved_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  UNIQUE (connection_id, name)
);

ALTER TABLE public.ps_mcp_tools ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ps_mcp_tools FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ps_mcp_tools TO authenticated;
DROP POLICY IF EXISTS ps_mcp_tools_read ON public.ps_mcp_tools;
CREATE POLICY ps_mcp_tools_read ON public.ps_mcp_tools FOR SELECT TO authenticated
  USING (public.erp_has_permission(workspace_id, 'integrations.use') OR public.erp_has_permission(workspace_id, 'integrations.manage'));
DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.ps_mcp_tools;
CREATE POLICY erp_workspace_not_suspended ON public.ps_mcp_tools AS RESTRICTIVE FOR ALL TO authenticated
  USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]));

-- Approves a tool as it is now, or withdraws the approval.
CREATE OR REPLACE FUNCTION public.ps_approve_mcp_tool(p_tool_id UUID, p_approve BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.ps_mcp_tools;
BEGIN
  SELECT * INTO t FROM public.ps_mcp_tools x WHERE x.id = p_tool_id;
  IF t.id IS NULL OR NOT (public.erp_has_permission(t.workspace_id, 'integrations.use') OR public.erp_has_permission(t.workspace_id, 'integrations.manage')) THEN
    RAISE EXCEPTION 'Tool not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.ps__require_connection_manager(t.workspace_id);
  UPDATE public.ps_mcp_tools
     SET approved_hash = CASE WHEN p_approve THEN schema_hash END,
         approved_by = CASE WHEN p_approve THEN auth.uid() END,
         approved_at = CASE WHEN p_approve THEN now() END
   WHERE id = t.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (t.workspace_id, auth.uid(), CASE WHEN p_approve THEN 'mcp_tool.approved' ELSE 'mcp_tool.unapproved' END,
          jsonb_build_object('connection_id', t.connection_id, 'tool', t.name, 'hash', t.schema_hash, 'tier', 'read'));
END;
$$;
REVOKE ALL ON FUNCTION public.ps_approve_mcp_tool(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_approve_mcp_tool(UUID, BOOLEAN) TO authenticated;

-- The worker keeps the tools a server lists now (approvals stay with their
-- fingerprint, so a changed tool no longer matches its approval).
CREATE OR REPLACE FUNCTION ps_worker.mcp_tools_seen(p_connection_id UUID, p_tools JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ws UUID;
  n INTEGER;
BEGIN
  SELECT workspace_id INTO ws FROM public.ps_connections WHERE id = p_connection_id AND kind = 'mcp';
  IF ws IS NULL THEN
    RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002';
  END IF;
  WITH listed AS (
    SELECT DISTINCT ON (a.x ->> 'name') a.x
      FROM jsonb_array_elements(COALESCE(p_tools, '[]'::jsonb)) WITH ORDINALITY AS a(x, i)
     WHERE a.i <= 1000
     ORDER BY a.x ->> 'name', a.i)
  INSERT INTO public.ps_mcp_tools (workspace_id, connection_id, name, title, description, input_schema, read_only, schema_hash)
  SELECT ws, p_connection_id, l.x ->> 'name', left(l.x ->> 'title', 200), left(l.x ->> 'description', 4000),
         CASE WHEN jsonb_typeof(l.x -> 'input_schema') = 'object' THEN l.x -> 'input_schema' END,
         (l.x ->> 'read_only')::boolean, l.x ->> 'hash'
    FROM listed l
  ON CONFLICT (connection_id, name) DO UPDATE
     SET title = EXCLUDED.title, description = EXCLUDED.description, input_schema = EXCLUDED.input_schema,
         read_only = EXCLUDED.read_only, schema_hash = EXCLUDED.schema_hash, seen_at = now();
  DELETE FROM public.ps_mcp_tools t
   WHERE t.connection_id = p_connection_id
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_tools, '[]'::jsonb)) e(x) WHERE e.x ->> 'name' = t.name);
  SELECT count(*) INTO n FROM public.ps_mcp_tools WHERE connection_id = p_connection_id;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION ps_worker.mcp_tool_approved(p_connection_id UUID, p_name TEXT, p_hash TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.ps_mcp_tools t
                  WHERE t.connection_id = p_connection_id AND t.name = p_name
                    AND t.schema_hash = p_hash AND t.approved_hash = p_hash);
$$;

REVOKE ALL ON FUNCTION ps_worker.mcp_tools_seen(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ps_worker.mcp_tool_approved(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ps_worker.mcp_tools_seen(UUID, JSONB) TO etna_worker;
GRANT EXECUTE ON FUNCTION ps_worker.mcp_tool_approved(UUID, TEXT, TEXT) TO etna_worker;

-- A sync of one table or query of a database, one endpoint of an API, one
-- source of a website, or one approved tool or resource of an MCP server.
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
  IF mode IS NULL OR NOT ((c.kind = 'postgres' AND mode IN ('table', 'query')) OR (c.kind = 'rest' AND mode = 'rest') OR (c.kind = 'web' AND mode = 'web') OR (c.kind = 'mcp' AND mode = 'mcp')) THEN
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
