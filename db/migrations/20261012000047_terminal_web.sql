-- TERMINAL web extraction (P2): a website as a connection (kind 'web').
--
-- * A website connection is one site (its origin). Each sync reads pages from
--   a list or the site's sitemap (optionally following a "next page" link)
--   and takes records out of them: an HTML table, repeated items picked with
--   CSS selectors, JSON-LD, an RSS or Atom feed, or a JSON, CSV or XML file
--   (ps_syncs.source: {mode: 'web', format, pages, urls, sitemap, filter,
--   next, max_pages, table, item, fields, types, records, record, key};
--   object 'web'). Pages are read as the server sends them; no JavaScript runs.
-- * The worker obeys robots.txt, reads one page a second (or the site's
--   Crawl-delay, up to 10 s), stays on the site, and leaves the dataset as it
--   is when everything it read hashes the same as last time.
-- * Syncing needs 'integrations.use' (reading public pages changes nothing).
--
-- Rollback: db/rollback/rollback_20261012000047_terminal_web.sql

ALTER TABLE public.ps_connections DROP CONSTRAINT IF EXISTS ps_connections_kind_check;
ALTER TABLE public.ps_connections ADD CONSTRAINT ps_connections_kind_check
  CHECK (kind IN ('accurate', 'jurnal', 'odoo', 'sap_b1', 'postgres', 'rest', 'web'));

-- A sync of one table or query of a database, one endpoint of an API, or one
-- source of a website, into a new dataset.
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
  IF mode IS NULL OR NOT ((c.kind = 'postgres' AND mode IN ('table', 'query')) OR (c.kind = 'rest' AND mode = 'rest') OR (c.kind = 'web' AND mode = 'web')) THEN
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
  IF mode = 'web' AND COALESCE(p_source ->> 'format', '') NOT IN ('table', 'list', 'jsonld', 'feed', 'json', 'csv', 'xml') THEN
    RAISE EXCEPTION 'A website sync names what it reads' USING ERRCODE = '22023';
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
