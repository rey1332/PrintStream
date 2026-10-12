-- Make the core stock, order-to-cash, and receivables flows consistent.

ALTER TABLE public.erp_invoices
  ADD COLUMN IF NOT EXISTS sales_order_id UUID REFERENCES public.erp_sales_orders(id) ON DELETE SET NULL;

ALTER TABLE public.erp_payments
  ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES public.erp_invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purchase_order_id UUID REFERENCES public.erp_purchase_orders(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_invoices_sales_order_id
  ON public.erp_invoices(sales_order_id)
  WHERE sales_order_id IS NOT NULL;

-- Invoice income is a receivable, not cash. Cash flow is recorded when payment
-- rows are inserted, so remove the old trigger that counted invoices as cash.
DROP TRIGGER IF EXISTS trg_invoice_to_transaction ON public.erp_invoices;
DELETE FROM public.erp_transactions
WHERE category = 'Accounts Receivable'
  AND description LIKE 'Invoice issued to %';

ALTER TABLE public.erp_payments
  ADD COLUMN IF NOT EXISTS transaction_id UUID REFERENCES public.erp_transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_erp_payments_invoice_id ON public.erp_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_erp_payments_purchase_order_id ON public.erp_payments(purchase_order_id);

-- New payment edits and deletions now keep their cash-flow row in sync.
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
      (user_id, transaction_type, category, amount, transaction_date, description)
    VALUES
      (NEW.user_id, transaction_kind, transaction_category, NEW.amount, NEW.payment_date, transaction_description)
    RETURNING id INTO linked_transaction_id;
    UPDATE public.erp_payments SET transaction_id = linked_transaction_id WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_to_transaction ON public.erp_payments;
CREATE TRIGGER trg_payment_to_transaction
  AFTER INSERT OR DELETE OR UPDATE OF payment_type, party, amount, payment_date, note
  ON public.erp_payments
  FOR EACH ROW EXECUTE FUNCTION public.erp_payment_to_transaction();

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
BEGIN
  SELECT * INTO invoice_row FROM public.erp_invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO paid_total
  FROM public.erp_payments
  WHERE invoice_id = p_invoice_id
    AND user_id = invoice_row.user_id
    AND payment_type = 'incoming';

  IF paid_total >= invoice_row.total THEN
    next_status := 'paid';
  ELSIF invoice_row.due_date < CURRENT_DATE THEN
    next_status := 'overdue';
  ELSE
    next_status := 'unpaid';
  END IF;

  UPDATE public.erp_invoices SET status = next_status WHERE id = p_invoice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_refresh_invoice_status(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.erp_sync_invoice_after_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.invoice_id IS NOT NULL THEN
    PERFORM public.erp_refresh_invoice_status(OLD.invoice_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.invoice_id IS NOT NULL THEN
    PERFORM public.erp_refresh_invoice_status(NEW.invoice_id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_invoice_after_payment ON public.erp_payments;
CREATE TRIGGER trg_sync_invoice_after_payment
  AFTER INSERT OR UPDATE OR DELETE ON public.erp_payments
  FOR EACH ROW EXECUTE FUNCTION public.erp_sync_invoice_after_payment();

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
  IF NEW.invoice_id IS NOT NULL THEN
    IF NEW.payment_type <> 'incoming' THEN
      RAISE EXCEPTION 'Invoice payments must be incoming';
    END IF;

    SELECT * INTO invoice_row
    FROM public.erp_invoices
    WHERE id = NEW.invoice_id AND user_id = NEW.user_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found for this account'; END IF;

    IF TG_OP = 'UPDATE' THEN
      SELECT COALESCE(SUM(amount), 0) INTO other_payments
      FROM public.erp_payments
      WHERE invoice_id = NEW.invoice_id AND user_id = NEW.user_id AND id <> OLD.id;
    ELSE
      SELECT COALESCE(SUM(amount), 0) INTO other_payments
      FROM public.erp_payments
      WHERE invoice_id = NEW.invoice_id AND user_id = NEW.user_id;
    END IF;

    IF other_payments + NEW.amount > invoice_row.total + 0.01 THEN
      RAISE EXCEPTION 'Payment exceeds the invoice balance';
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
    IF TG_OP = 'UPDATE' THEN
      SELECT COALESCE(SUM(amount), 0) INTO other_payments
      FROM public.erp_payments
      WHERE purchase_order_id = NEW.purchase_order_id AND user_id = NEW.user_id AND id <> OLD.id;
    ELSE
      SELECT COALESCE(SUM(amount), 0) INTO other_payments
      FROM public.erp_payments
      WHERE purchase_order_id = NEW.purchase_order_id AND user_id = NEW.user_id;
    END IF;
    IF other_payments + NEW.amount > purchase_order_row.total + 0.01 THEN
      RAISE EXCEPTION 'Payment exceeds the purchase order balance';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_invoice_payment ON public.erp_payments;
CREATE TRIGGER trg_validate_invoice_payment
  BEFORE INSERT OR UPDATE ON public.erp_payments
  FOR EACH ROW EXECUTE FUNCTION public.erp_validate_invoice_payment();

-- Issue an invoice and advance the order in one database transaction. Repeated
-- requests return the existing invoice and never duplicate it.
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
  WHERE id = p_sales_order_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales order not found'; END IF;

  SELECT id INTO invoice_id FROM public.erp_invoices
  WHERE sales_order_id = order_row.id AND user_id = auth.uid();
  IF invoice_id IS NOT NULL THEN RETURN invoice_id; END IF;
  IF order_row.status <> 'draft' THEN RAISE EXCEPTION 'Only draft orders can be invoiced'; END IF;

  INSERT INTO public.erp_invoices
    (user_id, customer_id, customer_name, invoice_date, due_date, status, total, sales_order_id)
  VALUES
    (order_row.user_id, order_row.customer_id, order_row.customer_name,
     CURRENT_DATE, GREATEST(p_due_date, CURRENT_DATE), 'unpaid', order_row.total, order_row.id)
  RETURNING id INTO invoice_id;

  UPDATE public.erp_sales_orders SET status = 'invoiced', updated_at = NOW()
  WHERE id = order_row.id;
  RETURN invoice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_issue_invoice_from_sales_order(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_issue_invoice_from_sales_order(UUID, DATE) TO authenticated;

-- Manual stock adjustments are written atomically with the corresponding
-- movement; stock can never silently become negative.
CREATE OR REPLACE FUNCTION public.erp_adjust_stock(
  p_product_id UUID,
  p_movement_type public.stock_movement_type,
  p_quantity INTEGER,
  p_note TEXT DEFAULT ''
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  product_row public.erp_products%ROWTYPE;
  next_stock INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_quantity <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero'; END IF;
  SELECT * INTO product_row FROM public.erp_products
  WHERE id = p_product_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;

  next_stock := product_row.current_stock + CASE
    WHEN p_movement_type = 'in' THEN p_quantity ELSE -p_quantity END;
  IF next_stock < 0 THEN RAISE EXCEPTION 'Insufficient stock'; END IF;

  UPDATE public.erp_products SET current_stock = next_stock, updated_at = NOW()
  WHERE id = product_row.id;
  INSERT INTO public.erp_stock_movements
    (user_id, product_id, product_name, movement_type, quantity, movement_date, note)
  VALUES
    (auth.uid(), product_row.id, product_row.name, p_movement_type, p_quantity, CURRENT_DATE, COALESCE(p_note, ''));
END;
$$;

REVOKE ALL ON FUNCTION public.erp_adjust_stock(UUID, public.stock_movement_type, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_adjust_stock(UUID, public.stock_movement_type, INTEGER, TEXT) TO authenticated;

-- Do not allow delivery to consume more inventory than is available. A raised
-- exception rolls the entire status change and all movement rows back.
CREATE OR REPLACE FUNCTION public.erp_so_inventory_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE item_rec RECORD;
  stock_now INTEGER;
BEGIN
  IF NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM 'delivered' THEN
    FOR item_rec IN
      SELECT product_id, product_name, qty
      FROM public.erp_sales_order_items
      WHERE sales_order_id = NEW.id AND product_id IS NOT NULL
    LOOP
      SELECT current_stock INTO stock_now
      FROM public.erp_products
      WHERE id = item_rec.product_id AND user_id = NEW.user_id
      FOR UPDATE;
      IF stock_now IS NULL THEN RAISE EXCEPTION 'Order product not found'; END IF;
      IF stock_now < item_rec.qty THEN
        RAISE EXCEPTION 'Insufficient stock for % (available %, required %)', item_rec.product_name, stock_now, item_rec.qty;
      END IF;

      UPDATE public.erp_products
      SET current_stock = current_stock - item_rec.qty, updated_at = NOW()
      WHERE id = item_rec.product_id AND user_id = NEW.user_id;
      INSERT INTO public.erp_stock_movements
        (user_id, product_id, product_name, movement_type, quantity, movement_date, note)
      VALUES
        (NEW.user_id, item_rec.product_id, item_rec.product_name,
         'out'::public.stock_movement_type, item_rec.qty, NEW.order_date,
         'Auto: Sales Order delivered - SO#' || NEW.id::TEXT);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

-- Backfill the now-derived invoice state for invoices with existing payments.
DO $$
DECLARE invoice_record RECORD;
BEGIN
  FOR invoice_record IN SELECT id FROM public.erp_invoices LOOP
    PERFORM public.erp_refresh_invoice_status(invoice_record.id);
  END LOOP;
END;
$$;
