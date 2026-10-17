-- OAuth 2.1 for MCP (docs/TERMINAL.md, "MCP access"): Claude's connectors
-- (claude.ai, Claude Desktop, the apps) and other MCP clients connect to
-- /api/mcp by signing in, instead of pasting an access token.
--
--   1. The client registers itself (dynamic client registration):
--      ps_oauth_clients. Its redirect addresses are checked by the app
--      against an allowlist (Claude's callback, this machine).
--   2. The member signs in to PrintStream and approves access to one
--      Terminal on /oauth/authorize: a code (10 minutes, once) bound to the
--      client, the redirect address and the PKCE challenge (S256).
--   3. The client exchanges the code for an access token (an ordinary
--      ps_mcp_tokens row of one hour, linked to the grant) and a refresh
--      token (30 days, renewed on use, at most a year): ps_oauth_grants.
--      Refresh tokens rotate; using an old one again ends the grant.
--   4. The grant appears in Terminal → AI → MCP access and can be revoked;
--      it also ends when the member leaves the Terminal.
--
-- Only hashes (SHA-256) of codes and tokens are stored. The token endpoints
-- run as the auth server role (etna_auth) through the functions in schema
-- auth; approving runs as the signed-in member.
--
-- Rollback: db/rollback/rollback_20261012000056_mcp_oauth.sql

CREATE TABLE IF NOT EXISTS public.ps_oauth_clients (
  client_id TEXT PRIMARY KEY CHECK (client_id ~ '^mcpc_[A-Za-z0-9_-]{20,64}$'),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  redirect_uris TEXT[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
  -- A confidential client's secret (SHA-256); public clients (PKCE only) have none.
  secret_hash TEXT CHECK (secret_hash IS NULL OR secret_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.ps_oauth_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES public.ps_oauth_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  aal TEXT NOT NULL CHECK (aal IN ('aal1', 'aal2')),
  scope TEXT NOT NULL DEFAULT 'mcp:read' CHECK (scope = 'mcp:read'),
  refresh_hash TEXT NOT NULL UNIQUE CHECK (refresh_hash ~ '^[0-9a-f]{64}$'),
  previous_refresh_hash TEXT CHECK (previous_refresh_hash IS NULL OR previous_refresh_hash ~ '^[0-9a-f]{64}$'),
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  refreshed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('member', 'reused', 'left', 'code_reused'))
);
CREATE INDEX IF NOT EXISTS ps_oauth_grants_member ON public.ps_oauth_grants (workspace_id, user_id);
CREATE INDEX IF NOT EXISTS ps_oauth_grants_previous ON public.ps_oauth_grants (previous_refresh_hash) WHERE previous_refresh_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.ps_oauth_codes (
  code_hash TEXT PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  client_id TEXT NOT NULL REFERENCES public.ps_oauth_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL CHECK (char_length(redirect_uri) <= 500),
  code_challenge TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  aal TEXT NOT NULL CHECK (aal IN ('aal1', 'aal2')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  grant_id UUID REFERENCES public.ps_oauth_grants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ps_oauth_codes_expiry ON public.ps_oauth_codes (expires_at);

ALTER TABLE public.ps_mcp_tokens ADD COLUMN IF NOT EXISTS grant_id UUID REFERENCES public.ps_oauth_grants(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS ps_mcp_tokens_grant ON public.ps_mcp_tokens (grant_id) WHERE grant_id IS NOT NULL;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ps_oauth_clients', 'ps_oauth_grants', 'ps_oauth_codes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['ps_oauth_grants', 'ps_oauth_codes'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.%I', t);
    EXECUTE format('CREATE POLICY erp_workspace_not_suspended ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
                      USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))
                      WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))', t);
  END LOOP;
END;
$$;

-- Whether the member still belongs to the Terminal (owner or active member).
CREATE OR REPLACE FUNCTION public.ps_oauth__member(p_workspace_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.erp_workspaces w WHERE w.id = p_workspace_id AND w.owner_id = p_user_id)
      OR EXISTS (SELECT 1 FROM public.erp_workspace_members m
                  WHERE m.workspace_id = p_workspace_id AND m.user_id = p_user_id AND m.status = 'active');
$$;

-- ─── Signed-in member: the consent page ──────────────────────────────────────

-- The client asking, for the consent page: its name and whether the redirect
-- address is one it registered.
CREATE OR REPLACE FUNCTION public.ps_oauth_client_get(p_client_id TEXT, p_redirect_uri TEXT)
RETURNS TABLE (client_id TEXT, name TEXT, redirect_ok BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.client_id, c.name, p_redirect_uri = ANY (c.redirect_uris)
    FROM public.ps_oauth_clients c
   WHERE c.client_id = p_client_id AND auth.uid() IS NOT NULL;
$$;

-- The member approves: a code for the client (10 minutes, once).
CREATE OR REPLACE FUNCTION public.ps_oauth_approve(
  p_client_id TEXT, p_redirect_uri TEXT, p_code_challenge TEXT, p_workspace_id UUID, p_code_hash TEXT
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
  IF NOT public.erp_workspace_mfa_ok(p_workspace_id) THEN
    RAISE EXCEPTION 'Two-factor authentication is required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  IF p_code_challenge IS NULL OR p_code_challenge !~ '^[A-Za-z0-9_-]{43}$' OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.ps_oauth_codes WHERE expires_at < now() - interval '1 day';
  INSERT INTO public.ps_oauth_codes (code_hash, client_id, user_id, workspace_id, redirect_uri, code_challenge, aal, expires_at)
  VALUES (p_code_hash, p_client_id, auth.uid(), p_workspace_id, p_redirect_uri, p_code_challenge,
          public.erp_session_aal(), now() + interval '10 minutes');
END;
$$;

-- Connected apps of the Terminal: the caller's, or everyone's with 'members'.
CREATE OR REPLACE FUNCTION public.ps_oauth_grant_list(p_workspace_id UUID)
RETURNS TABLE (id UUID, client_name TEXT, redirect_host TEXT, mine BOOLEAN, owner_email TEXT,
               created_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, uses BIGINT, refresh_expires_at TIMESTAMPTZ,
               revoked_at TIMESTAMPTZ)
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
         g.refresh_expires_at, g.revoked_at
    FROM public.ps_oauth_grants g
    JOIN public.ps_oauth_clients c ON c.client_id = g.client_id
    LEFT JOIN public.user_profiles p ON p.id = g.user_id
   WHERE g.workspace_id = p_workspace_id AND (g.user_id = auth.uid() OR all_grants)
   ORDER BY g.revoked_at IS NOT NULL, g.created_at DESC
   LIMIT 200;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_oauth_grant_revoke(p_grant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE g public.ps_oauth_grants%ROWTYPE;
BEGIN
  SELECT * INTO g FROM public.ps_oauth_grants x WHERE x.id = p_grant_id FOR UPDATE;
  IF g.id IS NULL OR public.erp_workspace_role(g.workspace_id) IS NULL
     OR (g.user_id IS DISTINCT FROM auth.uid() AND NOT public.erp_has_permission(g.workspace_id, 'members')) THEN
    RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002';
  END IF;
  IF g.revoked_at IS NULL THEN
    UPDATE public.ps_oauth_grants SET revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'member' WHERE id = g.id;
    UPDATE public.ps_mcp_tokens SET revoked_at = now(), revoked_by = auth.uid() WHERE grant_id = g.id AND revoked_at IS NULL;
  END IF;
END;
$$;

-- Personal tokens only (connected apps are listed above): as in 20261012000055.
CREATE OR REPLACE FUNCTION public.ps_mcp_token_list(p_workspace_id UUID)
RETURNS TABLE (id UUID, name TEXT, token_prefix TEXT, mine BOOLEAN, owner_email TEXT, aal TEXT,
               created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, use_count BIGINT,
               revoked_at TIMESTAMPTZ)
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
         t.created_at, t.expires_at, t.last_used_at, t.use_count, t.revoked_at
    FROM public.ps_mcp_tokens t
    LEFT JOIN public.user_profiles p ON p.id = t.user_id
   WHERE t.workspace_id = p_workspace_id AND t.grant_id IS NULL AND (t.user_id = auth.uid() OR all_tokens)
   ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC
   LIMIT 200;
END;
$$;

-- As in 20261012000055; the limit of 10 counts personal tokens only.
CREATE OR REPLACE FUNCTION public.ps_mcp_token_create(
  p_workspace_id UUID, p_name TEXT, p_token_hash TEXT, p_token_prefix TEXT, p_days INTEGER DEFAULT 90
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
  INSERT INTO public.ps_mcp_tokens (user_id, workspace_id, name, token_hash, token_prefix, aal, expires_at)
  VALUES (auth.uid(), p_workspace_id, v_name, p_token_hash, p_token_prefix, public.erp_session_aal(),
          now() + make_interval(days => v_days))
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

-- ─── Auth server role: registration and the token endpoint ──────────────────

-- p_redirect_uris are checked by the app (allowlist) before this.
CREATE OR REPLACE FUNCTION auth.oauth_register(p_client_id TEXT, p_name TEXT, p_redirect_uris TEXT[], p_secret_hash TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(p_redirect_uris) u WHERE char_length(u) > 500) THEN
    RAISE EXCEPTION 'Redirect address too long' USING ERRCODE = '22023';
  END IF;
  -- Clients nobody has used for 90 days are forgotten.
  DELETE FROM public.ps_oauth_clients c
   WHERE COALESCE(c.last_used_at, c.created_at) < now() - interval '90 days'
     AND NOT EXISTS (SELECT 1 FROM public.ps_oauth_grants g WHERE g.client_id = c.client_id AND g.revoked_at IS NULL);
  INSERT INTO public.ps_oauth_clients (client_id, name, redirect_uris, secret_hash)
  VALUES (p_client_id, left(btrim(p_name), 100), p_redirect_uris, p_secret_hash);
END;
$$;

-- The client's secret, when it has one, must match.
CREATE OR REPLACE FUNCTION auth.oauth__client_ok(p_client_id TEXT, p_secret_hash TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.ps_oauth_clients c
                  WHERE c.client_id = p_client_id
                    AND (c.secret_hash IS NULL OR c.secret_hash = p_secret_hash));
$$;

-- A one-hour access token of a grant (old ones of the grant are removed).
CREATE OR REPLACE FUNCTION auth.oauth__issue(g public.ps_oauth_grants, p_access_hash TEXT, p_access_prefix TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.ps_mcp_tokens t WHERE t.grant_id = g.id AND t.expires_at < now();
  INSERT INTO public.ps_mcp_tokens (user_id, workspace_id, name, token_hash, token_prefix, aal, expires_at, grant_id)
  VALUES (g.user_id, g.workspace_id, (SELECT left(c.name, 80) FROM public.ps_oauth_clients c WHERE c.client_id = g.client_id),
          p_access_hash, p_access_prefix, g.aal, now() + interval '1 hour', g.id);
  UPDATE public.ps_oauth_clients SET last_used_at = now() WHERE client_id = g.client_id;
END;
$$;

-- grant_type=authorization_code. p_challenge is BASE64URL(SHA-256(code_verifier)),
-- computed by the app. → error (null when it worked).
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
  INSERT INTO public.ps_oauth_grants (client_id, user_id, workspace_id, aal, refresh_hash, refresh_expires_at)
  VALUES (c.client_id, c.user_id, c.workspace_id, c.aal, p_refresh_hash, now() + interval '30 days')
  RETURNING * INTO g;
  UPDATE public.ps_oauth_codes SET used_at = now(), grant_id = g.id WHERE code_hash = c.code_hash;
  PERFORM auth.oauth__issue(g, p_access_hash, p_access_prefix);
  RETURN NULL;
END;
$$;

-- grant_type=refresh_token: a new access token and a new refresh token; an
-- old refresh token used again ends the grant (it was copied).
CREATE OR REPLACE FUNCTION auth.oauth_refresh(
  p_refresh_hash TEXT, p_client_id TEXT, p_secret_hash TEXT, p_access_hash TEXT, p_access_prefix TEXT, p_new_refresh_hash TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE g public.ps_oauth_grants%ROWTYPE;
BEGIN
  IF NOT auth.oauth__client_ok(p_client_id, p_secret_hash) THEN RETURN 'invalid_client'; END IF;
  SELECT * INTO g FROM public.ps_oauth_grants x WHERE x.previous_refresh_hash = p_refresh_hash AND x.client_id = p_client_id FOR UPDATE;
  IF g.id IS NOT NULL THEN
    UPDATE public.ps_oauth_grants SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = COALESCE(revoke_reason, 'reused')
     WHERE id = g.id;
    UPDATE public.ps_mcp_tokens SET revoked_at = now() WHERE grant_id = g.id AND revoked_at IS NULL;
    RETURN 'invalid_grant';
  END IF;
  SELECT * INTO g FROM public.ps_oauth_grants x WHERE x.refresh_hash = p_refresh_hash AND x.client_id = p_client_id FOR UPDATE;
  IF g.id IS NULL OR g.revoked_at IS NOT NULL OR g.refresh_expires_at < now() THEN RETURN 'invalid_grant'; END IF;
  IF NOT public.ps_oauth__member(g.workspace_id, g.user_id)
     OR EXISTS (SELECT 1 FROM auth.users u WHERE u.id = g.user_id AND u.banned_until > now()) THEN
    UPDATE public.ps_oauth_grants SET revoked_at = now(), revoke_reason = 'left' WHERE id = g.id;
    UPDATE public.ps_mcp_tokens SET revoked_at = now() WHERE grant_id = g.id AND revoked_at IS NULL;
    RETURN 'invalid_grant';
  END IF;
  UPDATE public.ps_oauth_grants
     SET previous_refresh_hash = refresh_hash, refresh_hash = p_new_refresh_hash, refreshed_at = now(),
         refresh_expires_at = LEAST(now() + interval '30 days', created_at + interval '365 days')
   WHERE id = g.id
  RETURNING * INTO g;
  PERFORM auth.oauth__issue(g, p_access_hash, p_access_prefix);
  RETURN NULL;
END;
$$;

-- As in 20261012000055, and a token of a revoked connection is not valid.
CREATE OR REPLACE FUNCTION auth.mcp_token_use(p_token_hash TEXT)
RETURNS TABLE (token_id UUID, user_id UUID, email TEXT, workspace_id UUID, aal TEXT)
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
  RETURN QUERY SELECT t.id, t.user_id, (SELECT u.email::TEXT FROM auth.users u WHERE u.id = t.user_id), t.workspace_id, t.aal;
END;
$$;

-- ─── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.ps_oauth__member(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_oauth_client_get(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_oauth_approve(TEXT, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_oauth_grant_list(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_oauth_grant_revoke(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_oauth_client_get(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_oauth_approve(TEXT, TEXT, TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_oauth_grant_list(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_oauth_grant_revoke(UUID) TO authenticated;

REVOKE ALL ON FUNCTION auth.oauth_register(TEXT, TEXT, TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION auth.oauth__client_ok(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION auth.oauth__issue(public.ps_oauth_grants, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION auth.oauth_exchange_code(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION auth.oauth_refresh(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION auth.mcp_token_use(TEXT) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') THEN
    GRANT EXECUTE ON FUNCTION auth.oauth_register(TEXT, TEXT, TEXT[], TEXT) TO etna_auth;
    GRANT EXECUTE ON FUNCTION auth.oauth_exchange_code(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO etna_auth;
    GRANT EXECUTE ON FUNCTION auth.oauth_refresh(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO etna_auth;
    GRANT EXECUTE ON FUNCTION auth.mcp_token_use(TEXT) TO etna_auth;
  END IF;
END;
$$;
