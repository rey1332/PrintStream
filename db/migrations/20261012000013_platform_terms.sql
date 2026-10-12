-- Terms & Conditions: versions, acceptance, and enforcement.
--
-- 1. etna_platform.terms_versions: each version of the T&C text (English
--    required; Indonesian and Chinese optional, shown in the reader's
--    language when present). A super admin writes drafts in the admin panel
--    and publishes one; the newest published version is the current one. A
--    published version can never be changed or deleted (trigger). No text is
--    shipped with ETNA: until a version is published nothing is required.
--    A draft that still contains the placeholder marker "[PLACEHOLDER" cannot
--    be published.
-- 2. etna_platform.terms_acceptances: one row per account and version, with
--    when, the language shown, the active workspace, IP, browser and session.
--    Append-only (trigger), no foreign key to the account, so it stays proof.
-- 3. Enforcement in the database: erp_check_request(), which runs at the
--    start of every request from the app as a signed-in user, refuses all
--    data until the account has accepted the current version (HINT
--    terms_required). Accepting goes through the sign-in server, which is
--    not subject to this check.
-- 4. Admin functions: list, read, save and delete drafts, publish, the
--    accounts that have not accepted yet, and an account's acceptance
--    history. Changes need a super admin and a fresh re-authentication, and
--    are recorded in the security log.
--
-- Rollback: db/rollback/rollback_20261012000013_platform_terms.sql

-- ─── 1. Versions ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS etna_platform.terms_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL CHECK (char_length(trim(label)) BETWEEN 1 AND 60),
  -- {"en": "...", "id": "...", "zh": "..."}: plain text, shown as written.
  content JSONB NOT NULL CHECK (
    jsonb_typeof(content) = 'object'
    AND (content - ARRAY['en', 'id', 'zh']) = '{}'::jsonb
    AND char_length(trim(COALESCE(content ->> 'en', ''))) > 0
    AND pg_column_size(content) <= 600000
  ),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by UUID,
  published_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS terms_versions_label_key ON etna_platform.terms_versions (lower(trim(label)));
CREATE INDEX IF NOT EXISTS terms_versions_published_idx
  ON etna_platform.terms_versions (published_at DESC) WHERE published_at IS NOT NULL;

CREATE OR REPLACE FUNCTION etna_platform._terms_versions_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'A published Terms & Conditions version cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS terms_versions_published_fixed ON etna_platform.terms_versions;
CREATE TRIGGER terms_versions_published_fixed
  BEFORE UPDATE OR DELETE ON etna_platform.terms_versions
  FOR EACH ROW EXECUTE FUNCTION etna_platform._terms_versions_guard();

