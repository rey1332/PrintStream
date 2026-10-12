-- TERMINAL imports: a CSV or Excel file is uploaded into the company's
-- imports folder, analysed by the worker (delimiter, header, column types,
-- a sample), mapped by the user onto a dataset (new or existing) or an ERP
-- list, then committed by the worker. Rows that do not fit are kept with the
-- reason, so the user can fix and re-import them.
--
-- ERP targets (customers, suppliers, products) are written by the worker as
-- the user (role authenticated, the user's claims), so the ERP's own row
-- security, checks and triggers decide, exactly as when typing them in.
--
-- Rollback: db/rollback/rollback_20261012000037_terminal_imports.sql

CREATE TABLE IF NOT EXISTS public.ps_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  file_kind TEXT NOT NULL CHECK (file_kind IN ('csv', 'xlsx')),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  -- Relative to the company's imports folder; set by the server, never by users.
  storage_key TEXT NOT NULL CHECK (storage_key ~ '^[0-9a-f-]{36}\.(csv|xlsx)$'),
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'analyzing', 'analyzed', 'committing', 'committed', 'failed', 'cancelled')),
  analysis JSONB CHECK (analysis IS NULL OR pg_column_size(analysis) <= 262144),
  -- {target: 'dataset'|'new_dataset'|'erp', dataset_id?, erp_entity?, mode, sheet?,
  --  header_row?, columns: [{source, target?, type?, label?, key?, sensitive?, skip?}]}
  mapping JSONB CHECK (mapping IS NULL OR pg_column_size(mapping) <= 65536),
  target_dataset_id UUID REFERENCES public.ps_datasets(id) ON DELETE SET NULL,
  target_erp_entity TEXT CHECK (target_erp_entity IS NULL OR target_erp_entity IN ('customers', 'suppliers', 'products')),
  rows_total INTEGER,
  rows_ok INTEGER NOT NULL DEFAULT 0,
  rows_rejected INTEGER NOT NULL DEFAULT 0,
  error_key TEXT CHECK (error_key IS NULL OR error_key ~ '^[a-z_]{2,40}$'),
  job_id UUID REFERENCES public.ps_jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  -- The worker removes the file 30 days after the import finished.
  file_removed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ps_imports_ws ON public.ps_imports (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ps_import_rejects (
  id BIGSERIAL PRIMARY KEY,
  import_id UUID NOT NULL REFERENCES public.ps_imports(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason ~ '^[a-z_]{2,40}$'),
  column_name TEXT CHECK (column_name IS NULL OR char_length(column_name) <= 120),
  raw JSONB CHECK (raw IS NULL OR pg_column_size(raw) <= 16384)
);
CREATE INDEX IF NOT EXISTS ps_import_rejects_import ON public.ps_import_rejects (import_id, row_number);

-- An import is seen by whoever started it and by members allowed to import.
CREATE OR REPLACE FUNCTION public.ps_can_see_import(p_workspace_id UUID, p_created_by UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.erp_workspace_role(p_workspace_id) IS NOT NULL
     AND (p_created_by = auth.uid() OR public.erp_has_permission(p_workspace_id, 'datasets.import'));
$$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ps_imports', 'ps_import_rejects'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.%I', t);
    EXECUTE format('CREATE POLICY erp_workspace_not_suspended ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
                   'USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[])) '
                   'WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))', t);
  END LOOP;
END;
$$;
REVOKE ALL ON SEQUENCE public.ps_import_rejects_id_seq FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS ps_imports_read ON public.ps_imports;
CREATE POLICY ps_imports_read ON public.ps_imports FOR SELECT TO authenticated
  USING (public.ps_can_see_import(workspace_id, created_by));
DROP POLICY IF EXISTS ps_import_rejects_read ON public.ps_import_rejects;
CREATE POLICY ps_import_rejects_read ON public.ps_import_rejects FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.ps_imports i WHERE i.id = import_id AND public.ps_can_see_import(i.workspace_id, i.created_by)));

-- ─── For members ─────────────────────────────────────────────────────────────

