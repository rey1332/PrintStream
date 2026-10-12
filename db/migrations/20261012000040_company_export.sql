-- The Owner's export of a company that ETNA is terminating (decision R-34).
--
-- During the export period (workspace_terminations.state = 'export_available',
-- before export_until) the company is suspended: nobody reads its data the
-- usual way. Its Owner can still ask for one export file: the worker writes
-- every ERP list and every dataset of the company into a compressed JSON file
-- in the company's artifacts folder, and the Owner downloads it while the
-- export period lasts. Secrets (hashes, tokens, passwords, keys) are left out.
--
-- Rollback: db/rollback/rollback_20261012000040_company_export.sql

CREATE TABLE IF NOT EXISTS etna_platform.workspace_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  requested_by UUID,
  job_id UUID,
  status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing', 'ready', 'failed')),
  file_key TEXT CHECK (file_key IS NULL OR file_key ~ '^company-export-[0-9a-f-]{36}\.json\.gz$'),
  size_bytes BIGINT,
  error_key TEXT CHECK (error_key IS NULL OR char_length(error_key) <= 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workspace_exports_ws ON etna_platform.workspace_exports (workspace_id, created_at DESC);
REVOKE ALL ON etna_platform.workspace_exports FROM PUBLIC, anon, authenticated;

-- The caller is the company's Owner and its export period is open.
CREATE OR REPLACE FUNCTION public.erp__export_window_open(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM etna_platform.workspace_terminations t
                  WHERE t.workspace_id = p_workspace_id AND t.state = 'export_available' AND t.export_until > now())
     AND EXISTS (SELECT 1 FROM public.erp_workspace_members m
                  WHERE m.workspace_id = p_workspace_id AND m.user_id = auth.uid() AND m.status = 'active' AND m.role = 'owner');
$$;

CREATE OR REPLACE FUNCTION public.erp_request_company_export(p_workspace_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
DECLARE
  export_id UUID := gen_random_uuid();
  job UUID;
BEGIN
  IF NOT public.erp__export_window_open(p_workspace_id) THEN
    RAISE EXCEPTION 'Only the Owner can export, during the export period' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM etna_platform.workspace_exports e WHERE e.workspace_id = p_workspace_id AND e.status = 'preparing') THEN
    RAISE EXCEPTION 'An export is already being prepared' USING ERRCODE = 'P0001', HINT = 'busy';
  END IF;
  INSERT INTO public.ps_jobs (workspace_id, kind, payload, as_user, as_aal, trigger, created_by, max_attempts)
  VALUES (p_workspace_id, 'workspace.export', jsonb_build_object('export_id', export_id), auth.uid(), public.erp_session_aal(),
          'manual', auth.uid(), 2)
  RETURNING id INTO job;
  INSERT INTO etna_platform.workspace_exports (id, workspace_id, requested_by, job_id) VALUES (export_id, p_workspace_id, auth.uid(), job);
  PERFORM etna_platform._log('COMPANY_EXPORT_REQUESTED', 'success', 'user', NULL, NULL, p_workspace_id, '{}'::jsonb, auth.uid());
  PERFORM pg_notify('ps_jobs', job::text);
  RETURN export_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_company_exports(p_workspace_id UUID)
RETURNS TABLE (id UUID, status TEXT, size_bytes BIGINT, error_key TEXT, created_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.erp__export_window_open(p_workspace_id) THEN RETURN; END IF;
  RETURN QUERY
  SELECT e.id, e.status, e.size_bytes, e.error_key, e.created_at, e.finished_at
    FROM etna_platform.workspace_exports e
   WHERE e.workspace_id = p_workspace_id
   ORDER BY e.created_at DESC
   LIMIT 10;
END;
$$;

-- Where a ready export lies, for the download route; every download is logged.
CREATE OR REPLACE FUNCTION public.erp_company_export_file(p_export_id UUID)
RETURNS TABLE (workspace_id UUID, file_key TEXT, storage_dir TEXT, size_bytes BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
DECLARE
  e etna_platform.workspace_exports;
BEGIN
  SELECT * INTO e FROM etna_platform.workspace_exports x WHERE x.id = p_export_id;
  IF e.id IS NULL OR e.status <> 'ready' OR NOT public.erp__export_window_open(e.workspace_id) THEN
    RAISE EXCEPTION 'Export not available' USING ERRCODE = 'P0002';
  END IF;
  PERFORM etna_platform._data_access_insert(e.workspace_id, auth.uid(), 'user', 'company_export', e.id::text, 'download', 0, '{}'::text[], NULL, NULL);
  RETURN QUERY
  SELECT e.workspace_id, e.file_key, (SELECT s.storage_dir FROM etna_platform.workspace_storage s WHERE s.workspace_id = e.workspace_id), e.size_bytes;
END;
$$;

-- ─── For the worker ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ps_worker.export_get(p_export_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, public, pg_temp
AS $$
  SELECT to_jsonb(e) || jsonb_build_object(
           'storage_dir', (SELECT s.storage_dir FROM etna_platform.workspace_storage s WHERE s.workspace_id = e.workspace_id),
           'workspace_name', (SELECT w.name FROM public.erp_workspaces w WHERE w.id = e.workspace_id),
           'window_open', EXISTS (SELECT 1 FROM etna_platform.workspace_terminations t
                                   WHERE t.workspace_id = e.workspace_id AND t.state = 'export_available' AND t.export_until > now()))
    FROM etna_platform.workspace_exports e WHERE e.id = p_export_id;
$$;

-- The company's tables (every public table with workspace_id but internal ones).
CREATE OR REPLACE FUNCTION ps_worker.export_tables()
RETURNS TABLE (table_name TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.relname::text
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
   WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p')
     AND c.relname NOT IN ('erp_workspace_invitations', 'ps_jobs', 'erp_invitation_attempts')
   ORDER BY 1;
$$;

-- One page of a company table, without secrets.
CREATE OR REPLACE FUNCTION ps_worker.export_rows(p_workspace_id UUID, p_table TEXT, p_offset INTEGER, p_limit INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  secret TEXT[];
  out JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ps_worker.export_tables() x WHERE x.table_name = p_table) THEN
    RAISE EXCEPTION 'Unknown table' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(a.attname::text), '{}') INTO secret
    FROM pg_attribute a
   WHERE a.attrelid = ('public.' || quote_ident(p_table))::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname ~* '(hash|secret|token|password|encrypted|private_key|api_key)';
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) - $2), ''[]''::jsonb) FROM (SELECT * FROM public.%I WHERE workspace_id = $1 ORDER BY 1 OFFSET $3 LIMIT $4) t',
                 p_table)
    INTO out USING p_workspace_id, secret, GREATEST(p_offset, 0), LEAST(GREATEST(p_limit, 1), 5000);
  RETURN out;
