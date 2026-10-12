-- Storage quotas per company (workspace), set centrally by ETNA.
--
-- * etna_platform.workspace_storage: quota (NULL = the platform default,
--   which may itself be unlimited), upload limit override, the company's
--   storage folder (set from ETNA.bat), and the last measured use:
--   TERMINAL datasets, files on disk and an estimate of the ERP records.
-- * Everything counts (decision R-33); the ERP part is an estimate (rows per
--   workspace x average row size per table) because ERP tables are shared.
-- * Uploads and imports reserve their size first, inside a lock on the
--   company's row, so parallel jobs cannot pass the quota together.
--   Reservations expire after a day if never released.
-- * Over quota, growth is refused (uploads, imports, datasets); ERP data
--   entry is never blocked and nothing is ever deleted to make room.
-- * Crossing 80, 90 and 100 % writes STORAGE_WARNING to the security log
--   (shown in /admin and to the Owner).
--
-- Rollback: db/rollback/rollback_20261012000034_storage_quotas.sql

ALTER TABLE etna_platform.settings ADD COLUMN IF NOT EXISTS default_quota_bytes BIGINT CHECK (default_quota_bytes IS NULL OR default_quota_bytes > 0);
ALTER TABLE etna_platform.settings ADD COLUMN IF NOT EXISTS default_max_upload_bytes BIGINT NOT NULL DEFAULT 209715200
  CHECK (default_max_upload_bytes BETWEEN 1048576 AND 10737418240);
ALTER TABLE etna_platform.settings ADD COLUMN IF NOT EXISTS xlsx_max_upload_bytes BIGINT NOT NULL DEFAULT 52428800
  CHECK (xlsx_max_upload_bytes BETWEEN 1048576 AND 1073741824);

CREATE TABLE IF NOT EXISTS etna_platform.workspace_storage (
  workspace_id UUID PRIMARY KEY,
  quota_bytes BIGINT CHECK (quota_bytes IS NULL OR quota_bytes > 0),
  -- true: no limit for this company even if the platform has a default.
  unlimited BOOLEAN NOT NULL DEFAULT false,
  max_upload_bytes BIGINT CHECK (max_upload_bytes IS NULL OR max_upload_bytes BETWEEN 1048576 AND 10737418240),
  storage_dir TEXT CHECK (storage_dir IS NULL OR (char_length(storage_dir) <= 260 AND storage_dir ~ '^[A-Za-z]:\\')),
  used_datasets BIGINT NOT NULL DEFAULT 0 CHECK (used_datasets >= 0),
  used_files BIGINT NOT NULL DEFAULT 0 CHECK (used_files >= 0),
  used_erp_estimate BIGINT NOT NULL DEFAULT 0 CHECK (used_erp_estimate >= 0),
  measured_at TIMESTAMPTZ,
  warned_level SMALLINT NOT NULL DEFAULT 0 CHECK (warned_level IN (0, 80, 90, 100)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON etna_platform.workspace_storage FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS etna_platform.storage_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes > 0),
  purpose TEXT NOT NULL CHECK (purpose ~ '^[a-z_]{2,30}$'),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day'
);
CREATE INDEX IF NOT EXISTS storage_reservations_ws_idx ON etna_platform.storage_reservations (workspace_id, expires_at);
REVOKE ALL ON etna_platform.storage_reservations FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS etna_platform.storage_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  requested_by UUID,
  message TEXT NOT NULL CHECK (char_length(message) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_by UUID,
  handled_at TIMESTAMPTZ
);
REVOKE ALL ON etna_platform.storage_requests FROM PUBLIC, anon, authenticated;

