-- Rollback for 20261004000000_workflow_auto_refresh.sql.
-- Run only after redeploying an app version without auto-refresh. Removes the
-- history rows of auto-refresh runs (metadata only; manual runs are kept) and
-- restores the five-argument workflow_run_start.

BEGIN;

DROP FUNCTION IF EXISTS public.workflow_run_start(UUID, TEXT, UUID, UUID, TEXT, TEXT);
DROP INDEX IF EXISTS public.idx_workflow_runs_auto_refresh;
DELETE FROM public.workflow_runs WHERE triggered_by = 'auto_refresh';
ALTER TABLE public.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_triggered_by_check;
ALTER TABLE public.workflow_runs
  ADD CONSTRAINT workflow_runs_triggered_by_check CHECK (triggered_by IN ('manual'));

CREATE OR REPLACE FUNCTION public.workflow_run_start(
  p_workflow_id UUID, p_run_kind TEXT, p_version_id UUID, p_request_id UUID, p_graph_hash TEXT
)
RETURNS TABLE (run_id UUID, created BOOLEAN, run_status TEXT, run_version INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w public.workflows;
  v_number INTEGER;
  existing RECORD;
  active_runs INTEGER;
  new_id UUID;
BEGIN
  w := public.workflow__visible(p_workflow_id);
  IF p_run_kind NOT IN ('draft', 'published', 'version') THEN
    RAISE EXCEPTION 'Invalid run kind' USING ERRCODE = '22023';
  END IF;
  IF (p_run_kind = 'draft') <> (p_version_id IS NULL) THEN
    RAISE EXCEPTION 'Invalid run version' USING ERRCODE = '22023';
  END IF;
  IF p_version_id IS NOT NULL THEN
    SELECT version INTO v_number FROM public.workflow_versions
    WHERE id = p_version_id AND workflow_id = w.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Version not found' USING ERRCODE = '42501'; END IF;
  END IF;

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

  SELECT count(*) INTO active_runs FROM public.workflow_runs
  WHERE user_id = auth.uid() AND status IN ('queued', 'running');
  IF active_runs >= 3 THEN
    RAISE EXCEPTION 'Too many workflow runs in progress' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.workflow_runs (
    workflow_id, user_id, workspace_id, status, run_kind, version_id, version, request_id, graph_hash, started_at
  ) VALUES (
    w.id, auth.uid(), w.workspace_id, 'running', p_run_kind, p_version_id, v_number, p_request_id,
    left(p_graph_hash, 128), now()
  )
  RETURNING id INTO new_id;

  RETURN QUERY SELECT new_id, true, 'running'::TEXT, v_number;
END;
$$;

REVOKE ALL ON FUNCTION public.workflow_run_start(UUID, TEXT, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workflow_run_start(UUID, TEXT, UUID, UUID, TEXT) TO authenticated;

COMMIT;
