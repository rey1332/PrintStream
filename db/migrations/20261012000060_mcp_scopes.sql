-- MCP: which tools and which data a connection may use (docs/teknis/TERMINAL.md,
-- "MCP access"). A member chooses, for each access token and each connected
-- app, the tools it may call and, optionally, the only datasets and pipelines
-- it may see; they change it later under Terminal → AI → MCP access.
--
-- * ps_mcp_tokens, ps_oauth_codes, ps_oauth_grants gain mcp_scope (JSONB; the grants' scope column is OAuth's own):
--     {"tools": [names] | null, "datasets": [ids] | null, "pipelines": [ids] | null}
--   null (the column or a key) means "all": tokens and connections made
--   before keep working as they did. An app's access tokens follow its
--   grant's scope at every call, so a change applies at once.
-- * The server offers and runs only the chosen tools and filters every list
--   and argument; the database checks the writes again (create/update a
--   pipeline: the tool, the pipeline and every dataset in the graph). A
--   pipeline an assistant creates joins the connection's pipeline list, so
--   it can still change it.
-- * New: ps_mcp_token_create_v3, ps_mcp_token_list_v3, ps_mcp_token_set_scope,
--   ps_oauth_approve_v3, ps_oauth_grant_list_v3, ps_oauth_grant_set_scope,
--   auth.mcp_token_use_v3. ps_mcp_pipeline_create / ps_mcp_pipeline_update
--   and auth.oauth_exchange_code keep their signatures and gain the checks.
--
-- Rollback: db/rollback/rollback_20261012000060_mcp_scopes.sql

ALTER TABLE public.ps_mcp_tokens ADD COLUMN IF NOT EXISTS mcp_scope JSONB;
ALTER TABLE public.ps_oauth_codes ADD COLUMN IF NOT EXISTS mcp_scope JSONB;
ALTER TABLE public.ps_oauth_grants ADD COLUMN IF NOT EXISTS mcp_scope JSONB;

-- ─── Scope helpers ───────────────────────────────────────────────────────────

-- Every tool of src/server/mcp/tools.ts (tests/db/mcpScopes.test.mjs keeps them equal).
CREATE OR REPLACE FUNCTION public.ps_mcp__tools()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY['list_pipelines', 'get_pipeline', 'list_pipeline_runs', 'get_pipeline_run',
               'list_datasets', 'preview_dataset', 'list_node_types', 'list_erp_fields',
               'validate_pipeline', 'test_pipeline', 'create_pipeline', 'update_pipeline',
               'profile_dataset', 'analyze_dataset', 'get_terminal_health'];
$$;

CREATE OR REPLACE FUNCTION public.ps_mcp__write_tools()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$ SELECT ARRAY['create_pipeline', 'update_pipeline']; $$;

