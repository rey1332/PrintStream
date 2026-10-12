-- Admin panel: closing accounts, transferring ERP ownership, a fuller account
-- list.
--
-- 1. Close account (etna_platform.admin_close_account): super admin, fresh
--    two-factor code, a reason, and the account's e-mail typed again. The
--    account row is NOT deleted: business tables point at it with ON DELETE
--    CASCADE, so deleting it would delete the records it wrote. Instead the
--    account is shut for good and its personal details are replaced:
--      * sign-in blocked forever, password removed, sessions ended, open
--        password links cancelled, authenticators and recovery codes removed;
--      * removed from every ERP (history kept, one entry each in the ERP's
--        own trail), its pending invitation codes revoked, its ERP limit
--        reset;
--      * e-mail and name replaced with placeholders (the address can be used
--        for a new account), its own personal ERP renamed.
--    Transactions, documents, workflows and audit trails stay. The security
--    log keeps the original address (it is append-only by design).
--    Refused for: your own account, a platform admin (revoke the role first),
--    an account already closed, and the Owner of an ERP that still has other
--    members (transfer the ownership first; a personal ERP cannot be
--    transferred, so its other members have to be removed instead).
--    Closed accounts are listed in etna_platform.closed_accounts and
--    _target() refuses every further admin action on them.
-- 2. Transfer ownership (etna_platform.admin_transfer_ownership): super admin,
--    fresh code, reason. Only for ERPs created from Add modules or New company
--    (their books belong to an internal account, so only the member roles
--    change). The new Owner must already be an active member; the previous
--    Owner, if still active, becomes Admin. created_by follows the Owner, as
--    it names the person shown as Owner. admin_workspace_detail says whether
--    an ERP can be transferred.
-- 3. admin_list_users: status "closed", every ERP with the account's role,
--    and a sort order.
--
-- Rollback: db/rollback/rollback_20261012000029_platform_admin_close_account.sql

-- ─── 1. Closed accounts ──────────────────────────────────────────────────────

-- No foreign key: the record stays whatever happens to the account.
CREATE TABLE IF NOT EXISTS etna_platform.closed_accounts (
  user_id UUID PRIMARY KEY,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by UUID,
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 3 AND 500)
);
REVOKE ALL ON etna_platform.closed_accounts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION etna_platform._is_closed(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM etna_platform.closed_accounts c WHERE c.user_id = p_user_id);
$$;

-- As in 20261012000012, plus: nothing more is done to a closed account.
CREATE OR REPLACE FUNCTION etna_platform._target(p_user_id UUID, p_caller_role TEXT, p_allow_self BOOLEAN)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  address TEXT;
  meta JSONB;
