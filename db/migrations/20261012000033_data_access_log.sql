-- The data-access log: every read and change of workspace data (decision
-- R-20, "everything"), separate from the security log so that log stays small.
--
-- etna_platform.data_access_log is partitioned by month (occurred_at); the
-- worker keeps the next months' partitions ready
-- (ensure_data_access_partitions) and purge_by_retention() deletes rows past
-- each workspace's data-access retention unless the workspace is on legal
-- hold. Rows are append-only: no role, the schema owner included, changes or
-- deletes them except through the purge.
--
-- Writers: erp_log_data_access() for signed-in requests (the app's data API,
-- documents, exports, TERMINAL), etna_platform.log_data_access_system() for
-- scheduled and system work. The ontology search log (erp_log_access) also
-- writes here. Readers: workspace members with 'audit' see their
-- workspace's log; platform admins see all.
--
-- Rollback: db/rollback/rollback_20261012000033_data_access_log.sql

CREATE TABLE IF NOT EXISTS etna_platform.data_access_log (
  id BIGSERIAL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  workspace_id UUID,
  actor_id UUID,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'staff', 'schedule', 'system', 'admin')),
  session_id UUID,
  object_kind TEXT NOT NULL CHECK (object_kind ~ '^[a-z_]{2,30}$'),
  object_id TEXT CHECK (object_id IS NULL OR char_length(object_id) <= 120),
  operation TEXT NOT NULL CHECK (operation IN ('query', 'preview', 'view', 'search', 'export', 'import', 'download', 'write', 'call', 'run', 'send')),
  rows INTEGER CHECK (rows IS NULL OR rows >= 0),
  fields_unmasked TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(fields_unmasked) <= 100),
  request_id TEXT CHECK (request_id IS NULL OR char_length(request_id) <= 80),
  ip TEXT CHECK (ip IS NULL OR char_length(ip) <= 64),
  detail JSONB CHECK (detail IS NULL OR pg_column_size(detail) <= 2000)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS etna_platform.data_access_log_default PARTITION OF etna_platform.data_access_log DEFAULT;
