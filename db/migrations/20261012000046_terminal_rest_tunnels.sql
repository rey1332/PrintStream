-- TERMINAL generic REST connections and tunnels (P2).
--
-- * A REST API as a connection (kind 'rest'): the base address and the
--   sign-in in its settings and sealed secret; each sync reads one endpoint
--   (ps_syncs.source: {mode: 'rest', method, path, query, body, records,
--   pagination, since_param, key, changed}; object 'rest'), any number per
--   connection. A GET endpoint needs 'integrations.use', like a table; a POST
--   ("POST as query") could change things in a careless API, so it needs
--   'integrations.manage' and a two-factor sign-in, and the audit log keeps it.
-- * Tunnels: a company's system inside its own network is reached through a
--   zero-trust tunnel (e.g. Cloudflare Tunnel) that arrives at one host:port
--   ETNA's server can reach. ETNA allows that host:port for that company only
--   (etna_platform.network_allowlist, managed in /admin by super admins with
--   two-factor); the connector guard adds it to the platform-wide list for
--   that company's connections. docs/TUNNELS.md has the procedure.
--
-- Rollback: db/rollback/rollback_20261012000046_terminal_rest_tunnels.sql

ALTER TABLE public.ps_connections DROP CONSTRAINT IF EXISTS ps_connections_kind_check;
ALTER TABLE public.ps_connections ADD CONSTRAINT ps_connections_kind_check
  CHECK (kind IN ('accurate', 'jurnal', 'odoo', 'sap_b1', 'postgres', 'rest'));