-- The company's numbers: quota (NULL = unlimited), use, reservations, limits.
CREATE OR REPLACE FUNCTION etna_platform.storage_state(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
  SELECT jsonb_build_object(
    'quota_bytes', CASE WHEN COALESCE(ws.unlimited, false) THEN NULL ELSE COALESCE(ws.quota_bytes, st.default_quota_bytes) END,
    'custom_quota', ws.quota_bytes IS NOT NULL OR COALESCE(ws.unlimited, false),
    'used_datasets', COALESCE(ws.used_datasets, 0),
    'used_files', COALESCE(ws.used_files, 0),
    'used_erp_estimate', COALESCE(ws.used_erp_estimate, 0),
    'used_bytes', COALESCE(ws.used_datasets, 0) + COALESCE(ws.used_files, 0) + COALESCE(ws.used_erp_estimate, 0),
    'reserved_bytes', COALESCE((SELECT sum(r.bytes) FROM etna_platform.storage_reservations r
                                 WHERE r.workspace_id = p_workspace_id AND r.expires_at > now()), 0),
    'max_upload_bytes', COALESCE(ws.max_upload_bytes, st.default_max_upload_bytes),
    'xlsx_max_upload_bytes', LEAST(st.xlsx_max_upload_bytes, COALESCE(ws.max_upload_bytes, st.default_max_upload_bytes)),
    'storage_dir', ws.storage_dir,
    'measured_at', ws.measured_at)
  FROM etna_platform.settings st
  LEFT JOIN etna_platform.workspace_storage ws ON ws.workspace_id = p_workspace_id
  WHERE st.id;
$$;

-- For members with 'storage.view' (Owner and Admin by default).
CREATE OR REPLACE FUNCTION public.erp_storage_usage(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
BEGIN
  IF NOT public.erp_has_permission(p_workspace_id, 'storage.view') THEN
    RAISE EXCEPTION 'You are not allowed to see this workspace''s storage' USING ERRCODE = '42501';
  END IF;
  RETURN etna_platform.storage_state(p_workspace_id) - 'storage_dir';
END;
$$;

-- Upload limits for a member who is about to upload (any member).
CREATE OR REPLACE FUNCTION public.erp_upload_limits(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
DECLARE
  s JSONB;
BEGIN
  IF public.erp_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  s := etna_platform.storage_state(p_workspace_id);
  RETURN jsonb_build_object('max_upload_bytes', s -> 'max_upload_bytes', 'xlsx_max_upload_bytes', s -> 'xlsx_max_upload_bytes',
    'available_bytes', CASE WHEN s ->> 'quota_bytes' IS NULL THEN NULL
                            ELSE GREATEST((s ->> 'quota_bytes')::bigint - (s ->> 'used_bytes')::bigint - (s ->> 'reserved_bytes')::bigint, 0) END);
END;
$$;

-- Reserves room for an upload or import; refuses when it would pass the
-- quota or the upload limit. Race-safe: one reservation at a time per company.
CREATE OR REPLACE FUNCTION public.erp_reserve_storage(p_workspace_id UUID, p_bytes BIGINT, p_purpose TEXT, p_kind TEXT DEFAULT 'file')
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
DECLARE
  s JSONB;
  quota BIGINT;
  reservation UUID;
BEGIN
  IF public.erp_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  IF p_bytes IS NULL OR p_bytes <= 0 THEN RAISE EXCEPTION 'Invalid size' USING ERRCODE = '22023'; END IF;
  INSERT INTO etna_platform.workspace_storage (workspace_id) VALUES (p_workspace_id) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM etna_platform.workspace_storage w WHERE w.workspace_id = p_workspace_id FOR UPDATE;
  DELETE FROM etna_platform.storage_reservations r WHERE r.workspace_id = p_workspace_id AND r.expires_at <= now();
  s := etna_platform.storage_state(p_workspace_id);
  IF p_bytes > (s ->> CASE WHEN p_kind = 'xlsx' THEN 'xlsx_max_upload_bytes' ELSE 'max_upload_bytes' END)::bigint THEN
    RAISE EXCEPTION 'The file is larger than the upload limit' USING ERRCODE = 'P0001', HINT = 'too_large';
  END IF;
  quota := (s ->> 'quota_bytes')::bigint;
  IF quota IS NOT NULL AND (s ->> 'used_bytes')::bigint + (s ->> 'reserved_bytes')::bigint + p_bytes > quota THEN
    RAISE EXCEPTION 'This company''s storage quota is full' USING ERRCODE = 'P0001', HINT = 'quota_exceeded';
  END IF;
  INSERT INTO etna_platform.storage_reservations (workspace_id, bytes, purpose, created_by)
  VALUES (p_workspace_id, p_bytes, p_purpose, auth.uid())
  RETURNING id INTO reservation;
  RETURN reservation;
END;
$$;

-- Ends a reservation; the bytes actually stored count as files until the next measurement.
CREATE OR REPLACE FUNCTION public.erp_release_storage(p_reservation_id UUID, p_stored_bytes BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
DECLARE
  r etna_platform.storage_reservations;
BEGIN
  DELETE FROM etna_platform.storage_reservations x WHERE x.id = p_reservation_id AND x.created_by = auth.uid()
  RETURNING * INTO r;
  IF r.id IS NULL THEN RETURN; END IF;
  IF COALESCE(p_stored_bytes, 0) > 0 THEN
    UPDATE etna_platform.workspace_storage SET used_files = used_files + p_stored_bytes, updated_at = now()
     WHERE workspace_id = r.workspace_id;
    PERFORM etna_platform._check_storage_warning(r.workspace_id);
  END IF;
END;
$$;

-- Writes a warning when use crosses 80, 90 or 100 % (once per level; lower again resets).
CREATE OR REPLACE FUNCTION etna_platform._check_storage_warning(p_workspace_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  s JSONB := etna_platform.storage_state(p_workspace_id);
  quota BIGINT := (s ->> 'quota_bytes')::bigint;
  pct NUMERIC;
  level SMALLINT;
  previous SMALLINT;
BEGIN
  IF quota IS NULL THEN
    UPDATE etna_platform.workspace_storage SET warned_level = 0 WHERE workspace_id = p_workspace_id AND warned_level <> 0;
    RETURN;
  END IF;
  pct := 100.0 * (s ->> 'used_bytes')::bigint / quota;
  level := CASE WHEN pct >= 100 THEN 100 WHEN pct >= 90 THEN 90 WHEN pct >= 80 THEN 80 ELSE 0 END;
  SELECT w.warned_level INTO previous FROM etna_platform.workspace_storage w WHERE w.workspace_id = p_workspace_id;
  IF level > COALESCE(previous, 0) THEN
    PERFORM etna_platform._log('STORAGE_WARNING', 'success', 'system', NULL, NULL, p_workspace_id,
      jsonb_build_object('percent', round(pct, 1), 'level', level, 'used', s -> 'used_bytes', 'quota', quota));
  END IF;
  UPDATE etna_platform.workspace_storage SET warned_level = level WHERE workspace_id = p_workspace_id AND warned_level <> level;
END;
$$;

-- The worker's measurement of one company (files on disk and datasets it measured itself).
CREATE OR REPLACE FUNCTION etna_platform.record_storage_measure(p_workspace_id UUID, p_datasets BIGINT, p_files BIGINT, p_erp BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
BEGIN
  INSERT INTO etna_platform.workspace_storage (workspace_id, used_datasets, used_files, used_erp_estimate, measured_at)
  VALUES (p_workspace_id, GREATEST(COALESCE(p_datasets, 0), 0), GREATEST(COALESCE(p_files, 0), 0), GREATEST(COALESCE(p_erp, 0), 0), now())
  -- NULL = that part was not measured this time: it keeps its last value.
  ON CONFLICT (workspace_id) DO UPDATE SET
    used_datasets = CASE WHEN p_datasets IS NULL THEN etna_platform.workspace_storage.used_datasets ELSE EXCLUDED.used_datasets END,
    used_files = CASE WHEN p_files IS NULL THEN etna_platform.workspace_storage.used_files ELSE EXCLUDED.used_files END,
    used_erp_estimate = CASE WHEN p_erp IS NULL THEN etna_platform.workspace_storage.used_erp_estimate ELSE EXCLUDED.used_erp_estimate END,
    measured_at = now(), updated_at = now();
  PERFORM etna_platform._check_storage_warning(p_workspace_id);
END;
$$;

-- ERP records per company, estimated: rows x average row size of each shared table.
CREATE OR REPLACE FUNCTION etna_platform.measure_erp_estimate()
RETURNS TABLE (workspace_id UUID, bytes BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, public, pg_temp
AS $$
DECLARE
  t RECORD;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS erp_estimate (workspace_id UUID, bytes NUMERIC) ON COMMIT DROP;
  TRUNCATE erp_estimate;
  FOR t IN
    SELECT c.oid, c.relname,
           GREATEST(pg_total_relation_size(c.oid), 0)::numeric / GREATEST(c.reltuples::numeric, 1) AS per_row
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
     WHERE ns.nspname = 'public' AND c.relkind = 'r'
       AND c.relname NOT IN ('erp_workspace_members', 'erp_workspace_audit_log', 'erp_access_log', 'erp_workspace_invitations')
  LOOP
    EXECUTE format('INSERT INTO erp_estimate SELECT workspace_id, count(*) * $1 FROM public.%I WHERE workspace_id IS NOT NULL GROUP BY workspace_id', t.relname)
      USING t.per_row;
  END LOOP;
  RETURN QUERY SELECT e.workspace_id, round(sum(e.bytes))::bigint FROM erp_estimate e GROUP BY e.workspace_id;
END;
$$;

-- Owners may ask ETNA for more room (shown in /admin).
CREATE OR REPLACE FUNCTION public.erp_request_storage(p_workspace_id UUID, p_message TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
BEGIN
  IF NOT public.erp_has_permission(p_workspace_id, 'storage.view') THEN
    RAISE EXCEPTION 'You are not allowed to ask for storage for this workspace' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM etna_platform.storage_requests r WHERE r.workspace_id = p_workspace_id AND r.handled_at IS NULL
              AND r.created_at > now() - interval '1 day') THEN
    RAISE EXCEPTION 'A request is already waiting' USING ERRCODE = 'P0001', HINT = 'already';
  END IF;
  INSERT INTO etna_platform.storage_requests (workspace_id, requested_by, message)
  VALUES (p_workspace_id, auth.uid(), left(btrim(COALESCE(p_message, '')), 500));
  PERFORM etna_platform._log('STORAGE_REQUESTED', 'success', 'user', NULL, NULL, p_workspace_id,
    jsonb_build_object('message', left(btrim(COALESCE(p_message, '')), 500)));
END;
$$;

-- ─── Admin ───────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION etna_platform.admin_workspace_storage(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  RETURN etna_platform.storage_state(p_workspace_id) || jsonb_build_object(
    'unlimited', COALESCE((SELECT w.unlimited FROM etna_platform.workspace_storage w WHERE w.workspace_id = p_workspace_id), false),
    'requests', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'message', r.message, 'created_at', r.created_at,
                                   'requested_by_email', (SELECT u.email FROM auth.users u WHERE u.id = r.requested_by),
                                   'handled_at', r.handled_at) ORDER BY r.created_at DESC)
                            FROM etna_platform.storage_requests r WHERE r.workspace_id = p_workspace_id), '[]'::jsonb));
END;
$$;

-- Quota in bytes (NULL = platform default), or unlimited; upload limit (NULL = default).
CREATE OR REPLACE FUNCTION etna_platform.admin_set_workspace_quota(
  p_workspace_id UUID, p_quota_bytes BIGINT, p_unlimited BOOLEAN, p_max_upload_bytes BIGINT, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  previous JSONB := etna_platform.storage_state(p_workspace_id);
BEGIN
  IF char_length(btrim(COALESCE(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Give a reason' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.erp_workspaces w WHERE w.id = p_workspace_id) THEN
    RAISE EXCEPTION 'No such workspace' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO etna_platform.workspace_storage (workspace_id, quota_bytes, unlimited, max_upload_bytes)
  VALUES (p_workspace_id, p_quota_bytes, COALESCE(p_unlimited, false), p_max_upload_bytes)
  ON CONFLICT (workspace_id) DO UPDATE SET quota_bytes = EXCLUDED.quota_bytes, unlimited = EXCLUDED.unlimited,
    max_upload_bytes = EXCLUDED.max_upload_bytes, updated_at = now();
  UPDATE etna_platform.storage_requests SET handled_at = now(), handled_by = auth.uid()
   WHERE workspace_id = p_workspace_id AND handled_at IS NULL;
  PERFORM etna_platform._check_storage_warning(p_workspace_id);
  PERFORM etna_platform._log('STORAGE_QUOTA_CHANGED', 'success', 'admin', NULL, NULL, p_workspace_id,
    jsonb_build_object('quota_bytes', p_quota_bytes, 'unlimited', COALESCE(p_unlimited, false), 'max_upload_bytes', p_max_upload_bytes,
                       'previous_quota', previous -> 'quota_bytes', 'reason', left(btrim(p_reason), 500)));
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_storage_defaults()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  RETURN (SELECT jsonb_build_object('default_quota_bytes', s.default_quota_bytes, 'default_max_upload_bytes', s.default_max_upload_bytes,
                                    'xlsx_max_upload_bytes', s.xlsx_max_upload_bytes)
            FROM etna_platform.settings s WHERE s.id);
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_set_storage_defaults(p_default_quota_bytes BIGINT, p_default_max_upload_bytes BIGINT, p_xlsx_max_upload_bytes BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
BEGIN
  UPDATE etna_platform.settings SET default_quota_bytes = p_default_quota_bytes,
         default_max_upload_bytes = p_default_max_upload_bytes, xlsx_max_upload_bytes = p_xlsx_max_upload_bytes, updated_at = now()
   WHERE id;
  PERFORM etna_platform._log('STORAGE_DEFAULTS_CHANGED', 'success', 'admin', NULL, NULL, NULL,
    jsonb_build_object('default_quota_bytes', p_default_quota_bytes, 'default_max_upload_bytes', p_default_max_upload_bytes,
                       'xlsx_max_upload_bytes', p_xlsx_max_upload_bytes));
END;
$$;

-- ETNA.bat (schema owner) sets the company's storage folder after checking and moving the files.
CREATE OR REPLACE FUNCTION etna_admin.set_workspace_storage_dir(p_workspace_id UUID, p_dir TEXT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = etna_platform, public, pg_temp
AS $$
DECLARE
  previous TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.erp_workspaces w WHERE w.id = p_workspace_id) THEN
    RAISE EXCEPTION 'No such workspace' USING ERRCODE = 'P0002';
  END IF;
  SELECT w.storage_dir INTO previous FROM etna_platform.workspace_storage w WHERE w.workspace_id = p_workspace_id;
  INSERT INTO etna_platform.workspace_storage (workspace_id, storage_dir) VALUES (p_workspace_id, NULLIF(btrim(p_dir), ''))
  ON CONFLICT (workspace_id) DO UPDATE SET storage_dir = EXCLUDED.storage_dir, updated_at = now();
  PERFORM etna_admin._log('STORAGE_DIR_CHANGED', NULL, jsonb_build_object('workspace_id', p_workspace_id, 'dir', NULLIF(btrim(p_dir), ''), 'previous', previous));
END;
$$;

-- For the app's file storage: each company's folder (NULL = the default under ETNA_DATA_ROOT).
CREATE OR REPLACE FUNCTION public.erp_workspace_storage_dir(p_workspace_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
  SELECT w.storage_dir FROM etna_platform.workspace_storage w
   WHERE w.workspace_id = p_workspace_id AND public.erp_workspace_role(p_workspace_id) IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION etna_platform.storage_state(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION etna_platform._check_storage_warning(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION etna_platform.record_storage_measure(UUID, BIGINT, BIGINT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION etna_platform.measure_erp_estimate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION etna_admin.set_workspace_storage_dir(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_storage_usage(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_upload_limits(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_reserve_storage(UUID, BIGINT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_release_storage(UUID, BIGINT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_request_storage(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_workspace_storage_dir(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_workspace_storage(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_set_workspace_quota(UUID, BIGINT, BOOLEAN, BIGINT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_storage_defaults() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_set_storage_defaults(BIGINT, BIGINT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_storage_usage(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_upload_limits(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_reserve_storage(UUID, BIGINT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_release_storage(UUID, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_request_storage(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_workspace_storage_dir(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_workspace_storage(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_set_workspace_quota(UUID, BIGINT, BOOLEAN, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_storage_defaults() TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_set_storage_defaults(BIGINT, BIGINT, BIGINT) TO authenticated;