CREATE INDEX IF NOT EXISTS data_access_log_workspace_idx ON etna_platform.data_access_log (workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS data_access_log_actor_idx ON etna_platform.data_access_log (actor_id, occurred_at DESC);
REVOKE ALL ON etna_platform.data_access_log FROM PUBLIC, anon, authenticated;

-- One partition per month, from this month on.
CREATE OR REPLACE FUNCTION etna_platform.ensure_data_access_partitions(p_months_ahead INTEGER DEFAULT 2)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  first DATE := date_trunc('month', now())::date;
  m DATE;
  made INTEGER := 0;
  name TEXT;
BEGIN
  FOR i IN 0 .. GREATEST(COALESCE(p_months_ahead, 2), 0) LOOP
    m := (first + make_interval(months => i))::date;
    name := 'data_access_log_' || to_char(m, 'YYYYMM');
    IF to_regclass('etna_platform.' || name) IS NULL THEN
      -- Rows that landed in the default partition for this month move into it.
      EXECUTE format('CREATE TABLE etna_platform.%I (LIKE etna_platform.data_access_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', name);
      PERFORM set_config('etna.data_access_purge', 'on', true);
      EXECUTE format('WITH moved AS (DELETE FROM etna_platform.data_access_log_default WHERE occurred_at >= %L AND occurred_at < %L RETURNING *)
                      INSERT INTO etna_platform.%I SELECT * FROM moved', m, (m + interval '1 month')::date, name);
      PERFORM set_config('etna.data_access_purge', 'off', true);
      EXECUTE format('ALTER TABLE etna_platform.data_access_log ATTACH PARTITION etna_platform.%I FOR VALUES FROM (%L) TO (%L)',
                     name, m, (m + interval '1 month')::date);
      EXECUTE format('REVOKE ALL ON etna_platform.%I FROM PUBLIC, anon, authenticated', name);
      made := made + 1;
    END IF;
  END LOOP;
  RETURN made;
END;
$$;
SELECT etna_platform.ensure_data_access_partitions(2);

-- Append-only, also for the schema owner, except inside the purge.
CREATE OR REPLACE FUNCTION etna_platform._data_access_log_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('etna.data_access_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'The data-access log is append-only' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS data_access_log_immutable ON etna_platform.data_access_log;
CREATE TRIGGER data_access_log_immutable BEFORE UPDATE OR DELETE ON etna_platform.data_access_log
  FOR EACH ROW EXECUTE FUNCTION etna_platform._data_access_log_immutable();

CREATE OR REPLACE FUNCTION etna_platform._data_access_insert(
  p_workspace_id UUID, p_actor UUID, p_actor_kind TEXT, p_object_kind TEXT, p_object_id TEXT, p_operation TEXT,
  p_rows INTEGER, p_fields_unmasked TEXT[], p_request_id TEXT, p_detail JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
BEGIN
  INSERT INTO etna_platform.data_access_log
    (workspace_id, actor_id, actor_kind, session_id, object_kind, object_id, operation, rows, fields_unmasked, request_id, ip, detail)
  VALUES (p_workspace_id, p_actor, p_actor_kind, NULLIF(auth.jwt() ->> 'sid', '')::uuid, p_object_kind, left(p_object_id, 120),
          p_operation, p_rows, COALESCE(p_fields_unmasked, '{}'), left(p_request_id, 80),
          NULLIF(left(current_setting('request.ip', true), 64), ''), p_detail);
END;
$$;

-- For signed-in requests. The caller must be in the workspace (member or staff session).
CREATE OR REPLACE FUNCTION public.erp_log_data_access(
  p_workspace_id UUID, p_object_kind TEXT, p_object_id TEXT, p_operation TEXT, p_rows INTEGER,
  p_fields_unmasked TEXT[] DEFAULT '{}', p_request_id TEXT DEFAULT NULL, p_detail JSONB DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
DECLARE
  kind TEXT := 'user';
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  IF p_workspace_id IS NOT NULL THEN
    IF public.erp_workspace_role(p_workspace_id) IS NULL THEN
      RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.erp_workspace_members m
                    WHERE m.workspace_id = p_workspace_id AND m.user_id = auth.uid() AND m.status = 'active')
       AND public.erp__staff_session_until(p_workspace_id) IS NOT NULL THEN
      kind := 'staff';
    END IF;
  END IF;
  PERFORM etna_platform._data_access_insert(p_workspace_id, auth.uid(), kind, p_object_kind, p_object_id, p_operation,
                                            p_rows, p_fields_unmasked, p_request_id, p_detail);
END;
$$;

-- For scheduled and system work (the worker); not callable by signed-in users.
CREATE OR REPLACE FUNCTION etna_platform.log_data_access_system(
  p_workspace_id UUID, p_actor UUID, p_actor_kind TEXT, p_object_kind TEXT, p_object_id TEXT, p_operation TEXT,
  p_rows INTEGER, p_detail JSONB DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
BEGIN
  IF p_actor_kind NOT IN ('schedule', 'system') THEN
    RAISE EXCEPTION 'System entries are schedule or system' USING ERRCODE = '22023';
  END IF;
  PERFORM etna_platform._data_access_insert(p_workspace_id, p_actor, p_actor_kind, p_object_kind, p_object_id, p_operation,
                                            p_rows, '{}', NULL, p_detail);
END;
$$;

-- The ontology search log (20261005000000) also lands here (patched in place).
DO $$
DECLARE
  body TEXT := pg_get_functiondef('public.erp_log_access(uuid,text,text[],uuid,integer)'::regprocedure);
  anchor TEXT := 'VALUES (p_workspace_id, auth.uid(), p_action, COALESCE(p_object_types, ''{}''), p_object_id, p_result_count);';
BEGIN
  IF position('_data_access_insert' IN body) > 0 THEN RETURN; END IF;
  IF position(anchor IN body) = 0 THEN RAISE EXCEPTION 'Cannot patch erp_log_access: expected text not found'; END IF;
  EXECUTE replace(body, anchor, anchor || '
  PERFORM etna_platform._data_access_insert(p_workspace_id, auth.uid(), ''user'', ''ontology'',
    array_to_string(COALESCE(p_object_types, ''{}''), '',''), p_action, p_result_count, ''{}'', NULL,
    CASE WHEN p_object_id IS NULL THEN NULL ELSE jsonb_build_object(''object_id'', p_object_id) END);');
END;
$$;

-- The workspace's own log (members with 'audit'), newest first.
CREATE OR REPLACE FUNCTION public.erp_data_access_log(
  p_workspace_id UUID, p_before TIMESTAMPTZ DEFAULT NULL, p_limit INTEGER DEFAULT 100,
  p_actor UUID DEFAULT NULL, p_object_kind TEXT DEFAULT NULL)
RETURNS TABLE (occurred_at TIMESTAMPTZ, actor_email TEXT, actor_kind TEXT, object_kind TEXT, object_id TEXT,
               operation TEXT, rows INTEGER, fields_unmasked TEXT[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform, auth
AS $$
BEGIN
  IF NOT public.erp_has_permission(p_workspace_id, 'audit') THEN
    RAISE EXCEPTION 'You are not allowed to see this workspace''s access log' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT l.occurred_at, u.email, l.actor_kind, l.object_kind, l.object_id, l.operation, l.rows, l.fields_unmasked
    FROM etna_platform.data_access_log l
    LEFT JOIN auth.users u ON u.id = l.actor_id
   WHERE l.workspace_id = p_workspace_id
     AND (p_before IS NULL OR l.occurred_at < p_before)
     AND (p_actor IS NULL OR l.actor_id = p_actor)
     AND (p_object_kind IS NULL OR l.object_kind = p_object_kind)
   ORDER BY l.occurred_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_data_access_log(
  p_workspace_id UUID DEFAULT NULL, p_actor UUID DEFAULT NULL, p_before TIMESTAMPTZ DEFAULT NULL, p_limit INTEGER DEFAULT 100,
  p_actor_kind TEXT DEFAULT NULL)
RETURNS TABLE (occurred_at TIMESTAMPTZ, workspace_id UUID, workspace_name TEXT, actor_email TEXT, actor_kind TEXT,
               object_kind TEXT, object_id TEXT, operation TEXT, rows INTEGER, fields_unmasked TEXT[], ip TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  RETURN QUERY
  SELECT l.occurred_at, l.workspace_id, w.name, u.email, l.actor_kind, l.object_kind, l.object_id, l.operation, l.rows,
         l.fields_unmasked, l.ip
    FROM etna_platform.data_access_log l
    LEFT JOIN auth.users u ON u.id = l.actor_id
    LEFT JOIN public.erp_workspaces w ON w.id = l.workspace_id
   WHERE (p_workspace_id IS NULL OR l.workspace_id = p_workspace_id)
     AND (p_actor IS NULL OR l.actor_id = p_actor)
     AND (p_actor_kind IS NULL OR l.actor_kind = p_actor_kind)
     AND (p_before IS NULL OR l.occurred_at < p_before)
   ORDER BY l.occurred_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
END;
$$;

-- The nightly purge also covers this log (same function as 20261012000032, plus the data-access part).
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
  access_removed INTEGER := 0;
  platform_days INTEGER := etna_platform.effective_retention_days(NULL, 'security');
  access_platform_days INTEGER := etna_platform.effective_retention_days(NULL, 'data_access');
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

  PERFORM set_config('etna.data_access_purge', 'on', true);
  DELETE FROM etna_platform.data_access_log l
   WHERE NOT etna_platform.on_legal_hold(l.workspace_id)
     AND l.occurred_at < now() - make_interval(days => COALESCE(
           CASE WHEN l.workspace_id IS NULL THEN access_platform_days ELSE etna_platform.effective_retention_days(l.workspace_id, 'data_access') END,
           365000));
  GET DIAGNOSTICS access_removed = ROW_COUNT;
  PERFORM set_config('etna.data_access_purge', 'off', true);

  PERFORM etna_platform._log('RETENTION_PURGED', 'success', 'system', NULL, NULL, NULL,
    jsonb_build_object('security_events', security_removed, 'workspace_audit', audit_removed, 'runs', runs_removed,
                       'data_access', access_removed));
  RETURN jsonb_build_object('security_events', security_removed, 'workspace_audit', audit_removed, 'runs', runs_removed,
                            'data_access', access_removed);
END;
$$;

REVOKE ALL ON FUNCTION etna_platform.ensure_data_access_partitions(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION etna_platform._data_access_insert(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION etna_platform.log_data_access_system(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION etna_platform.purge_by_retention() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_log_data_access(UUID, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_data_access_log(UUID, TIMESTAMPTZ, INTEGER, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_data_access_log(UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_log_data_access(UUID, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_data_access_log(UUID, TIMESTAMPTZ, INTEGER, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_data_access_log(UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) TO authenticated;
