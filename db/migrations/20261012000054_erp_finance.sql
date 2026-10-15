-- Finance: cash and bank accounts, bank statement reconciliation, and fixed
-- assets with depreciation (docs/FINANCE.md).
--
-- 1. Cash and bank accounts (erp_cash_accounts). Each is a ledger account of
--    its own; the first one is the ledger's "Cash and bank" (1000), which
--    every payment used so far. A payment or cash-book row can name the
--    account it went through (cash_account_id); without one it stays on the
--    default, as before. Transfers between accounts are journal entries:
--      Dr to-account / Cr from-account
-- 2. Bank statements (erp_bank_statements, erp_bank_statement_lines): lines
--    imported from a bank's CSV (parsed by the app: src/lib/finance/bankCsv.ts),
--    each kept once per account (a fingerprint of date, amount, text and
--    reference). A line is matched to a ledger line on the account's ledger
--    account with the same amount, or posted as a new entry against another
--    account (bank charges, interest), or ignored.
-- 3. Fixed assets (erp_fixed_assets) with monthly depreciation, straight line
--    or declining balance, one entry per asset and month:
--      Dr Depreciation expense / Cr Accumulated depreciation
--    Buying one: Dr Fixed assets / Cr a cash account, Accounts payable or
--    Opening balance equity (or nothing, when it is already in the ledger).
--    Disposal: Dr Accumulated depreciation, Dr Cash (proceeds) / Cr Fixed
--    assets, the difference to a gain or a loss on disposal.
--
-- Rights: everything here with 'payments'; reading with read access to
-- payments. Rollback: db/rollback/rollback_20261012000054_erp_finance.sql

-- ─── Ledger accounts ─────────────────────────────────────────────────────────