BEGIN
  SELECT u.email, u.raw_user_meta_data INTO address, meta FROM auth.users u WHERE u.id = p_user_id;
  IF address IS NULL OR etna_platform._is_container(meta) THEN
    RAISE EXCEPTION 'No such account' USING ERRCODE = 'P0002';
  END IF;
  IF etna_platform._is_closed(p_user_id) THEN
    RAISE EXCEPTION 'This account is closed' USING ERRCODE = 'P0001', HINT = 'closed';
  END IF;
  IF p_user_id = auth.uid() AND NOT p_allow_self THEN
    RAISE EXCEPTION 'Not on your own account' USING ERRCODE = 'P0001', HINT = 'self';
  END IF;
  IF etna_platform._role_of(p_user_id) IS NOT NULL AND p_caller_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Only a super admin may act on an admin account' USING ERRCODE = '42501', HINT = 'not_admin';
  END IF;
  RETURN address;
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_close_account(p_user_id UUID, p_reason TEXT, p_confirm_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  why TEXT := left(trim(COALESCE(p_reason, '')), 500);
  address TEXT;
  placeholder TEXT := 'closed-' || p_user_id || '@closed.etna.invalid';
  blocking TEXT;
  membership RECORD;
  removed INTEGER := 0;
  ended INTEGER;
BEGIN
  IF char_length(why) < 3 THEN
    RAISE EXCEPTION 'Give a reason' USING ERRCODE = '22023';
  END IF;
  -- One closure at a time per account.
  PERFORM 1 FROM auth.users u WHERE u.id = p_user_id FOR UPDATE;
  address := etna_platform._target(p_user_id, caller_role, false);
  IF lower(trim(COALESCE(p_confirm_email, ''))) <> lower(address) THEN
    RAISE EXCEPTION 'Type the account''s e-mail address to confirm' USING ERRCODE = 'P0001', HINT = 'confirm';
  END IF;
  IF etna_platform._role_of(p_user_id) IS NOT NULL THEN
    RAISE EXCEPTION 'Revoke the admin role first' USING ERRCODE = 'P0001', HINT = 'is_admin';
  END IF;

  SELECT string_agg(w.name, ', ' ORDER BY w.name) INTO blocking
    FROM public.erp_workspace_members m
    JOIN public.erp_workspaces w ON w.id = m.workspace_id
   WHERE m.user_id = p_user_id AND m.status = 'active' AND m.role = 'owner'
     AND EXISTS (SELECT 1 FROM public.erp_workspace_members o
                  WHERE o.workspace_id = m.workspace_id AND o.user_id <> p_user_id AND o.status = 'active');
  IF blocking IS NOT NULL THEN
    RAISE EXCEPTION 'Owner of ERPs that other people use: %', blocking USING ERRCODE = 'P0001', HINT = 'owns_workspace';
  END IF;

  -- Out of every ERP, before the details change, so each ERP's trail and the
  -- security log name the person.
  FOR membership IN
    SELECT m.workspace_id, m.role FROM public.erp_workspace_members m
     WHERE m.user_id = p_user_id AND m.status = 'active'
     FOR UPDATE
  LOOP
    UPDATE public.erp_workspace_members
       SET status = 'removed', removed_at = now(), removed_by = auth.uid(), removal_reason = 'Account closed: ' || why,
           updated_at = now()
     WHERE workspace_id = membership.workspace_id AND user_id = p_user_id;
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
    VALUES (membership.workspace_id, auth.uid(), 'member.removed', p_user_id,
            jsonb_build_object('role', membership.role, 'reason', 'Account closed: ' || why, 'via', 'etna_admin'));
    removed := removed + 1;
  END LOOP;

  UPDATE public.erp_workspace_invitations
     SET revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'Account closed'
   WHERE created_by = p_user_id AND redeemed_at IS NULL AND revoked_at IS NULL;

  ended := etna_platform._end_sessions(p_user_id);
  UPDATE etna_platform.password_links SET revoked_at = now()
   WHERE user_id = p_user_id AND used_at IS NULL AND revoked_at IS NULL;
  DELETE FROM auth.mfa_factors WHERE user_id = p_user_id;
  DELETE FROM public.erp_mfa_recovery_codes WHERE user_id = p_user_id;
  DELETE FROM etna_platform.account_limits WHERE user_id = p_user_id;

  INSERT INTO etna_platform.closed_accounts (user_id, closed_by, reason) VALUES (p_user_id, auth.uid(), why);
  PERFORM etna_platform._log('ACCOUNT_CLOSED', 'success', 'admin', p_user_id, address, NULL,
    jsonb_build_object('reason', why, 'erps_left', removed, 'sessions_ended', ended));

  UPDATE auth.users
     SET email = placeholder, encrypted_password = NULL, banned_until = 'infinity',
         raw_user_meta_data = jsonb_build_object('full_name', 'Closed account'), updated_at = now()
   WHERE id = p_user_id;
  UPDATE public.user_profiles SET email = placeholder, full_name = 'Closed account' WHERE id = p_user_id;
  UPDATE public.erp_workspaces SET name = 'Closed account', updated_at = now()
   WHERE owner_id = p_user_id AND is_personal;

  RETURN jsonb_build_object('erps_left', removed, 'sessions_ended', ended);
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_user_closure(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  RETURN (
    SELECT jsonb_build_object('closed_at', c.closed_at, 'reason', c.reason,
                              'closed_by_email', (SELECT u.email FROM auth.users u WHERE u.id = c.closed_by))
      FROM etna_platform.closed_accounts c WHERE c.user_id = p_user_id);
END;
$$;

-- ─── 2. Transfer ownership ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION etna_platform.admin_transfer_ownership(p_workspace_id UUID, p_new_owner UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  why TEXT := left(trim(COALESCE(p_reason, '')), 500);
  w public.erp_workspaces;
  newcomer public.erp_workspace_members;
  previous UUID;
  address TEXT;
BEGIN
  IF char_length(why) < 3 THEN
    RAISE EXCEPTION 'Give a reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO w FROM public.erp_workspaces x WHERE x.id = p_workspace_id FOR UPDATE;
  IF w.id IS NULL THEN
    RAISE EXCEPTION 'No such workspace' USING ERRCODE = 'P0002';
  END IF;
  -- A person's own ERP keeps its books under that person: it cannot change hands.
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = w.owner_id AND etna_platform._is_container(u.raw_user_meta_data)) THEN
    RAISE EXCEPTION 'A personal ERP cannot be transferred' USING ERRCODE = 'P0001', HINT = 'personal';
  END IF;
  -- A person, and not the caller: nobody makes themselves Owner of client data.
  address := etna_platform._target(p_new_owner, caller_role, false);

  SELECT * INTO newcomer FROM public.erp_workspace_members m
   WHERE m.workspace_id = w.id AND m.user_id = p_new_owner AND m.status = 'active' FOR UPDATE;
  IF newcomer.user_id IS NULL THEN
    RAISE EXCEPTION 'The new Owner must be a member of this ERP first' USING ERRCODE = 'P0001', HINT = 'not_member';
  END IF;
  IF newcomer.role = 'owner' THEN
    RAISE EXCEPTION 'Already the Owner' USING ERRCODE = 'P0001', HINT = 'already';
  END IF;

  SELECT m.user_id INTO previous FROM public.erp_workspace_members m
   WHERE m.workspace_id = w.id AND m.role = 'owner' AND m.status = 'active' FOR UPDATE;
  IF previous IS NOT NULL THEN
    UPDATE public.erp_workspace_members SET role = 'admin', updated_at = now()
     WHERE workspace_id = w.id AND user_id = previous;
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
    VALUES (w.id, auth.uid(), 'member.role_changed', previous,
            jsonb_build_object('from', 'owner', 'to', 'admin', 'reason', why, 'via', 'etna_admin'));
  END IF;
  UPDATE public.erp_workspace_members SET role = 'owner', updated_at = now()
   WHERE workspace_id = w.id AND user_id = p_new_owner;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
  VALUES (w.id, auth.uid(), 'member.role_changed', p_new_owner,
          jsonb_build_object('from', newcomer.role, 'to', 'owner', 'reason', why, 'via', 'etna_admin'));
  UPDATE public.erp_workspaces SET created_by = p_new_owner, updated_at = now() WHERE id = w.id;

  PERFORM etna_platform._log('WORKSPACE_OWNER_CHANGED', 'success', 'admin', p_new_owner, address, w.id,
    jsonb_build_object('reason', why, 'workspace_name', w.name,
                       'previous_owner_email', (SELECT u.email FROM auth.users u WHERE u.id = previous)));
END;
$$;

-- The workspace page offers the transfer only where it is possible.
DO $$
DECLARE
  body TEXT := pg_get_functiondef('etna_platform.admin_workspace_detail(uuid)'::regprocedure);
  anchor TEXT := '''suspended'', EXISTS (SELECT 1 FROM etna_platform.workspace_suspensions s';
BEGIN
  IF position('''transferable''' IN body) = 0 THEN
    IF position(anchor IN body) = 0 THEN
      RAISE EXCEPTION 'Cannot patch admin_workspace_detail: expected text not found';
    END IF;
    EXECUTE replace(body, anchor,
      '''transferable'', EXISTS (SELECT 1 FROM auth.users u WHERE u.id = w.owner_id AND etna_platform._is_container(u.raw_user_meta_data)),' || chr(10) || '      ' || anchor);
  END IF;
END;
$$;

-- ─── 3. Account list ─────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS etna_platform.admin_list_users(TEXT, TEXT, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION etna_platform.admin_list_users(
  p_query TEXT DEFAULT NULL,
  p_filter TEXT DEFAULT 'all',
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0,
  p_sort TEXT DEFAULT 'created_desc'
)
RETURNS TABLE (
  user_id UUID, email TEXT, full_name TEXT, created_at TIMESTAMPTZ, last_sign_in_at TIMESTAMPTZ,
  disabled BOOLEAN, closed BOOLEAN, mfa_enrolled BOOLEAN, active_sessions INTEGER, workspaces INTEGER,
  memberships JSONB, admin_role TEXT, total BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  needle TEXT := NULLIF(lower(trim(COALESCE(p_query, ''))), '');
  pattern TEXT;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  IF p_filter IS NULL OR p_filter NOT IN ('all', 'disabled', 'closed', 'no_mfa', 'admins') THEN
    RAISE EXCEPTION 'Unknown filter' USING ERRCODE = '22023';
  END IF;
  IF p_sort IS NULL OR p_sort NOT IN ('created_desc', 'created_asc', 'last_sign_in_desc', 'email_asc') THEN
    RAISE EXCEPTION 'Unknown sort order' USING ERRCODE = '22023';
  END IF;
  IF needle IS NOT NULL THEN
    pattern := '%' || replace(replace(replace(left(needle, 320), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;
  RETURN QUERY
  WITH people AS (
    SELECT u.id AS uid, u.email AS address, COALESCE(u.raw_user_meta_data ->> 'full_name', '') AS name,
           u.created_at AS created, u.last_sign_in_at AS last_in,
           etna_platform._is_closed(u.id) AS is_closed,
           COALESCE(u.banned_until > now(), false) AS is_banned,
           EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = u.id AND f.status = 'verified') AS has_mfa,
           (SELECT count(*) FROM auth.sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now())::int AS n_sessions,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('workspace_id', w.id, 'name', w.name, 'role', m.role)
                                      ORDER BY (m.role = 'owner') DESC, w.name)
                       FROM public.erp_workspace_members m
                       JOIN public.erp_workspaces w ON w.id = m.workspace_id
                      WHERE m.user_id = u.id AND m.status = 'active'), '[]'::jsonb) AS member_of,
           a.role AS role_name
      FROM auth.users u
      LEFT JOIN etna_platform.admins a ON a.user_id = u.id
     WHERE NOT etna_platform._is_container(u.raw_user_meta_data)
       AND (needle IS NULL OR lower(u.email) LIKE pattern
            OR lower(COALESCE(u.raw_user_meta_data ->> 'full_name', '')) LIKE pattern)
  )
  SELECT p.uid, p.address, p.name, p.created, p.last_in, p.is_banned AND NOT p.is_closed, p.is_closed,
         p.has_mfa, p.n_sessions, jsonb_array_length(p.member_of), p.member_of, p.role_name, count(*) OVER ()
    FROM people p
   WHERE p_filter = 'all'
      OR (p_filter = 'disabled' AND p.is_banned AND NOT p.is_closed)
      OR (p_filter = 'closed' AND p.is_closed)
      OR (p_filter = 'no_mfa' AND NOT p.has_mfa AND NOT p.is_closed)
      OR (p_filter = 'admins' AND p.role_name IS NOT NULL)
   ORDER BY
     CASE WHEN p_sort = 'created_desc' THEN p.created END DESC,
     CASE WHEN p_sort = 'created_asc' THEN p.created END ASC,
     CASE WHEN p_sort = 'last_sign_in_desc' THEN p.last_in END DESC NULLS LAST,
     CASE WHEN p_sort = 'email_asc' THEN lower(p.address) END ASC,
     p.created DESC, p.uid
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

-- ─── 4. Privileges ───────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION etna_platform._is_closed(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION etna_platform._target(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION etna_platform.admin_close_account(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_user_closure(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_transfer_ownership(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_list_users(TEXT, TEXT, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION etna_platform.admin_close_account(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_user_closure(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_transfer_ownership(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_list_users(TEXT, TEXT, INTEGER, INTEGER, TEXT) TO authenticated;