-- ─── 2. Acceptances ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS etna_platform.terms_acceptances (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id UUID NOT NULL REFERENCES etna_platform.terms_versions(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL,
  email TEXT NOT NULL CHECK (char_length(email) <= 320),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- The language the text was shown in, and how it was accepted.
  locale TEXT NOT NULL CHECK (locale IN ('en', 'id', 'zh')),
  method TEXT NOT NULL DEFAULT 'checkbox_and_button' CHECK (method IN ('checkbox_and_button')),
  workspace_id UUID,
  session_id UUID,
  ip TEXT CHECK (char_length(ip) <= 64),
  user_agent TEXT CHECK (char_length(user_agent) <= 400),
  UNIQUE (user_id, version_id)
);
CREATE INDEX IF NOT EXISTS terms_acceptances_version_idx ON etna_platform.terms_acceptances (version_id, accepted_at DESC);

CREATE OR REPLACE FUNCTION etna_platform._terms_acceptances_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Terms & Conditions acceptances are permanent' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS terms_acceptances_append_only ON etna_platform.terms_acceptances;
CREATE TRIGGER terms_acceptances_append_only
  BEFORE UPDATE OR DELETE ON etna_platform.terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION etna_platform._terms_acceptances_guard();
DROP TRIGGER IF EXISTS terms_acceptances_no_truncate ON etna_platform.terms_acceptances;
CREATE TRIGGER terms_acceptances_no_truncate
  BEFORE TRUNCATE ON etna_platform.terms_acceptances
  FOR EACH STATEMENT EXECUTE FUNCTION etna_platform._terms_acceptances_guard();

REVOKE ALL ON etna_platform.terms_versions, etna_platform.terms_acceptances FROM PUBLIC, anon, authenticated;

-- ─── 3. Current version and enforcement ───────────────────────────────────────

CREATE OR REPLACE FUNCTION etna_platform._current_terms_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
  SELECT v.id FROM etna_platform.terms_versions v
   WHERE v.published_at IS NOT NULL
   ORDER BY v.published_at DESC, v.id
   LIMIT 1;
$$;

-- True when a version is published and this account has not accepted it.
CREATE OR REPLACE FUNCTION etna_platform._terms_pending(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  current_id UUID := etna_platform._current_terms_id();
BEGIN
  RETURN current_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM etna_platform.terms_acceptances a WHERE a.user_id = p_user_id AND a.version_id = current_id
  );
END;
$$;

-- As in 20261001000000_erp_mfa_recovery.sql, plus the Terms & Conditions.
CREATE OR REPLACE FUNCTION public.erp_check_request()
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF current_setting('request.path', true) = '/rpc/erp_mfa_use_recovery_code' THEN
    RETURN;
  END IF;
  IF NOT public.erp_mfa_satisfied() THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  IF auth.uid() IS NOT NULL AND etna_platform._terms_pending(auth.uid()) THEN
    RAISE EXCEPTION 'The Terms & Conditions must be accepted first' USING ERRCODE = '42501', HINT = 'terms_required';
  END IF;
END;
$$;

-- ─── 4. For the sign-in server (etna_auth) ────────────────────────────────────

-- The current version to show (anyone may read it, also before signing in).
CREATE OR REPLACE FUNCTION etna_platform.terms_current()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
BEGIN
  RETURN (
    SELECT jsonb_build_object('id', v.id, 'label', v.label, 'content', v.content, 'published_at', v.published_at)
      FROM etna_platform.terms_versions v WHERE v.id = etna_platform._current_terms_id()
  );
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.terms_status(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  current_id UUID := etna_platform._current_terms_id();
BEGIN
  RETURN jsonb_build_object(
    'required', etna_platform._terms_pending(p_user_id),
    'version_id', current_id,
    'accepted_at', (SELECT a.accepted_at FROM etna_platform.terms_acceptances a
                     WHERE a.user_id = p_user_id AND a.version_id = current_id)
  );
END;
$$;

-- Records the acceptance of the current version. p_version_id must be the
-- current one (a version published while the page was open must be read
-- first). The workspace is kept only if the account is an active member.
CREATE OR REPLACE FUNCTION etna_platform.terms_accept(
  p_user_id UUID,
  p_version_id UUID,
  p_locale TEXT,
  p_workspace_id UUID,
  p_session_id UUID,
  p_ip TEXT,
  p_user_agent TEXT
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  address TEXT;
  label_text TEXT;
  workspace UUID;
  accepted TIMESTAMPTZ;
BEGIN
  IF p_version_id IS DISTINCT FROM etna_platform._current_terms_id() THEN
    RAISE EXCEPTION 'This is not the current version' USING ERRCODE = 'P0001', HINT = 'stale';
  END IF;
  SELECT u.email INTO address FROM auth.users u WHERE u.id = p_user_id;
  IF address IS NULL THEN
    RAISE EXCEPTION 'No such account' USING ERRCODE = 'P0002';
  END IF;
  SELECT m.workspace_id INTO workspace FROM public.erp_workspace_members m
   WHERE m.workspace_id = p_workspace_id AND m.user_id = p_user_id AND m.status = 'active';

  INSERT INTO etna_platform.terms_acceptances (version_id, user_id, email, locale, workspace_id, session_id, ip, user_agent)
  VALUES (p_version_id, p_user_id, address,
          CASE WHEN p_locale IN ('en', 'id', 'zh') THEN p_locale ELSE 'en' END,
          workspace, p_session_id, left(p_ip, 64), left(p_user_agent, 400))
  ON CONFLICT (user_id, version_id) DO NOTHING
  RETURNING accepted_at INTO accepted;

  IF accepted IS NULL THEN
    SELECT a.accepted_at INTO accepted FROM etna_platform.terms_acceptances a
     WHERE a.user_id = p_user_id AND a.version_id = p_version_id;
    RETURN accepted;
  END IF;

  SELECT v.label INTO label_text FROM etna_platform.terms_versions v WHERE v.id = p_version_id;
  PERFORM etna_platform._log('TERMS_ACCEPTED', 'success', 'user', p_user_id, address, workspace,
    jsonb_build_object('version_id', p_version_id, 'version', label_text,
                       'locale', CASE WHEN p_locale IN ('en', 'id', 'zh') THEN p_locale ELSE 'en' END),
    p_user_id, address, p_session_id, p_ip, p_user_agent);
  RETURN accepted;
END;
$$;

-- As in 20261012000012, plus declining the Terms & Conditions.
CREATE OR REPLACE FUNCTION etna_platform.log_auth_event(
  p_event_type TEXT,
  p_outcome TEXT,
  p_user_id UUID,
  p_email TEXT,
  p_session_id UUID,
  p_ip TEXT,
  p_user_agent TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
BEGIN
  IF p_event_type NOT IN (
    'LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'LOGIN_RATE_LIMITED', 'LOGOUT',
    'PASSWORD_CHANGED', 'PASSWORD_CHANGE_FAILED', 'PASSWORD_CHECK_FAILED',
    'PASSWORD_RESET_COMPLETED', 'PASSWORD_RESET_FAILED',
    'MFA_FACTOR_ADDED', 'MFA_FACTOR_REMOVED', 'MFA_CHALLENGE_SUCCEEDED', 'MFA_CHALLENGE_FAILED',
    'MFA_RATE_LIMITED', 'ADMIN_REAUTHENTICATED', 'ADMIN_REAUTH_FAILED', 'TERMS_DECLINED'
  ) THEN
    RAISE EXCEPTION 'Unknown sign-in event %', p_event_type USING ERRCODE = '22023';
  END IF;
  PERFORM etna_platform._log(p_event_type, p_outcome, 'user', p_user_id, p_email, NULL, p_metadata,
    p_user_id, p_email, p_session_id, p_ip, p_user_agent);
END;
$$;

-- ─── 5. Admin panel ───────────────────────────────────────────────────────────

-- Accounts that are people (not ERP containers): who should accept.
CREATE OR REPLACE FUNCTION etna_platform._people_count()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = auth, pg_temp
AS $$
  SELECT count(*) FROM auth.users u WHERE NOT etna_platform._is_container(u.raw_user_meta_data);
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_terms_list()
RETURNS TABLE (
  id UUID, label TEXT, status TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ, published_by_email TEXT, acceptances BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  current_id UUID := etna_platform._current_terms_id();
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  RETURN QUERY
  SELECT v.id, v.label,
         CASE WHEN v.published_at IS NULL THEN 'draft' WHEN v.id = current_id THEN 'current' ELSE 'previous' END,
         v.created_at, v.updated_at, v.published_at,
         (SELECT u.email FROM auth.users u WHERE u.id = v.published_by),
         (SELECT count(*) FROM etna_platform.terms_acceptances a WHERE a.version_id = v.id)
    FROM etna_platform.terms_versions v
   ORDER BY v.published_at DESC NULLS FIRST, v.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_terms_get(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  v etna_platform.terms_versions;
  accepted BIGINT;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  SELECT * INTO v FROM etna_platform.terms_versions x WHERE x.id = p_id;
  IF v.id IS NULL THEN
    RAISE EXCEPTION 'No such version' USING ERRCODE = 'P0002';
  END IF;
  SELECT count(*) INTO accepted FROM etna_platform.terms_acceptances a WHERE a.version_id = v.id;
  RETURN jsonb_build_object(
    'id', v.id, 'label', v.label, 'content', v.content,
    'status', CASE WHEN v.published_at IS NULL THEN 'draft'
                   WHEN v.id = etna_platform._current_terms_id() THEN 'current' ELSE 'previous' END,
    'created_at', v.created_at, 'updated_at', v.updated_at,
    'created_by_email', (SELECT u.email FROM auth.users u WHERE u.id = v.created_by),
    'published_at', v.published_at,
    'published_by_email', (SELECT u.email FROM auth.users u WHERE u.id = v.published_by),
    'acceptances', accepted,
    'people', etna_platform._people_count()
  );
END;
$$;

-- p_id NULL = a new draft. Only drafts can be saved.
CREATE OR REPLACE FUNCTION etna_platform.admin_terms_save(p_id UUID, p_label TEXT, p_content JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  clean JSONB := '{}'::jsonb;
  lang TEXT;
  saved UUID;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin'], true);
  IF jsonb_typeof(p_content) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid content' USING ERRCODE = '22023';
  END IF;
  FOREACH lang IN ARRAY ARRAY['en', 'id', 'zh'] LOOP
    IF jsonb_typeof(p_content -> lang) = 'string' AND char_length(trim(p_content ->> lang)) > 0 THEN
      IF char_length(p_content ->> lang) > 200000 THEN
        RAISE EXCEPTION 'The text is too long' USING ERRCODE = '22023';
      END IF;
      clean := clean || jsonb_build_object(lang, p_content ->> lang);
    END IF;
  END LOOP;
  IF NOT clean ? 'en' THEN
    RAISE EXCEPTION 'The English text is required' USING ERRCODE = '22023';
  END IF;
  IF char_length(trim(COALESCE(p_label, ''))) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Give a version name of at most 60 characters' USING ERRCODE = '22023';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO etna_platform.terms_versions (label, content, created_by)
    VALUES (trim(p_label), clean, auth.uid())
    RETURNING id INTO saved;
  ELSE
    UPDATE etna_platform.terms_versions SET label = trim(p_label), content = clean, updated_at = now()
     WHERE id = p_id
    RETURNING id INTO saved;
    IF saved IS NULL THEN
      RAISE EXCEPTION 'No such version' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  PERFORM etna_platform._log('TERMS_DRAFT_SAVED', 'success', 'admin', NULL, NULL, NULL,
    jsonb_build_object('version_id', saved, 'version', trim(p_label), 'languages', (SELECT jsonb_agg(k) FROM jsonb_object_keys(clean) k)));
  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_terms_delete(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  gone etna_platform.terms_versions;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin'], true);
  DELETE FROM etna_platform.terms_versions v WHERE v.id = p_id RETURNING v.* INTO gone;
  IF gone.id IS NULL THEN
    RAISE EXCEPTION 'No such version' USING ERRCODE = 'P0002';
  END IF;
  PERFORM etna_platform._log('TERMS_DRAFT_DELETED', 'success', 'admin', NULL, NULL, NULL,
    jsonb_build_object('version_id', gone.id, 'version', gone.label));
END;
$$;

-- Makes a draft the current version: every account must accept it next time
-- it uses ETNA.
CREATE OR REPLACE FUNCTION etna_platform.admin_terms_publish(p_id UUID)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  v etna_platform.terms_versions;
  previous UUID := etna_platform._current_terms_id();
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin'], true);
  SELECT * INTO v FROM etna_platform.terms_versions x WHERE x.id = p_id FOR UPDATE;
  IF v.id IS NULL THEN
    RAISE EXCEPTION 'No such version' USING ERRCODE = 'P0002';
  END IF;
  IF v.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'This version is already published' USING ERRCODE = 'P0001', HINT = 'already';
  END IF;
  IF v.content::text ILIKE '%[PLACEHOLDER%' THEN
    RAISE EXCEPTION 'Replace the placeholder text before publishing' USING ERRCODE = 'P0001', HINT = 'placeholder';
  END IF;
  UPDATE etna_platform.terms_versions SET published_at = clock_timestamp(), published_by = auth.uid()
   WHERE id = p_id
  RETURNING * INTO v;
  PERFORM etna_platform._log('TERMS_PUBLISHED', 'success', 'admin', NULL, NULL, NULL,
    jsonb_build_object('version_id', v.id, 'version', v.label, 'previous_version_id', previous,
                       'people', etna_platform._people_count()));
  RETURN v.published_at;
END;
$$;

-- Accounts that have not accepted the current version (people, newest first).
CREATE OR REPLACE FUNCTION etna_platform.admin_terms_pending(p_limit INTEGER DEFAULT 50, p_offset INTEGER DEFAULT 0)
RETURNS TABLE (user_id UUID, email TEXT, full_name TEXT, disabled BOOLEAN, last_sign_in_at TIMESTAMPTZ, last_accepted TEXT, total BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  current_id UUID := etna_platform._current_terms_id();
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  IF current_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT u.id, u.email, COALESCE(u.raw_user_meta_data ->> 'full_name', ''),
         COALESCE(u.banned_until > now(), false), u.last_sign_in_at,
         (SELECT v.label FROM etna_platform.terms_acceptances a JOIN etna_platform.terms_versions v ON v.id = a.version_id
           WHERE a.user_id = u.id ORDER BY a.accepted_at DESC LIMIT 1),
         count(*) OVER ()
    FROM auth.users u
   WHERE NOT etna_platform._is_container(u.raw_user_meta_data)
     AND NOT EXISTS (SELECT 1 FROM etna_platform.terms_acceptances a WHERE a.user_id = u.id AND a.version_id = current_id)
   ORDER BY u.last_sign_in_at DESC NULLS LAST, u.email
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

-- Which versions an account accepted, when, and how.
CREATE OR REPLACE FUNCTION etna_platform.admin_user_terms(p_user_id UUID)
RETURNS TABLE (
  version_id UUID, label TEXT, accepted_at TIMESTAMPTZ, locale TEXT, method TEXT,
  workspace_id UUID, workspace_name TEXT, ip TEXT, user_agent TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  RETURN QUERY
  SELECT a.version_id, v.label, a.accepted_at, a.locale, a.method, a.workspace_id, w.name, a.ip, a.user_agent
    FROM etna_platform.terms_acceptances a
    JOIN etna_platform.terms_versions v ON v.id = a.version_id
    LEFT JOIN public.erp_workspaces w ON w.id = a.workspace_id
   WHERE a.user_id = p_user_id
   ORDER BY a.accepted_at DESC;
END;
$$;

-- ─── 6. Grants ────────────────────────────────────────────────────────────────

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA etna_platform FROM PUBLIC;

GRANT EXECUTE ON FUNCTION etna_platform.admin_terms_list() TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_terms_get(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_terms_save(UUID, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_terms_delete(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_terms_publish(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_terms_pending(INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_user_terms(UUID) TO authenticated;
-- Re-granted after the REVOKE above (unchanged since 20261012000012).
GRANT EXECUTE ON FUNCTION etna_platform.my_admin_role() TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_list_admins() TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_set_role(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_revoke_role(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_security_events(BIGINT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_list_users(TEXT, TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_user_detail(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_list_workspaces(TEXT, TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_workspace_detail(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_disable_user(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_enable_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_end_sessions(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_create_reset_link(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_reset_mfa(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_create_user(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_suspend_workspace(UUID, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_reactivate_workspace(UUID, BOOLEAN) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') THEN
    GRANT EXECUTE ON FUNCTION etna_platform.log_auth_event(TEXT, TEXT, UUID, TEXT, UUID, TEXT, TEXT, JSONB) TO etna_auth;
    GRANT EXECUTE ON FUNCTION etna_platform.password_link_check(TEXT) TO etna_auth;
    GRANT EXECUTE ON FUNCTION etna_platform.password_link_use(TEXT) TO etna_auth;
    GRANT EXECUTE ON FUNCTION etna_platform.password_links_revoke(UUID) TO etna_auth;
    GRANT EXECUTE ON FUNCTION etna_platform.terms_current() TO etna_auth;
    GRANT EXECUTE ON FUNCTION etna_platform.terms_status(UUID) TO etna_auth;
    GRANT EXECUTE ON FUNCTION etna_platform.terms_accept(UUID, UUID, TEXT, UUID, UUID, TEXT, TEXT) TO etna_auth;
  END IF;
END;
$$;
