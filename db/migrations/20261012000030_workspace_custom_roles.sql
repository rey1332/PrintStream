-- Custom roles per workspace, and the TERMINAL permissions.
--
-- 1. Permissions: the ERP list stays as it is; TERMINAL and workspace
--    permissions are added (erp_all_permissions). The five built-in roles stay
--    as presets (erp_role_permissions) and get TERMINAL defaults.
-- 2. erp_custom_roles: a named set of permissions per workspace. A member has
--    either a built-in role, or role = 'custom' with custom_role_id.
-- 3. erp_member_permissions(workspace): the caller's effective permissions.
--    erp_has_permission, erp_can_read, the member manager check and the
--    document functions use it, so every existing check (row-level policies
--    and ERP functions) also works for custom roles.
-- 4. Nobody gives more than they hold (erp__can_grant): an inviter or role
--    editor may only hand out permissions they have themselves; only the Owner
--    makes Admins; nobody is made Owner.
-- 5. Custom roles need two-factor in ERPs other people use, unless the role
--    has none of the sensitive permissions and the Owner turned it off.
-- 6. Managing roles needs 'roles.manage' (Owner by default) and a two-factor
--    session; every change is in the workspace activity.
--
-- Rollback: db/rollback/rollback_20261012000030_workspace_custom_roles.sql

-- ─── 1. Permissions ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_all_permissions()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    -- ERP (unchanged)
    'read','customers','suppliers','products','inventory','sales','invoicing','fulfillment',
    'purchasing','receiving','payments','members','audit',
    -- Workspace
    'roles.manage','policies.manage','storage.view',
    -- Integrations
    'integrations.manage','integrations.use',
    -- Datasets
    'datasets.view','datasets.query','datasets.import','datasets.edit','datasets.schema',
    'datasets.export','datasets.share','datasets.delete','data.sensitive',
    -- Pipelines
    'pipelines.view','pipelines.create','pipelines.edit','pipelines.run','pipelines.schedule',
    'pipelines.publish','pipelines.disable','pipelines.delete',
    -- Approvals
    'approvals.decide'
  ]::TEXT[];
$$;

-- Permissions that make a role need two-factor (as Owner, Admin and Finance today).
CREATE OR REPLACE FUNCTION public.erp_sensitive_permissions()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY['read','invoicing','payments','members','audit','roles.manage','policies.manage',
               'integrations.manage','datasets.export','data.sensitive','approvals.decide']::TEXT[];
$$;

CREATE OR REPLACE FUNCTION public.erp_role_permissions(p_role TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_role
    -- Literal lists (tests/unit/erpRules.test.mjs compares them with the app).
    WHEN 'owner' THEN ARRAY['read','customers','suppliers','products','inventory','sales','invoicing','fulfillment','purchasing','receiving','payments','members','audit',
                            'roles.manage','policies.manage','storage.view','integrations.manage','integrations.use','datasets.view','datasets.query','datasets.import','datasets.edit','datasets.schema','datasets.export','datasets.share','datasets.delete','data.sensitive','pipelines.view','pipelines.create','pipelines.edit','pipelines.run','pipelines.schedule','pipelines.publish','pipelines.disable','pipelines.delete','approvals.decide']
    WHEN 'admin' THEN ARRAY['read','customers','suppliers','products','inventory','sales','invoicing','fulfillment','purchasing','receiving','payments','members','audit',
                            'policies.manage','storage.view','integrations.manage','integrations.use','datasets.view','datasets.query','datasets.import','datasets.edit','datasets.schema','datasets.export','datasets.share','datasets.delete','pipelines.view','pipelines.create','pipelines.edit','pipelines.run','pipelines.schedule','pipelines.publish','pipelines.disable','pipelines.delete','approvals.decide']
    WHEN 'finance' THEN ARRAY['read','invoicing','payments','storage.view','integrations.use',
                              'datasets.view','datasets.query','datasets.import','datasets.edit','datasets.schema','datasets.export',
                              'pipelines.view','pipelines.create','pipelines.edit','pipelines.run']
    WHEN 'sales' THEN ARRAY['customers','sales','invoicing']
    WHEN 'inventory' THEN ARRAY['suppliers','products','inventory','fulfillment','purchasing','receiving']
    ELSE ARRAY[]::TEXT[]
  END;
$$;

-- ─── 2. Custom roles ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.erp_custom_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  permissions TEXT[] NOT NULL DEFAULT '{}' CHECK (permissions <@ public.erp_all_permissions()),
  requires_mfa BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (requires_mfa OR NOT (permissions && public.erp_sensitive_permissions()))
);
CREATE UNIQUE INDEX IF NOT EXISTS erp_custom_roles_name_key ON public.erp_custom_roles (workspace_id, lower(btrim(name)));

