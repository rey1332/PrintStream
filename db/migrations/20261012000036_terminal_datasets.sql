-- TERMINAL datasets: one real PostgreSQL table per dataset (decision R-06),
-- created only by the worker through fixed functions (decision R-11).
--
-- * Metadata (public): ps_datasets, ps_dataset_columns (label, type, key,
--   sensitive, hidden), ps_dataset_versions (schema history),
--   ps_item_grants (restricted lists for datasets and pipelines),
--   ps_lineage_edges.
-- * Data (schema ps_data, owned by the role etna_ddl): table ds_<id> with
--   columns c_<n> named by the server, never by users, plus _id,
--   _workspace_id, _loaded_at, _source_kind, _source_id, _row_hash and
--   _deleted_at. Row-level security is enabled AND forced, with policies for
--   every role that decide by the signed-in user's claims
--   (ps_can_access_dataset): even the table's owner and the schema owner's
--   functions see only what that user may.
-- * Reading: the view dsv_<id> (also etna_ddl's), the only thing signed-in
--   users may SELECT. It leaves out hidden columns and removed rows and masks
--   sensitive columns unless the user has 'data.sensitive'.
-- * Writing: ps_rows_* functions (insert, upsert, replace, edit, delete),
--   which check the permission again and build their SQL from the metadata.
-- * Provisioning: ps_admin.* (owner etna_ddl), executable only by the
--   worker's role etna_worker. The app's role never creates or alters tables.
--
-- Rollback: db/rollback/rollback_20261012000036_terminal_datasets.sql

-- ─── Roles and schemas ───────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_ddl') THEN
    CREATE ROLE etna_ddl NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END;
$$;
-- The schema owner may hand objects to etna_ddl (it creates the functions and
-- gives them to it) but does not take on its rights.
GRANT etna_ddl TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;

CREATE SCHEMA IF NOT EXISTS ps_data AUTHORIZATION etna_ddl;
-- Only etna_ddl may grant on its schema. The schema owner's own functions
-- write datasets, so it needs to reach them too.
DO $$
DECLARE
  me TEXT := current_user;
BEGIN
  SET LOCAL ROLE etna_ddl;
  REVOKE ALL ON SCHEMA ps_data FROM PUBLIC;
  GRANT USAGE ON SCHEMA ps_data TO authenticated, etna_worker;
  EXECUTE format('GRANT USAGE ON SCHEMA ps_data TO %I', me);
  EXECUTE format('SET LOCAL ROLE %I', me);
END;
$$;
CREATE SCHEMA IF NOT EXISTS ps_admin;
REVOKE ALL ON SCHEMA ps_admin FROM PUBLIC;
GRANT USAGE ON SCHEMA ps_admin TO etna_worker;

-- ─── Metadata ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ps_datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  folder TEXT NOT NULL DEFAULT '' CHECK (char_length(folder) <= 120),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  access TEXT NOT NULL DEFAULT 'workspace' CHECK (access IN ('workspace', 'restricted')),
  -- Sales and Inventory may open a dataset linked to an ERP area they read.
  erp_area TEXT CHECK (erp_area IS NULL OR erp_area IN ('customers', 'suppliers', 'products', 'stock', 'purchase_orders', 'sales_orders', 'invoices', 'payments', 'books')),
  status TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning', 'ready', 'altering', 'failed', 'deleted')),
  error TEXT CHECK (error IS NULL OR char_length(error) <= 500),
  physical_table TEXT NOT NULL CHECK (physical_table ~ '^ds_[0-9a-f]{32}$'),
  row_count BIGINT NOT NULL DEFAULT 0,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  next_column INTEGER NOT NULL DEFAULT 1,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (physical_table)
);
CREATE UNIQUE INDEX IF NOT EXISTS ps_datasets_name_key ON public.ps_datasets (workspace_id, lower(folder), lower(btrim(name))) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.ps_dataset_columns (
  dataset_id UUID NOT NULL REFERENCES public.ps_datasets(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  physical_name TEXT NOT NULL CHECK (physical_name ~ '^c_[0-9]{1,4}$'),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 1000),
  label TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  type TEXT NOT NULL CHECK (type IN ('text', 'integer', 'decimal', 'boolean', 'date', 'timestamp', 'json')),
  required BOOLEAN NOT NULL DEFAULT false,
  is_key BOOLEAN NOT NULL DEFAULT false,
  sensitive BOOLEAN NOT NULL DEFAULT false,
  hidden BOOLEAN NOT NULL DEFAULT false,
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  unit TEXT NOT NULL DEFAULT '' CHECK (char_length(unit) <= 30),
  -- false until the worker has added it to the table.
  provisioned BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, physical_name)
);
CREATE UNIQUE INDEX IF NOT EXISTS ps_dataset_columns_label ON public.ps_dataset_columns (dataset_id, lower(btrim(label))) WHERE NOT hidden;

CREATE TABLE IF NOT EXISTS public.ps_dataset_versions (
  id BIGSERIAL PRIMARY KEY,
  dataset_id UUID NOT NULL REFERENCES public.ps_datasets(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  change JSONB NOT NULL CHECK (pg_column_size(change) <= 16384),
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ps_item_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('dataset', 'pipeline')),
  item_id UUID NOT NULL,
  grantee_kind TEXT NOT NULL CHECK (grantee_kind IN ('member', 'role', 'custom_role')),
  grantee TEXT NOT NULL CHECK (char_length(grantee) <= 64),
  -- Checked against erp_all_permissions() by ps_set_item_access, the only writer.
  permissions TEXT[] NOT NULL,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_kind, item_id, grantee_kind, grantee)
);

