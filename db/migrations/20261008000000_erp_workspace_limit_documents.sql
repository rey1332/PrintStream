-- ERP limit per account and workspace documents.
--
-- 1. An account can belong to at most three ERPs (workspaces), counting every
--    active membership: its own personal ERP and the ERPs it joined by
--    invitation. Redeeming an invitation past the limit is refused, and a
--    trigger on the membership table enforces the same rule for any other
--    path. Existing memberships above the limit are kept; only new ones are
--    refused. Owner memberships are not limited here (personal workspaces are
--    created automatically; creating more ERPs is a later change).
--
-- 2. Documents: files uploaded to a workspace. The bytes live on the server's
--    disk (src/server/documents/storage.ts); this table holds the metadata.
--    Clients have no table privileges: they list and read through functions
--    that check membership, and only the server's upload and delete routes may
--    register or remove a document (the functions check request.path, which
--    /api/data always sets to /rpc/<function> and cannot spoof).

-- ─── 1. ERP limit ────────────────────────────────────────────────────────────
-- Keep in sync with MAX_ERPS_PER_ACCOUNT in src/lib/workspaces/limits.ts.

CREATE OR REPLACE FUNCTION public.erp_workspace_limit()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 3 $$;

-- Active memberships of an account (personal ERP included).
CREATE OR REPLACE FUNCTION public.erp__active_workspace_count(p_user_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::INTEGER
  FROM public.erp_workspace_members m
  WHERE m.user_id = p_user_id AND m.status = 'active';
$$;

REVOKE ALL ON FUNCTION public.erp__active_workspace_count(UUID) FROM PUBLIC, anon, authenticated;

-- How many ERPs the signed-in account uses and may use.
CREATE OR REPLACE FUNCTION public.erp_my_workspace_quota()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE used INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  used := public.erp__active_workspace_count(auth.uid());
  RETURN jsonb_build_object('used', used, 'limit', public.erp_workspace_limit(),
                            'can_join', used < public.erp_workspace_limit());
END;
$$;

REVOKE ALL ON FUNCTION public.erp_my_workspace_quota() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_my_workspace_quota() TO authenticated;

-- Backstop for every path that activates a membership.
CREATE OR REPLACE FUNCTION public.erp_enforce_workspace_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'active' OR NEW.role = 'owner' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' THEN RETURN NEW; END IF;

  -- Same lock as invitation redemption: parallel joins are counted one by one.
  PERFORM pg_advisory_xact_lock(hashtext('erp_invite_redeem'), hashtext(NEW.user_id::TEXT));
  IF (SELECT count(*) FROM public.erp_workspace_members m
      WHERE m.user_id = NEW.user_id AND m.status = 'active' AND m.workspace_id <> NEW.workspace_id)
     >= public.erp_workspace_limit() THEN
    RAISE EXCEPTION 'This account already belongs to the maximum of % ERPs.', public.erp_workspace_limit()
      USING ERRCODE = 'P0001', HINT = 'workspace_limit';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_enforce_workspace_limit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_erp_workspace_limit ON public.erp_workspace_members;
CREATE TRIGGER trg_erp_workspace_limit
  BEFORE INSERT OR UPDATE OF status, role ON public.erp_workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.erp_enforce_workspace_limit();

-- Same definition as 20260926010000_erp_workspaces.sql, plus the limit check
-- (before the code is looked at, so it reveals nothing about the code and does
-- not count as a failed guess).
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

  IF public.erp__active_workspace_count(actor) >= public.erp_workspace_limit() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'workspace_limit', 'limit', public.erp_workspace_limit());
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
$$;

REVOKE ALL ON FUNCTION public.erp_redeem_workspace_invitation(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_redeem_workspace_invitation(TEXT) TO authenticated;

-- ─── 2. Documents ────────────────────────────────────────────────────────────
-- Size limits; keep in sync with src/lib/workspaces/limits.ts.

CREATE TABLE IF NOT EXISTS public.erp_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  uploaded_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  content_type TEXT NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 120),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_erp_documents_workspace
  ON public.erp_documents(workspace_id, created_at DESC);

