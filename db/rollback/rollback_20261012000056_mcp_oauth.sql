-- Rollback for 20261012000056_mcp_oauth.sql.
-- Run only after redeploying an app version from before this change.
-- Connected apps (OAuth) are removed and their access ends at once; personal
-- access tokens keep working.

BEGIN;

DELETE FROM public.ps_mcp_tokens WHERE grant_id IS NOT NULL;

-- As in 20261012000055.
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
  -- Where the role needs two-factor, so does the token's session.
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
       WHERE t.user_id = auth.uid() AND t.workspace_id = p_workspace_id
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
   WHERE t.workspace_id = p_workspace_id AND (t.user_id = auth.uid() OR all_tokens)
   ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC
   LIMIT 200;
END;
$$;

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
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.user_id AND COALESCE(u.banned_until <= now(), true)) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.erp_workspaces w WHERE w.id = t.workspace_id AND w.owner_id = t.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.erp_workspace_members m WHERE m.workspace_id = t.workspace_id AND m.user_id = t.user_id AND m.status = 'active') THEN
    RETURN;
  END IF;
  UPDATE public.ps_mcp_tokens SET last_used_at = now(), use_count = use_count + 1 WHERE id = t.id;
  RETURN QUERY SELECT t.id, t.user_id, (SELECT u.email::TEXT FROM auth.users u WHERE u.id = t.user_id), t.workspace_id, t.aal;
END;
$$;

DROP FUNCTION IF EXISTS auth.oauth_refresh(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS auth.oauth_exchange_code(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS auth.oauth__issue(public.ps_oauth_grants, TEXT, TEXT);
DROP FUNCTION IF EXISTS auth.oauth__client_ok(TEXT, TEXT);
DROP FUNCTION IF EXISTS auth.oauth_register(TEXT, TEXT, TEXT[], TEXT);
DROP FUNCTION IF EXISTS public.ps_oauth_grant_revoke(UUID);
DROP FUNCTION IF EXISTS public.ps_oauth_grant_list(UUID);
DROP FUNCTION IF EXISTS public.ps_oauth_approve(TEXT, TEXT, TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.ps_oauth_client_get(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.ps_oauth__member(UUID, UUID);

DROP INDEX IF EXISTS public.ps_mcp_tokens_grant;
ALTER TABLE public.ps_mcp_tokens DROP COLUMN IF EXISTS grant_id;
DROP TABLE IF EXISTS public.ps_oauth_codes;
DROP TABLE IF EXISTS public.ps_oauth_grants;
DROP TABLE IF EXISTS public.ps_oauth_clients;

COMMIT;