-- As erp_tax__account: the first free code from a base, once per ledger.
CREATE OR REPLACE FUNCTION public.erp_fin__account(p_owner UUID, p_key TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  account UUID;
  base_code INTEGER := CASE p_key
    WHEN 'fixed_assets' THEN 1500 WHEN 'accum_depreciation' THEN 1590 WHEN 'disposal_gain' THEN 4200
    WHEN 'depreciation' THEN 6500 WHEN 'disposal_loss' THEN 6510 WHEN 'bank_charges' THEN 6520 END;
  v_name TEXT := CASE p_key
    WHEN 'fixed_assets' THEN 'Fixed assets' WHEN 'accum_depreciation' THEN 'Accumulated depreciation'
    WHEN 'disposal_gain' THEN 'Gain on disposal of assets' WHEN 'depreciation' THEN 'Depreciation expense'
    WHEN 'disposal_loss' THEN 'Loss on disposal of assets' WHEN 'bank_charges' THEN 'Bank charges' END;
  v_type TEXT := CASE
    WHEN p_key IN ('fixed_assets', 'accum_depreciation') THEN 'asset'
    WHEN p_key = 'disposal_gain' THEN 'income' ELSE 'expense' END;
  candidate INTEGER;
BEGIN
  IF base_code IS NULL THEN RAISE EXCEPTION 'Unknown finance account %', p_key; END IF;
  PERFORM public.erp_gl__seed(p_owner);
  SELECT id INTO account FROM public.erp_gl_accounts WHERE user_id = p_owner AND system_key = p_key;
  IF account IS NOT NULL THEN RETURN account; END IF;
  FOR candidate IN base_code .. base_code + 9 LOOP
    IF NOT EXISTS (SELECT 1 FROM public.erp_gl_accounts WHERE user_id = p_owner AND code = candidate::TEXT) THEN
      INSERT INTO public.erp_gl_accounts (user_id, code, name, account_type, system_key)
      VALUES (p_owner, candidate::TEXT, v_name, v_type, p_key)
      RETURNING id INTO account;
      RETURN account;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'No free account code for %', v_name;
END;
$$;

ALTER TABLE public.erp_journal_entries DROP CONSTRAINT IF EXISTS erp_journal_entries_source_type_check;
ALTER TABLE public.erp_journal_entries ADD CONSTRAINT erp_journal_entries_source_type_check CHECK (source_type IN (
  'invoice', 'invoice_void', 'invoice_adjust', 'payment', 'payment_void', 'payment_adjust', 'transaction',
  'purchase_receipt', 'sales_delivery', 'stock_adjustment', 'opening_stock', 'manual', 'manual_reversal',
  'fx_settlement', 'payroll', 'payroll_reversal', 'weigh_ticket', 'weigh_ticket_cancel',
  'production', 'production_reversal', 'fuel_issue', 'fuel_issue_reversal',
  'supplier_bill', 'supplier_bill_void',
  'cash_transfer', 'cash_transfer_void', 'bank_line',
  'asset_acquisition', 'asset_acquisition_void', 'depreciation', 'asset_disposal'));

-- ─── 1. Cash and bank accounts ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.erp_cash_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('cash', 'bank')),
  bank_name TEXT NOT NULL DEFAULT '' CHECK (char_length(bank_name) <= 60),
  account_no TEXT NOT NULL DEFAULT '' CHECK (char_length(account_no) <= 40),
  gl_account_id UUID NOT NULL UNIQUE REFERENCES public.erp_gl_accounts(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_erp_cash_accounts_ws ON public.erp_cash_accounts (workspace_id);

ALTER TABLE public.erp_payments ADD COLUMN IF NOT EXISTS cash_account_id UUID REFERENCES public.erp_cash_accounts(id) ON DELETE SET NULL;
ALTER TABLE public.erp_transactions ADD COLUMN IF NOT EXISTS cash_account_id UUID REFERENCES public.erp_cash_accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_erp_payments_cash_account ON public.erp_payments (cash_account_id) WHERE cash_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_erp_transactions_cash_account ON public.erp_transactions (cash_account_id) WHERE cash_account_id IS NOT NULL;

-- The ledger's own "Cash and bank" account as the first cash account, once.
CREATE OR REPLACE FUNCTION public.erp_cash__ensure(p_owner UUID, p_workspace_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  gl UUID := public.erp_gl__account(p_owner, 'cash');
  existing UUID;
  v_name TEXT;
BEGIN
  SELECT id INTO existing FROM public.erp_cash_accounts WHERE gl_account_id = gl;
  IF existing IS NOT NULL THEN RETURN existing; END IF;
  SELECT name INTO v_name FROM public.erp_gl_accounts WHERE id = gl;
  IF EXISTS (SELECT 1 FROM public.erp_cash_accounts WHERE user_id = p_owner AND name = v_name) THEN
    v_name := left(v_name || ' (ledger)', 80);
  END IF;
  INSERT INTO public.erp_cash_accounts (user_id, workspace_id, name, kind, gl_account_id)
  VALUES (p_owner, p_workspace_id, v_name, 'cash', gl)
  ON CONFLICT (gl_account_id) DO NOTHING
  RETURNING id INTO existing;
  RETURN COALESCE(existing, (SELECT id FROM public.erp_cash_accounts WHERE gl_account_id = gl));
END;
$$;

-- A payment / cash-book row may name an active cash account of its own
-- business; once posted, it stays on that account (void and record again).
CREATE OR REPLACE FUNCTION public.erp_cash__check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.cash_account_id IS DISTINCT FROM OLD.cash_account_id THEN
      RAISE EXCEPTION 'The cash or bank account of a recorded entry cannot be changed; void it and record it again'
        USING ERRCODE = 'P0001', HINT = 'cash_account_locked';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.cash_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.erp_cash_accounts c
     WHERE c.id = NEW.cash_account_id AND c.user_id = NEW.user_id AND c.is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active cash or bank account of this business' USING ERRCODE = 'P0001', HINT = 'cash_account';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_erp_payment_cash_account ON public.erp_payments;
CREATE TRIGGER trg_erp_payment_cash_account BEFORE INSERT OR UPDATE OF cash_account_id ON public.erp_payments
  FOR EACH ROW EXECUTE FUNCTION public.erp_cash__check();
DROP TRIGGER IF EXISTS trg_erp_transaction_cash_account ON public.erp_transactions;
CREATE TRIGGER trg_erp_transaction_cash_account BEFORE INSERT OR UPDATE OF cash_account_id ON public.erp_transactions
  FOR EACH ROW EXECUTE FUNCTION public.erp_cash__check();

-- The "cash" lines of an entry onto the named cash account's ledger account.
CREATE OR REPLACE FUNCTION public.erp_cash__route(p_lines JSONB, p_cash_account UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN p_cash_account IS NULL THEN p_lines ELSE (
    SELECT COALESCE(jsonb_agg(
             CASE WHEN l ->> 'key' = 'cash'
               THEN (l - 'key') || jsonb_build_object('account_id', (SELECT gl_account_id FROM public.erp_cash_accounts WHERE id = p_cash_account))
               ELSE l END
             ORDER BY o), '[]'::jsonb)
      FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS t(l, o)) END;
$$;

-- As in 20261006000000, with the payment's cash account.
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
        'payment', NEW.id, 'payment:' || NEW.id,
        public.erp_cash__route(public.erp_gl__payment_lines(NEW, NEW.amount), NEW.cash_account_id));
    END IF;
  ELSIF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    PERFORM public.erp_gl__reverse(NEW.user_id, 'payment:' || NEW.id, NEW.voided_at::DATE,
      'Void of payment (' || NEW.party || ')', 'payment_void', NEW.id, 'payment_void:' || NEW.id);
  ELSIF NEW.voided_at IS NULL AND NEW.amount IS DISTINCT FROM OLD.amount THEN
    PERFORM public.erp_gl__post(NEW.user_id, CURRENT_DATE, 'Payment amount changed (' || NEW.party || ')',
      'payment_adjust', NEW.id, NULL,
      public.erp_cash__route(public.erp_gl__payment_lines(NEW, NEW.amount - OLD.amount), NEW.cash_account_id));
  END IF;
  IF NEW.currency IS NOT NULL THEN
    IF NEW.invoice_id IS NOT NULL THEN PERFORM public.erp_fx__settle('invoice', NEW.invoice_id); END IF;
    IF NEW.purchase_order_id IS NOT NULL THEN PERFORM public.erp_fx__settle('purchase_order', NEW.purchase_order_id); END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- As in 20260929000000, with the row's cash account.
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
    public.erp_cash__route(
      CASE WHEN NEW.transaction_type::TEXT = 'income'
        THEN public.erp_gl__pair('cash', 'other_income', NEW.amount)
        ELSE public.erp_gl__pair('expenses', 'cash', NEW.amount) END,
      NEW.cash_account_id));
  RETURN NULL;
END;
$$;

-- Read access to payments, for the lists below.
CREATE OR REPLACE FUNCTION public.erp_fin__read(p_workspace_id UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ws UUID := public.erp__resolve_workspace(p_workspace_id, 'read');
BEGIN
  IF NOT public.erp_can_read(ws, 'payments') THEN
    RAISE EXCEPTION 'Your workspace role does not allow this action' USING ERRCODE = '42501';
  END IF;
  RETURN ws;
END;
$$;

-- Accounts with their ledger balance (through p_as_of, default today).
CREATE OR REPLACE FUNCTION public.erp_cash_account_list(p_workspace_id UUID, p_as_of DATE DEFAULT NULL)
RETURNS TABLE (
  id UUID, name TEXT, kind TEXT, bank_name TEXT, account_no TEXT, gl_account_id UUID, gl_code TEXT,
  is_active BOOLEAN, is_default BOOLEAN, balance NUMERIC, open_lines INTEGER, last_statement_date DATE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_fin__read(p_workspace_id);
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces w WHERE w.id = ws);
  v_default UUID := public.erp_cash__ensure(v_owner, ws);
BEGIN
  RETURN QUERY
  SELECT c.id, c.name, c.kind, c.bank_name, c.account_no, c.gl_account_id, a.code,
         c.is_active, c.id = v_default,
         COALESCE((SELECT sum(l.debit - l.credit) FROM public.erp_journal_lines l
                     JOIN public.erp_journal_entries e ON e.id = l.entry_id
                    WHERE l.account_id = c.gl_account_id AND e.entry_date <= COALESCE(p_as_of, CURRENT_DATE)), 0)::NUMERIC,
         (SELECT count(*)::INTEGER FROM public.erp_bank_statement_lines s WHERE s.cash_account_id = c.id AND s.status = 'open'),
         (SELECT max(s.line_date) FROM public.erp_bank_statement_lines s WHERE s.cash_account_id = c.id)
    FROM public.erp_cash_accounts c
    JOIN public.erp_gl_accounts a ON a.id = c.gl_account_id
   WHERE c.user_id = v_owner
   ORDER BY c.id <> v_default, c.is_active DESC, c.kind, c.name;
END;
$$;

-- p: {name, kind: cash|bank, bank_name?, account_no?}
CREATE OR REPLACE FUNCTION public.erp_cash_account_create(p_workspace_id UUID, p JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'payments');
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces WHERE id = ws);
  v_name TEXT := left(btrim(COALESCE(p ->> 'name', '')), 80);
  v_kind TEXT := COALESCE(p ->> 'kind', 'bank');
  gl UUID;
  candidate INTEGER;
  new_id UUID;
BEGIN
  IF v_name = '' THEN RAISE EXCEPTION 'Enter a name for the account' USING ERRCODE = '22023', HINT = 'name'; END IF;
  IF v_kind NOT IN ('cash', 'bank') THEN RAISE EXCEPTION 'Invalid kind' USING ERRCODE = '22023'; END IF;
  PERFORM public.erp_cash__ensure(v_owner, ws);
  IF EXISTS (SELECT 1 FROM public.erp_cash_accounts WHERE user_id = v_owner AND lower(name) = lower(v_name)) THEN
    RAISE EXCEPTION 'An account with this name exists' USING ERRCODE = '23505', HINT = 'duplicate';
  END IF;
  FOR candidate IN 1001 .. 1099 LOOP
    IF NOT EXISTS (SELECT 1 FROM public.erp_gl_accounts WHERE user_id = v_owner AND code = candidate::TEXT) THEN
      INSERT INTO public.erp_gl_accounts (user_id, workspace_id, code, name, account_type)
      VALUES (v_owner, ws, candidate::TEXT, left(v_name, 120), 'asset')
      RETURNING id INTO gl;
      EXIT;
    END IF;
  END LOOP;
  IF gl IS NULL THEN RAISE EXCEPTION 'No free account code for a cash account (1001-1099)' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.erp_cash_accounts (user_id, workspace_id, name, kind, bank_name, account_no, gl_account_id, created_by)
  VALUES (v_owner, ws, v_name, v_kind,
          left(btrim(COALESCE(p ->> 'bank_name', '')), 60),
          left(btrim(COALESCE(p ->> 'account_no', '')), 40), gl, auth.uid())
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

-- p: {name?, bank_name?, account_no?, is_active?}. The default account
-- cannot be closed, nor one that still holds money.
CREATE OR REPLACE FUNCTION public.erp_cash_account_update(p_id UUID, p JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.erp_cash_accounts%ROWTYPE;
  v_name TEXT;
  v_active BOOLEAN;
  v_balance NUMERIC;
BEGIN
  SELECT * INTO c FROM public.erp_cash_accounts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found' USING ERRCODE = '42501'; END IF;
  PERFORM public.erp__resolve_workspace(c.workspace_id, 'payments');
  v_name := left(btrim(COALESCE(p ->> 'name', c.name)), 80);
  v_active := COALESCE((p ->> 'is_active')::BOOLEAN, c.is_active);
  IF v_name = '' THEN RAISE EXCEPTION 'Enter a name for the account' USING ERRCODE = '22023', HINT = 'name'; END IF;
  IF lower(v_name) <> lower(c.name) AND EXISTS (
    SELECT 1 FROM public.erp_cash_accounts WHERE user_id = c.user_id AND lower(name) = lower(v_name) AND id <> c.id
  ) THEN
    RAISE EXCEPTION 'An account with this name exists' USING ERRCODE = '23505', HINT = 'duplicate';
  END IF;
  IF NOT v_active AND c.is_active THEN
    IF c.gl_account_id = public.erp_gl__account(c.user_id, 'cash') THEN
      RAISE EXCEPTION 'The default cash account cannot be closed' USING ERRCODE = 'P0001', HINT = 'default';
    END IF;
    SELECT COALESCE(sum(debit - credit), 0) INTO v_balance FROM public.erp_journal_lines WHERE account_id = c.gl_account_id;
    IF v_balance <> 0 THEN
      RAISE EXCEPTION 'Move the balance (%) to another account before closing this one', v_balance
        USING ERRCODE = 'P0001', HINT = 'balance';
    END IF;
  END IF;
  UPDATE public.erp_cash_accounts
     SET name = v_name, is_active = v_active,
         bank_name = left(btrim(COALESCE(p ->> 'bank_name', bank_name)), 60),
         account_no = left(btrim(COALESCE(p ->> 'account_no', account_no)), 40)
   WHERE id = c.id;
  -- The default account keeps the ledger's own name; the others follow theirs.
  IF c.gl_account_id <> public.erp_gl__account(c.user_id, 'cash') THEN
    UPDATE public.erp_gl_accounts SET name = left(v_name, 120), is_active = v_active WHERE id = c.gl_account_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_cash__account(p_owner UUID, p_id UUID)
RETURNS public.erp_cash_accounts
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE c public.erp_cash_accounts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.erp_cash_accounts WHERE id = p_id AND user_id = p_owner AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose an active cash or bank account of this business' USING ERRCODE = 'P0001', HINT = 'cash_account';
  END IF;
  RETURN c;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_cash_transfer(
  p_workspace_id UUID, p_from UUID, p_to UUID, p_amount NUMERIC, p_date DATE, p_memo TEXT DEFAULT ''
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'payments');
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces WHERE id = ws);
  a public.erp_cash_accounts;
  b public.erp_cash_accounts;
  v_amount NUMERIC := round(p_amount, 2);
  v_date DATE := COALESCE(p_date, CURRENT_DATE);
BEGIN
  a := public.erp_cash__account(v_owner, p_from);
  b := public.erp_cash__account(v_owner, p_to);
  IF a.id = b.id THEN RAISE EXCEPTION 'Choose two different accounts' USING ERRCODE = '22023', HINT = 'same'; END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'Enter a positive amount' USING ERRCODE = '22023', HINT = 'amount'; END IF;
  IF v_date > CURRENT_DATE THEN RAISE EXCEPTION 'The date cannot be in the future' USING ERRCODE = '22023', HINT = 'future'; END IF;
  RETURN public.erp_gl__post(v_owner, v_date,
    COALESCE(NULLIF(left(btrim(p_memo), 300), ''), 'Transfer ' || a.name || ' → ' || b.name),
    'cash_transfer', NULL, 'cash_transfer:' || gen_random_uuid(),
    jsonb_build_array(
      jsonb_build_object('account_id', b.gl_account_id, 'debit', v_amount, 'credit', 0),
      jsonb_build_object('account_id', a.gl_account_id, 'debit', 0, 'credit', v_amount)));
END;
$$;

-- Transfers of a period, newest first.
CREATE OR REPLACE FUNCTION public.erp_cash_transfer_list(p_workspace_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (entry_id UUID, entry_no INTEGER, entry_date DATE, memo TEXT, amount NUMERIC,
               from_account TEXT, to_account TEXT, voided BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_fin__read(p_workspace_id);
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces w WHERE w.id = ws);
BEGIN
  RETURN QUERY
  SELECT e.id, e.entry_no, e.entry_date, e.memo,
         (SELECT sum(l.debit) FROM public.erp_journal_lines l WHERE l.entry_id = e.id)::NUMERIC,
         (SELECT c.name FROM public.erp_journal_lines l JOIN public.erp_cash_accounts c ON c.gl_account_id = l.account_id
           WHERE l.entry_id = e.id AND l.credit > 0 LIMIT 1),
         (SELECT c.name FROM public.erp_journal_lines l JOIN public.erp_cash_accounts c ON c.gl_account_id = l.account_id
           WHERE l.entry_id = e.id AND l.debit > 0 LIMIT 1),
         EXISTS (SELECT 1 FROM public.erp_journal_entries r WHERE r.reverses_entry_id = e.id)
    FROM public.erp_journal_entries e
   WHERE e.user_id = v_owner AND e.source_type = 'cash_transfer' AND e.entry_date BETWEEN p_from AND p_to
   ORDER BY e.entry_date DESC, e.entry_no DESC
   LIMIT 500;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_cash_transfer_void(p_workspace_id UUID, p_entry_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'payments');
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces WHERE id = ws);
  e public.erp_journal_entries%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.erp_journal_entries WHERE id = p_entry_id AND user_id = v_owner AND source_type = 'cash_transfer';
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.erp_journal_entries r WHERE r.reverses_entry_id = e.id) THEN
    RAISE EXCEPTION 'This transfer is already void' USING ERRCODE = 'P0001', HINT = 'void';
  END IF;
  IF EXISTS (SELECT 1 FROM public.erp_bank_statement_lines s JOIN public.erp_journal_lines l ON l.id = s.journal_line_id
              WHERE l.entry_id = e.id) THEN
    RAISE EXCEPTION 'A bank statement line is matched to this transfer; unmatch it first' USING ERRCODE = 'P0001', HINT = 'matched';
  END IF;
  RETURN public.erp_gl__reverse(v_owner, e.source_key, CURRENT_DATE, 'Void of ' || e.memo,
    'cash_transfer_void', NULL, 'cash_transfer_void:' || e.id);
