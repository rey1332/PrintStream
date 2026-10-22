-- Pipelines: the "JavaScript" step (tf.code; docs/teknis/WORKFLOWS.md, "Code step").
-- A step whose code a member writes, run in a sandbox (QuickJS in a separate
-- process without the server's settings; scripts/server/code-sandbox.mjs).
--
-- * Off by default per workspace: erp_workspaces.pipeline_code_enabled, set
--   only by the Owner with two-factor (ps_set_pipeline_code), in the audit log.
-- * A new permission, pipelines.code ("Write pipeline code"): the Owner has
--   it; custom roles may be given it; it needs two-factor like the other
--   sensitive permissions. Admins do not get it by default.
-- * Saving a pipeline whose code steps changed (added, edited) needs the
--   feature on, the permission and two-factor; every change is in the audit
--   log with a hash of the code. Checked by a trigger on workflows, so the
--   editor, the data API and every function are covered.
-- * MCP connections never write code (ps_mcp_pipeline_create / _update).
-- * Runs check that the feature is still on (ps_pipeline_code_enabled): when
--   the Owner switches it off, code steps stop with an error, nothing else.
--
-- Rollback: db/rollback/rollback_20261012000061_pipeline_code.sql

ALTER TABLE public.erp_workspaces ADD COLUMN IF NOT EXISTS pipeline_code_enabled BOOLEAN NOT NULL DEFAULT false;

-- ─── The permission ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_all_permissions()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    -- ERP (unchanged)
    'read','customers','suppliers','products','inventory','sales','invoicing','fulfillment',
    'purchasing','receiving','payments','members','audit',
    -- Workspace
    'roles.manage','policies.manage','storage.view',
    -- Integrations
    'integrations.manage','integrations.use',
    -- Datasets
    'datasets.view','datasets.query','datasets.import','datasets.edit','datasets.schema',
    'datasets.export','datasets.share','datasets.delete','data.sensitive',
    -- Pipelines
    'pipelines.view','pipelines.create','pipelines.edit','pipelines.run','pipelines.schedule',
    'pipelines.publish','pipelines.disable','pipelines.delete','pipelines.code',
    -- Approvals
    'approvals.decide'
  ]::TEXT[];
$$;

CREATE OR REPLACE FUNCTION public.erp_sensitive_permissions()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY['read','invoicing','payments','members','audit','roles.manage','policies.manage',
               'integrations.manage','datasets.export','data.sensitive','approvals.decide',
               'pipelines.code']::TEXT[];
$$;

CREATE OR REPLACE FUNCTION public.erp_role_permissions(p_role TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_role
    -- Literal lists (tests/unit/erpRules.test.mjs compares them with the app).
    WHEN 'owner' THEN ARRAY['read','customers','suppliers','products','inventory','sales','invoicing','fulfillment','purchasing','receiving','payments','members','audit',
                            'roles.manage','policies.manage','storage.view','integrations.manage','integrations.use','datasets.view','datasets.query','datasets.import','datasets.edit','datasets.schema','datasets.export','datasets.share','datasets.delete','data.sensitive','pipelines.view','pipelines.create','pipelines.edit','pipelines.run','pipelines.schedule','pipelines.publish','pipelines.disable','pipelines.delete','pipelines.code','approvals.decide']
    WHEN 'admin' THEN ARRAY['read','customers','suppliers','products','inventory','sales','invoicing','fulfillment','purchasing','receiving','payments','members','audit',
                            'policies.manage','storage.view','integrations.manage','integrations.use','datasets.view','datasets.query','datasets.import','datasets.edit','datasets.schema','datasets.export','datasets.share','datasets.delete','pipelines.view','pipelines.create','pipelines.edit','pipelines.run','pipelines.schedule','pipelines.publish','pipelines.disable','pipelines.delete','approvals.decide']
    WHEN 'finance' THEN ARRAY['read','invoicing','payments','storage.view','integrations.use',
                              'datasets.view','datasets.query','datasets.import','datasets.edit','datasets.schema','datasets.export',
                              'pipelines.view','pipelines.create','pipelines.edit','pipelines.run']
    WHEN 'sales' THEN ARRAY['customers','sales','invoicing']
    WHEN 'inventory' THEN ARRAY['suppliers','products','inventory','fulfillment','purchasing','receiving']
    ELSE ARRAY[]::TEXT[]
  END;
$$;

-- ─── The switch ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ps_set_pipeline_code(p_workspace_id UUID, p_enabled BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE w public.erp_workspaces;
BEGIN
  SELECT * INTO w FROM public.erp_workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR public.erp_workspace_role(w.id) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the Owner can switch pipeline code on or off' USING ERRCODE = '42501';
  END IF;
  IF public.erp_session_aal() IS DISTINCT FROM 'aal2' THEN
    RAISE EXCEPTION 'Two-factor authentication is required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  IF w.pipeline_code_enabled IS DISTINCT FROM COALESCE(p_enabled, false) THEN
    UPDATE public.erp_workspaces SET pipeline_code_enabled = COALESCE(p_enabled, false), updated_at = now() WHERE id = w.id;
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    VALUES (w.id, auth.uid(), CASE WHEN p_enabled THEN 'pipeline.codeEnabled' ELSE 'pipeline.codeDisabled' END, '{}'::jsonb);
  END IF;
END;
$$;

-- Whether code steps may run in the workspace (members only).
CREATE OR REPLACE FUNCTION public.ps_pipeline_code_enabled(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT w.pipeline_code_enabled FROM public.erp_workspaces w
                    WHERE w.id = p_workspace_id AND public.erp_workspace_role(w.id) IS NOT NULL), false);
$$;

-- ─── Saving code ─────────────────────────────────────────────────────────────

-- The code steps of a pipeline graph (editor graph: nodes[].data), {node id: code}.
CREATE OR REPLACE FUNCTION public.ps__graph_code(p_graph JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_object_agg(n->>'id', COALESCE(n->'data'->'config'->>'code', '')), '{}'::jsonb)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_graph->'nodes') = 'array' THEN p_graph->'nodes' ELSE '[]'::jsonb END) n
   WHERE n->'data'->>'type' = 'tf.code';
