-- Rollback for 20261012000049_terminal_ai.sql.
-- AI providers, their keys, policies, budget, usage, decisions and dataset
-- entity mappings are removed.

BEGIN;
DROP FUNCTION IF EXISTS public.ps_save_ai_provider(UUID, UUID, TEXT, TEXT, JSONB, BOOLEAN, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS public.ps_delete_ai_provider(UUID);
DROP FUNCTION IF EXISTS public.ps_set_ai_personal_key(UUID, TEXT);
DROP FUNCTION IF EXISTS public.ps_has_ai_personal_key(UUID);
DROP FUNCTION IF EXISTS public.ps_set_ai_policy(UUID, UUID, BOOLEAN, TEXT[], INTEGER);
DROP FUNCTION IF EXISTS public.ps_set_ai_settings(UUID, NUMERIC, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.ps_ai_budget(UUID);
DROP FUNCTION IF EXISTS public.ps__require_policy_manager(UUID);
DROP FUNCTION IF EXISTS public.ps_start_decision(UUID, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.ps_finish_decision(UUID, BOOLEAN, TEXT, TEXT, JSONB, JSONB, NUMERIC, JSONB, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.ps_request_review(UUID, TEXT);
DROP FUNCTION IF EXISTS public.ps_review_decision(UUID, TEXT);
DROP FUNCTION IF EXISTS public.ps_set_dataset_entity(UUID, TEXT, TEXT, TEXT, BOOLEAN, JSONB);
DROP FUNCTION IF EXISTS ps_worker.ai_provider_get(UUID, UUID);
DROP FUNCTION IF EXISTS ps_worker.ai_provider_tested(UUID, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS ps_worker.ai_usage_record(UUID, UUID, UUID, BOOLEAN, INTEGER, INTEGER, NUMERIC, JSONB);
DROP FUNCTION IF EXISTS etna_platform.admin_set_ai_local_endpoints(TEXT[]);
DROP FUNCTION IF EXISTS etna_platform.admin_ai_local_endpoints();
DELETE FROM public.ps_jobs WHERE kind IN ('ai.test', 'ai.analyze');
DROP TABLE IF EXISTS public.ps_ai_usage;
DROP TABLE IF EXISTS public.ps_decisions;
DROP TABLE IF EXISTS public.ps_ai_policies;
DROP TABLE IF EXISTS public.ps_ai_settings;
DROP TABLE IF EXISTS public.ps_dataset_entities;
DROP TABLE IF EXISTS etna_platform.ai_personal_keys;
DROP TABLE IF EXISTS etna_platform.ai_secrets;
DROP TABLE IF EXISTS public.ps_ai_providers;
ALTER TABLE etna_platform.settings DROP COLUMN IF EXISTS ai_local_endpoints;
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
    ELSE NULL
  END;
$$;
REVOKE ALL ON FUNCTION public.ps_job_permission(TEXT) FROM PUBLIC, anon, authenticated;
COMMIT;
