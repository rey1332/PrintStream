-- TERMINAL background work: a job queue in PostgreSQL, the worker's login
-- role, schedules and pipeline chains.
--
-- * ps_jobs: one row per job (dataset provisioning, imports, background
--   pipeline runs, maintenance). Members enqueue through ps_enqueue_job(),
--   which checks the permission for that kind of job; nobody writes the
--   table directly. Idempotency keys make retried requests harmless.
-- * The worker (scripts/server/worker.mjs) logs in as etna_worker: no
--   rights of its own; it can switch to authenticated with the claims of the
--   job's user (so row-level security and the ERP checks apply to the job
--   exactly as to that user) and call the functions in schema ps_worker.
--   It claims jobs with FOR UPDATE SKIP LOCKED under a 60-second lease that
--   its heartbeat renews; an expired lease puts the job back (or fails it
--   after max_attempts, with backoff). Jobs survive restarts.
-- * ps_schedules: when a published pipeline runs by itself (interval,
--   daily, weekly, monthly or cron, in a time zone), as the schedule's owner;
--   ps_triggers: run pipeline B after pipeline A succeeds. Loops are refused.
--   Three failures in a row switch a schedule off.
-- * ps_worker_status: each worker's heartbeat, for the health check.
--
-- Rollback: db/rollback/rollback_20261012000035_terminal_jobs.sql

-- ─── Roles and schema ────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_worker') THEN
    CREATE ROLE etna_worker NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END;
$$;
-- Like etna_app: may switch to anon/authenticated, inherits nothing.
GRANT anon, authenticated TO etna_worker;

CREATE SCHEMA IF NOT EXISTS ps_worker;
REVOKE ALL ON SCHEMA ps_worker FROM PUBLIC;
GRANT USAGE ON SCHEMA ps_worker TO etna_worker;
GRANT USAGE ON SCHEMA etna_platform TO etna_worker;

-- ─── Jobs ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ps_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind ~ '^[a-z]+(\.[a-z_]+)+$'),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 65536),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'awaiting_approval')),
  priority SMALLINT NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 9),
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  idempotency_key TEXT CHECK (idempotency_key IS NULL OR char_length(idempotency_key) <= 100),
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  -- Whose rights the job runs with, and whether that was a two-factor session.
  as_user UUID,
  as_aal TEXT NOT NULL DEFAULT 'aal1' CHECK (as_aal IN ('aal1', 'aal2')),
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'schedule', 'chain', 'system')),
  progress JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(progress) <= 16384),
  result JSONB CHECK (result IS NULL OR pg_column_size(result) <= 65536),
  error_key TEXT CHECK (error_key IS NULL OR char_length(error_key) <= 80),
  error_detail TEXT CHECK (error_detail IS NULL OR char_length(error_detail) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ps_jobs_idempotency ON public.ps_jobs (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ps_jobs_queue ON public.ps_jobs (priority, run_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS ps_jobs_running ON public.ps_jobs (lease_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS ps_jobs_workspace ON public.ps_jobs (workspace_id, created_at DESC);

ALTER TABLE public.ps_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ps_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ps_jobs TO authenticated;
DROP POLICY IF EXISTS ps_jobs_read ON public.ps_jobs;
CREATE POLICY ps_jobs_read ON public.ps_jobs FOR SELECT TO authenticated USING (
  workspace_id IS NOT NULL AND public.erp_workspace_role(workspace_id) IS NOT NULL
  AND (created_by = auth.uid() OR public.erp_has_permission(workspace_id, 'pipelines.view')
       OR public.erp_has_permission(workspace_id, 'datasets.view')));
DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.ps_jobs;
CREATE POLICY erp_workspace_not_suspended ON public.ps_jobs AS RESTRICTIVE FOR ALL TO authenticated
  USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]));

-- The permission each kind of job needs from the person who starts it.
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
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.ps_enqueue_job(
  p_workspace_id UUID, p_kind TEXT, p_payload JSONB, p_idempotency_key TEXT DEFAULT NULL, p_run_after TIMESTAMPTZ DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  needed TEXT := public.ps_job_permission(p_kind);
  job UUID;
  waiting INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF needed IS NULL THEN RAISE EXCEPTION 'Unknown job' USING ERRCODE = '22023'; END IF;
  IF NOT public.erp_has_permission(p_workspace_id, needed) THEN
    RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    SELECT j.id INTO job FROM public.ps_jobs j WHERE j.workspace_id = p_workspace_id AND j.idempotency_key = p_idempotency_key;
    IF job IS NOT NULL THEN RETURN job; END IF;
  END IF;
  SELECT count(*) INTO waiting FROM public.ps_jobs j
   WHERE j.created_by = auth.uid() AND j.status IN ('queued', 'running');
  IF waiting >= 20 THEN
    RAISE EXCEPTION 'Too many jobs waiting; let some finish first' USING ERRCODE = 'P0001', HINT = 'too_many_jobs';
  END IF;
  INSERT INTO public.ps_jobs (workspace_id, kind, payload, idempotency_key, run_after, created_by, as_user, as_aal, trigger)
  VALUES (p_workspace_id, p_kind, COALESCE(p_payload, '{}'::jsonb), p_idempotency_key, COALESCE(p_run_after, now()),
          auth.uid(), auth.uid(), public.erp_session_aal(), 'manual')
  RETURNING id INTO job;
  PERFORM pg_notify('ps_jobs', job::text);
  RETURN job;
END;
$$;

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

-- ─── Schedules and chains ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ps_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  pipeline_id UUID NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('interval', 'daily', 'weekly', 'monthly', 'cron')),
  spec JSONB NOT NULL CHECK (pg_column_size(spec) <= 2000),
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta' CHECK (char_length(timezone) <= 64),
  run_as UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  run_as_aal TEXT NOT NULL DEFAULT 'aal1' CHECK (run_as_aal IN ('aal1', 'aal2')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_job_id UUID,
  failure_streak SMALLINT NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id)
);
CREATE INDEX IF NOT EXISTS ps_schedules_due ON public.ps_schedules (next_run_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS public.ps_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  upstream_id UUID NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  downstream_id UUID NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  run_as UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  run_as_aal TEXT NOT NULL DEFAULT 'aal1' CHECK (run_as_aal IN ('aal1', 'aal2')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (upstream_id <> downstream_id),
  UNIQUE (upstream_id, downstream_id)
);

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ps_schedules', 'ps_triggers'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.erp_has_permission(workspace_id, ''pipelines.view''))', t || '_read', t);
    EXECUTE format('DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.%I', t);
    EXECUTE format('CREATE POLICY erp_workspace_not_suspended ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
                   'USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[])) '
                   'WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))', t);
  END LOOP;
