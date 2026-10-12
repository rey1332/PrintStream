-- ─── Workflows: workspace sharing, immutable versions, server-recorded runs ───
-- Additive and backward compatible:
--   • workflows gain a workspace (backfilled to the creator's personal
--     workspace), a published version and a "duplicated from" link. Existing
--     owner policies are unchanged; workspace members get read access.
--   • workflow_versions holds immutable snapshots, written only by RPCs.
--   • workflow_runs gains version, run kind, idempotency key, data-quality
--     summary and cancellation fields. The status list is widened, never
--     narrowed, so rows and inserts from older app versions stay valid.
--   • Run lifecycle RPCs record start/finish with server timestamps, expire
--     runs abandoned by a timed-out function and cap concurrent runs.
-- Nothing here reads or copies ERP data.
--
-- Rollback: supabase/snippets/rollback_20260927000000_workflow_versions_runs.sql

-- ─── 1. workflows ─────────────────────────────────────────────────────────────

ALTER TABLE public.workflows
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS published_version_id UUID,
  ADD COLUMN IF NOT EXISTS duplicated_from UUID REFERENCES public.workflows(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workflows_workspace_updated
  ON public.workflows(workspace_id, updated_at DESC);

-- Existing workflows belong to their creator's personal workspace (if it
-- exists). Only the creator can see them, exactly as before.
UPDATE public.workflows w
SET workspace_id = ws.id
FROM public.erp_workspaces ws
WHERE w.workspace_id IS NULL
  AND ws.owner_id = w.user_id
  AND ws.is_personal;

-- ─── 2. workflow_versions ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.workflow_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  graph JSONB NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version),
  CHECK (octet_length(graph::text) <= 1048576)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow
  ON public.workflow_versions(workflow_id, version DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflows_published_version_fk') THEN
    ALTER TABLE public.workflows
      ADD CONSTRAINT workflows_published_version_fk
      FOREIGN KEY (published_version_id) REFERENCES public.workflow_versions(id) ON DELETE SET NULL;
  END IF;
END;
$$;

ALTER TABLE public.workflow_versions ENABLE ROW LEVEL SECURITY;

-- Versions are visible to whoever can see the workflow (the subquery applies
-- the workflows policies). They are immutable: no write policies, no grants.
DROP POLICY IF EXISTS workflow_versions_read ON public.workflow_versions;
CREATE POLICY workflow_versions_read ON public.workflow_versions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.workflows w WHERE w.id = workflow_id));

REVOKE ALL ON public.workflow_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.workflow_versions TO authenticated;

-- ─── 3. Workspace rules for workflows ─────────────────────────────────────────

-- New workflows without a workspace (older app versions) go to the creator's
-- personal workspace. A workflow can only be placed in a workspace the
-- signed-in user belongs to, and can only publish one of its own versions.
CREATE OR REPLACE FUNCTION public.workflow_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.workspace_id IS NULL THEN
    NEW.workspace_id := public.erp_personal_workspace_id(NEW.user_id);
  END IF;

  IF NEW.workspace_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id)
     AND auth.uid() IS NOT NULL
     AND NOT public.erp_has_permission(NEW.workspace_id, 'read') THEN
    RAISE EXCEPTION 'Workflow workspace is not available' USING ERRCODE = '42501';
  END IF;

  IF NEW.published_version_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.published_version_id IS DISTINCT FROM OLD.published_version_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.workflow_versions v
       WHERE v.id = NEW.published_version_id AND v.workflow_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'Published version does not belong to this workflow' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.workflow_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_workflow_guard ON public.workflows;
CREATE TRIGGER trg_workflow_guard
  BEFORE INSERT OR UPDATE OF workspace_id, published_version_id ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.workflow_guard();

-- Members of a workspace can open, run and duplicate its workflows. Editing
-- stays with the creator (existing users_manage_own_workflows policy).
DROP POLICY IF EXISTS workflows_member_read ON public.workflows;
CREATE POLICY workflows_member_read ON public.workflows
  FOR SELECT TO authenticated
  USING (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, 'read'));

-- ─── 4. workflow_runs ─────────────────────────────────────────────────────────

