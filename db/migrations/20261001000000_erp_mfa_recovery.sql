-- ─── Two-factor recovery codes ───────────────────────────────────────────────
-- Additive. A user who loses their authenticator can sign in with their
-- password and use a one-time recovery code to remove their two-factor
-- devices, then set two-factor up again.
--
-- - Ten codes are issued when two-factor is turned on (or regenerated later
--   from a verified session). Only a SHA-256 hash is stored; the codes are
--   shown once.
-- - Using a code removes all of the user's authenticator devices and the
--   remaining codes. Workspaces that require two-factor stay closed to the
--   user until they enrol a device again.
-- - Attempts are rate limited (5 per 15 minutes per user), and every use is
--   written to the audit log of each workspace the user belongs to.
-- - The PostgREST pre-request check lets exactly this one RPC through for a
--   session that has not completed the second factor.
--
-- Rollback: supabase/snippets/rollback_20261001000000_erp_mfa_recovery.sql

CREATE TABLE IF NOT EXISTS public.erp_mfa_recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  UNIQUE (user_id, code_hash)
);

-- Only the functions below touch this table.
ALTER TABLE public.erp_mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_mfa_recovery_codes FROM PUBLIC, anon, authenticated;

-- Codes are compared case-insensitively, ignoring spaces and dashes.
CREATE OR REPLACE FUNCTION public.erp__mfa_recovery_hash(p_user_id UUID, p_code TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT encode(extensions.digest(p_user_id::text || ':' || upper(regexp_replace(COALESCE(p_code, ''), '[^0-9A-Za-z]', '', 'g')), 'sha256'), 'hex');
$$;

REVOKE ALL ON FUNCTION public.erp__mfa_recovery_hash(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- Replaces the caller's codes with ten new ones and returns them (shown once).
-- Needs a verified session, so a stolen password alone cannot mint codes.
CREATE OR REPLACE FUNCTION public.erp_mfa_generate_recovery_codes()
RETURNS TABLE (code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  -- 32 unambiguous characters (no 0/O, 1/I): each random byte maps without bias.
  alphabet CONSTANT TEXT := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  raw BYTEA;
  v_code TEXT;
  i INTEGER;
  j INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  IF NOT public.erp_mfa_enrolled(auth.uid()) THEN
    RAISE EXCEPTION 'Turn on two-factor authentication first' USING ERRCODE = '42501';
  END IF;
  IF public.erp_session_aal() <> 'aal2' THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;

  DELETE FROM public.erp_mfa_recovery_codes WHERE user_id = auth.uid();
  FOR i IN 1..10 LOOP
    raw := extensions.gen_random_bytes(10);
    v_code := '';
    FOR j IN 0..9 LOOP
      v_code := v_code || substr(alphabet, (get_byte(raw, j) % 32) + 1, 1);
    END LOOP;
    v_code := substr(v_code, 1, 5) || '-' || substr(v_code, 6, 5);
    INSERT INTO public.erp_mfa_recovery_codes (user_id, code_hash)
    VALUES (auth.uid(), public.erp__mfa_recovery_hash(auth.uid(), v_code));
    code := v_code;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- How many unused codes the caller has left.
CREATE OR REPLACE FUNCTION public.erp_mfa_recovery_status()
RETURNS TABLE (remaining INTEGER, generated_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*) FILTER (WHERE c.used_at IS NULL)::integer, MAX(c.created_at)
  FROM public.erp_mfa_recovery_codes c
  WHERE c.user_id = auth.uid();
$$;

-- Removes the caller's codes, e.g. after they removed their last device.
-- Allowed from a verified session, or when no device is left.
CREATE OR REPLACE FUNCTION public.erp_mfa_clear_recovery_codes()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  IF public.erp_mfa_enrolled(auth.uid()) AND public.erp_session_aal() <> 'aal2' THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  DELETE FROM public.erp_mfa_recovery_codes WHERE user_id = auth.uid();
END;
$$;

-- Signed in with the password only: a valid unused code removes every
-- authenticator device of the caller. Returns 'ok', 'invalid' or 'locked'
-- (never raises for a wrong code, so the attempt counter is kept).
CREATE OR REPLACE FUNCTION public.erp_mfa_use_recovery_code(p_code TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  me UUID := auth.uid();
  code_id UUID;
  removed INTEGER;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  IF NOT public.api_rate_limit_hit('mfa_recovery', 5, 900) THEN
    RETURN 'locked';
  END IF;

  SELECT c.id INTO code_id
  FROM public.erp_mfa_recovery_codes c
  WHERE c.user_id = me
    AND c.used_at IS NULL
    AND c.code_hash = public.erp__mfa_recovery_hash(me, p_code)
  FOR UPDATE;
  IF code_id IS NULL THEN
    RETURN 'invalid';
  END IF;

  UPDATE public.erp_mfa_recovery_codes SET used_at = now() WHERE id = code_id;
  DELETE FROM auth.mfa_factors WHERE user_id = me;
  GET DIAGNOSTICS removed = ROW_COUNT;
  -- The remaining codes belonged to the removed setup.
  DELETE FROM public.erp_mfa_recovery_codes WHERE user_id = me AND used_at IS NULL;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
  SELECT m.workspace_id, me, 'member.mfa_recovered', me, jsonb_build_object('devices_removed', removed)
  FROM public.erp_workspace_members m
  WHERE m.user_id = me AND m.status = 'active';

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.erp_mfa_generate_recovery_codes() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_mfa_recovery_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_mfa_clear_recovery_codes() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_mfa_use_recovery_code(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_mfa_generate_recovery_codes() TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_mfa_recovery_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_mfa_clear_recovery_codes() TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_mfa_use_recovery_code(TEXT) TO authenticated;

-- The pre-request check (20260928010000) with one exception: the recovery RPC
-- must work before the second factor, since that is the point of it.
CREATE OR REPLACE FUNCTION public.erp_check_request()
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF current_setting('request.path', true) = '/rpc/erp_mfa_use_recovery_code' THEN
    RETURN;
  END IF;
  IF NOT public.erp_mfa_satisfied() THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
END;
$$;
