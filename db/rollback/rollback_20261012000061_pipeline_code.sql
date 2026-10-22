-- Rollback for 20261012000061_pipeline_code.sql.
-- Run only after redeploying an app version from before this change. Code
-- steps already saved stay in the graphs but no longer run (the app version
-- before this one does not know them); the permission leaves custom roles.

BEGIN;

DROP TRIGGER IF EXISTS trg_workflow_code_guard ON public.workflows;
DROP FUNCTION IF EXISTS public.ps_workflow_code_guard();
DROP FUNCTION IF EXISTS public.ps_set_pipeline_code(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.ps_pipeline_code_enabled(UUID);

-- The permission leaves custom roles first (their check uses the list below).
UPDATE public.erp_custom_roles SET permissions = array_remove(permissions, 'pipelines.code')
 WHERE 'pipelines.code' = ANY (permissions);

-- As in 20261012000030 and 20261012000060.

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
    'pipelines.publish','pipelines.disable','pipelines.delete',
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
               'integrations.manage','datasets.export','data.sensitive','approvals.decide']::TEXT[];
$$;

CREATE OR REPLACE FUNCTION public.erp_role_permissions(p_role TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_role
    -- Literal lists (tests/unit/erpRules.test.mjs compares them with the app).
    WHEN 'owner' THEN ARRAY['read','customers','suppliers','products','inventory','sales','invoicing','fulfillment','purchasing','receiving','payments','members','audit',
                            'roles.manage','policies.manage','storage.view','integrations.manage','integrations.use','datasets.view','datasets.query','datasets.import','datasets.edit','datasets.schema','datasets.export','datasets.share','datasets.delete','data.sensitive','pipelines.view','pipelines.create','pipelines.edit','pipelines.run','pipelines.schedule','pipelines.publish','pipelines.disable','pipelines.delete','approvals.decide']
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
    -- Outside the connection's pipelines: as if it did not exist.
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

DROP FUNCTION IF EXISTS public.ps_mcp__no_code(JSONB, JSONB);
DROP FUNCTION IF EXISTS public.ps__code_changed(JSONB, JSONB);
DROP FUNCTION IF EXISTS public.ps__graph_code(JSONB);

ALTER TABLE public.erp_workspaces DROP COLUMN IF EXISTS pipeline_code_enabled;

COMMIT;