END;
$$;

CREATE OR REPLACE FUNCTION ps_worker.export_datasets(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', d.id, 'name', d.name, 'folder', d.folder, 'description', d.description,
           'columns', (SELECT COALESCE(jsonb_agg(jsonb_build_object('physical', c.physical_name, 'label', c.label, 'type', c.type,
                                                                    'sensitive', c.sensitive, 'hidden', c.hidden) ORDER BY c.position), '[]')
                         FROM public.ps_dataset_columns c WHERE c.dataset_id = d.id AND c.provisioned))
           ORDER BY d.folder, d.name), '[]')
    FROM public.ps_datasets d
   WHERE d.workspace_id = p_workspace_id AND d.deleted_at IS NULL AND d.physical_table ~ '^ds_[0-9a-f]{32}$'
     AND to_regclass('ps_data.' || d.physical_table) IS NOT NULL;
$$;

-- One page of a dataset's rows (by _id). The tables keep row-level security
-- forced for everyone; for this read the owner lifts it inside this
-- transaction only (the lock keeps everyone else out until it is back).
CREATE OR REPLACE FUNCTION ps_admin.export_dataset_rows(p_dataset_id UUID, p_after BIGINT, p_limit INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ps_data, public, pg_temp
AS $$
DECLARE
  d public.ps_datasets;
  out JSONB;
BEGIN
  SELECT * INTO d FROM public.ps_datasets x WHERE x.id = p_dataset_id;
  IF d.id IS NULL OR d.physical_table !~ '^ds_[0-9a-f]{32}$' THEN RAISE EXCEPTION 'Unknown dataset' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM etna_platform.workspace_terminations t
                  WHERE t.workspace_id = d.workspace_id AND t.state = 'export_available' AND t.export_until > now()) THEN
    RAISE EXCEPTION 'Datasets are exported only during a termination''s export period' USING ERRCODE = '42501';
  END IF;
  EXECUTE format('ALTER TABLE ps_data.%I NO FORCE ROW LEVEL SECURITY', d.physical_table);
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) - ''_workspace_id'' - ''_row_hash'' - ''_deleted_at'' ORDER BY t._id), ''[]''::jsonb)
                    FROM (SELECT * FROM ps_data.%I WHERE _deleted_at IS NULL AND _id > $1 ORDER BY _id LIMIT $2) t', d.physical_table)
    INTO out USING COALESCE(p_after, 0), LEAST(GREATEST(p_limit, 1), 5000);
  EXECUTE format('ALTER TABLE ps_data.%I FORCE ROW LEVEL SECURITY', d.physical_table);
  RETURN out;
