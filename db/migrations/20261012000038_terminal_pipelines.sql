-- TERMINAL pipelines: the existing workflows become pipelines in place
-- (decision R-03). Nothing is copied; the tables keep their names.
--
-- * workflows gains access (workspace / restricted, list in ps_item_grants)
--   and enabled (a disabled pipeline is not run by schedules or chains).
-- * Members read workspace pipelines with 'pipelines.view' (or the old ERP
--   'read'), and a restricted one only from its list.
-- * workflow_run_start accepts background runs (schedule, chain, background)
--   only while the worker holds a running 'pipeline.run' job for that
--   pipeline as that user; such runs are left out of the 5-minute clean-up
--   and of the three-runs-at-once limit, which are for runs in the editor.
-- * The worker closes a background run whose job it lost (worker_close_run).
--
-- Rollback: db/rollback/rollback_20261012000038_terminal_pipelines.sql

ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS access TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflows_access_check') THEN
    ALTER TABLE public.workflows ADD CONSTRAINT workflows_access_check CHECK (access IN ('workspace', 'restricted'));
  END IF;
END;
$$;

ALTER TABLE public.workflow_runs ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES public.ps_jobs(id) ON DELETE SET NULL;
ALTER TABLE public.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_triggered_by_check;
ALTER TABLE public.workflow_runs ADD CONSTRAINT workflow_runs_triggered_by_check
  CHECK (triggered_by IN ('manual', 'auto_refresh', 'schedule', 'chain', 'background'));

