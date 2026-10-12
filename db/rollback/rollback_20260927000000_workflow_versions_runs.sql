-- Rollback for 20260927000000_workflow_versions_runs.sql.
-- Run only after redeploying an app version that does not use workflow
-- versions or the run RPCs. Workflow definitions and run rows are kept; this
-- drops saved versions, the published-version link, workspace sharing of
-- workflows and the extra run metadata columns.

BEGIN;

DROP FUNCTION IF EXISTS public.workflow_run_cancel_requested(UUID);
DROP FUNCTION IF EXISTS public.workflow_run_cancel(UUID);
DROP FUNCTION IF EXISTS public.workflow_run_finish(UUID, TEXT, JSONB, JSONB, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.workflow_run_start(UUID, TEXT, UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.workflow_publish_version(UUID, UUID);
DROP FUNCTION IF EXISTS public.workflow_save_version(UUID, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.workflow__visible(UUID);

DROP POLICY IF EXISTS workflow_runs_member_read ON public.workflow_runs;
DROP POLICY IF EXISTS workflows_member_read ON public.workflows;
DROP TRIGGER IF EXISTS trg_workflow_guard ON public.workflows;
DROP FUNCTION IF EXISTS public.workflow_guard();

-- Runs recorded with the new statuses are mapped onto the old ones first.
UPDATE public.workflow_runs SET status = 'failed' WHERE status IN ('queued', 'running', 'cancelled');
ALTER TABLE public.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_status_check;
ALTER TABLE public.workflow_runs ADD CONSTRAINT workflow_runs_status_check CHECK (status IN ('running', 'success', 'failed'));
DROP INDEX IF EXISTS public.idx_workflow_runs_request;
DROP INDEX IF EXISTS public.idx_workflow_runs_active;
ALTER TABLE public.workflow_runs
  DROP COLUMN IF EXISTS cancel_requested_at,
  DROP COLUMN IF EXISTS error_code,
  DROP COLUMN IF EXISTS quality,
  DROP COLUMN IF EXISTS row_count,
  DROP COLUMN IF EXISTS graph_hash,
  DROP COLUMN IF EXISTS request_id,
  DROP COLUMN IF EXISTS triggered_by,
  DROP COLUMN IF EXISTS run_kind,
  DROP COLUMN IF EXISTS version,
  DROP COLUMN IF EXISTS version_id,
  DROP COLUMN IF EXISTS workspace_id;

ALTER TABLE public.workflows DROP CONSTRAINT IF EXISTS workflows_published_version_fk;
DROP TABLE IF EXISTS public.workflow_versions;
DROP INDEX IF EXISTS public.idx_workflows_workspace_updated;
ALTER TABLE public.workflows
  DROP COLUMN IF EXISTS duplicated_from,
  DROP COLUMN IF EXISTS published_version_id,
  DROP COLUMN IF EXISTS workspace_id;

COMMIT;
