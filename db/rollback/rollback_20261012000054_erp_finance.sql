-- Rollback for 20261012000054_erp_finance.sql.
-- Run only after redeploying an app version from before this change.
-- Cash accounts, bank statements and fixed assets are removed; payments go
-- back to one cash account. Journal entries already posted (transfers,
-- depreciation, disposals, bank lines) and the ledger accounts they use stay:
-- they explain the books. The journal keeps allowing their source types.

BEGIN;

-- The previous versions (20261006000000 / 20260929000000 / 20261012000053).
CREATE OR REPLACE FUNCTION public.erp_gl__on_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.voided_at IS NULL THEN
      PERFORM public.erp_gl__post(NEW.user_id, NEW.payment_date,
        CASE WHEN NEW.payment_type::TEXT = 'incoming' THEN 'Payment from ' ELSE 'Payment to ' END || NEW.party
          || CASE WHEN NEW.currency IS NOT NULL THEN ' (' || NEW.amount || ' ' || NEW.currency || ' @ ' || public.erp_fx__num(NEW.fx_rate) || ')' ELSE '' END,
        'payment', NEW.id, 'payment:' || NEW.id, public.erp_gl__payment_lines(NEW, NEW.amount));
    END IF;
  ELSIF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    PERFORM public.erp_gl__reverse(NEW.user_id, 'payment:' || NEW.id, NEW.voided_at::DATE,
      'Void of payment (' || NEW.party || ')', 'payment_void', NEW.id, 'payment_void:' || NEW.id);
  ELSIF NEW.voided_at IS NULL AND NEW.amount IS DISTINCT FROM OLD.amount THEN
    PERFORM public.erp_gl__post(NEW.user_id, CURRENT_DATE, 'Payment amount changed (' || NEW.party || ')',
      'payment_adjust', NEW.id, NULL, public.erp_gl__payment_lines(NEW, NEW.amount - OLD.amount));
  END IF;
  IF NEW.currency IS NOT NULL THEN
    IF NEW.invoice_id IS NOT NULL THEN PERFORM public.erp_fx__settle('invoice', NEW.invoice_id); END IF;
    IF NEW.purchase_order_id IS NOT NULL THEN PERFORM public.erp_fx__settle('purchase_order', NEW.purchase_order_id); END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_gl__on_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Rows mirrored from payments are posted with the payment.
  IF NEW.source_payment_id IS NOT NULL THEN RETURN NULL; END IF;
  PERFORM public.erp_gl__post(NEW.user_id, NEW.transaction_date,
    COALESCE(NULLIF(NEW.description, ''), NEW.category), 'transaction', NEW.id, 'transaction:' || NEW.id,
    CASE WHEN NEW.transaction_type::TEXT = 'income'
      THEN public.erp_gl__pair('cash', 'other_income', NEW.amount)
      ELSE public.erp_gl__pair('expenses', 'cash', NEW.amount) END);
  RETURN NULL;
END;
$$;