-- Whether the signed-in user may do `p_op` (view, edit, run) with a pipeline.
CREATE OR REPLACE FUNCTION public.ps_can_access_pipeline(p_pipeline_id UUID, p_op TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w public.workflows;
  role TEXT;
  needed TEXT := CASE p_op WHEN 'view' THEN 'pipelines.view' WHEN 'edit' THEN 'pipelines.edit' WHEN 'run' THEN 'pipelines.run' END;
  custom UUID;
BEGIN
  IF auth.uid() IS NULL OR needed IS NULL THEN RETURN false; END IF;
  SELECT * INTO w FROM public.workflows x WHERE x.id = p_pipeline_id;
  IF w.id IS NULL THEN RETURN false; END IF;
  IF w.user_id = auth.uid() THEN RETURN true; END IF;
  IF w.workspace_id IS NULL THEN RETURN false; END IF;
  role := public.erp_workspace_role(w.workspace_id);
  IF role IS NULL OR NOT public.erp_workspace_mfa_ok(w.workspace_id) THEN RETURN false; END IF;
  IF role = 'owner' THEN RETURN true; END IF;
  IF NOT (public.erp_has_permission(w.workspace_id, needed) OR (p_op = 'view' AND public.erp_has_permission(w.workspace_id, 'read'))) THEN
    RETURN false;
  END IF;
  IF w.access = 'workspace' THEN RETURN true; END IF;
  SELECT m.custom_role_id INTO custom FROM public.erp_workspace_members m
   WHERE m.workspace_id = w.workspace_id AND m.user_id = auth.uid() AND m.status = 'active';
  RETURN EXISTS (
    SELECT 1 FROM public.ps_item_grants g
     WHERE g.item_kind = 'pipeline' AND g.item_id = w.id AND needed = ANY(g.permissions)
       AND ((g.grantee_kind = 'member' AND g.grantee = auth.uid()::text)
         OR (g.grantee_kind = 'role' AND g.grantee = role)
         OR (g.grantee_kind = 'custom_role' AND custom IS NOT NULL AND g.grantee = custom::text)));
END;
$$;
REVOKE ALL ON FUNCTION public.ps_can_access_pipeline(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_can_access_pipeline(UUID, TEXT) TO authenticated;

DROP POLICY IF EXISTS workflows_member_read ON public.workflows;
CREATE POLICY workflows_member_read ON public.workflows FOR SELECT TO authenticated
  USING (workspace_id IS NOT NULL AND public.ps_can_access_pipeline(id, 'view'));

-- ps_set_item_access also changes a pipeline's access setting.
DO $$
DECLARE
  def TEXT := pg_get_functiondef('public.ps_set_item_access(text,uuid,text,jsonb)'::regprocedure);
  old_check TEXT := $q$    IF ws IS NULL OR NOT public.erp_has_permission(ws, 'pipelines.edit') THEN
      RAISE EXCEPTION 'You are not allowed to share this pipeline' USING ERRCODE = '42501';
    END IF;$q$;
BEGIN
  IF position('UPDATE public.workflows SET access' IN def) = 0 THEN
    IF position(old_check IN def) = 0 THEN RAISE EXCEPTION 'ps_set_item_access has changed; update this migration'; END IF;
    def := replace(def, old_check, $q$    IF ws IS NULL OR NOT public.ps_can_access_pipeline(p_item_id, 'edit') THEN
      RAISE EXCEPTION 'You are not allowed to share this pipeline' USING ERRCODE = '42501';
    END IF;
    UPDATE public.workflows SET access = p_access, updated_at = now() WHERE id = p_item_id;$q$);
    EXECUTE def;
  END IF;
END;
$$;

-- workflow__visible: the pipeline rules above.
DO $$
DECLARE
  def TEXT := pg_get_functiondef('public.workflow__visible(uuid)'::regprocedure);
  old_check TEXT := $q$     OR NOT (w.user_id = auth.uid()
             OR (w.workspace_id IS NOT NULL AND public.erp_has_permission(w.workspace_id, 'read'))) THEN$q$;
BEGIN
  IF position('ps_can_access_pipeline' IN def) = 0 THEN
    IF position(old_check IN def) = 0 THEN RAISE EXCEPTION 'workflow__visible has changed; update this migration'; END IF;
    EXECUTE replace(def, old_check, $q$     OR NOT public.ps_can_access_pipeline(w.id, 'view') THEN$q$);
  END IF;
END;
$$;

-- workflow_run_start: background runs, tied to the worker's job.
DO $$
DECLARE
  def TEXT := pg_get_functiondef('public.workflow_run_start(uuid,text,uuid,uuid,text,text)'::regprocedure);
  parts TEXT[][] := ARRAY[
    ARRAY[$q$  v_trigger TEXT := COALESCE(p_triggered_by, 'manual');$q$,
          $q$  v_trigger TEXT := COALESCE(p_triggered_by, 'manual');
  v_job UUID;$q$],
    ARRAY[$q$  IF v_trigger NOT IN ('manual', 'auto_refresh') THEN
    RAISE EXCEPTION 'Invalid run trigger' USING ERRCODE = '22023';
  END IF;$q$,
          $q$  IF v_trigger NOT IN ('manual', 'auto_refresh', 'schedule', 'chain', 'background') THEN
    RAISE EXCEPTION 'Invalid run trigger' USING ERRCODE = '22023';
  END IF;
  -- Background runs only come from the worker, holding the job for this pipeline.
  IF v_trigger NOT IN ('manual', 'auto_refresh') THEN
    SELECT j.id INTO v_job FROM public.ps_jobs j
     WHERE j.kind = 'pipeline.run' AND j.status = 'running' AND j.as_user = auth.uid()
       AND j.payload ->> 'pipeline_id' = w.id::text
     ORDER BY j.started_at DESC LIMIT 1;
    IF v_job IS NULL OR p_run_kind = 'draft' THEN
      RAISE EXCEPTION 'Background runs are started by the worker' USING ERRCODE = '42501';
    END IF;
  END IF;$q$],
    ARRAY[$q$  WHERE user_id = auth.uid() AND status IN ('queued', 'running') AND started_at < now() - interval '5 minutes';$q$,
          $q$  WHERE user_id = auth.uid() AND status IN ('queued', 'running') AND started_at < now() - interval '5 minutes'
    AND triggered_by IN ('manual', 'auto_refresh');$q$],
    ARRAY[$q$  SELECT count(*) INTO active_runs FROM public.workflow_runs
  WHERE user_id = auth.uid() AND status IN ('queued', 'running');
  IF active_runs >= 3 THEN$q$,
          $q$  SELECT count(*) INTO active_runs FROM public.workflow_runs
  WHERE user_id = auth.uid() AND status IN ('queued', 'running') AND triggered_by IN ('manual', 'auto_refresh');
  IF active_runs >= 3 AND v_job IS NULL THEN$q$],
    ARRAY[$q$    triggered_by, started_at
  ) VALUES ($q$, $q$    triggered_by, started_at, job_id
  ) VALUES ($q$],
    ARRAY[$q$    left(p_graph_hash, 128), v_trigger, now()
  )$q$, $q$    left(p_graph_hash, 128), v_trigger, now(), v_job
  )$q$]];
  i INTEGER;
