-- Admin panel, phase 4: the dashboard, access changes, workspace access, and
-- audit history that outlives what it describes.
--
-- 1. ERP audit trails are kept when an account or an ERP is deleted. Resetting
--    or emptying an ERP already kept them (20261011000000, 20261012000004),
--    but deleting a created ERP removed its internal owner account, and with
--    it (ON DELETE CASCADE) every audit entry of that ERP. The foreign keys
--    from the three audit tables to accounts and workspaces are dropped, as
--    for the security log: the rows stay, with the ids they had. Only platform
--    admins can still reach the trail of a deleted ERP; members lose it with
--    the ERP.
-- 2. Access changes and destructive ERP actions are copied from each ERP's own
--    trail (erp_workspace_audit_log) into the append-only security log: members
--    added, removed, leaving, role changes, resets, emptying and deleting an
--    ERP. The client still sees them in its own trail.
-- 3. Super admins can grant, change and remove an account's access to a
--    workspace (a reason and a fresh two-factor code each time). Never their
--    own access (another admin must), never the Owner's, never the Owner role.
--    The client's trail shows the change, made by the admin's account.
-- 4. etna_platform.admin_dashboard(): the numbers on /admin for the last 24
--    hours, 7 days or 30 days, from data ETNA already keeps. Nothing new is
--    collected.
--
-- Rollback: db/rollback/rollback_20261012000014_platform_admin_dashboard.sql

