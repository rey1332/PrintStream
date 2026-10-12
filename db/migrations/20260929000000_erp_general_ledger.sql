-- ─── General ledger (double-entry) ───────────────────────────────────────────
-- Additive. Adds a chart of accounts, balanced journal entries posted
-- automatically from ERP documents, manual journals, a lock date that closes
-- the books through a date, and server-side reporting functions.
--
-- Posting rules (amounts in the workspace's base currency):
--   invoice issued            Dr Accounts receivable   Cr Sales revenue
--   invoice voided            reversal of the invoice entry (dated the void)
--   incoming payment          Dr Cash   Cr Accounts receivable (with invoice) / Other income
--   outgoing payment          Dr Accounts payable (with PO) / Operating expenses   Cr Cash
--   payment voided            reversal of the payment entry (dated the void)
--   manual cash income        Dr Cash   Cr Other income
--   manual cash expense       Dr Operating expenses   Cr Cash
--   purchase receipt          Dr Inventory (stock lines) / Operating expenses   Cr Accounts payable   (PO price)
--   sales delivery            Dr Cost of goods sold   Cr Inventory   (product purchase price at delivery)
--   receipt/delivery reversal reversal of the original event entry
--   opening stock             Dr Inventory   Cr Opening balance equity   (product purchase price)
--   stock adjustment          Inventory against Inventory adjustments   (product purchase price)
-- Cash-book rows mirrored from payments (source_payment_id set) are not posted
-- twice. Every entry must balance (checked at commit); nothing can be posted
-- on or before the lock date.
--
-- Existing documents are posted once by the backfill at the end (idempotent).
-- Rollback: supabase/snippets/rollback_20260929000000_erp_general_ledger.sql

-- ─── 1. Tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.erp_accounting_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL,
  base_currency TEXT NOT NULL DEFAULT 'USD' CHECK (base_currency ~ '^[A-Z]{3}$'),
  lock_date DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID
);

