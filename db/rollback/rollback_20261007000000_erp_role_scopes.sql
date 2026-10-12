-- Rollback for 20261007000000_erp_role_scopes.sql.
-- Run only after redeploying an app version from before module-scoped roles.
--
-- Restores: 'read' for Sales and Inventory (they read the whole workspace
-- again), the Viewer role and its grants, the read policies and the functions
-- this migration changed.
-- Not restored: members who were Viewers stay removed and the viewer
-- invitations stay revoked (both are in the workspace audit trail); the owner
-- invites them again if needed.

BEGIN;

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

ALTER TABLE public.erp_workspace_members DROP CONSTRAINT IF EXISTS erp_workspace_members_role_check;
ALTER TABLE public.erp_workspace_members ADD CONSTRAINT erp_workspace_members_role_check
  CHECK (role IN ('owner', 'admin', 'finance', 'sales', 'inventory', 'viewer'));
ALTER TABLE public.erp_workspace_invitations DROP CONSTRAINT IF EXISTS erp_workspace_invitations_role_check;
ALTER TABLE public.erp_workspace_invitations ADD CONSTRAINT erp_workspace_invitations_role_check
  CHECK (role IN ('admin', 'finance', 'sales', 'inventory', 'viewer'));

-- Read policies: 'read' again.
DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['erp_customers', 'erp_suppliers', 'erp_products', 'erp_payments', 'erp_purchase_orders',
                                'erp_sales_orders', 'erp_invoices', 'erp_transactions', 'erp_stock_movements'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', target || '_member_read', target);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
                   'USING (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, ''read''))',
                   target || '_member_read', target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['erp_warehouses', 'erp_stock_transfers'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', target || '_read', target);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ('
                   'user_id = (SELECT auth.uid()) OR (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, ''read'')))',
                   target || '_read', target);
  END LOOP;
END;
$$;

DROP POLICY IF EXISTS erp_purchase_order_items_member_read ON public.erp_purchase_order_items;
CREATE POLICY erp_purchase_order_items_member_read ON public.erp_purchase_order_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.erp_purchase_orders o
                 WHERE o.id = purchase_order_id AND o.workspace_id IS NOT NULL AND public.erp_has_permission(o.workspace_id, 'read')));
DROP POLICY IF EXISTS erp_sales_order_items_member_read ON public.erp_sales_order_items;
CREATE POLICY erp_sales_order_items_member_read ON public.erp_sales_order_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.erp_sales_orders o
                 WHERE o.id = sales_order_id AND o.workspace_id IS NOT NULL AND public.erp_has_permission(o.workspace_id, 'read')));
DROP POLICY IF EXISTS erp_approval_requests_member_read ON public.erp_approval_requests;
CREATE POLICY erp_approval_requests_member_read ON public.erp_approval_requests
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.erp_purchase_orders o
                 WHERE o.id = purchase_order_id AND o.workspace_id IS NOT NULL AND public.erp_has_permission(o.workspace_id, 'read')));
DROP POLICY IF EXISTS erp_stock_reservations_read ON public.erp_stock_reservations;
CREATE POLICY erp_stock_reservations_read ON public.erp_stock_reservations
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, 'read')));
DROP POLICY IF EXISTS erp_fulfillment_events_read ON public.erp_fulfillment_events;
CREATE POLICY erp_fulfillment_events_read ON public.erp_fulfillment_events
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, 'read')));

-- Functions: their previous checks.
CREATE OR REPLACE FUNCTION public.erp__authorize(p_user_id UUID, p_workspace_id UUID, p_permission TEXT, p_label TEXT)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF NOT public.erp_can_write_record(p_user_id, p_workspace_id, 'read') THEN
    RAISE EXCEPTION '% not found', p_label;
  END IF;
  IF NOT public.erp_can_write_record(p_user_id, p_workspace_id, p_permission) THEN
    RAISE EXCEPTION 'Your workspace role does not allow this action' USING ERRCODE = '42501';
  END IF;
END;
$$;

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
  IF NOT public.erp_has_permission(p_workspace_id, p_permission) THEN
    RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT owner_id FROM public.erp_workspaces WHERE id = p_workspace_id);
END;
$$;

-- The settings and rate functions used erp_gl__scope(…, 'member'); 'read' again.
DO $$
DECLARE
  fn TEXT;
  def TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.erp_accounting_settings_get(uuid)',
    'public.erp_exchange_rate_lookup(uuid, text, text, date)',
    'public.erp_import_exchange_rates(uuid, text, timestamptz, jsonb)',
    'public.erp_currency_settings_get(uuid)'
  ] LOOP
    def := pg_get_functiondef(fn::regprocedure);
    EXECUTE replace(def, 'public.erp_gl__scope(p_workspace_id, ''member'')', 'public.erp_gl__scope(p_workspace_id, ''read'')');
  END LOOP;
  def := pg_get_functiondef(
    'public.erp_ontology_search(uuid, text, text[], uuid, uuid, integer, text[], date, date, integer, integer)'::regprocedure);
  EXECUTE replace(def, 'public.erp_can_read(p_workspace_id, public.erp_ontology_area(p_type))',
                  'public.erp_has_permission(p_workspace_id, ''read'')');
  def := pg_get_functiondef('public.erp_log_access(uuid, text, text[], uuid, integer)'::regprocedure);
  EXECUTE replace(def, 'public.erp_is_member(p_workspace_id)', 'public.erp_has_permission(p_workspace_id, ''read'')');
END;
$$;

DROP FUNCTION IF EXISTS public.erp_ontology_area(TEXT);
DROP FUNCTION IF EXISTS public.erp_can_read(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_is_member(UUID);
DROP FUNCTION IF EXISTS public.erp_read_grants(TEXT);

COMMIT;
