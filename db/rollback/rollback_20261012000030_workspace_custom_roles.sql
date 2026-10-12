-- Rollback for 20261012000030_workspace_custom_roles.sql.
-- Run only after redeploying an app version from before this change.
--
-- Refused while any active member has a custom role: give them a built-in
-- role first (ERP → Settings → Members). Custom roles, their pending
-- invitations and the TERMINAL permissions of the built-in roles are removed;
-- the activity entries about roles stay.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.erp_workspace_members WHERE role = 'custom' AND status = 'active') THEN
    RAISE EXCEPTION 'Members still have custom roles; give them built-in roles first';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.erp_my_workspace_access();
DROP FUNCTION IF EXISTS public.erp__staff_session_until(UUID);
DROP FUNCTION IF EXISTS public.erp_my_permissions(UUID);
DROP FUNCTION IF EXISTS public.erp_delete_custom_role(UUID, UUID);
DROP FUNCTION IF EXISTS public.erp_save_custom_role(UUID, UUID, TEXT, TEXT, TEXT[], BOOLEAN);
DROP FUNCTION IF EXISTS public.erp_list_custom_roles(UUID);
DROP FUNCTION IF EXISTS public.erp__require_role_manager(UUID);
DROP FUNCTION IF EXISTS public.erp_list_workspace_members_v2(UUID);

