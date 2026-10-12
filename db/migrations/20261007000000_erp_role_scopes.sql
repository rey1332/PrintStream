-- Module-scoped roles.
--
-- Sales and Inventory no longer read the whole workspace:
--   * Sales     — customers, sales orders and invoices (plus the product list
--                 and stock availability needed to write a sales order);
--   * Inventory — suppliers, products, stock, purchase orders, goods receipts,
--                 and the sales orders it delivers.
-- Owner, Admin and Finance keep 'read' (everything), as before.
-- The Viewer role is retired: pending viewer invitations are revoked and
-- active viewers are removed from their workspaces (rows kept as history,
-- status = 'removed'; accounts are not touched).
--
-- Every change is enforced here, in row-level security and the RPCs; the app
-- only mirrors it (src/app/erp/lib/erpRules.ts, parity-tested).

-- ─── 1. Roles ────────────────────────────────────────────────────────────────
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
    WHEN 'sales' THEN ARRAY['customers','sales','invoicing']
    WHEN 'inventory' THEN ARRAY['suppliers','products','inventory','fulfillment','purchasing','receiving']
    ELSE ARRAY[]::TEXT[]
  END;
$$;

CREATE OR REPLACE FUNCTION public.erp_grantable_roles(p_role TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_role
    WHEN 'owner' THEN ARRAY['admin','finance','sales','inventory']
    WHEN 'admin' THEN ARRAY['finance','sales','inventory']
    ELSE ARRAY[]::TEXT[]
  END;
$$;

-- ─── 2. Read areas ───────────────────────────────────────────────────────────
-- Which permissions let a member read an area. 'read' reads everything.
-- Keep in sync with READ_AREAS in src/app/erp/lib/erpRules.ts.

CREATE OR REPLACE FUNCTION public.erp_read_grants(p_area TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_area
    WHEN 'customers' THEN ARRAY['read','customers']
    WHEN 'suppliers' THEN ARRAY['read','suppliers']
    WHEN 'products' THEN ARRAY['read','products','sales']
    WHEN 'stock' THEN ARRAY['read','inventory']
    WHEN 'purchase_orders' THEN ARRAY['read','purchasing','receiving']
    WHEN 'sales_orders' THEN ARRAY['read','sales','fulfillment']
    WHEN 'invoices' THEN ARRAY['read','invoicing']
    WHEN 'payments' THEN ARRAY['read','payments']
    ELSE ARRAY['read']
  END;
$$;

CREATE OR REPLACE FUNCTION public.erp_can_read(p_workspace_id UUID, p_area TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.erp_role_permissions(public.erp_workspace_role(p_workspace_id)) && public.erp_read_grants(p_area), false)
     AND public.erp_workspace_mfa_ok(p_workspace_id);
$$;

-- An active member of the workspace (any role), two-factor rule included.
CREATE OR REPLACE FUNCTION public.erp_is_member(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.erp_workspace_role(p_workspace_id) IS NOT NULL AND public.erp_workspace_mfa_ok(p_workspace_id);
$$;

REVOKE ALL ON FUNCTION public.erp_read_grants(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_can_read(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_is_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_read_grants(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_can_read(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_is_member(UUID) TO authenticated;

-- ─── 3. Row-level security: reads by area ────────────────────────────────────
-- Same policy names as before; only the read condition changes. The
-- "own rows" policies (user_id = auth.uid()) are untouched.

DO $$
DECLARE
  spec RECORD;
  target TEXT;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('erp_customers', 'customers'),
      ('erp_suppliers', 'suppliers'),
      ('erp_products', 'products'),
      ('erp_payments', 'payments'),
      ('erp_purchase_orders', 'purchase_orders'),
      ('erp_sales_orders', 'sales_orders'),
      ('erp_invoices', 'invoices'),
      ('erp_transactions', 'books'),
      ('erp_stock_movements', 'stock')
    ) AS s(table_name, area)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.table_name || '_member_read', spec.table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
      'USING (workspace_id IS NOT NULL AND public.erp_can_read(workspace_id, %L))',
      spec.table_name || '_member_read', spec.table_name, spec.area);
  END LOOP;

  FOREACH target IN ARRAY ARRAY['erp_warehouses', 'erp_stock_transfers'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', target || '_read', target);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ('
      'user_id = (SELECT auth.uid()) OR (workspace_id IS NOT NULL AND public.erp_can_read(workspace_id, ''stock'')))',
      target || '_read', target);
  END LOOP;
END;
$$;

DROP POLICY IF EXISTS erp_purchase_order_items_member_read ON public.erp_purchase_order_items;
CREATE POLICY erp_purchase_order_items_member_read ON public.erp_purchase_order_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.erp_purchase_orders o
    WHERE o.id = purchase_order_id AND o.workspace_id IS NOT NULL
      AND public.erp_can_read(o.workspace_id, 'purchase_orders')));

DROP POLICY IF EXISTS erp_sales_order_items_member_read ON public.erp_sales_order_items;
CREATE POLICY erp_sales_order_items_member_read ON public.erp_sales_order_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.erp_sales_orders o
    WHERE o.id = sales_order_id AND o.workspace_id IS NOT NULL
      AND public.erp_can_read(o.workspace_id, 'sales_orders')));

DROP POLICY IF EXISTS erp_approval_requests_member_read ON public.erp_approval_requests;
CREATE POLICY erp_approval_requests_member_read ON public.erp_approval_requests
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.erp_purchase_orders o
    WHERE o.id = purchase_order_id AND o.workspace_id IS NOT NULL
      AND public.erp_can_read(o.workspace_id, 'purchase_orders')));