$$;

-- Added or edited code steps (a removed one needs no right: it runs nothing).
CREATE OR REPLACE FUNCTION public.ps__code_changed(p_old JSONB, p_new JSONB)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg(k ORDER BY k), '{}')
    FROM jsonb_each_text(public.ps__graph_code(p_new)) AS n(k, v)
   WHERE (public.ps__graph_code(p_old)->>k) IS DISTINCT FROM v;
$$;

CREATE OR REPLACE FUNCTION public.ps_workflow_code_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed TEXT[] := public.ps__code_changed(CASE WHEN TG_OP = 'UPDATE' THEN OLD.graph END, NEW.graph);
  code JSONB;
BEGIN
  IF cardinality(changed) = 0 THEN RETURN NEW; END IF;
  IF NEW.workspace_id IS NULL
     OR NOT COALESCE((SELECT w.pipeline_code_enabled FROM public.erp_workspaces w WHERE w.id = NEW.workspace_id), false) THEN
    RAISE EXCEPTION 'Pipeline code is switched off in this workspace' USING ERRCODE = 'P0001', HINT = 'code_off';
  END IF;
  IF auth.uid() IS NULL OR NOT public.erp_has_permission(NEW.workspace_id, 'pipelines.code')
     OR public.erp_session_aal() IS DISTINCT FROM 'aal2' THEN
    RAISE EXCEPTION 'Writing pipeline code needs the "Write pipeline code" permission and two-factor'
      USING ERRCODE = '42501', HINT = 'code_not_allowed';
  END IF;
  code := public.ps__graph_code(NEW.graph);
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  SELECT NEW.workspace_id, auth.uid(), 'pipeline.codeChanged',
         jsonb_build_object('pipeline_id', NEW.id, 'pipeline', NEW.name, 'node_id', k,
                            'sha256', encode(extensions.digest(convert_to(code->>k, 'UTF8'), 'sha256'), 'hex'),
                            'length', char_length(code->>k))
    FROM unnest(changed) k;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workflow_code_guard ON public.workflows;
CREATE TRIGGER trg_workflow_code_guard
  BEFORE INSERT OR UPDATE OF graph ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.ps_workflow_code_guard();

-- ─── MCP never writes code ───────────────────────────────────────────────────
-- ps_mcp__check_graph (20261012000057) is what both MCP writes call first.

