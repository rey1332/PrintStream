-- ERP settings per ERP (Settings → Alerts and Purchase approval).
--
-- Alert thresholds (erp_settings) and purchase-order approval
-- (erp_approval_settings) are kept per ERP owner account. Every ERP has its
-- own owner account (an account's own ERP: the account; a created ERP: its
-- internal account), so they are already one row per ERP, and purchase
-- orders already look them up by the ERP's owner. The app, however, read and
-- wrote them for the signed-in account: approval set up in a created ERP was
-- saved on the person's own ERP and never applied, and members of someone
-- else's ERP saw their own thresholds.
--
-- These functions read and write the settings of a given ERP: every member
-- reads the alert thresholds; the Owner and Admins read and change the
-- approval set-up and change the thresholds. Changes are in the audit trail.
--
-- Rollback: db/rollback/rollback_20261012000005_erp_workspace_settings.sql

CREATE OR REPLACE FUNCTION public.erp_workspace_settings_get(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := COALESCE(p_workspace_id, public.erp_personal_workspace_id(auth.uid()));
  v_role TEXT := public.erp_workspace_role(ws);
  v_owner UUID;
  s public.erp_settings%ROWTYPE;
  a public.erp_approval_settings%ROWTYPE;
  manage BOOLEAN;
BEGIN
  IF v_role IS NULL OR NOT public.erp_workspace_mfa_ok(ws) THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = '42501';
  END IF;
  manage := v_role IN ('owner', 'admin');
  SELECT w.owner_id INTO v_owner FROM public.erp_workspaces w WHERE w.id = ws;
  SELECT * INTO s FROM public.erp_settings x WHERE x.user_id = v_owner;
  SELECT * INTO a FROM public.erp_approval_settings x WHERE x.owner_id = v_owner;
  RETURN jsonb_build_object(
    'can_edit', manage,
    'cash_low_threshold', COALESCE(s.cash_low_threshold, 5000),
    'expense_spike_ratio', COALESCE(s.expense_spike_ratio, 85),
    'inventory_low_threshold', COALESCE(s.inventory_low_threshold, 10000),
    'approval', CASE WHEN manage THEN jsonb_build_object(
      -- An internal owner's address is not a real mailbox.
      'admin_email', CASE WHEN a.admin_email LIKE '%@container.etna.invalid' THEN '' ELSE COALESCE(a.admin_email, '') END,
      'approver_emails', to_jsonb(COALESCE(a.approver_emails, '{}')),
      'po_approval_threshold', COALESCE(a.po_approval_threshold, 0)) END);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_workspace_settings_set(p_workspace_id UUID, p_settings JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := COALESCE(p_workspace_id, public.erp_personal_workspace_id(auth.uid()));
  v_owner UUID;
  cash NUMERIC := (p_settings ->> 'cash_low_threshold')::NUMERIC;
  ratio NUMERIC := (p_settings ->> 'expense_spike_ratio')::NUMERIC;
  stock NUMERIC := (p_settings ->> 'inventory_low_threshold')::NUMERIC;
  v_admin TEXT := lower(btrim(COALESCE(p_settings ->> 'admin_email', '')));
  approvers TEXT[];
  threshold NUMERIC := COALESCE((p_settings ->> 'po_approval_threshold')::NUMERIC, 0);
  v_email TEXT;
BEGIN
  IF NOT public.erp_sync__can(ws) THEN
    RAISE EXCEPTION 'Only an owner or admin can change the settings of this ERP' USING ERRCODE = '42501';
  END IF;
  IF cash IS NULL OR cash < 0 OR stock IS NULL OR stock < 0 OR ratio IS NULL OR ratio <= 0 OR ratio > 1000 THEN
    RAISE EXCEPTION 'Alert thresholds must be zero or more' USING ERRCODE = 'P0001', HINT = 'thresholds';
  END IF;
  IF threshold < 0 THEN
    RAISE EXCEPTION 'The approval amount cannot be negative' USING ERRCODE = 'P0001', HINT = 'threshold';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT lower(btrim(e))) FILTER (WHERE btrim(e) <> ''), '{}') INTO approvers
  FROM jsonb_array_elements_text(COALESCE(p_settings -> 'approver_emails', '[]'::jsonb)) e;
  FOREACH v_email IN ARRAY approvers || CASE WHEN v_admin <> '' THEN ARRAY[v_admin] ELSE ARRAY[]::TEXT[] END LOOP
    IF v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
      RAISE EXCEPTION 'Not an e-mail address: %', v_email USING ERRCODE = 'P0001', HINT = 'email';
    END IF;
  END LOOP;
  IF threshold > 0 AND cardinality(approvers) = 0 THEN
    RAISE EXCEPTION 'Add at least one approver for purchase orders above the amount' USING ERRCODE = 'P0001', HINT = 'approver';
  END IF;
  IF cardinality(approvers) > 20 THEN
    RAISE EXCEPTION 'At most 20 approvers' USING ERRCODE = 'P0001', HINT = 'approver';
  END IF;

  SELECT w.owner_id INTO v_owner FROM public.erp_workspaces w WHERE w.id = ws;
  INSERT INTO public.erp_settings (user_id, cash_low_threshold, expense_spike_ratio, inventory_low_threshold)
  VALUES (v_owner, cash, ratio, stock)
  ON CONFLICT (user_id) DO UPDATE SET cash_low_threshold = EXCLUDED.cash_low_threshold,
    expense_spike_ratio = EXCLUDED.expense_spike_ratio, inventory_low_threshold = EXCLUDED.inventory_low_threshold,
    updated_at = now();
  INSERT INTO public.erp_approval_settings (owner_id, admin_email, approver_emails, po_approval_threshold)
  VALUES (v_owner, COALESCE(NULLIF(v_admin, ''), lower(COALESCE(auth.jwt() ->> 'email', ''))), approvers, threshold)
  ON CONFLICT (owner_id) DO UPDATE SET admin_email = EXCLUDED.admin_email, approver_emails = EXCLUDED.approver_emails,
    po_approval_threshold = EXCLUDED.po_approval_threshold, updated_at = now();

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'settings.changed', jsonb_build_object(
    'cash_low_threshold', cash, 'expense_spike_ratio', ratio, 'inventory_low_threshold', stock,
    'po_approval_threshold', threshold, 'approvers', cardinality(approvers)));
END;
$$;

REVOKE ALL ON FUNCTION public.erp_workspace_settings_get(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_workspace_settings_set(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_workspace_settings_get(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_workspace_settings_set(UUID, JSONB) TO authenticated;