-- As before this migration: public.erp_role_permissions(text)
CREATE OR REPLACE FUNCTION public.erp_role_permissions(p_role text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE p_role
    WHEN 'owner' THEN ARRAY['read','customers','suppliers','products','inventory','sales','invoicing','fulfillment','purchasing','receiving','payments','members','audit']
    WHEN 'admin' THEN ARRAY['read','customers','suppliers','products','inventory','sales','invoicing','fulfillment','purchasing','receiving','payments','members','audit']
    WHEN 'finance' THEN ARRAY['read','invoicing','payments']
    WHEN 'sales' THEN ARRAY['customers','sales','invoicing']
    WHEN 'inventory' THEN ARRAY['suppliers','products','inventory','fulfillment','purchasing','receiving']
    ELSE ARRAY[]::TEXT[]
  END;
$function$;

-- As before this migration: public.erp_has_permission(uuid,text)
CREATE OR REPLACE FUNCTION public.erp_has_permission(p_workspace_id uuid, p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(p_permission = ANY(public.erp_role_permissions(public.erp_workspace_role(p_workspace_id))), false)
     AND public.erp_workspace_mfa_ok(p_workspace_id);
$function$;

-- As before this migration: public.erp_can_read(uuid,text)
CREATE OR REPLACE FUNCTION public.erp_can_read(p_workspace_id uuid, p_area text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(public.erp_role_permissions(public.erp_workspace_role(p_workspace_id)) && public.erp_read_grants(p_area), false)
     AND public.erp_workspace_mfa_ok(p_workspace_id);
$function$;

-- As before this migration: public.erp__require_member_manager(uuid)
CREATE OR REPLACE FUNCTION public.erp__require_member_manager(p_workspace_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE actor_role TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  actor_role := public.erp_workspace_role(p_workspace_id);
  IF actor_role IS NULL OR NOT ('members' = ANY(public.erp_role_permissions(actor_role))) THEN
    RAISE EXCEPTION 'You are not allowed to manage members of this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN actor_role;
END;
$function$;

-- As before this migration: public.erp__role_needs_mfa(uuid)
CREATE OR REPLACE FUNCTION public.erp__role_needs_mfa(p_workspace_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((
    SELECT public.erp_workspace_role(w.id) IN ('owner', 'admin', 'finance')
           -- Not the caller's own personal ERP (a created ERP belongs to an internal owner).
           AND (NOT (w.is_personal AND w.owner_id = auth.uid()) OR EXISTS (
             SELECT 1 FROM public.erp_workspace_members m
              WHERE m.workspace_id = w.id AND m.status = 'active' AND m.user_id <> auth.uid()))
      FROM public.erp_workspaces w WHERE w.id = p_workspace_id), false);
$function$;

-- As before this migration: public.erp_documents_list(uuid)
CREATE OR REPLACE FUNCTION public.erp_documents_list(p_workspace_id uuid)
 RETURNS TABLE(id uuid, file_name text, content_type text, size_bytes bigint, created_at timestamp with time zone, uploaded_by_email text, can_delete boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ws UUID := COALESCE(p_workspace_id, public.erp_personal_workspace_id(auth.uid()));
  actor_role TEXT;
BEGIN
  actor_role := public.erp__require_document_access(ws);
  RETURN QUERY
  SELECT d.id, d.file_name, d.content_type, d.size_bytes, d.created_at, p.email,
         d.uploaded_by = auth.uid() OR 'members' = ANY(public.erp_role_permissions(actor_role))
  FROM public.erp_documents d
  LEFT JOIN public.user_profiles p ON p.id = d.uploaded_by
  WHERE d.workspace_id = ws
  ORDER BY d.created_at DESC
  LIMIT 500;
END;
$function$;

-- As before this migration: public.erp_document_delete(uuid)
CREATE OR REPLACE FUNCTION public.erp_document_delete(p_document_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  doc public.erp_documents%ROWTYPE;
  actor_role TEXT;
BEGIN
  IF current_setting('request.path', true) IS DISTINCT FROM '/documents/delete' THEN
    RAISE EXCEPTION 'Documents are deleted through the documents page' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO doc FROM public.erp_documents d WHERE d.id = p_document_id FOR UPDATE;
  IF NOT FOUND OR public.erp_workspace_role(doc.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002';
  END IF;
  actor_role := public.erp__require_document_access(doc.workspace_id);
  IF doc.uploaded_by IS DISTINCT FROM auth.uid() AND NOT ('members' = ANY(public.erp_role_permissions(actor_role))) THEN
    RAISE EXCEPTION 'Only the uploader, an owner or an admin can delete this document' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.erp_documents WHERE id = doc.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (doc.workspace_id, auth.uid(), 'document.deleted',
          jsonb_build_object('document_id', doc.id, 'file_name', doc.file_name, 'size_bytes', doc.size_bytes));
  RETURN doc.workspace_id;
END;
$function$;

-- As before this migration: public.erp_redeem_workspace_invitation(text)
CREATE OR REPLACE FUNCTION public.erp_redeem_workspace_invitation(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  actor UUID := auth.uid();
  normalized TEXT;
  invitation public.erp_workspace_invitations%ROWTYPE;
  membership public.erp_workspace_members%ROWTYPE;
  creator_role TEXT;
  short_failures INTEGER;
  daily_failures INTEGER;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = actor) THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- One redemption at a time per user, so parallel guesses share the limit.
  PERFORM pg_advisory_xact_lock(hashtext('erp_invite_redeem'), hashtext(actor::TEXT));

  SELECT count(*) FILTER (WHERE attempted_at > now() - interval '15 minutes'),
         count(*)
  INTO short_failures, daily_failures
  FROM public.erp_invitation_attempts
  WHERE user_id = actor AND NOT succeeded AND attempted_at > now() - interval '24 hours';
  IF short_failures >= 5 OR daily_failures >= 20 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;

  IF public.erp__active_workspace_count(actor) >= public.erp__workspace_limit_for(actor) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'workspace_limit', 'limit', public.erp__workspace_limit_for(actor));
  END IF;

  normalized := public.erp_normalize_access_code(p_code);
  IF length(normalized) = 20 THEN
    SELECT * INTO invitation
    FROM public.erp_workspace_invitations
    WHERE code_hash = public.erp_hash_access_code(normalized)
    FOR UPDATE;
  END IF;

  IF invitation.id IS NOT NULL THEN
    -- The inviter must still be allowed to grant this role.
    SELECT m.role INTO creator_role
    FROM public.erp_workspace_members m
    WHERE m.workspace_id = invitation.workspace_id AND m.user_id = invitation.created_by AND m.status = 'active';
  END IF;

  IF invitation.id IS NULL
     OR invitation.revoked_at IS NOT NULL
     OR invitation.redeemed_at IS NOT NULL
     OR invitation.expires_at <= now()
     OR creator_role IS NULL
     OR NOT (invitation.role = ANY(public.erp_grantable_roles(creator_role))) THEN
    INSERT INTO public.erp_invitation_attempts (user_id, succeeded) VALUES (actor, false);
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  SELECT * INTO membership
  FROM public.erp_workspace_members
  WHERE workspace_id = invitation.workspace_id AND user_id = actor
  FOR UPDATE;

  IF FOUND AND membership.status = 'active' THEN
    -- Already a member: nothing to do, and the code stays usable for its
    -- intended recipient.
    INSERT INTO public.erp_invitation_attempts (user_id, succeeded) VALUES (actor, true);
    RETURN jsonb_build_object('ok', true, 'workspace_id', invitation.workspace_id,
                              'role', membership.role, 'already_member', true);
  END IF;

  IF FOUND THEN
    UPDATE public.erp_workspace_members
    SET status = 'active', role = invitation.role, invited_by = invitation.created_by,
        invitation_id = invitation.id, joined_at = now(), removed_at = NULL,
        removed_by = NULL, removal_reason = '', updated_at = now()
    WHERE workspace_id = invitation.workspace_id AND user_id = actor;
  ELSE
    INSERT INTO public.erp_workspace_members (workspace_id, user_id, role, invited_by, invitation_id)
    VALUES (invitation.workspace_id, actor, invitation.role, invitation.created_by, invitation.id);
  END IF;

  UPDATE public.erp_workspace_invitations
  SET redeemed_by = actor, redeemed_at = now()
  WHERE id = invitation.id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, invitation_id, details)
  VALUES
    (invitation.workspace_id, actor, 'invitation.redeemed', actor, invitation.id, jsonb_build_object('role', invitation.role)),
    (invitation.workspace_id, actor, 'member.added', actor, invitation.id,
     jsonb_build_object('role', invitation.role, 'invited_by', invitation.created_by));

  INSERT INTO public.erp_invitation_attempts (user_id, succeeded) VALUES (actor, true);
  RETURN jsonb_build_object('ok', true, 'workspace_id', invitation.workspace_id,
                            'role', invitation.role, 'already_member', false);
END;
$function$;

-- As before this migration: public.erp_create_workspace_invitation(uuid,text,integer,text)
CREATE OR REPLACE FUNCTION public.erp_create_workspace_invitation(p_workspace_id uuid, p_role text, p_expires_in_hours integer DEFAULT 72, p_label text DEFAULT ''::text)
 RETURNS TABLE(invitation_id uuid, access_code text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  actor UUID := auth.uid();
  actor_role TEXT;
  alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  random_bytes BYTEA;
  code TEXT := '';
  idx INTEGER;
  new_id UUID;
  new_expiry TIMESTAMPTZ;
  pending_count INTEGER;
  clean_label TEXT := left(trim(COALESCE(p_label, '')), 120);
BEGIN
  actor_role := public.erp__require_member_manager(p_workspace_id);
  IF p_role IS NULL OR NOT (p_role = ANY(public.erp_grantable_roles(actor_role))) THEN
    RAISE EXCEPTION 'You cannot grant this role' USING ERRCODE = '42501';
  END IF;
  IF p_expires_in_hours IS NULL OR p_expires_in_hours < 1 OR p_expires_in_hours > 168 THEN
    RAISE EXCEPTION 'Invitation lifetime must be between 1 hour and 7 days';
  END IF;

  -- Serialize invitation creation per workspace so the pending cap holds.
  PERFORM 1 FROM public.erp_workspaces WHERE id = p_workspace_id FOR UPDATE;
  SELECT count(*) INTO pending_count
  FROM public.erp_workspace_invitations i
  WHERE i.workspace_id = p_workspace_id
    AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now();
  IF pending_count >= 25 THEN
    RAISE EXCEPTION 'Too many pending invitations. Revoke unused codes first';
  END IF;

  -- 256 is a multiple of 32, so byte % 32 is uniform over the alphabet.
  random_bytes := extensions.gen_random_bytes(20);
  FOR idx IN 0..19 LOOP
    code := code || substr(alphabet, (get_byte(random_bytes, idx) % 32) + 1, 1);
  END LOOP;

  new_expiry := now() + make_interval(hours => p_expires_in_hours);
  INSERT INTO public.erp_workspace_invitations (workspace_id, code_hash, role, label, created_by, expires_at)
  VALUES (p_workspace_id, public.erp_hash_access_code(code), p_role, clean_label, actor, new_expiry)
  RETURNING id INTO new_id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, invitation_id, details)
  VALUES (p_workspace_id, actor, 'invitation.created', new_id,
          jsonb_build_object('role', p_role, 'expires_at', new_expiry, 'label', clean_label));

  RETURN QUERY SELECT new_id,
    'ETNA-' || substr(code, 1, 5) || '-' || substr(code, 6, 5) || '-' || substr(code, 11, 5) || '-' || substr(code, 16, 5),
    new_expiry;
END;
$function$;

-- As before this migration: public.erp_update_workspace_member_role(uuid,uuid,text,text)
CREATE OR REPLACE FUNCTION public.erp_update_workspace_member_role(p_workspace_id uuid, p_user_id uuid, p_role text, p_reason text DEFAULT ''::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  actor_role TEXT;
  target public.erp_workspace_members%ROWTYPE;
BEGIN
  actor_role := public.erp__require_member_manager(p_workspace_id);
  IF p_user_id = auth.uid() THEN RAISE EXCEPTION 'You cannot change your own role' USING ERRCODE = '42501'; END IF;
  SELECT * INTO target FROM public.erp_workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found'; END IF;
  IF NOT (target.role = ANY(public.erp_grantable_roles(actor_role)))
     OR p_role IS NULL OR NOT (p_role = ANY(public.erp_grantable_roles(actor_role))) THEN
    RAISE EXCEPTION 'You cannot assign this role' USING ERRCODE = '42501';
  END IF;
  IF target.role = p_role THEN RETURN; END IF;

  UPDATE public.erp_workspace_members SET role = p_role, updated_at = now()
  WHERE workspace_id = p_workspace_id AND user_id = p_user_id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
  VALUES (p_workspace_id, auth.uid(), 'member.role_changed', p_user_id,
          jsonb_build_object('from', target.role, 'to', p_role, 'reason', left(trim(COALESCE(p_reason, '')), 500)));
END;
$function$;

-- As before this migration: public.erp_remove_workspace_member(uuid,uuid,text)
CREATE OR REPLACE FUNCTION public.erp_remove_workspace_member(p_workspace_id uuid, p_user_id uuid, p_reason text DEFAULT ''::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  actor_role TEXT;
  target public.erp_workspace_members%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO target FROM public.erp_workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found'; END IF;
  IF target.role = 'owner' THEN RAISE EXCEPTION 'The workspace owner cannot be removed' USING ERRCODE = '42501'; END IF;

  IF p_user_id <> auth.uid() THEN
    actor_role := public.erp__require_member_manager(p_workspace_id);
    IF NOT (target.role = ANY(public.erp_grantable_roles(actor_role))) THEN
      RAISE EXCEPTION 'You cannot remove this member' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE public.erp_workspace_members
  SET status = 'removed', removed_at = now(), removed_by = auth.uid(),
      removal_reason = left(trim(COALESCE(p_reason, '')), 500), updated_at = now()
  WHERE workspace_id = p_workspace_id AND user_id = p_user_id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
  VALUES (p_workspace_id, auth.uid(),
          CASE WHEN p_user_id = auth.uid() THEN 'member.left' ELSE 'member.removed' END,
          p_user_id, jsonb_build_object('role', target.role, 'reason', left(trim(COALESCE(p_reason, '')), 500)));
END;
$function$;

-- As before this migration: public.erp_list_workspace_members(uuid)
CREATE OR REPLACE FUNCTION public.erp_list_workspace_members(p_workspace_id uuid)
 RETURNS TABLE(user_id uuid, email text, full_name text, role text, joined_at timestamp with time zone, is_owner boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.erp_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT m.user_id, p.email, p.full_name, m.role, m.joined_at, m.role = 'owner'
  FROM public.erp_workspace_members m
  JOIN public.user_profiles p ON p.id = m.user_id
  WHERE m.workspace_id = p_workspace_id AND m.status = 'active'
  ORDER BY (m.role = 'owner') DESC, m.joined_at;
END;
$function$;

DROP FUNCTION IF EXISTS public.erp_create_workspace_invitation_v2(UUID, TEXT, INTEGER, TEXT, UUID);
DROP FUNCTION IF EXISTS public.erp_update_workspace_member_role_v2(UUID, UUID, TEXT, TEXT, UUID);

DROP FUNCTION IF EXISTS public.erp_my_grantable_roles(UUID);
DROP FUNCTION IF EXISTS public.erp_member_permissions(UUID);
DROP FUNCTION IF EXISTS public.erp__can_grant(UUID, UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS public.erp__member_permissions_of(UUID, UUID);

UPDATE public.erp_workspace_members SET role = 'viewer', custom_role_id = NULL WHERE role = 'custom';
DELETE FROM public.erp_workspace_invitations WHERE role = 'custom';
ALTER TABLE public.erp_workspace_members DROP CONSTRAINT IF EXISTS erp_workspace_members_custom_role_check;
ALTER TABLE public.erp_workspace_members DROP CONSTRAINT IF EXISTS erp_workspace_members_role_check;
ALTER TABLE public.erp_workspace_members ADD CONSTRAINT erp_workspace_members_role_check CHECK (
  role IN ('owner', 'admin', 'finance', 'sales', 'inventory') OR (role = 'viewer' AND status = 'removed'));
ALTER TABLE public.erp_workspace_invitations DROP CONSTRAINT IF EXISTS erp_workspace_invitations_custom_role_check;
ALTER TABLE public.erp_workspace_invitations DROP CONSTRAINT IF EXISTS erp_workspace_invitations_role_check;
ALTER TABLE public.erp_workspace_invitations ADD CONSTRAINT erp_workspace_invitations_role_check CHECK (
  role IN ('admin', 'finance', 'sales', 'inventory') OR (role = 'viewer' AND (redeemed_at IS NOT NULL OR revoked_at IS NOT NULL)));
ALTER TABLE public.erp_workspace_invitations DROP COLUMN IF EXISTS custom_role_id;
ALTER TABLE public.erp_workspace_members DROP COLUMN IF EXISTS custom_role_id;
DROP FUNCTION IF EXISTS public.erp__role_set(TEXT, UUID);
DROP TABLE IF EXISTS public.erp_custom_roles;
DROP FUNCTION IF EXISTS public.erp_sensitive_permissions();
DROP FUNCTION IF EXISTS public.erp_all_permissions();

COMMIT;
