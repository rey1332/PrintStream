-- Security hardening.
--
-- 1. Resetting an ERP (Settings → Delete all transactions / Delete all data)
--    goes through erp_reset_workspace, callable only from the server's reset
--    route (request.path '/account/reset'), which checks the password first.
--    Before, erp_delete_all_data / erp_delete_all_transactions checked only
--    that the caller passed their own id: a stolen session could wipe every
--    ERP its owner had, including the audit log, from the browser console.
--    The reset now:
--      * is for the Owner of the ERP, and clears that ERP only;
--      * keeps the audit log, and records the reset in the workspace trail.
--    The old functions stay for the record but no client can call them.
--
-- 2. Only the functions the app calls stay callable by API roles. Internal
--    helpers, trigger functions and the ledger's building blocks were
--    executable by every signed-in user (some even by anonymous visitors)
--    because new functions were granted to them by default. The allowlist
--    below is the complete set; tests/db/functionPrivileges.test.mjs keeps it
--    honest. New functions are no longer granted to anyone by default: each
--    migration grants what it needs explicitly.

-- ─── 1. Reset ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_reset_workspace(p_workspace_id UUID, p_scope TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := COALESCE(p_workspace_id, public.erp_personal_workspace_id(auth.uid()));
  v_owner UUID;
  counts JSONB;
BEGIN
  IF current_setting('request.path', true) IS DISTINCT FROM '/account/reset' THEN
    RAISE EXCEPTION 'An ERP is reset from Settings, with your password' USING ERRCODE = '42501';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('transactions', 'all') THEN
    RAISE EXCEPTION 'Unknown reset' USING ERRCODE = '22023';
  END IF;
  IF public.erp_workspace_role(ws) IS DISTINCT FROM 'owner' OR NOT public.erp_workspace_mfa_ok(ws) THEN
    RAISE EXCEPTION 'Only the owner can reset this ERP' USING ERRCODE = '42501';
  END IF;
  -- Also checked for every request (erp_check_request); repeated here for the most destructive action.
  IF NOT public.erp_mfa_satisfied() THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  SELECT w.owner_id INTO v_owner FROM public.erp_workspaces w WHERE w.id = ws;

  -- One reset at a time per ERP.
  PERFORM pg_advisory_xact_lock(hashtext('erp_reset'), hashtext(ws::TEXT));

  counts := jsonb_build_object(
    'invoices', (SELECT count(*) FROM public.erp_invoices x WHERE x.workspace_id = ws),
    'payments', (SELECT count(*) FROM public.erp_payments x WHERE x.workspace_id = ws),
    'transactions', (SELECT count(*) FROM public.erp_transactions x WHERE x.workspace_id = ws),
    'purchase_orders', (SELECT count(*) FROM public.erp_purchase_orders x WHERE x.workspace_id = ws),
    'sales_orders', (SELECT count(*) FROM public.erp_sales_orders x WHERE x.workspace_id = ws),
    'journal_entries', (SELECT count(*) FROM public.erp_journal_entries x WHERE x.workspace_id = ws));
  IF p_scope = 'all' THEN
    counts := counts || jsonb_build_object(
      'products', (SELECT count(*) FROM public.erp_products x WHERE x.workspace_id = ws),
      'customers', (SELECT count(*) FROM public.erp_customers x WHERE x.workspace_id = ws),
      'suppliers', (SELECT count(*) FROM public.erp_suppliers x WHERE x.workspace_id = ws),
      'workflows', (SELECT count(*) FROM public.workflows x WHERE x.workspace_id = ws));
  END IF;

  -- The trail outlives the reset: who, when, what and how much.
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'workspace.reset', jsonb_build_object('scope', p_scope, 'removed', counts));

  -- Same order as the previous reset (dependent rows first), scoped to this ERP.
  -- Approval requests go with their purchase orders (ON DELETE CASCADE).
  IF p_scope = 'all' THEN
    DELETE FROM public.workflow_runs x WHERE x.workspace_id = ws;
    DELETE FROM public.workflows x WHERE x.workspace_id = ws;
  END IF;
  DELETE FROM public.erp_stock_movements x WHERE x.workspace_id = ws;
  DELETE FROM public.erp_transactions x WHERE x.workspace_id = ws;
  DELETE FROM public.erp_payments x WHERE x.workspace_id = ws;
  DELETE FROM public.erp_invoices x WHERE x.workspace_id = ws;
  DELETE FROM public.erp_purchase_order_items i
    WHERE i.purchase_order_id IN (SELECT po.id FROM public.erp_purchase_orders po WHERE po.workspace_id = ws);
  DELETE FROM public.erp_purchase_orders x WHERE x.workspace_id = ws;
  DELETE FROM public.erp_sales_order_items i
    WHERE i.sales_order_id IN (SELECT so.id FROM public.erp_sales_orders so WHERE so.workspace_id = ws);
  DELETE FROM public.erp_sales_orders x WHERE x.workspace_id = ws;
  DELETE FROM public.erp_journal_entries x WHERE x.workspace_id = ws;
  IF p_scope = 'all' THEN
    DELETE FROM public.erp_products x WHERE x.workspace_id = ws;
    DELETE FROM public.erp_suppliers x WHERE x.workspace_id = ws;
    DELETE FROM public.erp_customers x WHERE x.workspace_id = ws;
    -- Kept per owner until an owner can have several ERPs.
    DELETE FROM public.erp_settings x WHERE x.user_id = v_owner;
    DELETE FROM public.erp_approval_settings x WHERE x.owner_id = v_owner;
    DELETE FROM public.erp_gl_accounts x WHERE x.workspace_id = ws;
    DELETE FROM public.erp_accounting_settings x WHERE x.workspace_id = ws;
  END IF;
  RETURN counts;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_reset_workspace(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_reset_workspace(UUID, TEXT) TO authenticated;

-- ─── 2. Callable functions ───────────────────────────────────────────────────

DO $$
DECLARE
  -- Every function the app calls (from the browser through /api/data, or from
  -- server routes as the signed-in user), and those used by row-level
  -- security policies. Everything else in the public schema is internal.
  callable TEXT[] := ARRAY[
    'api_rate_limit_hit', 'erp_accounting_settings_get', 'erp_accounting_settings_set', 'erp_add_exchange_rate',
    'erp_adjust_stock', 'erp_can_read', 'erp_cancel_purchase_order', 'erp_cancel_sales_order', 'erp_check_request',
    'erp_confirm_base_currency', 'erp_create_gl_account', 'erp_create_invoice', 'erp_create_invoice_v2',
    'erp_create_invoice_v3', 'erp_create_invoice_v4', 'erp_create_invoice_v5', 'erp_create_purchase_order',
    'erp_create_purchase_order_v2', 'erp_create_purchase_order_v3', 'erp_create_sales_order',
    'erp_create_sales_order_v2', 'erp_create_sales_order_v3', 'erp_create_warehouse',
    'erp_create_workspace_invitation', 'erp_currency_preview', 'erp_currency_settings_get', 'erp_decide_po_approval',
    'erp_deliver_sales_order', 'erp_document_delete', 'erp_document_get', 'erp_document_register',
    'erp_documents_list', 'erp_exchange_rate_lookup', 'erp_has_permission', 'erp_hr_access', 'erp_hr_attendance',
    'erp_hr_attendance_correct', 'erp_hr_clock_in', 'erp_hr_clock_out', 'erp_hr_employee_delete',
    'erp_hr_employee_save', 'erp_hr_employees', 'erp_hr_set_attendance_roles', 'erp_hr_today',
    'erp_import_exchange_rates', 'erp_issue_invoice_from_sales_order', 'erp_issue_invoice_from_sales_order_v2',
    'erp_journal_list', 'erp_list_workspace_audit', 'erp_list_workspace_invitations',
    'erp_list_workspace_member_security', 'erp_list_workspace_members', 'erp_log_access',
    'erp_mfa_clear_recovery_codes', 'erp_mfa_generate_recovery_codes', 'erp_mfa_recovery_status', 'erp_mfa_satisfied',
    'erp_mfa_use_recovery_code', 'erp_my_workspace_quota', 'erp_my_workspaces', 'erp_ontology_area',
    'erp_ontology_search', 'erp_post_journal', 'erp_read_grants', 'erp_record_purchase_receipt',
    'erp_record_purchase_receipt_v2', 'erp_record_sales_delivery', 'erp_redeem_workspace_invitation',
    'erp_remove_workspace_member', 'erp_rename_workspace', 'erp_reset_workspace', 'erp_reverse_fulfillment_event',
    'erp_reverse_journal', 'erp_revoke_workspace_invitation', 'erp_set_gl_account_active',
    'erp_session_aal', 'erp_set_purchase_tax_rate', 'erp_set_workspace_require_mfa', 'erp_transfer_stock', 'erp_trial_balance',
    'erp_update_purchase_order_status', 'erp_update_sales_order_items', 'erp_update_workspace_member_role',
    'erp_void_invoice', 'erp_void_payment', 'erp_workspace_owner_id', 'erp_workspace_role',
    'erp_workspace_security', 'workflow_publish_version', 'workflow_run_cancel', 'workflow_run_cancel_requested',
    'workflow_run_finish', 'workflow_run_start', 'workflow_save_version'
  ];
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig, p.proname AS name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      -- Extension functions (pg_trgm) are left as their extension made them.
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn.sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn.sig);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      IF fn.name = ANY(callable) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn.sig);
      ELSE
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn.sig);
      END IF;
    END IF;
  END LOOP;

  -- Anonymous requests run only the two-factor pre-request check.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT EXECUTE ON FUNCTION public.erp_check_request() TO anon;
  END IF;

  -- Nothing new becomes callable by default any more.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
  END IF;
  ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
END;
$$;
