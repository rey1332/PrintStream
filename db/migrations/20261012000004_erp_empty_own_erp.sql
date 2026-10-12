-- Emptying the account's own ERP (ERPs & sync → Delete, on "Your own").
--
-- Every account keeps one ERP of its own, so "deleting" it empties it
-- completely instead: all records, books, stock, warehouses, HR and payroll,
-- documents, workflows, settings, sync state and the sync inbox, invitations
-- and every member other than the Owner. The ERP itself, its name and its
-- trails (the workspace audit log and the record-change log) stay; the trail
-- records who emptied it and how much was removed. Exchange rates stay (they
-- cannot be changed or removed by design).
--
-- Like deleting a created ERP it runs only from the server route that checks
-- the password and the typed name ('/account/delete-erp'), for the Owner,
-- after two-factor verification when the account uses it. Data synced into
-- other ERPs stays there; their links to this ERP's rows are dropped.
--
-- Rollback: db/rollback/rollback_20261012000004_erp_empty_own_erp.sql

CREATE OR REPLACE FUNCTION public.erp_empty_erp(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor UUID := auth.uid();
  w public.erp_workspaces%ROWTYPE;
  counts JSONB;
BEGIN
  IF current_setting('request.path', true) IS DISTINCT FROM '/account/delete-erp' THEN
    RAISE EXCEPTION 'An ERP is emptied from ERPs & sync, with your password' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO w FROM public.erp_workspaces x WHERE x.id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR public.erp_workspace_role(w.id) IS DISTINCT FROM 'owner' OR NOT public.erp_workspace_mfa_ok(w.id) THEN
    RAISE EXCEPTION 'Only the owner can empty this ERP' USING ERRCODE = '42501';
  END IF;
  IF NOT public.erp_mfa_satisfied() THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  IF NOT w.is_personal OR w.owner_id IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'Only your own ERP is emptied; a created ERP is deleted' USING ERRCODE = 'P0001', HINT = 'not_personal';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('erp_reset'), hashtext(w.id::TEXT));

  counts := jsonb_build_object(
    'invoices', (SELECT count(*) FROM public.erp_invoices x WHERE x.workspace_id = w.id),
    'payments', (SELECT count(*) FROM public.erp_payments x WHERE x.workspace_id = w.id),
    'purchase_orders', (SELECT count(*) FROM public.erp_purchase_orders x WHERE x.workspace_id = w.id),
    'sales_orders', (SELECT count(*) FROM public.erp_sales_orders x WHERE x.workspace_id = w.id),
    'journal_entries', (SELECT count(*) FROM public.erp_journal_entries x WHERE x.workspace_id = w.id),
    'products', (SELECT count(*) FROM public.erp_products x WHERE x.workspace_id = w.id),
    'customers', (SELECT count(*) FROM public.erp_customers x WHERE x.workspace_id = w.id),
    'suppliers', (SELECT count(*) FROM public.erp_suppliers x WHERE x.workspace_id = w.id),
    'employees', (SELECT count(*) FROM public.erp_employees x WHERE x.workspace_id = w.id),
    'documents', (SELECT count(*) FROM public.erp_documents x WHERE x.workspace_id = w.id),
    'workflows', (SELECT count(*) FROM public.workflows x WHERE x.workspace_id = w.id),
    'members', (SELECT count(*) FROM public.erp_workspace_members x
                WHERE x.workspace_id = w.id AND x.status = 'active' AND x.user_id <> actor));

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (w.id, actor, 'erp.emptied', jsonb_build_object('name', w.name, 'removed', counts));

  -- Dependent rows first, as in erp_delete_erp.
  DELETE FROM public.workflow_runs x WHERE x.workspace_id = w.id;
  DELETE FROM public.workflows x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_stock_movements x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_transactions x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_payments x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_invoices x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_purchase_order_items i
    WHERE i.purchase_order_id IN (SELECT po.id FROM public.erp_purchase_orders po WHERE po.workspace_id = w.id);
  DELETE FROM public.erp_purchase_orders x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_sales_order_items i
    WHERE i.sales_order_id IN (SELECT so.id FROM public.erp_sales_orders so WHERE so.workspace_id = w.id);
  DELETE FROM public.erp_sales_orders x WHERE x.workspace_id = w.id;
  -- Attendance keeps its employee (ON DELETE RESTRICT); payroll runs keep their entries.
  DELETE FROM public.erp_attendance x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_payroll_runs x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_employees x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_hr_settings x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_journal_entries x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_stock_transfers x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_products x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_suppliers x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_customers x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_warehouses x WHERE x.workspace_id = w.id OR x.user_id = w.owner_id;
  DELETE FROM public.erp_gl_accounts x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_accounting_settings x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_settings x WHERE x.user_id = w.owner_id;
  DELETE FROM public.erp_approval_settings x WHERE x.owner_id = w.owner_id;
  -- Files on disk are removed by the server route after the commit.
  DELETE FROM public.erp_documents x WHERE x.workspace_id = w.id;
  -- Sync: copies in other ERPs stay; links, state and runs about this ERP go.
  DELETE FROM public.erp_sync_inbox x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_sync_links x WHERE x.ws_a = w.id OR x.ws_b = w.id;
  DELETE FROM public.erp_sync_state x WHERE x.source_ws = w.id OR x.target_ws = w.id;
  DELETE FROM public.erp_sync_runs x WHERE x.source_ws = w.id;
  -- The team: everyone but the Owner, and every invitation.
  DELETE FROM public.erp_workspace_invitations x WHERE x.workspace_id = w.id;
  UPDATE public.erp_workspace_members x
  SET status = 'removed', removed_at = now(), removed_by = actor,
      removal_reason = 'ERP emptied', updated_at = now()
  WHERE x.workspace_id = w.id AND x.status = 'active' AND x.user_id <> actor;
  RETURN counts;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_empty_erp(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_empty_erp(UUID) TO authenticated;