CREATE TABLE IF NOT EXISTS public.ps_lineage_edges (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  from_kind TEXT NOT NULL CHECK (from_kind IN ('dataset', 'erp_entity', 'import', 'connector')),
  from_id TEXT NOT NULL CHECK (char_length(from_id) <= 120),
  to_kind TEXT NOT NULL CHECK (to_kind IN ('dataset', 'erp_entity')),
  to_id TEXT NOT NULL CHECK (char_length(to_id) <= 120),
  via_kind TEXT NOT NULL CHECK (via_kind IN ('pipeline', 'import')),
  via_id UUID,
  run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ps_lineage_to ON public.ps_lineage_edges (workspace_id, to_kind, to_id);
CREATE INDEX IF NOT EXISTS ps_lineage_from ON public.ps_lineage_edges (workspace_id, from_kind, from_id);

-- ─── Access ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ps_op_permission(p_op TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_op
    WHEN 'view' THEN 'datasets.view' WHEN 'query' THEN 'datasets.query' WHEN 'import' THEN 'datasets.import'
    WHEN 'edit' THEN 'datasets.edit' WHEN 'schema' THEN 'datasets.schema' WHEN 'export' THEN 'datasets.export'
    WHEN 'share' THEN 'datasets.share' WHEN 'delete' THEN 'datasets.delete' ELSE NULL END;
$$;

-- Whether the signed-in user may do `p_op` with a dataset: the role's
-- permission, and for a restricted dataset also a place on its list.
CREATE OR REPLACE FUNCTION public.ps_can_access_dataset(p_dataset_id UUID, p_op TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.ps_datasets;
  role TEXT;
  perms TEXT[];
  needed TEXT := public.ps_op_permission(p_op);
  custom UUID;
BEGIN
  IF auth.uid() IS NULL OR needed IS NULL THEN RETURN false; END IF;
  SELECT * INTO d FROM public.ps_datasets x WHERE x.id = p_dataset_id;
  IF d.id IS NULL OR d.deleted_at IS NOT NULL THEN RETURN false; END IF;
  role := public.erp_workspace_role(d.workspace_id);
  IF role IS NULL OR NOT public.erp_workspace_mfa_ok(d.workspace_id) THEN RETURN false; END IF;
  IF role = 'owner' THEN RETURN true; END IF;
  perms := public.erp_member_permissions(d.workspace_id);
  IF NOT (needed = ANY(perms) OR (p_op IN ('view', 'query') AND d.erp_area IS NOT NULL AND perms && public.erp_read_grants(d.erp_area))) THEN
    RETURN false;
  END IF;
  IF d.access = 'workspace' THEN RETURN true; END IF;
  SELECT m.custom_role_id INTO custom FROM public.erp_workspace_members m
   WHERE m.workspace_id = d.workspace_id AND m.user_id = auth.uid() AND m.status = 'active';
  RETURN EXISTS (
    SELECT 1 FROM public.ps_item_grants g
     WHERE g.item_kind = 'dataset' AND g.item_id = d.id AND needed = ANY(g.permissions)
       AND ((g.grantee_kind = 'member' AND g.grantee = auth.uid()::text)
         OR (g.grantee_kind = 'role' AND g.grantee = role)
         OR (g.grantee_kind = 'custom_role' AND custom IS NOT NULL AND g.grantee = custom::text)));
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_can_unmask(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Sensitive values need the permission and a two-factor session (decision R-21).
  SELECT public.erp_has_permission(p_workspace_id, 'data.sensitive') AND public.erp_session_aal() = 'aal2';
$$;

CREATE OR REPLACE FUNCTION public.ps_mask_text(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_value IS NULL THEN NULL
              WHEN char_length(p_value) <= 4 THEN '••••'
              ELSE repeat('•', LEAST(char_length(p_value) - 4, 8)) || right(p_value, 4) END;
$$;

CREATE OR REPLACE FUNCTION public.ps_sql_type(p_type TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_type WHEN 'text' THEN 'text' WHEN 'integer' THEN 'bigint' WHEN 'decimal' THEN 'numeric'
    WHEN 'boolean' THEN 'boolean' WHEN 'date' THEN 'date' WHEN 'timestamp' THEN 'timestamptz' WHEN 'json' THEN 'jsonb' END;
$$;

-- Metadata is read by members who may open the dataset; changed through functions only.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ps_datasets', 'ps_dataset_columns', 'ps_dataset_versions', 'ps_item_grants', 'ps_lineage_edges'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO etna_ddl', t);
    EXECUTE format('DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.%I', t);
    EXECUTE format('CREATE POLICY erp_workspace_not_suspended ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
                   'USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[])) '
                   'WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_ddl', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO etna_ddl USING (true)', t || '_ddl', t);
  END LOOP;
END;
$$;
DROP POLICY IF EXISTS ps_datasets_read ON public.ps_datasets;
CREATE POLICY ps_datasets_read ON public.ps_datasets FOR SELECT TO authenticated USING (public.ps_can_access_dataset(id, 'view'));
DROP POLICY IF EXISTS ps_dataset_columns_read ON public.ps_dataset_columns;
CREATE POLICY ps_dataset_columns_read ON public.ps_dataset_columns FOR SELECT TO authenticated USING (public.ps_can_access_dataset(dataset_id, 'view'));
DROP POLICY IF EXISTS ps_dataset_versions_read ON public.ps_dataset_versions;
CREATE POLICY ps_dataset_versions_read ON public.ps_dataset_versions FOR SELECT TO authenticated USING (public.ps_can_access_dataset(dataset_id, 'view'));
DROP POLICY IF EXISTS ps_item_grants_read ON public.ps_item_grants;
CREATE POLICY ps_item_grants_read ON public.ps_item_grants FOR SELECT TO authenticated USING (public.erp_workspace_role(workspace_id) IS NOT NULL);
DROP POLICY IF EXISTS ps_lineage_edges_read ON public.ps_lineage_edges;
CREATE POLICY ps_lineage_edges_read ON public.ps_lineage_edges FOR SELECT TO authenticated USING (public.erp_has_permission(workspace_id, 'datasets.view'));

-- ─── Creating and changing datasets (members; the worker builds the table) ───

-- Columns: [{label, type, required?, key?, sensitive?, description?, unit?}]
CREATE OR REPLACE FUNCTION public.ps__validate_columns(p_columns JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  c JSONB;
BEGIN
  IF jsonb_typeof(p_columns) <> 'array' OR jsonb_array_length(p_columns) > 500 THEN
    RAISE EXCEPTION 'Give at most 500 columns' USING ERRCODE = '22023';
  END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(p_columns) LOOP
    IF char_length(btrim(COALESCE(c ->> 'label', ''))) NOT BETWEEN 1 AND 120 THEN
      RAISE EXCEPTION 'Every column needs a name (at most 120 characters)' USING ERRCODE = '22023';
    END IF;
    IF COALESCE(c ->> 'type', '') NOT IN ('text', 'integer', 'decimal', 'boolean', 'date', 'timestamp', 'json') THEN
      RAISE EXCEPTION 'Unknown column type %', c ->> 'type' USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_create_dataset(
  p_workspace_id UUID, p_name TEXT, p_folder TEXT, p_description TEXT, p_columns JSONB,
  p_access TEXT DEFAULT 'workspace', p_erp_area TEXT DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ds UUID := gen_random_uuid();
  c JSONB;
  n INTEGER := 0;
BEGIN
  IF NOT public.erp_has_permission(p_workspace_id, 'datasets.schema') THEN
    RAISE EXCEPTION 'You are not allowed to create datasets in this workspace' USING ERRCODE = '42501';
  END IF;
  PERFORM public.ps__validate_columns(COALESCE(p_columns, '[]'::jsonb));
  INSERT INTO public.ps_datasets (id, workspace_id, name, folder, description, access, erp_area, physical_table, created_by)
  VALUES (ds, p_workspace_id, btrim(p_name), btrim(COALESCE(p_folder, '')), left(COALESCE(p_description, ''), 2000),
          COALESCE(p_access, 'workspace'), p_erp_area, 'ds_' || replace(ds::text, '-', ''), auth.uid());
  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(p_columns, '[]'::jsonb)) LOOP
    n := n + 1;
    INSERT INTO public.ps_dataset_columns (dataset_id, workspace_id, physical_name, position, label, type, required, is_key, sensitive, description, unit)
    VALUES (ds, p_workspace_id, 'c_' || n, n, btrim(c ->> 'label'), c ->> 'type', COALESCE((c ->> 'required')::boolean, false),
            COALESCE((c ->> 'key')::boolean, false), COALESCE((c ->> 'sensitive')::boolean, false),
            left(COALESCE(c ->> 'description', ''), 500), left(COALESCE(c ->> 'unit', ''), 30));
  END LOOP;
  UPDATE public.ps_datasets SET next_column = n + 1 WHERE id = ds;
  INSERT INTO public.ps_dataset_versions (dataset_id, workspace_id, version, change, created_by)
  VALUES (ds, p_workspace_id, 1, jsonb_build_object('created', true, 'columns', COALESCE(p_columns, '[]'::jsonb)), auth.uid());
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (p_workspace_id, auth.uid(), 'dataset.created', jsonb_build_object('dataset_id', ds, 'name', btrim(p_name), 'columns', n));
  PERFORM public.ps_enqueue_job(p_workspace_id, 'dataset.provision', jsonb_build_object('dataset_id', ds), 'provision-' || ds::text);
  RETURN ds;
END;
$$;

-- Changes: {name?, folder?, description?, access?, erp_area?,
--   columns: [{physical_name, label?, sensitive?, description?, unit?, hidden?}],
--   add: [{label, type, ...}]}. New columns are added to the table by the worker.
CREATE OR REPLACE FUNCTION public.ps_alter_dataset(p_dataset_id UUID, p_changes JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.ps_datasets;
  c JSONB;
  n INTEGER;
  physical BOOLEAN := false;
BEGIN
  SELECT * INTO d FROM public.ps_datasets x WHERE x.id = p_dataset_id FOR UPDATE;
  IF d.id IS NULL OR NOT public.ps_can_access_dataset(d.id, 'schema') THEN
    RAISE EXCEPTION 'You are not allowed to change this dataset' USING ERRCODE = '42501';
  END IF;
  IF d.status NOT IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'The dataset is being prepared; try again in a moment' USING ERRCODE = 'P0001', HINT = 'busy';
  END IF;
  IF (p_changes ? 'access' OR p_changes ? 'erp_area') AND NOT public.ps_can_access_dataset(d.id, 'share') THEN
    RAISE EXCEPTION 'You are not allowed to change who sees this dataset' USING ERRCODE = '42501';
  END IF;
  UPDATE public.ps_datasets SET
    name = COALESCE(NULLIF(btrim(p_changes ->> 'name'), ''), name),
    folder = COALESCE(btrim(p_changes ->> 'folder'), folder),
    description = COALESCE(left(p_changes ->> 'description', 2000), description),
    access = COALESCE(p_changes ->> 'access', access),
    erp_area = CASE WHEN p_changes ? 'erp_area' THEN NULLIF(p_changes ->> 'erp_area', '') ELSE erp_area END,
    updated_at = now()
  WHERE id = d.id;
  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(p_changes -> 'columns', '[]'::jsonb)) LOOP
    UPDATE public.ps_dataset_columns SET
      label = COALESCE(NULLIF(btrim(c ->> 'label'), ''), label),
      sensitive = COALESCE((c ->> 'sensitive')::boolean, sensitive),
      hidden = COALESCE((c ->> 'hidden')::boolean, hidden),
      description = COALESCE(left(c ->> 'description', 500), description),
      unit = COALESCE(left(c ->> 'unit', 30), unit)
    WHERE dataset_id = d.id AND physical_name = c ->> 'physical_name';
    IF c ? 'sensitive' OR c ? 'hidden' THEN physical := true; END IF;
  END LOOP;
  IF p_changes ? 'add' THEN
    PERFORM public.ps__validate_columns(p_changes -> 'add');
    n := d.next_column;
    FOR c IN SELECT * FROM jsonb_array_elements(p_changes -> 'add') LOOP
      INSERT INTO public.ps_dataset_columns (dataset_id, workspace_id, physical_name, position, label, type, required, is_key, sensitive, description, unit)
      VALUES (d.id, d.workspace_id, 'c_' || n, n, btrim(c ->> 'label'), c ->> 'type', false, false,
              COALESCE((c ->> 'sensitive')::boolean, false), left(COALESCE(c ->> 'description', ''), 500), left(COALESCE(c ->> 'unit', ''), 30));
      n := n + 1;
    END LOOP;
    UPDATE public.ps_datasets SET next_column = n WHERE id = d.id;
    physical := true;
  END IF;
  UPDATE public.ps_datasets SET schema_version = schema_version + 1 WHERE id = d.id RETURNING schema_version INTO n;
  INSERT INTO public.ps_dataset_versions (dataset_id, workspace_id, version, change, created_by)
  VALUES (d.id, d.workspace_id, n, p_changes, auth.uid());
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (d.workspace_id, auth.uid(), 'dataset.changed', jsonb_build_object('dataset_id', d.id, 'version', n));
  IF physical THEN
    UPDATE public.ps_datasets SET status = 'altering' WHERE id = d.id;
    PERFORM public.ps_enqueue_job(d.workspace_id, 'dataset.alter', jsonb_build_object('dataset_id', d.id, 'version', n),
                                  'alter-' || d.id::text || '-' || n);
  END IF;
  RETURN n;
END;
$$;

-- Deleting hides the dataset at once; its table is dropped 30 days later.
CREATE OR REPLACE FUNCTION public.ps_delete_dataset(p_dataset_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.ps_datasets;
BEGIN
  SELECT * INTO d FROM public.ps_datasets x WHERE x.id = p_dataset_id FOR UPDATE;
  IF d.id IS NULL OR NOT public.ps_can_access_dataset(d.id, 'delete') THEN
    RAISE EXCEPTION 'You are not allowed to delete this dataset' USING ERRCODE = '42501';
  END IF;
  UPDATE public.ps_datasets SET status = 'deleted', deleted_at = now(), updated_at = now() WHERE id = d.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (d.workspace_id, auth.uid(), 'dataset.deleted', jsonb_build_object('dataset_id', d.id, 'name', d.name));
  INSERT INTO public.ps_jobs (workspace_id, kind, payload, as_user, trigger, run_after, idempotency_key, max_attempts)
  VALUES (d.workspace_id, 'dataset.purge', jsonb_build_object('dataset_id', d.id), auth.uid(), 'system', now() + interval '30 days',
          'purge-' || d.id::text, 3);
END;
$$;

-- Who may open a restricted dataset or pipeline: grants = [{kind, grantee, permissions}].
CREATE OR REPLACE FUNCTION public.ps_set_item_access(p_item_kind TEXT, p_item_id UUID, p_access TEXT, p_grants JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID;
  g JSONB;
  mine TEXT[];
BEGIN
  IF p_access NOT IN ('workspace', 'restricted') THEN RAISE EXCEPTION 'Unknown access' USING ERRCODE = '22023'; END IF;
  IF p_item_kind = 'dataset' THEN
    SELECT d.workspace_id INTO ws FROM public.ps_datasets d WHERE d.id = p_item_id;
    IF ws IS NULL OR NOT public.ps_can_access_dataset(p_item_id, 'share') THEN
      RAISE EXCEPTION 'You are not allowed to share this dataset' USING ERRCODE = '42501';
    END IF;
    UPDATE public.ps_datasets SET access = p_access, updated_at = now() WHERE id = p_item_id;
  ELSIF p_item_kind = 'pipeline' THEN
    SELECT w.workspace_id INTO ws FROM public.workflows w WHERE w.id = p_item_id;
    IF ws IS NULL OR NOT public.erp_has_permission(ws, 'pipelines.edit') THEN
      RAISE EXCEPTION 'You are not allowed to share this pipeline' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown item' USING ERRCODE = '22023';
  END IF;
  mine := public.erp_member_permissions(ws);
  DELETE FROM public.ps_item_grants WHERE item_kind = p_item_kind AND item_id = p_item_id;
  FOR g IN SELECT * FROM jsonb_array_elements(COALESCE(p_grants, '[]'::jsonb)) LOOP
    IF g ->> 'kind' NOT IN ('member', 'role', 'custom_role') THEN RAISE EXCEPTION 'Unknown grantee' USING ERRCODE = '22023'; END IF;
    IF NOT ARRAY(SELECT jsonb_array_elements_text(g -> 'permissions')) <@ public.erp_all_permissions() THEN
      RAISE EXCEPTION 'Unknown permission' USING ERRCODE = '22023';
    END IF;
    -- Nobody passes on more than they hold.
    IF public.erp_workspace_role(ws) <> 'owner'
       AND NOT ARRAY(SELECT jsonb_array_elements_text(g -> 'permissions')) <@ mine THEN
      RAISE EXCEPTION 'You cannot give permissions you do not have' USING ERRCODE = '42501', HINT = 'escalation';
    END IF;
    INSERT INTO public.ps_item_grants (workspace_id, item_kind, item_id, grantee_kind, grantee, permissions, created_by)
    VALUES (ws, p_item_kind, p_item_id, g ->> 'kind', left(g ->> 'grantee', 64),
            ARRAY(SELECT jsonb_array_elements_text(g -> 'permissions')), auth.uid());
  END LOOP;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'item.access_changed', jsonb_build_object('kind', p_item_kind, 'id', p_item_id, 'access', p_access,
          'grants', COALESCE(p_grants, '[]'::jsonb)));
END;
$$;

-- ─── Rows (members, by permission; SQL built from the metadata) ──────────────

-- The live row count shown in lists, kept by the row functions below.
CREATE OR REPLACE FUNCTION public.ps__count_rows(p_dataset_id UUID, p_delta INTEGER)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ps_datasets SET row_count = GREATEST(row_count + COALESCE(p_delta, 0), 0), updated_at = now()
   WHERE id = p_dataset_id AND COALESCE(p_delta, 0) <> 0;
$$;

-- The column list of a dataset's provisioned columns: physical name and SQL type.
CREATE OR REPLACE FUNCTION public.ps__columns(p_dataset_id UUID)
RETURNS TABLE (physical_name TEXT, sql_type TEXT, is_key BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.physical_name, public.ps_sql_type(c.type), c.is_key
    FROM public.ps_dataset_columns c
   WHERE c.dataset_id = p_dataset_id AND c.provisioned AND c.physical_name ~ '^c_[0-9]{1,4}$'
   ORDER BY c.position;
$$;

CREATE OR REPLACE FUNCTION public.ps__writable(p_dataset_id UUID, p_op TEXT)
RETURNS public.ps_datasets
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.ps_datasets;
BEGIN
  SELECT * INTO d FROM public.ps_datasets x WHERE x.id = p_dataset_id;
  IF d.id IS NULL OR d.status NOT IN ('ready', 'altering') OR NOT public.ps_can_access_dataset(d.id, p_op) THEN
    RAISE EXCEPTION 'You are not allowed to write this dataset' USING ERRCODE = '42501';
  END IF;
  IF d.physical_table !~ '^ds_[0-9a-f]{32}$' THEN RAISE EXCEPTION 'Invalid dataset' USING ERRCODE = '22023'; END IF;
  RETURN d;
END;
$$;

-- Inserts rows: [{c_1: ..., c_2: ...}], tagged with where they came from.
-- p_mode: append (insert), upsert (by the key columns) or replace (the rows
-- with an older source are marked removed after the new ones are in).
CREATE OR REPLACE FUNCTION public.ps_rows_write(p_dataset_id UUID, p_rows JSONB, p_mode TEXT, p_source_kind TEXT, p_source_id TEXT, p_op TEXT DEFAULT 'import')
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, ps_data, pg_temp
AS $$
DECLARE
  d public.ps_datasets;
  cols TEXT;
  defs TEXT;
  keys TEXT;
  updates TEXT;
  n INTEGER;
  fresh INTEGER;
  quota JSONB;
BEGIN
  IF p_op NOT IN ('import', 'edit') THEN RAISE EXCEPTION 'Invalid write' USING ERRCODE = '22023'; END IF;
  d := public.ps__writable(p_dataset_id, p_op);
  IF p_mode NOT IN ('append', 'upsert', 'replace') THEN RAISE EXCEPTION 'Unknown write mode' USING ERRCODE = '22023'; END IF;
  IF p_source_kind NOT IN ('import', 'pipeline', 'manual', 'connector') THEN RAISE EXCEPTION 'Unknown source' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'Rows must be a list' USING ERRCODE = '22023'; END IF;
  IF jsonb_array_length(p_rows) > 10000 THEN RAISE EXCEPTION 'At most 10,000 rows per batch' USING ERRCODE = '22023'; END IF;
  quota := etna_platform.storage_state(d.workspace_id);
  IF quota ->> 'quota_bytes' IS NOT NULL
     AND (quota ->> 'used_bytes')::bigint + (quota ->> 'reserved_bytes')::bigint >= (quota ->> 'quota_bytes')::bigint
     AND p_source_kind <> 'manual' THEN
    RAISE EXCEPTION 'This company''s storage quota is full' USING ERRCODE = 'P0001', HINT = 'quota_exceeded';
  END IF;
  SELECT string_agg(format('%I', c.physical_name), ', '), string_agg(format('%I %s', c.physical_name, c.sql_type), ', '),
         string_agg(format('%I', c.physical_name), ', ') FILTER (WHERE c.is_key),
         string_agg(format('%1$I = EXCLUDED.%1$I', c.physical_name), ', ')
    INTO cols, defs, keys, updates
    FROM public.ps__columns(d.id) c;
  IF cols IS NULL THEN RAISE EXCEPTION 'The dataset has no columns yet' USING ERRCODE = 'P0001', HINT = 'no_columns'; END IF;
  IF p_mode = 'upsert' AND keys IS NULL THEN
    RAISE EXCEPTION 'Upsert needs key columns' USING ERRCODE = 'P0001', HINT = 'no_key';
  END IF;
  EXECUTE format(
    'WITH w AS (INSERT INTO ps_data.%1$I (_workspace_id, _source_kind, _source_id, _row_hash, %2$s)
     SELECT $1, $2, $3, md5(r.item::text), %4$s
       FROM jsonb_array_elements($4) AS r(item), jsonb_to_record(r.item) AS x(%3$s) %5$s
     RETURNING (xmax = 0) AS fresh)
     SELECT count(*)::int, (count(*) FILTER (WHERE fresh))::int FROM w',
    d.physical_table, cols, defs, (SELECT string_agg(format('x.%I', c.physical_name), ', ') FROM public.ps__columns(d.id) c),
    CASE WHEN p_mode = 'upsert' THEN format('ON CONFLICT (%s) WHERE _deleted_at IS NULL DO UPDATE SET %s, _source_kind = EXCLUDED._source_kind, _source_id = EXCLUDED._source_id, _row_hash = EXCLUDED._row_hash, _loaded_at = now()', keys, updates) ELSE '' END)
  USING d.workspace_id, p_source_kind, left(p_source_id, 120), p_rows
  INTO n, fresh;
  PERFORM public.ps__count_rows(d.id, fresh);
  RETURN n;
END;
$$;

-- After a replace: every row from an earlier source is marked removed (kept 7 days).
CREATE OR REPLACE FUNCTION public.ps_rows_finish_replace(p_dataset_id UUID, p_source_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, ps_data, pg_temp
AS $$
DECLARE
  d public.ps_datasets := public.ps__writable(p_dataset_id, 'import');
  n INTEGER;
BEGIN
  EXECUTE format('UPDATE ps_data.%I SET _deleted_at = now() WHERE _deleted_at IS NULL AND _source_id IS DISTINCT FROM $1', d.physical_table)
  USING left(p_source_id, 120);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM public.ps__count_rows(d.id, -n);
  RETURN n;
END;
$$;

-- A failed or retried run removes what it had written so far (idempotent retries).
CREATE OR REPLACE FUNCTION public.ps_rows_undo_source(p_dataset_id UUID, p_source_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, ps_data, pg_temp
AS $$
DECLARE
  d public.ps_datasets := public.ps__writable(p_dataset_id, 'import');
  n INTEGER;
BEGIN
  EXECUTE format('WITH x AS (DELETE FROM ps_data.%I WHERE _source_id = $1 RETURNING _deleted_at IS NULL AS live)
                  SELECT (count(*) FILTER (WHERE live))::int FROM x', d.physical_table)
  USING left(p_source_id, 120) INTO n;
  PERFORM public.ps__count_rows(d.id, -n);
  RETURN n;
END;
$$;

-- Editing in the grid: one row's values ({c_n: value}); removing rows (kept 7 days).
CREATE OR REPLACE FUNCTION public.ps_row_update(p_dataset_id UUID, p_row_id BIGINT, p_values JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, ps_data, pg_temp
AS $$
DECLARE
  d public.ps_datasets := public.ps__writable(p_dataset_id, 'edit');
  sets TEXT;
BEGIN
  SELECT string_agg(format('%1$I = (jsonb_populate_record(NULL::ps_data.%2$I, jsonb_build_object(%3$L, $1 -> %3$L))).%1$I',
                           c.physical_name, d.physical_table, c.physical_name), ', ')
    INTO sets
    FROM public.ps__columns(d.id) c
   WHERE p_values ? c.physical_name;
  IF sets IS NULL THEN RETURN; END IF;
  EXECUTE format('UPDATE ps_data.%I SET %s, _source_kind = ''manual'', _loaded_at = now() WHERE _id = $2 AND _deleted_at IS NULL', d.physical_table, sets)
  USING p_values, p_row_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_rows_delete(p_dataset_id UUID, p_row_ids BIGINT[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, ps_data, pg_temp
AS $$
DECLARE
  d public.ps_datasets := public.ps__writable(p_dataset_id, 'edit');
  n INTEGER;
BEGIN
  EXECUTE format('UPDATE ps_data.%I SET _deleted_at = now() WHERE _id = ANY($1) AND _deleted_at IS NULL', d.physical_table) USING p_row_ids;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM public.ps__count_rows(d.id, -n);
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_record_lineage(
  p_workspace_id UUID, p_from_kind TEXT, p_from_id TEXT, p_to_kind TEXT, p_to_id TEXT, p_via_kind TEXT, p_via_id UUID, p_run_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.erp_has_permission(p_workspace_id, 'datasets.import') AND NOT public.erp_has_permission(p_workspace_id, 'pipelines.run') THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  -- One edge per source, target and route: a new run replaces the run reference.
  DELETE FROM public.ps_lineage_edges e
   WHERE e.workspace_id = p_workspace_id AND e.from_kind = p_from_kind AND e.from_id = p_from_id
     AND e.to_kind = p_to_kind AND e.to_id = p_to_id AND e.via_kind = p_via_kind AND e.via_id IS NOT DISTINCT FROM p_via_id;
  INSERT INTO public.ps_lineage_edges (workspace_id, from_kind, from_id, to_kind, to_id, via_kind, via_id, run_id)
  VALUES (p_workspace_id, p_from_kind, left(p_from_id, 120), p_to_kind, left(p_to_id, 120), p_via_kind, p_via_id, p_run_id);
END;
$$;

-- Status and counters, set by the provisioning functions and the worker.
CREATE OR REPLACE FUNCTION public.ps__set_dataset_state(p_dataset_id UUID, p_status TEXT, p_error TEXT, p_provisioned BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.ps_datasets SET status = COALESCE(p_status, status), error = left(p_error, 500), updated_at = now()
   WHERE id = p_dataset_id AND status <> 'deleted';
  IF p_provisioned THEN
    UPDATE public.ps_dataset_columns SET provisioned = true WHERE dataset_id = p_dataset_id;
  END IF;
END;
$$;

-- ─── Provisioning (etna_ddl; only the worker may call it) ────────────────────

-- The read view: no hidden columns, no removed rows, sensitive columns masked.
CREATE OR REPLACE FUNCTION ps_admin.rebuild_view(p_dataset_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ps_data, public, pg_temp
AS $$
DECLARE
  d public.ps_datasets;
  cols TEXT;
  view_name TEXT;
BEGIN
  SELECT * INTO d FROM public.ps_datasets x WHERE x.id = p_dataset_id;
  IF d.id IS NULL OR d.physical_table !~ '^ds_[0-9a-f]{32}$' THEN RAISE EXCEPTION 'Unknown dataset' USING ERRCODE = 'P0002'; END IF;
  view_name := 'dsv_' || substr(d.physical_table, 4);
  SELECT string_agg(
           CASE WHEN c.sensitive AND c.type = 'text'
                  THEN format('CASE WHEN public.ps_can_unmask(%L) THEN t.%2$I ELSE public.ps_mask_text(t.%2$I) END AS %2$I', d.workspace_id, c.physical_name)
                WHEN c.sensitive
                  THEN format('CASE WHEN public.ps_can_unmask(%L) THEN t.%2$I END AS %2$I', d.workspace_id, c.physical_name)
                ELSE format('t.%1$I', c.physical_name) END, ', ' ORDER BY c.position)
    INTO cols
    FROM public.ps_dataset_columns c
   WHERE c.dataset_id = d.id AND NOT c.hidden AND c.physical_name ~ '^c_[0-9]{1,4}$'
     AND EXISTS (SELECT 1 FROM information_schema.columns ic
                  WHERE ic.table_schema = 'ps_data' AND ic.table_name = d.physical_table AND ic.column_name = c.physical_name);
  EXECUTE format('DROP VIEW IF EXISTS ps_data.%I', view_name);
  EXECUTE format('CREATE VIEW ps_data.%I WITH (security_barrier = true) AS SELECT t._id, t._loaded_at, t._source_kind, t._source_id%s FROM ps_data.%I t WHERE t._deleted_at IS NULL',
                 view_name, CASE WHEN cols IS NULL THEN '' ELSE ', ' || cols END, d.physical_table);
  EXECUTE format('REVOKE ALL ON ps_data.%I FROM PUBLIC', view_name);
  EXECUTE format('GRANT SELECT ON ps_data.%I TO authenticated', view_name);
END;
$$;

CREATE OR REPLACE FUNCTION ps_admin.provision_dataset(p_dataset_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ps_data, public, pg_temp
AS $$
DECLARE
  d public.ps_datasets;
  defs TEXT;
  keys TEXT;
  owner_role TEXT := (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'public');
BEGIN
  SELECT * INTO d FROM public.ps_datasets x WHERE x.id = p_dataset_id;
  IF d.id IS NULL OR d.physical_table !~ '^ds_[0-9a-f]{32}$' THEN RAISE EXCEPTION 'Unknown dataset' USING ERRCODE = 'P0002'; END IF;
  IF d.status = 'deleted' THEN RETURN; END IF;
  -- The job runs with the creator's rights: they must still be allowed.
  IF NOT public.erp_has_permission(d.workspace_id, 'datasets.schema') THEN
    RAISE EXCEPTION 'The creator may no longer create datasets' USING ERRCODE = '42501';
  END IF;
  SELECT string_agg(format('%I %s', c.physical_name, public.ps_sql_type(c.type)), ', ' ORDER BY c.position),
         string_agg(format('%I', c.physical_name), ', ' ORDER BY c.position) FILTER (WHERE c.is_key)
    INTO defs, keys
    FROM public.ps_dataset_columns c
   WHERE c.dataset_id = d.id AND c.physical_name ~ '^c_[0-9]{1,4}$';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS ps_data.%I (
       _id BIGSERIAL PRIMARY KEY,
       _workspace_id UUID NOT NULL CHECK (_workspace_id = %L),
       _loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       _source_kind TEXT NOT NULL DEFAULT ''manual'',
       _source_id TEXT,
       _row_hash TEXT,
       _deleted_at TIMESTAMPTZ%s)',
    d.physical_table, d.workspace_id, CASE WHEN defs IS NULL THEN '' ELSE ', ' || defs END);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON ps_data.%I (_source_id)', d.physical_table || '_src', d.physical_table);
  IF keys IS NOT NULL THEN
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON ps_data.%I (%s) WHERE _deleted_at IS NULL', d.physical_table || '_key', d.physical_table, keys);
  END IF;
  -- Row-level security for everyone, the table's owner included; decided by the user's claims.
  EXECUTE format('ALTER TABLE ps_data.%I ENABLE ROW LEVEL SECURITY', d.physical_table);
  EXECUTE format('ALTER TABLE ps_data.%I FORCE ROW LEVEL SECURITY', d.physical_table);
  EXECUTE format('DROP POLICY IF EXISTS ps_read ON ps_data.%I', d.physical_table);
  EXECUTE format('CREATE POLICY ps_read ON ps_data.%I FOR SELECT USING (public.ps_can_access_dataset(%L, ''view''))', d.physical_table, d.id);
  EXECUTE format('DROP POLICY IF EXISTS ps_insert ON ps_data.%I', d.physical_table);
  EXECUTE format('CREATE POLICY ps_insert ON ps_data.%I FOR INSERT WITH CHECK (_workspace_id = %L AND (public.ps_can_access_dataset(%L, ''import'') OR public.ps_can_access_dataset(%L, ''edit'')))',
                 d.physical_table, d.workspace_id, d.id, d.id);
  EXECUTE format('DROP POLICY IF EXISTS ps_update ON ps_data.%I', d.physical_table);
  EXECUTE format('CREATE POLICY ps_update ON ps_data.%I FOR UPDATE USING (public.ps_can_access_dataset(%2$L, ''import'') OR public.ps_can_access_dataset(%2$L, ''edit'')) WITH CHECK (_workspace_id = %3$L)',
                 d.physical_table, d.id, d.workspace_id);
  EXECUTE format('DROP POLICY IF EXISTS ps_delete ON ps_data.%I', d.physical_table);
  EXECUTE format('CREATE POLICY ps_delete ON ps_data.%I FOR DELETE USING (public.ps_can_access_dataset(%L, ''import''))', d.physical_table, d.id);
  EXECUTE format('DROP POLICY IF EXISTS ps_ddl_read ON ps_data.%I', d.physical_table);
  EXECUTE format('CREATE POLICY ps_ddl_read ON ps_data.%I FOR SELECT TO etna_ddl USING (_deleted_at IS NOT NULL)', d.physical_table);
  EXECUTE format('DROP POLICY IF EXISTS ps_ddl_purge ON ps_data.%I', d.physical_table);
  EXECUTE format('CREATE POLICY ps_ddl_purge ON ps_data.%I FOR DELETE TO etna_ddl USING (_deleted_at IS NOT NULL)', d.physical_table);
  EXECUTE format('REVOKE ALL ON ps_data.%I FROM PUBLIC', d.physical_table);
  -- Signed-in users never read the table itself (only the masking view); the schema
  -- owner's row functions write it, under the policies above.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ps_data.%I TO %I', d.physical_table, owner_role);
  EXECUTE format('GRANT USAGE ON SEQUENCE ps_data.%I TO %I', d.physical_table || '__id_seq', owner_role);
  PERFORM ps_admin.rebuild_view(d.id);
  PERFORM public.ps__set_dataset_state(d.id, 'ready', NULL, true);
END;
$$;

-- Adds the columns the metadata has and the table not yet; rebuilds the view.
CREATE OR REPLACE FUNCTION ps_admin.alter_dataset(p_dataset_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ps_data, public, pg_temp
AS $$
DECLARE
  d public.ps_datasets;
  c RECORD;
BEGIN
  SELECT * INTO d FROM public.ps_datasets x WHERE x.id = p_dataset_id;
  IF d.id IS NULL OR d.physical_table !~ '^ds_[0-9a-f]{32}$' THEN RAISE EXCEPTION 'Unknown dataset' USING ERRCODE = 'P0002'; END IF;
  IF d.status = 'deleted' THEN RETURN; END IF;
  IF NOT public.erp_has_permission(d.workspace_id, 'datasets.schema') THEN
    RAISE EXCEPTION 'Not allowed to change this dataset' USING ERRCODE = '42501';
  END IF;
  FOR c IN
    SELECT x.physical_name, public.ps_sql_type(x.type) AS sql_type FROM public.ps_dataset_columns x
     WHERE x.dataset_id = d.id AND x.physical_name ~ '^c_[0-9]{1,4}$'
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                        WHERE ic.table_schema = 'ps_data' AND ic.table_name = d.physical_table AND ic.column_name = x.physical_name)
     ORDER BY x.position
  LOOP
    EXECUTE format('ALTER TABLE ps_data.%I ADD COLUMN %I %s', d.physical_table, c.physical_name, c.sql_type);
  END LOOP;
  PERFORM ps_admin.rebuild_view(d.id);
  PERFORM public.ps__set_dataset_state(d.id, 'ready', NULL, true);
END;
$$;

-- 30 days after deletion: the table and view go (the metadata stays as history).
CREATE OR REPLACE FUNCTION ps_admin.purge_dataset(p_dataset_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ps_data, public, pg_temp
AS $$
DECLARE
  d public.ps_datasets;
BEGIN
  SELECT * INTO d FROM public.ps_datasets x WHERE x.id = p_dataset_id;
  IF d.id IS NULL OR d.deleted_at IS NULL OR d.deleted_at > now() - interval '29 days' OR d.physical_table !~ '^ds_[0-9a-f]{32}$' THEN
    RETURN false;
  END IF;
  EXECUTE format('DROP VIEW IF EXISTS ps_data.%I', 'dsv_' || substr(d.physical_table, 4));
  EXECUTE format('DROP TABLE IF EXISTS ps_data.%I', d.physical_table);
  RETURN true;
END;
$$;

-- Removed rows past 7 days are deleted for good (all datasets).
CREATE OR REPLACE FUNCTION ps_admin.purge_removed_rows()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ps_data, public, pg_temp
AS $$
DECLARE
  d RECORD;
  n BIGINT := 0;
  m BIGINT;
BEGIN
  FOR d IN SELECT x.physical_table FROM public.ps_datasets x
            WHERE x.deleted_at IS NULL AND x.status IN ('ready', 'altering') AND x.physical_table ~ '^ds_[0-9a-f]{32}$'
              AND to_regclass('ps_data.' || x.physical_table) IS NOT NULL LOOP
    -- Without a user, etna_ddl's own policies let it see and delete removed rows only.
    EXECUTE format('DELETE FROM ps_data.%I WHERE _deleted_at < now() - interval ''7 days''', d.physical_table);
    GET DIAGNOSTICS m = ROW_COUNT;
    n := n + m;
  END LOOP;
  RETURN n;
END;
$$;

-- Sizes per company, for the storage quota.
CREATE OR REPLACE FUNCTION ps_admin.measure_datasets()
RETURNS TABLE (workspace_id UUID, bytes BIGINT, datasets INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ps_data, public, pg_temp
AS $$
  SELECT d.workspace_id,
         COALESCE(sum(pg_total_relation_size(to_regclass('ps_data.' || d.physical_table))), 0)::bigint,
         count(*)::int
    FROM public.ps_datasets d
   WHERE d.physical_table ~ '^ds_[0-9a-f]{32}$' AND to_regclass('ps_data.' || d.physical_table) IS NOT NULL
   GROUP BY d.workspace_id;
$$;

GRANT USAGE, CREATE ON SCHEMA ps_admin TO etna_ddl;
GRANT USAGE ON SCHEMA public TO etna_ddl;
DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['ps_admin.rebuild_view(uuid)', 'ps_admin.provision_dataset(uuid)', 'ps_admin.alter_dataset(uuid)',
                           'ps_admin.purge_dataset(uuid)', 'ps_admin.purge_removed_rows()', 'ps_admin.measure_datasets()'] LOOP
    -- Grants first: once etna_ddl owns the function, only it may grant.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO etna_worker', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO etna_ddl', f);
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION public.ps__set_dataset_state(UUID, TEXT, TEXT, BOOLEAN) TO etna_ddl;
GRANT EXECUTE ON FUNCTION public.ps_can_access_dataset(UUID, TEXT) TO etna_ddl;
-- Functions in a view are checked against the reader.
GRANT EXECUTE ON FUNCTION public.ps_can_unmask(UUID) TO etna_ddl, authenticated;
GRANT EXECUTE ON FUNCTION public.ps_mask_text(TEXT) TO etna_ddl, authenticated;
GRANT EXECUTE ON FUNCTION public.ps_sql_type(TEXT) TO etna_ddl;
GRANT EXECUTE ON FUNCTION public.erp_has_permission(UUID, TEXT) TO etna_ddl;

-- ─── Privileges for members ──────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.ps_op_permission(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps__validate_columns(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps__columns(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps__count_rows(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps__writable(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps__set_dataset_state(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_sql_type(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_can_access_dataset(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_can_unmask(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_mask_text(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_can_access_dataset(UUID, TEXT) TO authenticated;
DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.ps_create_dataset(uuid,text,text,text,jsonb,text,text)', 'public.ps_alter_dataset(uuid,jsonb)',
    'public.ps_delete_dataset(uuid)', 'public.ps_set_item_access(text,uuid,text,jsonb)',
    'public.ps_rows_write(uuid,jsonb,text,text,text,text)', 'public.ps_rows_finish_replace(uuid,text)',
    'public.ps_rows_undo_source(uuid,text)', 'public.ps_row_update(uuid,bigint,jsonb)', 'public.ps_rows_delete(uuid,bigint[])',
    'public.ps_record_lineage(uuid,text,text,text,text,text,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END;
$$;

-- ─── For the worker ──────────────────────────────────────────────────────────

-- Who a job runs as: their e-mail for the session claims, and whether the
-- account may still act (a disabled account's jobs fail).
CREATE OR REPLACE FUNCTION ps_worker.identity(p_user_id UUID)
RETURNS TABLE (user_id UUID, email TEXT, active BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- plpgsql: auth.users.banned_until is only checked when this runs.
  RETURN QUERY
  SELECT p.id, p.email, NOT COALESCE(u.banned_until > now(), false)
    FROM public.user_profiles p JOIN auth.users u ON u.id = p.id
   WHERE p.id = p_user_id;
END;
$$;

-- A provisioning or schema job failed for good.
CREATE OR REPLACE FUNCTION ps_worker.dataset_failed(p_dataset_id UUID, p_error TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.ps__set_dataset_state(p_dataset_id, 'failed', p_error, false);
$$;

-- Each dataset's size on disk, for the lists; returns how many were measured.
CREATE OR REPLACE FUNCTION ps_worker.refresh_dataset_sizes()
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH s AS (
    SELECT d.id, pg_total_relation_size(to_regclass('ps_data.' || d.physical_table)) AS b
      FROM public.ps_datasets d
     WHERE d.deleted_at IS NULL AND d.physical_table ~ '^ds_[0-9a-f]{32}$' AND to_regclass('ps_data.' || d.physical_table) IS NOT NULL),
  u AS (UPDATE public.ps_datasets d SET size_bytes = s.b FROM s WHERE s.id = d.id RETURNING 1)
  SELECT count(*)::int FROM u;
$$;

REVOKE ALL ON FUNCTION ps_worker.refresh_dataset_sizes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ps_worker.refresh_dataset_sizes() TO etna_worker;
REVOKE ALL ON FUNCTION ps_worker.identity(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ps_worker.dataset_failed(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ps_worker.identity(UUID) TO etna_worker;
GRANT EXECUTE ON FUNCTION ps_worker.dataset_failed(UUID, TEXT) TO etna_worker;