BEGIN
  IF position('v_job UUID' IN def) > 0 THEN RETURN; END IF;
  FOR i IN 1 .. array_length(parts, 1) LOOP
    IF position(parts[i][1] IN def) = 0 THEN
      RAISE EXCEPTION 'workflow_run_start has changed (part %); update this migration', i;
    END IF;
    def := replace(def, parts[i][1], parts[i][2]);
  END LOOP;
  EXECUTE def;
END;
$$;

-- The worker closes the run of a job it gave up on (lost lease, cancelled, failed).
CREATE OR REPLACE FUNCTION ps_worker.close_pipeline_run(p_job_id UUID, p_error_code TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.workflow_runs
     SET status = CASE WHEN p_error_code = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
         error_code = left(p_error_code, 64), finished_at = now(),
         duration_ms = GREATEST(0, (extract(epoch FROM now() - started_at) * 1000)::integer)
   WHERE job_id = p_job_id AND status IN ('queued', 'running');
$$;

-- What the worker needs to run a pipeline: the version to run and whether it may.
CREATE OR REPLACE FUNCTION ps_worker.pipeline_for_run(p_pipeline_id UUID)
RETURNS TABLE (pipeline_id UUID, workspace_id UUID, name TEXT, enabled BOOLEAN, published_version_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT w.id, w.workspace_id, w.name, w.enabled, w.published_version_id FROM public.workflows w WHERE w.id = p_pipeline_id;
$$;

REVOKE ALL ON FUNCTION ps_worker.close_pipeline_run(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ps_worker.pipeline_for_run(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ps_worker.close_pipeline_run(UUID, TEXT) TO etna_worker;
GRANT EXECUTE ON FUNCTION ps_worker.pipeline_for_run(UUID) TO etna_worker;

-- Enabling and disabling a pipeline (schedules and chains skip a disabled one).
CREATE OR REPLACE FUNCTION public.ps_set_pipeline_enabled(p_pipeline_id UUID, p_enabled BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w public.workflows;
BEGIN
  SELECT * INTO w FROM public.workflows x WHERE x.id = p_pipeline_id FOR UPDATE;
  IF w.id IS NULL OR NOT public.ps_can_access_pipeline(w.id, 'view') THEN
    RAISE EXCEPTION 'Pipeline not found' USING ERRCODE = 'P0002';
  END IF;
  IF w.user_id <> auth.uid() AND (w.workspace_id IS NULL OR NOT public.erp_has_permission(w.workspace_id, 'pipelines.disable')) THEN
    RAISE EXCEPTION 'You are not allowed to switch this pipeline on or off' USING ERRCODE = '42501';
  END IF;
  UPDATE public.workflows SET enabled = p_enabled, updated_at = now() WHERE id = w.id;
  IF w.workspace_id IS NOT NULL THEN
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    VALUES (w.workspace_id, auth.uid(), CASE WHEN p_enabled THEN 'pipeline.enabled' ELSE 'pipeline.disabled' END,
            jsonb_build_object('pipeline_id', w.id, 'name', w.name));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.ps_set_pipeline_enabled(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_set_pipeline_enabled(UUID, BOOLEAN) TO authenticated;

-- Schedules and chains skip disabled pipelines.
DO $$
DECLARE
  def TEXT := pg_get_functiondef('ps_worker.due_schedules(integer)'::regprocedure);
BEGIN
  IF position('w.enabled' IN def) = 0 THEN
    IF position('s.enabled' IN def) = 0 THEN RAISE EXCEPTION 'due_schedules has changed; update this migration'; END IF;
    EXECUTE replace(def, 's.enabled', 's.enabled AND EXISTS (SELECT 1 FROM public.workflows w WHERE w.id = s.pipeline_id AND w.enabled)');
  END IF;
END;
$$;
DO $$
DECLARE
  def TEXT := pg_get_functiondef('ps_worker.downstream(uuid)'::regprocedure);
BEGIN
  IF position('w.enabled' IN def) = 0 THEN
    IF position('t.enabled' IN def) = 0 THEN RAISE EXCEPTION 'downstream has changed; update this migration'; END IF;
    EXECUTE replace(def, 't.enabled', 't.enabled AND EXISTS (SELECT 1 FROM public.workflows w WHERE w.id = t.downstream_id AND w.enabled)');
  END IF;
END;
$$;
