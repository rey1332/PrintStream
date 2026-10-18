-- MCP: building pipelines (docs/TERMINAL.md, "Building pipelines with an AI
-- assistant"). An MCP connection can be allowed to write: it then creates
-- pipelines and changes their drafts, as the member it belongs to, never
-- more than the member may do. It cannot publish: background runs,
-- schedules and chains only use published versions, so nothing an assistant
-- writes runs on its own until a person has reviewed it in the editor and
-- published it.
--
-- * ps_mcp_tokens, ps_oauth_codes, ps_oauth_grants gain can_write (off by
--   default): chosen when a token is made or a connection approved; it
--   cannot be switched on later (make a new token or connect again).
-- * workflows gain mcp_client / mcp_edited_at / mcp_token_id: which
--   connection last wrote the draft and when (the editor and the list show it).
-- * ps_mcp_token_create_v2, ps_oauth_approve_v2 (can_write), the lists
--   ps_mcp_token_list_v2, ps_oauth_grant_list_v2 and auth.mcp_token_use_v2
--   (with can_write).
-- * ps_mcp_pipeline_create / ps_mcp_pipeline_update: the only writes, each
--   checked against the token (the caller's, not revoked, allowed to write)
--   and the member's rights (pipelines.create, pipelines.edit; only pipelines
--   the member made, as in the editor; the draft must be the one read).
--
-- Rollback: db/rollback/rollback_20261012000057_mcp_pipeline_builder.sql

ALTER TABLE public.ps_mcp_tokens ADD COLUMN IF NOT EXISTS can_write BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.ps_oauth_codes ADD COLUMN IF NOT EXISTS can_write BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.ps_oauth_grants ADD COLUMN IF NOT EXISTS can_write BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS mcp_client TEXT CHECK (mcp_client IS NULL OR char_length(mcp_client) <= 100);
ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS mcp_edited_at TIMESTAMPTZ;
ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS mcp_token_id UUID REFERENCES public.ps_mcp_tokens(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS workflows_mcp_created ON public.workflows (user_id, created_at) WHERE mcp_client IS NOT NULL;

-- ─── Whether the caller's token may write ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ps_mcp__writer(p_token_id UUID, p_workspace_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.name FROM public.ps_mcp_tokens t
    LEFT JOIN public.ps_oauth_grants g ON g.id = t.grant_id
   WHERE t.id = p_token_id AND t.user_id = auth.uid() AND t.workspace_id = p_workspace_id
     AND t.can_write AND t.revoked_at IS NULL AND t.expires_at > now()
     AND (t.grant_id IS NULL OR (g.revoked_at IS NULL AND g.can_write))
     AND NOT t.workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]);
$$;

CREATE OR REPLACE FUNCTION public.ps_mcp__check_graph(p_graph JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_graph IS NULL OR jsonb_typeof(p_graph->'nodes') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_graph->'edges') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_graph->'nodes') > 100 OR jsonb_array_length(p_graph->'edges') > 300
     OR octet_length(p_graph::text) > 1000000 THEN
    RAISE EXCEPTION 'Invalid pipeline graph' USING ERRCODE = '22023', HINT = 'graph';
  END IF;
END;
$$;

-- ─── The writes ──────────────────────────────────────────────────────────────

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

-- The draft only (published versions stay as they are). p_expected_updated_at:
-- the draft's updated_at as read; a newer save (the editor, another
-- assistant) is not overwritten.
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

-- ─── Tokens and connections that may write ───────────────────────────────────
-- New versions (_v2) next to the earlier ones, which stay as they were (they
-- make and list read-only tokens and connections) so that earlier migrations
-- can be applied again.

