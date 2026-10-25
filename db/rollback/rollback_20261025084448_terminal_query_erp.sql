-- Rollback of 20261025084448: Query Tool runs on an ERP go, the run
-- functions are as in 20261012000058.

DELETE FROM public.ps_sql_runs WHERE erp_workspace_id IS NOT NULL;
DROP FUNCTION IF EXISTS public.ps_sql_run_start(UUID, UUID, TEXT, TEXT, UUID);
ALTER TABLE public.ps_sql_runs DROP CONSTRAINT IF EXISTS ps_sql_runs_one_target;
ALTER TABLE public.ps_sql_runs DROP COLUMN IF EXISTS erp_workspace_id;

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
REVOKE ALL ON FUNCTION public.ps_sql_run_start(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_sql_run_start(UUID, UUID, TEXT, TEXT) TO authenticated;

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
