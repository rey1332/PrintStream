-- Platform governance: security officer, staff access sessions, retention
-- bounds and legal holds, termination of a client company.
--
-- 1. security_officer: a platform role that reads everything an auditor
--    reads, sets retention bounds and legal holds and confirms the deletion
--    of a terminated company. It never opens customer data.
-- 2. Staff access sessions: a super admin opens one workspace for at most
--    8 hours with a reason, a ticket reference and a fresh two-factor code,
--    with no one else's approval. Meanwhile erp_workspace_role() gives them
--    the Owner's rights there (decision R-24). Start and end are in the
--    security log and in the workspace's own activity ("by ETNA staff");
--    the app e-mails the Owner. Sessions end by themselves.
-- 3. Retention: per log type ETNA sets minimum, maximum and default days;
--    a workspace may choose within the bounds (policies.manage, two-factor).
--    Legal holds (security officer) stop every purge of a workspace.
--    etna_platform.purge_by_retention() deletes what is past retention; the
--    worker runs it nightly and the purge is logged.
-- 4. Termination: super admin starts it (the workspace is suspended, the
--    Owner may download an export for 30 days); the security officer
--    confirms deletion after the grace period; the deletion removes the
--    company's records (not its audit trails, which follow retention) and
--    keeps a deletion record. Only companies (ERPs with an internal owner),
--    never a person's own ERP.
--
-- Rollback: db/rollback/rollback_20261012000032_platform_governance.sql

-- ─── 1. Security officer ─────────────────────────────────────────────────────

ALTER TABLE etna_platform.admins DROP CONSTRAINT IF EXISTS admins_role_check;
ALTER TABLE etna_platform.admins ADD CONSTRAINT admins_role_check
  CHECK (role IN ('super_admin', 'support', 'auditor', 'security_officer'));

-- A security officer may read whatever an auditor may read.
CREATE OR REPLACE FUNCTION etna_platform._require_admin(p_roles TEXT[], p_fresh BOOLEAN)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  caller UUID := auth.uid();
  caller_role TEXT;
  current_sid UUID := NULLIF(auth.jwt() ->> 'sid', '')::uuid;
BEGIN
  caller_role := etna_platform._role_of(caller);
  IF caller IS NULL OR caller_role IS NULL
     OR NOT (caller_role = ANY(p_roles) OR (caller_role = 'security_officer' AND 'auditor' = ANY(p_roles))) THEN
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
$$;

-- The role lists in the admin and command-line functions (patched in place).
DO $$
DECLARE
  patches TEXT[][] := ARRAY[
    ['etna_platform.admin_set_role(text,text)',
     'p_role NOT IN (''super_admin'', ''support'', ''auditor'')',
     'p_role NOT IN (''super_admin'', ''support'', ''auditor'', ''security_officer'')'],
    ['etna_admin.grant_platform_admin(text,text)',
     'p_role NOT IN (''super_admin'', ''support'', ''auditor'')',
     'p_role NOT IN (''super_admin'', ''support'', ''auditor'', ''security_officer'')']
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

-- ─── 2. Staff access sessions ────────────────────────────────────────────────

-- No foreign keys: the history stays whatever happens to accounts or ERPs.
CREATE TABLE IF NOT EXISTS etna_platform.staff_access_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500),
  ticket_ref TEXT NOT NULL CHECK (char_length(btrim(ticket_ref)) BETWEEN 1 AND 100),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  ended_by UUID,
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '8 hours')
);
CREATE INDEX IF NOT EXISTS staff_access_sessions_live_idx
  ON etna_platform.staff_access_sessions (admin_id, workspace_id, ends_at) WHERE ended_at IS NULL;
REVOKE ALL ON etna_platform.staff_access_sessions FROM PUBLIC, anon, authenticated;

-- The caller's live staff session in a workspace: its end, or NULL.
CREATE OR REPLACE FUNCTION public.erp__staff_session_until(p_workspace_id UUID)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
  SELECT max(s.ends_at) FROM etna_platform.staff_access_sessions s
   WHERE s.admin_id = auth.uid() AND s.workspace_id = p_workspace_id
     AND s.ended_at IS NULL AND s.ends_at > now() AND s.starts_at <= now()
     AND etna_platform._role_of(auth.uid()) = 'super_admin';
$$;

-- As in 20261012000012, plus: during a staff session the admin has the Owner's role.
CREATE OR REPLACE FUNCTION public.erp_workspace_role(p_workspace_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT m.role
       FROM public.erp_workspace_members m
      WHERE m.workspace_id = p_workspace_id AND m.user_id = auth.uid() AND m.status = 'active'),
    CASE WHEN public.erp__staff_session_until(p_workspace_id) IS NOT NULL THEN 'owner' END)
  WHERE NOT EXISTS (
    SELECT 1 FROM etna_platform.workspace_suspensions s
     WHERE s.workspace_id = p_workspace_id AND s.lifted_at IS NULL);
