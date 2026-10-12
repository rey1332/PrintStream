-- ─── ERP workspaces, membership, and access-code invitations ─────────────────
-- Phase 1 of the workspace rollout (additive, backward compatible):
--   1. Create workspace / membership / invitation / audit structures.
--   2. Give every existing user a personal workspace with an `owner` membership
--      and associate their existing ERP rows with it (workspace_id backfill).
--      Nothing is shared with anybody by default.
--   3. Keep every existing `user_id = auth.uid()` policy. New member policies
--      are *additional* permissive policies, so existing clients and sessions
--      keep exactly the access they had.
--   4. Expose workspace-aware helper functions that the next migrations and
--      the new app version use. Old app versions never call them.
--
-- Invariant for this phase: a workspace is owned by one user and every ERP row
-- in it has `user_id = workspace owner` and `workspace_id = owner's personal
-- workspace`. Members write through RLS member policies or SECURITY DEFINER
-- RPCs that stamp the owner's user_id and record the acting user separately.

-- ─── 1. Maintenance switch for backfills ─────────────────────────────────────
-- Flag set only by migrations while they backfill new
-- columns, so the backfill does not rewrite updated_at timestamps or flood the
-- audit log with synthetic UPDATE rows. Clients cannot set custom GUCs through
-- PostgREST, and nothing user-callable sets it.

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('erp.maintenance', true) = 'on' THEN
    RETURN NEW;
  END IF;
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

-- ─── 2. Tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.erp_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'My workspace' CHECK (char_length(name) BETWEEN 1 AND 120),
  is_personal BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_workspaces_personal_owner
  ON public.erp_workspaces(owner_id) WHERE is_personal;

CREATE TABLE IF NOT EXISTS public.erp_workspace_members (
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'finance', 'sales', 'inventory', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  invited_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  invitation_id UUID,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  removed_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  removal_reason TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_erp_workspace_members_user_active
  ON public.erp_workspace_members(user_id) WHERE status = 'active';

-- Access codes are never stored. Only a SHA-256 hash of the normalized code is
-- kept; the plaintext is returned once to the inviter when it is created.
CREATE TABLE IF NOT EXISTS public.erp_workspace_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'finance', 'sales', 'inventory', 'viewer')),
  label TEXT NOT NULL DEFAULT '',
  created_by UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  redeemed_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT NOT NULL DEFAULT '',
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_erp_workspace_invitations_workspace
  ON public.erp_workspace_invitations(workspace_id, created_at DESC);

-- Redemption attempts per user, used for database-enforced rate limiting that
-- holds across every app server instance.
CREATE TABLE IF NOT EXISTS public.erp_invitation_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  succeeded BOOLEAN NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_erp_invitation_attempts_user_time
  ON public.erp_invitation_attempts(user_id, attempted_at DESC);

-- Append-only trail for invitations and membership changes. Never holds codes.
CREATE TABLE IF NOT EXISTS public.erp_workspace_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_user_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  invitation_id UUID REFERENCES public.erp_workspace_invitations(id) ON DELETE SET NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_erp_workspace_audit_log_workspace
  ON public.erp_workspace_audit_log(workspace_id, created_at DESC);

ALTER TABLE public.erp_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_invitation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_workspace_audit_log ENABLE ROW LEVEL SECURITY;

-- Supabase grants new public tables to API roles by default. Workspace data is
-- read through narrow policies/RPCs and written only by SECURITY DEFINER RPCs.
REVOKE ALL ON public.erp_workspaces, public.erp_workspace_members,
  public.erp_workspace_invitations, public.erp_invitation_attempts,
  public.erp_workspace_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_workspaces, public.erp_workspace_members TO authenticated;

-- ─── 3. Role model ────────────────────────────────────────────────────────────
-- Keep in sync with src/app/erp/lib/erpRules.ts (a test checks parity).