END;
$$;

-- Supplier bills paid from a chosen account (as in 20261012000053, plus p_cash_account_id).
DROP FUNCTION IF EXISTS public.erp_supplier_bill_pay(UUID, NUMERIC, DATE, TEXT);
CREATE OR REPLACE FUNCTION public.erp_supplier_bill_pay(
  p_bill_id UUID, p_amount NUMERIC, p_date DATE, p_method TEXT, p_cash_account_id UUID DEFAULT NULL
)
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
  INSERT INTO public.erp_payments (user_id, workspace_id, payment_type, party, amount, payment_date, method, note,
                                   supplier_bill_id, cash_account_id, created_by)
  VALUES (b.user_id, b.workspace_id, 'outgoing', b.supplier_name, v_amount, v_date,
          left(COALESCE(NULLIF(btrim(p_method), ''), 'transfer'), 40),
          left('Bill ' || COALESCE(NULLIF(b.bill_no, ''), b.description), 300), b.id, p_cash_account_id, auth.uid())
  RETURNING id INTO new_id;
  PERFORM public.erp__bill_refresh(b.id);
  RETURN new_id;
END;
$$;

-- ─── 2. Bank statements ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.erp_bank_statements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  cash_account_id UUID NOT NULL REFERENCES public.erp_cash_accounts(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL DEFAULT '' CHECK (char_length(file_name) <= 200),
  bank_format TEXT NOT NULL DEFAULT 'custom' CHECK (bank_format IN ('bca', 'mandiri', 'bri', 'bni', 'custom')),
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  opening_balance NUMERIC(15, 2),
  closing_balance NUMERIC(15, 2),
  line_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  imported_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (date_from <= date_to)
);
CREATE INDEX IF NOT EXISTS idx_erp_bank_statements_account ON public.erp_bank_statements (cash_account_id, imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_erp_bank_statements_ws ON public.erp_bank_statements (workspace_id);

CREATE TABLE IF NOT EXISTS public.erp_bank_statement_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id UUID NOT NULL REFERENCES public.erp_bank_statements(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  cash_account_id UUID NOT NULL REFERENCES public.erp_cash_accounts(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  line_date DATE NOT NULL,
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  reference TEXT NOT NULL DEFAULT '' CHECK (char_length(reference) <= 100),
  amount NUMERIC(15, 2) NOT NULL CHECK (amount <> 0),
  balance NUMERIC(15, 2),
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'ignored')),
  journal_line_id UUID REFERENCES public.erp_journal_lines(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),
  matched_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  matched_at TIMESTAMPTZ,
  UNIQUE (cash_account_id, fingerprint)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_bank_lines_journal_line
  ON public.erp_bank_statement_lines (journal_line_id) WHERE journal_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_erp_bank_lines_account_date ON public.erp_bank_statement_lines (cash_account_id, line_date, line_no);
CREATE INDEX IF NOT EXISTS idx_erp_bank_lines_statement ON public.erp_bank_statement_lines (statement_id, line_no);
CREATE INDEX IF NOT EXISTS idx_erp_bank_lines_ws ON public.erp_bank_statement_lines (workspace_id);

-- The lines of an import as rows (a bad date or amount raises).
CREATE OR REPLACE FUNCTION public.erp_bank__parse(p_lines JSONB)
RETURNS TABLE (ord INTEGER, line_date DATE, description TEXT, reference TEXT, amount NUMERIC, balance NUMERIC)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT t.ord::INTEGER, (t.l ->> 'date')::DATE,
         left(regexp_replace(btrim(COALESCE(t.l ->> 'description', '')), '\s+', ' ', 'g'), 500),
         left(btrim(COALESCE(t.l ->> 'reference', '')), 100),
         round((t.l ->> 'amount')::NUMERIC, 2),
         round(NULLIF(t.l ->> 'balance', '')::NUMERIC, 2)
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS t(l, ord);
$$;

-- p: {file_name?, format?, opening_balance?, closing_balance?,
--     lines: [{date, description, reference?, amount (+ in, − out), balance?}]}
-- → {statement_id, imported, duplicates}. Lines already imported for the
-- account (same date, amount, text, reference and place among identical
-- lines of the file) are skipped, so a file can be imported twice safely.
-- Lines of 0 are left out.
CREATE OR REPLACE FUNCTION public.erp_bank_statement_import(p_workspace_id UUID, p_cash_account_id UUID, p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'payments');
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces WHERE id = ws);
  c public.erp_cash_accounts;
  v_format TEXT := COALESCE(NULLIF(p ->> 'format', ''), 'custom');
  v_count INTEGER := CASE WHEN jsonb_typeof(p -> 'lines') = 'array' THEN jsonb_array_length(p -> 'lines') ELSE 0 END;
  v_lines INTEGER;
  v_bad INTEGER;
  v_out_of_range INTEGER;
  v_from DATE;
  v_to DATE;
  v_opening NUMERIC;
  v_closing NUMERIC;
  v_statement UUID;
  v_imported INTEGER;
