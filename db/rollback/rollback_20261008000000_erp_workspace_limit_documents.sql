-- Rollback for 20261008000000_erp_workspace_limit_documents.sql.
-- Run only after redeploying an app version from before the ERP limit and
-- documents.
--
-- Restores: invitation redemption without the ERP limit.
-- Not restored: document metadata is dropped with its table. The files stay
-- on disk (ETNA_DOCUMENTS_DIR, default storage/documents); move or delete
-- them by hand. Audit entries for documents are kept.

BEGIN;

DROP TRIGGER IF EXISTS trg_erp_workspace_limit ON public.erp_workspace_members;
DROP FUNCTION IF EXISTS public.erp_enforce_workspace_limit();

CREATE OR REPLACE FUNCTION public.erp_redeem_workspace_invitation(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  PERFORM pg_advisory_xact_lock(hashtext('erp_invite_redeem'), hashtext(actor::TEXT));

  SELECT count(*) FILTER (WHERE attempted_at > now() - interval '15 minutes'),
         count(*)
  INTO short_failures, daily_failures
  FROM public.erp_invitation_attempts
  WHERE user_id = actor AND NOT succeeded AND attempted_at > now() - interval '24 hours';
  IF short_failures >= 5 OR daily_failures >= 20 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;

  normalized := public.erp_normalize_access_code(p_code);
  IF length(normalized) = 20 THEN
    SELECT * INTO invitation
    FROM public.erp_workspace_invitations
    WHERE code_hash = public.erp_hash_access_code(normalized)
    FOR UPDATE;
  END IF;

  IF invitation.id IS NOT NULL THEN
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
$$;

DROP FUNCTION IF EXISTS public.erp_my_workspace_quota();
DROP FUNCTION IF EXISTS public.erp__active_workspace_count(UUID);
DROP FUNCTION IF EXISTS public.erp_workspace_limit();

DROP FUNCTION IF EXISTS public.erp_document_delete(UUID);
DROP FUNCTION IF EXISTS public.erp_document_register(UUID, TEXT, TEXT, BIGINT, TEXT);
DROP FUNCTION IF EXISTS public.erp_document_get(UUID);
DROP FUNCTION IF EXISTS public.erp_documents_list(UUID);
DROP FUNCTION IF EXISTS public.erp__require_document_access(UUID);
DROP TABLE IF EXISTS public.erp_documents;

COMMIT;
