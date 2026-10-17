-- Terminal: clearer jobs, an overview of what needs attention, and read-only
-- MCP access to pipelines for AI assistants (docs/TERMINAL.md, "MCP access").
--
-- 1. Jobs: who cancelled a job is kept (cancelled_by, and error_key
--    'cancelled_by_user' when it never started), and a failed or cancelled
--    job can be run again (ps_retry_job): a new job with the same work,
--    started with the rights of the person who retries it (retry_of points
--    at the original).
-- 2. Health: when the background worker last reported (ps_worker_last_seen),
--    so the overview can say that queued jobs are waiting for it.
-- 3. MCP access tokens (ps_mcp_tokens): a member creates a token for one
--    Terminal; an MCP client (Claude, Cursor, …) sends it as a bearer token to
--    /api/mcp and reads that Terminal's pipelines, runs and datasets with the
--    member's own rights (row-level security as in the app; nothing is
--    written). Only a SHA-256 hash of the token is stored. A token lasts at
--    most a year, can be revoked, and keeps the two-factor level of the
--    session it was made in. Only the auth server role (etna_auth) may look a
--    token up.
--
-- Rollback: db/rollback/rollback_20261012000055_terminal_jobs_health_mcp.sql

-- ─── 1. Jobs ─────────────────────────────────────────────────────────────────

ALTER TABLE public.ps_jobs ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE public.ps_jobs ADD COLUMN IF NOT EXISTS retry_of UUID REFERENCES public.ps_jobs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ps_jobs_retry_of ON public.ps_jobs (retry_of) WHERE retry_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS ps_jobs_workspace_recent ON public.ps_jobs (workspace_id, created_at DESC);

-- As in 20261012000035, plus who cancelled it.
CREATE OR REPLACE FUNCTION public.ps_cancel_job(p_job_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j public.ps_jobs;
BEGIN
  SELECT * INTO j FROM public.ps_jobs x WHERE x.id = p_job_id FOR UPDATE;
  IF j.id IS NULL OR public.erp_workspace_role(j.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF j.created_by IS DISTINCT FROM auth.uid() AND NOT public.erp_has_permission(j.workspace_id, 'pipelines.disable') THEN
    RAISE EXCEPTION 'You cannot cancel this job' USING ERRCODE = '42501';
  END IF;
  IF j.status = 'queued' OR j.status = 'awaiting_approval' THEN
    UPDATE public.ps_jobs
       SET status = 'cancelled', finished_at = now(), cancelled_by = auth.uid(),
           error_key = COALESCE(error_key, 'cancelled_by_user')
     WHERE id = j.id;
    RETURN 'cancelled';
  ELSIF j.status = 'running' THEN
    UPDATE public.ps_jobs SET cancel_requested_at = now(), cancelled_by = auth.uid() WHERE id = j.id;
    RETURN 'cancelling';
  END IF;
  RETURN j.status;
END;
$$;

-- The kinds of job that can simply be run again.
CREATE OR REPLACE FUNCTION public.ps_job_retryable(p_kind TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_kind IN ('pipeline.run', 'connector.sync', 'connector.test', 'connector.describe',
                    'ai.test', 'dataset.export', 'import.analyze');
$$;

-- A failed or cancelled job again, as a new job of the caller (who needs the
-- job's permission, as when starting it). A retry already waiting is returned.
CREATE OR REPLACE FUNCTION public.ps_retry_job(p_job_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j public.ps_jobs;
  waiting UUID;
  new_id UUID;
BEGIN
  SELECT * INTO j FROM public.ps_jobs x WHERE x.id = p_job_id FOR UPDATE;
  IF j.id IS NULL OR j.workspace_id IS NULL OR public.erp_workspace_role(j.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF j.status NOT IN ('failed', 'cancelled') OR NOT public.ps_job_retryable(j.kind) THEN
    RAISE EXCEPTION 'This job cannot be run again' USING ERRCODE = 'P0001', HINT = 'not_retryable';
  END IF;
  IF NOT public.erp_has_permission(j.workspace_id, public.ps_job_permission(j.kind)) THEN
    RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
  END IF;
  SELECT x.id INTO waiting FROM public.ps_jobs x
   WHERE x.retry_of = j.id AND x.status IN ('queued', 'running') LIMIT 1;
  IF waiting IS NOT NULL THEN RETURN waiting; END IF;
  new_id := public.ps_enqueue_job(j.workspace_id, j.kind, j.payload - 'attempt');
  UPDATE public.ps_jobs SET retry_of = j.id WHERE id = new_id;
  RETURN new_id;
END;
$$;

-- ─── 2. Health ───────────────────────────────────────────────────────────────

-- When a background worker last reported (it does every 30 seconds while it
-- runs); nothing else about the workers is shown.
CREATE OR REPLACE FUNCTION public.ps_worker_last_seen()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
  SELECT max(seen_at) FROM etna_platform.worker_status;
$$;

-- ─── 3. MCP access tokens ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ps_mcp_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- The first characters of the token, to tell tokens apart in the list.
  token_prefix TEXT NOT NULL CHECK (char_length(token_prefix) BETWEEN 8 AND 16),
  aal TEXT NOT NULL CHECK (aal IN ('aal1', 'aal2')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  use_count BIGINT NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '366 days')
);
CREATE INDEX IF NOT EXISTS ps_mcp_tokens_member ON public.ps_mcp_tokens (workspace_id, user_id);

-- Read and written only through the functions below (the hash never leaves them).
ALTER TABLE public.ps_mcp_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ps_mcp_tokens FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.ps_mcp_tokens;
CREATE POLICY erp_workspace_not_suspended ON public.ps_mcp_tokens AS RESTRICTIVE FOR ALL TO authenticated
  USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]));

-- p_token_hash: SHA-256 (hex) of the token the app generated and shows once.
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

-- The caller's tokens in the Terminal; with 'members', everyone's.
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

-- One's own token, or anyone's with 'members'.
CREATE OR REPLACE FUNCTION public.ps_mcp_token_revoke(p_token_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE t public.ps_mcp_tokens%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.ps_mcp_tokens x WHERE x.id = p_token_id FOR UPDATE;
  IF t.id IS NULL OR public.erp_workspace_role(t.workspace_id) IS NULL
     OR (t.user_id IS DISTINCT FROM auth.uid() AND NOT public.erp_has_permission(t.workspace_id, 'members')) THEN
    RAISE EXCEPTION 'Token not found' USING ERRCODE = 'P0002';
  END IF;
  IF t.revoked_at IS NULL THEN
    UPDATE public.ps_mcp_tokens SET revoked_at = now(), revoked_by = auth.uid() WHERE id = t.id;
  END IF;
END;
$$;

-- For the auth server role only (schema auth, where it works): the member a token stands for, when it is
-- valid (not revoked or expired, the account not banned, still a member).
-- Counts the use.
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

-- ─── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.ps_job_retryable(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_retry_job(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_worker_last_seen() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_mcp_token_create(UUID, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_mcp_token_list(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_mcp_token_revoke(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION auth.mcp_token_use(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ps_retry_job(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_worker_last_seen() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_mcp_token_create(UUID, TEXT, TEXT, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_mcp_token_list(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_mcp_token_revoke(UUID) TO authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') THEN
    GRANT EXECUTE ON FUNCTION auth.mcp_token_use(TEXT) TO etna_auth;
  END IF;
END;
$$;