BEGIN
  c := public.erp_cash__account(v_owner, p_cash_account_id);
  IF v_count = 0 THEN RAISE EXCEPTION 'The statement has no lines' USING ERRCODE = '22023', HINT = 'empty'; END IF;
  IF v_count > 5000 THEN
    RAISE EXCEPTION 'Import at most 5000 lines at a time' USING ERRCODE = '22023', HINT = 'too_many';
  END IF;
  IF v_format NOT IN ('bca', 'mandiri', 'bri', 'bni', 'custom') THEN v_format := 'custom'; END IF;
  -- Ready for the first bank charge to be posted from a line.
  PERFORM public.erp_fin__account(v_owner, 'bank_charges');
  BEGIN
    SELECT count(*) FILTER (WHERE x.amount <> 0),
           count(*) FILTER (WHERE x.line_date IS NULL OR x.amount IS NULL),
           count(*) FILTER (WHERE x.line_date > CURRENT_DATE OR x.line_date < DATE '2000-01-01'),
           min(x.line_date) FILTER (WHERE x.amount <> 0), max(x.line_date) FILTER (WHERE x.amount <> 0)
      INTO v_lines, v_bad, v_out_of_range, v_from, v_to
      FROM public.erp_bank__parse(p -> 'lines') x;
    v_opening := round(NULLIF(p ->> 'opening_balance', '')::NUMERIC, 2);
    v_closing := round(NULLIF(p ->> 'closing_balance', '')::NUMERIC, 2);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'A line has an invalid date or amount' USING ERRCODE = '22023', HINT = 'invalid_line';
  END;
  IF v_bad > 0 THEN RAISE EXCEPTION 'A line has an invalid date or amount' USING ERRCODE = '22023', HINT = 'invalid_line'; END IF;
  IF v_out_of_range > 0 THEN
    RAISE EXCEPTION 'A line is dated in the future or before 2000' USING ERRCODE = '22023', HINT = 'date_range';
  END IF;
  IF v_lines = 0 THEN RAISE EXCEPTION 'The statement has no lines' USING ERRCODE = '22023', HINT = 'empty'; END IF;

  INSERT INTO public.erp_bank_statements
    (user_id, workspace_id, cash_account_id, file_name, bank_format, date_from, date_to, opening_balance, closing_balance, imported_by)
  VALUES (v_owner, ws, c.id, left(COALESCE(p ->> 'file_name', ''), 200), v_format, v_from, v_to, v_opening, v_closing, auth.uid())
  RETURNING id INTO v_statement;

  WITH numbered AS (
    SELECT x.*, row_number() OVER (PARTITION BY x.line_date, x.amount, lower(x.description), x.reference ORDER BY x.ord) AS occurrence
      FROM public.erp_bank__parse(p -> 'lines') x
     WHERE x.amount <> 0
  ), inserted AS (
    INSERT INTO public.erp_bank_statement_lines
      (statement_id, user_id, workspace_id, cash_account_id, line_no, line_date, description, reference, amount, balance, fingerprint)
    SELECT v_statement, v_owner, ws, c.id, n.ord, n.line_date, n.description, n.reference, n.amount, n.balance,
           md5(concat_ws('|', n.line_date, n.amount, lower(n.description), n.reference, n.occurrence))
      FROM numbered n
     ORDER BY n.ord
    ON CONFLICT (cash_account_id, fingerprint) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_imported FROM inserted;

  IF v_imported = 0 THEN
    DELETE FROM public.erp_bank_statements WHERE id = v_statement;
    RETURN jsonb_build_object('statement_id', NULL, 'imported', 0, 'duplicates', v_lines);
  END IF;
  UPDATE public.erp_bank_statements SET line_count = v_imported, duplicate_count = v_lines - v_imported
   WHERE id = v_statement;
  RETURN jsonb_build_object('statement_id', v_statement, 'imported', v_imported, 'duplicates', v_lines - v_imported);
END;
$$;

-- A statement and its lines, when none of them is matched yet.
CREATE OR REPLACE FUNCTION public.erp_bank_statement_delete(p_statement_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s public.erp_bank_statements%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.erp_bank_statements WHERE id = p_statement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found' USING ERRCODE = '42501'; END IF;
  PERFORM public.erp__resolve_workspace(s.workspace_id, 'payments');
  IF EXISTS (SELECT 1 FROM public.erp_bank_statement_lines WHERE statement_id = s.id AND status = 'matched') THEN
    RAISE EXCEPTION 'Unmatch its lines before deleting this statement' USING ERRCODE = 'P0001', HINT = 'matched';
  END IF;
  DELETE FROM public.erp_bank_statements WHERE id = s.id;
END;
$$;

-- Ledger lines of the account a bank line could be: same amount, within
-- p_days, not yet matched, not voided (nor a void).
CREATE OR REPLACE FUNCTION public.erp_bank__candidates(p_line public.erp_bank_statement_lines, p_days INTEGER)
RETURNS TABLE (journal_line_id UUID, entry_id UUID, entry_no INTEGER, entry_date DATE, memo TEXT,
               source_type TEXT, amount NUMERIC, days_apart INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.id, e.id, e.entry_no, e.entry_date, COALESCE(NULLIF(l.memo, ''), e.memo), e.source_type,
         (l.debit - l.credit)::NUMERIC, abs(e.entry_date - p_line.line_date)::INTEGER
    FROM public.erp_cash_accounts c
    JOIN public.erp_journal_lines l ON l.account_id = c.gl_account_id
    JOIN public.erp_journal_entries e ON e.id = l.entry_id
   WHERE c.id = p_line.cash_account_id
     AND l.debit - l.credit = p_line.amount
     AND e.entry_date BETWEEN p_line.line_date - p_days AND p_line.line_date + p_days
     AND e.reverses_entry_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.erp_journal_entries r WHERE r.reverses_entry_id = e.id)
     AND NOT EXISTS (SELECT 1 FROM public.erp_bank_statement_lines s WHERE s.journal_line_id = l.id)
   ORDER BY abs(e.entry_date - p_line.line_date), e.entry_date, e.entry_no
   LIMIT 20;
$$;

CREATE OR REPLACE FUNCTION public.erp_bank__line(p_line_id UUID)
RETURNS public.erp_bank_statement_lines
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s public.erp_bank_statement_lines%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.erp_bank_statement_lines WHERE id = p_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Statement line not found' USING ERRCODE = '42501'; END IF;
  PERFORM public.erp__resolve_workspace(s.workspace_id, 'payments');
  RETURN s;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_bank_line_candidates(p_line_id UUID)
RETURNS TABLE (journal_line_id UUID, entry_id UUID, entry_no INTEGER, entry_date DATE, memo TEXT,
               source_type TEXT, amount NUMERIC, days_apart INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s public.erp_bank_statement_lines;
BEGIN
  s := public.erp_bank__line(p_line_id);
  RETURN QUERY SELECT * FROM public.erp_bank__candidates(s, 31);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_bank_line_match(p_line_id UUID, p_journal_line_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s public.erp_bank_statement_lines;
BEGIN
  s := public.erp_bank__line(p_line_id);
  IF s.status = 'matched' THEN RAISE EXCEPTION 'This line is already matched' USING ERRCODE = 'P0001', HINT = 'matched'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.erp_bank__candidates(s, 366) x WHERE x.journal_line_id = p_journal_line_id) THEN
    RAISE EXCEPTION 'Match a ledger line of this account with the same amount that is not matched yet'
      USING ERRCODE = 'P0001', HINT = 'not_candidate';
  END IF;
  UPDATE public.erp_bank_statement_lines
     SET status = 'matched', journal_line_id = p_journal_line_id, matched_by = auth.uid(), matched_at = now()
   WHERE id = s.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_bank_line_unmatch(p_line_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s public.erp_bank_statement_lines;
BEGIN
  s := public.erp_bank__line(p_line_id);
  UPDATE public.erp_bank_statement_lines
     SET status = 'open', journal_line_id = NULL, note = '', matched_by = NULL, matched_at = NULL
   WHERE id = s.id;
END;
$$;

-- Lines that are not in the ledger and need not be (a duplicate the bank
-- itself reversed, a line from before the books started).
CREATE OR REPLACE FUNCTION public.erp_bank_line_ignore(p_line_id UUID, p_note TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s public.erp_bank_statement_lines;
BEGIN
  s := public.erp_bank__line(p_line_id);
  IF s.status = 'matched' THEN RAISE EXCEPTION 'Unmatch this line first' USING ERRCODE = 'P0001', HINT = 'matched'; END IF;
  IF btrim(COALESCE(p_note, '')) = '' THEN
    RAISE EXCEPTION 'Say why this line is not in the books' USING ERRCODE = '22023', HINT = 'note';
  END IF;
  UPDATE public.erp_bank_statement_lines
     SET status = 'ignored', note = left(btrim(p_note), 300), matched_by = auth.uid(), matched_at = now()
   WHERE id = s.id;
END;
$$;

-- A line that is not in the books yet (bank charges, interest, a transfer
-- nobody recorded): posted against p_account_id and matched at once.
CREATE OR REPLACE FUNCTION public.erp_bank_line_post(p_line_id UUID, p_account_id UUID, p_memo TEXT DEFAULT '')
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.erp_bank_statement_lines;
  c public.erp_cash_accounts%ROWTYPE;
  v_amount NUMERIC;
  v_entry UUID;
  v_line UUID;
BEGIN
  s := public.erp_bank__line(p_line_id);
  IF s.status <> 'open' THEN RAISE EXCEPTION 'Only an open line can be posted' USING ERRCODE = 'P0001', HINT = 'not_open'; END IF;
  SELECT * INTO c FROM public.erp_cash_accounts WHERE id = s.cash_account_id;
  IF p_account_id = c.gl_account_id OR NOT EXISTS (
    SELECT 1 FROM public.erp_gl_accounts a WHERE a.id = p_account_id AND a.user_id = s.user_id AND a.is_active
  ) THEN
    RAISE EXCEPTION 'Choose another active account of this ledger' USING ERRCODE = 'P0001', HINT = 'account';
  END IF;
  v_amount := abs(s.amount);
  v_entry := public.erp_gl__post(s.user_id, s.line_date,
    COALESCE(NULLIF(left(btrim(p_memo), 300), ''), NULLIF(s.description, ''), 'Bank statement line'),
    'bank_line', s.id, 'bank_line:' || s.id,
    CASE WHEN s.amount > 0 THEN jsonb_build_array(
        jsonb_build_object('account_id', c.gl_account_id, 'debit', v_amount, 'credit', 0),
        jsonb_build_object('account_id', p_account_id, 'debit', 0, 'credit', v_amount))
      ELSE jsonb_build_array(
        jsonb_build_object('account_id', p_account_id, 'debit', v_amount, 'credit', 0),
        jsonb_build_object('account_id', c.gl_account_id, 'debit', 0, 'credit', v_amount)) END);
  SELECT l.id INTO v_line FROM public.erp_journal_lines l
   WHERE l.entry_id = v_entry AND l.account_id = c.gl_account_id
     AND NOT EXISTS (SELECT 1 FROM public.erp_bank_statement_lines x WHERE x.journal_line_id = l.id)
   LIMIT 1;
  IF v_line IS NULL THEN RAISE EXCEPTION 'This line was posted and its entry is matched elsewhere' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.erp_bank_statement_lines
     SET status = 'matched', journal_line_id = v_line, matched_by = auth.uid(), matched_at = now()
   WHERE id = s.id;
  RETURN v_entry;
END;
$$;

-- Matches every open line of the account that has exactly one ledger line
-- with its amount within three days. Returns how many were matched.
CREATE OR REPLACE FUNCTION public.erp_bank_auto_match(p_workspace_id UUID, p_cash_account_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'payments');
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces WHERE id = ws);
  s public.erp_bank_statement_lines%ROWTYPE;
  found_ids UUID[];
  n INTEGER := 0;
BEGIN
  PERFORM public.erp_cash__account(v_owner, p_cash_account_id);
  FOR s IN SELECT * FROM public.erp_bank_statement_lines
            WHERE cash_account_id = p_cash_account_id AND status = 'open'
            ORDER BY line_date, line_no FOR UPDATE LOOP
    SELECT array_agg(x.journal_line_id) INTO found_ids FROM public.erp_bank__candidates(s, 3) x;
    IF COALESCE(array_length(found_ids, 1), 0) = 1 THEN
      UPDATE public.erp_bank_statement_lines
         SET status = 'matched', journal_line_id = found_ids[1], matched_by = auth.uid(), matched_at = now()
       WHERE id = s.id;
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END;
$$;

-- Where the account stands on p_as_of: the ledger balance, the bank's last
-- balance, and what explains the difference (lines on one side only, from
-- the first statement line on).
CREATE OR REPLACE FUNCTION public.erp_bank_reconciliation(p_workspace_id UUID, p_cash_account_id UUID, p_as_of DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_fin__read(p_workspace_id);
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces WHERE id = ws);
  c public.erp_cash_accounts%ROWTYPE;
  v_as_of DATE := COALESCE(p_as_of, CURRENT_DATE);
  v_first DATE;
  v_ledger NUMERIC;
  v_bank NUMERIC;
  v_bank_date DATE;
  v_open_count INTEGER;
  v_open_sum NUMERIC;
  v_unmatched_count INTEGER;
  v_unmatched_sum NUMERIC;
BEGIN
  SELECT * INTO c FROM public.erp_cash_accounts WHERE id = p_cash_account_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found' USING ERRCODE = '42501'; END IF;
  SELECT min(line_date) INTO v_first FROM public.erp_bank_statement_lines WHERE cash_account_id = c.id;
  SELECT COALESCE(sum(l.debit - l.credit), 0) INTO v_ledger
    FROM public.erp_journal_lines l JOIN public.erp_journal_entries e ON e.id = l.entry_id
   WHERE l.account_id = c.gl_account_id AND e.entry_date <= v_as_of;
  SELECT s.balance, s.line_date INTO v_bank, v_bank_date FROM public.erp_bank_statement_lines s
   WHERE s.cash_account_id = c.id AND s.balance IS NOT NULL AND s.line_date <= v_as_of
   ORDER BY s.line_date DESC, (SELECT st.imported_at FROM public.erp_bank_statements st WHERE st.id = s.statement_id) DESC,
            s.line_no DESC
   LIMIT 1;
  SELECT count(*), COALESCE(sum(amount), 0) INTO v_open_count, v_open_sum
    FROM public.erp_bank_statement_lines WHERE cash_account_id = c.id AND status = 'open' AND line_date <= v_as_of;
  SELECT count(*), COALESCE(sum(l.debit - l.credit), 0) INTO v_unmatched_count, v_unmatched_sum
    FROM public.erp_journal_lines l JOIN public.erp_journal_entries e ON e.id = l.entry_id
   WHERE l.account_id = c.gl_account_id AND v_first IS NOT NULL
     AND e.entry_date BETWEEN v_first AND v_as_of
     AND NOT EXISTS (SELECT 1 FROM public.erp_bank_statement_lines s WHERE s.journal_line_id = l.id)
     AND e.reverses_entry_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.erp_journal_entries r WHERE r.reverses_entry_id = e.id);
  RETURN jsonb_build_object(
    'as_of', v_as_of,
    'first_line_date', v_first,
    'ledger_balance', v_ledger,
    'bank_balance', v_bank,
    'bank_balance_date', v_bank_date,
    'open_lines', v_open_count,
    'open_lines_total', v_open_sum,
    'unmatched_ledger', v_unmatched_count,
    'unmatched_ledger_total', v_unmatched_sum,
    -- Bank = ledger + bank lines not in the books − book lines not at the bank.
    'difference', CASE WHEN v_bank IS NULL THEN NULL ELSE v_bank - (v_ledger + v_open_sum - v_unmatched_sum) END);
END;
$$;

-- Ledger lines of the account in a period that no bank line is matched to.
CREATE OR REPLACE FUNCTION public.erp_bank_unmatched_ledger(p_workspace_id UUID, p_cash_account_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (journal_line_id UUID, entry_no INTEGER, entry_date DATE, memo TEXT, source_type TEXT, amount NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_fin__read(p_workspace_id);
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces w WHERE w.id = ws);
BEGIN
  RETURN QUERY
  SELECT l.id, e.entry_no, e.entry_date, COALESCE(NULLIF(l.memo, ''), e.memo), e.source_type, (l.debit - l.credit)::NUMERIC
    FROM public.erp_cash_accounts c
    JOIN public.erp_journal_lines l ON l.account_id = c.gl_account_id
    JOIN public.erp_journal_entries e ON e.id = l.entry_id
   WHERE c.id = p_cash_account_id AND c.user_id = v_owner
     AND e.entry_date BETWEEN p_from AND p_to
     AND e.reverses_entry_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.erp_journal_entries r WHERE r.reverses_entry_id = e.id)
     AND NOT EXISTS (SELECT 1 FROM public.erp_bank_statement_lines s WHERE s.journal_line_id = l.id)
   ORDER BY e.entry_date, e.entry_no
   LIMIT 1000;
END;
$$;

-- ─── 3. Fixed assets ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.erp_fixed_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  asset_no TEXT NOT NULL DEFAULT '' CHECK (char_length(asset_no) <= 40),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('land', 'building', 'vehicle', 'heavy_equipment', 'machinery', 'office', 'other')),
  -- The machine in the equipment module, if any. No foreign key: the
  -- equipment module can be rolled back on its own (checked on create).
  equipment_id UUID,
  acquisition_date DATE NOT NULL,
  cost NUMERIC(15, 2) NOT NULL CHECK (cost > 0),
  salvage_value NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),
  useful_life_months INTEGER NOT NULL CHECK (useful_life_months BETWEEN 1 AND 600),
  method TEXT NOT NULL CHECK (method IN ('straight_line', 'declining_balance', 'none')),
  declining_rate NUMERIC(6, 2) CHECK (declining_rate IS NULL OR declining_rate BETWEEN 0.01 AND 100),
  depreciation_start DATE NOT NULL CHECK (depreciation_start = date_trunc('month', depreciation_start)::DATE),
  prior_months INTEGER NOT NULL DEFAULT 0 CHECK (prior_months >= 0),
  prior_accumulated NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (prior_accumulated >= 0),
  funding TEXT NOT NULL CHECK (funding IN ('cash', 'payable', 'opening', 'recorded')),
  cash_account_id UUID REFERENCES public.erp_cash_accounts(id) ON DELETE SET NULL,
  asset_account_id UUID NOT NULL REFERENCES public.erp_gl_accounts(id) ON DELETE CASCADE,
  accum_account_id UUID NOT NULL REFERENCES public.erp_gl_accounts(id) ON DELETE CASCADE,
  expense_account_id UUID NOT NULL REFERENCES public.erp_gl_accounts(id) ON DELETE CASCADE,
  accumulated NUMERIC(15, 2) NOT NULL DEFAULT 0,
  depreciated_through DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed', 'void')),
  disposed_on DATE,
  disposal_proceeds NUMERIC(15, 2),
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (salvage_value < cost),
  CHECK (prior_accumulated <= cost - salvage_value),
  CHECK (accumulated >= 0 AND accumulated <= cost - salvage_value),
  CHECK (method <> 'declining_balance' OR declining_rate IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_erp_fixed_assets_ws ON public.erp_fixed_assets (workspace_id, status, acquisition_date);
CREATE INDEX IF NOT EXISTS idx_erp_fixed_assets_equipment ON public.erp_fixed_assets (equipment_id) WHERE equipment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.erp_fixed_asset_depreciation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES public.erp_fixed_assets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  period DATE NOT NULL CHECK (period = date_trunc('month', period)::DATE),
  amount NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
  journal_entry_id UUID REFERENCES public.erp_journal_entries(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, period)
);
CREATE INDEX IF NOT EXISTS idx_erp_fa_depreciation_ws ON public.erp_fixed_asset_depreciation (workspace_id, period);

-- One month's depreciation after p_done months with p_accumulated taken.
-- The last month of the life takes what is left down to the salvage value.
CREATE OR REPLACE FUNCTION public.erp_fa__amount(p public.erp_fixed_assets, p_done INTEGER, p_accumulated NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p.method = 'none' OR p_done >= p.useful_life_months OR p.cost - p.salvage_value - p_accumulated <= 0 THEN 0
    WHEN p_done = p.useful_life_months - 1 THEN p.cost - p.salvage_value - p_accumulated
    WHEN p.method = 'straight_line' THEN
      LEAST(round((p.cost - p.salvage_value) / p.useful_life_months, 2), p.cost - p.salvage_value - p_accumulated)
    ELSE
      LEAST(round((p.cost - p_accumulated) * p.declining_rate / 1200, 2), p.cost - p.salvage_value - p_accumulated)
  END;
$$;

-- Posts the months not posted yet, through p_through (a first of month).
-- Returns {months, amount}.
CREATE OR REPLACE FUNCTION public.erp_fa__run(p_asset_id UUID, p_through DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a public.erp_fixed_assets%ROWTYPE;
  m DATE;
  done INTEGER;
  acc NUMERIC;
  amt NUMERIC;
  v_entry UUID;
  n INTEGER := 0;
  total NUMERIC := 0;
BEGIN
  SELECT * INTO a FROM public.erp_fixed_assets WHERE id = p_asset_id FOR UPDATE;
  IF a.status <> 'active' OR a.method = 'none' THEN RETURN jsonb_build_object('months', 0, 'amount', 0); END IF;
  m := COALESCE((a.depreciated_through + INTERVAL '1 month')::DATE, a.depreciation_start);
  done := a.prior_months + (SELECT count(*)::INTEGER FROM public.erp_fixed_asset_depreciation WHERE asset_id = a.id);
  acc := a.accumulated;
  WHILE m <= p_through LOOP
    amt := public.erp_fa__amount(a, done, acc);
    EXIT WHEN amt <= 0;
    v_entry := public.erp_gl__post(a.user_id, (m + INTERVAL '1 month - 1 day')::DATE,
      'Depreciation ' || to_char(m, 'YYYY-MM') || ': ' || a.name, 'depreciation', a.id,
      'depreciation:' || a.id || ':' || to_char(m, 'YYYY-MM'),
      jsonb_build_array(
        jsonb_build_object('account_id', a.expense_account_id, 'debit', amt, 'credit', 0),
        jsonb_build_object('account_id', a.accum_account_id, 'debit', 0, 'credit', amt)));
    INSERT INTO public.erp_fixed_asset_depreciation (asset_id, user_id, workspace_id, period, amount, journal_entry_id)
    VALUES (a.id, a.user_id, a.workspace_id, m, amt, v_entry);
    acc := acc + amt;
    done := done + 1;
    n := n + 1;
    total := total + amt;
    m := (m + INTERVAL '1 month')::DATE;
  END LOOP;
  IF n > 0 THEN
    UPDATE public.erp_fixed_assets
       SET accumulated = acc, depreciated_through = (m - INTERVAL '1 month')::DATE
     WHERE id = a.id;
  END IF;
  RETURN jsonb_build_object('months', n, 'amount', total);
END;
$$;

-- p: {name, asset_no?, category?, equipment_id?, acquisition_date, cost,
--     salvage_value?, useful_life_months, method, declining_rate?,
--     depreciation_start? (YYYY-MM-01, default the acquisition month),
--     prior_months?, prior_accumulated?, funding, cash_account_id?,
--     asset_account_id?, note?}
-- funding: cash (paid from a cash account), payable (owed to the seller),
-- opening (owned before the books started: against Opening balance equity,
-- with the depreciation already taken), recorded (already in the ledger,
-- e.g. through a supplier bill on the asset account: nothing is posted).
CREATE OR REPLACE FUNCTION public.erp_fixed_asset_create(p_workspace_id UUID, p JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'payments');
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces WHERE id = ws);
  v_name TEXT := left(btrim(COALESCE(p ->> 'name', '')), 200);
  v_category TEXT := COALESCE(NULLIF(p ->> 'category', ''), 'other');
  v_method TEXT := COALESCE(NULLIF(p ->> 'method', ''), 'straight_line');
  v_funding TEXT := COALESCE(NULLIF(p ->> 'funding', ''), 'cash');
  v_date DATE;
  v_cost NUMERIC;
  v_salvage NUMERIC;
  v_life INTEGER;
  v_rate NUMERIC;
  v_start DATE;
  v_prior_months INTEGER;
  v_prior_acc NUMERIC;
  v_equipment UUID;
  v_asset_account UUID;
  v_cash public.erp_cash_accounts;
  v_lock DATE;
  v_credit UUID;
  lines JSONB;
  new_id UUID;
BEGIN
  BEGIN
    v_date := (p ->> 'acquisition_date')::DATE;
    v_cost := round((p ->> 'cost')::NUMERIC, 2);
    v_salvage := round(COALESCE(NULLIF(p ->> 'salvage_value', '')::NUMERIC, 0), 2);
    v_life := (p ->> 'useful_life_months')::INTEGER;
    v_rate := round(NULLIF(p ->> 'declining_rate', '')::NUMERIC, 2);
    v_start := date_trunc('month', COALESCE(NULLIF(p ->> 'depreciation_start', '')::DATE, v_date))::DATE;
    v_prior_months := COALESCE(NULLIF(p ->> 'prior_months', '')::INTEGER, 0);
    v_prior_acc := round(COALESCE(NULLIF(p ->> 'prior_accumulated', '')::NUMERIC, 0), 2);
    v_equipment := NULLIF(p ->> 'equipment_id', '')::UUID;
    v_asset_account := NULLIF(p ->> 'asset_account_id', '')::UUID;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid asset' USING ERRCODE = '22023';
  END;
  IF v_name = '' OR v_date IS NULL THEN
    RAISE EXCEPTION 'Enter the name and the acquisition date' USING ERRCODE = '22023', HINT = 'required';
  END IF;
  IF v_date > CURRENT_DATE THEN RAISE EXCEPTION 'The date cannot be in the future' USING ERRCODE = '22023', HINT = 'future'; END IF;
  IF v_category NOT IN ('land', 'building', 'vehicle', 'heavy_equipment', 'machinery', 'office', 'other')
     OR v_method NOT IN ('straight_line', 'declining_balance', 'none')
     OR v_funding NOT IN ('cash', 'payable', 'opening', 'recorded') THEN
    RAISE EXCEPTION 'Invalid asset' USING ERRCODE = '22023';
  END IF;
  IF v_cost IS NULL OR v_cost <= 0 OR v_salvage < 0 OR v_salvage >= v_cost THEN
    RAISE EXCEPTION 'The cost must be positive and the salvage value below it' USING ERRCODE = '22023', HINT = 'amounts';
  END IF;
  IF v_life IS NULL OR v_life < 1 OR v_life > 600 THEN
    RAISE EXCEPTION 'The useful life is 1 to 600 months' USING ERRCODE = '22023', HINT = 'life';
  END IF;
  IF v_method = 'declining_balance' THEN
    -- Double the straight-line rate unless one is given (the Indonesian tax
    -- groups: 4 years 50%, 8 years 25%, 16 years 12.5%, 20 years 10%).
    v_rate := COALESCE(v_rate, round(2400.0 / v_life, 2));
    IF v_rate <= 0 OR v_rate > 100 THEN
      RAISE EXCEPTION 'The declining rate is a yearly percentage up to 100' USING ERRCODE = '22023', HINT = 'rate';
    END IF;
  ELSE
    v_rate := NULL;
  END IF;
  IF v_prior_months < 0 OR v_prior_months > v_life OR v_prior_acc < 0 OR v_prior_acc > v_cost - v_salvage THEN
    RAISE EXCEPTION 'The depreciation already taken does not fit the life or the cost' USING ERRCODE = '22023', HINT = 'prior';
  END IF;
  IF v_funding IN ('cash', 'payable') AND (v_prior_months > 0 OR v_prior_acc > 0) THEN
    RAISE EXCEPTION 'An asset bought now has no depreciation taken yet; use "owned before" for that'
      USING ERRCODE = '22023', HINT = 'prior_new';
  END IF;
  IF v_start < date_trunc('month', v_date)::DATE THEN
    RAISE EXCEPTION 'Depreciation cannot start before the asset was acquired' USING ERRCODE = '22023', HINT = 'start';
  END IF;
  SELECT lock_date INTO v_lock FROM public.erp_accounting_settings WHERE user_id = v_owner;
  IF v_method <> 'none' AND v_lock IS NOT NULL AND (v_start + INTERVAL '1 month - 1 day')::DATE <= v_lock THEN
    RAISE EXCEPTION 'Depreciation would start in a closed period (through %); enter the depreciation already taken and start after it', v_lock
      USING ERRCODE = 'P0001', HINT = 'closed';
  END IF;
  IF v_equipment IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.erp_equipment WHERE id = v_equipment AND workspace_id = ws) THEN
    RAISE EXCEPTION 'Equipment not found' USING ERRCODE = 'P0001', HINT = 'equipment';
  END IF;
  IF v_asset_account IS NULL THEN
    v_asset_account := public.erp_fin__account(v_owner, 'fixed_assets');
  ELSIF NOT EXISTS (SELECT 1 FROM public.erp_gl_accounts a WHERE a.id = v_asset_account AND a.user_id = v_owner
                       AND a.account_type = 'asset' AND a.is_active
                       AND NOT EXISTS (SELECT 1 FROM public.erp_cash_accounts c WHERE c.gl_account_id = a.id)) THEN
    RAISE EXCEPTION 'Choose an active asset account' USING ERRCODE = 'P0001', HINT = 'account';
  END IF;
  IF v_funding = 'cash' THEN
    v_cash := public.erp_cash__account(v_owner,
      COALESCE(NULLIF(p ->> 'cash_account_id', '')::UUID, public.erp_cash__ensure(v_owner, ws)));
  END IF;

  INSERT INTO public.erp_fixed_assets (
    user_id, workspace_id, asset_no, name, category, equipment_id, acquisition_date, cost, salvage_value,
    useful_life_months, method, declining_rate, depreciation_start, prior_months, prior_accumulated,
    funding, cash_account_id, asset_account_id, accum_account_id, expense_account_id, accumulated, note, created_by)
  VALUES (
    v_owner, ws, left(btrim(COALESCE(p ->> 'asset_no', '')), 40), v_name, v_category, v_equipment, v_date, v_cost, v_salvage,
    v_life, v_method, v_rate, v_start, v_prior_months, v_prior_acc,
    v_funding, v_cash.id, v_asset_account, public.erp_fin__account(v_owner, 'accum_depreciation'),
    public.erp_fin__account(v_owner, 'depreciation'), v_prior_acc, left(btrim(COALESCE(p ->> 'note', '')), 500), auth.uid())
  RETURNING id INTO new_id;

  IF v_funding <> 'recorded' THEN
    v_credit := CASE v_funding
      WHEN 'cash' THEN v_cash.gl_account_id
      WHEN 'payable' THEN public.erp_gl__account(v_owner, 'ap')
      ELSE public.erp_gl__account(v_owner, 'opening') END;
    lines := jsonb_build_array(
      jsonb_build_object('account_id', v_asset_account, 'debit', v_cost, 'credit', 0),
      jsonb_build_object('account_id', v_credit, 'debit', 0, 'credit', v_cost));
    IF v_prior_acc > 0 THEN
      lines := lines || jsonb_build_array(
        jsonb_build_object('account_id', v_credit, 'debit', v_prior_acc, 'credit', 0, 'memo', 'Depreciation already taken'),
        jsonb_build_object('account_id', public.erp_fin__account(v_owner, 'accum_depreciation'), 'debit', 0, 'credit', v_prior_acc,
                           'memo', 'Depreciation already taken'));
    END IF;
    PERFORM public.erp_gl__post(v_owner, v_date, 'Fixed asset: ' || v_name, 'asset_acquisition', new_id, 'asset:' || new_id, lines);
  END IF;
  RETURN new_id;
END;
$$;

-- An asset entered by mistake: only before any depreciation is posted.
CREATE OR REPLACE FUNCTION public.erp_fixed_asset_void(p_asset_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE a public.erp_fixed_assets%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.erp_fixed_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Asset not found' USING ERRCODE = '42501'; END IF;
  PERFORM public.erp__resolve_workspace(a.workspace_id, 'payments');
  IF a.status <> 'active' THEN RAISE EXCEPTION 'Only an active asset can be voided' USING ERRCODE = 'P0001', HINT = 'not_active'; END IF;
  IF EXISTS (SELECT 1 FROM public.erp_fixed_asset_depreciation WHERE asset_id = a.id) THEN
    RAISE EXCEPTION 'Depreciation is posted for this asset; dispose of it instead' USING ERRCODE = 'P0001', HINT = 'depreciated';
  END IF;
  IF btrim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION 'Enter a reason' USING ERRCODE = '22023', HINT = 'reason'; END IF;
  IF EXISTS (SELECT 1 FROM public.erp_journal_entries WHERE user_id = a.user_id AND source_key = 'asset:' || a.id) THEN
    PERFORM public.erp_gl__reverse(a.user_id, 'asset:' || a.id, CURRENT_DATE, 'Void of fixed asset: ' || a.name,
      'asset_acquisition_void', a.id, 'asset_void:' || a.id);
  END IF;
  UPDATE public.erp_fixed_assets SET status = 'void', note = left(btrim(p_reason), 500) WHERE id = a.id;
END;
$$;

-- Posts depreciation for every active asset through the month of p_through.
CREATE OR REPLACE FUNCTION public.erp_fixed_assets_depreciate(p_workspace_id UUID, p_through DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'payments');
  v_month DATE := date_trunc('month', COALESCE(p_through, CURRENT_DATE))::DATE;
  a_id UUID;
  r JSONB;
  v_assets INTEGER := 0;
  v_months INTEGER := 0;
  v_amount NUMERIC := 0;
BEGIN
  IF v_month > date_trunc('month', CURRENT_DATE)::DATE THEN
    RAISE EXCEPTION 'Depreciation can be posted up to the current month' USING ERRCODE = '22023', HINT = 'future';
  END IF;
  FOR a_id IN SELECT id FROM public.erp_fixed_assets
               WHERE workspace_id = ws AND status = 'active' AND method <> 'none'
               ORDER BY acquisition_date, created_at LOOP
    r := public.erp_fa__run(a_id, v_month);
    IF (r ->> 'months')::INTEGER > 0 THEN
      v_assets := v_assets + 1;
      v_months := v_months + (r ->> 'months')::INTEGER;
      v_amount := v_amount + (r ->> 'amount')::NUMERIC;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('assets', v_assets, 'months', v_months, 'amount', v_amount);
END;
$$;

-- Sold or scrapped on p_date for p_proceeds (into p_cash_account_id, or the
-- default account): depreciation through that month first, then the asset
-- leaves the books with a gain or a loss.
CREATE OR REPLACE FUNCTION public.erp_fixed_asset_dispose(
  p_asset_id UUID, p_date DATE, p_proceeds NUMERIC, p_cash_account_id UUID DEFAULT NULL, p_note TEXT DEFAULT ''
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a public.erp_fixed_assets%ROWTYPE;
  v_date DATE := COALESCE(p_date, CURRENT_DATE);
  v_proceeds NUMERIC := round(COALESCE(p_proceeds, 0), 2);
  v_cash public.erp_cash_accounts;
  v_gain NUMERIC;
  lines JSONB;
  v_entry UUID;
BEGIN
  SELECT * INTO a FROM public.erp_fixed_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Asset not found' USING ERRCODE = '42501'; END IF;
  PERFORM public.erp__resolve_workspace(a.workspace_id, 'payments');
  IF a.status <> 'active' THEN RAISE EXCEPTION 'Only an active asset can be disposed of' USING ERRCODE = 'P0001', HINT = 'not_active'; END IF;
  IF v_date > CURRENT_DATE OR v_date < a.acquisition_date THEN
    RAISE EXCEPTION 'The date must be between the acquisition and today' USING ERRCODE = '22023', HINT = 'date';
  END IF;
  IF a.depreciated_through IS NOT NULL AND a.depreciated_through > date_trunc('month', v_date)::DATE THEN
    RAISE EXCEPTION 'Depreciation is posted after this date' USING ERRCODE = 'P0001', HINT = 'depreciated_after';
  END IF;
  IF v_proceeds < 0 THEN RAISE EXCEPTION 'The proceeds cannot be negative' USING ERRCODE = '22023', HINT = 'amount'; END IF;
  IF v_proceeds > 0 THEN
    v_cash := public.erp_cash__account(a.user_id, COALESCE(p_cash_account_id, public.erp_cash__ensure(a.user_id, a.workspace_id)));
  END IF;

  PERFORM public.erp_fa__run(a.id, date_trunc('month', v_date)::DATE);
  SELECT * INTO a FROM public.erp_fixed_assets WHERE id = a.id;
  v_gain := v_proceeds - (a.cost - a.accumulated);
  lines := jsonb_build_array(
    jsonb_build_object('account_id', a.accum_account_id, 'debit', a.accumulated, 'credit', 0),
    jsonb_build_object('account_id', v_cash.gl_account_id, 'debit', v_proceeds, 'credit', 0),
    jsonb_build_object('account_id', a.asset_account_id, 'debit', 0, 'credit', a.cost));
  IF v_gain > 0 THEN
    lines := lines || jsonb_build_array(jsonb_build_object('account_id', public.erp_fin__account(a.user_id, 'disposal_gain'), 'debit', 0, 'credit', v_gain));
  ELSIF v_gain < 0 THEN
    lines := lines || jsonb_build_array(jsonb_build_object('account_id', public.erp_fin__account(a.user_id, 'disposal_loss'), 'debit', -v_gain, 'credit', 0));
  END IF;
  -- Lines of 0 (nothing accumulated, no proceeds) are skipped by the posting.
  SELECT jsonb_agg(l) INTO lines FROM jsonb_array_elements(lines) l WHERE l ->> 'account_id' IS NOT NULL;
  v_entry := public.erp_gl__post(a.user_id, v_date, 'Disposal of ' || a.name, 'asset_disposal', a.id, 'asset_disposal:' || a.id, lines);
  UPDATE public.erp_fixed_assets
     SET status = 'disposed', disposed_on = v_date, disposal_proceeds = v_proceeds,
         note = CASE WHEN btrim(COALESCE(p_note, '')) = '' THEN note ELSE left(btrim(p_note), 500) END
   WHERE id = a.id;
  RETURN v_entry;
END;
$$;

-- The asset's months: posted ones, then the plan to the end of its life.
CREATE OR REPLACE FUNCTION public.erp_fixed_asset_schedule(p_asset_id UUID)
RETURNS TABLE (period DATE, amount NUMERIC, accumulated NUMERIC, book_value NUMERIC, posted BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a public.erp_fixed_assets%ROWTYPE;
  r RECORD;
  m DATE;
  done INTEGER;
  acc NUMERIC;
  amt NUMERIC;
  guard INTEGER := 0;
BEGIN
  SELECT * INTO a FROM public.erp_fixed_assets WHERE id = p_asset_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Asset not found' USING ERRCODE = '42501'; END IF;
  PERFORM public.erp_fin__read(a.workspace_id);
  acc := a.prior_accumulated;
  FOR r IN SELECT d.period, d.amount FROM public.erp_fixed_asset_depreciation d WHERE d.asset_id = a.id ORDER BY d.period LOOP
    acc := acc + r.amount;
    period := r.period; amount := r.amount; accumulated := acc; book_value := a.cost - acc; posted := true;
    RETURN NEXT;
  END LOOP;
  IF a.status <> 'active' THEN RETURN; END IF;
  m := COALESCE((a.depreciated_through + INTERVAL '1 month')::DATE, a.depreciation_start);
  done := a.prior_months + (SELECT count(*)::INTEGER FROM public.erp_fixed_asset_depreciation d WHERE d.asset_id = a.id);
  LOOP
    amt := public.erp_fa__amount(a, done, acc);
    EXIT WHEN amt <= 0 OR guard >= 600;
    acc := acc + amt;
    done := done + 1;
    guard := guard + 1;
    period := m; amount := amt; accumulated := acc; book_value := a.cost - acc; posted := false;
    RETURN NEXT;
    m := (m + INTERVAL '1 month')::DATE;
  END LOOP;
END;
$$;

-- ─── Triggers, row-level security ────────────────────────────────────────────

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['erp_cash_accounts', 'erp_bank_statements', 'erp_bank_statement_lines',
                           'erp_fixed_assets', 'erp_fixed_asset_depreciation'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_erp_assign_workspace ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_erp_assign_workspace BEFORE INSERT OR UPDATE ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION public.erp_assign_workspace()', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_member_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
                      USING (workspace_id IS NOT NULL AND public.erp_can_read(workspace_id, ''payments''))', t || '_member_read', t);
    EXECUTE format('DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.%I', t);
    EXECUTE format('CREATE POLICY erp_workspace_not_suspended ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
                      USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))
                      WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))', t);
  END LOOP;
  -- Matching every statement line would flood the audit log; the documents are audited.
  FOREACH t IN ARRAY ARRAY['erp_cash_accounts', 'erp_bank_statements', 'erp_fixed_assets'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_audit_' || t, t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn()', 'trg_audit_' || t, t);
  END LOOP;
END;
$$;

-- ─── Reset: statements and assets go with the documents ──────────────────────
-- As in 20261012000053, plus bank statements and fixed assets (their ledger
-- entries are cleared by the reset itself); cash accounts are kept like
-- equipment, and go with the ledger's accounts on a full reset.
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
  DELETE FROM public.erp_bank_statements x WHERE x.workspace_id = p_workspace_id;
  DELETE FROM public.erp_fixed_assets x WHERE x.workspace_id = p_workspace_id;
  IF p_scope = 'all' THEN
    DELETE FROM public.erp_vehicles x WHERE x.workspace_id = p_workspace_id;
    DELETE FROM public.erp_equipment x WHERE x.workspace_id = p_workspace_id;
  END IF;
END;
$$;

-- ─── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.erp_fin__account(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_fin__read(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_cash__ensure(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_cash__check() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_cash__route(JSONB, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_cash__account(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_bank__candidates(public.erp_bank_statement_lines, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_bank__line(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_bank__parse(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_fa__amount(public.erp_fixed_assets, INTEGER, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_fa__run(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_gl__on_payment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_gl__on_transaction() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.erp_cash_account_list(UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_cash_account_create(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_cash_account_update(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_cash_transfer(UUID, UUID, UUID, NUMERIC, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_cash_transfer_list(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_cash_transfer_void(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_supplier_bill_pay(UUID, NUMERIC, DATE, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_bank_statement_import(UUID, UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_bank_statement_delete(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_bank_line_candidates(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_bank_line_match(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_bank_line_unmatch(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_bank_line_ignore(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_bank_line_post(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_bank_auto_match(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_bank_reconciliation(UUID, UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_bank_unmatched_ledger(UUID, UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_fixed_asset_create(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_fixed_asset_void(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_fixed_assets_depreciate(UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_fixed_asset_dispose(UUID, DATE, NUMERIC, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_fixed_asset_schedule(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_cash_account_list(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_cash_account_create(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_cash_account_update(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_cash_transfer(UUID, UUID, UUID, NUMERIC, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_cash_transfer_list(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_cash_transfer_void(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_supplier_bill_pay(UUID, NUMERIC, DATE, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_bank_statement_import(UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_bank_statement_delete(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_bank_line_candidates(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_bank_line_match(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_bank_line_unmatch(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_bank_line_ignore(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_bank_line_post(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_bank_auto_match(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_bank_reconciliation(UUID, UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_bank_unmatched_ledger(UUID, UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_fixed_asset_create(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_fixed_asset_void(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_fixed_assets_depreciate(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_fixed_asset_dispose(UUID, DATE, NUMERIC, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_fixed_asset_schedule(UUID) TO authenticated;
