-- ─── Two-factor enforcement, workspace security settings, API rate limits ────
-- Additive. Nothing changes for users who have not enrolled two-factor
-- authentication and workspaces that do not require it.
--
-- 1. MFA enforcement in the database. A user with a verified MFA factor must
--    have completed the second step (JWT aal = aal2) before any API request is
--    served — tables and RPCs alike — via PostgREST's pre-request hook. A
--    stolen password alone therefore cannot read or change ERP data, even
--    when the Supabase API is called directly instead of through the app.
-- 2. Workspace security: owners can require two-factor for every member
--    (members without it lose data access in that workspace until they enable
--    it), rename the workspace, and see which members have two-factor on.
-- 3. API rate limits kept in the database, so they hold across every app
--    server instance (the previous limiter lived in one process's memory).
--
-- Rollback: supabase/snippets/rollback_20260928010000_erp_security_workspace.sql

-- ─── 1. MFA ───────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_session_aal()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(auth.jwt() ->> 'aal', 'aal1');
$$;

CREATE OR REPLACE FUNCTION public.erp_mfa_enrolled(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = p_user_id AND f.status::text = 'verified');
$$;

-- True when the signed-in user may be served: anonymous, already at aal2,
-- or without a verified factor.
CREATE OR REPLACE FUNCTION public.erp_mfa_satisfied()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT auth.uid() IS NULL
      OR public.erp_session_aal() = 'aal2'
      OR NOT public.erp_mfa_enrolled(auth.uid());
$$;

-- PostgREST runs this before every API request (see below).
CREATE OR REPLACE FUNCTION public.erp_check_request()
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT public.erp_mfa_satisfied() THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_mfa_enrolled(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_mfa_satisfied() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_check_request() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erp_session_aal() TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_mfa_satisfied() TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_check_request() TO anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    ALTER ROLE authenticator SET pgrst.db_pre_request = 'public.erp_check_request';
    NOTIFY pgrst, 'reload config';
  END IF;
END;
$$;

-- ─── 2. Workspace security settings ───────────────────────────────────────────

ALTER TABLE public.erp_workspaces
  ADD COLUMN IF NOT EXISTS require_mfa BOOLEAN NOT NULL DEFAULT false;

-- Data access in a workspace that requires two-factor needs an aal2 session.
CREATE OR REPLACE FUNCTION public.erp_workspace_mfa_ok(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT NOT w.require_mfa OR public.erp_session_aal() = 'aal2'
                   FROM public.erp_workspaces w WHERE w.id = p_workspace_id), true);
$$;

-- Same definition as before, plus the workspace's two-factor requirement.
CREATE OR REPLACE FUNCTION public.erp_has_permission(p_workspace_id UUID, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(p_permission = ANY(public.erp_role_permissions(public.erp_workspace_role(p_workspace_id))), false)
     AND public.erp_workspace_mfa_ok(p_workspace_id);
$$;

REVOKE ALL ON FUNCTION public.erp_workspace_mfa_ok(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_workspace_mfa_ok(UUID) TO authenticated;

-- Security state of a workspace as seen by the signed-in member.
CREATE OR REPLACE FUNCTION public.erp_workspace_security(p_workspace_id UUID)
RETURNS TABLE (require_mfa BOOLEAN, my_mfa_enrolled BOOLEAN, session_aal TEXT, access_blocked BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF public.erp_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT w.require_mfa, public.erp_mfa_enrolled(auth.uid()), public.erp_session_aal(),
         NOT public.erp_workspace_mfa_ok(w.id)
  FROM public.erp_workspaces w WHERE w.id = p_workspace_id;
END;
$$;

-- Which members have two-factor enabled (for owners/admins deciding whether
-- to require it). Emails are already visible to members; nothing else is added.
CREATE OR REPLACE FUNCTION public.erp_list_workspace_member_security(p_workspace_id UUID)
RETURNS TABLE (user_id UUID, mfa_enrolled BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT public.erp_has_permission(p_workspace_id, 'members') THEN
    RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT m.user_id, public.erp_mfa_enrolled(m.user_id)
  FROM public.erp_workspace_members m
  WHERE m.workspace_id = p_workspace_id AND m.status = 'active';
END;
$$;

-- Only the owner, from a two-factor session, can require two-factor (so the
-- owner cannot lock themselves out), and every change is audited.
CREATE OR REPLACE FUNCTION public.erp_set_workspace_require_mfa(p_workspace_id UUID, p_required BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE w public.erp_workspaces;
BEGIN
  SELECT * INTO w FROM public.erp_workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR w.owner_id <> auth.uid() THEN
    RAISE EXCEPTION 'Only the workspace owner can change this setting' USING ERRCODE = '42501';
  END IF;
  IF p_required AND public.erp_session_aal() <> 'aal2' THEN
    RAISE EXCEPTION 'Turn on two-factor authentication for your own account first' USING ERRCODE = 'P0001';
  END IF;
  IF w.require_mfa IS DISTINCT FROM p_required THEN
    UPDATE public.erp_workspaces SET require_mfa = p_required, updated_at = now() WHERE id = w.id;
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    VALUES (w.id, auth.uid(), CASE WHEN p_required THEN 'workspace.mfa_required' ELSE 'workspace.mfa_optional' END, '{}'::jsonb);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_rename_workspace(p_workspace_id UUID, p_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  clean TEXT := btrim(COALESCE(p_name, ''));
  old_name TEXT;
BEGIN
  IF NOT public.erp_has_permission(p_workspace_id, 'members') THEN
    RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
  END IF;
  IF char_length(clean) < 1 OR char_length(clean) > 80 THEN
    RAISE EXCEPTION 'Workspace name must be 1 to 80 characters' USING ERRCODE = 'P0001';
  END IF;
  SELECT name INTO old_name FROM public.erp_workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF old_name IS DISTINCT FROM clean THEN
    UPDATE public.erp_workspaces SET name = clean, updated_at = now() WHERE id = p_workspace_id;
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    VALUES (p_workspace_id, auth.uid(), 'workspace.renamed', jsonb_build_object('from', old_name, 'to', clean));
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_workspace_security(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_list_workspace_member_security(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_set_workspace_require_mfa(UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_rename_workspace(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_workspace_security(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_list_workspace_member_security(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_set_workspace_require_mfa(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_rename_workspace(UUID, TEXT) TO authenticated;

-- ─── 3. Rate limits ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  user_id UUID NOT NULL,
  bucket TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, bucket, window_start)
);
ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_rate_limits FROM PUBLIC, anon, authenticated;

-- Counts one request for the signed-in user in a fixed window; true while the
-- count is within the limit.
CREATE OR REPLACE FUNCTION public.api_rate_limit_hit(p_bucket TEXT, p_limit INTEGER, p_window_seconds INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  win TIMESTAMPTZ;
  total INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  IF p_bucket IS NULL OR char_length(p_bucket) NOT BETWEEN 1 AND 64
     OR p_limit NOT BETWEEN 1 AND 100000 OR p_window_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'Invalid rate limit' USING ERRCODE = '22023';
  END IF;
  win := to_timestamp(floor(extract(epoch FROM clock_timestamp()) / p_window_seconds) * p_window_seconds);
  INSERT INTO public.api_rate_limits (user_id, bucket, window_start, hits)
  VALUES (auth.uid(), p_bucket, win, 1)
  ON CONFLICT (user_id, bucket, window_start) DO UPDATE SET hits = api_rate_limits.hits + 1
  RETURNING hits INTO total;
  -- Occasional cleanup of old windows.
  IF random() < 0.01 THEN
    DELETE FROM public.api_rate_limits WHERE window_start < now() - interval '1 day';
  END IF;
  RETURN total <= p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.api_rate_limit_hit(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_rate_limit_hit(TEXT, INTEGER, INTEGER) TO authenticated;
