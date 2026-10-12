-- TERMINAL connectors (P2): connections to other ERPs (Accurate Online,
-- Jurnal by Mekari, Odoo, SAP Business One) and syncs of their lists into
-- datasets, run by the worker.
--
-- * ps_connections: what a connection is (kind, name, settings that are not
--   secret). Members with 'integrations.use' see them; 'integrations.manage'
--   (with two-factor) adds, changes and removes them.
-- * Secrets (passwords, API keys, OAuth tokens) are encrypted by the app
--   (AES-256-GCM, src/server/vault.ts) and kept in
--   etna_platform.connection_secrets, which no signed-in user can read; only
--   the worker gets them (ps_worker.connection_get).
-- * ps_syncs: one ERP list into one dataset (created with the sync), on demand
--   or on a schedule; incremental where the ERP allows it, with a full refresh
--   every few days that also removes rows deleted in the ERP.
-- * Outgoing connections are checked by the app (no internal addresses unless
--   ETNA allows them: etna_platform.settings.connector_private_hosts).
--
-- Rollback: db/rollback/rollback_20261012000041_terminal_connectors.sql

ALTER TABLE etna_platform.settings ADD COLUMN IF NOT EXISTS connector_private_hosts TEXT[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(connector_private_hosts) <= 50);

CREATE TABLE IF NOT EXISTS public.ps_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('accurate', 'jurnal', 'odoo', 'sap_b1')),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(config) <= 8192),
  status TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'ok', 'failed', 'needs_auth')),
  last_tested_at TIMESTAMPTZ,
  last_error_key TEXT CHECK (last_error_key IS NULL OR char_length(last_error_key) <= 80),
  has_secret BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ps_connections_name ON public.ps_connections (workspace_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS etna_platform.connection_secrets (
  connection_id UUID PRIMARY KEY REFERENCES public.ps_connections(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL CHECK (ciphertext ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' AND char_length(ciphertext) <= 65536),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON etna_platform.connection_secrets FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.ps_syncs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.ps_connections(id) ON DELETE CASCADE,
  object TEXT NOT NULL CHECK (object ~ '^[a-z_]{2,40}$'),
  dataset_id UUID NOT NULL REFERENCES public.ps_datasets(id) ON DELETE CASCADE,
  -- Where the last incremental run got to (the ERP's own "changed since" value).
  cursor JSONB,
  full_every_days SMALLINT NOT NULL DEFAULT 7 CHECK (full_every_days BETWEEN 1 AND 90),
  last_full_at TIMESTAMPTZ,
  schedule_kind TEXT CHECK (schedule_kind IS NULL OR schedule_kind IN ('interval', 'daily', 'weekly', 'monthly', 'cron')),
  schedule_spec JSONB,
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta' CHECK (char_length(timezone) <= 64),
  next_run_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT true,
  run_as UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  run_as_aal TEXT NOT NULL DEFAULT 'aal1' CHECK (run_as_aal IN ('aal1', 'aal2')),
  last_run_at TIMESTAMPTZ,
  last_status TEXT CHECK (last_status IS NULL OR last_status IN ('ok', 'failed')),
  last_error_key TEXT CHECK (last_error_key IS NULL OR char_length(last_error_key) <= 80),
  last_rows INTEGER,
  last_removed INTEGER,
  failure_streak SMALLINT NOT NULL DEFAULT 0,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, object)
);
CREATE INDEX IF NOT EXISTS ps_syncs_due ON public.ps_syncs (next_run_at) WHERE enabled;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ps_connections', 'ps_syncs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.erp_has_permission(workspace_id, ''integrations.use'') OR public.erp_has_permission(workspace_id, ''integrations.manage''))', t || '_read', t);
    EXECUTE format('DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.%I', t);
    EXECUTE format('CREATE POLICY erp_workspace_not_suspended ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
                   'USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[])) '
                   'WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))', t);
  END LOOP;
END;
$$;

-- Jobs of connectors need 'integrations.use'.
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
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.ps__require_connection_manager(p_workspace_id UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.erp_has_permission(p_workspace_id, 'integrations.manage') OR public.erp_session_aal() IS DISTINCT FROM 'aal2' THEN
    RAISE EXCEPTION 'Connections are managed by members allowed to, signed in with two-factor' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  IF NOT public.ps__terminal_on(p_workspace_id) THEN
    RAISE EXCEPTION 'TERMINAL is not added to this ERP (Dashboard → Add modules)' USING ERRCODE = 'P0001', HINT = 'terminal_off';
  END IF;
END;
$$;

-- Adds or changes a connection. p_secret: the app's ciphertext; NULL keeps the stored one.
CREATE OR REPLACE FUNCTION public.ps_save_connection(
  p_workspace_id UUID, p_id UUID, p_kind TEXT, p_name TEXT, p_config JSONB, p_secret TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
DECLARE
  c public.ps_connections;
  saved UUID;
BEGIN
  PERFORM public.ps__require_connection_manager(p_workspace_id);
  IF p_id IS NULL THEN
    INSERT INTO public.ps_connections (workspace_id, kind, name, config, created_by)
    VALUES (p_workspace_id, p_kind, btrim(p_name), COALESCE(p_config, '{}'::jsonb), auth.uid())
    RETURNING id INTO saved;
  ELSE
    SELECT * INTO c FROM public.ps_connections x WHERE x.id = p_id AND x.workspace_id = p_workspace_id FOR UPDATE;
    IF c.id IS NULL THEN RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002'; END IF;
    UPDATE public.ps_connections
       SET name = btrim(p_name), config = COALESCE(p_config, config), status = 'untested', last_error_key = NULL, updated_at = now()
     WHERE id = c.id;
    saved := c.id;
  END IF;
  IF p_secret IS NOT NULL THEN
    INSERT INTO etna_platform.connection_secrets (connection_id, ciphertext) VALUES (saved, p_secret)
    ON CONFLICT (connection_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now();
    UPDATE public.ps_connections SET has_secret = true WHERE id = saved;
  END IF;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (p_workspace_id, auth.uid(), CASE WHEN p_id IS NULL THEN 'connection.added' ELSE 'connection.changed' END,
          jsonb_build_object('connection_id', saved, 'kind', p_kind, 'name', btrim(p_name), 'secret_changed', p_secret IS NOT NULL));
  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_delete_connection(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.ps_connections;
BEGIN
  SELECT * INTO c FROM public.ps_connections x WHERE x.id = p_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.ps__require_connection_manager(c.workspace_id);
  DELETE FROM public.ps_connections WHERE id = c.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (c.workspace_id, auth.uid(), 'connection.removed', jsonb_build_object('connection_id', c.id, 'kind', c.kind, 'name', c.name));
END;
$$;

-- A sync of one ERP list into a new dataset (columns from the app's catalogue).
CREATE OR REPLACE FUNCTION public.ps_create_sync(p_connection_id UUID, p_object TEXT, p_dataset_name TEXT, p_columns JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.ps_connections;
  ds UUID;
  sync UUID;
BEGIN
  SELECT * INTO c FROM public.ps_connections x WHERE x.id = p_connection_id;
  IF c.id IS NULL OR NOT public.erp_has_permission(c.workspace_id, 'integrations.use') THEN
    RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002';
  END IF;
  ds := public.ps_create_dataset(c.workspace_id, p_dataset_name, c.name, 'Synced from ' || c.name || ' (' || p_object || ')', p_columns);
  INSERT INTO public.ps_syncs (workspace_id, connection_id, object, dataset_id, run_as, run_as_aal, created_by)
  VALUES (c.workspace_id, c.id, p_object, ds, auth.uid(), public.erp_session_aal(), auth.uid())
  RETURNING id INTO sync;
  UPDATE public.ps_datasets SET erp_area = NULL WHERE id = ds;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (c.workspace_id, auth.uid(), 'sync.added', jsonb_build_object('sync_id', sync, 'connection_id', c.id, 'object', p_object, 'dataset_id', ds));
  RETURN sync;
END;
$$;

-- Schedule (next_run_at from the app, which understands the spec), on/off, full-refresh interval.
CREATE OR REPLACE FUNCTION public.ps_set_sync(
  p_sync_id UUID, p_enabled BOOLEAN, p_kind TEXT, p_spec JSONB, p_timezone TEXT, p_next_run_at TIMESTAMPTZ, p_full_every_days INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.ps_syncs;
BEGIN
  SELECT * INTO s FROM public.ps_syncs x WHERE x.id = p_sync_id FOR UPDATE;
  IF s.id IS NULL OR NOT public.erp_has_permission(s.workspace_id, 'integrations.use')
     OR NOT public.erp_has_permission(s.workspace_id, 'pipelines.schedule') THEN
    RAISE EXCEPTION 'You are not allowed to schedule this sync' USING ERRCODE = '42501';
  END IF;
  UPDATE public.ps_syncs
     SET enabled = COALESCE(p_enabled, enabled), schedule_kind = p_kind, schedule_spec = p_spec,
         timezone = COALESCE(NULLIF(p_timezone, ''), timezone), next_run_at = p_next_run_at,
         full_every_days = COALESCE(p_full_every_days, full_every_days), failure_streak = 0,
         run_as = auth.uid(), run_as_aal = public.erp_session_aal()
   WHERE id = s.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (s.workspace_id, auth.uid(), 'sync.scheduled', jsonb_build_object('sync_id', s.id, 'kind', p_kind, 'spec', p_spec, 'enabled', p_enabled));
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_delete_sync(p_sync_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.ps_syncs;
BEGIN
  SELECT * INTO s FROM public.ps_syncs x WHERE x.id = p_sync_id;
  IF s.id IS NULL OR NOT public.erp_has_permission(s.workspace_id, 'integrations.manage') THEN
    RAISE EXCEPTION 'You are not allowed to remove this sync' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.ps_syncs WHERE id = s.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (s.workspace_id, auth.uid(), 'sync.removed', jsonb_build_object('sync_id', s.id, 'dataset_id', s.dataset_id));
END;
$$;

-- ─── For the worker ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ps_worker.connection_get(p_connection_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform, pg_temp
AS $$
  SELECT to_jsonb(c) || jsonb_build_object(
           'secret', (SELECT s.ciphertext FROM etna_platform.connection_secrets s WHERE s.connection_id = c.id),
           'private_hosts', (SELECT to_jsonb(st.connector_private_hosts) FROM etna_platform.settings st WHERE st.id),
           'terminal_on', public.ps__terminal_on(c.workspace_id))
    FROM public.ps_connections c WHERE c.id = p_connection_id;
$$;

-- Refreshed OAuth tokens and the outcome of a test or sync.
CREATE OR REPLACE FUNCTION ps_worker.connection_update(p_connection_id UUID, p_status TEXT, p_error TEXT, p_secret TEXT, p_config JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, etna_platform, pg_temp
AS $$
BEGIN
  UPDATE public.ps_connections
     SET status = COALESCE(p_status, status), last_error_key = CASE WHEN p_status IS NULL THEN last_error_key ELSE left(p_error, 80) END,
         last_tested_at = CASE WHEN p_status IS NULL THEN last_tested_at ELSE now() END,
         config = CASE WHEN p_config IS NULL THEN config ELSE config || p_config END, updated_at = now()
   WHERE id = p_connection_id;
  IF p_secret IS NOT NULL THEN
    UPDATE etna_platform.connection_secrets SET ciphertext = p_secret, updated_at = now() WHERE connection_id = p_connection_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION ps_worker.sync_get(p_sync_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT to_jsonb(s) FROM public.ps_syncs s WHERE s.id = p_sync_id;
$$;

CREATE OR REPLACE FUNCTION ps_worker.sync_finished(
  p_sync_id UUID, p_ok BOOLEAN, p_cursor JSONB, p_full BOOLEAN, p_rows INTEGER, p_removed INTEGER, p_error TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s public.ps_syncs;
BEGIN
  UPDATE public.ps_syncs
     SET last_run_at = now(), last_status = CASE WHEN p_ok THEN 'ok' ELSE 'failed' END, last_error_key = left(p_error, 80),
         last_rows = p_rows, last_removed = p_removed,
         cursor = CASE WHEN p_ok THEN p_cursor ELSE cursor END,
         last_full_at = CASE WHEN p_ok AND p_full THEN now() ELSE last_full_at END,
         failure_streak = CASE WHEN p_ok THEN 0 ELSE failure_streak + 1 END
   WHERE id = p_sync_id
  RETURNING * INTO s;
  -- Three failures in a row switch the schedule off.
  IF s.id IS NOT NULL AND s.failure_streak >= 3 AND s.enabled AND s.schedule_kind IS NOT NULL THEN
    UPDATE public.ps_syncs SET enabled = false WHERE id = s.id;
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    VALUES (s.workspace_id, s.run_as, 'sync.schedule_disabled', jsonb_build_object('sync_id', s.id, 'reason', 'three_failures'));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION ps_worker.due_syncs(p_limit INTEGER DEFAULT 20)
RETURNS SETOF public.ps_syncs
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM public.ps_syncs s
   WHERE s.enabled AND s.schedule_kind IS NOT NULL AND s.next_run_at IS NOT NULL AND s.next_run_at <= now()
     AND public.ps__terminal_on(s.workspace_id)
   ORDER BY s.next_run_at
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
   FOR UPDATE SKIP LOCKED;
$$;

CREATE OR REPLACE FUNCTION ps_worker.sync_fired(p_sync_id UUID, p_next_run_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.ps_syncs SET next_run_at = p_next_run_at WHERE id = p_sync_id;
$$;

-- ETNA allows connections to internal addresses (e.g. an SAP B1 server in the company's network).
CREATE OR REPLACE FUNCTION etna_platform.admin_set_connector_private_hosts(p_hosts TEXT[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  h TEXT;
BEGIN
  FOREACH h IN ARRAY COALESCE(p_hosts, '{}') LOOP
    IF h !~ '^[A-Za-z0-9.:/_-]{1,255}$' THEN RAISE EXCEPTION 'Invalid host or network' USING ERRCODE = '22023'; END IF;
  END LOOP;
  UPDATE etna_platform.settings SET connector_private_hosts = COALESCE(p_hosts, '{}'), updated_at = now() WHERE id;
  PERFORM etna_platform._log('CONNECTOR_NETWORKS_CHANGED', 'success', 'admin', NULL, NULL, NULL, jsonb_build_object('hosts', to_jsonb(p_hosts)));
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_connector_private_hosts()
RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor', 'security_officer'], false);
BEGIN
  RETURN (SELECT s.connector_private_hosts FROM etna_platform.settings s WHERE s.id);
END;
$$;

DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['ps_worker.connection_get(uuid)', 'ps_worker.connection_update(uuid,text,text,text,jsonb)',
                           'ps_worker.sync_get(uuid)', 'ps_worker.sync_finished(uuid,boolean,jsonb,boolean,integer,integer,text)',
                           'ps_worker.due_syncs(integer)', 'ps_worker.sync_fired(uuid,timestamptz)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO etna_worker', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.ps_save_connection(uuid,uuid,text,text,jsonb,text)', 'public.ps_delete_connection(uuid)',
                           'public.ps_create_sync(uuid,text,text,jsonb)',
                           'public.ps_set_sync(uuid,boolean,text,jsonb,text,timestamptz,integer)', 'public.ps_delete_sync(uuid)',
                           'etna_platform.admin_set_connector_private_hosts(text[])', 'etna_platform.admin_connector_private_hosts()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.ps__require_connection_manager(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps_job_permission(TEXT) FROM PUBLIC, anon, authenticated;