ALTER TABLE public.erp_custom_roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_custom_roles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_custom_roles TO authenticated;
DROP POLICY IF EXISTS erp_custom_roles_members_read ON public.erp_custom_roles;
CREATE POLICY erp_custom_roles_members_read ON public.erp_custom_roles FOR SELECT TO authenticated
  USING (public.erp_workspace_role(workspace_id) IS NOT NULL);
DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.erp_custom_roles;
CREATE POLICY erp_workspace_not_suspended ON public.erp_custom_roles AS RESTRICTIVE FOR ALL TO authenticated
  USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]));

ALTER TABLE public.erp_workspace_members
  ADD COLUMN IF NOT EXISTS custom_role_id UUID REFERENCES public.erp_custom_roles(id) ON DELETE RESTRICT;
ALTER TABLE public.erp_workspace_members DROP CONSTRAINT IF EXISTS erp_workspace_members_role_check;
ALTER TABLE public.erp_workspace_members ADD CONSTRAINT erp_workspace_members_role_check CHECK (
  role IN ('owner', 'admin', 'finance', 'sales', 'inventory', 'custom') OR (role = 'viewer' AND status = 'removed'));
ALTER TABLE public.erp_workspace_members DROP CONSTRAINT IF EXISTS erp_workspace_members_custom_role_check;
ALTER TABLE public.erp_workspace_members ADD CONSTRAINT erp_workspace_members_custom_role_check
  CHECK ((role = 'custom') = (custom_role_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_erp_workspace_members_custom_role ON public.erp_workspace_members (custom_role_id) WHERE custom_role_id IS NOT NULL;

ALTER TABLE public.erp_workspace_invitations
  ADD COLUMN IF NOT EXISTS custom_role_id UUID REFERENCES public.erp_custom_roles(id) ON DELETE CASCADE;
ALTER TABLE public.erp_workspace_invitations DROP CONSTRAINT IF EXISTS erp_workspace_invitations_role_check;
ALTER TABLE public.erp_workspace_invitations ADD CONSTRAINT erp_workspace_invitations_role_check CHECK (
  role IN ('admin', 'finance', 'sales', 'inventory', 'custom')
  OR (role = 'viewer' AND (redeemed_at IS NOT NULL OR revoked_at IS NOT NULL)));
ALTER TABLE public.erp_workspace_invitations DROP CONSTRAINT IF EXISTS erp_workspace_invitations_custom_role_check;
ALTER TABLE public.erp_workspace_invitations ADD CONSTRAINT erp_workspace_invitations_custom_role_check
  CHECK ((role = 'custom') = (custom_role_id IS NOT NULL));

-- ─── 3. Effective permissions ────────────────────────────────────────────────

-- The permissions of a role (built-in, or a custom role by id).
CREATE OR REPLACE FUNCTION public.erp__role_set(p_role TEXT, p_custom_role_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN p_role = 'custom'
    THEN COALESCE((SELECT r.permissions FROM public.erp_custom_roles r WHERE r.id = p_custom_role_id), ARRAY[]::TEXT[])
    ELSE public.erp_role_permissions(p_role) END;
$$;

-- Any account's permissions in a workspace (empty when not an active member).
CREATE OR REPLACE FUNCTION public.erp__member_permissions_of(p_workspace_id UUID, p_user_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT public.erp__role_set(m.role, m.custom_role_id)
      FROM public.erp_workspace_members m
     WHERE m.workspace_id = p_workspace_id AND m.user_id = p_user_id AND m.status = 'active'), ARRAY[]::TEXT[]);
$$;

-- The caller's permissions in a workspace (empty when not a member or suspended).
CREATE OR REPLACE FUNCTION public.erp_member_permissions(p_workspace_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN r IS NULL THEN ARRAY[]::TEXT[]
              WHEN r = 'custom' THEN public.erp__member_permissions_of(p_workspace_id, auth.uid())
              ELSE public.erp_role_permissions(r) END
    FROM public.erp_workspace_role(p_workspace_id) AS r;
$$;

CREATE OR REPLACE FUNCTION public.erp_has_permission(p_workspace_id UUID, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(p_permission = ANY(public.erp_member_permissions(p_workspace_id)), false)
     AND public.erp_workspace_mfa_ok(p_workspace_id);
$$;

CREATE OR REPLACE FUNCTION public.erp_can_read(p_workspace_id UUID, p_area TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.erp_member_permissions(p_workspace_id) && public.erp_read_grants(p_area), false)
     AND public.erp_workspace_mfa_ok(p_workspace_id);
$$;

CREATE OR REPLACE FUNCTION public.erp__require_member_manager(p_workspace_id UUID)
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
  IF actor_role IS NULL OR NOT ('members' = ANY(public.erp_member_permissions(p_workspace_id))) THEN
    RAISE EXCEPTION 'You are not allowed to manage members of this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN actor_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp__role_needs_mfa(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT (public.erp_workspace_role(w.id) IN ('owner', 'admin', 'finance')
            OR (public.erp_workspace_role(w.id) = 'custom' AND EXISTS (
                  SELECT 1 FROM public.erp_workspace_members m JOIN public.erp_custom_roles r ON r.id = m.custom_role_id
                   WHERE m.workspace_id = w.id AND m.user_id = auth.uid() AND m.status = 'active' AND r.requires_mfa)))
           -- Not the caller's own personal ERP (a created ERP belongs to an internal owner).
           AND (NOT (w.is_personal AND w.owner_id = auth.uid()) OR EXISTS (
             SELECT 1 FROM public.erp_workspace_members m
              WHERE m.workspace_id = w.id AND m.status = 'active' AND m.user_id <> auth.uid()))
      FROM public.erp_workspaces w WHERE w.id = p_workspace_id), false);
$$;

-- The document functions read the actor's role permissions; they now read the
-- effective ones (patched in place, the rest of each function unchanged).
DO $$
DECLARE
  patches TEXT[][] := ARRAY[
    ['public.erp_documents_list(uuid)', 'public.erp_role_permissions(actor_role)', 'public.erp_member_permissions(ws)'],
    ['public.erp_document_delete(uuid)', 'public.erp_role_permissions(actor_role)', 'public.erp_member_permissions(doc.workspace_id)']
  ];
  i INTEGER;
  body TEXT;
BEGIN
  FOR i IN 1 .. array_length(patches, 1) LOOP
    body := pg_get_functiondef(patches[i][1]::regprocedure);
    CONTINUE WHEN position(patches[i][3] IN body) > 0;
    IF position(patches[i][2] IN body) = 0 THEN
      RAISE EXCEPTION 'Cannot patch %: expected text not found', patches[i][1];
    END IF;
    EXECUTE replace(body, patches[i][2], patches[i][3]);
  END LOOP;
END;
$$;

-- ─── 4. Granting without escalation ──────────────────────────────────────────

-- Whether an account may give a role (built-in or custom) in a workspace.
CREATE OR REPLACE FUNCTION public.erp__can_grant(p_actor UUID, p_workspace_id UUID, p_role TEXT, p_custom_role_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH actor AS (
    SELECT m.role, public.erp__role_set(m.role, m.custom_role_id) AS perms
      FROM public.erp_workspace_members m
     WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor AND m.status = 'active'
  )
  SELECT COALESCE((
    SELECT 'members' = ANY(a.perms)
       AND p_role IS NOT NULL AND p_role <> 'owner'
       AND (p_role <> 'admin' OR a.role = 'owner')
       AND (p_role <> 'custom' OR EXISTS (SELECT 1 FROM public.erp_custom_roles r WHERE r.id = p_custom_role_id AND r.workspace_id = p_workspace_id))
       AND (p_role IN ('admin', 'finance', 'sales', 'inventory', 'custom'))
       AND (a.role = 'owner' OR public.erp__role_set(p_role, p_custom_role_id) <@ a.perms)
      FROM actor a), false);
$$;

-- Kept for the app: the built-in roles the caller may give.
CREATE OR REPLACE FUNCTION public.erp_my_grantable_roles(p_workspace_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ARRAY(SELECT r FROM unnest(ARRAY['admin','finance','sales','inventory']) r
                WHERE public.erp__can_grant(auth.uid(), p_workspace_id, r, NULL));
$$;

-- New versions (_v2) take a custom role; the old signatures stay and pass
-- through, so older migrations can be re-applied safely.
CREATE OR REPLACE FUNCTION public.erp_create_workspace_invitation_v2(
  p_workspace_id UUID, p_role TEXT, p_expires_in_hours INTEGER, p_label TEXT, p_custom_role_id UUID)
RETURNS TABLE (invitation_id UUID, access_code TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor UUID := auth.uid();
  alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  random_bytes BYTEA;
  code TEXT := '';
  idx INTEGER;
  new_id UUID;
  new_expiry TIMESTAMPTZ;
  pending_count INTEGER;
  clean_label TEXT := left(trim(COALESCE(p_label, '')), 120);
  custom_id UUID := CASE WHEN p_role = 'custom' THEN p_custom_role_id END;
BEGIN
  PERFORM public.erp__require_member_manager(p_workspace_id);
  IF NOT public.erp__can_grant(actor, p_workspace_id, p_role, custom_id) THEN
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
  INSERT INTO public.erp_workspace_invitations (workspace_id, code_hash, role, custom_role_id, label, created_by, expires_at)
  VALUES (p_workspace_id, public.erp_hash_access_code(code), p_role, custom_id, clean_label, actor, new_expiry)
  RETURNING id INTO new_id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, invitation_id, details)
  VALUES (p_workspace_id, actor, 'invitation.created', new_id,
          jsonb_strip_nulls(jsonb_build_object('role', p_role, 'custom_role_id', custom_id, 'expires_at', new_expiry, 'label', clean_label)));

  RETURN QUERY SELECT new_id,
    'ETNA-' || substr(code, 1, 5) || '-' || substr(code, 6, 5) || '-' || substr(code, 11, 5) || '-' || substr(code, 16, 5),
    new_expiry;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_create_workspace_invitation(
  p_workspace_id UUID, p_role TEXT, p_expires_in_hours INTEGER DEFAULT 72, p_label TEXT DEFAULT '')
RETURNS TABLE (invitation_id UUID, access_code TEXT, expires_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.erp_create_workspace_invitation_v2(p_workspace_id, p_role, p_expires_in_hours, p_label, NULL);
$$;

CREATE OR REPLACE FUNCTION public.erp_update_workspace_member_role_v2(
  p_workspace_id UUID, p_user_id UUID, p_role TEXT, p_reason TEXT, p_custom_role_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.erp_workspace_members%ROWTYPE;
  custom_id UUID := CASE WHEN p_role = 'custom' THEN p_custom_role_id END;
BEGIN
  PERFORM public.erp__require_member_manager(p_workspace_id);
  IF p_user_id = auth.uid() THEN RAISE EXCEPTION 'You cannot change your own role' USING ERRCODE = '42501'; END IF;
  SELECT * INTO target FROM public.erp_workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found'; END IF;
  -- Both the member's current role and the new one must be within the caller's reach.
  IF NOT public.erp__can_grant(auth.uid(), p_workspace_id, target.role, target.custom_role_id)
     OR NOT public.erp__can_grant(auth.uid(), p_workspace_id, p_role, custom_id) THEN
    RAISE EXCEPTION 'You cannot assign this role' USING ERRCODE = '42501';
  END IF;
  IF target.role = p_role AND target.custom_role_id IS NOT DISTINCT FROM custom_id THEN RETURN; END IF;

  UPDATE public.erp_workspace_members SET role = p_role, custom_role_id = custom_id, updated_at = now()
  WHERE workspace_id = p_workspace_id AND user_id = p_user_id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
  VALUES (p_workspace_id, auth.uid(), 'member.role_changed', p_user_id,
          jsonb_strip_nulls(jsonb_build_object('from', target.role, 'to', p_role,
            'from_custom_role_id', target.custom_role_id, 'to_custom_role_id', custom_id,
            'reason', left(trim(COALESCE(p_reason, '')), 500))));
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_update_workspace_member_role(
  p_workspace_id UUID, p_user_id UUID, p_role TEXT, p_reason TEXT DEFAULT '')
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.erp_update_workspace_member_role_v2(p_workspace_id, p_user_id, p_role, p_reason, NULL);
$$;

CREATE OR REPLACE FUNCTION public.erp_remove_workspace_member(p_workspace_id UUID, p_user_id UUID, p_reason TEXT DEFAULT '')
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.erp_workspace_members%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO target FROM public.erp_workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found'; END IF;
  IF target.role = 'owner' THEN RAISE EXCEPTION 'The workspace owner cannot be removed' USING ERRCODE = '42501'; END IF;

  IF p_user_id <> auth.uid() THEN
    PERFORM public.erp__require_member_manager(p_workspace_id);
    IF NOT public.erp__can_grant(auth.uid(), p_workspace_id, target.role, target.custom_role_id) THEN
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
$$;

-- Redeeming: the inviter must still be allowed to give the role, and a custom
-- role carries over (patched in place).
DO $$
DECLARE
  body TEXT := pg_get_functiondef('public.erp_redeem_workspace_invitation(text)'::regprocedure);
BEGIN
  IF position('erp__can_grant' IN body) > 0 THEN RETURN; END IF;
  body := replace(body,
    'OR NOT (invitation.role = ANY(public.erp_grantable_roles(creator_role))) THEN',
    'OR NOT public.erp__can_grant(invitation.created_by, invitation.workspace_id, invitation.role, invitation.custom_role_id) THEN');
  body := replace(body,
    'SET status = ''active'', role = invitation.role, invited_by = invitation.created_by,',
    'SET status = ''active'', role = invitation.role, custom_role_id = invitation.custom_role_id, invited_by = invitation.created_by,');
  body := replace(body,
    'INSERT INTO public.erp_workspace_members (workspace_id, user_id, role, invited_by, invitation_id)
    VALUES (invitation.workspace_id, actor, invitation.role, invitation.created_by, invitation.id);',
    'INSERT INTO public.erp_workspace_members (workspace_id, user_id, role, custom_role_id, invited_by, invitation_id)
    VALUES (invitation.workspace_id, actor, invitation.role, invitation.custom_role_id, invitation.created_by, invitation.id);');
  IF position('erp__can_grant' IN body) = 0 OR position('custom_role_id = invitation.custom_role_id' IN body) = 0
     OR position('invitation.custom_role_id, invitation.created_by, invitation.id' IN body) = 0 THEN
    RAISE EXCEPTION 'Cannot patch erp_redeem_workspace_invitation: expected text not found';
  END IF;
  EXECUTE body;
END;
$$;

-- ─── 5. Managing roles ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp__require_role_manager(p_workspace_id UUID)
RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  perms TEXT[] := public.erp_member_permissions(p_workspace_id);
BEGIN
  IF auth.uid() IS NULL OR NOT ('roles.manage' = ANY(perms)) OR NOT public.erp_workspace_mfa_ok(p_workspace_id) THEN
    RAISE EXCEPTION 'You are not allowed to manage roles of this workspace' USING ERRCODE = '42501';
  END IF;
  IF public.erp_session_aal() <> 'aal2' THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  RETURN perms;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_list_custom_roles(p_workspace_id UUID)
RETURNS TABLE (id UUID, name TEXT, description TEXT, permissions TEXT[], requires_mfa BOOLEAN,
               members INTEGER, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.erp_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id, r.name, r.description, r.permissions, r.requires_mfa,
         (SELECT count(*)::int FROM public.erp_workspace_members m WHERE m.custom_role_id = r.id AND m.status = 'active'),
         r.updated_at
    FROM public.erp_custom_roles r
   WHERE r.workspace_id = p_workspace_id
   ORDER BY lower(r.name);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_save_custom_role(
  p_workspace_id UUID, p_role_id UUID, p_name TEXT, p_description TEXT, p_permissions TEXT[], p_requires_mfa BOOLEAN DEFAULT true)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  mine TEXT[] := public.erp__require_role_manager(p_workspace_id);
  wanted TEXT[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_permissions, '{}')) x ORDER BY x);
  previous public.erp_custom_roles;
  saved UUID;
BEGIN
  IF NOT wanted <@ public.erp_all_permissions() THEN
    RAISE EXCEPTION 'Unknown permission' USING ERRCODE = '22023';
  END IF;
  IF public.erp_workspace_role(p_workspace_id) <> 'owner' AND NOT wanted <@ mine THEN
    RAISE EXCEPTION 'A role cannot have permissions you do not have' USING ERRCODE = '42501', HINT = 'escalation';
  END IF;
  IF NOT COALESCE(p_requires_mfa, true) AND wanted && public.erp_sensitive_permissions() THEN
    RAISE EXCEPTION 'This role needs two-factor because of its permissions' USING ERRCODE = '22023', HINT = 'mfa';
  END IF;
  IF p_role_id IS NULL THEN
    INSERT INTO public.erp_custom_roles (workspace_id, name, description, permissions, requires_mfa, created_by)
    VALUES (p_workspace_id, btrim(p_name), left(btrim(COALESCE(p_description, '')), 300), wanted, COALESCE(p_requires_mfa, true), auth.uid())
    RETURNING id INTO saved;
  ELSE
    SELECT * INTO previous FROM public.erp_custom_roles r WHERE r.id = p_role_id AND r.workspace_id = p_workspace_id FOR UPDATE;
    IF previous.id IS NULL THEN RAISE EXCEPTION 'No such role' USING ERRCODE = 'P0002'; END IF;
    IF public.erp_workspace_role(p_workspace_id) <> 'owner' AND NOT previous.permissions <@ mine THEN
      RAISE EXCEPTION 'You cannot change a role with permissions you do not have' USING ERRCODE = '42501', HINT = 'escalation';
    END IF;
    UPDATE public.erp_custom_roles
       SET name = btrim(p_name), description = left(btrim(COALESCE(p_description, '')), 300),
           permissions = wanted, requires_mfa = COALESCE(p_requires_mfa, true), updated_at = now()
     WHERE id = p_role_id
    RETURNING id INTO saved;
  END IF;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (p_workspace_id, auth.uid(), CASE WHEN p_role_id IS NULL THEN 'role.created' ELSE 'role.changed' END,
          jsonb_strip_nulls(jsonb_build_object('role_id', saved, 'name', btrim(p_name), 'permissions', to_jsonb(wanted),
                                               'previous_permissions', to_jsonb(previous.permissions), 'requires_mfa', COALESCE(p_requires_mfa, true))));
  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_delete_custom_role(p_workspace_id UUID, p_role_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  mine TEXT[] := public.erp__require_role_manager(p_workspace_id);
  doomed public.erp_custom_roles;
BEGIN
  SELECT * INTO doomed FROM public.erp_custom_roles r WHERE r.id = p_role_id AND r.workspace_id = p_workspace_id FOR UPDATE;
  IF doomed.id IS NULL THEN RAISE EXCEPTION 'No such role' USING ERRCODE = 'P0002'; END IF;
  IF public.erp_workspace_role(p_workspace_id) <> 'owner' AND NOT doomed.permissions <@ mine THEN
    RAISE EXCEPTION 'You cannot delete a role with permissions you do not have' USING ERRCODE = '42501', HINT = 'escalation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.erp_workspace_members m WHERE m.custom_role_id = p_role_id AND m.status = 'active') THEN
    RAISE EXCEPTION 'Members still have this role' USING ERRCODE = 'P0001', HINT = 'in_use';
  END IF;
  -- Former members keep their history: their row points at a built-in role marker instead.
  UPDATE public.erp_workspace_members SET role = 'viewer', custom_role_id = NULL
   WHERE custom_role_id = p_role_id AND status = 'removed';
  -- Its invitations stay in the history, closed.
  UPDATE public.erp_workspace_invitations
     SET revoked_at = COALESCE(revoked_at, CASE WHEN redeemed_at IS NULL THEN now() END),
         revoked_by = CASE WHEN revoked_at IS NULL AND redeemed_at IS NULL THEN auth.uid() ELSE revoked_by END,
         revoke_reason = CASE WHEN revoked_at IS NULL AND redeemed_at IS NULL THEN 'Role deleted' ELSE revoke_reason END,
         role = 'viewer', custom_role_id = NULL
   WHERE custom_role_id = p_role_id;
  DELETE FROM public.erp_custom_roles WHERE id = p_role_id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (p_workspace_id, auth.uid(), 'role.deleted', jsonb_build_object('role_id', p_role_id, 'name', doomed.name, 'permissions', to_jsonb(doomed.permissions)));
END;
$$;

-- ─── 6. What the app reads ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_my_permissions(p_workspace_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.erp_member_permissions(p_workspace_id);
$$;

-- When the caller is in a workspace through an ETNA staff access session, until
-- when (filled in by 20261012000032_platform_governance; none before).
CREATE OR REPLACE FUNCTION public.erp__staff_session_until(p_workspace_id UUID)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NULL::TIMESTAMPTZ;
$$;

CREATE OR REPLACE FUNCTION public.erp_my_workspace_access()
RETURNS TABLE (workspace_id UUID, role TEXT, custom_role_id UUID, custom_role_name TEXT, permissions TEXT[], grantable_roles TEXT[],
               staff_session_until TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT m.workspace_id, m.role, m.custom_role_id, r.name,
         public.erp_member_permissions(m.workspace_id),
         public.erp_my_grantable_roles(m.workspace_id),
         NULL::TIMESTAMPTZ
    FROM public.erp_workspace_members m
    LEFT JOIN public.erp_custom_roles r ON r.id = m.custom_role_id
   WHERE m.user_id = auth.uid() AND m.status = 'active';
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_list_workspace_members_v2(p_workspace_id UUID)
RETURNS TABLE (user_id UUID, email TEXT, full_name TEXT, role TEXT, joined_at TIMESTAMPTZ, is_owner BOOLEAN,
               custom_role_id UUID, custom_role_name TEXT, can_manage BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.erp_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT m.user_id, p.email, p.full_name, m.role, m.joined_at, m.role = 'owner',
         m.custom_role_id, r.name,
         m.user_id <> auth.uid() AND public.erp__can_grant(auth.uid(), p_workspace_id, m.role, m.custom_role_id)
  FROM public.erp_workspace_members m
  JOIN public.user_profiles p ON p.id = m.user_id
  LEFT JOIN public.erp_custom_roles r ON r.id = m.custom_role_id
  WHERE m.workspace_id = p_workspace_id AND m.status = 'active'
  ORDER BY (m.role = 'owner') DESC, m.joined_at;
END;
$$;

-- ─── 7. Privileges ───────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.erp__role_set(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__member_permissions_of(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__can_grant(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__require_role_manager(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__staff_session_until(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_member_permissions(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_my_permissions(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_my_grantable_roles(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_my_workspace_access() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_list_custom_roles(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_save_custom_role(UUID, UUID, TEXT, TEXT, TEXT[], BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_delete_custom_role(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_create_workspace_invitation_v2(UUID, TEXT, INTEGER, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_update_workspace_member_role_v2(UUID, UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_list_workspace_members_v2(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_my_permissions(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_my_grantable_roles(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_my_workspace_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_list_custom_roles(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_save_custom_role(UUID, UUID, TEXT, TEXT, TEXT[], BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_delete_custom_role(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_workspace_invitation_v2(UUID, TEXT, INTEGER, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_update_workspace_member_role_v2(UUID, UUID, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_list_workspace_members_v2(UUID) TO authenticated;