CREATE OR REPLACE FUNCTION public.ps_mcp_token_create_v2(
  p_workspace_id UUID, p_name TEXT, p_token_hash TEXT, p_token_prefix TEXT, p_days INTEGER DEFAULT 90,
  p_can_write BOOLEAN DEFAULT false
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := left(btrim(COALESCE(p_name, '')), 80);
  v_days INTEGER := COALESCE(p_days, 90);
  new_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF public.erp_workspace_role(p_workspace_id) IS NULL OR NOT public.erp_has_permission(p_workspace_id, 'pipelines.view') THEN
    RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_can_write, false) AND NOT (public.erp_has_permission(p_workspace_id, 'pipelines.create')
                                           OR public.erp_has_permission(p_workspace_id, 'pipelines.edit')) THEN
    RAISE EXCEPTION 'You are not allowed to build pipelines here' USING ERRCODE = '42501', HINT = 'no_write';
  END IF;
  IF NOT public.erp_workspace_mfa_ok(p_workspace_id) THEN
    RAISE EXCEPTION 'Two-factor authentication is required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'Name the token' USING ERRCODE = 'P0001', HINT = 'name'; END IF;
  IF v_days < 1 OR v_days > 365 THEN
    RAISE EXCEPTION 'A token lasts 1 to 365 days' USING ERRCODE = 'P0001', HINT = 'days';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_token_prefix IS NULL
     OR char_length(p_token_prefix) NOT BETWEEN 8 AND 16 THEN
    RAISE EXCEPTION 'Invalid token' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.ps_mcp_tokens t
       WHERE t.user_id = auth.uid() AND t.workspace_id = p_workspace_id AND t.grant_id IS NULL
         AND t.revoked_at IS NULL AND t.expires_at > now()) >= 10 THEN
    RAISE EXCEPTION 'At most 10 tokens per Terminal; revoke one first' USING ERRCODE = 'P0001', HINT = 'too_many_tokens';
  END IF;
  INSERT INTO public.ps_mcp_tokens (user_id, workspace_id, name, token_hash, token_prefix, aal, expires_at, can_write)
  VALUES (auth.uid(), p_workspace_id, v_name, p_token_hash, p_token_prefix, public.erp_session_aal(),
          now() + make_interval(days => v_days), COALESCE(p_can_write, false))
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_mcp_token_list_v2(p_workspace_id UUID)
RETURNS TABLE (id UUID, name TEXT, token_prefix TEXT, mine BOOLEAN, owner_email TEXT, aal TEXT,
               created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, use_count BIGINT,
               revoked_at TIMESTAMPTZ, can_write BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE all_tokens BOOLEAN;
BEGIN
  IF public.erp_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = '42501';
  END IF;
  all_tokens := public.erp_has_permission(p_workspace_id, 'members');
  RETURN QUERY
  SELECT t.id, t.name, t.token_prefix, t.user_id = auth.uid(), p.email, t.aal,
         t.created_at, t.expires_at, t.last_used_at, t.use_count, t.revoked_at, t.can_write
    FROM public.ps_mcp_tokens t
    LEFT JOIN public.user_profiles p ON p.id = t.user_id
   WHERE t.workspace_id = p_workspace_id AND t.grant_id IS NULL AND (t.user_id = auth.uid() OR all_tokens)
   ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC
   LIMIT 200;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_oauth_approve_v2(
  p_client_id TEXT, p_redirect_uri TEXT, p_code_challenge TEXT, p_workspace_id UUID, p_code_hash TEXT,
  p_can_write BOOLEAN DEFAULT false
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ps_oauth_clients c WHERE c.client_id = p_client_id AND p_redirect_uri = ANY (c.redirect_uris)) THEN
    RAISE EXCEPTION 'Unknown client or redirect address' USING ERRCODE = 'P0001', HINT = 'invalid_client';
  END IF;
  IF public.erp_workspace_role(p_workspace_id) IS NULL OR NOT public.erp_has_permission(p_workspace_id, 'pipelines.view') THEN
    RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_can_write, false) AND NOT (public.erp_has_permission(p_workspace_id, 'pipelines.create')
                                           OR public.erp_has_permission(p_workspace_id, 'pipelines.edit')) THEN
    RAISE EXCEPTION 'You are not allowed to build pipelines here' USING ERRCODE = '42501', HINT = 'no_write';
  END IF;
  IF NOT public.erp_workspace_mfa_ok(p_workspace_id) THEN
    RAISE EXCEPTION 'Two-factor authentication is required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  IF p_code_challenge IS NULL OR p_code_challenge !~ '^[A-Za-z0-9_-]{43}$' OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.ps_oauth_codes WHERE expires_at < now() - interval '1 day';
  INSERT INTO public.ps_oauth_codes (code_hash, client_id, user_id, workspace_id, redirect_uri, code_challenge, aal, expires_at, can_write)
  VALUES (p_code_hash, p_client_id, auth.uid(), p_workspace_id, p_redirect_uri, p_code_challenge,
          public.erp_session_aal(), now() + interval '10 minutes', COALESCE(p_can_write, false));
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_oauth_grant_list_v2(p_workspace_id UUID)
RETURNS TABLE (id UUID, client_name TEXT, redirect_host TEXT, mine BOOLEAN, owner_email TEXT,
               created_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, uses BIGINT, refresh_expires_at TIMESTAMPTZ,
               revoked_at TIMESTAMPTZ, can_write BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE all_grants BOOLEAN;
BEGIN
  IF public.erp_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = '42501';
  END IF;
  all_grants := public.erp_has_permission(p_workspace_id, 'members');
  RETURN QUERY
  SELECT g.id, c.name, substring(c.redirect_uris[1] FROM '^[a-z][a-z0-9+.-]*://([^/?#]+)'), g.user_id = auth.uid(), p.email,
         g.created_at,
         (SELECT max(t.last_used_at) FROM public.ps_mcp_tokens t WHERE t.grant_id = g.id),
         (SELECT COALESCE(sum(t.use_count), 0)::BIGINT FROM public.ps_mcp_tokens t WHERE t.grant_id = g.id),
         g.refresh_expires_at, g.revoked_at, g.can_write
    FROM public.ps_oauth_grants g
    JOIN public.ps_oauth_clients c ON c.client_id = g.client_id
    LEFT JOIN public.user_profiles p ON p.id = g.user_id
   WHERE g.workspace_id = p_workspace_id AND (g.user_id = auth.uid() OR all_grants)
   ORDER BY g.revoked_at IS NOT NULL, g.created_at DESC
   LIMIT 200;
END;
$$;

-- As in 20261012000056; the access token carries the grant's can_write.
CREATE OR REPLACE FUNCTION auth.oauth__issue(g public.ps_oauth_grants, p_access_hash TEXT, p_access_prefix TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.ps_mcp_tokens t WHERE t.grant_id = g.id AND t.expires_at < now();
  INSERT INTO public.ps_mcp_tokens (user_id, workspace_id, name, token_hash, token_prefix, aal, expires_at, grant_id, can_write)
  VALUES (g.user_id, g.workspace_id, (SELECT left(c.name, 80) FROM public.ps_oauth_clients c WHERE c.client_id = g.client_id),
          p_access_hash, p_access_prefix, g.aal, now() + interval '1 hour', g.id, g.can_write);
  UPDATE public.ps_oauth_clients SET last_used_at = now() WHERE client_id = g.client_id;
END;
$$;

-- As in 20261012000056; the grant carries the code's can_write.
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

-- As auth.mcp_token_use (20261012000056), and whether the token may write.
CREATE OR REPLACE FUNCTION auth.mcp_token_use_v2(p_token_hash TEXT)
RETURNS TABLE (token_id UUID, user_id UUID, email TEXT, workspace_id UUID, aal TEXT, can_write BOOLEAN, client_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE t public.ps_mcp_tokens%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.ps_mcp_tokens x
   WHERE x.token_hash = p_token_hash AND x.revoked_at IS NULL AND x.expires_at > now();
  IF t.id IS NULL THEN RETURN; END IF;
  IF t.grant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ps_oauth_grants g WHERE g.id = t.grant_id AND g.revoked_at IS NULL
  ) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.user_id AND COALESCE(u.banned_until <= now(), true)) THEN
    RETURN;
  END IF;
  IF NOT public.ps_oauth__member(t.workspace_id, t.user_id) THEN RETURN; END IF;
  UPDATE public.ps_mcp_tokens SET last_used_at = now(), use_count = use_count + 1 WHERE id = t.id;
  RETURN QUERY SELECT t.id, t.user_id, (SELECT u.email::TEXT FROM auth.users u WHERE u.id = t.user_id), t.workspace_id, t.aal,
                      t.can_write, t.name;
END;
$$;

-- ─── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.ps_mcp__writer(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_mcp__check_graph(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_mcp_pipeline_create(UUID, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_mcp_pipeline_update(UUID, UUID, TIMESTAMPTZ, JSONB, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_mcp_token_create_v2(UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_mcp_token_list_v2(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_oauth_approve_v2(TEXT, TEXT, TEXT, UUID, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_oauth_grant_list_v2(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_mcp_pipeline_create(UUID, UUID, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_mcp_pipeline_update(UUID, UUID, TIMESTAMPTZ, JSONB, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_mcp_token_create_v2(UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_mcp_token_list_v2(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_oauth_approve_v2(TEXT, TEXT, TEXT, UUID, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_oauth_grant_list_v2(UUID) TO authenticated;

REVOKE ALL ON FUNCTION auth.oauth__issue(public.ps_oauth_grants, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION auth.oauth_exchange_code(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION auth.mcp_token_use_v2(TEXT) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') THEN
    GRANT EXECUTE ON FUNCTION auth.mcp_token_use_v2(TEXT) TO etna_auth;
  END IF;
END;
$$;
