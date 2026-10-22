-- Rollback for 20261012000060_mcp_scopes.sql.
-- Run only after redeploying an app version from before this change. Every
-- MCP token and connected app may use all its tools and data again.

BEGIN;

DROP FUNCTION IF EXISTS auth.mcp_token_use_v3(TEXT);
DROP FUNCTION IF EXISTS public.ps_oauth_grant_set_scope(UUID, JSONB);
DROP FUNCTION IF EXISTS public.ps_oauth_grant_list_v3(UUID);
DROP FUNCTION IF EXISTS public.ps_oauth_approve_v3(TEXT, TEXT, TEXT, UUID, TEXT, BOOLEAN, JSONB);
DROP FUNCTION IF EXISTS public.ps_mcp_token_set_scope(UUID, JSONB);
DROP FUNCTION IF EXISTS public.ps_mcp_token_list_v3(UUID);
DROP FUNCTION IF EXISTS public.ps_mcp_token_create_v3(UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, JSONB);

-- As in 20261012000057.

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
BEGIN
  IF auth.uid() IS NULL OR client IS NULL THEN
    RAISE EXCEPTION 'This connection may not write' USING ERRCODE = '42501', HINT = 'read_only';
  END IF;
  IF NOT public.erp_has_permission(p_workspace_id, 'pipelines.create') OR NOT public.erp_workspace_mfa_ok(p_workspace_id) THEN
    RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
  END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'Name the pipeline' USING ERRCODE = 'P0001', HINT = 'name'; END IF;
  PERFORM public.ps_mcp__check_graph(p_graph);
  IF (SELECT count(*) FROM public.workflows w
       WHERE w.user_id = auth.uid() AND w.mcp_client IS NOT NULL AND w.created_at > now() - interval '1 day') >= 100 THEN
    RAISE EXCEPTION 'At most 100 pipelines a day through MCP' USING ERRCODE = 'P0001', HINT = 'too_many';
  END IF;
  RETURN QUERY
  INSERT INTO public.workflows AS w (user_id, workspace_id, name, description, graph, mcp_client, mcp_edited_at, mcp_token_id, updated_at)
  VALUES (auth.uid(), p_workspace_id, v_name, NULLIF(left(btrim(COALESCE(p_description, '')), 2000), ''), p_graph,
          left(client, 100), now(), p_token_id, date_trunc('milliseconds', clock_timestamp()))
  RETURNING w.id, w.updated_at;
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
BEGIN
  SELECT * INTO w FROM public.workflows x WHERE x.id = p_pipeline_id FOR UPDATE;
  IF w.id IS NULL OR w.workspace_id IS NULL OR NOT public.ps_can_access_pipeline(w.id, 'view') THEN
    RAISE EXCEPTION 'Pipeline not found' USING ERRCODE = 'P0002';
  END IF;
  client := public.ps_mcp__writer(p_token_id, w.workspace_id);
  IF auth.uid() IS NULL OR client IS NULL THEN
    RAISE EXCEPTION 'This connection may not write' USING ERRCODE = '42501', HINT = 'read_only';
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
  INSERT INTO public.ps_oauth_grants (client_id, user_id, workspace_id, aal, refresh_hash, refresh_expires_at, can_write)
  VALUES (c.client_id, c.user_id, c.workspace_id, c.aal, p_refresh_hash, now() + interval '30 days', c.can_write)
  RETURNING * INTO g;
  UPDATE public.ps_oauth_codes SET used_at = now(), grant_id = g.id WHERE code_hash = c.code_hash;
  PERFORM auth.oauth__issue(g, p_access_hash, p_access_prefix);
  RETURN NULL;
END;
$$;

DROP FUNCTION IF EXISTS public.ps_mcp__check_scope(UUID, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.ps_mcp__graph_datasets(JSONB);
DROP FUNCTION IF EXISTS public.ps_mcp__allows(JSONB, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.ps_mcp__scope(UUID);
DROP FUNCTION IF EXISTS public.ps_mcp__scope_clean(UUID, JSONB, BOOLEAN);
DROP FUNCTION IF EXISTS public.ps_mcp__write_tools();
DROP FUNCTION IF EXISTS public.ps_mcp__tools();

ALTER TABLE public.ps_oauth_grants DROP COLUMN IF EXISTS mcp_scope;
ALTER TABLE public.ps_oauth_codes DROP COLUMN IF EXISTS mcp_scope;
ALTER TABLE public.ps_mcp_tokens DROP COLUMN IF EXISTS mcp_scope;

COMMIT;