-- ─── 1. Audit trails outlive accounts and ERPs ────────────────────────────────

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT con.conname, con.conrelid::regclass AS tbl
      FROM pg_constraint con
     WHERE con.contype = 'f'
       AND con.conrelid IN (
         'public.erp_audit_log'::regclass,
         'public.erp_workspace_audit_log'::regclass,
         'public.erp_currency_audit'::regclass)
       AND con.confrelid IN ('public.user_profiles'::regclass, 'public.erp_workspaces'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
  END LOOP;
END;
$$;

-- ─── 2. Access changes and ERP resets in the security log ────────────────────

-- Copies the listed actions; everything else stays only in the ERP's trail.
-- Only known keys of `details` are copied (never codes or secrets).
CREATE OR REPLACE FUNCTION etna_platform._mirror_workspace_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  kind TEXT := CASE NEW.action
    WHEN 'member.added' THEN 'WORKSPACE_MEMBER_ADDED'
    WHEN 'member.role_changed' THEN 'WORKSPACE_ROLE_CHANGED'
    WHEN 'member.removed' THEN 'WORKSPACE_MEMBER_REMOVED'
    WHEN 'member.left' THEN 'WORKSPACE_MEMBER_LEFT'
    WHEN 'workspace.reset' THEN 'ERP_RESET'
    WHEN 'erp.emptied' THEN 'ERP_EMPTIED'
    WHEN 'erp.deleted' THEN 'ERP_DELETED'
  END;
  d JSONB := COALESCE(NEW.details, '{}'::jsonb);
  ws UUID := NEW.workspace_id;
  meta JSONB;
BEGIN
  IF kind IS NULL THEN
    RETURN NEW;
  END IF;
  -- A deleted ERP is recorded in its Owner's own trail; the log names the ERP.
  IF NEW.action = 'erp.deleted' AND d ->> 'workspace_id' ~ '^[0-9a-fA-F-]{36}$' THEN
    ws := (d ->> 'workspace_id')::uuid;
  END IF;
  meta := jsonb_strip_nulls(jsonb_build_object(
    'workspace_name', COALESCE(d -> 'name', (SELECT to_jsonb(w.name) FROM public.erp_workspaces w WHERE w.id = ws)),
    'role', d -> 'role', 'from', d -> 'from', 'to', d -> 'to',
    'reason', d -> 'reason', 'scope', d -> 'scope', 'removed', d -> 'removed',
    'invited_by', d -> 'invited_by', 'via', d -> 'via'));
  IF pg_column_size(meta) > 4000 THEN
    meta := jsonb_build_object('workspace_name', meta -> 'workspace_name', 'truncated', true);
  END IF;
  PERFORM etna_platform._log(
    kind, 'success',
    CASE WHEN d ->> 'via' = 'etna_admin' THEN 'admin' ELSE 'user' END,
    NEW.target_user_id,
    (SELECT u.email FROM auth.users u WHERE u.id = NEW.target_user_id),
    ws, meta, NEW.actor_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS erp_workspace_audit_to_security_log ON public.erp_workspace_audit_log;
CREATE TRIGGER erp_workspace_audit_to_security_log
  AFTER INSERT ON public.erp_workspace_audit_log
  FOR EACH ROW EXECUTE FUNCTION etna_platform._mirror_workspace_audit();

-- ─── 3. Workspace access (super admin; fresh re-authentication) ───────────────

-- Adds the account to the workspace with p_role, or changes the role it has
-- there. Returns 'added', 'changed' or 'unchanged'.
CREATE OR REPLACE FUNCTION etna_platform.admin_workspace_grant(p_workspace_id UUID, p_email TEXT, p_role TEXT, p_reason TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  why TEXT := left(trim(COALESCE(p_reason, '')), 500);
  target UUID;
  w public.erp_workspaces;
  membership public.erp_workspace_members;
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('admin', 'finance', 'sales', 'inventory') THEN
    RAISE EXCEPTION 'Choose one of the roles admin, finance, sales or inventory' USING ERRCODE = '22023';
  END IF;
  IF char_length(why) < 3 THEN
    RAISE EXCEPTION 'Give a reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO w FROM public.erp_workspaces x WHERE x.id = p_workspace_id FOR UPDATE;
  IF w.id IS NULL THEN
    RAISE EXCEPTION 'No such workspace' USING ERRCODE = 'P0002';
  END IF;
  SELECT u.id INTO target FROM auth.users u WHERE lower(u.email) = lower(trim(COALESCE(p_email, '')));
  IF target IS NULL THEN
    RAISE EXCEPTION 'No account for that e-mail address' USING ERRCODE = 'P0002';
  END IF;
  -- A person, and not the caller: nobody gives themselves access to client data.
  PERFORM etna_platform._target(target, caller_role, false);

  SELECT * INTO membership FROM public.erp_workspace_members m
   WHERE m.workspace_id = w.id AND m.user_id = target FOR UPDATE;

  IF membership.status = 'active' THEN
    IF membership.role = 'owner' THEN
      RAISE EXCEPTION 'The Owner''s access cannot be changed' USING ERRCODE = 'P0001', HINT = 'owner';
    END IF;
    IF membership.role = p_role THEN
      RETURN 'unchanged';
    END IF;
    UPDATE public.erp_workspace_members SET role = p_role, updated_at = now()
     WHERE workspace_id = w.id AND user_id = target;
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
    VALUES (w.id, auth.uid(), 'member.role_changed', target,
            jsonb_build_object('from', membership.role, 'to', p_role, 'reason', why, 'via', 'etna_admin'));
    RETURN 'changed';
  END IF;

  -- The workspace limit (erp_enforce_workspace_limit) applies as for an invitation.
  IF membership.user_id IS NOT NULL THEN
    UPDATE public.erp_workspace_members
       SET status = 'active', role = p_role, invited_by = auth.uid(), invitation_id = NULL,
           joined_at = now(), removed_at = NULL, removed_by = NULL, removal_reason = '', updated_at = now()
     WHERE workspace_id = w.id AND user_id = target;
  ELSE
    INSERT INTO public.erp_workspace_members (workspace_id, user_id, role, invited_by)
    VALUES (w.id, target, p_role, auth.uid());
  END IF;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
  VALUES (w.id, auth.uid(), 'member.added', target,
          jsonb_build_object('role', p_role, 'reason', why, 'via', 'etna_admin'));
  RETURN 'added';
END;
$$;

-- Ends an account's access to the workspace (not the Owner's). Removing one's
-- own access is allowed: it only takes privileges away.
CREATE OR REPLACE FUNCTION etna_platform.admin_workspace_remove(p_workspace_id UUID, p_user_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  why TEXT := left(trim(COALESCE(p_reason, '')), 500);
  membership public.erp_workspace_members;
BEGIN
  IF char_length(why) < 3 THEN
    RAISE EXCEPTION 'Give a reason' USING ERRCODE = '22023';
  END IF;
  PERFORM etna_platform._target(p_user_id, caller_role, true);
  SELECT * INTO membership FROM public.erp_workspace_members m
   WHERE m.workspace_id = p_workspace_id AND m.user_id = p_user_id AND m.status = 'active' FOR UPDATE;
  IF membership.user_id IS NULL THEN
    RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = 'P0002';
  END IF;
  IF membership.role = 'owner' THEN
    RAISE EXCEPTION 'The Owner''s access cannot be changed' USING ERRCODE = 'P0001', HINT = 'owner';
  END IF;
  UPDATE public.erp_workspace_members
     SET status = 'removed', removed_at = now(), removed_by = auth.uid(), removal_reason = why, updated_at = now()
   WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
  VALUES (p_workspace_id, auth.uid(), 'member.removed', p_user_id,
          jsonb_build_object('role', membership.role, 'reason', why, 'via', 'etna_admin'));
END;
$$;

-- ─── 4. Dashboard (every admin role) ──────────────────────────────────────────

-- p_hours: 24, 168 (7 days) or 720 (30 days). p_tz: the reader's time zone,
-- for the hours / days of the charts (UTC when unknown).
CREATE OR REPLACE FUNCTION etna_platform.admin_dashboard(p_hours INTEGER, p_tz TEXT DEFAULT 'UTC')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  since TIMESTAMPTZ;
  tz TEXT := 'UTC';
  unit TEXT;
  accounts JSONB;
  spaces JSONB;
  sign_in JSONB;
  terms JSONB;
  series JSONB;
  failing_accounts JSONB;
  failing_ips JSONB;
  access_changes JSONB;
  admin_actions JSONB;
  db_info JSONB;
  current_id UUID := etna_platform._current_terms_id();
  applied JSONB := '[]'::jsonb;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  IF p_hours IS NULL OR p_hours NOT IN (24, 168, 720) THEN
    RAISE EXCEPTION 'Choose 24, 168 or 720 hours' USING ERRCODE = '22023';
  END IF;
  IF p_tz IS NOT NULL AND char_length(p_tz) <= 64 AND EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = p_tz) THEN
    tz := p_tz;
  END IF;
  since := now() - make_interval(hours => p_hours);
  unit := CASE WHEN p_hours = 24 THEN 'hour' ELSE 'day' END;

  SELECT jsonb_build_object(
           'total', count(*),
           'active', count(*) FILTER (WHERE u.last_sign_in_at >= since),
           'new', count(*) FILTER (WHERE u.created_at >= since),
           'disabled', count(*) FILTER (WHERE COALESCE(u.banned_until > now(), false)),
           'without_mfa', count(*) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = u.id AND f.status = 'verified')),
           'admins', (SELECT count(*) FROM etna_platform.admins))
    INTO accounts
    FROM auth.users u
   WHERE NOT etna_platform._is_container(u.raw_user_meta_data);

  SELECT jsonb_build_object(
           'total', count(*),
           'shared', count(*) FILTER (WHERE NOT w.is_personal),
           'new', count(*) FILTER (WHERE w.created_at >= since),
           'suspended', count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM etna_platform.workspace_suspensions s WHERE s.workspace_id = w.id AND s.lifted_at IS NULL)),
           -- Active: something in it was created, changed or deleted.
           'active', count(*) FILTER (WHERE w.id IN (
              SELECT a.workspace_id FROM public.erp_audit_log a WHERE a.created_at >= since AND a.workspace_id IS NOT NULL)))
    INTO spaces
    FROM public.erp_workspaces w;

  SELECT jsonb_build_object(
           'succeeded', count(*) FILTER (WHERE e.event_type = 'LOGIN_SUCCEEDED'),
           'failed', count(*) FILTER (WHERE e.event_type = 'LOGIN_FAILED'),
           'rate_limited', count(*) FILTER (WHERE e.event_type IN ('LOGIN_RATE_LIMITED', 'MFA_RATE_LIMITED')),
           'mfa_failed', count(*) FILTER (WHERE e.event_type IN ('MFA_CHALLENGE_FAILED', 'ADMIN_REAUTH_FAILED')),
           'reset_failed', count(*) FILTER (WHERE e.event_type = 'PASSWORD_RESET_FAILED'),
           'access_changes', count(*) FILTER (WHERE e.event_type IN (
              'ADMIN_ROLE_GRANTED', 'ADMIN_ROLE_CHANGED', 'ADMIN_ROLE_REVOKED', 'WORKSPACE_MEMBER_ADDED',
              'WORKSPACE_ROLE_CHANGED', 'WORKSPACE_MEMBER_REMOVED', 'WORKSPACE_MEMBER_LEFT')),
           'admin_actions', count(*) FILTER (WHERE e.actor_kind IN ('admin', 'cli')))
    INTO sign_in
    FROM etna_platform.security_events e
   WHERE e.occurred_at >= since;

  -- Failed sign-ins and two-factor codes, by account (the address typed) and by IP.
  SELECT COALESCE(jsonb_agg(x ORDER BY x.failures DESC, x.last_at DESC), '[]'::jsonb) INTO failing_accounts
    FROM (
      SELECT lower(e.target_email) AS email, max(e.target_user_id::text)::uuid AS user_id,
             count(*) AS failures, max(e.occurred_at) AS last_at
        FROM etna_platform.security_events e
       WHERE e.occurred_at >= since AND e.outcome = 'failure' AND e.target_email IS NOT NULL
         AND e.event_type IN ('LOGIN_FAILED', 'MFA_CHALLENGE_FAILED', 'LOGIN_RATE_LIMITED', 'MFA_RATE_LIMITED')
       GROUP BY lower(e.target_email)
       ORDER BY count(*) DESC, max(e.occurred_at) DESC
       LIMIT 5) x;

  SELECT COALESCE(jsonb_agg(x ORDER BY x.failures DESC, x.last_at DESC), '[]'::jsonb) INTO failing_ips
    FROM (
      SELECT e.ip, count(*) AS failures, count(DISTINCT lower(e.target_email)) AS accounts,
             max(e.occurred_at) AS last_at
        FROM etna_platform.security_events e
       WHERE e.occurred_at >= since AND e.outcome = 'failure' AND e.ip IS NOT NULL
         AND e.event_type IN ('LOGIN_FAILED', 'MFA_CHALLENGE_FAILED', 'LOGIN_RATE_LIMITED', 'MFA_RATE_LIMITED')
       GROUP BY e.ip
       ORDER BY count(*) DESC, max(e.occurred_at) DESC
       LIMIT 5) x;

  -- One point per hour (24 hours) or day, in the reader's time zone.
  WITH buckets AS (
    SELECT g AS bucket
      FROM generate_series(date_trunc(unit, since AT TIME ZONE tz), date_trunc(unit, now() AT TIME ZONE tz),
                           ('1 ' || unit)::interval) g
  ),
  events AS (
    SELECT date_trunc(unit, e.occurred_at AT TIME ZONE tz) AS bucket,
           count(*) FILTER (WHERE e.event_type = 'LOGIN_SUCCEEDED') AS ok,
           count(*) FILTER (WHERE e.event_type IN ('LOGIN_FAILED', 'MFA_CHALLENGE_FAILED')) AS failed
      FROM etna_platform.security_events e
     WHERE e.occurred_at >= since
     GROUP BY 1
  ),
  joined AS (
    SELECT date_trunc(unit, u.created_at AT TIME ZONE tz) AS bucket, count(*) AS n
      FROM auth.users u
     WHERE u.created_at >= since AND NOT etna_platform._is_container(u.raw_user_meta_data)
     GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           't', to_char(b.bucket, 'YYYY-MM-DD"T"HH24:MI'),
           'sign_ins', COALESCE(ev.ok, 0),
           'failed', COALESCE(ev.failed, 0),
           'new_accounts', COALESCE(j.n, 0)) ORDER BY b.bucket), '[]'::jsonb)
    INTO series
    FROM buckets b
    LEFT JOIN events ev ON ev.bucket = b.bucket
    LEFT JOIN joined j ON j.bucket = b.bucket;

  SELECT jsonb_build_object(
           'version_id', v.id, 'label', v.label, 'published_at', v.published_at,
           'pending', (SELECT count(*) FROM auth.users u
                        WHERE NOT etna_platform._is_container(u.raw_user_meta_data)
                          AND NOT EXISTS (SELECT 1 FROM etna_platform.terms_acceptances a
                                           WHERE a.user_id = u.id AND a.version_id = v.id)),
           'pending_active', (SELECT count(*) FROM auth.users u
                        WHERE NOT etna_platform._is_container(u.raw_user_meta_data)
                          AND NOT COALESCE(u.banned_until > now(), false)
                          AND NOT EXISTS (SELECT 1 FROM etna_platform.terms_acceptances a
                                           WHERE a.user_id = u.id AND a.version_id = v.id)))
    INTO terms
    FROM etna_platform.terms_versions v
   WHERE v.id = current_id;

  -- The newest entries, whatever the period.
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id DESC), '[]'::jsonb) INTO access_changes
    FROM (
      SELECT e.id::text AS id, e.occurred_at, e.event_type, e.outcome, e.actor_kind, e.actor_user_id, e.actor_email,
             e.target_user_id, e.target_email, e.workspace_id, e.session_id, e.ip, e.user_agent, e.metadata
        FROM etna_platform.security_events e
       WHERE e.event_type IN ('ADMIN_ROLE_GRANTED', 'ADMIN_ROLE_CHANGED', 'ADMIN_ROLE_REVOKED', 'WORKSPACE_MEMBER_ADDED',
                              'WORKSPACE_ROLE_CHANGED', 'WORKSPACE_MEMBER_REMOVED', 'WORKSPACE_MEMBER_LEFT')
       ORDER BY e.id DESC
       LIMIT 8) x;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id DESC), '[]'::jsonb) INTO admin_actions
    FROM (
      SELECT e.id::text AS id, e.occurred_at, e.event_type, e.outcome, e.actor_kind, e.actor_user_id, e.actor_email,
             e.target_user_id, e.target_email, e.workspace_id, e.session_id, e.ip, e.user_agent, e.metadata
        FROM etna_platform.security_events e
       WHERE e.actor_kind IN ('admin', 'cli')
       ORDER BY e.id DESC
       LIMIT 8) x;

  -- Migrations applied by scripts/db/migrate.mjs (plain PostgreSQL only).
  IF to_regclass('etna_meta.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT COALESCE(jsonb_agg(m.name ORDER BY m.name), ''[]''::jsonb) FROM etna_meta.schema_migrations m'
      INTO applied;
  END IF;

  db_info := jsonb_build_object(
    'version', current_setting('server_version'),
    'size_bytes', pg_database_size(current_database()),
    'migrations', applied,
    'security_log', (SELECT jsonb_build_object('events', count(*), 'oldest', min(e.occurred_at))
                       FROM etna_platform.security_events e),
    'retention_days', (SELECT s.security_log_retention_days FROM etna_platform.settings s WHERE s.id));

  RETURN jsonb_build_object(
    'hours', p_hours,
    'since', since,
    'time_zone', tz,
    'unit', unit,
    'accounts', accounts,
    'workspaces', spaces,
    'sign_in', sign_in,
    'failing_accounts', failing_accounts,
    'failing_ips', failing_ips,
    'series', series,
    'terms', terms,
    'access_changes', access_changes,
    'admin_actions', admin_actions,
    'database', db_info);
END;
$$;

-- ─── 5. Grants ────────────────────────────────────────────────────────────────

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA etna_platform FROM PUBLIC;

GRANT EXECUTE ON FUNCTION etna_platform.admin_workspace_grant(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_workspace_remove(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_dashboard(INTEGER, TEXT) TO authenticated;
