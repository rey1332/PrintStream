-- Workspaces add people; ETNA creates accounts.
--
-- PrintStream runs on ETNA's servers. Accounts are created only by ETNA's
-- platform Owner and Admins (/admin → Users, Create company, psctl users).
-- A workspace Owner or Admin adds people who already have an account: with an
-- invitation code, or by e-mail. Inviting an address without an account is
-- refused (hint no_account) instead of creating one, as 20261012000031 did.
-- Invitations made before this migration keep working.
--
-- Rollback: db/rollback/rollback_20261012000062_invite_existing_accounts.sql

CREATE OR REPLACE FUNCTION public.erp_invite_by_email(
  p_workspace_id UUID, p_email TEXT, p_role TEXT, p_custom_role_id UUID, p_expires_in_hours INTEGER, p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, etna_platform, pg_temp
AS $$
DECLARE
  address TEXT := lower(trim(COALESCE(p_email, '')));
  target auth.users;
  invitation RECORD;
BEGIN
  IF address !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' OR char_length(address) > 254 THEN
    RAISE EXCEPTION 'Give a valid e-mail address' USING ERRCODE = '22023';
  END IF;
  -- Only people allowed to invite learn whether an address has an account.
  IF NOT public.erp_has_permission(p_workspace_id, 'members') THEN
    RAISE EXCEPTION 'You are not allowed to manage members of this workspace' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO target FROM auth.users u WHERE lower(u.email) = address;
  IF target.id IS NULL THEN
    RAISE EXCEPTION 'No PrintStream account uses this address. Accounts are created by ETNA; ask ETNA to create it, then invite again.'
      USING ERRCODE = 'P0001', HINT = 'no_account';
  END IF;
  IF etna_platform._is_container(target.raw_user_meta_data) OR etna_platform._is_closed(target.id) THEN
    RAISE EXCEPTION 'This address cannot be invited' USING ERRCODE = 'P0001', HINT = 'not_invitable';
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.erp_workspace_members m WHERE m.workspace_id = p_workspace_id AND m.user_id = target.id AND m.status = 'active') THEN
    RAISE EXCEPTION 'Already a member of this workspace' USING ERRCODE = 'P0001', HINT = 'already_member';
  END IF;

  -- The code, with every check of an ordinary invitation (manager, no escalation, caps).
  SELECT * INTO invitation FROM public.erp_create_workspace_invitation_v2(p_workspace_id, p_role, p_expires_in_hours, '', p_custom_role_id);
  UPDATE public.erp_workspace_invitations SET email = address, label = left(address, 120) WHERE id = invitation.invitation_id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, invitation_id, details)
  VALUES (p_workspace_id, auth.uid(), 'invitation.emailed', invitation.invitation_id,
          jsonb_build_object('email', address, 'new_account', false));

  RETURN jsonb_build_object(
    'invitation_id', invitation.invitation_id,
    'access_code', invitation.access_code,
    'expires_at', invitation.expires_at,
    'new_account', false);
END;
$$;
REVOKE ALL ON FUNCTION public.erp_invite_by_email(UUID, TEXT, TEXT, UUID, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_invite_by_email(UUID, TEXT, TEXT, UUID, INTEGER, TEXT) TO authenticated;
