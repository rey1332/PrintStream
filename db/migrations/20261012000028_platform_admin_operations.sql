-- Admin panel: new client companies, ERP usage and modules, ERP limits per
-- account, announcements, and logged operations (backups, e-mail, exports).
--
--   admin_create_company       a new ERP for a client (name, industry
--                              template) with its Owner: an existing account
--                              or a new one with an invitation link
--   admin_workspace_usage      what an ERP holds (records, documents, last
--                              activity), its industry and modules
--   admin_set_workspace_modules change an ERP's industry and modules
--   admin_account_limit /      how many ERPs an account may belong to: the
--   admin_set_account_limit    default (3) or a number set for that account
--   admin_announcements /      banners shown in the ERP to everyone or to one
--   admin_save_announcement /  ERP, from a start to an optional end time
--   admin_cancel_announcement
--   admin_authorize            checks the role (and a fresh two-factor code)
--                              for operations done by the server itself —
--                              running a backup, sending a test e-mail,
--                              exporting — and writes them to the security log
--
-- Creating companies, modules and limits: super admin with a fresh
-- two-factor code; announcements: super admin or support. Everything is in
-- the security log. erp_my_announcements() gives a signed-in member the
-- banners that apply to them.
--
-- Rollback: db/rollback/rollback_20261012000028_platform_admin_operations.sql