-- A scope as given, checked and normalised (sorted, without duplicates);
-- NULL stays NULL ("everything"). Datasets and pipelines must be the
-- Terminal's; the writing tools need a connection that may write.
CREATE OR REPLACE FUNCTION public.ps_mcp__scope_clean(p_workspace_id UUID, p_scope JSONB, p_can_write BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tools TEXT[];
  v_datasets UUID[];
  v_pipelines UUID[];
  k TEXT;
BEGIN
  IF p_scope IS NULL OR jsonb_typeof(p_scope) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_scope) <> 'object' THEN
    RAISE EXCEPTION 'Invalid access scope' USING ERRCODE = '22023', HINT = 'scope';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_scope) LOOP
    IF k NOT IN ('tools', 'datasets', 'pipelines') THEN
      RAISE EXCEPTION 'Invalid access scope' USING ERRCODE = '22023', HINT = 'scope';
    END IF;
    IF jsonb_typeof(p_scope->k) NOT IN ('array', 'null') THEN
      RAISE EXCEPTION 'Invalid access scope' USING ERRCODE = '22023', HINT = 'scope';
    END IF;
  END LOOP;
  BEGIN
    IF jsonb_typeof(p_scope->'tools') = 'array' THEN
      SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_tools FROM jsonb_array_elements_text(p_scope->'tools') x;
    END IF;
    IF jsonb_typeof(p_scope->'datasets') = 'array' THEN
      SELECT COALESCE(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_datasets FROM jsonb_array_elements_text(p_scope->'datasets') x;
    END IF;
    IF jsonb_typeof(p_scope->'pipelines') = 'array' THEN
      SELECT COALESCE(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_pipelines FROM jsonb_array_elements_text(p_scope->'pipelines') x;
    END IF;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Invalid access scope' USING ERRCODE = '22023', HINT = 'scope';
  END;
  IF v_tools IS NOT NULL THEN
    IF cardinality(v_tools) = 0 THEN
      RAISE EXCEPTION 'Choose at least one tool' USING ERRCODE = 'P0001', HINT = 'no_tools';
    END IF;
    IF NOT v_tools <@ public.ps_mcp__tools() THEN
      RAISE EXCEPTION 'Unknown tool' USING ERRCODE = '22023', HINT = 'scope';
    END IF;
    IF NOT COALESCE(p_can_write, false) AND v_tools && public.ps_mcp__write_tools() THEN
      RAISE EXCEPTION 'This connection may not build pipelines' USING ERRCODE = 'P0001', HINT = 'no_write';
    END IF;
  END IF;
  IF COALESCE(cardinality(v_datasets), 0) > 200 OR COALESCE(cardinality(v_pipelines), 0) > 200 THEN
    RAISE EXCEPTION 'At most 200 datasets and 200 pipelines' USING ERRCODE = 'P0001', HINT = 'too_many';
  END IF;
  IF v_datasets IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(v_datasets) d
     WHERE NOT EXISTS (SELECT 1 FROM public.ps_datasets x WHERE x.id = d AND x.workspace_id = p_workspace_id)
  ) THEN
    RAISE EXCEPTION 'A dataset is not in this Terminal' USING ERRCODE = 'P0001', HINT = 'scope_dataset';
  END IF;
  IF v_pipelines IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(v_pipelines) p
     WHERE NOT EXISTS (SELECT 1 FROM public.workflows x WHERE x.id = p AND x.workspace_id = p_workspace_id)
  ) THEN
    RAISE EXCEPTION 'A pipeline is not in this Terminal' USING ERRCODE = 'P0001', HINT = 'scope_pipeline';
  END IF;
  RETURN jsonb_build_object('tools', to_jsonb(v_tools), 'datasets', to_jsonb(v_datasets), 'pipelines', to_jsonb(v_pipelines));
END;
$$;

-- The scope a token works under: its app's (grant) or its own.
CREATE OR REPLACE FUNCTION public.ps_mcp__scope(p_token_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN t.grant_id IS NULL THEN t.mcp_scope ELSE g.mcp_scope END
    FROM public.ps_mcp_tokens t
    LEFT JOIN public.ps_oauth_grants g ON g.id = t.grant_id
   WHERE t.id = p_token_id;
$$;

-- Whether a scope lets an item through: a missing list allows everything.
CREATE OR REPLACE FUNCTION public.ps_mcp__allows(p_scope JSONB, p_key TEXT, p_item TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_scope IS NULL OR jsonb_typeof(p_scope->p_key) IS DISTINCT FROM 'array'
         OR (p_scope->p_key) ? p_item;
$$;

-- The datasets a pipeline graph reads or writes (editor graph: nodes[].data).
CREATE OR REPLACE FUNCTION public.ps_mcp__graph_datasets(p_graph JSONB)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg(DISTINCT n->'data'->'config'->>'datasetId'), '{}')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_graph->'nodes') = 'array' THEN p_graph->'nodes' ELSE '[]'::jsonb END) n
   WHERE n->'data'->>'type' IN ('src.psDataset', 'out.psDataset')
     AND COALESCE(n->'data'->'config'->>'datasetId', '') <> '';
$$;

