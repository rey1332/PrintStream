-- The Terminal's Query Tool (docs/TERMINAL.md, "Query Tool"): read-only SQL
-- by a member, run by the worker, with its result and history kept for the
-- member only.
--
-- Two targets, never PrintStream's own database directly (the session
-- settings that row-level security relies on could be changed by SQL):
--
-- * "sql.datasets": this Terminal's datasets. The worker reads the datasets
--   the query names, as the member (masking and dataset access as in the
--   app, in the data-access log), into a new in-memory PostgreSQL (PGlite)
--   in its own thread, runs the query there read-only and discards it.
--   Needs datasets.query.
-- * "sql.connection": one of the Terminal's PostgreSQL connections, in a
--   read-only transaction with a time limit (src/server/connectors/postgres.ts).
--   A query can read anything that database user may, so it needs what
--   describing a query of the connection needs: integrations.manage, in a
--   two-factor session.
--
-- ps_sql_runs keeps each run: the SQL, its state and, for an hour, its result
-- (at most 2,000 rows) and error message; then only the SQL and the numbers
-- stay (Query History, the newest 200 per member and Terminal). Only the
-- member reads their runs; only the worker writes results.
--
-- Rollback: db/rollback/rollback_20261012000058_terminal_query_tool.sql

CREATE TABLE IF NOT EXISTS public.ps_sql_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  -- NULL: the Terminal's datasets.
  connection_id UUID REFERENCES public.ps_connections(id) ON DELETE SET NULL,
  target_name TEXT NOT NULL DEFAULT '' CHECK (char_length(target_name) <= 200),
  sql TEXT NOT NULL CHECK (char_length(sql) BETWEEN 1 AND 100000),
  mode TEXT NOT NULL CHECK (mode IN ('run', 'explain', 'analyze')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  job_id UUID REFERENCES public.ps_jobs(id) ON DELETE SET NULL,
  columns JSONB,
  rows JSONB CHECK (rows IS NULL OR pg_column_size(rows) <= 24000000),
  row_count INTEGER,
  truncated TEXT CHECK (truncated IS NULL OR truncated IN ('rows', 'size')),
  messages JSONB CHECK (messages IS NULL OR pg_column_size(messages) <= 262144),
  notifications JSONB CHECK (notifications IS NULL OR pg_column_size(notifications) <= 262144),
  error JSONB CHECK (error IS NULL OR pg_column_size(error) <= 16384),
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ps_sql_runs_member ON public.ps_sql_runs (user_id, workspace_id, created_at DESC);

ALTER TABLE public.ps_sql_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ps_sql_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ps_sql_runs TO authenticated;
DROP POLICY IF EXISTS ps_sql_runs_own ON public.ps_sql_runs;
CREATE POLICY ps_sql_runs_own ON public.ps_sql_runs FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND public.erp_workspace_role(workspace_id) IS NOT NULL);
DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.ps_sql_runs;
CREATE POLICY erp_workspace_not_suspended ON public.ps_sql_runs AS RESTRICTIVE FOR ALL TO authenticated
  USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]));

-- ─── Jobs: who may start a query ─────────────────────────────────────────────

-- As in 20261012000049, and the Query Tool's two jobs.
CREATE OR REPLACE FUNCTION public.ps_job_permission(p_kind TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_kind
    WHEN 'dataset.provision' THEN 'datasets.schema'
    WHEN 'dataset.alter' THEN 'datasets.schema'
    WHEN 'dataset.delete' THEN 'datasets.delete'
    WHEN 'dataset.export' THEN 'datasets.export'
    WHEN 'import.analyze' THEN 'datasets.import'
    WHEN 'import.commit' THEN 'datasets.import'
    WHEN 'pipeline.run' THEN 'pipelines.run'
    WHEN 'connector.test' THEN 'integrations.use'
    WHEN 'connector.sync' THEN 'integrations.use'
    WHEN 'connector.oauth' THEN 'integrations.manage'
    WHEN 'connector.describe' THEN 'integrations.use'
    WHEN 'ai.test' THEN 'integrations.manage'
    WHEN 'ai.analyze' THEN 'datasets.query'
    WHEN 'sql.datasets' THEN 'datasets.query'
    WHEN 'sql.connection' THEN 'integrations.manage'
    ELSE NULL
  END;
$$;
REVOKE ALL ON FUNCTION public.ps_job_permission(TEXT) FROM PUBLIC, anon, authenticated;

-- ─── The member ──────────────────────────────────────────────────────────────

-- A query to run: the run and its job. p_connection_id NULL: the datasets.
CREATE OR REPLACE FUNCTION public.ps_sql_run_start(
  p_workspace_id UUID, p_connection_id UUID, p_sql TEXT, p_mode TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.ps_connections%ROWTYPE;
  run_id UUID;
  job UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('run', 'explain', 'analyze') THEN
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

  -- History: the newest 200 per member and Terminal; results for an hour.
  DELETE FROM public.ps_sql_runs r
   WHERE r.user_id = auth.uid() AND r.workspace_id = p_workspace_id
     AND r.id NOT IN (SELECT x.id FROM public.ps_sql_runs x
                       WHERE x.user_id = auth.uid() AND x.workspace_id = p_workspace_id
                       ORDER BY x.created_at DESC LIMIT 199);
  UPDATE public.ps_sql_runs r SET rows = NULL, error = NULL, messages = NULL, notifications = NULL
   WHERE r.user_id = auth.uid() AND r.created_at < now() - interval '1 hour'
     AND (r.rows IS NOT NULL OR r.error IS NOT NULL OR r.messages IS NOT NULL);

  INSERT INTO public.ps_sql_runs (workspace_id, user_id, connection_id, target_name, sql, mode)
  VALUES (p_workspace_id, auth.uid(), c.id, COALESCE(left(c.name, 200), ''), p_sql, p_mode)
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

-- ─── The worker ──────────────────────────────────────────────────────────────

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
                            'connection_id', r.connection_id, 'sql', r.sql, 'mode', r.mode);
END;
$$;

CREATE OR REPLACE FUNCTION ps_worker.sql_run_finish(
  p_run_id UUID, p_status TEXT, p_columns JSONB, p_rows JSONB, p_row_count INTEGER, p_truncated TEXT,
  p_messages JSONB, p_notifications JSONB, p_error JSONB, p_duration_ms INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_status NOT IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid status' USING ERRCODE = '22023';
  END IF;
  UPDATE public.ps_sql_runs
     SET status = p_status, columns = p_columns, rows = p_rows, row_count = p_row_count, truncated = p_truncated,
         messages = p_messages, notifications = p_notifications, error = p_error, duration_ms = p_duration_ms,
         finished_at = now()
   WHERE id = p_run_id AND status IN ('queued', 'running');
END;
$$;

-- ─── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.ps_sql_run_start(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_sql_run_start(UUID, UUID, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION ps_worker.sql_run_begin(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ps_worker.sql_run_finish(UUID, TEXT, JSONB, JSONB, INTEGER, TEXT, JSONB, JSONB, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_worker') THEN
    GRANT EXECUTE ON FUNCTION ps_worker.sql_run_begin(UUID, UUID) TO etna_worker;
    GRANT EXECUTE ON FUNCTION ps_worker.sql_run_finish(UUID, TEXT, JSONB, JSONB, INTEGER, TEXT, JSONB, JSONB, JSONB, INTEGER) TO etna_worker;
  END IF;
END;
$$;