-- ─── 1. ERP limit per account ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS etna_platform.account_limits (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  erp_limit INTEGER NOT NULL CHECK (erp_limit BETWEEN 1 AND 100),
  reason TEXT NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  set_by UUID,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON etna_platform.account_limits FROM PUBLIC, anon, authenticated;

-- The number of ERPs an account may belong to.
CREATE OR REPLACE FUNCTION public.erp__workspace_limit_for(p_user_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
  SELECT COALESCE((SELECT l.erp_limit FROM etna_platform.account_limits l WHERE l.user_id = p_user_id),
                  public.erp_workspace_limit());
$$;
REVOKE ALL ON FUNCTION public.erp__workspace_limit_for(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION pg_temp.erp_patch(p_fn REGPROCEDURE, p_pairs TEXT[])
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  body TEXT := pg_get_functiondef(p_fn);
  i INTEGER;
BEGIN
  FOR i IN 1 .. COALESCE(array_length(p_pairs, 1), 0) BY 2 LOOP
    IF position(p_pairs[i] IN body) = 0 THEN
      RAISE EXCEPTION 'erp_patch: % does not contain %', p_fn, p_pairs[i];
    END IF;
    body := replace(body, p_pairs[i], p_pairs[i + 1]);
  END LOOP;
  RETURN body;
END;
$$;
-- Every check of the limit uses the account's own limit.
DO $$
BEGIN
  EXECUTE pg_temp.erp_patch('public.erp_enforce_workspace_limit()'::regprocedure,
    ARRAY['public.erp_workspace_limit()', 'public.erp__workspace_limit_for(NEW.user_id)']);
  EXECUTE pg_temp.erp_patch('public.erp_my_workspace_quota()'::regprocedure,
    ARRAY['public.erp_workspace_limit()', 'public.erp__workspace_limit_for(auth.uid())']);
  EXECUTE pg_temp.erp_patch('public.erp_create_erp(text)'::regprocedure,
    ARRAY['public.erp_workspace_limit()', 'public.erp__workspace_limit_for(actor)']);
  EXECUTE pg_temp.erp_patch('public.erp_redeem_workspace_invitation(text)'::regprocedure,
    ARRAY['public.erp_workspace_limit()', 'public.erp__workspace_limit_for(actor)']);
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_account_limit(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  l etna_platform.account_limits;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'No such account' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO l FROM etna_platform.account_limits x WHERE x.user_id = p_user_id;
  RETURN jsonb_build_object(
    'limit', public.erp__workspace_limit_for(p_user_id), 'default', public.erp_workspace_limit(),
    'custom', l.user_id IS NOT NULL, 'reason', l.reason, 'set_at', l.set_at,
    'used', public.erp__active_workspace_count(p_user_id),
    'unlimited', etna_platform._role_of(p_user_id) IS NOT NULL);
END;
$$;

-- p_limit NULL = back to the default.
CREATE OR REPLACE FUNCTION etna_platform.admin_set_account_limit(p_user_id UUID, p_limit INTEGER, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  why TEXT := left(trim(COALESCE(p_reason, '')), 500);
  address TEXT;
  before_limit INTEGER := public.erp__workspace_limit_for(p_user_id);
BEGIN
  SELECT u.email INTO address FROM auth.users u WHERE u.id = p_user_id;
  IF address IS NULL THEN RAISE EXCEPTION 'No such account' USING ERRCODE = 'P0002'; END IF;
  PERFORM etna_platform._target(p_user_id, caller_role, false);
  IF char_length(why) < 3 THEN RAISE EXCEPTION 'Give a reason' USING ERRCODE = '22023'; END IF;
  IF p_limit IS NOT NULL AND p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'The limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL THEN
    DELETE FROM etna_platform.account_limits WHERE user_id = p_user_id;
  ELSE
    INSERT INTO etna_platform.account_limits (user_id, erp_limit, reason, set_by, set_at)
    VALUES (p_user_id, p_limit, why, auth.uid(), now())
    ON CONFLICT (user_id) DO UPDATE SET erp_limit = EXCLUDED.erp_limit, reason = EXCLUDED.reason,
                                        set_by = EXCLUDED.set_by, set_at = now();
  END IF;
  PERFORM etna_platform._log('ACCOUNT_ERP_LIMIT_CHANGED', 'success', 'admin', p_user_id, address, NULL,
    jsonb_build_object('from', before_limit, 'to', public.erp__workspace_limit_for(p_user_id), 'reason', why));
END;
$$;

-- ─── 2. New client company ───────────────────────────────────────────────────
-- A new ERP (as erp_create_erp: its own internal owner account, so it has
-- its own books) whose Owner is the given person. A new person gets an
-- account without a password and an invitation link (p_token_hash).
CREATE OR REPLACE FUNCTION etna_platform.admin_create_company(
  p_name TEXT, p_industry TEXT, p_owner_email TEXT, p_owner_name TEXT, p_token_hash TEXT, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  v_name TEXT := btrim(COALESCE(p_name, ''));
  address TEXT := trim(COALESCE(p_owner_email, ''));
  why TEXT := left(trim(COALESCE(p_reason, '')), 500);
  v_owner UUID;
  new_user BOOLEAN := false;
  link JSONB;
  container UUID := gen_random_uuid();
  ws UUID;
BEGIN
  IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Give the company a name (at most 120 characters)' USING ERRCODE = '22023';
  END IF;
  IF p_industry IS NULL OR p_industry NOT IN ('general', 'quarry', 'trading', 'manufacturing') THEN
    RAISE EXCEPTION 'Unknown industry' USING ERRCODE = '22023';
  END IF;
  IF address !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' OR char_length(address) > 254 THEN
    RAISE EXCEPTION 'Give a valid e-mail address' USING ERRCODE = '22023';
  END IF;
  IF char_length(why) < 3 THEN RAISE EXCEPTION 'Give a reason' USING ERRCODE = '22023'; END IF;

  SELECT u.id INTO v_owner FROM auth.users u WHERE lower(u.email) = lower(address);
  IF v_owner IS NULL THEN
    IF p_token_hash IS NULL OR char_length(p_token_hash) < 32 THEN
      RAISE EXCEPTION 'An invitation link is needed for a new account' USING ERRCODE = '22023';
    END IF;
    INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
    VALUES (address, NULL,
            jsonb_build_object('full_name', COALESCE(NULLIF(left(trim(p_owner_name), 120), ''), split_part(address, '@', 1))),
            now())
    RETURNING id INTO v_owner;
    new_user := true;
    link := etna_platform._create_password_link(v_owner, p_token_hash, 'invite');
    PERFORM etna_platform._log('USER_CREATED', 'success', 'admin', v_owner, address, NULL,
      jsonb_build_object('invite_link_id', link ->> 'link_id', 'expires_at', link ->> 'expires_at', 'via', 'company'));
  ELSE
    -- A person, and not the caller (nobody makes themselves Owner of client data).
    PERFORM etna_platform._target(v_owner, caller_role, false);
    PERFORM pg_advisory_xact_lock(hashtext('erp_invite_redeem'), hashtext(v_owner::TEXT));
    IF etna_platform._role_of(v_owner) IS NULL
       AND public.erp__active_workspace_count(v_owner) >= public.erp__workspace_limit_for(v_owner) THEN
      RAISE EXCEPTION 'This account already belongs to the maximum of % ERPs.', public.erp__workspace_limit_for(v_owner)
        USING ERRCODE = 'P0001', HINT = 'workspace_limit';
    END IF;
  END IF;

  -- The internal owner: no password, blocked forever (as in erp_create_erp).
  INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, banned_until)
  VALUES (container, 'erp-' || container || '@container.etna.invalid', NULL,
          jsonb_build_object('full_name', v_name, 'etna_kind', 'erp_container', 'created_by', v_owner), 'infinity');
  INSERT INTO public.user_profiles (id, email, full_name)
  VALUES (container, 'erp-' || container || '@container.etna.invalid', v_name)
  ON CONFLICT (id) DO NOTHING;
  ws := public.erp_personal_workspace_id(container);
  UPDATE public.erp_workspaces
     SET name = v_name, created_by = v_owner, industry = p_industry,
         modules = public.erp__industry_modules(p_industry), updated_at = now()
   WHERE id = ws;
  DELETE FROM public.erp_workspace_members WHERE workspace_id = ws AND user_id = container;
  INSERT INTO public.erp_workspace_members (workspace_id, user_id, role, invited_by)
  VALUES (ws, v_owner, 'owner', auth.uid());
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
  VALUES (ws, auth.uid(), 'workspace.created', v_owner,
          jsonb_build_object('source', 'etna_admin', 'name', v_name, 'industry', p_industry, 'reason', why));
  PERFORM etna_platform._log('COMPANY_CREATED', 'success', 'admin', v_owner, address, ws,
    jsonb_build_object('name', v_name, 'industry', p_industry, 'new_owner_account', new_user, 'reason', why));
  RETURN jsonb_build_object('workspace_id', ws, 'user_id', v_owner, 'new_user', new_user)
         || COALESCE(link, '{}'::jsonb);
END;
$$;

-- ─── 3. ERP usage and modules ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION etna_platform.admin_workspace_usage(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  w public.erp_workspaces;
  counts JSONB := '{}'::jsonb;
  t RECORD;
  n BIGINT;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  SELECT * INTO w FROM public.erp_workspaces x WHERE x.id = p_workspace_id;
  IF w.id IS NULL THEN RAISE EXCEPTION 'No such workspace' USING ERRCODE = 'P0002'; END IF;
  FOR t IN SELECT * FROM (VALUES
      ('customers', 'erp_customers'), ('suppliers', 'erp_suppliers'), ('products', 'erp_products'),
      ('sales_orders', 'erp_sales_orders'), ('purchase_orders', 'erp_purchase_orders'), ('invoices', 'erp_invoices'),
      ('payments', 'erp_payments'), ('journal_entries', 'erp_journal_entries'), ('employees', 'erp_employees'),
      ('weigh_tickets', 'erp_weigh_tickets'), ('production_runs', 'erp_production_runs'),
      ('equipment', 'erp_equipment')) AS v(k, tbl)
  LOOP
    IF to_regclass('public.' || t.tbl) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE workspace_id = $1', t.tbl) INTO n USING w.id;
      counts := counts || jsonb_build_object(t.k, n);
    END IF;
  END LOOP;
  RETURN jsonb_build_object(
    'industry', w.industry, 'modules', to_jsonb(w.modules), 'counts', counts,
    'documents', (SELECT count(*) FROM public.erp_documents d WHERE d.workspace_id = w.id),
    'document_bytes', (SELECT COALESCE(sum(d.size_bytes), 0) FROM public.erp_documents d WHERE d.workspace_id = w.id),
    'members', (SELECT count(*) FROM public.erp_workspace_members m WHERE m.workspace_id = w.id AND m.status = 'active'),
    'last_activity', GREATEST(
      (SELECT max(a.created_at) FROM public.erp_audit_log a WHERE a.workspace_id = w.id),
      (SELECT max(a.created_at) FROM public.erp_workspace_audit_log a WHERE a.workspace_id = w.id)));
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_set_workspace_modules(p_workspace_id UUID, p_industry TEXT, p_modules TEXT[],
                                                                    p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  why TEXT := left(trim(COALESCE(p_reason, '')), 500);
  w public.erp_workspaces;
  v_modules TEXT[];
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin'], true);
  SELECT * INTO w FROM public.erp_workspaces x WHERE x.id = p_workspace_id FOR UPDATE;
  IF w.id IS NULL THEN RAISE EXCEPTION 'No such workspace' USING ERRCODE = 'P0002'; END IF;
  IF p_industry IS NULL OR p_industry NOT IN ('general', 'quarry', 'trading', 'manufacturing') THEN
    RAISE EXCEPTION 'Unknown industry' USING ERRCODE = '22023';
  END IF;
  v_modules := COALESCE(p_modules, public.erp__industry_modules(p_industry));
  IF NOT v_modules <@ ARRAY['weighbridge', 'production', 'equipment']::TEXT[] THEN
    RAISE EXCEPTION 'Unknown module' USING ERRCODE = '22023';
  END IF;
  IF char_length(why) < 3 THEN RAISE EXCEPTION 'Give a reason' USING ERRCODE = '22023'; END IF;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_modules FROM unnest(v_modules) x;
  IF w.industry IS NOT DISTINCT FROM p_industry AND w.modules IS NOT DISTINCT FROM v_modules THEN RETURN; END IF;
  UPDATE public.erp_workspaces SET industry = p_industry, modules = v_modules, updated_at = now() WHERE id = w.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (w.id, auth.uid(), 'workspace.modules', jsonb_build_object(
    'industry', p_industry, 'modules', to_jsonb(v_modules), 'previous_industry', w.industry,
    'previous_modules', to_jsonb(w.modules), 'via', 'etna_admin', 'reason', why));
  PERFORM etna_platform._log('WORKSPACE_MODULES_CHANGED', 'success', 'admin', NULL, NULL, w.id,
    jsonb_build_object('industry', p_industry, 'modules', to_jsonb(v_modules), 'reason', why));
END;
$$;

-- ─── 4. Announcements ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS etna_platform.announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message TEXT NOT NULL CHECK (char_length(btrim(message)) BETWEEN 1 AND 500),
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warning', 'maintenance')),
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ,
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON etna_platform.announcements (starts_at) WHERE cancelled_at IS NULL;
REVOKE ALL ON etna_platform.announcements FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION etna_platform.admin_announcements()
RETURNS TABLE (id UUID, message TEXT, level TEXT, workspace_id UUID, workspace_name TEXT, starts_at TIMESTAMPTZ,
               ends_at TIMESTAMPTZ, created_at TIMESTAMPTZ, created_by_email TEXT, cancelled_at TIMESTAMPTZ, state TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], false);
  RETURN QUERY
  SELECT a.id, a.message, a.level, a.workspace_id, w.name, a.starts_at, a.ends_at, a.created_at, u.email, a.cancelled_at,
         CASE WHEN a.cancelled_at IS NOT NULL THEN 'cancelled'
              WHEN a.ends_at IS NOT NULL AND a.ends_at <= now() THEN 'ended'
              WHEN a.starts_at > now() THEN 'scheduled' ELSE 'active' END
    FROM etna_platform.announcements a
    LEFT JOIN public.erp_workspaces w ON w.id = a.workspace_id
    LEFT JOIN auth.users u ON u.id = a.created_by
   ORDER BY a.created_at DESC
   LIMIT 200;
END;
$$;

-- p: {message, level?, workspace_id?, starts_at?, ends_at?}
CREATE OR REPLACE FUNCTION etna_platform.admin_save_announcement(p JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
DECLARE
  new_id UUID;
  v_ws UUID;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support'], true);
  BEGIN
    v_ws := NULLIF(p ->> 'workspace_id', '')::UUID;
    v_start := COALESCE(NULLIF(p ->> 'starts_at', '')::TIMESTAMPTZ, now());
    v_end := NULLIF(p ->> 'ends_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid announcement' USING ERRCODE = '22023';
  END;
  IF v_ws IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.erp_workspaces w WHERE w.id = v_ws) THEN
    RAISE EXCEPTION 'No such workspace' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO etna_platform.announcements (message, level, workspace_id, starts_at, ends_at, created_by)
  VALUES (btrim(COALESCE(p ->> 'message', '')), COALESCE(NULLIF(p ->> 'level', ''), 'info'), v_ws, v_start, v_end, auth.uid())
  RETURNING id INTO new_id;
  PERFORM etna_platform._log('ANNOUNCEMENT_CREATED', 'success', 'admin', NULL, NULL, v_ws,
    jsonb_build_object('announcement_id', new_id, 'level', p ->> 'level', 'starts_at', v_start, 'ends_at', v_end));
  RETURN new_id;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'Invalid announcement' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_cancel_announcement(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, public, pg_temp
AS $$
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support'], true);
  UPDATE etna_platform.announcements SET cancelled_at = now(), cancelled_by = auth.uid()
   WHERE id = p_id AND cancelled_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such announcement' USING ERRCODE = 'P0002'; END IF;
  PERFORM etna_platform._log('ANNOUNCEMENT_CANCELLED', 'success', 'admin', NULL, NULL, NULL,
    jsonb_build_object('announcement_id', p_id));
END;
$$;

-- The banners for the signed-in person: for everyone, or for an ERP they belong to.
CREATE OR REPLACE FUNCTION public.erp_my_announcements()
RETURNS TABLE (id UUID, message TEXT, level TEXT, workspace_id UUID, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT a.id, a.message, a.level, a.workspace_id, a.starts_at, a.ends_at
    FROM etna_platform.announcements a
   WHERE a.cancelled_at IS NULL AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
     AND (a.workspace_id IS NULL OR EXISTS (
           SELECT 1 FROM public.erp_workspace_members m
            WHERE m.workspace_id = a.workspace_id AND m.user_id = auth.uid() AND m.status = 'active'))
   ORDER BY CASE a.level WHEN 'maintenance' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.starts_at DESC
   LIMIT 5;
END;
$$;

-- ─── 5. Operations done by the server ───────────────────────────────────────
CREATE OR REPLACE FUNCTION etna_platform.admin_authorize(p_event TEXT, p_metadata JSONB)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, auth, pg_temp
AS $$
DECLARE
  caller_role TEXT;
BEGIN
  IF p_event = 'BACKUP_STARTED' THEN
    caller_role := etna_platform._require_admin(ARRAY['super_admin'], true);
  ELSIF p_event IN ('EMAIL_TEST_SENT', 'ADMIN_EXPORT') THEN
    caller_role := etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor'], true);
  ELSIF p_event = 'INVITE_EMAILED' THEN
    caller_role := etna_platform._require_admin(ARRAY['super_admin', 'support'], false);
  ELSE
    RAISE EXCEPTION 'Unknown operation' USING ERRCODE = '22023';
  END IF;
  PERFORM etna_platform._log(p_event, 'success', 'admin', NULLIF(p_metadata ->> 'user_id', '')::UUID,
    NULLIF(p_metadata ->> 'email', ''), NULL, COALESCE(p_metadata, '{}'::jsonb) - 'user_id' - 'email');
  RETURN caller_role;
END;
$$;

-- ─── 6. Privileges ───────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION etna_platform.admin_account_limit(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_set_account_limit(UUID, INTEGER, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_create_company(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_workspace_usage(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_set_workspace_modules(UUID, TEXT, TEXT[], TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_announcements() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_save_announcement(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_cancel_announcement(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION etna_platform.admin_authorize(TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_my_announcements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION etna_platform.admin_account_limit(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_set_account_limit(UUID, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_create_company(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_workspace_usage(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_set_workspace_modules(UUID, TEXT, TEXT[], TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_announcements() TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_save_announcement(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_cancel_announcement(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION etna_platform.admin_authorize(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_my_announcements() TO authenticated;