-- Reservations feed stock availability, which a sales order needs.
DROP POLICY IF EXISTS erp_stock_reservations_read ON public.erp_stock_reservations;
CREATE POLICY erp_stock_reservations_read ON public.erp_stock_reservations
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid())
         OR (workspace_id IS NOT NULL AND public.erp_can_read(workspace_id, 'products')));

-- A goods receipt belongs to its purchase order; a delivery to its sales order.
DROP POLICY IF EXISTS erp_fulfillment_events_read ON public.erp_fulfillment_events;
CREATE POLICY erp_fulfillment_events_read ON public.erp_fulfillment_events
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid())
         OR (workspace_id IS NOT NULL AND public.erp_can_read(workspace_id,
               CASE kind WHEN 'purchase_receipt' THEN 'purchase_orders' ELSE 'sales_orders' END)));

-- ─── 4. RPC authorization ────────────────────────────────────────────────────
-- Non-members still get "not found"; members whose role lacks the permission
-- get a permission error. Membership no longer implies reading everything.

CREATE OR REPLACE FUNCTION public.erp__authorize(p_user_id UUID, p_workspace_id UUID, p_permission TEXT, p_label TEXT)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF NOT ((p_workspace_id IS NOT NULL AND public.erp_is_member(p_workspace_id))
          OR (p_workspace_id IS NULL AND p_user_id = auth.uid())) THEN
    RAISE EXCEPTION '% not found', p_label;
  END IF;
  IF NOT public.erp_can_write_record(p_user_id, p_workspace_id, p_permission) THEN
    RAISE EXCEPTION 'Your workspace role does not allow this action' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- 'member' = any active member (for settings every form needs: base
-- currency, tax rates, exchange rates). Everything else is a permission.
CREATE OR REPLACE FUNCTION public.erp_gl__scope(p_workspace_id UUID, p_permission TEXT DEFAULT 'read')
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_workspace_id IS NULL THEN RETURN auth.uid(); END IF;
  IF (p_permission = 'member' AND NOT public.erp_is_member(p_workspace_id))
     OR (p_permission <> 'member' AND NOT public.erp_has_permission(p_workspace_id, p_permission)) THEN
    RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT owner_id FROM public.erp_workspaces WHERE id = p_workspace_id);
END;
$$;