$$;

-- A staff session counts as the Owner when giving roles.
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
    UNION ALL
    SELECT 'owner', public.erp_role_permissions('owner')
     WHERE p_actor = auth.uid() AND public.erp__staff_session_until(p_workspace_id) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.erp_workspace_members m
                        WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor AND m.status = 'active')
  )
  SELECT COALESCE((
    SELECT 'members' = ANY(a.perms)
       AND p_role IS NOT NULL AND p_role <> 'owner'
       AND (p_role <> 'admin' OR a.role = 'owner')
       AND (p_role <> 'custom' OR EXISTS (SELECT 1 FROM public.erp_custom_roles r WHERE r.id = p_custom_role_id AND r.workspace_id = p_workspace_id))
       AND (p_role IN ('admin', 'finance', 'sales', 'inventory', 'custom'))
       AND (a.role = 'owner' OR public.erp__role_set(p_role, p_custom_role_id) <@ a.perms)
      FROM actor a LIMIT 1), false);
$$;

-- The workspace list includes the ones open through a staff session.
CREATE OR REPLACE FUNCTION public.erp_my_workspaces()
RETURNS TABLE (workspace_id UUID, name TEXT, role TEXT, is_owner BOOLEAN, is_personal BOOLEAN, owner_id UUID, owner_email TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  PERFORM public.erp_personal_workspace_id(auth.uid());
  RETURN QUERY
  SELECT x.id, x.name, x.role, x.is_owner, x.is_personal, x.owner_id, x.owner_email FROM (
    SELECT w.id, w.name, m.role,
           m.role = 'owner' AS is_owner,
           w.is_personal AND w.owner_id = auth.uid() AS is_personal,
           -- Rows are written on behalf of this account (the app's writeOwner).
           w.owner_id,
           COALESCE(creator.email, owner_profile.email) AS owner_email,
           0 AS kind
    FROM public.erp_workspace_members m
    JOIN public.erp_workspaces w ON w.id = m.workspace_id
    LEFT JOIN public.user_profiles owner_profile ON owner_profile.id = w.owner_id
    LEFT JOIN public.user_profiles creator ON creator.id = w.created_by
    WHERE m.user_id = auth.uid() AND m.status = 'active'
    UNION ALL
    SELECT DISTINCT w.id, w.name, 'owner', true, false, w.owner_id,
           COALESCE(creator.email, owner_profile.email), 1
    FROM etna_platform.staff_access_sessions s
    JOIN public.erp_workspaces w ON w.id = s.workspace_id
    LEFT JOIN public.user_profiles owner_profile ON owner_profile.id = w.owner_id
    LEFT JOIN public.user_profiles creator ON creator.id = w.created_by
    WHERE s.admin_id = auth.uid() AND s.ended_at IS NULL AND s.ends_at > now()
      AND etna_platform._role_of(auth.uid()) = 'super_admin'
      AND NOT EXISTS (SELECT 1 FROM public.erp_workspace_members m
                       WHERE m.workspace_id = w.id AND m.user_id = auth.uid() AND m.status = 'active')
  ) x
  ORDER BY x.kind, (x.owner_id = auth.uid()) DESC, (x.role = 'owner') DESC, x.name;
END;
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
   WHERE m.user_id = auth.uid() AND m.status = 'active'
  UNION ALL
  SELECT s.workspace_id, 'owner', NULL::UUID, NULL::TEXT,
         public.erp_member_permissions(s.workspace_id),
         public.erp_my_grantable_roles(s.workspace_id),
         max(s.ends_at)
    FROM etna_platform.staff_access_sessions s
   WHERE s.admin_id = auth.uid() AND s.ended_at IS NULL AND s.ends_at > now()
     AND etna_platform._role_of(auth.uid()) = 'super_admin'
     AND NOT EXISTS (SELECT 1 FROM public.erp_workspace_members m
                      WHERE m.workspace_id = s.workspace_id AND m.user_id = auth.uid() AND m.status = 'active')
   GROUP BY s.workspace_id;
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_start_staff_access(p_workspace_id UUID, p_reason TEXT, p_ticket TEXT, p_hours INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  why TEXT := btrim(COALESCE(p_reason, ''));
  ticket TEXT := btrim(COALESCE(p_ticket, ''));
  w public.erp_workspaces;
  owner_email TEXT;
  session etna_platform.staff_access_sessions;
BEGIN
  IF char_length(why) < 10 THEN
    RAISE EXCEPTION 'Describe the reason (at least 10 characters)' USING ERRCODE = '22023';
  END IF;
  IF char_length(ticket) < 1 THEN
    RAISE EXCEPTION 'Give the ticket or incident reference' USING ERRCODE = '22023';
  END IF;
  IF p_hours IS NULL OR p_hours < 1 OR p_hours > 8 THEN
    RAISE EXCEPTION 'A staff session lasts 1 to 8 hours' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO w FROM public.erp_workspaces x WHERE x.id = p_workspace_id;
  IF w.id IS NULL THEN RAISE EXCEPTION 'No such workspace' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM public.erp_workspace_members m WHERE m.workspace_id = w.id AND m.user_id = auth.uid() AND m.status = 'active') THEN
    RAISE EXCEPTION 'You are already a member of this workspace' USING ERRCODE = 'P0001', HINT = 'already';
  END IF;
  -- One live session per admin and workspace: a new one replaces it.
  UPDATE etna_platform.staff_access_sessions SET ended_at = now(), ended_by = auth.uid()
   WHERE admin_id = auth.uid() AND workspace_id = w.id AND ended_at IS NULL AND ends_at > now();
  INSERT INTO etna_platform.staff_access_sessions (admin_id, workspace_id, reason, ticket_ref, ends_at)
  VALUES (auth.uid(), w.id, left(why, 500), left(ticket, 100), now() + make_interval(hours => p_hours))
  RETURNING * INTO session;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (w.id, auth.uid(), 'staff.access_started',
          jsonb_build_object('reason', session.reason, 'ticket', session.ticket_ref, 'until', session.ends_at, 'via', 'etna_admin'));
  PERFORM etna_platform._log('STAFF_ACCESS_STARTED', 'success', 'admin', NULL, NULL, w.id,
    jsonb_build_object('session_id', session.id, 'reason', session.reason, 'ticket', session.ticket_ref, 'until', session.ends_at,
                       'workspace_name', w.name));
  SELECT COALESCE(c.email, o.email) INTO owner_email
    FROM public.erp_workspaces x
    LEFT JOIN public.user_profiles c ON c.id = x.created_by
    LEFT JOIN public.user_profiles o ON o.id = x.owner_id
   WHERE x.id = w.id;
  RETURN jsonb_build_object('session_id', session.id, 'ends_at', session.ends_at, 'workspace_name', w.name,
                            'owner_email', owner_email, 'admin_email', (SELECT u.email FROM auth.users u WHERE u.id = auth.uid()));
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_end_staff_access(p_session_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], false);
  session etna_platform.staff_access_sessions;
BEGIN
  UPDATE etna_platform.staff_access_sessions SET ended_at = now(), ended_by = auth.uid()
   WHERE id = p_session_id AND ended_at IS NULL
  RETURNING * INTO session;
  IF session.id IS NULL THEN RAISE EXCEPTION 'No live session' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (session.workspace_id, auth.uid(), 'staff.access_ended', jsonb_build_object('session_id', session.id, 'via', 'etna_admin'));
  PERFORM etna_platform._log('STAFF_ACCESS_ENDED', 'success', 'admin', NULL, NULL, session.workspace_id,
    jsonb_build_object('session_id', session.id, 'started_by', session.admin_id, 'early', session.ends_at > now()));
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_staff_access_sessions(p_workspace_id UUID DEFAULT NULL, p_limit INTEGER DEFAULT 50)
RETURNS TABLE (id UUID, admin_email TEXT, workspace_id UUID, workspace_name TEXT, reason TEXT, ticket_ref TEXT,
               starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, live BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  RETURN QUERY
  SELECT s.id, u.email, s.workspace_id, w.name, s.reason, s.ticket_ref, s.starts_at, s.ends_at, s.ended_at,
         s.ended_at IS NULL AND s.ends_at > now()
    FROM etna_platform.staff_access_sessions s
    LEFT JOIN auth.users u ON u.id = s.admin_id
    LEFT JOIN public.erp_workspaces w ON w.id = s.workspace_id
   WHERE p_workspace_id IS NULL OR s.workspace_id = p_workspace_id
   ORDER BY s.starts_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$$;

-- ─── 3. Retention ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS etna_platform.retention_policies (
  log_type TEXT PRIMARY KEY CHECK (log_type IN ('security', 'data_access', 'workspace_audit', 'run_history', 'stream_raw')),
  min_days INTEGER NOT NULL CHECK (min_days >= 7),
  max_days INTEGER CHECK (max_days IS NULL OR max_days >= 7),
  default_days INTEGER CHECK (default_days IS NULL OR default_days >= 7),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (max_days IS NULL OR max_days >= min_days),
  CHECK (default_days IS NULL OR (default_days >= min_days AND (max_days IS NULL OR default_days <= max_days))),
  CHECK (default_days IS NOT NULL OR max_days IS NULL)
);
-- NULL = forever. The security log keeps its existing platform setting as default.
INSERT INTO etna_platform.retention_policies (log_type, min_days, max_days, default_days) VALUES
  ('security', 365, NULL, (SELECT CASE WHEN s.security_log_retention_days >= 365 THEN s.security_log_retention_days END FROM etna_platform.settings s WHERE s.id)),
  ('data_access', 90, 730, 365),
  ('workspace_audit', 365, NULL, NULL),
  ('run_history', 30, 730, 180),
  ('stream_raw', 7, 365, 30)
ON CONFLICT (log_type) DO NOTHING;
REVOKE ALL ON etna_platform.retention_policies FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS etna_platform.workspace_retention (
  workspace_id UUID NOT NULL,
  log_type TEXT NOT NULL REFERENCES etna_platform.retention_policies(log_type),
  days INTEGER CHECK (days IS NULL OR days >= 7),
  set_by UUID,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, log_type)
);
REVOKE ALL ON etna_platform.workspace_retention FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS etna_platform.legal_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500),
  set_by UUID,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  until DATE,
  released_at TIMESTAMPTZ,
  released_by UUID,
  release_reason TEXT
);
CREATE INDEX IF NOT EXISTS legal_holds_live_idx ON etna_platform.legal_holds (workspace_id) WHERE released_at IS NULL;
REVOKE ALL ON etna_platform.legal_holds FROM PUBLIC, anon, authenticated;

