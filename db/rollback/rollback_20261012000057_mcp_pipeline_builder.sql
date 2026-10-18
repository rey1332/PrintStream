-- Rollback for 20261012000057_mcp_pipeline_builder.sql.
-- Run only after redeploying an app version from before this change.
-- Pipelines built through MCP stay (as ordinary pipelines of the member who
-- made them); every MCP connection becomes read-only again.

BEGIN;

DROP FUNCTION IF EXISTS public.ps_mcp_pipeline_create(UUID, UUID, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.ps_mcp_pipeline_update(UUID, UUID, TIMESTAMPTZ, JSONB, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.ps_mcp__writer(UUID, UUID);
DROP FUNCTION IF EXISTS public.ps_mcp__check_graph(JSONB);
DROP FUNCTION IF EXISTS public.ps_mcp_token_create_v2(UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN);
DROP FUNCTION IF EXISTS public.ps_mcp_token_list_v2(UUID);
DROP FUNCTION IF EXISTS public.ps_oauth_approve_v2(TEXT, TEXT, TEXT, UUID, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.ps_oauth_grant_list_v2(UUID);
DROP FUNCTION IF EXISTS auth.mcp_token_use_v2(TEXT);

-- As in 20261012000056.

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

DROP INDEX IF EXISTS public.workflows_mcp_created;
ALTER TABLE public.workflows DROP COLUMN IF EXISTS mcp_token_id;
ALTER TABLE public.workflows DROP COLUMN IF EXISTS mcp_edited_at;
ALTER TABLE public.workflows DROP COLUMN IF EXISTS mcp_client;
ALTER TABLE public.ps_oauth_grants DROP COLUMN IF EXISTS can_write;
ALTER TABLE public.ps_oauth_codes DROP COLUMN IF EXISTS can_write;
ALTER TABLE public.ps_mcp_tokens DROP COLUMN IF EXISTS can_write;

COMMIT;