CREATE TABLE IF NOT EXISTS public.erp_gl_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL,
  code TEXT NOT NULL CHECK (code ~ '^[0-9A-Za-z.-]{1,20}$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  account_type TEXT NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  system_key TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, code)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_gl_accounts_system_key
  ON public.erp_gl_accounts(user_id, system_key) WHERE system_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_erp_gl_accounts_workspace ON public.erp_gl_accounts(workspace_id);

CREATE TABLE IF NOT EXISTS public.erp_journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL,
  entry_no INTEGER NOT NULL,
  entry_date DATE NOT NULL,
  memo TEXT NOT NULL DEFAULT '' CHECK (char_length(memo) <= 500),
  source_type TEXT NOT NULL CHECK (source_type IN (
    'invoice', 'invoice_void', 'invoice_adjust', 'payment', 'payment_void', 'payment_adjust', 'transaction',
    'purchase_receipt', 'sales_delivery', 'stock_adjustment', 'opening_stock', 'manual', 'manual_reversal'
  )),
  source_id UUID,
  source_key TEXT,
  reverses_entry_id UUID REFERENCES public.erp_journal_entries(id),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, entry_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_journal_entries_source_key
  ON public.erp_journal_entries(user_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_erp_journal_entries_date ON public.erp_journal_entries(user_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_erp_journal_entries_workspace ON public.erp_journal_entries(workspace_id, entry_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_journal_entries_reversal
  ON public.erp_journal_entries(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.erp_journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES public.erp_journal_entries(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.erp_gl_accounts(id),
  debit NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo TEXT NOT NULL DEFAULT '' CHECK (char_length(memo) <= 300),
  CHECK ((debit > 0) <> (credit > 0))
);
CREATE INDEX IF NOT EXISTS idx_erp_journal_lines_entry ON public.erp_journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_erp_journal_lines_account ON public.erp_journal_lines(account_id);

-- Workspace follows the owner, like every other ERP table.
DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['erp_accounting_settings', 'erp_gl_accounts', 'erp_journal_entries'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_erp_assign_workspace ON public.%I', target);
    EXECUTE format(
      'CREATE TRIGGER trg_erp_assign_workspace BEFORE INSERT OR UPDATE OF user_id, workspace_id ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.erp_assign_workspace()', target);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%s ON public.%I', target, target);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_%s AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn()', target, target);
  END LOOP;
END;
$$;

-- ─── 2. Access: read by owner and workspace members; writes only via functions ─

ALTER TABLE public.erp_accounting_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_gl_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_journal_lines ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.erp_accounting_settings, public.erp_gl_accounts, public.erp_journal_entries, public.erp_journal_lines
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_accounting_settings, public.erp_gl_accounts, public.erp_journal_entries, public.erp_journal_lines
  TO authenticated;

DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['erp_accounting_settings', 'erp_gl_accounts', 'erp_journal_entries'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', target || '_read', target);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ('
      'user_id = (SELECT auth.uid()) OR (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, ''read'')))',
      target || '_read', target);
  END LOOP;
END;
$$;

DROP POLICY IF EXISTS erp_journal_lines_read ON public.erp_journal_lines;
CREATE POLICY erp_journal_lines_read ON public.erp_journal_lines
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.erp_journal_entries e WHERE e.id = entry_id));

-- ─── 3. Chart of accounts ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_gl__seed(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.erp_gl_accounts (user_id, code, name, account_type, system_key)
  VALUES
    (p_user_id, '1000', 'Cash and bank', 'asset', 'cash'),
    (p_user_id, '1100', 'Accounts receivable', 'asset', 'ar'),
    (p_user_id, '1200', 'Inventory', 'asset', 'inventory'),
    (p_user_id, '1300', 'Input tax (VAT receivable)', 'asset', 'tax_in'),
    (p_user_id, '2000', 'Accounts payable', 'liability', 'ap'),
    (p_user_id, '2100', 'Output tax (VAT payable)', 'liability', 'tax_out'),
    (p_user_id, '3000', 'Opening balance equity', 'equity', 'opening'),
    (p_user_id, '3100', 'Retained earnings', 'equity', 'retained'),
    (p_user_id, '4000', 'Sales revenue', 'income', 'revenue'),
    (p_user_id, '4100', 'Other income', 'income', 'other_income'),
    (p_user_id, '5000', 'Cost of goods sold', 'expense', 'cogs'),
    (p_user_id, '6000', 'Operating expenses', 'expense', 'expenses'),
    (p_user_id, '6100', 'Inventory adjustments', 'expense', 'inventory_adjust')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.erp_accounting_settings (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_gl__account(p_user_id UUID, p_key TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE account UUID;
BEGIN
  SELECT id INTO account FROM public.erp_gl_accounts WHERE user_id = p_user_id AND system_key = p_key;
  IF account IS NULL THEN
    PERFORM public.erp_gl__seed(p_user_id);
    SELECT id INTO account FROM public.erp_gl_accounts WHERE user_id = p_user_id AND system_key = p_key;
  END IF;
  IF account IS NULL THEN RAISE EXCEPTION 'Ledger account % is missing', p_key; END IF;
  RETURN account;
END;
$$;

-- ─── 4. Posting ───────────────────────────────────────────────────────────────

-- Posts one balanced entry. p_lines: [{"key": "ar" | "account_id": uuid, "debit": n, "credit": n, "memo": ""}].
-- Idempotent per source key. Refuses dates on or before the lock date.
CREATE OR REPLACE FUNCTION public.erp_gl__post(
  p_user_id UUID, p_date DATE, p_memo TEXT, p_source_type TEXT, p_source_id UUID, p_source_key TEXT,
  p_lines JSONB, p_reverses UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing UUID;
  lock_through DATE;
  new_id UUID;
  next_no INTEGER;
  line JSONB;
  total_debit NUMERIC := 0;
  total_credit NUMERIC := 0;
BEGIN
  IF p_user_id IS NULL THEN RETURN NULL; END IF;
  IF p_source_key IS NOT NULL THEN
    SELECT id INTO existing FROM public.erp_journal_entries WHERE user_id = p_user_id AND source_key = p_source_key;
    IF existing IS NOT NULL THEN RETURN existing; END IF;
  END IF;

  FOR line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    total_debit := total_debit + round(COALESCE((line->>'debit')::NUMERIC, 0), 2);
    total_credit := total_credit + round(COALESCE((line->>'credit')::NUMERIC, 0), 2);
  END LOOP;
  IF total_debit = 0 AND total_credit = 0 THEN RETURN NULL; END IF;
  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Journal entry is not balanced (debit %, credit %)', total_debit, total_credit USING ERRCODE = 'P0001';
  END IF;

  SELECT lock_date INTO lock_through FROM public.erp_accounting_settings WHERE user_id = p_user_id;
  IF lock_through IS NOT NULL AND p_date <= lock_through THEN
    RAISE EXCEPTION 'The books are closed through %; use a later date', lock_through USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('erp_journal:' || p_user_id::TEXT));
  SELECT COALESCE(MAX(entry_no), 0) + 1 INTO next_no FROM public.erp_journal_entries WHERE user_id = p_user_id;

  INSERT INTO public.erp_journal_entries
    (user_id, entry_no, entry_date, memo, source_type, source_id, source_key, reverses_entry_id, created_by)
  VALUES
    (p_user_id, next_no, p_date, left(COALESCE(p_memo, ''), 500), p_source_type, p_source_id, p_source_key, p_reverses, auth.uid())
  RETURNING id INTO new_id;

  FOR line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF round(COALESCE((line->>'debit')::NUMERIC, 0), 2) = 0 AND round(COALESCE((line->>'credit')::NUMERIC, 0), 2) = 0 THEN
      CONTINUE;
    END IF;
    INSERT INTO public.erp_journal_lines (entry_id, account_id, debit, credit, memo)
    VALUES (
      new_id,
      COALESCE((line->>'account_id')::UUID, public.erp_gl__account(p_user_id, line->>'key')),
      round(COALESCE((line->>'debit')::NUMERIC, 0), 2),
      round(COALESCE((line->>'credit')::NUMERIC, 0), 2),
      left(COALESCE(line->>'memo', ''), 300)
    );
  END LOOP;
  RETURN new_id;
END;
$$;

-- Posts the mirror image of the entry with p_original_key.
CREATE OR REPLACE FUNCTION public.erp_gl__reverse(
  p_user_id UUID, p_original_key TEXT, p_date DATE, p_memo TEXT, p_source_type TEXT, p_source_id UUID, p_new_key TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  original UUID;
  lines JSONB;
BEGIN
  SELECT id INTO original FROM public.erp_journal_entries WHERE user_id = p_user_id AND source_key = p_original_key;
  IF original IS NULL THEN RETURN NULL; END IF;
  SELECT jsonb_agg(jsonb_build_object('account_id', account_id, 'debit', credit, 'credit', debit, 'memo', memo))
  INTO lines FROM public.erp_journal_lines WHERE entry_id = original;
  RETURN public.erp_gl__post(p_user_id, p_date, p_memo, p_source_type, p_source_id, p_new_key, lines, original);
END;
$$;

-- A two-line entry: debit one account, credit another.
CREATE OR REPLACE FUNCTION public.erp_gl__pair(p_debit_key TEXT, p_credit_key TEXT, p_amount NUMERIC)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_amount >= 0
    THEN jsonb_build_array(jsonb_build_object('key', p_debit_key, 'debit', p_amount),
                           jsonb_build_object('key', p_credit_key, 'credit', p_amount))
    ELSE jsonb_build_array(jsonb_build_object('key', p_credit_key, 'debit', -p_amount),
                           jsonb_build_object('key', p_debit_key, 'credit', -p_amount))
  END;
$$;

-- Every entry balances and has at least two lines (checked at commit).
CREATE OR REPLACE FUNCTION public.erp_gl__check_balanced()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target UUID := COALESCE(NEW.entry_id, OLD.entry_id);
  d NUMERIC;
  c NUMERIC;
  n INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.erp_journal_entries WHERE id = target) THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), count(*) INTO d, c, n
  FROM public.erp_journal_lines WHERE entry_id = target;
  IF d <> c OR n < 2 THEN
    RAISE EXCEPTION 'Journal entry % is not balanced', target USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_erp_gl_balanced ON public.erp_journal_lines;
CREATE CONSTRAINT TRIGGER trg_erp_gl_balanced
  AFTER INSERT OR UPDATE OR DELETE ON public.erp_journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.erp_gl__check_balanced();

-- ─── 5. Automatic posting from ERP documents ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_gl__on_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::TEXT <> 'void' THEN
      PERFORM public.erp_gl__post(NEW.user_id, NEW.invoice_date, 'Invoice to ' || NEW.customer_name,
        'invoice', NEW.id, 'invoice:' || NEW.id, public.erp_gl__pair('ar', 'revenue', NEW.total));
    END IF;
  ELSIF NEW.status::TEXT = 'void' AND OLD.status::TEXT <> 'void' THEN
    PERFORM public.erp_gl__reverse(NEW.user_id, 'invoice:' || NEW.id, COALESCE(NEW.voided_at::DATE, CURRENT_DATE),
      'Void of invoice to ' || NEW.customer_name, 'invoice_void', NEW.id, 'invoice_void:' || NEW.id);
  ELSIF NEW.total IS DISTINCT FROM OLD.total AND NEW.status::TEXT <> 'void' THEN
    PERFORM public.erp_gl__post(NEW.user_id, CURRENT_DATE, 'Invoice total changed for ' || NEW.customer_name,
      'invoice_adjust', NEW.id, NULL, public.erp_gl__pair('ar', 'revenue', NEW.total - OLD.total));
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_gl__payment_lines(p public.erp_payments, p_amount NUMERIC)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN p.payment_type::TEXT = 'incoming' THEN
      public.erp_gl__pair('cash', CASE WHEN p.invoice_id IS NOT NULL THEN 'ar' ELSE 'other_income' END, p_amount)
    ELSE
      public.erp_gl__pair(CASE WHEN p.purchase_order_id IS NOT NULL THEN 'ap' ELSE 'expenses' END, 'cash', p_amount)
  END;
$$;

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
        CASE WHEN NEW.payment_type::TEXT = 'incoming' THEN 'Payment from ' ELSE 'Payment to ' END || NEW.party,
        'payment', NEW.id, 'payment:' || NEW.id, public.erp_gl__payment_lines(NEW, NEW.amount));
    END IF;
  ELSIF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    PERFORM public.erp_gl__reverse(NEW.user_id, 'payment:' || NEW.id, NEW.voided_at::DATE,
      'Void of payment (' || NEW.party || ')', 'payment_void', NEW.id, 'payment_void:' || NEW.id);
  ELSIF NEW.voided_at IS NULL AND NEW.amount IS DISTINCT FROM OLD.amount THEN
    PERFORM public.erp_gl__post(NEW.user_id, CURRENT_DATE, 'Payment amount changed (' || NEW.party || ')',
      'payment_adjust', NEW.id, NULL, public.erp_gl__payment_lines(NEW, NEW.amount - OLD.amount));
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

-- Receipts and deliveries are posted when the transaction commits, once all
-- of the event's lines exist.
CREATE OR REPLACE FUNCTION public.erp_gl__post_fulfillment(p_event_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ev public.erp_fulfillment_events;
  stock_value NUMERIC := 0;
  other_value NUMERIC := 0;
  lines JSONB;
  memo TEXT;
BEGIN
  SELECT * INTO ev FROM public.erp_fulfillment_events WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- A reversal mirrors the original event's entry (same values even if
  -- product prices changed since).
  IF ev.is_reversal AND ev.reverses_event_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.erp_journal_entries WHERE user_id = ev.user_id AND source_key = ev.kind || ':' || ev.reverses_event_id) THEN
    RETURN public.erp_gl__reverse(ev.user_id, ev.kind || ':' || ev.reverses_event_id, ev.created_at::DATE,
      'Reversal of ' || replace(ev.kind, '_', ' '), ev.kind, ev.id, ev.kind || ':' || ev.id);
  END IF;

  IF ev.kind = 'purchase_receipt' THEN
    SELECT COALESCE(SUM(l.quantity * i.price) FILTER (WHERE l.product_id IS NOT NULL), 0),
           COALESCE(SUM(l.quantity * i.price) FILTER (WHERE l.product_id IS NULL), 0)
    INTO stock_value, other_value
    FROM public.erp_fulfillment_event_lines l
    JOIN public.erp_purchase_order_items i ON i.id = l.purchase_order_item_id
    WHERE l.event_id = ev.id;
    lines := jsonb_build_array(
      jsonb_build_object('key', 'inventory', 'debit', stock_value),
      jsonb_build_object('key', 'expenses', 'debit', other_value),
      jsonb_build_object('key', 'ap', 'credit', stock_value + other_value));
    memo := 'Goods received';
  ELSE
    SELECT COALESCE(SUM(l.quantity * p.purchase_price), 0) INTO stock_value
    FROM public.erp_fulfillment_event_lines l
    JOIN public.erp_products p ON p.id = l.product_id
    WHERE l.event_id = ev.id;
    lines := jsonb_build_array(
      jsonb_build_object('key', 'cogs', 'debit', stock_value),
      jsonb_build_object('key', 'inventory', 'credit', stock_value));
    memo := 'Goods delivered (cost)';
  END IF;

  IF ev.is_reversal THEN
    SELECT jsonb_agg(jsonb_build_object('key', x->>'key', 'debit', x->'credit', 'credit', x->'debit')) INTO lines
    FROM jsonb_array_elements(lines) x;
    memo := 'Reversal: ' || memo;
  END IF;

  RETURN public.erp_gl__post(ev.user_id, ev.created_at::DATE, memo, ev.kind, ev.id, ev.kind || ':' || ev.id, lines);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_gl__on_fulfillment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.erp_gl__post_fulfillment(NEW.id);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_gl__on_stock_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  unit_cost NUMERIC;
  value NUMERIC;
  opening BOOLEAN;
BEGIN
  -- Receipts and deliveries are posted from their fulfillment events.
  IF NEW.source_type IS NULL OR NEW.source_type NOT IN ('manual_adjustment', 'product_edit') THEN RETURN NULL; END IF;
  SELECT purchase_price INTO unit_cost FROM public.erp_products WHERE id = NEW.product_id;
  value := COALESCE(unit_cost, 0) * NEW.quantity;
  IF value = 0 THEN RETURN NULL; END IF;
  opening := NEW.note LIKE 'Opening stock%';
  PERFORM public.erp_gl__post(NEW.user_id, NEW.movement_date,
    CASE WHEN opening THEN 'Opening stock: ' ELSE 'Stock adjustment: ' END || NEW.product_name,
    CASE WHEN opening THEN 'opening_stock' ELSE 'stock_adjustment' END, NEW.id, 'stock:' || NEW.id,
    CASE WHEN NEW.movement_type::TEXT = 'in'
      THEN public.erp_gl__pair('inventory', CASE WHEN opening THEN 'opening' ELSE 'inventory_adjust' END, value)
      ELSE public.erp_gl__pair('inventory_adjust', 'inventory', value) END);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_erp_gl_invoice ON public.erp_invoices;
CREATE TRIGGER trg_erp_gl_invoice AFTER INSERT OR UPDATE OF status, total ON public.erp_invoices
  FOR EACH ROW EXECUTE FUNCTION public.erp_gl__on_invoice();
DROP TRIGGER IF EXISTS trg_erp_gl_payment ON public.erp_payments;
CREATE TRIGGER trg_erp_gl_payment AFTER INSERT OR UPDATE OF voided_at, amount ON public.erp_payments
  FOR EACH ROW EXECUTE FUNCTION public.erp_gl__on_payment();
DROP TRIGGER IF EXISTS trg_erp_gl_transaction ON public.erp_transactions;
CREATE TRIGGER trg_erp_gl_transaction AFTER INSERT ON public.erp_transactions
  FOR EACH ROW EXECUTE FUNCTION public.erp_gl__on_transaction();
DROP TRIGGER IF EXISTS trg_erp_gl_fulfillment ON public.erp_fulfillment_events;
CREATE CONSTRAINT TRIGGER trg_erp_gl_fulfillment AFTER INSERT ON public.erp_fulfillment_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.erp_gl__on_fulfillment();
DROP TRIGGER IF EXISTS trg_erp_gl_stock ON public.erp_stock_movements;
CREATE TRIGGER trg_erp_gl_stock AFTER INSERT ON public.erp_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.erp_gl__on_stock_movement();

-- ─── 6. Scope, reports and manual journals (called by the app) ───────────────

-- Owner whose books the caller may read: their own, or a workspace's owner.
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

-- Dropped first: a later migration adds a column to its result.
DROP FUNCTION IF EXISTS public.erp_accounting_settings_get(UUID);
CREATE FUNCTION public.erp_accounting_settings_get(p_workspace_id UUID)
RETURNS TABLE (base_currency TEXT, lock_date DATE, can_manage BOOLEAN, can_post BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE owner UUID := public.erp_gl__scope(p_workspace_id);
BEGIN
  PERFORM public.erp_gl__seed(owner);
  RETURN QUERY
  SELECT s.base_currency, s.lock_date,
         owner = auth.uid() OR (p_workspace_id IS NOT NULL AND public.erp_has_permission(p_workspace_id, 'members')),
         owner = auth.uid() OR (p_workspace_id IS NOT NULL AND public.erp_has_permission(p_workspace_id, 'payments'))
  FROM public.erp_accounting_settings s WHERE s.user_id = owner;
END;
$$;

-- Base currency and lock date. Owners and admins may close the books (move
-- the lock date forward); only the owner may reopen a closed period.
CREATE OR REPLACE FUNCTION public.erp_accounting_settings_set(p_workspace_id UUID, p_base_currency TEXT, p_lock_date DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner UUID := public.erp_gl__scope(p_workspace_id, CASE WHEN p_workspace_id IS NULL THEN 'read' ELSE 'members' END);
  current public.erp_accounting_settings;
BEGIN
  PERFORM public.erp_gl__seed(owner);
  SELECT * INTO current FROM public.erp_accounting_settings WHERE user_id = owner FOR UPDATE;
  IF p_base_currency IS NULL OR p_base_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Currency must be a 3-letter ISO code' USING ERRCODE = 'P0001';
  END IF;
  IF p_lock_date IS DISTINCT FROM current.lock_date
     AND (p_lock_date IS NULL OR (current.lock_date IS NOT NULL AND p_lock_date < current.lock_date))
     AND owner <> auth.uid() THEN
    RAISE EXCEPTION 'Only the owner can reopen a closed period' USING ERRCODE = '42501';
  END IF;
  IF p_lock_date IS NOT NULL AND p_lock_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'The lock date cannot be in the future' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.erp_accounting_settings
  SET base_currency = p_base_currency, lock_date = p_lock_date, updated_at = now(), updated_by = auth.uid()
  WHERE user_id = owner;
END;
$$;

-- Balances per account over a period (NULL from = since the beginning).
CREATE OR REPLACE FUNCTION public.erp_trial_balance(p_workspace_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (account_id UUID, code TEXT, name TEXT, account_type TEXT, system_key TEXT, debit NUMERIC, credit NUMERIC, balance NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE owner UUID := public.erp_gl__scope(p_workspace_id);
BEGIN
  PERFORM public.erp_gl__seed(owner);
  RETURN QUERY
  SELECT a.id, a.code, a.name, a.account_type, a.system_key,
         COALESCE(SUM(t.debit), 0)::NUMERIC, COALESCE(SUM(t.credit), 0)::NUMERIC,
         CASE WHEN a.account_type IN ('asset', 'expense')
              THEN COALESCE(SUM(t.debit), 0) - COALESCE(SUM(t.credit), 0)
              ELSE COALESCE(SUM(t.credit), 0) - COALESCE(SUM(t.debit), 0) END::NUMERIC
  FROM public.erp_gl_accounts a
  LEFT JOIN (
    SELECT l.account_id, l.debit, l.credit
    FROM public.erp_journal_lines l
    JOIN public.erp_journal_entries e ON e.id = l.entry_id
    WHERE e.user_id = owner
      AND (p_from IS NULL OR e.entry_date >= p_from)
      AND (p_to IS NULL OR e.entry_date <= p_to)
  ) t ON t.account_id = a.id
  WHERE a.user_id = owner
  GROUP BY a.id
  ORDER BY a.code;
END;
$$;

-- Journal entries with their lines, newest first.
CREATE OR REPLACE FUNCTION public.erp_journal_list(
  p_workspace_id UUID, p_from DATE, p_to DATE, p_account_id UUID, p_limit INTEGER, p_offset INTEGER
)
RETURNS TABLE (id UUID, entry_no INTEGER, entry_date DATE, memo TEXT, source_type TEXT, source_id UUID,
               reverses_entry_id UUID, reversed BOOLEAN, created_at TIMESTAMPTZ, lines JSONB, total_count BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE owner UUID := public.erp_gl__scope(p_workspace_id);
BEGIN
  RETURN QUERY
  WITH filtered AS (
    SELECT e.* FROM public.erp_journal_entries e
    WHERE e.user_id = owner
      AND (p_from IS NULL OR e.entry_date >= p_from)
      AND (p_to IS NULL OR e.entry_date <= p_to)
      AND (p_account_id IS NULL OR EXISTS (SELECT 1 FROM public.erp_journal_lines l WHERE l.entry_id = e.id AND l.account_id = p_account_id))
  )
  SELECT f.id, f.entry_no, f.entry_date, f.memo, f.source_type, f.source_id, f.reverses_entry_id,
         EXISTS (SELECT 1 FROM public.erp_journal_entries r WHERE r.reverses_entry_id = f.id),
         f.created_at,
         (SELECT jsonb_agg(jsonb_build_object('account_id', l.account_id, 'code', a.code, 'name', a.name,
                                              'debit', l.debit, 'credit', l.credit, 'memo', l.memo) ORDER BY l.debit DESC, a.code)
          FROM public.erp_journal_lines l JOIN public.erp_gl_accounts a ON a.id = l.account_id WHERE l.entry_id = f.id),
         (SELECT count(*) FROM filtered)
  FROM filtered f
  ORDER BY f.entry_date DESC, f.entry_no DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

-- Manual journal entry (accruals, corrections, opening balances).
CREATE OR REPLACE FUNCTION public.erp_post_journal(p_workspace_id UUID, p_date DATE, p_memo TEXT, p_lines JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner UUID := public.erp_gl__scope(p_workspace_id, CASE WHEN p_workspace_id IS NULL THEN 'read' ELSE 'payments' END);
  line JSONB;
  n INTEGER := 0;
  d NUMERIC;
  c NUMERIC;
BEGIN
  IF p_date IS NULL THEN RAISE EXCEPTION 'Choose a date' USING ERRCODE = 'P0001'; END IF;
  IF char_length(btrim(COALESCE(p_memo, ''))) < 3 THEN
    RAISE EXCEPTION 'Describe the entry (at least 3 characters)' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 2 AND 50 THEN
    RAISE EXCEPTION 'A journal entry needs 2 to 50 lines' USING ERRCODE = 'P0001';
  END IF;
  FOR line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    n := n + 1;
    d := round(COALESCE((line->>'debit')::NUMERIC, 0), 2);
    c := round(COALESCE((line->>'credit')::NUMERIC, 0), 2);
    IF d < 0 OR c < 0 OR (d > 0) = (c > 0) THEN
      RAISE EXCEPTION 'Line % must have either a debit or a credit amount', n USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.erp_gl_accounts WHERE id = (line->>'account_id')::UUID AND user_id = owner AND is_active) THEN
      RAISE EXCEPTION 'Line % uses an account that is not available', n USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN public.erp_gl__post(owner, p_date, btrim(p_memo), 'manual', NULL, NULL,
    (SELECT jsonb_agg(jsonb_build_object('account_id', x->>'account_id', 'debit', x->'debit', 'credit', x->'credit', 'memo', COALESCE(x->>'memo', '')))
     FROM jsonb_array_elements(p_lines) x));
END;
$$;

-- Reverses a manual journal entry (automatic entries are reversed by voiding their document).
CREATE OR REPLACE FUNCTION public.erp_reverse_journal(p_entry_id UUID, p_reason TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  entry public.erp_journal_entries;
  lines JSONB;
BEGIN
  SELECT * INTO entry FROM public.erp_journal_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Journal entry not found' USING ERRCODE = '42501'; END IF;
  PERFORM public.erp_gl__scope(CASE WHEN entry.user_id = auth.uid() THEN NULL ELSE entry.workspace_id END,
                               CASE WHEN entry.user_id = auth.uid() THEN 'read' ELSE 'payments' END);
  IF entry.source_type <> 'manual' THEN
    RAISE EXCEPTION 'Automatic entries are reversed by voiding or reversing their document' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'A reason (at least 3 characters) is required to reverse a journal entry' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.erp_journal_entries WHERE reverses_entry_id = entry.id) THEN
    RAISE EXCEPTION 'This entry has already been reversed' USING ERRCODE = 'P0001';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('account_id', account_id, 'debit', credit, 'credit', debit, 'memo', memo))
  INTO lines FROM public.erp_journal_lines WHERE entry_id = entry.id;
  RETURN public.erp_gl__post(entry.user_id, CURRENT_DATE, 'Reversal of #' || entry.entry_no || ': ' || btrim(p_reason),
    'manual_reversal', entry.id, NULL, lines, entry.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_create_gl_account(p_workspace_id UUID, p_code TEXT, p_name TEXT, p_type TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner UUID := public.erp_gl__scope(p_workspace_id, CASE WHEN p_workspace_id IS NULL THEN 'read' ELSE 'payments' END);
  new_id UUID;
BEGIN
  PERFORM public.erp_gl__seed(owner);
  IF EXISTS (SELECT 1 FROM public.erp_gl_accounts WHERE user_id = owner AND code = btrim(p_code)) THEN
    RAISE EXCEPTION 'An account with code % already exists', btrim(p_code) USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.erp_gl_accounts (user_id, code, name, account_type)
  VALUES (owner, btrim(p_code), btrim(p_name), p_type)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_set_gl_account_active(p_account_id UUID, p_active BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE account public.erp_gl_accounts;
BEGIN
  SELECT * INTO account FROM public.erp_gl_accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found' USING ERRCODE = '42501'; END IF;
  PERFORM public.erp_gl__scope(CASE WHEN account.user_id = auth.uid() THEN NULL ELSE account.workspace_id END,
                               CASE WHEN account.user_id = auth.uid() THEN 'read' ELSE 'payments' END);
  IF account.system_key IS NOT NULL AND NOT p_active THEN
    RAISE EXCEPTION 'System accounts used for automatic posting cannot be deactivated' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.erp_gl_accounts SET is_active = p_active WHERE id = account.id;
END;
$$;

-- Internal functions are not callable through the API.
REVOKE ALL ON FUNCTION public.erp_gl__seed(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_gl__account(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_gl__post(UUID, DATE, TEXT, TEXT, UUID, TEXT, JSONB, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_gl__reverse(UUID, TEXT, DATE, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_gl__post_fulfillment(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_gl__scope(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_gl__on_invoice() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_gl__on_payment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_gl__on_transaction() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_gl__on_fulfillment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_gl__on_stock_movement() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_gl__check_balanced() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.erp_accounting_settings_get(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_accounting_settings_set(UUID, TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_trial_balance(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_journal_list(UUID, DATE, DATE, UUID, INTEGER, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_post_journal(UUID, DATE, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_reverse_journal(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_create_gl_account(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_set_gl_account_active(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_accounting_settings_get(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_accounting_settings_set(UUID, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_trial_balance(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_journal_list(UUID, DATE, DATE, UUID, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_post_journal(UUID, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_reverse_journal(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_gl_account(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_set_gl_account_active(UUID, BOOLEAN) TO authenticated;

-- ─── 7. Account resets also clear the ledger ─────────────────────────────────
-- The existing "delete all" functions remove the documents; their ledger
-- entries must go with them or the books would no longer match.

CREATE OR REPLACE FUNCTION public.erp_gl__clear(p_user_id UUID, p_accounts BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.erp_journal_entries WHERE user_id = p_user_id;
  IF p_accounts THEN
    DELETE FROM public.erp_gl_accounts WHERE user_id = p_user_id;
    DELETE FROM public.erp_accounting_settings WHERE user_id = p_user_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_gl__clear(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  body TEXT;
BEGIN
  -- Add the ledger reset to the existing reset functions without changing
  -- anything else they do.
  SELECT pg_get_functiondef('public.erp_delete_all_transactions(uuid)'::regprocedure) INTO body;
  IF body IS NOT NULL AND position('erp_gl__clear' IN body) = 0 THEN
    body := replace(body, 'DELETE FROM public.erp_audit_log WHERE user_id = p_user_id;',
      'PERFORM public.erp_gl__clear(p_user_id, false);' || chr(10) || '  DELETE FROM public.erp_audit_log WHERE user_id = p_user_id;');
    EXECUTE body;
  END IF;
  SELECT pg_get_functiondef('public.erp_delete_all_data(uuid)'::regprocedure) INTO body;
  IF body IS NOT NULL AND position('erp_gl__clear' IN body) = 0 THEN
    body := replace(body, 'DELETE FROM public.erp_audit_log WHERE user_id = p_user_id;',
      'PERFORM public.erp_gl__clear(p_user_id, true);' || chr(10) || '  DELETE FROM public.erp_audit_log WHERE user_id = p_user_id;');
    EXECUTE body;
  END IF;
END;
$$;

-- ─── 8. Backfill existing documents ──────────────────────────────────────────
-- Posts every existing document once, oldest first, with its original date.
-- Stock movements from before fulfillment events (no source) are treated as
-- receipts (in) and deliveries (out) at the product's purchase price.

DO $$
DECLARE
  r RECORD;
  pay public.erp_payments;
BEGIN
  PERFORM set_config('erp.maintenance', 'on', true);

  FOR r IN SELECT * FROM public.erp_invoices ORDER BY invoice_date, created_at LOOP
    PERFORM public.erp_gl__post(r.user_id, r.invoice_date, 'Invoice to ' || r.customer_name,
      'invoice', r.id, 'invoice:' || r.id, public.erp_gl__pair('ar', 'revenue', r.total));
    IF r.status::TEXT = 'void' THEN
      PERFORM public.erp_gl__reverse(r.user_id, 'invoice:' || r.id, COALESCE(r.voided_at::DATE, r.invoice_date),
        'Void of invoice to ' || r.customer_name, 'invoice_void', r.id, 'invoice_void:' || r.id);
    END IF;
  END LOOP;

  FOR pay IN SELECT * FROM public.erp_payments ORDER BY payment_date, created_at LOOP
    PERFORM public.erp_gl__post(pay.user_id, pay.payment_date,
      CASE WHEN pay.payment_type::TEXT = 'incoming' THEN 'Payment from ' ELSE 'Payment to ' END || pay.party,
      'payment', pay.id, 'payment:' || pay.id,
      public.erp_gl__payment_lines(pay, pay.amount));
    IF pay.voided_at IS NOT NULL THEN
      PERFORM public.erp_gl__reverse(pay.user_id, 'payment:' || pay.id, pay.voided_at::DATE,
        'Void of payment (' || pay.party || ')', 'payment_void', pay.id, 'payment_void:' || pay.id);
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM public.erp_transactions WHERE source_payment_id IS NULL
           AND id NOT IN (SELECT transaction_id FROM public.erp_payments WHERE transaction_id IS NOT NULL)
           ORDER BY transaction_date, created_at LOOP
    PERFORM public.erp_gl__post(r.user_id, r.transaction_date, COALESCE(NULLIF(r.description, ''), r.category),
      'transaction', r.id, 'transaction:' || r.id,
      CASE WHEN r.transaction_type::TEXT = 'income'
        THEN public.erp_gl__pair('cash', 'other_income', r.amount)
        ELSE public.erp_gl__pair('expenses', 'cash', r.amount) END);
  END LOOP;

  FOR r IN SELECT id FROM public.erp_fulfillment_events ORDER BY created_at LOOP
    PERFORM public.erp_gl__post_fulfillment(r.id);
  END LOOP;

  FOR r IN SELECT m.*, p.purchase_price FROM public.erp_stock_movements m
           LEFT JOIN public.erp_products p ON p.id = m.product_id
           WHERE m.source_type IS NULL OR m.source_type IN ('manual_adjustment', 'product_edit')
           ORDER BY m.movement_date, m.created_at LOOP
    IF COALESCE(r.purchase_price, 0) * r.quantity <> 0 THEN
      PERFORM public.erp_gl__post(r.user_id, r.movement_date,
        CASE WHEN r.source_type IS NULL THEN 'Stock movement: ' ELSE 'Stock adjustment: ' END || r.product_name,
        CASE WHEN r.note LIKE 'Opening stock%' THEN 'opening_stock' ELSE 'stock_adjustment' END, r.id, 'stock:' || r.id,
        CASE
          WHEN r.note LIKE 'Opening stock%' THEN public.erp_gl__pair('inventory', 'opening', r.purchase_price * r.quantity)
          WHEN r.source_type IS NULL AND r.movement_type::TEXT = 'in' THEN public.erp_gl__pair('inventory', 'ap', r.purchase_price * r.quantity)
          WHEN r.source_type IS NULL THEN public.erp_gl__pair('cogs', 'inventory', r.purchase_price * r.quantity)
          WHEN r.movement_type::TEXT = 'in' THEN public.erp_gl__pair('inventory', 'inventory_adjust', r.purchase_price * r.quantity)
          ELSE public.erp_gl__pair('inventory_adjust', 'inventory', r.purchase_price * r.quantity)
        END);
    END IF;
  END LOOP;

  PERFORM set_config('erp.maintenance', 'off', true);
END;
$$;