-- Days to keep a log type for a workspace (NULL = forever), within the bounds.
CREATE OR REPLACE FUNCTION etna_platform.effective_retention_days(p_workspace_id UUID, p_log_type TEXT)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
  SELECT CASE
    WHEN p.log_type IS NULL THEN NULL
    WHEN w.workspace_id IS NULL THEN p.default_days
    WHEN w.days IS NULL THEN p.max_days
    ELSE GREATEST(p.min_days, LEAST(w.days, COALESCE(p.max_days, w.days))) END
  FROM etna_platform.retention_policies p
  LEFT JOIN etna_platform.workspace_retention w ON w.workspace_id = p_workspace_id AND w.log_type = p.log_type
  WHERE p.log_type = p_log_type;
$$;

CREATE OR REPLACE FUNCTION etna_platform.on_legal_hold(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
  SELECT p_workspace_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM etna_platform.legal_holds h
     WHERE h.workspace_id = p_workspace_id AND h.released_at IS NULL AND (h.until IS NULL OR h.until >= current_date));
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_retention_policies()
RETURNS TABLE (log_type TEXT, min_days INTEGER, max_days INTEGER, default_days INTEGER, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  RETURN QUERY SELECT p.log_type, p.min_days, p.max_days, p.default_days, p.updated_at
                 FROM etna_platform.retention_policies p ORDER BY p.log_type;
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_set_retention_policy(p_log_type TEXT, p_min_days INTEGER, p_max_days INTEGER, p_default_days INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin', 'security_officer'], true);
  previous etna_platform.retention_policies;
BEGIN
  SELECT * INTO previous FROM etna_platform.retention_policies p WHERE p.log_type = p_log_type FOR UPDATE;
  IF previous.log_type IS NULL THEN RAISE EXCEPTION 'Unknown log type' USING ERRCODE = '22023'; END IF;
  UPDATE etna_platform.retention_policies
     SET min_days = p_min_days, max_days = p_max_days, default_days = p_default_days, updated_by = auth.uid(), updated_at = now()
   WHERE log_type = p_log_type;
  PERFORM etna_platform._log('RETENTION_POLICY_CHANGED', 'success', 'admin', NULL, NULL, NULL,
    jsonb_build_object('log_type', p_log_type, 'min_days', p_min_days, 'max_days', p_max_days, 'default_days', p_default_days,
                       'previous', jsonb_build_object('min_days', previous.min_days, 'max_days', previous.max_days, 'default_days', previous.default_days)));
END;
$$;

-- What a workspace keeps, for its Owner (any member reads it).
CREATE OR REPLACE FUNCTION public.erp_workspace_retention(p_workspace_id UUID)
RETURNS TABLE (log_type TEXT, min_days INTEGER, max_days INTEGER, default_days INTEGER, chosen_days INTEGER,
               effective_days INTEGER, legal_hold BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
BEGIN
  IF public.erp_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT p.log_type, p.min_days, p.max_days, p.default_days, w.days,
         etna_platform.effective_retention_days(p_workspace_id, p.log_type),
         etna_platform.on_legal_hold(p_workspace_id)
    FROM etna_platform.retention_policies p
    LEFT JOIN etna_platform.workspace_retention w ON w.workspace_id = p_workspace_id AND w.log_type = p.log_type
   WHERE p.log_type <> 'stream_raw'
   ORDER BY p.log_type;
END;
$$;

-- NULL days = the longest the platform allows (forever where there is no maximum).
CREATE OR REPLACE FUNCTION public.erp_set_workspace_retention(p_workspace_id UUID, p_log_type TEXT, p_days INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
DECLARE
  bounds etna_platform.retention_policies;
BEGIN
  IF NOT public.erp_has_permission(p_workspace_id, 'policies.manage') THEN
    RAISE EXCEPTION 'You are not allowed to change retention in this workspace' USING ERRCODE = '42501';
  END IF;
  IF public.erp_session_aal() <> 'aal2' THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  SELECT * INTO bounds FROM etna_platform.retention_policies p WHERE p.log_type = p_log_type;
  IF bounds.log_type IS NULL OR p_log_type = 'stream_raw' THEN RAISE EXCEPTION 'Unknown log type' USING ERRCODE = '22023'; END IF;
  IF p_days IS NOT NULL AND (p_days < bounds.min_days OR (bounds.max_days IS NOT NULL AND p_days > bounds.max_days)) THEN
    RAISE EXCEPTION 'Choose between % and % days', bounds.min_days, COALESCE(bounds.max_days::text, 'forever') USING ERRCODE = '22023';
  END IF;
  IF p_days IS NULL AND bounds.max_days IS NOT NULL THEN
    p_days := bounds.max_days;
  END IF;
  INSERT INTO etna_platform.workspace_retention (workspace_id, log_type, days, set_by)
  VALUES (p_workspace_id, p_log_type, p_days, auth.uid())
  ON CONFLICT (workspace_id, log_type) DO UPDATE SET days = EXCLUDED.days, set_by = EXCLUDED.set_by, set_at = now();
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (p_workspace_id, auth.uid(), 'retention.changed', jsonb_build_object('log_type', p_log_type, 'days', p_days));
  PERFORM etna_platform._log('WORKSPACE_RETENTION_CHANGED', 'success', 'user', NULL, NULL, p_workspace_id,
    jsonb_build_object('log_type', p_log_type, 'days', p_days));
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_set_legal_hold(p_workspace_id UUID, p_reason TEXT, p_until DATE)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['security_officer'], true);
  hold_id UUID;
BEGIN
  IF char_length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'Describe the reason (at least 10 characters)' USING ERRCODE = '22023';
  END IF;
  INSERT INTO etna_platform.legal_holds (workspace_id, reason, set_by, until)
  VALUES (p_workspace_id, left(btrim(p_reason), 500), auth.uid(), p_until)
  RETURNING id INTO hold_id;
  PERFORM etna_platform._log('LEGAL_HOLD_SET', 'success', 'admin', NULL, NULL, p_workspace_id,
    jsonb_build_object('hold_id', hold_id, 'reason', left(btrim(p_reason), 500), 'until', p_until));
  RETURN hold_id;
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_release_legal_hold(p_hold_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['security_officer'], true);
  hold etna_platform.legal_holds;
BEGIN
  IF char_length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Give a reason' USING ERRCODE = '22023';
  END IF;
  UPDATE etna_platform.legal_holds SET released_at = now(), released_by = auth.uid(), release_reason = left(btrim(p_reason), 500)
   WHERE id = p_hold_id AND released_at IS NULL
  RETURNING * INTO hold;
  IF hold.id IS NULL THEN RAISE EXCEPTION 'No such hold' USING ERRCODE = 'P0002'; END IF;
  PERFORM etna_platform._log('LEGAL_HOLD_RELEASED', 'success', 'admin', NULL, NULL, hold.workspace_id,
    jsonb_build_object('hold_id', hold.id, 'reason', hold.release_reason));
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_legal_holds(p_workspace_id UUID DEFAULT NULL)
RETURNS TABLE (id UUID, workspace_id UUID, workspace_name TEXT, reason TEXT, set_by_email TEXT, set_at TIMESTAMPTZ, until DATE,
               released_at TIMESTAMPTZ, release_reason TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  RETURN QUERY
  SELECT h.id, h.workspace_id, w.name, h.reason, u.email, h.set_at, h.until, h.released_at, h.release_reason
    FROM etna_platform.legal_holds h
    LEFT JOIN public.erp_workspaces w ON w.id = h.workspace_id
    LEFT JOIN auth.users u ON u.id = h.set_by
   WHERE p_workspace_id IS NULL OR h.workspace_id = p_workspace_id
   ORDER BY h.set_at DESC;
END;
$$;

-- Deletes what is past its retention, except for workspaces on legal hold.
-- Run nightly by the worker (and by hand from ETNA.bat); every purge is logged.
CREATE OR REPLACE FUNCTION etna_platform.purge_by_retention()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, public, pg_temp
AS $$
DECLARE
  security_removed INTEGER := 0;
  audit_removed INTEGER := 0;
  runs_removed INTEGER := 0;
  platform_days INTEGER := etna_platform.effective_retention_days(NULL, 'security');
BEGIN
  PERFORM set_config('etna.security_log_purge', 'on', true);
  DELETE FROM etna_platform.security_events e
   WHERE NOT etna_platform.on_legal_hold(e.workspace_id)
     AND e.occurred_at < now() - make_interval(days => COALESCE(
           CASE WHEN e.workspace_id IS NULL THEN platform_days ELSE etna_platform.effective_retention_days(e.workspace_id, 'security') END,
           365000));
  GET DIAGNOSTICS security_removed = ROW_COUNT;
  PERFORM set_config('etna.security_log_purge', 'off', true);

  DELETE FROM public.erp_workspace_audit_log a
   WHERE NOT etna_platform.on_legal_hold(a.workspace_id)
     AND a.created_at < now() - make_interval(days => COALESCE(etna_platform.effective_retention_days(a.workspace_id, 'workspace_audit'), 365000));
  GET DIAGNOSTICS audit_removed = ROW_COUNT;

  DELETE FROM public.workflow_runs r
   WHERE r.workspace_id IS NOT NULL AND r.status <> 'running'
     AND NOT etna_platform.on_legal_hold(r.workspace_id)
     AND r.started_at < now() - make_interval(days => COALESCE(etna_platform.effective_retention_days(r.workspace_id, 'run_history'), 365000));
  GET DIAGNOSTICS runs_removed = ROW_COUNT;

  PERFORM etna_platform._log('RETENTION_PURGED', 'success', 'system', NULL, NULL, NULL,
    jsonb_build_object('security_events', security_removed, 'workspace_audit', audit_removed, 'runs', runs_removed));
  RETURN jsonb_build_object('security_events', security_removed, 'workspace_audit', audit_removed, 'runs', runs_removed);
END;
$$;

-- ─── 4. Termination ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS etna_platform.workspace_terminations (
  workspace_id UUID PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('export_available', 'deleting', 'deleted', 'cancelled')),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500),
  started_by UUID,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  export_until TIMESTAMPTZ NOT NULL,
  confirmed_by UUID,
  confirmed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  deletion_summary JSONB,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ
);
REVOKE ALL ON etna_platform.workspace_terminations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION etna_platform.admin_terminate_workspace(p_workspace_id UUID, p_reason TEXT, p_grace_days INTEGER DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  why TEXT := btrim(COALESCE(p_reason, ''));
  w public.erp_workspaces;
  owner_email TEXT;
  row etna_platform.workspace_terminations;
BEGIN
  IF char_length(why) < 10 THEN RAISE EXCEPTION 'Describe the reason (at least 10 characters)' USING ERRCODE = '22023'; END IF;
  IF p_grace_days IS NULL OR p_grace_days < 7 OR p_grace_days > 90 THEN
    RAISE EXCEPTION 'The export period is 7 to 90 days' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO w FROM public.erp_workspaces x WHERE x.id = p_workspace_id FOR UPDATE;
  IF w.id IS NULL THEN RAISE EXCEPTION 'No such workspace' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = w.owner_id AND etna_platform._is_container(u.raw_user_meta_data)) THEN
    RAISE EXCEPTION 'Only a company ERP can be terminated, not a person''s own ERP' USING ERRCODE = 'P0001', HINT = 'personal';
  END IF;
  IF EXISTS (SELECT 1 FROM etna_platform.workspace_terminations t WHERE t.workspace_id = w.id AND t.state IN ('export_available', 'deleting', 'deleted')) THEN
    RAISE EXCEPTION 'This company is already being terminated' USING ERRCODE = 'P0001', HINT = 'already';
  END IF;
  INSERT INTO etna_platform.workspace_terminations (workspace_id, state, reason, started_by, export_until)
  VALUES (w.id, 'export_available', left(why, 500), auth.uid(), now() + make_interval(days => p_grace_days))
  ON CONFLICT (workspace_id) DO UPDATE SET state = 'export_available', reason = EXCLUDED.reason, started_by = EXCLUDED.started_by,
    started_at = now(), export_until = EXCLUDED.export_until, confirmed_by = NULL, confirmed_at = NULL,
    deleted_at = NULL, deletion_summary = NULL, cancelled_by = NULL, cancelled_at = NULL
  RETURNING * INTO row;
  IF NOT EXISTS (SELECT 1 FROM etna_platform.workspace_suspensions s WHERE s.workspace_id = w.id AND s.lifted_at IS NULL) THEN
    INSERT INTO etna_platform.workspace_suspensions (workspace_id, reason, suspended_by)
    VALUES (w.id, left('Termination: ' || why, 500), auth.uid());
  END IF;
  PERFORM etna_platform._log('WORKSPACE_TERMINATION_STARTED', 'success', 'admin', NULL, NULL, w.id,
    jsonb_build_object('reason', row.reason, 'export_until', row.export_until, 'workspace_name', w.name));
  SELECT COALESCE(c.email, o.email) INTO owner_email
    FROM public.erp_workspaces x LEFT JOIN public.user_profiles c ON c.id = x.created_by LEFT JOIN public.user_profiles o ON o.id = x.owner_id
   WHERE x.id = w.id;
  RETURN jsonb_build_object('export_until', row.export_until, 'workspace_name', w.name, 'owner_email', owner_email);
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_cancel_termination(p_workspace_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  row etna_platform.workspace_terminations;
BEGIN
  IF char_length(btrim(COALESCE(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Give a reason' USING ERRCODE = '22023'; END IF;
  UPDATE etna_platform.workspace_terminations SET state = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now()
   WHERE workspace_id = p_workspace_id AND state = 'export_available'
  RETURNING * INTO row;
  IF row.workspace_id IS NULL THEN RAISE EXCEPTION 'Nothing to cancel' USING ERRCODE = 'P0002'; END IF;
  PERFORM etna_platform._log('WORKSPACE_TERMINATION_CANCELLED', 'success', 'admin', NULL, NULL, p_workspace_id,
    jsonb_build_object('reason', left(btrim(p_reason), 500)));
END;
$$;

-- Second person: the security officer, after the export period.
CREATE OR REPLACE FUNCTION etna_platform.admin_confirm_termination(p_workspace_id UUID, p_confirm_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['security_officer'], true);
  row etna_platform.workspace_terminations;
  ws_name TEXT;
BEGIN
  SELECT * INTO row FROM etna_platform.workspace_terminations t WHERE t.workspace_id = p_workspace_id FOR UPDATE;
  IF row.workspace_id IS NULL OR row.state <> 'export_available' THEN
    RAISE EXCEPTION 'This company is not waiting for deletion' USING ERRCODE = 'P0002';
  END IF;
  IF row.started_by = auth.uid() THEN
    RAISE EXCEPTION 'Another person must confirm the deletion' USING ERRCODE = 'P0001', HINT = 'self';
  END IF;
  IF row.export_until > now() THEN
    RAISE EXCEPTION 'The export period runs until %', row.export_until USING ERRCODE = 'P0001', HINT = 'too_early';
  END IF;
  IF etna_platform.on_legal_hold(p_workspace_id) THEN
    RAISE EXCEPTION 'This company is on legal hold' USING ERRCODE = 'P0001', HINT = 'legal_hold';
  END IF;
  SELECT w.name INTO ws_name FROM public.erp_workspaces w WHERE w.id = p_workspace_id;
  IF btrim(COALESCE(p_confirm_name, '')) IS DISTINCT FROM ws_name THEN
    RAISE EXCEPTION 'Type the company''s name to confirm' USING ERRCODE = 'P0001', HINT = 'confirm';
  END IF;
  UPDATE etna_platform.workspace_terminations SET state = 'deleting', confirmed_by = auth.uid(), confirmed_at = now()
   WHERE workspace_id = p_workspace_id;
  PERFORM etna_platform._log('WORKSPACE_TERMINATION_CONFIRMED', 'success', 'admin', NULL, NULL, p_workspace_id,
    jsonb_build_object('workspace_name', ws_name));
END;
$$;

-- The deletion itself (run by the worker once confirmed). Every table with a
-- workspace_id is emptied for this company, dependent rows first (tables
-- that refuse because of references are retried after the others). Audit
-- trails stay (retention). The workspace row stays as a tombstone.
CREATE OR REPLACE FUNCTION etna_platform.run_workspace_deletion(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, public, pg_temp
AS $$
DECLARE
  row etna_platform.workspace_terminations;
  w public.erp_workspaces;
  keep CONSTANT TEXT[] := ARRAY['erp_workspace_audit_log', 'erp_audit_log', 'erp_access_log', 'erp_currency_audit', 'erp_workspace_members'];
  tables TEXT[];
  t TEXT;
  n INTEGER;
  blocked INTEGER;
  pass INTEGER := 0;
  summary JSONB := '{}'::jsonb;
BEGIN
  SELECT * INTO row FROM etna_platform.workspace_terminations x WHERE x.workspace_id = p_workspace_id FOR UPDATE;
  IF row.workspace_id IS NULL OR row.state <> 'deleting' THEN
    RAISE EXCEPTION 'Deletion has not been confirmed' USING ERRCODE = 'P0001', HINT = 'not_confirmed';
  END IF;
  IF etna_platform.on_legal_hold(p_workspace_id) THEN
    RAISE EXCEPTION 'This company is on legal hold' USING ERRCODE = 'P0001', HINT = 'legal_hold';
  END IF;
  SELECT * INTO w FROM public.erp_workspaces x WHERE x.id = p_workspace_id;
  SELECT array_agg(c.relname::text ORDER BY c.relname) INTO tables
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
   WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relname = ANY(keep);

  -- Members leave first (a custom role cannot go while someone has it).
  UPDATE public.erp_workspace_members
     SET status = 'removed', removed_at = now(), removal_reason = 'Company terminated', updated_at = now(),
         role = CASE WHEN role = 'custom' THEN 'viewer' ELSE role END,
         custom_role_id = NULL
   WHERE workspace_id = p_workspace_id AND (status = 'active' OR custom_role_id IS NOT NULL);

  LOOP
    pass := pass + 1;
    blocked := 0;
    FOREACH t IN ARRAY tables LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE workspace_id = $1', t) USING p_workspace_id;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN summary := summary || jsonb_build_object(t, COALESCE((summary ->> t)::int, 0) + n); END IF;
      EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN
        blocked := blocked + 1;
      END;
    END LOOP;
    EXIT WHEN blocked = 0;
    IF pass >= 12 THEN
      RAISE EXCEPTION 'Some records could not be deleted (references); nothing was deleted' USING ERRCODE = 'P0001', HINT = 'blocked';
    END IF;
  END LOOP;

  -- Settings kept per internal owner of the company.
  DELETE FROM public.erp_settings x WHERE x.user_id = w.owner_id;
  DELETE FROM public.erp_approval_settings x WHERE x.owner_id = w.owner_id;
  UPDATE etna_platform.workspace_terminations SET state = 'deleted', deleted_at = now(), deletion_summary = summary
   WHERE workspace_id = p_workspace_id;
  PERFORM etna_platform._log('WORKSPACE_DATA_DELETED', 'success', 'system', NULL, NULL, p_workspace_id,
    jsonb_build_object('workspace_name', w.name, 'removed', summary));
  RETURN summary;
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_workspace_termination(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  RETURN (
    SELECT jsonb_build_object('state', t.state, 'reason', t.reason, 'started_at', t.started_at, 'export_until', t.export_until,
             'started_by_email', (SELECT u.email FROM auth.users u WHERE u.id = t.started_by),
             'confirmed_at', t.confirmed_at, 'confirmed_by_email', (SELECT u.email FROM auth.users u WHERE u.id = t.confirmed_by),
             'deleted_at', t.deleted_at, 'deletion_summary', t.deletion_summary, 'cancelled_at', t.cancelled_at,
             'legal_hold', etna_platform.on_legal_hold(t.workspace_id))
      FROM etna_platform.workspace_terminations t WHERE t.workspace_id = p_workspace_id);
END;
$$;

-- For the Owner: whether the ERP is being terminated, and until when the export is available.
CREATE OR REPLACE FUNCTION public.erp_my_termination(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
  SELECT jsonb_build_object('state', t.state, 'export_until', t.export_until)
    FROM etna_platform.workspace_terminations t
   WHERE t.workspace_id = p_workspace_id AND t.state IN ('export_available', 'deleting', 'deleted')
     AND EXISTS (SELECT 1 FROM public.erp_workspace_members m
                  WHERE m.workspace_id = p_workspace_id AND m.user_id = auth.uid() AND m.role = 'owner');
$$;

-- ─── 5. Privileges ───────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION etna_platform.effective_retention_days(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION etna_platform.on_legal_hold(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION etna_platform.purge_by_retention() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION etna_platform.run_workspace_deletion(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__staff_session_until(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION etna_platform.admin_start_staff_access(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_end_staff_access(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_staff_access_sessions(UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_retention_policies() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_set_retention_policy(TEXT, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_set_legal_hold(UUID, TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_release_legal_hold(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_legal_holds(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_terminate_workspace(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_cancel_termination(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_confirm_termination(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_workspace_termination(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_workspace_retention(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_set_workspace_retention(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_my_termination(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION etna_platform.admin_start_staff_access(UUID, TEXT, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_end_staff_access(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_staff_access_sessions(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_retention_policies() TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_set_retention_policy(TEXT, INTEGER, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_set_legal_hold(UUID, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_release_legal_hold(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_legal_holds(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_terminate_workspace(UUID, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_cancel_termination(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_confirm_termination(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_workspace_termination(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_workspace_retention(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_set_workspace_retention(UUID, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_my_termination(UUID) TO authenticated;