DROP FUNCTION IF EXISTS public.erp_supplier_bill_pay(UUID, NUMERIC, DATE, TEXT, UUID);
CREATE OR REPLACE FUNCTION public.erp_supplier_bill_pay(p_bill_id UUID, p_amount NUMERIC, p_date DATE, p_method TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  b public.erp_supplier_bills%ROWTYPE;
  v_amount NUMERIC := round(p_amount, 2);
  v_date DATE := COALESCE(p_date, CURRENT_DATE);
  new_id UUID;
BEGIN
  SELECT * INTO b FROM public.erp_supplier_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  PERFORM public.erp__resolve_workspace(b.workspace_id, 'payments');
  IF b.status = 'void' THEN RAISE EXCEPTION 'This bill is void' USING ERRCODE = 'P0001', HINT = 'void'; END IF;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount > b.total_payable - b.amount_paid THEN
    RAISE EXCEPTION 'The amount must be positive and at most what is still owed (%)', b.total_payable - b.amount_paid
      USING ERRCODE = 'P0001', HINT = 'amount';
  END IF;
  IF v_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'The date cannot be in the future' USING ERRCODE = '22023', HINT = 'future';
  END IF;
  INSERT INTO public.erp_payments (user_id, workspace_id, payment_type, party, amount, payment_date, method, note, supplier_bill_id, created_by)
  VALUES (b.user_id, b.workspace_id, 'outgoing', b.supplier_name, v_amount, v_date,
          left(COALESCE(NULLIF(btrim(p_method), ''), 'transfer'), 40),
          left('Bill ' || COALESCE(NULLIF(b.bill_no, ''), b.description), 300), b.id, auth.uid())
  RETURNING id INTO new_id;
  PERFORM public.erp__bill_refresh(b.id);
  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_supplier_bill_pay(UUID, NUMERIC, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_supplier_bill_pay(UUID, NUMERIC, DATE, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.erp__reset_modules(p_workspace_id UUID, p_scope TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.erp_weigh_tickets x WHERE x.workspace_id = p_workspace_id;
  DELETE FROM public.erp_production_runs x WHERE x.workspace_id = p_workspace_id;
  DELETE FROM public.erp_equipment_logs x WHERE x.workspace_id = p_workspace_id;
  UPDATE public.erp_equipment x SET hour_meter = x.initial_hour_meter, last_service_hours = NULL, last_service_date = NULL
   WHERE x.workspace_id = p_workspace_id;
  UPDATE public.erp_payments x SET supplier_bill_id = NULL WHERE x.workspace_id = p_workspace_id AND x.supplier_bill_id IS NOT NULL;
  DELETE FROM public.erp_supplier_bills x WHERE x.workspace_id = p_workspace_id;
  IF p_scope = 'all' THEN
    DELETE FROM public.erp_vehicles x WHERE x.workspace_id = p_workspace_id;
    DELETE FROM public.erp_equipment x WHERE x.workspace_id = p_workspace_id;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.erp_cash_account_list(UUID, DATE);
DROP FUNCTION IF EXISTS public.erp_cash_account_create(UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_cash_account_update(UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_cash_transfer(UUID, UUID, UUID, NUMERIC, DATE, TEXT);
DROP FUNCTION IF EXISTS public.erp_cash_transfer_list(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS public.erp_cash_transfer_void(UUID, UUID);
DROP FUNCTION IF EXISTS public.erp_bank_statement_import(UUID, UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_bank_statement_delete(UUID);
DROP FUNCTION IF EXISTS public.erp_bank_line_candidates(UUID);
DROP FUNCTION IF EXISTS public.erp_bank_line_match(UUID, UUID);
DROP FUNCTION IF EXISTS public.erp_bank_line_unmatch(UUID);
DROP FUNCTION IF EXISTS public.erp_bank_line_ignore(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_bank_line_post(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_bank_auto_match(UUID, UUID);
DROP FUNCTION IF EXISTS public.erp_bank_reconciliation(UUID, UUID, DATE);
DROP FUNCTION IF EXISTS public.erp_bank_unmatched_ledger(UUID, UUID, DATE, DATE);
DROP FUNCTION IF EXISTS public.erp_fixed_asset_create(UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_fixed_asset_void(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_fixed_assets_depreciate(UUID, DATE);
DROP FUNCTION IF EXISTS public.erp_fixed_asset_dispose(UUID, DATE, NUMERIC, UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_fixed_asset_schedule(UUID);
DROP FUNCTION IF EXISTS public.erp_fa__run(UUID, DATE);
DROP FUNCTION IF EXISTS public.erp_fa__amount(public.erp_fixed_assets, INTEGER, NUMERIC);
DROP FUNCTION IF EXISTS public.erp_bank__candidates(public.erp_bank_statement_lines, INTEGER);
DROP FUNCTION IF EXISTS public.erp_bank__line(UUID);
DROP FUNCTION IF EXISTS public.erp_bank__parse(JSONB);
DROP FUNCTION IF EXISTS public.erp_cash__account(UUID, UUID);
DROP FUNCTION IF EXISTS public.erp_cash__route(JSONB, UUID);
DROP FUNCTION IF EXISTS public.erp_cash__ensure(UUID, UUID);
DROP FUNCTION IF EXISTS public.erp_fin__read(UUID);
DROP FUNCTION IF EXISTS public.erp_fin__account(UUID, TEXT);

DROP TRIGGER IF EXISTS trg_erp_payment_cash_account ON public.erp_payments;
DROP TRIGGER IF EXISTS trg_erp_transaction_cash_account ON public.erp_transactions;
DROP FUNCTION IF EXISTS public.erp_cash__check();

DROP TABLE IF EXISTS public.erp_fixed_asset_depreciation;
DROP TABLE IF EXISTS public.erp_fixed_assets;
DROP TABLE IF EXISTS public.erp_bank_statement_lines;
DROP TABLE IF EXISTS public.erp_bank_statements;
ALTER TABLE public.erp_payments DROP COLUMN IF EXISTS cash_account_id;
ALTER TABLE public.erp_transactions DROP COLUMN IF EXISTS cash_account_id;
DROP TABLE IF EXISTS public.erp_cash_accounts;

COMMIT;