ALTER TABLE public.workflow_runs
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version_id UUID REFERENCES public.workflow_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version INTEGER,
  ADD COLUMN IF NOT EXISTS run_kind TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS triggered_by TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS request_id UUID,
  ADD COLUMN IF NOT EXISTS graph_hash TEXT,
  ADD COLUMN IF NOT EXISTS row_count INTEGER,
  ADD COLUMN IF NOT EXISTS quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_run_kind_check') THEN
    ALTER TABLE public.workflow_runs
      ADD CONSTRAINT workflow_runs_run_kind_check CHECK (run_kind IN ('draft', 'published', 'version'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_triggered_by_check') THEN
    ALTER TABLE public.workflow_runs
      ADD CONSTRAINT workflow_runs_triggered_by_check CHECK (triggered_by IN ('manual'));
  END IF;
END;
$$;

-- Widen the status list (old values stay valid).
ALTER TABLE public.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_status_check;
ALTER TABLE public.workflow_runs
  ADD CONSTRAINT workflow_runs_status_check
  CHECK (status IN ('queued', 'running', 'success', 'failed', 'cancelled'));

-- One run per (workflow, user, request): retries of the same request reuse it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_request
  ON public.workflow_runs(workflow_id, user_id, request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_active
  ON public.workflow_runs(user_id, status)
  WHERE status IN ('queued', 'running');

-- Anyone who can see a workflow can see its run history (metadata only).
DROP POLICY IF EXISTS workflow_runs_member_read ON public.workflow_runs;
CREATE POLICY workflow_runs_member_read ON public.workflow_runs
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.workflows w WHERE w.id = workflow_id));

-- ─── 5. Helpers ───────────────────────────────────────────────────────────────

-- The workflow if the signed-in user may see it (owner or workspace member).
CREATE OR REPLACE FUNCTION public.workflow__visible(p_workflow_id UUID)
RETURNS public.workflows
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.workflow__visible(UUID) FROM PUBLIC, anon, authenticated;

-- ─── 6. Versions ──────────────────────────────────────────────────────────────

-- Snapshots the saved draft as the next version; optionally publishes it.
CREATE OR REPLACE FUNCTION public.workflow_save_version(p_workflow_id UUID, p_note TEXT, p_publish BOOLEAN)
RETURNS public.workflow_versions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w public.workflows;
  v public.workflow_versions;
  next_version INTEGER;
BEGIN
  SELECT * INTO w FROM public.workflows WHERE id = p_workflow_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR w.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Workflow not found' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(MAX(version), 0) + 1 INTO next_version
  FROM public.workflow_versions WHERE workflow_id = w.id;

  INSERT INTO public.workflow_versions (workflow_id, version, name, graph, note, created_by)
  VALUES (w.id, next_version, w.name, w.graph, left(COALESCE(p_note, ''), 500), auth.uid())
  RETURNING * INTO v;

  IF COALESCE(p_publish, false) THEN
    UPDATE public.workflows SET published_version_id = v.id WHERE id = w.id;
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.workflow_publish_version(p_workflow_id UUID, p_version_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE w public.workflows;
BEGIN
  SELECT * INTO w FROM public.workflows WHERE id = p_workflow_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR w.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Workflow not found' USING ERRCODE = '42501';
  END IF;
  -- workflow_guard() rejects a version of another workflow.
  UPDATE public.workflows SET published_version_id = p_version_id WHERE id = w.id;
END;
$$;

-- ─── 7. Run lifecycle ─────────────────────────────────────────────────────────

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

-- Records the outcome once; later calls for a finished run change nothing.
CREATE OR REPLACE FUNCTION public.workflow_run_finish(
  p_run_id UUID, p_status TEXT, p_node_results JSONB, p_quality JSONB, p_row_count INTEGER,
  p_error_code TEXT, p_error TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.workflow_runs;
BEGIN
  SELECT * INTO r FROM public.workflow_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR r.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Run not found' USING ERRCODE = '42501';
  END IF;
  IF r.status NOT IN ('queued', 'running') THEN
    RETURN r.status;
  END IF;
  IF p_status NOT IN ('success', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid run status' USING ERRCODE = '22023';
  END IF;

  UPDATE public.workflow_runs SET
    status = p_status,
    finished_at = now(),
    duration_ms = GREATEST(0, (extract(epoch FROM now() - r.started_at) * 1000)::INTEGER),
    -- Run history keeps per-node metadata only, never result rows.
    node_results = CASE WHEN octet_length(COALESCE(p_node_results, '{}'::jsonb)::text) <= 262144
                        THEN COALESCE(p_node_results, '{}'::jsonb) ELSE '{}'::jsonb END,
    quality = CASE WHEN octet_length(COALESCE(p_quality, '{}'::jsonb)::text) <= 65536
                   THEN COALESCE(p_quality, '{}'::jsonb) ELSE '{}'::jsonb END,
    row_count = p_row_count,
    error_code = left(p_error_code, 64),
    error = left(p_error, 2000)
  WHERE id = r.id;
  RETURN p_status;
END;
$$;

-- The runner or the workflow's creator can ask a running run to stop.
CREATE OR REPLACE FUNCTION public.workflow_run_cancel(p_run_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.workflow_runs;
BEGIN
  SELECT * INTO r FROM public.workflow_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT (
    r.user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.workflows w WHERE w.id = r.workflow_id AND w.user_id = auth.uid())
  ) THEN
    RAISE EXCEPTION 'Run not found' USING ERRCODE = '42501';
  END IF;
  IF r.status = 'queued' THEN
    UPDATE public.workflow_runs SET status = 'cancelled', finished_at = now(), cancel_requested_at = now() WHERE id = r.id;
    RETURN 'cancelled';
  ELSIF r.status = 'running' THEN
    UPDATE public.workflow_runs SET cancel_requested_at = COALESCE(cancel_requested_at, now()) WHERE id = r.id;
  END IF;
  RETURN r.status;
END;
$$;

CREATE OR REPLACE FUNCTION public.workflow_run_cancel_requested(p_run_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cancel_requested_at IS NOT NULL FROM public.workflow_runs
  WHERE id = p_run_id AND user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.workflow_save_version(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_publish_version(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_run_start(UUID, TEXT, UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_run_finish(UUID, TEXT, JSONB, JSONB, INTEGER, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_run_cancel(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_run_cancel_requested(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workflow_save_version(UUID, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_publish_version(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_run_start(UUID, TEXT, UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_run_finish(UUID, TEXT, JSONB, JSONB, INTEGER, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_run_cancel(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_run_cancel_requested(UUID) TO authenticated;
