-- The Query Tool on an ERP's data (docs/teknis/TERMINAL.md, "Query Tool").
--
-- A third target beside a Terminal's datasets and its PostgreSQL
-- connections: an ERP, the Terminal's own (a Terminal inside an ERP) or one
-- a Terminal on its own is linked to (20261012000044). As with the datasets,
-- never PrintStream's database directly: the worker reads the ERP lists the
-- query names (the analytics catalog's tables and fields, src/lib/analytics/
-- catalog.ts) as the member, with their rights in that ERP (row-level
-- security, the ERP's permissions, its two-factor rule), into a PGlite of
-- its own, runs the query there read-only and discards it.
--
-- * ps_sql_runs.erp_workspace_id: the ERP of a run (NULL: datasets or a
--   connection, never both).
-- * ps_sql_run_start(…, p_erp_workspace_id): checks the ERP is the
--   Terminal's own or linked, that the member is a member of it and passes
--   its two-factor rule. The job is sql.datasets (datasets.query), as a run
--   on the datasets; the 4-argument form stays for the datasets and
--   connections.
-- * ps_worker.sql_run_begin also gives the run's ERP.
--
-- Rollback: db/rollback/rollback_20261025084448_terminal_query_erp.sql

ALTER TABLE public.ps_sql_runs
  ADD COLUMN IF NOT EXISTS erp_workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL;
ALTER TABLE public.ps_sql_runs DROP CONSTRAINT IF EXISTS ps_sql_runs_one_target;
ALTER TABLE public.ps_sql_runs ADD CONSTRAINT ps_sql_runs_one_target
  CHECK (connection_id IS NULL OR erp_workspace_id IS NULL);

-- A query to run: the run and its job. Both targets NULL: the datasets.
CREATE OR REPLACE FUNCTION public.ps_sql_run_start(
  p_workspace_id UUID, p_connection_id UUID, p_sql TEXT, p_mode TEXT, p_erp_workspace_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.ps_connections%ROWTYPE;
  e public.erp_workspaces%ROWTYPE;
  run_id UUID;
  job UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('run', 'explain', 'analyze') THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;
  IF p_connection_id IS NOT NULL AND p_erp_workspace_id IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;
  IF p_sql IS NULL OR char_length(btrim(p_sql)) = 0 THEN
    RAISE EXCEPTION 'The query is empty' USING ERRCODE = 'P0001', HINT = 'sql_empty';
  END IF;
  IF char_length(p_sql) > 100000 THEN
    RAISE EXCEPTION 'The query is too long' USING ERRCODE = 'P0001', HINT = 'sql_too_long';
  END IF;
  IF public.erp_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
  END IF;
  IF p_connection_id IS NOT NULL THEN
    SELECT * INTO c FROM public.ps_connections x WHERE x.id = p_connection_id AND x.workspace_id = p_workspace_id;
    IF c.id IS NULL OR c.kind <> 'postgres' THEN
      RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002';
    END IF;
    IF public.erp_session_aal() IS DISTINCT FROM 'aal2' THEN
      RAISE EXCEPTION 'Two-factor authentication is required' USING ERRCODE = '42501', HINT = 'mfa_required';
    END IF;
    IF NOT public.erp_has_permission(p_workspace_id, 'integrations.manage') THEN
      RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_erp_workspace_id IS NOT NULL THEN
    SELECT * INTO e FROM public.erp_workspaces w WHERE w.id = p_erp_workspace_id;
    -- The Terminal's own ERP, or one it is linked to.
    IF e.id IS NULL OR e.kind <> 'erp' OR NOT (
         e.id = p_workspace_id
         OR EXISTS (SELECT 1 FROM public.ps_erp_links l
                     WHERE l.workspace_id = p_workspace_id AND l.erp_workspace_id = e.id)) THEN
      RAISE EXCEPTION 'This ERP is not linked to this Terminal' USING ERRCODE = 'P0002', HINT = 'erp_not_linked';
    END IF;
    IF public.erp_workspace_role(e.id) IS NULL THEN
      RAISE EXCEPTION 'You are not a member of this ERP' USING ERRCODE = '42501', HINT = 'erp_not_member';
    END IF;
    IF NOT public.erp_workspace_mfa_ok(e.id) THEN
      RAISE EXCEPTION 'Two-factor authentication is required' USING ERRCODE = '42501', HINT = 'mfa_required';
    END IF;
  END IF;

  -- History: the newest 200 per member and Terminal; results for an hour.
  DELETE FROM public.ps_sql_runs r
   WHERE r.user_id = auth.uid() AND r.workspace_id = p_workspace_id
     AND r.id NOT IN (SELECT x.id FROM public.ps_sql_runs x
                       WHERE x.user_id = auth.uid() AND x.workspace_id = p_workspace_id
                       ORDER BY x.created_at DESC LIMIT 199);
  UPDATE public.ps_sql_runs r SET rows = NULL, error = NULL, messages = NULL, notifications = NULL
   WHERE r.user_id = auth.uid() AND r.created_at < now() - interval '1 hour'
     AND (r.rows IS NOT NULL OR r.error IS NOT NULL OR r.messages IS NOT NULL);

  INSERT INTO public.ps_sql_runs (workspace_id, user_id, connection_id, erp_workspace_id, target_name, sql, mode)
  VALUES (p_workspace_id, auth.uid(), c.id, e.id, COALESCE(left(c.name, 200), left(e.name, 200), ''), p_sql, p_mode)
  RETURNING id INTO run_id;
  job := public.ps_enqueue_job(
    p_workspace_id,
    CASE WHEN c.id IS NULL THEN 'sql.datasets' ELSE 'sql.connection' END,
    jsonb_build_object('run_id', run_id)
  );
  UPDATE public.ps_sql_runs SET job_id = job WHERE id = run_id;
  RETURN run_id;
END;
$$;

-- The datasets or a connection, as before.
CREATE OR REPLACE FUNCTION public.ps_sql_run_start(
  p_workspace_id UUID, p_connection_id UUID, p_sql TEXT, p_mode TEXT
)
RETURNS UUID
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT public.ps_sql_run_start(p_workspace_id, p_connection_id, p_sql, p_mode, NULL::uuid);
$$;

-- The run of a job, now running (or NULL when it is not this job's, or done).
CREATE OR REPLACE FUNCTION ps_worker.sql_run_begin(p_run_id UUID, p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r public.ps_sql_runs%ROWTYPE;
BEGIN
  UPDATE public.ps_sql_runs x SET status = 'running', started_at = now()
   WHERE x.id = p_run_id AND x.job_id = p_job_id AND x.status IN ('queued', 'running')
  RETURNING * INTO r;
  IF r.id IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id', r.id, 'workspace_id', r.workspace_id, 'user_id', r.user_id,
                            'connection_id', r.connection_id, 'erp_workspace_id', r.erp_workspace_id,
                            'sql', r.sql, 'mode', r.mode);
END;
$$;

REVOKE ALL ON FUNCTION public.ps_sql_run_start(UUID, UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_sql_run_start(UUID, UUID, TEXT, TEXT, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.ps_sql_run_start(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_sql_run_start(UUID, UUID, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION ps_worker.sql_run_begin(UUID, UUID) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_worker') THEN
    GRANT EXECUTE ON FUNCTION ps_worker.sql_run_begin(UUID, UUID) TO etna_worker;
  END IF;
END;
$$;