-- Raises unless the token's scope allows the tool and every dataset of the graph.
CREATE OR REPLACE FUNCTION public.ps_mcp__check_scope(p_token_id UUID, p_tool TEXT, p_graph JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s JSONB := public.ps_mcp__scope(p_token_id);
  d TEXT;
BEGIN
  IF NOT public.ps_mcp__allows(s, 'tools', p_tool) THEN
    RAISE EXCEPTION 'This connection may not use %', p_tool USING ERRCODE = '42501', HINT = 'scope_tool';
  END IF;
  FOREACH d IN ARRAY public.ps_mcp__graph_datasets(p_graph) LOOP
    IF NOT public.ps_mcp__allows(s, 'datasets', d) THEN
      RAISE EXCEPTION 'This connection may not use dataset %', d USING ERRCODE = '42501', HINT = 'scope_dataset';
    END IF;
  END LOOP;
  RETURN s;
END;
$$;

-- ─── The writes, now within the scope ────────────────────────────────────────

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

-- ─── Tokens ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ps_mcp_token_create_v3(
  p_workspace_id UUID, p_name TEXT, p_token_hash TEXT, p_token_prefix TEXT, p_days INTEGER DEFAULT 90,
  p_can_write BOOLEAN DEFAULT false, p_scope JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id UUID := public.ps_mcp_token_create_v2(p_workspace_id, p_name, p_token_hash, p_token_prefix, p_days, p_can_write);
BEGIN
  UPDATE public.ps_mcp_tokens SET mcp_scope = public.ps_mcp__scope_clean(p_workspace_id, p_scope, p_can_write) WHERE id = new_id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_mcp_token_list_v3(p_workspace_id UUID)
RETURNS TABLE (id UUID, name TEXT, token_prefix TEXT, mine BOOLEAN, owner_email TEXT, aal TEXT,
               created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, use_count BIGINT,
               revoked_at TIMESTAMPTZ, can_write BOOLEAN, scope JSONB)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.*, t.mcp_scope FROM public.ps_mcp_token_list_v2(p_workspace_id) l
    JOIN public.ps_mcp_tokens t ON t.id = l.id;
$$;

-- The token's owner changes what it may use (the writing tools only if it may write).
CREATE OR REPLACE FUNCTION public.ps_mcp_token_set_scope(p_token_id UUID, p_scope JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE t public.ps_mcp_tokens%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.ps_mcp_tokens x WHERE x.id = p_token_id FOR UPDATE;
  IF t.id IS NULL OR t.user_id IS DISTINCT FROM auth.uid() OR t.grant_id IS NOT NULL OR t.revoked_at IS NOT NULL
     OR public.erp_workspace_role(t.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Token not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.erp_workspace_mfa_ok(t.workspace_id) THEN
    RAISE EXCEPTION 'Two-factor authentication is required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  UPDATE public.ps_mcp_tokens SET mcp_scope = public.ps_mcp__scope_clean(t.workspace_id, p_scope, t.can_write) WHERE id = t.id;
END;
$$;

-- ─── Connected apps ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ps_oauth_approve_v3(
  p_client_id TEXT, p_redirect_uri TEXT, p_code_challenge TEXT, p_workspace_id UUID, p_code_hash TEXT,
  p_can_write BOOLEAN DEFAULT false, p_scope JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_scope JSONB;
BEGIN
  PERFORM public.ps_oauth_approve_v2(p_client_id, p_redirect_uri, p_code_challenge, p_workspace_id, p_code_hash, p_can_write);
  v_scope := public.ps_mcp__scope_clean(p_workspace_id, p_scope, p_can_write);
  UPDATE public.ps_oauth_codes SET mcp_scope = v_scope WHERE code_hash = p_code_hash;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_oauth_grant_list_v3(p_workspace_id UUID)
RETURNS TABLE (id UUID, client_name TEXT, redirect_host TEXT, mine BOOLEAN, owner_email TEXT,
               created_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, uses BIGINT, refresh_expires_at TIMESTAMPTZ,
               revoked_at TIMESTAMPTZ, can_write BOOLEAN, scope JSONB)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.*, g.mcp_scope FROM public.ps_oauth_grant_list_v2(p_workspace_id) l
    JOIN public.ps_oauth_grants g ON g.id = l.id;
$$;

CREATE OR REPLACE FUNCTION public.ps_oauth_grant_set_scope(p_grant_id UUID, p_scope JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE g public.ps_oauth_grants%ROWTYPE;
BEGIN
  SELECT * INTO g FROM public.ps_oauth_grants x WHERE x.id = p_grant_id FOR UPDATE;
  IF g.id IS NULL OR g.user_id IS DISTINCT FROM auth.uid() OR g.revoked_at IS NOT NULL
     OR public.erp_workspace_role(g.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.erp_workspace_mfa_ok(g.workspace_id) THEN
    RAISE EXCEPTION 'Two-factor authentication is required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  UPDATE public.ps_oauth_grants SET mcp_scope = public.ps_mcp__scope_clean(g.workspace_id, p_scope, g.can_write) WHERE id = g.id;
END;
$$;

-- As in 20261012000057; the grant carries the code's scope too.
CREATE OR REPLACE FUNCTION auth.oauth_exchange_code(
  p_code_hash TEXT, p_client_id TEXT, p_secret_hash TEXT, p_redirect_uri TEXT, p_challenge TEXT,
  p_access_hash TEXT, p_access_prefix TEXT, p_refresh_hash TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c public.ps_oauth_codes%ROWTYPE;
  g public.ps_oauth_grants%ROWTYPE;
BEGIN
  IF NOT auth.oauth__client_ok(p_client_id, p_secret_hash) THEN RETURN 'invalid_client'; END IF;
  SELECT * INTO c FROM public.ps_oauth_codes x WHERE x.code_hash = p_code_hash FOR UPDATE;
  IF c.code_hash IS NULL OR c.client_id <> p_client_id THEN RETURN 'invalid_grant'; END IF;
  IF c.used_at IS NOT NULL THEN
    -- A code used twice: whoever has it, the connection made with it ends.
    UPDATE public.ps_oauth_grants SET revoked_at = now(), revoke_reason = 'code_reused' WHERE id = c.grant_id AND revoked_at IS NULL;
    UPDATE public.ps_mcp_tokens SET revoked_at = now() WHERE grant_id = c.grant_id AND revoked_at IS NULL;
    RETURN 'invalid_grant';
  END IF;
  IF c.expires_at < now() OR c.redirect_uri <> p_redirect_uri OR c.code_challenge <> p_challenge THEN
    RETURN 'invalid_grant';
  END IF;
  IF NOT public.ps_oauth__member(c.workspace_id, c.user_id) THEN RETURN 'invalid_grant'; END IF;
  INSERT INTO public.ps_oauth_grants (client_id, user_id, workspace_id, aal, refresh_hash, refresh_expires_at, can_write, mcp_scope)
  VALUES (c.client_id, c.user_id, c.workspace_id, c.aal, p_refresh_hash, now() + interval '30 days', c.can_write, c.mcp_scope)
  RETURNING * INTO g;
  UPDATE public.ps_oauth_codes SET used_at = now(), grant_id = g.id WHERE code_hash = c.code_hash;
  PERFORM auth.oauth__issue(g, p_access_hash, p_access_prefix);
  RETURN NULL;
END;
$$;

-- As auth.mcp_token_use_v2, with the scope the token works under.
CREATE OR REPLACE FUNCTION auth.mcp_token_use_v3(p_token_hash TEXT)
RETURNS TABLE (token_id UUID, user_id UUID, email TEXT, workspace_id UUID, aal TEXT, can_write BOOLEAN,
               client_name TEXT, scope JSONB)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.*, public.ps_mcp__scope(u.token_id) FROM auth.mcp_token_use_v2(p_token_hash) u;
$$;

-- ─── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.ps_mcp__tools() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_mcp__write_tools() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_mcp__scope_clean(UUID, JSONB, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_mcp__scope(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_mcp__allows(JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_mcp__graph_datasets(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_mcp__check_scope(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_mcp_token_create_v3(UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_mcp_token_list_v3(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_mcp_token_set_scope(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_oauth_approve_v3(TEXT, TEXT, TEXT, UUID, TEXT, BOOLEAN, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_oauth_grant_list_v3(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_oauth_grant_set_scope(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_mcp_token_create_v3(UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_mcp_token_list_v3(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_mcp_token_set_scope(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_oauth_approve_v3(TEXT, TEXT, TEXT, UUID, TEXT, BOOLEAN, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_oauth_grant_list_v3(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_oauth_grant_set_scope(UUID, JSONB) TO authenticated;

REVOKE ALL ON FUNCTION auth.mcp_token_use_v3(TEXT) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') THEN
    GRANT EXECUTE ON FUNCTION auth.mcp_token_use_v3(TEXT) TO etna_auth;
  END IF;
END $$;