ALTER TABLE public.erp_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_documents FROM PUBLIC, anon, authenticated;

-- Members (with the workspace's two-factor rule met) may see documents.
CREATE OR REPLACE FUNCTION public.erp__require_document_access(p_workspace_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE actor_role TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  actor_role := public.erp_workspace_role(p_workspace_id);
  IF actor_role IS NULL OR NOT public.erp_workspace_mfa_ok(p_workspace_id) THEN
    RAISE EXCEPTION 'You are not allowed to open documents in this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN actor_role;
END;
$$;

REVOKE ALL ON FUNCTION public.erp__require_document_access(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.erp_documents_list(p_workspace_id UUID)
RETURNS TABLE (
  id UUID, file_name TEXT, content_type TEXT, size_bytes BIGINT, created_at TIMESTAMPTZ,
  uploaded_by_email TEXT, can_delete BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

-- One document's metadata, for downloading it.
CREATE OR REPLACE FUNCTION public.erp_document_get(p_document_id UUID)
RETURNS TABLE (id UUID, workspace_id UUID, file_name TEXT, content_type TEXT, size_bytes BIGINT, sha256 TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE doc public.erp_documents%ROWTYPE;
BEGIN
  SELECT * INTO doc FROM public.erp_documents d WHERE d.id = p_document_id;
  -- A document the user may not see looks exactly like a missing one.
  IF NOT FOUND OR public.erp_workspace_role(doc.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.erp__require_document_access(doc.workspace_id);
  RETURN QUERY SELECT doc.id, doc.workspace_id, doc.file_name, doc.content_type, doc.size_bytes, doc.sha256;
END;
$$;

-- Registers an uploaded file. Only the server's upload route may call it: it
-- writes the bytes to disk under the returned id in the same transaction.
CREATE OR REPLACE FUNCTION public.erp_document_register(
  p_workspace_id UUID, p_file_name TEXT, p_content_type TEXT, p_size_bytes BIGINT, p_sha256 TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := COALESCE(p_workspace_id, public.erp_personal_workspace_id(auth.uid()));
  used BIGINT;
  doc_id UUID;
BEGIN
  IF current_setting('request.path', true) IS DISTINCT FROM '/documents/upload' THEN
    RAISE EXCEPTION 'Documents are uploaded through the documents page' USING ERRCODE = '42501';
  END IF;
  PERFORM public.erp__require_document_access(ws);

  -- Uploads to one workspace are counted one at a time.
  PERFORM pg_advisory_xact_lock(hashtext('erp_documents'), hashtext(ws::TEXT));
  SELECT COALESCE(sum(d.size_bytes), 0) INTO used FROM public.erp_documents d WHERE d.workspace_id = ws;
  IF used + p_size_bytes > 1073741824 THEN
    RAISE EXCEPTION 'This workspace has no room for more documents (1 GB in total).'
      USING ERRCODE = 'P0001', HINT = 'documents_full';
  END IF;

  INSERT INTO public.erp_documents (workspace_id, uploaded_by, file_name, content_type, size_bytes, sha256)
  VALUES (ws, auth.uid(), p_file_name, p_content_type, p_size_bytes, p_sha256)
  RETURNING id INTO doc_id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'document.uploaded',
          jsonb_build_object('document_id', doc_id, 'file_name', p_file_name, 'size_bytes', p_size_bytes));
  RETURN doc_id;
END;
$$;

-- Removes a document (its uploader, an owner or an admin). Returns the
-- workspace so the server can delete the file after the commit.
CREATE OR REPLACE FUNCTION public.erp_document_delete(p_document_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.erp_documents_list(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_document_get(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_document_register(UUID, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_document_delete(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_documents_list(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_document_get(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_document_register(UUID, TEXT, TEXT, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_document_delete(UUID) TO authenticated;
