-- ─── ERP Sync Triggers Migration ─────────────────────────────────────────────
-- Automatic synchronization between ERP modules:
-- 1. Sales Order → delivered: reduce inventory (stock out) for each line item
-- 2. Purchase Order → received: increase inventory (stock in) for each line item
-- 3. Payment → created: auto-create erp_transactions record for cash flow

-- ─── 1. FUNCTION: Sync inventory when Sales Order status changes to 'delivered' ──

CREATE OR REPLACE FUNCTION public.erp_so_inventory_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  item_rec RECORD;
BEGIN
  -- Only act when transitioning TO 'delivered'
  IF NEW.status = 'delivered' AND (OLD.status IS DISTINCT FROM 'delivered') THEN
    -- Loop through all line items of this sales order
    FOR item_rec IN
      SELECT product_id, product_name, qty
      FROM public.erp_sales_order_items
      WHERE sales_order_id = NEW.id
        AND product_id IS NOT NULL
    LOOP
      -- Reduce product stock
      UPDATE public.erp_products
      SET current_stock = GREATEST(0, current_stock - item_rec.qty),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = item_rec.product_id
        AND user_id = NEW.user_id;

      -- Record stock movement (out)
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
$func$;

DROP TRIGGER IF EXISTS trg_so_inventory_sync ON public.erp_sales_orders;
CREATE TRIGGER trg_so_inventory_sync
  AFTER UPDATE ON public.erp_sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.erp_so_inventory_sync();

-- ─── 2. FUNCTION: Sync inventory when Purchase Order status changes to 'received' ─

CREATE OR REPLACE FUNCTION public.erp_po_inventory_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  item_rec RECORD;
BEGIN
  -- Only act when transitioning TO 'received'
  IF NEW.status = 'received' AND (OLD.status IS DISTINCT FROM 'received') THEN
    -- Loop through all line items of this purchase order
    FOR item_rec IN
      SELECT product_id, product_name, qty
      FROM public.erp_purchase_order_items
      WHERE purchase_order_id = NEW.id
        AND product_id IS NOT NULL
    LOOP
      -- Increase product stock
      UPDATE public.erp_products
      SET current_stock = current_stock + item_rec.qty,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = item_rec.product_id
        AND user_id = NEW.user_id;

      -- Record stock movement (in)
      INSERT INTO public.erp_stock_movements
        (user_id, product_id, product_name, movement_type, quantity, movement_date, note)
      VALUES
        (NEW.user_id, item_rec.product_id, item_rec.product_name,
         'in'::public.stock_movement_type, item_rec.qty, NEW.order_date,
         'Auto: Purchase Order received - PO#' || NEW.id::TEXT);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS trg_po_inventory_sync ON public.erp_purchase_orders;
CREATE TRIGGER trg_po_inventory_sync
  AFTER UPDATE ON public.erp_purchase_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.erp_po_inventory_sync();

-- ─── 3. FUNCTION: Auto-create transaction when a payment is recorded ─────────

CREATE OR REPLACE FUNCTION public.erp_payment_to_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  txn_type public.transaction_type;
  txn_category TEXT;
  txn_description TEXT;
BEGIN
  -- Map payment type to transaction type
  IF NEW.payment_type = 'incoming' THEN
    txn_type := 'income'::public.transaction_type;
    txn_category := 'Payment Received';
    txn_description := 'Incoming payment from ' || NEW.party ||
      CASE WHEN NEW.note <> '' THEN ' - ' || NEW.note ELSE '' END;
  ELSE
    txn_type := 'expense'::public.transaction_type;
    txn_category := 'Payment Sent';
    txn_description := 'Outgoing payment to ' || NEW.party ||
      CASE WHEN NEW.note <> '' THEN ' - ' || NEW.note ELSE '' END;
  END IF;

  INSERT INTO public.erp_transactions
    (user_id, transaction_type, category, amount, transaction_date, description)
  VALUES
    (NEW.user_id, txn_type, txn_category, NEW.amount, NEW.payment_date, txn_description);

  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS trg_payment_to_transaction ON public.erp_payments;
CREATE TRIGGER trg_payment_to_transaction
  AFTER INSERT ON public.erp_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.erp_payment_to_transaction();

-- ─── 4. FUNCTION: Auto-create transaction when an invoice is created ──────────
-- Creates an "income" transaction for Accounts Receivable tracking

CREATE OR REPLACE FUNCTION public.erp_invoice_to_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
BEGIN
  -- Only on INSERT (new invoice creation)
  INSERT INTO public.erp_transactions
    (user_id, transaction_type, category, amount, transaction_date, description)
  VALUES
    (NEW.user_id, 'income'::public.transaction_type, 'Accounts Receivable',
     NEW.total, NEW.invoice_date,
     'Invoice issued to ' || NEW.customer_name || ' (status: ' || NEW.status::TEXT || ')');

  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS trg_invoice_to_transaction ON public.erp_invoices;
CREATE TRIGGER trg_invoice_to_transaction
  AFTER INSERT ON public.erp_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.erp_invoice_to_transaction();