-- A sync of one table or query of a database, or one endpoint of an API,
-- into a new dataset (columns as the worker described them, types as the
-- user chose).
CREATE OR REPLACE FUNCTION public.ps_create_source_sync(
  p_connection_id UUID, p_source JSONB, p_label TEXT, p_dataset_name TEXT, p_columns JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.ps_connections;
  mode TEXT := p_source ->> 'mode';
  ds UUID;
  sync UUID;
BEGIN
  SELECT * INTO c FROM public.ps_connections x WHERE x.id = p_connection_id;
  IF c.id IS NULL OR NOT public.erp_has_permission(c.workspace_id, 'integrations.use') THEN
    RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002';
  END IF;
  IF mode IS NULL OR NOT ((c.kind = 'postgres' AND mode IN ('table', 'query')) OR (c.kind = 'rest' AND mode = 'rest')) THEN
    RAISE EXCEPTION 'Not a source of this connection' USING ERRCODE = '22023';
  END IF;
  IF mode = 'table' AND (COALESCE(p_source ->> 'schema', '') = '' OR COALESCE(p_source ->> 'table', '') = '') THEN
    RAISE EXCEPTION 'A table sync names its schema and table' USING ERRCODE = '22023';
  END IF;
  IF mode = 'query' THEN
    -- Any read-only SQL: for those who manage connections, with two-factor.
    PERFORM public.ps__require_connection_manager(c.workspace_id);
    IF char_length(COALESCE(p_source ->> 'sql', '')) NOT BETWEEN 1 AND 20000 THEN
      RAISE EXCEPTION 'The query is empty or too long' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF mode = 'rest' THEN
    IF COALESCE(p_source ->> 'path', '') !~ '^/' OR COALESCE(p_source ->> 'method', '') NOT IN ('GET', 'POST') THEN
      RAISE EXCEPTION 'An endpoint sync names its method and path' USING ERRCODE = '22023';
    END IF;
    -- POST as query: for those who manage connections, with two-factor.
    IF p_source ->> 'method' = 'POST' THEN
      PERFORM public.ps__require_connection_manager(c.workspace_id);
    END IF;
  END IF;
  ds := public.ps_create_dataset(c.workspace_id, p_dataset_name, c.name, 'Synced from ' || c.name || ' (' || left(btrim(p_label), 200) || ')', p_columns);
  INSERT INTO public.ps_syncs (workspace_id, connection_id, object, source, label, dataset_id, run_as, run_as_aal, created_by)
  VALUES (c.workspace_id, c.id, mode, p_source, left(btrim(p_label), 200), ds, auth.uid(), public.erp_session_aal(), auth.uid())
  RETURNING id INTO sync;
  UPDATE public.ps_datasets SET erp_area = NULL WHERE id = ds;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (c.workspace_id, auth.uid(), 'sync.added', jsonb_build_object('sync_id', sync, 'connection_id', c.id, 'object', mode, 'source', p_source, 'dataset_id', ds));
  RETURN sync;
END;
$$;
REVOKE ALL ON FUNCTION public.ps_create_source_sync(UUID, JSONB, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_create_source_sync(UUID, JSONB, TEXT, TEXT, JSONB) TO authenticated;

-- ─── Tunnels: internal host:port allowed for one company ─────────────────────

CREATE TABLE IF NOT EXISTS etna_platform.network_allowlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  -- host:port, e.g. sap.internal:50000, 10.20.0.5:5432, [fd00::5]:443
  host TEXT NOT NULL CHECK (host ~ '^(\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252}):[0-9]{1,5}$'),
  purpose TEXT NOT NULL CHECK (char_length(btrim(purpose)) BETWEEN 1 AND 200),
  approved_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS network_allowlist_entry ON etna_platform.network_allowlist (workspace_id, lower(host));
REVOKE ALL ON etna_platform.network_allowlist FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION etna_platform.admin_network_allowlist()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, public, pg_temp
AS $$
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor', 'security_officer'], false);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'workspace_id', a.workspace_id, 'workspace_name', w.name,
                                        'host', a.host, 'purpose', a.purpose, 'created_at', a.created_at)
                     ORDER BY lower(w.name), lower(a.host))
      FROM etna_platform.network_allowlist a JOIN public.erp_workspaces w ON w.id = a.workspace_id), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_add_network_allow(p_workspace_id UUID, p_host TEXT, p_purpose TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  port INTEGER;
  saved UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.erp_workspaces w WHERE w.id = p_workspace_id) THEN
    RAISE EXCEPTION 'Company not found' USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(p_host, '') !~ '^(\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252}):[0-9]{1,5}$' THEN
    RAISE EXCEPTION 'Give one host and port (host:port)' USING ERRCODE = '22023';
  END IF;
  port := substring(p_host FROM ':([0-9]{1,5})$')::INTEGER;
  IF port NOT BETWEEN 1 AND 65535 THEN
    RAISE EXCEPTION 'Give one host and port (host:port)' USING ERRCODE = '22023';
  END IF;
  -- Never the server itself or cloud metadata.
  IF lower(p_host) ~ '^(localhost|127\.|0\.|169\.254\.|\[::1?\]|\[fe80)' THEN
    RAISE EXCEPTION 'This address is never allowed' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM etna_platform.network_allowlist a WHERE a.workspace_id = p_workspace_id) >= 20 THEN
    RAISE EXCEPTION 'At most 20 entries a company' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO etna_platform.network_allowlist (workspace_id, host, purpose, approved_by)
  VALUES (p_workspace_id, lower(p_host), btrim(p_purpose), auth.uid())
  RETURNING id INTO saved;
  PERFORM etna_platform._log('NETWORK_ALLOW_ADDED', 'success', 'admin', NULL, NULL, p_workspace_id,
                             jsonb_build_object('host', lower(p_host), 'purpose', btrim(p_purpose)));
  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_remove_network_allow(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  a etna_platform.network_allowlist;
BEGIN
  DELETE FROM etna_platform.network_allowlist x WHERE x.id = p_id RETURNING * INTO a;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'Entry not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM etna_platform._log('NETWORK_ALLOW_REMOVED', 'success', 'admin', NULL, NULL, a.workspace_id,
                             jsonb_build_object('host', a.host));
END;
$$;

REVOKE ALL ON FUNCTION etna_platform.admin_network_allowlist() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_add_network_allow(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_remove_network_allow(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION etna_platform.admin_network_allowlist() TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_add_network_allow(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_remove_network_allow(UUID) TO authenticated;

-- The connection for the worker: the platform-wide internal hosts plus the
-- company's own tunnel entries.
CREATE OR REPLACE FUNCTION ps_worker.connection_get(p_connection_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform, pg_temp
AS $$
  SELECT to_jsonb(c) || jsonb_build_object(
           'secret', (SELECT s.ciphertext FROM etna_platform.connection_secrets s WHERE s.connection_id = c.id),
           'private_hosts', COALESCE((SELECT to_jsonb(st.connector_private_hosts) FROM etna_platform.settings st WHERE st.id), '[]'::jsonb)
                            || COALESCE((SELECT jsonb_agg(a.host) FROM etna_platform.network_allowlist a WHERE a.workspace_id = c.workspace_id), '[]'::jsonb),
           'terminal_on', public.ps__terminal_on(c.workspace_id))
    FROM public.ps_connections c WHERE c.id = p_connection_id;
$$;
REVOKE ALL ON FUNCTION ps_worker.connection_get(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ps_worker.connection_get(UUID) TO etna_worker;
