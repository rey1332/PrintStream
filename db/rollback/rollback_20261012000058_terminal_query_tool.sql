-- Rollback for 20261012000058_terminal_query_tool.sql.
-- Run only after redeploying an app version from before this change.
-- Query results and history are removed; queued Query Tool jobs are cancelled.

BEGIN;

UPDATE public.ps_jobs SET status = 'cancelled', finished_at = now()
 WHERE kind IN ('sql.datasets', 'sql.connection') AND status IN ('queued', 'running');

DROP FUNCTION IF EXISTS ps_worker.sql_run_finish(UUID, TEXT, JSONB, JSONB, INTEGER, TEXT, JSONB, JSONB, JSONB, INTEGER);
DROP FUNCTION IF EXISTS ps_worker.sql_run_begin(UUID, UUID);
DROP FUNCTION IF EXISTS public.ps_sql_run_start(UUID, UUID, TEXT, TEXT);
DROP TABLE IF EXISTS public.ps_sql_runs;

-- As in 20261012000049.
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
    ELSE NULL
  END;
$$;
REVOKE ALL ON FUNCTION public.ps_job_permission(TEXT) FROM PUBLIC, anon, authenticated;

COMMIT;
