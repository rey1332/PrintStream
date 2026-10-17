-- Rollback for 20261012000055_terminal_jobs_health_mcp.sql.
-- Run only after redeploying an app version from before this change.
-- MCP access tokens are removed (MCP clients stop working at once); jobs
-- keep their history but lose who cancelled them and what they retried.

BEGIN;

-- As in 20261012000035.
CREATE OR REPLACE FUNCTION public.ps_cancel_job(p_job_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j public.ps_jobs;
BEGIN
  SELECT * INTO j FROM public.ps_jobs x WHERE x.id = p_job_id FOR UPDATE;
  IF j.id IS NULL OR public.erp_workspace_role(j.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF j.created_by IS DISTINCT FROM auth.uid() AND NOT public.erp_has_permission(j.workspace_id, 'pipelines.disable') THEN
    RAISE EXCEPTION 'You cannot cancel this job' USING ERRCODE = '42501';
  END IF;
  IF j.status = 'queued' OR j.status = 'awaiting_approval' THEN
    UPDATE public.ps_jobs SET status = 'cancelled', finished_at = now() WHERE id = j.id;
    RETURN 'cancelled';
  ELSIF j.status = 'running' THEN
    UPDATE public.ps_jobs SET cancel_requested_at = now() WHERE id = j.id;
    RETURN 'cancelling';
  END IF;
  RETURN j.status;
END;
$$;

DROP FUNCTION IF EXISTS auth.mcp_token_use(TEXT);
DROP FUNCTION IF EXISTS public.ps_mcp_token_revoke(UUID);
DROP FUNCTION IF EXISTS public.ps_mcp_token_list(UUID);
DROP FUNCTION IF EXISTS public.ps_mcp_token_create(UUID, TEXT, TEXT, TEXT, INTEGER);
DROP TABLE IF EXISTS public.ps_mcp_tokens;
DROP FUNCTION IF EXISTS public.ps_worker_last_seen();
DROP FUNCTION IF EXISTS public.ps_retry_job(UUID);
DROP FUNCTION IF EXISTS public.ps_job_retryable(TEXT);
DROP INDEX IF EXISTS public.ps_jobs_workspace_recent;
DROP INDEX IF EXISTS public.ps_jobs_retry_of;
ALTER TABLE public.ps_jobs DROP COLUMN IF EXISTS retry_of;
ALTER TABLE public.ps_jobs DROP COLUMN IF EXISTS cancelled_by;

COMMIT;
