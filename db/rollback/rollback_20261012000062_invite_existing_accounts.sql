-- Rollback of 20261012000062: e-mail invitations create accounts again (as in 20261012000031).

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
  link JSONB;
  created_today INTEGER;
  ws_name TEXT;
BEGIN
  IF address !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' OR char_length(address) > 254 THEN
    RAISE EXCEPTION 'Give a valid e-mail address' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO target FROM auth.users u WHERE lower(u.email) = address;
  IF target.id IS NOT NULL AND (etna_platform._is_container(target.raw_user_meta_data) OR etna_platform._is_closed(target.id)) THEN
    RAISE EXCEPTION 'This address cannot be invited' USING ERRCODE = 'P0001', HINT = 'not_invitable';
  END IF;
  IF target.id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.erp_workspace_members m WHERE m.workspace_id = p_workspace_id AND m.user_id = target.id AND m.status = 'active') THEN
    RAISE EXCEPTION 'Already a member of this workspace' USING ERRCODE = 'P0001', HINT = 'already_member';
  END IF;

  -- The code, with every check of an ordinary invitation (manager, no escalation, caps).
  SELECT * INTO invitation FROM public.erp_create_workspace_invitation_v2(p_workspace_id, p_role, p_expires_in_hours, '', p_custom_role_id);
  UPDATE public.erp_workspace_invitations SET email = address, label = left(address, 120) WHERE id = invitation.invitation_id;

  IF target.id IS NULL THEN
    SELECT count(*) INTO created_today FROM public.erp_workspace_invitations i
     WHERE i.workspace_id = p_workspace_id AND i.created_account AND i.created_at > now() - interval '1 day';
    IF created_today >= 20 THEN
      RAISE EXCEPTION 'Too many new accounts invited today' USING ERRCODE = 'P0001', HINT = 'rate_limited';
    END IF;
    INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
    VALUES (address, NULL, jsonb_build_object('full_name', split_part(address, '@', 1)), now())
    RETURNING * INTO target;
    link := etna_platform._create_password_link(target.id, p_token_hash, 'invite');
    UPDATE public.erp_workspace_invitations SET created_account = true WHERE id = invitation.invitation_id;
    SELECT w.name INTO ws_name FROM public.erp_workspaces w WHERE w.id = p_workspace_id;
    PERFORM etna_platform._log('USER_CREATED', 'success', 'user', target.id, address, p_workspace_id,
      jsonb_build_object('via', 'workspace_invitation', 'workspace_name', ws_name, 'invite_link_id', link ->> 'link_id'));
  END IF;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, invitation_id, details)
  VALUES (p_workspace_id, auth.uid(), 'invitation.emailed', invitation.invitation_id,
          jsonb_build_object('email', address, 'new_account', link IS NOT NULL));

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'invitation_id', invitation.invitation_id,
    'access_code', invitation.access_code,
    'expires_at', invitation.expires_at,
    'new_account', link IS NOT NULL,
    'link_expires_at', link ->> 'expires_at'));
END;
$$;
REVOKE ALL ON FUNCTION public.erp_invite_by_email(UUID, TEXT, TEXT, UUID, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_invite_by_email(UUID, TEXT, TEXT, UUID, INTEGER, TEXT) TO authenticated;