-- Called by the upload route after the file is stored (and its storage reserved).
CREATE OR REPLACE FUNCTION public.ps_create_import(
  p_workspace_id UUID, p_import_id UUID, p_file_name TEXT, p_file_kind TEXT, p_size_bytes BIGINT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  job UUID;
BEGIN
  IF NOT public.erp_has_permission(p_workspace_id, 'datasets.import') THEN
    RAISE EXCEPTION 'You are not allowed to import into this workspace' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.ps_imports (id, workspace_id, created_by, file_name, file_kind, size_bytes, storage_key)
  VALUES (p_import_id, p_workspace_id, auth.uid(), left(btrim(p_file_name), 255), p_file_kind, p_size_bytes,
          p_import_id::text || '.' || p_file_kind);
  job := public.ps_enqueue_job(p_workspace_id, 'import.analyze', jsonb_build_object('import_id', p_import_id), 'analyze-' || p_import_id::text);
  UPDATE public.ps_imports SET job_id = job, status = 'analyzing' WHERE id = p_import_id;
  RETURN p_import_id;
END;
$$;

-- Re-analyse with other settings (sheet, header row, delimiter, encoding).
CREATE OR REPLACE FUNCTION public.ps_reanalyze_import(p_import_id UUID, p_options JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i public.ps_imports;
  job UUID;
BEGIN
  SELECT * INTO i FROM public.ps_imports x WHERE x.id = p_import_id FOR UPDATE;
  IF i.id IS NULL OR i.created_by IS DISTINCT FROM auth.uid() OR NOT public.erp_has_permission(i.workspace_id, 'datasets.import') THEN
    RAISE EXCEPTION 'Import not found' USING ERRCODE = 'P0002';
  END IF;
  IF i.status NOT IN ('analyzed', 'failed') OR i.file_removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This import cannot be analysed again' USING ERRCODE = 'P0001', HINT = 'wrong_state';
  END IF;
  job := public.ps_enqueue_job(i.workspace_id, 'import.analyze',
                               jsonb_build_object('import_id', i.id, 'options', COALESCE(p_options, '{}'::jsonb)));
  UPDATE public.ps_imports SET job_id = job, status = 'analyzing', error_key = NULL, updated_at = now() WHERE id = i.id;
  RETURN job;
END;
$$;

-- Saves the mapping and starts the commit. A new dataset is created first
-- (its table is built before the commit job runs: jobs run in order per workspace).
CREATE OR REPLACE FUNCTION public.ps_commit_import(p_import_id UUID, p_mapping JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i public.ps_imports;
  target TEXT := p_mapping ->> 'target';
  mode TEXT := COALESCE(p_mapping ->> 'mode', 'append');
  ds UUID;
  entity TEXT;
  job UUID;
  cols JSONB;
BEGIN
  SELECT * INTO i FROM public.ps_imports x WHERE x.id = p_import_id FOR UPDATE;
  IF i.id IS NULL OR i.created_by IS DISTINCT FROM auth.uid() OR NOT public.erp_has_permission(i.workspace_id, 'datasets.import') THEN
    RAISE EXCEPTION 'Import not found' USING ERRCODE = 'P0002';
  END IF;
  IF i.status <> 'analyzed' THEN
    RAISE EXCEPTION 'This import is not ready to commit' USING ERRCODE = 'P0001', HINT = 'wrong_state';
  END IF;
  IF jsonb_typeof(p_mapping -> 'columns') <> 'array' OR jsonb_array_length(p_mapping -> 'columns') > 500 THEN
    RAISE EXCEPTION 'Map at most 500 columns' USING ERRCODE = '22023';
  END IF;
  IF mode NOT IN ('append', 'upsert', 'replace') THEN RAISE EXCEPTION 'Unknown write mode' USING ERRCODE = '22023'; END IF;
  IF target = 'new_dataset' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('label', c ->> 'label', 'type', c ->> 'type', 'key', COALESCE((c ->> 'key')::boolean, false),
                                                 'sensitive', COALESCE((c ->> 'sensitive')::boolean, false))), '[]'::jsonb)
      INTO cols
      FROM jsonb_array_elements(p_mapping -> 'columns') c
     WHERE NOT COALESCE((c ->> 'skip')::boolean, false);
    ds := public.ps_create_dataset(i.workspace_id, COALESCE(NULLIF(btrim(p_mapping ->> 'name'), ''), regexp_replace(i.file_name, '\.[^.]+$', '')),
                                   COALESCE(p_mapping ->> 'folder', ''), 'Imported from ' || i.file_name, cols);
  ELSIF target = 'dataset' THEN
    ds := (p_mapping ->> 'dataset_id')::uuid;
    IF NOT public.ps_can_access_dataset(ds, 'import') THEN
      RAISE EXCEPTION 'You are not allowed to import into this dataset' USING ERRCODE = '42501';
    END IF;
    IF (SELECT d.workspace_id FROM public.ps_datasets d WHERE d.id = ds) IS DISTINCT FROM i.workspace_id THEN
      RAISE EXCEPTION 'Dataset not found' USING ERRCODE = 'P0002';
    END IF;
  ELSIF target = 'erp' THEN
    entity := p_mapping ->> 'erp_entity';
    IF entity NOT IN ('customers', 'suppliers', 'products') THEN RAISE EXCEPTION 'Unknown ERP list' USING ERRCODE = '22023'; END IF;
    IF NOT public.erp_has_permission(i.workspace_id, entity) THEN
      RAISE EXCEPTION 'You are not allowed to add to this ERP list' USING ERRCODE = '42501';
    END IF;
    IF mode = 'replace' THEN RAISE EXCEPTION 'ERP lists are never replaced by an import' USING ERRCODE = '22023'; END IF;
  ELSE
    RAISE EXCEPTION 'Choose where the rows go' USING ERRCODE = '22023';
  END IF;
  job := public.ps_enqueue_job(i.workspace_id, 'import.commit', jsonb_build_object('import_id', i.id), 'commit-' || i.id::text);
  UPDATE public.ps_imports
     SET mapping = p_mapping || jsonb_build_object('dataset_id', ds), target_dataset_id = ds, target_erp_entity = entity,
         status = 'committing', job_id = job, updated_at = now()
   WHERE id = i.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (i.workspace_id, auth.uid(), 'import.started',
          jsonb_build_object('import_id', i.id, 'file_name', i.file_name, 'target', target, 'dataset_id', ds, 'erp_entity', entity, 'mode', mode));
  RETURN job;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_cancel_import(p_import_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i public.ps_imports;
BEGIN
  SELECT * INTO i FROM public.ps_imports x WHERE x.id = p_import_id FOR UPDATE;
  IF i.id IS NULL OR NOT public.ps_can_see_import(i.workspace_id, i.created_by) THEN
    RAISE EXCEPTION 'Import not found' USING ERRCODE = 'P0002';
  END IF;
  IF i.status IN ('committed', 'cancelled') THEN RETURN; END IF;
  IF i.job_id IS NOT NULL THEN PERFORM public.ps_cancel_job(i.job_id); END IF;
  UPDATE public.ps_imports SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = i.id;
END;
$$;

-- ─── For the worker ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ps_worker.import_get(p_import_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT to_jsonb(i) || jsonb_build_object('storage_dir', etna_platform.storage_state(i.workspace_id) ->> 'storage_dir')
    FROM public.ps_imports i WHERE i.id = p_import_id;
$$;

CREATE OR REPLACE FUNCTION ps_worker.import_analyzed(p_import_id UUID, p_analysis JSONB, p_rows_total INTEGER)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.ps_imports SET analysis = p_analysis, rows_total = p_rows_total, status = 'analyzed', error_key = NULL, updated_at = now()
   WHERE id = p_import_id AND status = 'analyzing';
$$;

CREATE OR REPLACE FUNCTION ps_worker.import_progress(p_import_id UUID, p_rows_ok INTEGER, p_rows_rejected INTEGER, p_rejects JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  i public.ps_imports;
  kept INTEGER;
BEGIN
  SELECT * INTO i FROM public.ps_imports x WHERE x.id = p_import_id;
  IF i.id IS NULL THEN RETURN; END IF;
  UPDATE public.ps_imports SET rows_ok = p_rows_ok, rows_rejected = p_rows_rejected, updated_at = now() WHERE id = i.id;
  -- At most 10,000 rejected rows are kept per import.
  SELECT count(*) INTO kept FROM public.ps_import_rejects r WHERE r.import_id = i.id;
  INSERT INTO public.ps_import_rejects (import_id, workspace_id, row_number, reason, column_name, raw)
  SELECT i.id, i.workspace_id, (r ->> 'row')::int, r ->> 'reason', left(r ->> 'column', 120), r -> 'raw'
    FROM jsonb_array_elements(COALESCE(p_rejects, '[]'::jsonb)) r
   LIMIT GREATEST(10000 - kept, 0);
END;
$$;

-- A retried commit starts from scratch: its earlier rejects go.
CREATE OR REPLACE FUNCTION ps_worker.import_restart(p_import_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM public.ps_import_rejects WHERE import_id = p_import_id;
  UPDATE public.ps_imports SET rows_ok = 0, rows_rejected = 0, updated_at = now() WHERE id = p_import_id;
$$;

CREATE OR REPLACE FUNCTION ps_worker.import_finished(p_import_id UUID, p_status TEXT, p_error_key TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  i public.ps_imports;
BEGIN
  IF p_status NOT IN ('analyzed', 'committed', 'failed') THEN RAISE EXCEPTION 'Invalid status' USING ERRCODE = '22023'; END IF;
  UPDATE public.ps_imports
     SET status = p_status, error_key = p_error_key, updated_at = now(),
         finished_at = CASE WHEN p_status IN ('committed', 'failed') THEN now() ELSE finished_at END
   WHERE id = p_import_id AND status IN ('analyzing', 'committing')
  RETURNING * INTO i;
  IF i.id IS NOT NULL AND p_status IN ('committed', 'failed') THEN
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    VALUES (i.workspace_id, i.created_by, 'import.' || p_status,
            jsonb_build_object('import_id', i.id, 'file_name', i.file_name, 'rows_ok', i.rows_ok, 'rows_rejected', i.rows_rejected,
                               'dataset_id', i.target_dataset_id, 'erp_entity', i.target_erp_entity, 'error', p_error_key));
  END IF;
END;
$$;

-- Files of imports finished more than 30 days ago (and of cancelled ones).
CREATE OR REPLACE FUNCTION ps_worker.import_files_to_remove(p_limit INTEGER DEFAULT 200)
RETURNS TABLE (import_id UUID, workspace_id UUID, storage_key TEXT, storage_dir TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.id, i.workspace_id, i.storage_key, etna_platform.storage_state(i.workspace_id) ->> 'storage_dir'
    FROM public.ps_imports i
   WHERE i.file_removed_at IS NULL
     AND ((i.status IN ('committed', 'failed') AND i.finished_at < now() - interval '30 days')
       OR (i.status = 'cancelled' AND i.updated_at < now() - interval '1 day'))
   ORDER BY i.created_at
   LIMIT LEAST(GREATEST(p_limit, 1), 1000);
$$;

CREATE OR REPLACE FUNCTION ps_worker.import_file_removed(p_import_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.ps_imports SET file_removed_at = now() WHERE id = p_import_id;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ps_worker FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ps_worker TO etna_worker;
-- The worker reads the size of a company's datasets for the quota.
GRANT EXECUTE ON FUNCTION etna_platform.storage_state(UUID) TO etna_worker;

REVOKE ALL ON FUNCTION public.ps_can_see_import(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_can_see_import(UUID, UUID) TO authenticated;
DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.ps_create_import(uuid,uuid,text,text,bigint)', 'public.ps_reanalyze_import(uuid,jsonb)',
                           'public.ps_commit_import(uuid,jsonb)', 'public.ps_cancel_import(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END;
$$;
