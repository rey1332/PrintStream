-- Rollback for 20261012000032_platform_governance.sql.
-- Run only after redeploying an app version from before this change.
--
-- Live staff sessions end; security officers become auditors; retention
-- choices, legal holds and termination records are removed (the security
-- log keeps their entries). Suspensions made by a termination stay: lift
-- them in /admin if the company should be usable again.

BEGIN;

UPDATE etna_platform.admins SET role = 'auditor', updated_at = now() WHERE role = 'security_officer';
ALTER TABLE etna_platform.admins DROP CONSTRAINT IF EXISTS admins_role_check;
ALTER TABLE etna_platform.admins ADD CONSTRAINT admins_role_check CHECK (role IN ('super_admin', 'support', 'auditor'));

DROP FUNCTION IF EXISTS public.erp_my_termination(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_workspace_termination(UUID);
DROP FUNCTION IF EXISTS etna_platform.run_workspace_deletion(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_confirm_termination(UUID, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_cancel_termination(UUID, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_terminate_workspace(UUID, TEXT, INTEGER);
DROP FUNCTION IF EXISTS etna_platform.purge_by_retention();
DROP FUNCTION IF EXISTS etna_platform.admin_legal_holds(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_release_legal_hold(UUID, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_set_legal_hold(UUID, TEXT, DATE);
DROP FUNCTION IF EXISTS public.erp_set_workspace_retention(UUID, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.erp_workspace_retention(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_set_retention_policy(TEXT, INTEGER, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS etna_platform.admin_retention_policies();
DROP FUNCTION IF EXISTS etna_platform.on_legal_hold(UUID);
DROP FUNCTION IF EXISTS etna_platform.effective_retention_days(UUID, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_staff_access_sessions(UUID, INTEGER);
DROP FUNCTION IF EXISTS etna_platform.admin_end_staff_access(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_start_staff_access(UUID, TEXT, TEXT, INTEGER);

-- As before this migration: etna_platform._require_admin(text[],boolean)
CREATE OR REPLACE FUNCTION etna_platform._require_admin(p_roles text[], p_fresh boolean)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'etna_platform', 'auth', 'pg_temp'
AS $function$
DECLARE
  caller UUID := auth.uid();
  caller_role TEXT;
  current_sid UUID := NULLIF(auth.jwt() ->> 'sid', '')::uuid;
BEGIN
  caller_role := etna_platform._role_of(caller);
  IF caller IS NULL OR caller_role IS NULL OR NOT caller_role = ANY(p_roles) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501', HINT = 'not_admin';
  END IF;
  IF COALESCE(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  IF p_fresh AND NOT EXISTS (
    SELECT 1 FROM auth.sessions s
     WHERE s.id = current_sid AND s.user_id = caller AND s.revoked_at IS NULL
       AND s.reauthenticated_at > now() - interval '10 minutes'
  ) THEN
    RAISE EXCEPTION 'Confirm with a two-factor code first' USING ERRCODE = '42501', HINT = 'reauth_required';
  END IF;
  RETURN caller_role;
END;
$function$;

-- As before this migration: etna_platform.admin_set_role(text,text)
CREATE OR REPLACE FUNCTION etna_platform.admin_set_role(p_email text, p_role text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'etna_platform', 'auth', 'pg_temp'
AS $function$
DECLARE
  caller UUID := auth.uid();
  target UUID;
  target_address TEXT;
  previous TEXT;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin'], true);
  IF p_role IS NULL OR p_role NOT IN ('super_admin', 'support', 'auditor') THEN
    RAISE EXCEPTION 'Unknown admin role' USING ERRCODE = '22023';
  END IF;
  SELECT u.id, u.email INTO target, target_address FROM auth.users u WHERE lower(u.email) = lower(trim(COALESCE(p_email, '')));
  IF target IS NULL THEN
    RAISE EXCEPTION 'No account for that e-mail address' USING ERRCODE = 'P0002';
  END IF;
  -- Nobody changes their own role, so a super admin always remains.
  IF target = caller THEN
    RAISE EXCEPTION 'You cannot change your own admin role' USING ERRCODE = 'P0001', HINT = 'self';
  END IF;
  SELECT a.role INTO previous FROM etna_platform.admins a WHERE a.user_id = target FOR UPDATE;
  IF previous IS NOT DISTINCT FROM p_role THEN
    RETURN p_role;
  END IF;
  INSERT INTO etna_platform.admins (user_id, role, granted_by)
  VALUES (target, p_role, caller)
  ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = now();
  PERFORM etna_platform._log(
    CASE WHEN previous IS NULL THEN 'ADMIN_ROLE_GRANTED' ELSE 'ADMIN_ROLE_CHANGED' END,
    'success', 'admin', target, target_address, NULL,
    jsonb_build_object('role', p_role, 'previous_role', previous)
  );
  RETURN p_role;
END;
$function$;

-- As before this migration: etna_admin.grant_platform_admin(text,text)
CREATE OR REPLACE FUNCTION etna_admin.grant_platform_admin(p_email text, p_role text DEFAULT 'super_admin'::text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'auth', 'pg_temp'
AS $function$
DECLARE
  target UUID := etna_admin._user_id(p_email);
  previous TEXT;
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('super_admin', 'support', 'auditor') THEN
    RAISE EXCEPTION 'Role must be super_admin, support or auditor' USING ERRCODE = '22023';
  END IF;
  SELECT a.role INTO previous FROM etna_platform.admins a WHERE a.user_id = target FOR UPDATE;
  IF previous IS NOT DISTINCT FROM p_role THEN
    RETURN p_role;
  END IF;
  INSERT INTO etna_platform.admins (user_id, role, granted_by)
  VALUES (target, p_role, NULL)
  ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = NULL, updated_at = now();
  PERFORM etna_admin._log(CASE WHEN previous IS NULL THEN 'ADMIN_ROLE_GRANTED' ELSE 'ADMIN_ROLE_CHANGED' END,
    target, jsonb_build_object('role', p_role, 'previous_role', previous));
  RETURN p_role;
END;
$function$;

-- As before this migration: public.erp_workspace_role(uuid)
CREATE OR REPLACE FUNCTION public.erp_workspace_role(p_workspace_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT m.role
  FROM public.erp_workspace_members m
  WHERE m.workspace_id = p_workspace_id
    AND m.user_id = auth.uid()
    AND m.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM etna_platform.workspace_suspensions s
       WHERE s.workspace_id = p_workspace_id AND s.lifted_at IS NULL
    );
$function$;

-- As before this migration: public.erp_my_workspaces()
CREATE OR REPLACE FUNCTION public.erp_my_workspaces()
 RETURNS TABLE(workspace_id uuid, name text, role text, is_owner boolean, is_personal boolean, owner_id uuid, owner_email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  PERFORM public.erp_personal_workspace_id(auth.uid());
  RETURN QUERY
  SELECT w.id, w.name, m.role,
         m.role = 'owner',
         w.is_personal AND w.owner_id = auth.uid(),
         -- Rows are written on behalf of this account (the app's writeOwner).
         w.owner_id,
         COALESCE(creator.email, owner_profile.email)
  FROM public.erp_workspace_members m
  JOIN public.erp_workspaces w ON w.id = m.workspace_id
  LEFT JOIN public.user_profiles owner_profile ON owner_profile.id = w.owner_id
  LEFT JOIN public.user_profiles creator ON creator.id = w.created_by
  WHERE m.user_id = auth.uid() AND m.status = 'active'
  ORDER BY (w.owner_id = auth.uid()) DESC, (m.role = 'owner') DESC, w.name;
END;
$function$;

-- As in 20261012000030_workspace_custom_roles.sql
CREATE OR REPLACE FUNCTION public.erp__staff_session_until(p_workspace_id UUID)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NULL::TIMESTAMPTZ;
$$;

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

DROP TABLE IF EXISTS etna_platform.workspace_terminations;
DROP TABLE IF EXISTS etna_platform.legal_holds;
DROP TABLE IF EXISTS etna_platform.workspace_retention;
DROP TABLE IF EXISTS etna_platform.retention_policies;
DROP TABLE IF EXISTS etna_platform.staff_access_sessions;

COMMIT;
