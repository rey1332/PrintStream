-- ─── ERP finance rules: partial payments, voids, reversals ───────────────────
-- Additive and backward compatible:
--   * invoices keep their legacy status (paid / unpaid / overdue) so older app
--     versions keep filtering correctly; the new amount_paid + payment_state
--     columns make partial payment explicit.
--   * payments are corrected by voiding (with a reason) instead of deleting:
--     the payment row stays, a reversal cash transaction is written, and the
--     invoice balance is recomputed. Hard DELETE keeps working for old
--     clients and still keeps balances correct.
--   * overpayment is rejected under a row lock on the invoice / PO, so
--     concurrent payment attempts are serialized.

-- ─── 1. Columns ───────────────────────────────────────────────────────────────

ALTER TABLE public.erp_invoices
  ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_state TEXT NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID,
  ADD COLUMN IF NOT EXISTS void_reason TEXT NOT NULL DEFAULT '';

DO $$ BEGIN
  ALTER TABLE public.erp_invoices
    ADD CONSTRAINT erp_invoices_payment_state_check
    CHECK (payment_state IN ('unpaid', 'partially_paid', 'paid', 'void')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.erp_invoices VALIDATE CONSTRAINT erp_invoices_payment_state_check;

ALTER TABLE public.erp_payments
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID,
  ADD COLUMN IF NOT EXISTS void_reason TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reversal_transaction_id UUID REFERENCES public.erp_transactions(id) ON DELETE SET NULL;

ALTER TABLE public.erp_transactions
  ADD COLUMN IF NOT EXISTS source_payment_id UUID REFERENCES public.erp_payments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_reversal BOOLEAN NOT NULL DEFAULT false;

-- ─── 2. Shared authorization helper for ERP RPCs ─────────────────────────────
-- Non-members get "not found" (no existence leak); members whose role lacks
-- the permission get a permission error.

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

CREATE OR REPLACE FUNCTION public.erp__require_reason(p_reason TEXT, p_action TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF char_length(trim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'A reason (at least 3 characters) is required to %', p_action;
  END IF;
  RETURN left(trim(p_reason), 500);
END;
$$;

-- Resolves the workspace an RPC writes into and checks the caller's role.
-- NULL means the caller's personal workspace (the legacy behaviour).
CREATE OR REPLACE FUNCTION public.erp__resolve_workspace(p_workspace_id UUID, p_permission TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE workspace UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  workspace := COALESCE(p_workspace_id, public.erp_personal_workspace_id(auth.uid()));
  IF workspace IS NULL OR public.erp_workspace_role(workspace) IS NULL THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = '42501';
  END IF;
  IF NOT public.erp_has_permission(workspace, p_permission) THEN
    RAISE EXCEPTION 'Your workspace role does not allow this action' USING ERRCODE = '42501';
  END IF;
  RETURN workspace;
END;
$$;

REVOKE ALL ON FUNCTION public.erp__authorize(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__require_reason(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__resolve_workspace(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ─── 3. Invoice balance / status derivation ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_refresh_invoice_status(p_invoice_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invoice_row public.erp_invoices%ROWTYPE;
  paid_total NUMERIC(15,2);
  next_status public.invoice_status;
  next_state TEXT;
BEGIN
  SELECT * INTO invoice_row FROM public.erp_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO paid_total
  FROM public.erp_payments
  WHERE invoice_id = p_invoice_id
    AND user_id = invoice_row.user_id
    AND payment_type = 'incoming'
    AND voided_at IS NULL;

  IF invoice_row.status = 'void' THEN
    next_status := 'void';
    next_state := 'void';
  ELSIF paid_total >= invoice_row.total THEN
    next_status := 'paid';
    next_state := 'paid';
  ELSE
    next_status := CASE WHEN invoice_row.due_date < CURRENT_DATE THEN 'overdue' ELSE 'unpaid' END;
    next_state := CASE WHEN paid_total > 0 THEN 'partially_paid' ELSE 'unpaid' END;
  END IF;

  UPDATE public.erp_invoices
  SET status = next_status, amount_paid = paid_total, payment_state = next_state
  WHERE id = p_invoice_id
    AND (status, amount_paid, payment_state) IS DISTINCT FROM (next_status, paid_total, next_state);
END;
$$;

REVOKE ALL ON FUNCTION public.erp_refresh_invoice_status(UUID) FROM PUBLIC, anon, authenticated;

-- ─── 4. Payment validation (overpayment, void rules) ─────────────────────────

CREATE OR REPLACE FUNCTION public.erp_validate_invoice_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invoice_row public.erp_invoices%ROWTYPE;
  purchase_order_row public.erp_purchase_orders%ROWTYPE;
  other_payments NUMERIC(15,2);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.voided_at IS NOT NULL THEN
      IF (NEW.voided_at, NEW.voided_by, NEW.void_reason, NEW.amount, NEW.payment_type, NEW.invoice_id,
          NEW.purchase_order_id, NEW.party, NEW.payment_date)
         IS DISTINCT FROM (OLD.voided_at, OLD.voided_by, OLD.void_reason, OLD.amount, OLD.payment_type, OLD.invoice_id,
          OLD.purchase_order_id, OLD.party, OLD.payment_date) THEN
        RAISE EXCEPTION 'Voided payments cannot be changed';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.voided_at IS NOT NULL THEN
      -- Only erp_void_payment() may void: it also books the reversal entry,
      -- which keeps the cash ledger consistent with the payment list.
      IF current_setting('erp.payment_void', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'Use the void action to void a payment';
      END IF;
      IF char_length(trim(COALESCE(NEW.void_reason, ''))) < 3 THEN
        RAISE EXCEPTION 'A reason is required to void a payment';
      END IF;
    END IF;
    -- Nothing that affects balances changed (e.g. void, note, workspace backfill).
    IF (NEW.amount, NEW.payment_type, NEW.invoice_id, NEW.purchase_order_id)
       IS NOT DISTINCT FROM (OLD.amount, OLD.payment_type, OLD.invoice_id, OLD.purchase_order_id) THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'A payment cannot be created as voided';
  END IF;

  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;

  IF NEW.invoice_id IS NOT NULL THEN
    IF NEW.payment_type <> 'incoming' THEN
      RAISE EXCEPTION 'Invoice payments must be incoming';
    END IF;

    -- The row lock serializes concurrent payments against the same invoice;
    -- the sum below is taken after the lock and sees committed payments.
    SELECT * INTO invoice_row
    FROM public.erp_invoices
    WHERE id = NEW.invoice_id AND user_id = NEW.user_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found for this account'; END IF;
    IF invoice_row.status = 'void' THEN
      RAISE EXCEPTION 'Payments cannot be recorded against a void invoice';
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO other_payments
    FROM public.erp_payments
    WHERE invoice_id = NEW.invoice_id AND user_id = NEW.user_id AND voided_at IS NULL
      AND (TG_OP = 'INSERT' OR id <> OLD.id);

    IF other_payments + NEW.amount > invoice_row.total + 0.01 THEN
      RAISE EXCEPTION 'Payment exceeds the invoice balance (remaining %)', GREATEST(invoice_row.total - other_payments, 0);
    END IF;
  END IF;

  IF NEW.purchase_order_id IS NOT NULL THEN
    IF NEW.payment_type <> 'outgoing' THEN RAISE EXCEPTION 'Supplier order payments must be outgoing'; END IF;
    SELECT * INTO purchase_order_row
    FROM public.erp_purchase_orders
    WHERE id = NEW.purchase_order_id AND user_id = NEW.user_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found for this account'; END IF;
    IF purchase_order_row.status NOT IN ('approved', 'received') THEN
      RAISE EXCEPTION 'Only approved or received purchase orders can be paid';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO other_payments
    FROM public.erp_payments
    WHERE purchase_order_id = NEW.purchase_order_id AND user_id = NEW.user_id AND voided_at IS NULL
      AND (TG_OP = 'INSERT' OR id <> OLD.id);
    IF other_payments + NEW.amount > purchase_order_row.total + 0.01 THEN
      RAISE EXCEPTION 'Payment exceeds the purchase order balance (remaining %)', GREATEST(purchase_order_row.total - other_payments, 0);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ─── 5. Payment ↔ cash transaction mirror ────────────────────────────────────
-- Same behaviour as before, plus: mirror rows point back at their payment, and
-- a hard delete also removes the reversal row written by a void.

CREATE OR REPLACE FUNCTION public.erp_payment_to_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  transaction_kind public.transaction_type;
  transaction_category TEXT;
  transaction_description TEXT;
  linked_transaction_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.transaction_id IS NOT NULL THEN
      DELETE FROM public.erp_transactions WHERE id = OLD.transaction_id AND user_id = OLD.user_id;
    END IF;
    IF OLD.reversal_transaction_id IS NOT NULL THEN
      DELETE FROM public.erp_transactions WHERE id = OLD.reversal_transaction_id AND user_id = OLD.user_id;
    END IF;
    RETURN OLD;
  END IF;

  transaction_kind := CASE WHEN NEW.payment_type = 'incoming' THEN 'income'::public.transaction_type ELSE 'expense'::public.transaction_type END;
  transaction_category := CASE WHEN NEW.payment_type = 'incoming' THEN 'Payment Received' ELSE 'Payment Sent' END;
  transaction_description := CASE WHEN NEW.payment_type = 'incoming' THEN 'Incoming payment from ' ELSE 'Outgoing payment to ' END
    || NEW.party || CASE WHEN COALESCE(NEW.note, '') <> '' THEN ' - ' || NEW.note ELSE '' END;

  IF TG_OP = 'UPDATE' AND OLD.transaction_id IS NOT NULL THEN
    UPDATE public.erp_transactions
    SET transaction_type = transaction_kind, category = transaction_category,
        amount = NEW.amount, transaction_date = NEW.payment_date, description = transaction_description
    WHERE id = OLD.transaction_id AND user_id = NEW.user_id
    RETURNING id INTO linked_transaction_id;
  END IF;

  IF linked_transaction_id IS NULL THEN
    INSERT INTO public.erp_transactions
      (user_id, transaction_type, category, amount, transaction_date, description, source_payment_id)
    VALUES
      (NEW.user_id, transaction_kind, transaction_category, NEW.amount, NEW.payment_date, transaction_description, NEW.id)
    RETURNING id INTO linked_transaction_id;
    UPDATE public.erp_payments SET transaction_id = linked_transaction_id WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

-- ─── 6. Invoice status transitions ───────────────────────────────────────────
-- paid / unpaid / overdue are derived from payments; `void` is terminal and
-- needs a reason.

CREATE OR REPLACE FUNCTION public.erp_guard_invoice_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'void' AND NEW.status IS DISTINCT FROM 'void' THEN
    RAISE EXCEPTION 'Voided invoices cannot be reopened';
  END IF;
  IF NEW.status = 'void' AND OLD.status IS DISTINCT FROM 'void'
     AND char_length(trim(COALESCE(NEW.void_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'A reason is required to void an invoice';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_guard_invoice_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_invoice_status ON public.erp_invoices;
CREATE TRIGGER trg_guard_invoice_status
  BEFORE UPDATE OF status ON public.erp_invoices
  FOR EACH ROW EXECUTE FUNCTION public.erp_guard_invoice_status();

-- ─── 7. Correction RPCs ───────────────────────────────────────────────────────

-- Voids a payment: keeps the row, writes an opposite cash transaction, and
-- recomputes the invoice balance (via trg_sync_invoice_after_payment).
-- Retrying returns the same reversal and never writes a second one.
CREATE OR REPLACE FUNCTION public.erp_void_payment(p_payment_id UUID, p_reason TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payment public.erp_payments%ROWTYPE;
  reason TEXT;
  reversal_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO payment FROM public.erp_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  PERFORM public.erp__authorize(payment.user_id, payment.workspace_id, 'payments', 'Payment');
  IF payment.voided_at IS NOT NULL THEN RETURN payment.reversal_transaction_id; END IF;
  reason := public.erp__require_reason(p_reason, 'void a payment');

  INSERT INTO public.erp_transactions
    (user_id, transaction_type, category, amount, transaction_date, description, source_payment_id, is_reversal)
  VALUES
    (payment.user_id,
     CASE WHEN payment.payment_type = 'incoming' THEN 'expense'::public.transaction_type ELSE 'income'::public.transaction_type END,
     'Payment Voided', payment.amount, CURRENT_DATE,
     'Reversal of ' || payment.payment_type::TEXT || ' payment (' || payment.party || ', ' || payment.payment_date::TEXT || '): ' || reason,
     payment.id, true)
  RETURNING id INTO reversal_id;

  PERFORM set_config('erp.payment_void', 'on', true);
  UPDATE public.erp_payments
  SET voided_at = now(), voided_by = auth.uid(), void_reason = reason, reversal_transaction_id = reversal_id
  WHERE id = payment.id;
  PERFORM set_config('erp.payment_void', 'off', true);

  RETURN reversal_id;
END;
$$;

-- Voids an invoice that has no remaining (non-void) payments. Invoices created
-- from a sales order are voided by cancelling that order instead.
CREATE OR REPLACE FUNCTION public.erp_void_invoice(p_invoice_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invoice public.erp_invoices%ROWTYPE;
  reason TEXT;
  order_status public.so_status;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO invoice FROM public.erp_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  PERFORM public.erp__authorize(invoice.user_id, invoice.workspace_id, 'payments', 'Invoice');
  IF invoice.status = 'void' THEN RETURN; END IF;
  reason := public.erp__require_reason(p_reason, 'void an invoice');

  IF invoice.sales_order_id IS NOT NULL THEN
    SELECT status INTO order_status FROM public.erp_sales_orders WHERE id = invoice.sales_order_id;
    IF order_status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'This invoice belongs to a sales order; cancel the sales order to void it';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.erp_payments WHERE invoice_id = invoice.id AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'Void the payments recorded on this invoice first';
  END IF;

  UPDATE public.erp_invoices
  SET status = 'void', payment_state = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = reason
  WHERE id = invoice.id;
END;
$$;

-- ─── 8. Workspace-aware invoice RPCs ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_create_invoice_v2(
  p_workspace_id UUID,
  p_customer_id UUID,
  p_customer_name TEXT,
  p_invoice_date DATE,
  p_due_date DATE,
  p_total NUMERIC(15,2)
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  workspace UUID;
  owner UUID;
  canonical_customer_name TEXT;
  new_invoice_id UUID;
BEGIN
  workspace := public.erp__resolve_workspace(p_workspace_id, 'invoicing');
  SELECT owner_id INTO owner FROM public.erp_workspaces WHERE id = workspace;
  IF p_total IS NULL OR p_total < 0 THEN RAISE EXCEPTION 'Invoice total cannot be negative'; END IF;

  IF p_customer_id IS NOT NULL THEN
    SELECT name INTO canonical_customer_name FROM public.erp_customers
    WHERE id = p_customer_id AND workspace_id = workspace;
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this account'; END IF;
  ELSE
    canonical_customer_name := left(trim(COALESCE(p_customer_name, '')), 200);
    IF canonical_customer_name = '' THEN RAISE EXCEPTION 'Customer name is required'; END IF;
  END IF;

  INSERT INTO public.erp_invoices
    (user_id, workspace_id, created_by, customer_id, customer_name, invoice_date, due_date, status, total)
  VALUES
    (owner, workspace, auth.uid(), p_customer_id, canonical_customer_name,
     COALESCE(p_invoice_date, CURRENT_DATE), COALESCE(p_due_date, CURRENT_DATE), 'unpaid', p_total)
  RETURNING id INTO new_invoice_id;
  RETURN new_invoice_id;
END;
$$;

-- Legacy signature: same behaviour, in the caller's personal workspace.
CREATE OR REPLACE FUNCTION public.erp_create_invoice(
  p_customer_id UUID,
  p_customer_name TEXT,
  p_invoice_date DATE,
  p_due_date DATE,
  p_total NUMERIC(15,2)
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.erp_create_invoice_v2(NULL, p_customer_id, p_customer_name, p_invoice_date, p_due_date, p_total);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_issue_invoice_from_sales_order(
  p_sales_order_id UUID,
  p_due_date DATE DEFAULT (CURRENT_DATE + 30)
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  order_row public.erp_sales_orders%ROWTYPE;
  invoice_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO order_row FROM public.erp_sales_orders
  WHERE id = p_sales_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales order not found'; END IF;
  PERFORM public.erp__authorize(order_row.user_id, order_row.workspace_id, 'invoicing', 'Sales order');

  -- Repeated requests return the existing invoice and never duplicate it.
  SELECT id INTO invoice_id FROM public.erp_invoices
  WHERE sales_order_id = order_row.id AND user_id = order_row.user_id;
  IF invoice_id IS NOT NULL THEN RETURN invoice_id; END IF;
  IF order_row.status <> 'draft' THEN RAISE EXCEPTION 'Only draft orders can be invoiced'; END IF;

  INSERT INTO public.erp_invoices
    (user_id, workspace_id, created_by, customer_id, customer_name, invoice_date, due_date, status, total, sales_order_id)
  VALUES
    (order_row.user_id, order_row.workspace_id, auth.uid(), order_row.customer_id, order_row.customer_name,
     CURRENT_DATE, GREATEST(p_due_date, CURRENT_DATE), 'unpaid', order_row.total, order_row.id)
  RETURNING id INTO invoice_id;

  UPDATE public.erp_sales_orders SET status = 'invoiced', updated_at = NOW()
  WHERE id = order_row.id;
  RETURN invoice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_void_payment(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_void_invoice(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_create_invoice_v2(UUID, UUID, TEXT, DATE, DATE, NUMERIC) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_create_invoice(UUID, TEXT, DATE, DATE, NUMERIC) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_issue_invoice_from_sales_order(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_void_payment(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_void_invoice(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_invoice_v2(UUID, UUID, TEXT, DATE, DATE, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_invoice(UUID, TEXT, DATE, DATE, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_issue_invoice_from_sales_order(UUID, DATE) TO authenticated;

-- ─── 9. Backfill derived invoice balances ────────────────────────────────────

SELECT set_config('erp.maintenance', 'on', false);
DO $$
DECLARE invoice_record RECORD;
BEGIN
  FOR invoice_record IN SELECT id FROM public.erp_invoices LOOP
    PERFORM public.erp_refresh_invoice_status(invoice_record.id);
  END LOOP;
END;
$$;
UPDATE public.erp_transactions t
SET source_payment_id = p.id
FROM public.erp_payments p
WHERE p.transaction_id = t.id AND t.source_payment_id IS NULL;
SELECT set_config('erp.maintenance', 'off', false);