END;
$$;

-- A schedule for a pipeline (one per pipeline); next_run_at comes from the
-- app (it understands the spec) and is checked again by the worker.
CREATE OR REPLACE FUNCTION public.ps_save_schedule(
  p_pipeline_id UUID, p_kind TEXT, p_spec JSONB, p_timezone TEXT, p_next_run_at TIMESTAMPTZ, p_enabled BOOLEAN DEFAULT true)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w public.workflows;
  saved UUID;
BEGIN
  SELECT * INTO w FROM public.workflows x WHERE x.id = p_pipeline_id;
  IF w.id IS NULL OR w.workspace_id IS NULL OR NOT public.erp_has_permission(w.workspace_id, 'pipelines.schedule') THEN
    RAISE EXCEPTION 'You are not allowed to schedule this pipeline' USING ERRCODE = '42501';
  END IF;
  IF w.published_version_id IS NULL THEN
    RAISE EXCEPTION 'Publish the pipeline before scheduling it' USING ERRCODE = 'P0001', HINT = 'not_published';
  END IF;
  INSERT INTO public.ps_schedules (workspace_id, pipeline_id, kind, spec, timezone, run_as, run_as_aal, enabled, next_run_at)
  VALUES (w.workspace_id, w.id, p_kind, p_spec, COALESCE(NULLIF(p_timezone, ''), 'Asia/Jakarta'), auth.uid(), public.erp_session_aal(),
          COALESCE(p_enabled, true), p_next_run_at)
  ON CONFLICT (pipeline_id) DO UPDATE SET kind = EXCLUDED.kind, spec = EXCLUDED.spec, timezone = EXCLUDED.timezone,
    run_as = EXCLUDED.run_as, run_as_aal = EXCLUDED.run_as_aal, enabled = EXCLUDED.enabled, next_run_at = EXCLUDED.next_run_at,
    failure_streak = 0, disabled_reason = NULL, updated_at = now()
  RETURNING id INTO saved;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (w.workspace_id, auth.uid(), 'pipeline.scheduled',
          jsonb_build_object('pipeline_id', w.id, 'kind', p_kind, 'spec', p_spec, 'enabled', COALESCE(p_enabled, true)));
  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_delete_schedule(p_pipeline_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.ps_schedules;
BEGIN
  SELECT * INTO s FROM public.ps_schedules x WHERE x.pipeline_id = p_pipeline_id;
  IF s.id IS NULL THEN RETURN; END IF;
  IF NOT public.erp_has_permission(s.workspace_id, 'pipelines.schedule') THEN
    RAISE EXCEPTION 'You are not allowed to change this schedule' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.ps_schedules WHERE id = s.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (s.workspace_id, auth.uid(), 'pipeline.unscheduled', jsonb_build_object('pipeline_id', p_pipeline_id));
END;
$$;

-- Run downstream after upstream succeeds; refused when it would make a loop.
CREATE OR REPLACE FUNCTION public.ps_save_trigger(p_upstream_id UUID, p_downstream_id UUID, p_enabled BOOLEAN DEFAULT true)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  up public.workflows;
  down public.workflows;
  saved UUID;
BEGIN
  SELECT * INTO up FROM public.workflows x WHERE x.id = p_upstream_id;
  SELECT * INTO down FROM public.workflows x WHERE x.id = p_downstream_id;
  IF up.id IS NULL OR down.id IS NULL OR up.workspace_id IS DISTINCT FROM down.workspace_id
     OR NOT public.erp_has_permission(down.workspace_id, 'pipelines.schedule') THEN
    RAISE EXCEPTION 'You are not allowed to chain these pipelines' USING ERRCODE = '42501';
  END IF;
  IF up.id = down.id OR EXISTS (
    WITH RECURSIVE chain(id) AS (
      SELECT t.downstream_id FROM public.ps_triggers t WHERE t.upstream_id = p_downstream_id AND t.enabled
      UNION
      SELECT t.downstream_id FROM public.ps_triggers t JOIN chain c ON t.upstream_id = c.id WHERE t.enabled
    ) SELECT 1 FROM chain WHERE id = p_upstream_id) THEN
    RAISE EXCEPTION 'This would make the pipelines run in a loop' USING ERRCODE = 'P0001', HINT = 'loop';
  END IF;
  INSERT INTO public.ps_triggers (workspace_id, upstream_id, downstream_id, run_as, run_as_aal, enabled)
  VALUES (down.workspace_id, up.id, down.id, auth.uid(), public.erp_session_aal(), COALESCE(p_enabled, true))
  ON CONFLICT (upstream_id, downstream_id) DO UPDATE SET enabled = EXCLUDED.enabled, run_as = EXCLUDED.run_as, run_as_aal = EXCLUDED.run_as_aal
  RETURNING id INTO saved;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (down.workspace_id, auth.uid(), 'pipeline.chained', jsonb_build_object('upstream_id', up.id, 'downstream_id', down.id, 'enabled', COALESCE(p_enabled, true)));
  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_delete_trigger(p_trigger_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.ps_triggers;
BEGIN
  SELECT * INTO t FROM public.ps_triggers x WHERE x.id = p_trigger_id;
  IF t.id IS NULL THEN RETURN; END IF;
  IF NOT public.erp_has_permission(t.workspace_id, 'pipelines.schedule') THEN
    RAISE EXCEPTION 'You are not allowed to change this chain' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.ps_triggers WHERE id = t.id;
END;
$$;

-- ─── Worker functions (etna_worker only) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS etna_platform.worker_status (
  worker_id TEXT PRIMARY KEY CHECK (char_length(worker_id) <= 100),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version TEXT,
  running INTEGER NOT NULL DEFAULT 0
);
REVOKE ALL ON etna_platform.worker_status FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION ps_worker.heartbeat_worker(p_worker TEXT, p_version TEXT, p_running INTEGER)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
  INSERT INTO etna_platform.worker_status (worker_id, version, running) VALUES (p_worker, left(p_version, 60), p_running)
  ON CONFLICT (worker_id) DO UPDATE SET seen_at = now(), version = EXCLUDED.version, running = EXCLUDED.running;
$$;

-- Takes the next job; expired leases go back to the queue first.
CREATE OR REPLACE FUNCTION ps_worker.claim(p_worker TEXT, p_max_per_workspace INTEGER DEFAULT 1)
RETURNS SETOF public.ps_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  j public.ps_jobs;
BEGIN
  UPDATE public.ps_jobs
     SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         error_key = CASE WHEN attempts >= max_attempts THEN 'worker_lost' ELSE error_key END,
         finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
         run_after = now() + make_interval(secs => 15 * attempts),
         lease_owner = NULL, lease_until = NULL
   WHERE status = 'running' AND lease_until < now();

  SELECT * INTO j FROM public.ps_jobs q
   WHERE q.status = 'queued' AND q.run_after <= now() AND q.cancel_requested_at IS NULL
     AND (q.workspace_id IS NULL OR (
           SELECT count(*) FROM public.ps_jobs r WHERE r.workspace_id = q.workspace_id AND r.status = 'running'
         ) < GREATEST(p_max_per_workspace, 1))
   ORDER BY q.priority, q.run_after, q.created_at
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF j.id IS NULL THEN RETURN; END IF;
  UPDATE public.ps_jobs SET status = 'running', lease_owner = left(p_worker, 100), lease_until = now() + interval '60 seconds',
         heartbeat_at = now(), attempts = attempts + 1, started_at = COALESCE(started_at, now())
   WHERE id = j.id
  RETURNING * INTO j;
  RETURN NEXT j;
END;
$$;

-- Keeps the lease; returns true when someone asked to cancel the job.
CREATE OR REPLACE FUNCTION ps_worker.heartbeat(p_job_id UUID, p_worker TEXT, p_progress JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  cancel BOOLEAN;
BEGIN
  UPDATE public.ps_jobs SET lease_until = now() + interval '60 seconds', heartbeat_at = now(),
         progress = COALESCE(p_progress, progress)
   WHERE id = p_job_id AND lease_owner = p_worker AND status = 'running'
  RETURNING cancel_requested_at IS NOT NULL INTO cancel;
  IF cancel IS NULL THEN
    RAISE EXCEPTION 'Lease lost' USING ERRCODE = 'P0001', HINT = 'lease_lost';
  END IF;
  RETURN cancel;
END;
$$;

-- Ends a job. A failed retryable job goes back to the queue with backoff.
CREATE OR REPLACE FUNCTION ps_worker.finish(
  p_job_id UUID, p_worker TEXT, p_status TEXT, p_result JSONB, p_error_key TEXT, p_error_detail TEXT, p_retryable BOOLEAN DEFAULT false)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  j public.ps_jobs;
  final TEXT;
BEGIN
  SELECT * INTO j FROM public.ps_jobs x WHERE x.id = p_job_id FOR UPDATE;
  IF j.id IS NULL OR j.lease_owner IS DISTINCT FROM p_worker OR j.status <> 'running' THEN
    RETURN COALESCE(j.status, 'missing');
  END IF;
  IF p_status NOT IN ('succeeded', 'failed', 'cancelled', 'awaiting_approval') THEN
    RAISE EXCEPTION 'Invalid status' USING ERRCODE = '22023';
  END IF;
  final := CASE WHEN p_status = 'failed' AND p_retryable AND j.attempts < j.max_attempts THEN 'queued' ELSE p_status END;
  UPDATE public.ps_jobs SET
    status = final,
    result = p_result,
    error_key = left(p_error_key, 80),
    error_detail = left(p_error_detail, 2000),
    lease_owner = NULL, lease_until = NULL,
    run_after = CASE WHEN final = 'queued' THEN now() + make_interval(secs => 30 * power(2, j.attempts)::int) ELSE run_after END,
    finished_at = CASE WHEN final IN ('succeeded', 'failed', 'cancelled') THEN now() ELSE NULL END
  WHERE id = j.id;
  RETURN final;
END;
$$;

-- Jobs created by the system (schedules, chains, maintenance) for a user's rights.
CREATE OR REPLACE FUNCTION ps_worker.enqueue(
  p_workspace_id UUID, p_kind TEXT, p_payload JSONB, p_as_user UUID, p_as_aal TEXT, p_trigger TEXT, p_idempotency_key TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  job UUID;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT j.id INTO job FROM public.ps_jobs j WHERE j.workspace_id IS NOT DISTINCT FROM p_workspace_id AND j.idempotency_key = p_idempotency_key;
    IF job IS NOT NULL THEN RETURN job; END IF;
  END IF;
  INSERT INTO public.ps_jobs (workspace_id, kind, payload, idempotency_key, as_user, as_aal, trigger, created_by, max_attempts)
  VALUES (p_workspace_id, p_kind, COALESCE(p_payload, '{}'::jsonb), p_idempotency_key, p_as_user, COALESCE(p_as_aal, 'aal1'),
          COALESCE(p_trigger, 'system'), p_as_user, CASE WHEN p_kind LIKE 'maintenance.%' THEN 1 ELSE 3 END)
  RETURNING id INTO job;
  RETURN job;
END;
$$;

CREATE OR REPLACE FUNCTION ps_worker.due_schedules(p_limit INTEGER DEFAULT 20)
RETURNS SETOF public.ps_schedules
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM public.ps_schedules s
   WHERE s.enabled AND s.next_run_at IS NOT NULL AND s.next_run_at <= now()
   ORDER BY s.next_run_at
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
   FOR UPDATE SKIP LOCKED;
$$;

-- Records that a schedule fired (and when it fires next).
CREATE OR REPLACE FUNCTION ps_worker.schedule_fired(p_schedule_id UUID, p_job_id UUID, p_next_run_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.ps_schedules SET last_run_at = now(), last_job_id = p_job_id, next_run_at = p_next_run_at, updated_at = now()
   WHERE id = p_schedule_id;
$$;

-- A scheduled run ended: three failures in a row switch the schedule off.
CREATE OR REPLACE FUNCTION ps_worker.schedule_result(p_pipeline_id UUID, p_ok BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s public.ps_schedules;
BEGIN
  UPDATE public.ps_schedules SET failure_streak = CASE WHEN p_ok THEN 0 ELSE failure_streak + 1 END, updated_at = now()
   WHERE pipeline_id = p_pipeline_id
  RETURNING * INTO s;
  IF s.id IS NOT NULL AND s.failure_streak >= 3 AND s.enabled THEN
    UPDATE public.ps_schedules SET enabled = false, disabled_reason = 'three_failures' WHERE id = s.id;
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    VALUES (s.workspace_id, s.run_as, 'pipeline.schedule_disabled', jsonb_build_object('pipeline_id', p_pipeline_id, 'reason', 'three_failures'));
    RETURN true;
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION ps_worker.downstream(p_pipeline_id UUID)
RETURNS SETOF public.ps_triggers
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM public.ps_triggers t WHERE t.upstream_id = p_pipeline_id AND t.enabled;
$$;

CREATE OR REPLACE FUNCTION ps_worker.pending_deletions()
RETURNS TABLE (workspace_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
  SELECT t.workspace_id FROM etna_platform.workspace_terminations t WHERE t.state = 'deleting';
$$;

CREATE OR REPLACE FUNCTION ps_worker.workspaces()
RETURNS TABLE (workspace_id UUID, storage_dir TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform, pg_temp
AS $$
  SELECT w.id, s.storage_dir FROM public.erp_workspaces w LEFT JOIN etna_platform.workspace_storage s ON s.workspace_id = w.id;
$$;

CREATE OR REPLACE FUNCTION ps_worker.company_dir(p_workspace_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
  SELECT s.storage_dir FROM etna_platform.workspace_storage s WHERE s.workspace_id = p_workspace_id;
$$;

-- ─── Privileges ──────────────────────────────────────────────────────────────
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ps_worker FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ps_worker TO etna_worker;
GRANT EXECUTE ON FUNCTION etna_platform.purge_by_retention() TO etna_worker;
GRANT EXECUTE ON FUNCTION etna_platform.ensure_data_access_partitions(INTEGER) TO etna_worker;
GRANT EXECUTE ON FUNCTION etna_platform.record_storage_measure(UUID, BIGINT, BIGINT, BIGINT) TO etna_worker;
GRANT EXECUTE ON FUNCTION etna_platform.measure_erp_estimate() TO etna_worker;
GRANT EXECUTE ON FUNCTION etna_platform.run_workspace_deletion(UUID) TO etna_worker;
GRANT EXECUTE ON FUNCTION etna_platform.log_data_access_system(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB) TO etna_worker;
REVOKE ALL ON FUNCTION public.ps_job_permission(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_enqueue_job(UUID, TEXT, JSONB, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_cancel_job(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_save_schedule(UUID, TEXT, JSONB, TEXT, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_delete_schedule(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_save_trigger(UUID, UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_delete_trigger(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_enqueue_job(UUID, TEXT, JSONB, TEXT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_cancel_job(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_save_schedule(UUID, TEXT, JSONB, TEXT, TIMESTAMPTZ, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_delete_schedule(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_save_trigger(UUID, UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_delete_trigger(UUID) TO authenticated;