CREATE OR REPLACE FUNCTION public.erp_role_permissions(p_role TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_role
    WHEN 'owner' THEN ARRAY['read','customers','suppliers','products','inventory','sales','invoicing','fulfillment','purchasing','receiving','payments','members','audit']
    WHEN 'admin' THEN ARRAY['read','customers','suppliers','products','inventory','sales','invoicing','fulfillment','purchasing','receiving','payments','members','audit']
    WHEN 'finance' THEN ARRAY['read','invoicing','payments']
    WHEN 'sales' THEN ARRAY['read','customers','sales','invoicing']
    WHEN 'inventory' THEN ARRAY['read','suppliers','products','inventory','fulfillment','purchasing','receiving']
    WHEN 'viewer' THEN ARRAY['read']
    ELSE ARRAY[]::TEXT[]
  END;
$$;

CREATE OR REPLACE FUNCTION public.erp_grantable_roles(p_role TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_role
    WHEN 'owner' THEN ARRAY['admin','finance','sales','inventory','viewer']
    WHEN 'admin' THEN ARRAY['finance','sales','inventory','viewer']
    ELSE ARRAY[]::TEXT[]
  END;
$$;

CREATE OR REPLACE FUNCTION public.erp_workspace_role(p_workspace_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.role
  FROM public.erp_workspace_members m
  WHERE m.workspace_id = p_workspace_id
    AND m.user_id = auth.uid()
    AND m.status = 'active';
$$;

CREATE OR REPLACE FUNCTION public.erp_has_permission(p_workspace_id UUID, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(p_permission = ANY(public.erp_role_permissions(public.erp_workspace_role(p_workspace_id))), false);
$$;

-- Only members learn who owns a workspace.
CREATE OR REPLACE FUNCTION public.erp_workspace_owner_id(p_workspace_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.owner_id
  FROM public.erp_workspaces w
  WHERE w.id = p_workspace_id
    AND public.erp_workspace_role(w.id) IS NOT NULL;
$$;

-- Row-level authorization used by the ERP RPCs. Legacy rows without a
-- workspace remain writable by their owner exactly as before.
CREATE OR REPLACE FUNCTION public.erp_can_write_record(p_user_id UUID, p_workspace_id UUID, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    (p_workspace_id IS NOT NULL AND public.erp_has_permission(p_workspace_id, p_permission))
    OR (p_workspace_id IS NULL AND p_user_id = auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.erp_role_permissions(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_grantable_roles(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_workspace_role(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_has_permission(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_workspace_owner_id(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_can_write_record(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_role_permissions(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_grantable_roles(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_workspace_role(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_has_permission(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_workspace_owner_id(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_can_write_record(UUID, UUID, TEXT) TO authenticated;

-- ─── 4. Personal workspaces ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp__default_workspace_name(p_full_name TEXT, p_email TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT left(COALESCE(NULLIF(trim(p_full_name), ''), NULLIF(split_part(COALESCE(p_email, ''), '@', 1), ''), 'My') || ' workspace', 120);
$$;

-- Returns (creating on first use) the personal workspace of a user. Internal:
-- callable only from SECURITY DEFINER code, never directly by API roles.
CREATE OR REPLACE FUNCTION public.erp_personal_workspace_id(p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  workspace UUID;
  profile RECORD;
BEGIN
  IF p_user_id IS NULL THEN RETURN NULL; END IF;

  SELECT id INTO workspace FROM public.erp_workspaces WHERE owner_id = p_user_id AND is_personal;
  IF workspace IS NOT NULL THEN RETURN workspace; END IF;

  SELECT full_name, email INTO profile FROM public.user_profiles WHERE id = p_user_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO public.erp_workspaces (owner_id, name, is_personal)
  VALUES (p_user_id, public.erp__default_workspace_name(profile.full_name, profile.email), true)
  ON CONFLICT (owner_id) WHERE is_personal DO NOTHING
  RETURNING id INTO workspace;

  IF workspace IS NULL THEN
    SELECT id INTO workspace FROM public.erp_workspaces WHERE owner_id = p_user_id AND is_personal;
  ELSE
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
    VALUES (workspace, p_user_id, 'workspace.created', p_user_id, jsonb_build_object('source', 'automatic'));
  END IF;

  INSERT INTO public.erp_workspace_members (workspace_id, user_id, role)
  VALUES (workspace, p_user_id, 'owner')
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  RETURN workspace;
END;
$$;

REVOKE ALL ON FUNCTION public.erp__default_workspace_name(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_personal_workspace_id(UUID) FROM PUBLIC, anon, authenticated;

-- New sign-ups get their workspace immediately. Failures never block sign-up:
-- the workspace is also created lazily on first ERP write or workspace lookup.
CREATE OR REPLACE FUNCTION public.erp_on_profile_created()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.erp_personal_workspace_id(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Personal workspace creation deferred for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_on_profile_created() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_erp_profile_workspace ON public.user_profiles;
CREATE TRIGGER trg_erp_profile_workspace
  AFTER INSERT ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.erp_on_profile_created();

-- Keeps workspace_id consistent with the row owner. Old clients never send
-- workspace_id, so it is filled in; a mismatching value is rejected, which
-- prevents anyone from planting rows in a workspace they do not own.
CREATE OR REPLACE FUNCTION public.erp_assign_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE owner_workspace UUID;
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
     AND NEW.workspace_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  owner_workspace := public.erp_personal_workspace_id(NEW.user_id);
  IF NEW.workspace_id IS NULL THEN
    NEW.workspace_id := owner_workspace;
  ELSIF NEW.workspace_id IS DISTINCT FROM owner_workspace THEN
    RAISE EXCEPTION 'Record workspace does not match its owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_assign_workspace() FROM PUBLIC, anon, authenticated;

-- ─── 5. workspace_id / created_by on ERP tables (nullable, additive) ──────────

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'erp_customers', 'erp_suppliers', 'erp_products', 'erp_purchase_orders',
    'erp_sales_orders', 'erp_invoices', 'erp_payments', 'erp_transactions',
    'erp_stock_movements'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL',
      target);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(workspace_id)', 'idx_' || target || '_workspace_id', target);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_erp_assign_workspace ON public.%I', target);
    EXECUTE format(
      'CREATE TRIGGER trg_erp_assign_workspace BEFORE INSERT OR UPDATE OF user_id, workspace_id ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.erp_assign_workspace()', target);
  END LOOP;
END;
$$;

-- Who performed a write, independent of the owning user_id.
ALTER TABLE public.erp_purchase_orders ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT auth.uid();
ALTER TABLE public.erp_sales_orders ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT auth.uid();
ALTER TABLE public.erp_invoices ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT auth.uid();
ALTER TABLE public.erp_payments ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT auth.uid();
ALTER TABLE public.erp_stock_movements ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT auth.uid();

ALTER TABLE public.erp_audit_log
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_id UUID;
CREATE INDEX IF NOT EXISTS idx_erp_audit_log_workspace_id ON public.erp_audit_log(workspace_id, created_at DESC);

-- ─── 6. Audit attribution ─────────────────────────────────────────────────────
-- Same rows as before, plus the workspace and the acting user. changed_by now
-- names the signed-in user who made the change (previously the row owner).

CREATE OR REPLACE FUNCTION public.erp_audit_trigger_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_user_id   UUID;
  v_record_id UUID;
  v_before    JSONB;
  v_after     JSONB;
  v_row       JSONB;
  v_actor     UUID := auth.uid();
  v_email     TEXT;
BEGIN
  IF current_setting('erp.maintenance', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id; v_record_id := OLD.id;
    v_before := to_jsonb(OLD); v_after := NULL; v_row := v_before;
  ELSIF TG_OP = 'INSERT' THEN
    v_user_id := NEW.user_id; v_record_id := NEW.id;
    v_before := NULL; v_after := to_jsonb(NEW); v_row := v_after;
  ELSE
    v_user_id := NEW.user_id; v_record_id := NEW.id;
    v_before := to_jsonb(OLD); v_after := to_jsonb(NEW); v_row := v_after;
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = COALESCE(v_actor, v_user_id) LIMIT 1;
  IF v_email IS NULL THEN
    v_email := COALESCE(v_actor::TEXT, v_user_id::TEXT, 'system');
  END IF;

  INSERT INTO public.erp_audit_log
    (user_id, workspace_id, actor_id, table_name, record_id, action, changed_by, before_data, after_data)
  VALUES
    (v_user_id, NULLIF(v_row->>'workspace_id', '')::UUID, v_actor, TG_TABLE_NAME, v_record_id,
     TG_OP, v_email, v_before, v_after);

  RETURN COALESCE(NEW, OLD);
END;
$func$;

-- ─── 7. Backfill: personal workspace per existing user ───────────────────────
-- Idempotent. Existing data is only associated with its current owner's own
-- workspace; no row becomes visible to any other user.

SELECT set_config('erp.maintenance', 'on', false);

WITH created AS (
  INSERT INTO public.erp_workspaces (owner_id, name, is_personal)
  SELECT p.id, public.erp__default_workspace_name(p.full_name, p.email), true
  FROM public.user_profiles p
  ON CONFLICT (owner_id) WHERE is_personal DO NOTHING
  RETURNING id, owner_id
)
INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
SELECT id, owner_id, 'workspace.created', owner_id, jsonb_build_object('source', 'migration')
FROM created;

INSERT INTO public.erp_workspace_members (workspace_id, user_id, role)
SELECT w.id, w.owner_id, 'owner'
FROM public.erp_workspaces w
WHERE w.is_personal
ON CONFLICT (workspace_id, user_id) DO NOTHING;

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'erp_customers', 'erp_suppliers', 'erp_products', 'erp_purchase_orders',
    'erp_sales_orders', 'erp_invoices', 'erp_payments', 'erp_transactions',
    'erp_stock_movements', 'erp_audit_log'
  ] LOOP
    EXECUTE format(
      'UPDATE public.%I t SET workspace_id = w.id FROM public.erp_workspaces w '
      'WHERE w.owner_id = t.user_id AND w.is_personal AND t.workspace_id IS NULL', target);
  END LOOP;
END;
$$;

SELECT set_config('erp.maintenance', 'off', false);

-- ─── 8. Workspace-aware RLS (additional permissive policies) ─────────────────
-- Existing "users manage own rows" policies are unchanged. These grant members
-- of a workspace access that matches their role. Writes by members must keep
-- user_id = workspace owner (enforced here and by erp_assign_workspace()).

DROP POLICY IF EXISTS erp_workspaces_member_read ON public.erp_workspaces;
CREATE POLICY erp_workspaces_member_read ON public.erp_workspaces
  FOR SELECT TO authenticated
  USING (public.erp_workspace_role(id) IS NOT NULL);

DROP POLICY IF EXISTS erp_workspace_members_member_read ON public.erp_workspace_members;
CREATE POLICY erp_workspace_members_member_read ON public.erp_workspace_members
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.erp_workspace_role(workspace_id) IS NOT NULL);

DO $$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('erp_customers', 'customers', true, true),
      ('erp_suppliers', 'suppliers', true, true),
      ('erp_products', 'products', true, true),
      ('erp_payments', 'payments', true, false),
      ('erp_purchase_orders', NULL, false, false),
      ('erp_sales_orders', NULL, false, false),
      ('erp_invoices', NULL, false, false),
      ('erp_transactions', NULL, false, false),
      ('erp_stock_movements', NULL, false, false)
    ) AS s(table_name, write_permission, allow_insert, allow_modify)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.table_name || '_member_read', spec.table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
      'USING (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, ''read''))',
      spec.table_name || '_member_read', spec.table_name);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.table_name || '_member_insert', spec.table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.table_name || '_member_update', spec.table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.table_name || '_member_delete', spec.table_name);

    IF spec.allow_insert THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated '
        'WITH CHECK (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, %L) '
        'AND user_id = public.erp_workspace_owner_id(workspace_id))',
        spec.table_name || '_member_insert', spec.table_name, spec.write_permission);
    END IF;
    IF spec.allow_modify THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated '
        'USING (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, %L)) '
        'WITH CHECK (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, %L) '
        'AND user_id = public.erp_workspace_owner_id(workspace_id))',
        spec.table_name || '_member_update', spec.table_name, spec.write_permission, spec.write_permission);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated '
        'USING (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, %L))',
        spec.table_name || '_member_delete', spec.table_name, spec.write_permission);
    END IF;
  END LOOP;
END;
$$;

DROP POLICY IF EXISTS erp_purchase_order_items_member_read ON public.erp_purchase_order_items;
CREATE POLICY erp_purchase_order_items_member_read ON public.erp_purchase_order_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.erp_purchase_orders o
    WHERE o.id = purchase_order_id AND o.workspace_id IS NOT NULL
      AND public.erp_has_permission(o.workspace_id, 'read')));

DROP POLICY IF EXISTS erp_sales_order_items_member_read ON public.erp_sales_order_items;
CREATE POLICY erp_sales_order_items_member_read ON public.erp_sales_order_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.erp_sales_orders o
    WHERE o.id = sales_order_id AND o.workspace_id IS NOT NULL
      AND public.erp_has_permission(o.workspace_id, 'read')));

DROP POLICY IF EXISTS erp_approval_requests_member_read ON public.erp_approval_requests;
CREATE POLICY erp_approval_requests_member_read ON public.erp_approval_requests
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.erp_purchase_orders o
    WHERE o.id = purchase_order_id AND o.workspace_id IS NOT NULL
      AND public.erp_has_permission(o.workspace_id, 'read')));

DROP POLICY IF EXISTS erp_audit_log_member_read ON public.erp_audit_log;
CREATE POLICY erp_audit_log_member_read ON public.erp_audit_log
  FOR SELECT TO authenticated
  USING (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, 'audit'));

-- ─── 9. Access codes ──────────────────────────────────────────────────────────
-- Format: ETNA-XXXXX-XXXXX-XXXXX-XXXXX, 20 symbols from Crockford base32
-- (100 bits from pgcrypto's CSPRNG). Input is normalized so dashes, spaces,
-- lowercase, and the easily confused O/I/L are accepted.

CREATE OR REPLACE FUNCTION public.erp_normalize_access_code(p_code TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN length(c) = 24 AND left(c, 4) = 'ETNA' THEN substr(c, 5)
    ELSE c
  END
  FROM (
    SELECT translate(regexp_replace(upper(COALESCE(p_code, '')), '[^0-9A-Z]', '', 'g'), 'OIL', '011') AS c
  ) normalized;
$$;

CREATE OR REPLACE FUNCTION public.erp_hash_access_code(p_normalized_code TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(sha256(convert_to('etna-workspace-invite:' || p_normalized_code, 'UTF8')), 'hex');
$$;

REVOKE ALL ON FUNCTION public.erp_normalize_access_code(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hash_access_code(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.erp__require_member_manager(p_workspace_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE actor_role TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  actor_role := public.erp_workspace_role(p_workspace_id);
  IF actor_role IS NULL OR NOT ('members' = ANY(public.erp_role_permissions(actor_role))) THEN
    RAISE EXCEPTION 'You are not allowed to manage members of this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN actor_role;
END;
$$;

REVOKE ALL ON FUNCTION public.erp__require_member_manager(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.erp_create_workspace_invitation(
  p_workspace_id UUID,
  p_role TEXT,
  p_expires_in_hours INTEGER DEFAULT 72,
  p_label TEXT DEFAULT ''
)
RETURNS TABLE (invitation_id UUID, access_code TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor UUID := auth.uid();
  actor_role TEXT;
  alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  random_bytes BYTEA;
  code TEXT := '';
  idx INTEGER;
  new_id UUID;
  new_expiry TIMESTAMPTZ;
  pending_count INTEGER;
  clean_label TEXT := left(trim(COALESCE(p_label, '')), 120);
BEGIN
  actor_role := public.erp__require_member_manager(p_workspace_id);
  IF p_role IS NULL OR NOT (p_role = ANY(public.erp_grantable_roles(actor_role))) THEN
    RAISE EXCEPTION 'You cannot grant this role' USING ERRCODE = '42501';
  END IF;
  IF p_expires_in_hours IS NULL OR p_expires_in_hours < 1 OR p_expires_in_hours > 168 THEN
    RAISE EXCEPTION 'Invitation lifetime must be between 1 hour and 7 days';
  END IF;

  -- Serialize invitation creation per workspace so the pending cap holds.
  PERFORM 1 FROM public.erp_workspaces WHERE id = p_workspace_id FOR UPDATE;
  SELECT count(*) INTO pending_count
  FROM public.erp_workspace_invitations i
  WHERE i.workspace_id = p_workspace_id
    AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now();
  IF pending_count >= 25 THEN
    RAISE EXCEPTION 'Too many pending invitations. Revoke unused codes first';
  END IF;

  -- 256 is a multiple of 32, so byte % 32 is uniform over the alphabet.
  random_bytes := extensions.gen_random_bytes(20);
  FOR idx IN 0..19 LOOP
    code := code || substr(alphabet, (get_byte(random_bytes, idx) % 32) + 1, 1);
  END LOOP;

  new_expiry := now() + make_interval(hours => p_expires_in_hours);
  INSERT INTO public.erp_workspace_invitations (workspace_id, code_hash, role, label, created_by, expires_at)
  VALUES (p_workspace_id, public.erp_hash_access_code(code), p_role, clean_label, actor, new_expiry)
  RETURNING id INTO new_id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, invitation_id, details)
  VALUES (p_workspace_id, actor, 'invitation.created', new_id,
          jsonb_build_object('role', p_role, 'expires_at', new_expiry, 'label', clean_label));

  RETURN QUERY SELECT new_id,
    'ETNA-' || substr(code, 1, 5) || '-' || substr(code, 6, 5) || '-' || substr(code, 11, 5) || '-' || substr(code, 16, 5),
    new_expiry;
END;
$$;

-- Generic failures on purpose: callers cannot tell a wrong code from an
-- expired, revoked, or already used one. Failed attempts are recorded (the
-- function returns instead of raising so the record is committed) and more
-- than 5 failures in 15 minutes or 20 in 24 hours block further attempts.
CREATE OR REPLACE FUNCTION public.erp_redeem_workspace_invitation(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor UUID := auth.uid();
  normalized TEXT;
  invitation public.erp_workspace_invitations%ROWTYPE;
  membership public.erp_workspace_members%ROWTYPE;
  creator_role TEXT;
  short_failures INTEGER;
  daily_failures INTEGER;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = actor) THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- One redemption at a time per user, so parallel guesses share the limit.
  PERFORM pg_advisory_xact_lock(hashtext('erp_invite_redeem'), hashtext(actor::TEXT));

  SELECT count(*) FILTER (WHERE attempted_at > now() - interval '15 minutes'),
         count(*)
  INTO short_failures, daily_failures
  FROM public.erp_invitation_attempts
  WHERE user_id = actor AND NOT succeeded AND attempted_at > now() - interval '24 hours';
  IF short_failures >= 5 OR daily_failures >= 20 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;

  normalized := public.erp_normalize_access_code(p_code);
  IF length(normalized) = 20 THEN
    SELECT * INTO invitation
    FROM public.erp_workspace_invitations
    WHERE code_hash = public.erp_hash_access_code(normalized)
    FOR UPDATE;
  END IF;

  IF invitation.id IS NOT NULL THEN
    -- The inviter must still be allowed to grant this role.
    SELECT m.role INTO creator_role
    FROM public.erp_workspace_members m
    WHERE m.workspace_id = invitation.workspace_id AND m.user_id = invitation.created_by AND m.status = 'active';
  END IF;

  IF invitation.id IS NULL
     OR invitation.revoked_at IS NOT NULL
     OR invitation.redeemed_at IS NOT NULL
     OR invitation.expires_at <= now()
     OR creator_role IS NULL
     OR NOT (invitation.role = ANY(public.erp_grantable_roles(creator_role))) THEN
    INSERT INTO public.erp_invitation_attempts (user_id, succeeded) VALUES (actor, false);
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  SELECT * INTO membership
  FROM public.erp_workspace_members
  WHERE workspace_id = invitation.workspace_id AND user_id = actor
  FOR UPDATE;

  IF FOUND AND membership.status = 'active' THEN
    -- Already a member: nothing to do, and the code stays usable for its
    -- intended recipient.
    INSERT INTO public.erp_invitation_attempts (user_id, succeeded) VALUES (actor, true);
    RETURN jsonb_build_object('ok', true, 'workspace_id', invitation.workspace_id,
                              'role', membership.role, 'already_member', true);
  END IF;

  IF FOUND THEN
    UPDATE public.erp_workspace_members
    SET status = 'active', role = invitation.role, invited_by = invitation.created_by,
        invitation_id = invitation.id, joined_at = now(), removed_at = NULL,
        removed_by = NULL, removal_reason = '', updated_at = now()
    WHERE workspace_id = invitation.workspace_id AND user_id = actor;
  ELSE
    INSERT INTO public.erp_workspace_members (workspace_id, user_id, role, invited_by, invitation_id)
    VALUES (invitation.workspace_id, actor, invitation.role, invitation.created_by, invitation.id);
  END IF;

  UPDATE public.erp_workspace_invitations
  SET redeemed_by = actor, redeemed_at = now()
  WHERE id = invitation.id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, invitation_id, details)
  VALUES
    (invitation.workspace_id, actor, 'invitation.redeemed', actor, invitation.id, jsonb_build_object('role', invitation.role)),
    (invitation.workspace_id, actor, 'member.added', actor, invitation.id,
     jsonb_build_object('role', invitation.role, 'invited_by', invitation.created_by));

  INSERT INTO public.erp_invitation_attempts (user_id, succeeded) VALUES (actor, true);
  RETURN jsonb_build_object('ok', true, 'workspace_id', invitation.workspace_id,
                            'role', invitation.role, 'already_member', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_revoke_workspace_invitation(p_invitation_id UUID, p_reason TEXT DEFAULT '')
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invitation public.erp_workspace_invitations%ROWTYPE;
  actor_role TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO invitation FROM public.erp_workspace_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation not found'; END IF;
  actor_role := public.erp__require_member_manager(invitation.workspace_id);
  IF NOT (invitation.role = ANY(public.erp_grantable_roles(actor_role))) THEN
    RAISE EXCEPTION 'You cannot revoke this invitation' USING ERRCODE = '42501';
  END IF;
  IF invitation.redeemed_at IS NOT NULL THEN RAISE EXCEPTION 'This invitation has already been used'; END IF;
  IF invitation.revoked_at IS NOT NULL THEN RETURN; END IF;

  UPDATE public.erp_workspace_invitations
  SET revoked_at = now(), revoked_by = auth.uid(), revoke_reason = left(trim(COALESCE(p_reason, '')), 500)
  WHERE id = p_invitation_id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, invitation_id, details)
  VALUES (invitation.workspace_id, auth.uid(), 'invitation.revoked', invitation.id,
          jsonb_build_object('role', invitation.role, 'reason', left(trim(COALESCE(p_reason, '')), 500)));
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_list_workspace_invitations(p_workspace_id UUID)
RETURNS TABLE (
  id UUID, role TEXT, label TEXT, status TEXT, created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
  created_by_email TEXT, redeemed_by_email TEXT, redeemed_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.erp__require_member_manager(p_workspace_id);
  RETURN QUERY
  SELECT i.id, i.role, i.label,
    CASE
      WHEN i.redeemed_at IS NOT NULL THEN 'redeemed'
      WHEN i.revoked_at IS NOT NULL THEN 'revoked'
      WHEN i.expires_at <= now() THEN 'expired'
      ELSE 'pending'
    END,
    i.created_at, i.expires_at, creator.email, redeemer.email, i.redeemed_at, i.revoked_at
  FROM public.erp_workspace_invitations i
  LEFT JOIN public.user_profiles creator ON creator.id = i.created_by
  LEFT JOIN public.user_profiles redeemer ON redeemer.id = i.redeemed_by
  WHERE i.workspace_id = p_workspace_id
  ORDER BY i.created_at DESC
  LIMIT 100;
END;
$$;

-- ─── 10. Membership management ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_my_workspaces()
RETURNS TABLE (workspace_id UUID, name TEXT, role TEXT, is_owner BOOLEAN, is_personal BOOLEAN, owner_id UUID, owner_email TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  PERFORM public.erp_personal_workspace_id(auth.uid());
  RETURN QUERY
  SELECT w.id, w.name, m.role, w.owner_id = auth.uid(), w.is_personal, w.owner_id, owner_profile.email
  FROM public.erp_workspace_members m
  JOIN public.erp_workspaces w ON w.id = m.workspace_id
  LEFT JOIN public.user_profiles owner_profile ON owner_profile.id = w.owner_id
  WHERE m.user_id = auth.uid() AND m.status = 'active'
  ORDER BY (w.owner_id = auth.uid()) DESC, w.name;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_list_workspace_members(p_workspace_id UUID)
RETURNS TABLE (user_id UUID, email TEXT, full_name TEXT, role TEXT, joined_at TIMESTAMPTZ, is_owner BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.erp_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT m.user_id, p.email, p.full_name, m.role, m.joined_at, m.role = 'owner'
  FROM public.erp_workspace_members m
  JOIN public.user_profiles p ON p.id = m.user_id
  WHERE m.workspace_id = p_workspace_id AND m.status = 'active'
  ORDER BY (m.role = 'owner') DESC, m.joined_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_update_workspace_member_role(
  p_workspace_id UUID, p_user_id UUID, p_role TEXT, p_reason TEXT DEFAULT ''
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_role TEXT;
  target public.erp_workspace_members%ROWTYPE;
BEGIN
  actor_role := public.erp__require_member_manager(p_workspace_id);
  IF p_user_id = auth.uid() THEN RAISE EXCEPTION 'You cannot change your own role' USING ERRCODE = '42501'; END IF;
  SELECT * INTO target FROM public.erp_workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found'; END IF;
  IF NOT (target.role = ANY(public.erp_grantable_roles(actor_role)))
     OR p_role IS NULL OR NOT (p_role = ANY(public.erp_grantable_roles(actor_role))) THEN
    RAISE EXCEPTION 'You cannot assign this role' USING ERRCODE = '42501';
  END IF;
  IF target.role = p_role THEN RETURN; END IF;

  UPDATE public.erp_workspace_members SET role = p_role, updated_at = now()
  WHERE workspace_id = p_workspace_id AND user_id = p_user_id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
  VALUES (p_workspace_id, auth.uid(), 'member.role_changed', p_user_id,
          jsonb_build_object('from', target.role, 'to', p_role, 'reason', left(trim(COALESCE(p_reason, '')), 500)));
END;
$$;

-- Members may leave; managers may remove members whose role they could grant.
-- The owner cannot be removed. Rows are kept (status = removed) for history.
CREATE OR REPLACE FUNCTION public.erp_remove_workspace_member(
  p_workspace_id UUID, p_user_id UUID, p_reason TEXT DEFAULT ''
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_role TEXT;
  target public.erp_workspace_members%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO target FROM public.erp_workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found'; END IF;
  IF target.role = 'owner' THEN RAISE EXCEPTION 'The workspace owner cannot be removed' USING ERRCODE = '42501'; END IF;

  IF p_user_id <> auth.uid() THEN
    actor_role := public.erp__require_member_manager(p_workspace_id);
    IF NOT (target.role = ANY(public.erp_grantable_roles(actor_role))) THEN
      RAISE EXCEPTION 'You cannot remove this member' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE public.erp_workspace_members
  SET status = 'removed', removed_at = now(), removed_by = auth.uid(),
      removal_reason = left(trim(COALESCE(p_reason, '')), 500), updated_at = now()
  WHERE workspace_id = p_workspace_id AND user_id = p_user_id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
  VALUES (p_workspace_id, auth.uid(),
          CASE WHEN p_user_id = auth.uid() THEN 'member.left' ELSE 'member.removed' END,
          p_user_id, jsonb_build_object('role', target.role, 'reason', left(trim(COALESCE(p_reason, '')), 500)));
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_list_workspace_audit(p_workspace_id UUID, p_limit INTEGER DEFAULT 50)
RETURNS TABLE (id UUID, action TEXT, actor_email TEXT, target_email TEXT, details JSONB, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.erp_has_permission(p_workspace_id, 'audit') THEN
    RAISE EXCEPTION 'You are not allowed to view this workspace history' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT a.id, a.action, actor.email, target.email, a.details, a.created_at
  FROM public.erp_workspace_audit_log a
  LEFT JOIN public.user_profiles actor ON actor.id = a.actor_id
  LEFT JOIN public.user_profiles target ON target.id = a.target_user_id
  WHERE a.workspace_id = p_workspace_id
  ORDER BY a.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$$;

REVOKE ALL ON FUNCTION public.erp_create_workspace_invitation(UUID, TEXT, INTEGER, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_redeem_workspace_invitation(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_revoke_workspace_invitation(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_list_workspace_invitations(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_my_workspaces() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_list_workspace_members(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_update_workspace_member_role(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_remove_workspace_member(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_list_workspace_audit(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_create_workspace_invitation(UUID, TEXT, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_redeem_workspace_invitation(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_revoke_workspace_invitation(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_list_workspace_invitations(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_my_workspaces() TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_list_workspace_members(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_update_workspace_member_role(UUID, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_remove_workspace_member(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_list_workspace_audit(UUID, INTEGER) TO authenticated;
