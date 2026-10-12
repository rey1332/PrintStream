-- Rollback for 20261012000038_terminal_pipelines.sql.
-- Run only after redeploying an app version from before this change, with
-- the worker stopped. Background run history stays; its trigger becomes 'manual'.

BEGIN;
DROP FUNCTION IF EXISTS public.ps_set_pipeline_enabled(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS ps_worker.pipeline_for_run(UUID);
DROP FUNCTION IF EXISTS ps_worker.close_pipeline_run(UUID, TEXT);

-- As before this migration: public.workflow__visible(uuid)
CREATE OR REPLACE FUNCTION public.workflow__visible(p_workflow_id uuid)
 RETURNS workflows
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE w public.workflows;
BEGIN
  SELECT * INTO w FROM public.workflows WHERE id = p_workflow_id;
  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT (w.user_id = auth.uid()
             OR (w.workspace_id IS NOT NULL AND public.erp_has_permission(w.workspace_id, 'read'))) THEN
    RAISE EXCEPTION 'Workflow not found' USING ERRCODE = '42501';
  END IF;
  RETURN w;
END;
$function$;

-- As before this migration: public.workflow_run_start(uuid,text,uuid,uuid,text,text)
CREATE OR REPLACE FUNCTION public.workflow_run_start(p_workflow_id uuid, p_run_kind text, p_version_id uuid, p_request_id uuid, p_graph_hash text, p_triggered_by text DEFAULT 'manual'::text)
 RETURNS TABLE(run_id uuid, created boolean, run_status text, run_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  w public.workflows;
  v_number INTEGER;
  existing RECORD;
  active_runs INTEGER;
  new_id UUID;
  v_trigger TEXT := COALESCE(p_triggered_by, 'manual');
BEGIN
  w := public.workflow__visible(p_workflow_id);
  IF p_run_kind NOT IN ('draft', 'published', 'version') THEN
    RAISE EXCEPTION 'Invalid run kind' USING ERRCODE = '22023';
  END IF;
  IF v_trigger NOT IN ('manual', 'auto_refresh') THEN
    RAISE EXCEPTION 'Invalid run trigger' USING ERRCODE = '22023';
  END IF;
  IF (p_run_kind = 'draft') <> (p_version_id IS NULL) THEN
    RAISE EXCEPTION 'Invalid run version' USING ERRCODE = '22023';
  END IF;
  IF p_version_id IS NOT NULL THEN
    SELECT version INTO v_number FROM public.workflow_versions
    WHERE id = p_version_id AND workflow_id = w.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Version not found' USING ERRCODE = '42501'; END IF;
  END IF;

  -- Runs whose server function was stopped (e.g. by a platform time limit)
  -- never report back; close them so history does not show them as running.
  UPDATE public.workflow_runs
  SET status = 'failed', error_code = 'abandoned', error = 'The run did not finish.', finished_at = now()
  WHERE user_id = auth.uid() AND status IN ('queued', 'running') AND started_at < now() - interval '5 minutes';

  IF p_request_id IS NOT NULL THEN
    SELECT r.id, r.status, r.version INTO existing FROM public.workflow_runs r
    WHERE r.workflow_id = w.id AND r.user_id = auth.uid() AND r.request_id = p_request_id;
    IF FOUND THEN
      RETURN QUERY SELECT existing.id, false, existing.status, existing.version;
      RETURN;
    END IF;
  END IF;

  IF v_trigger = 'auto_refresh' THEN
    IF EXISTS (
      SELECT 1 FROM public.workflow_runs r
      WHERE r.workflow_id = w.id AND r.user_id = auth.uid() AND r.triggered_by = 'auto_refresh'
        AND r.started_at > now() - interval '45 seconds'
    ) THEN
      RAISE EXCEPTION 'Auto-refresh too soon' USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM public.workflow_runs
    WHERE id IN (
      SELECT r.id FROM public.workflow_runs r
      WHERE r.workflow_id = w.id AND r.user_id = auth.uid() AND r.triggered_by = 'auto_refresh'
        AND r.status NOT IN ('queued', 'running')
      ORDER BY r.started_at DESC
      OFFSET 99
    );
  END IF;

  SELECT count(*) INTO active_runs FROM public.workflow_runs
  WHERE user_id = auth.uid() AND status IN ('queued', 'running');
  IF active_runs >= 3 THEN
    RAISE EXCEPTION 'Too many workflow runs in progress' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.workflow_runs (
    workflow_id, user_id, workspace_id, status, run_kind, version_id, version, request_id, graph_hash,
    triggered_by, started_at
  ) VALUES (
    w.id, auth.uid(), w.workspace_id, 'running', p_run_kind, p_version_id, v_number, p_request_id,
    left(p_graph_hash, 128), v_trigger, now()
  )
  RETURNING id INTO new_id;

  RETURN QUERY SELECT new_id, true, 'running'::TEXT, v_number;
END;
$function$;

DO $$
DECLARE
  def TEXT;
BEGIN
  def := pg_get_functiondef('ps_worker.due_schedules(integer)'::regprocedure);
  EXECUTE replace(def, 's.enabled AND EXISTS (SELECT 1 FROM public.workflows w WHERE w.id = s.pipeline_id AND w.enabled)', 's.enabled');
  def := pg_get_functiondef('ps_worker.downstream(uuid)'::regprocedure);
  EXECUTE replace(def, 't.enabled AND EXISTS (SELECT 1 FROM public.workflows w WHERE w.id = t.downstream_id AND w.enabled)', 't.enabled');
  def := pg_get_functiondef('public.ps_set_item_access(text,uuid,text,jsonb)'::regprocedure);
  def := replace(def, $q$
    UPDATE public.workflows SET access = p_access, updated_at = now() WHERE id = p_item_id;$q$, '');
  EXECUTE replace(def, $q$public.ps_can_access_pipeline(p_item_id, 'edit')$q$, $q$public.erp_has_permission(ws, 'pipelines.edit')$q$);
END;
$$;

DROP POLICY IF EXISTS workflows_member_read ON public.workflows;
CREATE POLICY workflows_member_read ON public.workflows FOR SELECT TO authenticated
  USING (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, 'read'));
DROP FUNCTION IF EXISTS public.ps_can_access_pipeline(UUID, TEXT);

UPDATE public.workflow_runs SET triggered_by = 'manual' WHERE triggered_by NOT IN ('manual', 'auto_refresh');
ALTER TABLE public.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_triggered_by_check;
ALTER TABLE public.workflow_runs ADD CONSTRAINT workflow_runs_triggered_by_check CHECK (triggered_by IN ('manual', 'auto_refresh'));
ALTER TABLE public.workflow_runs DROP COLUMN IF EXISTS job_id;
ALTER TABLE public.workflows DROP CONSTRAINT IF EXISTS workflows_access_check;
ALTER TABLE public.workflows DROP COLUMN IF EXISTS enabled;
ALTER TABLE public.workflows DROP COLUMN IF EXISTS access;
COMMIT;