END;
$$;

CREATE OR REPLACE FUNCTION ps_worker.export_finished(p_export_id UUID, p_status TEXT, p_file_key TEXT, p_size BIGINT, p_error TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, public, pg_temp
AS $$
DECLARE
  e etna_platform.workspace_exports;
BEGIN
  IF p_status NOT IN ('ready', 'failed') THEN RAISE EXCEPTION 'Invalid status' USING ERRCODE = '22023'; END IF;
  UPDATE etna_platform.workspace_exports
     SET status = p_status, file_key = p_file_key, size_bytes = p_size, error_key = left(p_error, 80), finished_at = now()
   WHERE id = p_export_id AND status = 'preparing'
  RETURNING * INTO e;
  IF e.id IS NOT NULL THEN
    PERFORM etna_platform._log(CASE WHEN p_status = 'ready' THEN 'COMPANY_EXPORT_READY' ELSE 'COMPANY_EXPORT_FAILED' END,
      CASE WHEN p_status = 'ready' THEN 'success' ELSE 'failure' END, 'system', NULL, NULL, e.workspace_id,
      jsonb_build_object('size_bytes', p_size, 'error', p_error));
  END IF;
END;
$$;

DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['ps_worker.export_get(uuid)', 'ps_worker.export_tables()', 'ps_worker.export_rows(uuid,text,integer,integer)',
                           'ps_worker.export_datasets(uuid)', 'ps_worker.export_finished(uuid,text,text,bigint,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO etna_worker', f);
  END LOOP;
  -- Grants first: once etna_ddl owns the function, only it may grant.
  REVOKE ALL ON FUNCTION ps_admin.export_dataset_rows(UUID, BIGINT, INTEGER) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION ps_admin.export_dataset_rows(UUID, BIGINT, INTEGER) TO etna_worker;
  ALTER FUNCTION ps_admin.export_dataset_rows(UUID, BIGINT, INTEGER) OWNER TO etna_ddl;
END;
$$;
GRANT USAGE ON SCHEMA etna_platform TO etna_ddl;
GRANT SELECT ON etna_platform.workspace_terminations TO etna_ddl;

REVOKE ALL ON FUNCTION public.erp__export_window_open(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_request_company_export(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_company_exports(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_company_export_file(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_request_company_export(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_company_exports(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_company_export_file(UUID) TO authenticated;