CREATE OR REPLACE FUNCTION public.ps_mcp__no_code(p_old JSONB, p_new JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF cardinality(public.ps__code_changed(p_old, p_new)) > 0 THEN
    RAISE EXCEPTION 'An assistant cannot write pipeline code; a person adds code steps in the editor'
      USING ERRCODE = 'P0001', HINT = 'code_via_mcp';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_mcp_pipeline_create(
  p_token_id UUID, p_workspace_id UUID, p_name TEXT, p_description TEXT, p_graph JSONB
)
RETURNS TABLE (id UUID, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  client TEXT := public.ps_mcp__writer(p_token_id, p_workspace_id);
  v_name TEXT := left(btrim(COALESCE(p_name, '')), 120);
  s JSONB;
  new_id UUID;
  new_at TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL OR client IS NULL THEN
    RAISE EXCEPTION 'This connection may not write' USING ERRCODE = '42501', HINT = 'read_only';
  END IF;
  IF NOT public.erp_has_permission(p_workspace_id, 'pipelines.create') OR NOT public.erp_workspace_mfa_ok(p_workspace_id) THEN
    RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
  END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'Name the pipeline' USING ERRCODE = 'P0001', HINT = 'name'; END IF;
  PERFORM public.ps_mcp__check_graph(p_graph);
  PERFORM public.ps_mcp__no_code(NULL, p_graph);
  s := public.ps_mcp__check_scope(p_token_id, 'create_pipeline', p_graph);
  IF (SELECT count(*) FROM public.workflows w
       WHERE w.user_id = auth.uid() AND w.mcp_client IS NOT NULL AND w.created_at > now() - interval '1 day') >= 100 THEN
    RAISE EXCEPTION 'At most 100 pipelines a day through MCP' USING ERRCODE = 'P0001', HINT = 'too_many';
  END IF;
  INSERT INTO public.workflows AS w (user_id, workspace_id, name, description, graph, mcp_client, mcp_edited_at, mcp_token_id, updated_at)
  VALUES (auth.uid(), p_workspace_id, v_name, NULLIF(left(btrim(COALESCE(p_description, '')), 2000), ''), p_graph,
          left(client, 100), now(), p_token_id, date_trunc('milliseconds', clock_timestamp()))
  RETURNING w.id, w.updated_at INTO new_id, new_at;
  -- A connection limited to some pipelines keeps the ones it makes.
  IF s IS NOT NULL AND jsonb_typeof(s->'pipelines') = 'array' THEN
    UPDATE public.ps_oauth_grants g SET mcp_scope = jsonb_set(g.mcp_scope, '{pipelines}', (g.mcp_scope->'pipelines') || to_jsonb(new_id::text))
     WHERE g.id = (SELECT t.grant_id FROM public.ps_mcp_tokens t WHERE t.id = p_token_id);
    UPDATE public.ps_mcp_tokens t SET mcp_scope = jsonb_set(t.mcp_scope, '{pipelines}', (t.mcp_scope->'pipelines') || to_jsonb(new_id::text))
     WHERE t.id = p_token_id AND t.grant_id IS NULL;
  END IF;
  RETURN QUERY SELECT new_id, new_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_mcp_pipeline_update(
  p_token_id UUID, p_pipeline_id UUID, p_expected_updated_at TIMESTAMPTZ,
  p_graph JSONB, p_name TEXT DEFAULT NULL, p_description TEXT DEFAULT NULL
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w public.workflows%ROWTYPE;
  client TEXT;
  v_name TEXT := left(btrim(COALESCE(p_name, '')), 120);
  saved TIMESTAMPTZ;
  s JSONB;
BEGIN
  SELECT * INTO w FROM public.workflows x WHERE x.id = p_pipeline_id FOR UPDATE;
  IF w.id IS NULL OR w.workspace_id IS NULL OR NOT public.ps_can_access_pipeline(w.id, 'view') THEN
    RAISE EXCEPTION 'Pipeline not found' USING ERRCODE = 'P0002';
  END IF;
  client := public.ps_mcp__writer(p_token_id, w.workspace_id);
  IF auth.uid() IS NULL OR client IS NULL THEN
    RAISE EXCEPTION 'This connection may not write' USING ERRCODE = '42501', HINT = 'read_only';
  END IF;
  s := public.ps_mcp__check_scope(p_token_id, 'update_pipeline', p_graph);
  IF NOT public.ps_mcp__allows(s, 'pipelines', w.id::text) THEN
    RAISE EXCEPTION 'Pipeline not found' USING ERRCODE = 'P0002';
  END IF;
  IF w.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only pipelines you made can be changed; create a new one instead' USING ERRCODE = 'P0001', HINT = 'not_owner';
  END IF;
  IF NOT public.erp_has_permission(w.workspace_id, 'pipelines.edit') OR NOT public.erp_workspace_mfa_ok(w.workspace_id) THEN
    RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
  END IF;
  IF p_expected_updated_at IS NULL OR w.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'The draft changed since it was read' USING ERRCODE = 'P0001', HINT = 'conflict';
  END IF;
  PERFORM public.ps_mcp__check_graph(p_graph);
  -- Code steps the person wrote stay as they are; the assistant cannot add or change one.
  PERFORM public.ps_mcp__no_code(w.graph, p_graph);
  UPDATE public.workflows x
     SET graph = p_graph,
         name = CASE WHEN v_name = '' THEN x.name ELSE v_name END,
         description = CASE WHEN p_description IS NULL THEN x.description
                            ELSE NULLIF(left(btrim(p_description), 2000), '') END,
         updated_at = date_trunc('milliseconds', clock_timestamp()),
         mcp_client = left(client, 100), mcp_edited_at = now(), mcp_token_id = p_token_id
   WHERE x.id = w.id
  RETURNING x.updated_at INTO saved;
  RETURN saved;
END;
$$;

-- ─── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.ps_set_pipeline_code(UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_pipeline_code_enabled(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps__graph_code(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps__code_changed(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_workflow_code_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_mcp__no_code(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ps_set_pipeline_code(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_pipeline_code_enabled(UUID) TO authenticated;