-- Same as 20260930000000, readable by every member (tax rates and base
-- currency are needed to write orders and invoices).
CREATE OR REPLACE FUNCTION public.erp_accounting_settings_get(p_workspace_id UUID)
RETURNS TABLE (base_currency TEXT, lock_date DATE, sales_tax_rate NUMERIC, purchase_tax_rate NUMERIC, can_manage BOOLEAN, can_post BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE owner UUID := public.erp_gl__scope(p_workspace_id, 'member');
BEGIN
  PERFORM public.erp_gl__seed(owner);
  RETURN QUERY
  SELECT s.base_currency, s.lock_date, s.sales_tax_rate, s.purchase_tax_rate,
         owner = auth.uid() OR (p_workspace_id IS NOT NULL AND public.erp_has_permission(p_workspace_id, 'members')),
         owner = auth.uid() OR (p_workspace_id IS NOT NULL AND public.erp_has_permission(p_workspace_id, 'payments'))
  FROM public.erp_accounting_settings s WHERE s.user_id = owner;
END;
$$;

-- Same as 20261006000000, readable by every member.
CREATE OR REPLACE FUNCTION public.erp_exchange_rate_lookup(p_workspace_id UUID, p_from TEXT, p_to TEXT, p_date DATE)
RETURNS TABLE (rate NUMERIC, rate_date DATE, source TEXT, provider TEXT, rate_id UUID, method TEXT, age_days INTEGER, stale BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE owner UUID := public.erp_gl__scope(p_workspace_id, 'member');
BEGIN
  RETURN QUERY
  SELECT f.rate, f.rate_date, f.source, f.provider, f.rate_id, f.method,
         (COALESCE(p_date, CURRENT_DATE) - f.rate_date)::INTEGER,
         (COALESCE(p_date, CURRENT_DATE) - f.rate_date) > public.erp_fx__max_age_days()
  FROM public.erp_fx__find_rate(owner, upper(p_from), upper(p_to), COALESCE(p_date, CURRENT_DATE)) f;
END;
$$;

-- Same as 20261006000000; the permission check below still decides.
CREATE OR REPLACE FUNCTION public.erp_import_exchange_rates(
  p_workspace_id UUID, p_provider TEXT, p_retrieved_at TIMESTAMPTZ, p_rows JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner UUID := public.erp_gl__scope(p_workspace_id, 'member');
  row JSONB;
  inserted INTEGER := 0;
  v_from TEXT; v_to TEXT; v_rate NUMERIC; v_date DATE;
BEGIN
  IF current_setting('request.path', true) IS DISTINCT FROM '/currency/import' THEN
    RAISE EXCEPTION 'Provider rates are recorded by the ETNA server only' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NOT NULL AND NOT (
       public.erp_has_permission(p_workspace_id, 'invoicing') OR public.erp_has_permission(p_workspace_id, 'payments')
    OR public.erp_has_permission(p_workspace_id, 'purchasing') OR public.erp_has_permission(p_workspace_id, 'sales')) THEN
    RAISE EXCEPTION 'Your workspace role does not allow this action' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 200 THEN
    RAISE EXCEPTION 'Invalid rates' USING ERRCODE = '22023';
  END IF;
  FOR row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    BEGIN
      v_from := row->>'from'; v_to := row->>'to';
      v_rate := (row->>'rate')::NUMERIC; v_date := (row->>'date')::DATE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid rate row' USING ERRCODE = '22023';
    END;
    IF v_from = v_to OR v_rate IS NULL OR v_rate <= 0 OR v_date IS NULL OR v_date > CURRENT_DATE
       OR NOT EXISTS (SELECT 1 FROM public.erp_currencies WHERE code = v_from)
       OR NOT EXISTS (SELECT 1 FROM public.erp_currencies WHERE code = v_to) THEN
      RAISE EXCEPTION 'Invalid rate row' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.erp_exchange_rates
                   WHERE user_id = owner AND from_currency = v_from AND to_currency = v_to
                     AND effective_date = v_date AND source = 'frankfurter' AND rate = round(v_rate, 12)) THEN
      INSERT INTO public.erp_exchange_rates
        (user_id, workspace_id, from_currency, to_currency, rate, effective_date, source, provider, retrieved_at, created_by)
      VALUES (owner, p_workspace_id, v_from, v_to, round(v_rate, 12), v_date, 'frankfurter',
              left(COALESCE(p_provider, ''), 100), COALESCE(p_retrieved_at, now()), auth.uid());
      inserted := inserted + 1;
    END IF;
  END LOOP;
  IF inserted > 0 THEN
    PERFORM public.erp_fx__audit(owner, p_workspace_id, 'rates_imported',
      jsonb_build_object('provider', left(COALESCE(p_provider, ''), 100), 'count', inserted, 'retrieved_at', p_retrieved_at));
  END IF;
  RETURN inserted;
END;
$$;

-- Same as 20261006000000, readable by every member.
CREATE OR REPLACE FUNCTION public.erp_currency_settings_get(p_workspace_id UUID)
RETURNS TABLE (
  base_currency TEXT, confirmed_at TIMESTAMPTZ, locked BOOLEAN, has_records BOOLEAN,
  can_change_base BOOLEAN, can_manage_rates BOOLEAN, can_fetch_rates BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner UUID := public.erp_gl__scope(p_workspace_id, 'member');
  records BOOLEAN := public.erp_fx__has_records(owner);
BEGIN
  PERFORM public.erp_gl__seed(owner);
  RETURN QUERY
  SELECT s.base_currency, s.base_currency_confirmed_at, s.base_currency_confirmed_at IS NOT NULL AND records, records,
         owner = auth.uid(),
         owner = auth.uid() OR (p_workspace_id IS NOT NULL AND public.erp_has_permission(p_workspace_id, 'payments')),
         owner = auth.uid() OR (p_workspace_id IS NOT NULL AND (
           public.erp_has_permission(p_workspace_id, 'invoicing') OR public.erp_has_permission(p_workspace_id, 'payments')
           OR public.erp_has_permission(p_workspace_id, 'purchasing') OR public.erp_has_permission(p_workspace_id, 'sales')))
  FROM public.erp_accounting_settings s WHERE s.user_id = owner;
END;
$$;

-- ─── 5. ERP → Search by area ─────────────────────────────────────────────────
-- Each object type is searched only by roles that may read its area.
-- Keep in sync with `area` in src/lib/ontology/registry.ts.

CREATE OR REPLACE FUNCTION public.erp_ontology_area(p_type TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_type
    WHEN 'supplier' THEN 'suppliers'
    WHEN 'customer' THEN 'customers'
    WHEN 'product' THEN 'products'
    WHEN 'purchaseOrder' THEN 'purchase_orders'
    WHEN 'goodsReceipt' THEN 'purchase_orders'
    WHEN 'salesOrder' THEN 'sales_orders'
    WHEN 'delivery' THEN 'sales_orders'
    WHEN 'invoice' THEN 'invoices'
    WHEN 'payment' THEN 'payments'
    WHEN 'stockMovement' THEN 'stock'
    ELSE 'books'
  END;
$$;
REVOKE ALL ON FUNCTION public.erp_ontology_area(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_ontology_area(TEXT) TO authenticated;

-- erp_ontology_search (20261005000000) is unchanged except for its access
-- check: the type's area instead of 'read'. Rewritten from its own current
-- definition, so nothing else in it can drift.
DO $$
DECLARE
  def TEXT := pg_get_functiondef(
    'public.erp_ontology_search(uuid, text, text[], uuid, uuid, integer, text[], date, date, integer, integer)'::regprocedure);
  old_check CONSTANT TEXT := 'public.erp_has_permission(p_workspace_id, ''read'')';
BEGIN
  IF position(old_check IN def) = 0 THEN
    RAISE EXCEPTION 'erp_ontology_search is not the expected version';
  END IF;
  EXECUTE replace(def, old_check, 'public.erp_can_read(p_workspace_id, public.erp_ontology_area(p_type))');
END;
$$;

-- Logging a search or a record view needs membership (the search itself
-- checked the areas).
CREATE OR REPLACE FUNCTION public.erp_log_access(
  p_workspace_id UUID, p_action TEXT, p_object_types TEXT[], p_object_id UUID, p_result_count INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NOT NULL AND NOT public.erp_is_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('search', 'view')
     OR COALESCE(cardinality(p_object_types), 0) > 20
     OR EXISTS (SELECT 1 FROM unnest(p_object_types) x WHERE x !~ '^[a-zA-Z]{1,40}$') THEN
    RAISE EXCEPTION 'Invalid access log entry' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.erp_access_log (workspace_id, actor_id, action, object_types, object_id, result_count)
  VALUES (p_workspace_id, auth.uid(), p_action, COALESCE(p_object_types, '{}'), p_object_id, p_result_count);
END;
$$;

-- ─── 6. Retire the Viewer role ───────────────────────────────────────────────
-- Recorded in each workspace's audit trail (actor: none, source: migration).

WITH revoked AS (
  UPDATE public.erp_workspace_invitations
  SET revoked_at = now(), revoke_reason = 'Viewer role retired'
  WHERE role = 'viewer' AND redeemed_at IS NULL AND revoked_at IS NULL
  RETURNING id, workspace_id
)
INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, invitation_id, details)
SELECT workspace_id, NULL, 'invitation.revoked', id,
       jsonb_build_object('role', 'viewer', 'reason', 'Viewer role retired', 'source', 'migration')
FROM revoked;

WITH removed AS (
  UPDATE public.erp_workspace_members
  SET status = 'removed', removed_at = now(), removed_by = NULL,
      removal_reason = 'Viewer role retired', updated_at = now()
  WHERE role = 'viewer' AND status = 'active'
  RETURNING workspace_id, user_id
)
INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
SELECT workspace_id, NULL, 'member.removed', user_id,
       jsonb_build_object('role', 'viewer', 'reason', 'Viewer role retired', 'source', 'migration')
FROM removed;

-- Viewer stays valid only on history rows (removed members, used or revoked
-- invitations), so nobody can hold or be given it again.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conrelid::regclass AS rel, conname FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid IN ('public.erp_workspace_members'::regclass, 'public.erp_workspace_invitations'::regclass)
      AND pg_get_constraintdef(oid) LIKE '%viewer%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.rel, c.conname);
  END LOOP;
END;
$$;

ALTER TABLE public.erp_workspace_members ADD CONSTRAINT erp_workspace_members_role_check
  CHECK (role IN ('owner', 'admin', 'finance', 'sales', 'inventory') OR (role = 'viewer' AND status = 'removed'));
ALTER TABLE public.erp_workspace_invitations ADD CONSTRAINT erp_workspace_invitations_role_check
  CHECK (role IN ('admin', 'finance', 'sales', 'inventory')
         OR (role = 'viewer' AND (redeemed_at IS NOT NULL OR revoked_at IS NOT NULL)));
