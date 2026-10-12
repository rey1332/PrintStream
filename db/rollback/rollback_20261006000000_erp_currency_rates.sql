-- Rollback for 20261006000000_erp_currency_rates.sql.
-- Run only after redeploying an app version without Settings → Currencies.
--
-- Refuses to run while purchase or sales orders in another currency, or
-- exchange-difference (fx_settlement) journal entries, exist: the previous
-- version cannot represent them. Void/cancel them first, or keep this version.
--
-- What it does:
--   * restores the previous bodies of the functions this migration replaced
--     (settings, invoice/payment currency triggers, ledger posting, receipt
--     costing, sales-order invoicing);
--   * drops the rate table, the currency list and the currency audit log
--     (export them first if they are needed), and the new functions;
--   * drops the rate provenance columns and the order/receipt currency columns.
-- What it keeps: invoice and payment amounts, currencies and rates; fx_rate
-- stays NUMERIC(24,12) (wider than before, so no value is truncated), and the
-- generated base_total/base_amount columns keep their values. Ledger entries
-- are not touched.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.erp_purchase_orders WHERE currency IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.erp_sales_orders WHERE currency IS NOT NULL) THEN
    RAISE EXCEPTION 'Rollback refused: foreign-currency purchase or sales orders exist';
  END IF;
  IF EXISTS (SELECT 1 FROM public.erp_journal_entries WHERE source_type = 'fx_settlement') THEN
    RAISE EXCEPTION 'Rollback refused: exchange-difference (fx_settlement) journal entries exist';
  END IF;
END;
$$;

-- New triggers.
DROP TRIGGER IF EXISTS trg_erp_guard_base_currency ON public.erp_accounting_settings;
DROP TRIGGER IF EXISTS trg_erp_po_currency ON public.erp_purchase_orders;
DROP TRIGGER IF EXISTS trg_erp_so_currency ON public.erp_sales_orders;
DROP TRIGGER IF EXISTS trg_erp_fx_receipt_rate ON public.erp_fulfillment_events;

-- Previous function bodies.
-- From 20260929010000_erp_sales_tax.sql
CREATE OR REPLACE FUNCTION public.erp_accounting_settings_set(p_workspace_id UUID, p_base_currency TEXT, p_lock_date DATE, p_sales_tax_rate NUMERIC)
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
  IF p_sales_tax_rate IS NULL OR p_sales_tax_rate < 0 OR p_sales_tax_rate > 100 THEN
    RAISE EXCEPTION 'Tax rate must be between 0 and 100 percent' USING ERRCODE = 'P0001';
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
  SET base_currency = p_base_currency, lock_date = p_lock_date, sales_tax_rate = p_sales_tax_rate,
      updated_at = now(), updated_by = auth.uid()
  WHERE user_id = owner;
END;
$$;

-- From 20260930000000_erp_inventory_costing.sql
CREATE OR REPLACE FUNCTION public.erp_fulfillment_line_cost()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.unit_cost IS NULL THEN
    IF NEW.purchase_order_item_id IS NOT NULL THEN
      SELECT price INTO NEW.unit_cost FROM public.erp_purchase_order_items WHERE id = NEW.purchase_order_item_id;
    ELSIF NEW.product_id IS NOT NULL THEN
      NEW.unit_cost := public.erp__unit_cost(NEW.product_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- From 20260930000000_erp_inventory_costing.sql
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
  rate NUMERIC := 0;
  tax NUMERIC := 0;
  lines JSONB;
  memo TEXT;
BEGIN
  SELECT * INTO ev FROM public.erp_fulfillment_events WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF ev.is_reversal AND ev.reverses_event_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.erp_journal_entries WHERE user_id = ev.user_id AND source_key = ev.kind || ':' || ev.reverses_event_id) THEN
    RETURN public.erp_gl__reverse(ev.user_id, ev.kind || ':' || ev.reverses_event_id, ev.created_at::DATE,
      'Reversal of ' || replace(ev.kind, '_', ' '), ev.kind, ev.id, ev.kind || ':' || ev.id);
  END IF;

  IF ev.kind = 'purchase_receipt' THEN
    SELECT COALESCE(SUM(l.quantity * COALESCE(l.unit_cost, i.price)) FILTER (WHERE l.product_id IS NOT NULL), 0),
           COALESCE(SUM(l.quantity * COALESCE(l.unit_cost, i.price)) FILTER (WHERE l.product_id IS NULL), 0)
    INTO stock_value, other_value
    FROM public.erp_fulfillment_event_lines l
    JOIN public.erp_purchase_order_items i ON i.id = l.purchase_order_item_id
    WHERE l.event_id = ev.id;
    SELECT tax_rate INTO rate FROM public.erp_purchase_orders WHERE id = ev.purchase_order_id;
    tax := round((stock_value + other_value) * COALESCE(rate, 0) / 100, 2);
    lines := jsonb_build_array(
      jsonb_build_object('key', 'inventory', 'debit', stock_value),
      jsonb_build_object('key', 'expenses', 'debit', other_value),
      jsonb_build_object('key', 'tax_in', 'debit', tax),
      jsonb_build_object('key', 'ap', 'credit', stock_value + other_value + tax));
    memo := 'Goods received';
  ELSE
    SELECT COALESCE(SUM(l.quantity * COALESCE(l.unit_cost, public.erp__unit_cost(l.product_id))), 0) INTO stock_value
    FROM public.erp_fulfillment_event_lines l
    WHERE l.event_id = ev.id AND l.product_id IS NOT NULL;
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

-- From 20260929000000_erp_general_ledger.sql
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

-- From 20260929000000_erp_general_ledger.sql
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

-- From 20260930010000_erp_multi_currency.sql
CREATE OR REPLACE FUNCTION public.erp_gl__on_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  total_base NUMERIC := round(NEW.total * NEW.fx_rate, 2);
  tax_base NUMERIC := round(NEW.tax_amount * NEW.fx_rate, 2);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::TEXT <> 'void' THEN
      PERFORM public.erp_gl__post(NEW.user_id, NEW.invoice_date,
        'Invoice to ' || NEW.customer_name || CASE WHEN NEW.currency IS NOT NULL THEN ' (' || NEW.total || ' ' || NEW.currency || ' @ ' || NEW.fx_rate || ')' ELSE '' END,
        'invoice', NEW.id, 'invoice:' || NEW.id,
        jsonb_build_array(
          jsonb_build_object('key', 'ar', 'debit', total_base),
          jsonb_build_object('key', 'revenue', 'credit', total_base - tax_base),
          jsonb_build_object('key', 'tax_out', 'credit', tax_base)));
    END IF;
  ELSIF NEW.status::TEXT = 'void' AND OLD.status::TEXT <> 'void' THEN
    PERFORM public.erp_gl__reverse(NEW.user_id, 'invoice:' || NEW.id, COALESCE(NEW.voided_at::DATE, CURRENT_DATE),
      'Void of invoice to ' || NEW.customer_name, 'invoice_void', NEW.id, 'invoice_void:' || NEW.id);
  ELSIF NEW.total IS DISTINCT FROM OLD.total AND NEW.status::TEXT <> 'void' THEN
    PERFORM public.erp_gl__post(NEW.user_id, CURRENT_DATE, 'Invoice total changed for ' || NEW.customer_name,
      'invoice_adjust', NEW.id, NULL, public.erp_gl__pair('ar', 'revenue', round((NEW.total - OLD.total) * NEW.fx_rate, 2)));
  END IF;
  RETURN NULL;
END;
$$;

-- From 20260930010000_erp_multi_currency.sql
CREATE OR REPLACE FUNCTION public.erp_gl__payment_lines(p public.erp_payments, p_amount NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cash_base NUMERIC := round(p_amount * p.fx_rate, 2);
  inv_rate NUMERIC;
  ar_base NUMERIC;
BEGIN
  IF p.payment_type::TEXT = 'incoming' AND p.invoice_id IS NOT NULL THEN
    SELECT fx_rate INTO inv_rate FROM public.erp_invoices WHERE id = p.invoice_id;
    ar_base := round(p_amount * COALESCE(inv_rate, p.fx_rate), 2);
    RETURN jsonb_build_array(
      jsonb_build_object('key', 'cash', 'debit', GREATEST(cash_base, 0), 'credit', GREATEST(-cash_base, 0)),
      jsonb_build_object('key', 'ar', 'credit', GREATEST(ar_base, 0), 'debit', GREATEST(-ar_base, 0)),
      jsonb_build_object('key', 'fx', 'credit', GREATEST(cash_base - ar_base, 0), 'debit', GREATEST(ar_base - cash_base, 0)));
  ELSIF p.payment_type::TEXT = 'incoming' THEN
    RETURN public.erp_gl__pair('cash', 'other_income', cash_base);
  ELSE
    RETURN public.erp_gl__pair(CASE WHEN p.purchase_order_id IS NOT NULL THEN 'ap' ELSE 'expenses' END, 'cash', cash_base);
  END IF;
END;
$$;

-- From 20260930010000_erp_multi_currency.sql
CREATE OR REPLACE FUNCTION public.erp_invoice_currency_from_request()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(current_setting('erp.new_invoice_currency', true), '') <> '' THEN
    NEW.currency := current_setting('erp.new_invoice_currency', true);
    NEW.fx_rate := current_setting('erp.new_invoice_rate', true)::NUMERIC;
  END IF;
  RETURN NEW;
END;
$$;

-- From 20260930010000_erp_multi_currency.sql
CREATE OR REPLACE FUNCTION public.erp_normalize_invoice_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE base TEXT;
BEGIN
  IF NEW.currency IS NOT NULL THEN
    SELECT base_currency INTO base FROM public.erp_accounting_settings WHERE user_id = NEW.user_id;
    IF NEW.currency = COALESCE(base, 'USD') THEN NEW.currency := NULL; END IF;
  END IF;
  IF NEW.currency IS NULL THEN NEW.fx_rate := 1; END IF;
  RETURN NEW;
END;
$$;

-- From 20260930010000_erp_multi_currency.sql
CREATE OR REPLACE FUNCTION public.erp_normalize_payment_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv_currency TEXT;
  inv_rate NUMERIC;
  base TEXT;
BEGIN
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT currency, fx_rate INTO inv_currency, inv_rate FROM public.erp_invoices WHERE id = NEW.invoice_id;
    IF NEW.currency IS NOT NULL AND NEW.currency IS DISTINCT FROM inv_currency THEN
      SELECT base_currency INTO base FROM public.erp_accounting_settings WHERE user_id = NEW.user_id;
      IF NOT (inv_currency IS NULL AND NEW.currency = COALESCE(base, 'USD')) THEN
        RAISE EXCEPTION 'A payment must be in the invoice currency (%)', COALESCE(inv_currency, COALESCE(base, 'USD'));
      END IF;
    END IF;
    NEW.currency := inv_currency;
    IF inv_currency IS NOT NULL AND (TG_OP = 'INSERT' AND NEW.fx_rate = 1) THEN NEW.fx_rate := inv_rate; END IF;
  ELSIF NEW.purchase_order_id IS NOT NULL THEN
    NEW.currency := NULL;
  ELSIF NEW.currency IS NOT NULL THEN
    SELECT base_currency INTO base FROM public.erp_accounting_settings WHERE user_id = NEW.user_id;
    IF NEW.currency = COALESCE(base, 'USD') THEN NEW.currency := NULL; END IF;
  END IF;
  IF NEW.currency IS NULL THEN NEW.fx_rate := 1; END IF;
  RETURN NEW;
END;
$$;

-- From 20260926020000_erp_finance_rules.sql
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

-- Previous trigger columns for payments.
DROP TRIGGER IF EXISTS trg_erp_payment_currency ON public.erp_payments;
CREATE TRIGGER trg_erp_payment_currency BEFORE INSERT OR UPDATE OF currency, fx_rate, invoice_id ON public.erp_payments
  FOR EACH ROW EXECUTE FUNCTION public.erp_normalize_payment_currency();

-- New functions.
DROP FUNCTION IF EXISTS public.erp_issue_invoice_from_sales_order_v2(UUID, DATE, NUMERIC);
DROP FUNCTION IF EXISTS public.erp_record_purchase_receipt_v2(UUID, JSONB, UUID, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS public.erp_create_sales_order_v3(UUID, UUID, TEXT, DATE, TEXT, JSONB, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS public.erp_create_purchase_order_v3(UUID, UUID, TEXT, DATE, TEXT, JSONB, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS public.erp_create_invoice_v5(UUID, UUID, TEXT, DATE, DATE, NUMERIC, NUMERIC, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS public.erp_confirm_base_currency(UUID, TEXT, BIGINT);
DROP FUNCTION IF EXISTS public.erp_currency_preview(UUID);
DROP FUNCTION IF EXISTS public.erp_currency_settings_get(UUID);
DROP FUNCTION IF EXISTS public.erp_import_exchange_rates(UUID, TEXT, TIMESTAMPTZ, JSONB);
DROP FUNCTION IF EXISTS public.erp_add_exchange_rate(UUID, TEXT, TEXT, NUMERIC, DATE, TEXT);
DROP FUNCTION IF EXISTS public.erp_exchange_rate_lookup(UUID, TEXT, TEXT, DATE);
DROP FUNCTION IF EXISTS public.erp_fx__settle(TEXT, UUID);
DROP FUNCTION IF EXISTS public.erp_fx__po_carrying_rate(UUID, NUMERIC);
DROP FUNCTION IF EXISTS public.erp_fx__num(NUMERIC);
DROP FUNCTION IF EXISTS public.erp_fx__change_base(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_fx__resolve(UUID, TEXT, DATE, NUMERIC);
DROP FUNCTION IF EXISTS public.erp_fx__require_rate(UUID, TEXT, TEXT, DATE);
DROP FUNCTION IF EXISTS public.erp_fx__find_rate(UUID, TEXT, TEXT, DATE);
DROP FUNCTION IF EXISTS public.erp_fx__max_age_days();
DROP FUNCTION IF EXISTS public.erp_fx__has_records(UUID);
DROP FUNCTION IF EXISTS public.erp_fx__base(UUID);
DROP FUNCTION IF EXISTS public.erp_fx__audit(UUID, UUID, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.erp_fx_receipt_rate();
DROP FUNCTION IF EXISTS public.erp_normalize_order_currency();
DROP FUNCTION IF EXISTS public.erp_guard_base_currency();

-- Journal sources as before.
ALTER TABLE public.erp_journal_entries DROP CONSTRAINT IF EXISTS erp_journal_entries_source_type_check;
ALTER TABLE public.erp_journal_entries ADD CONSTRAINT erp_journal_entries_source_type_check CHECK (source_type IN (
  'invoice', 'invoice_void', 'invoice_adjust', 'payment', 'payment_void', 'payment_adjust', 'transaction',
  'purchase_receipt', 'sales_delivery', 'stock_adjustment', 'opening_stock', 'manual', 'manual_reversal'));

-- New columns (and their constraints).
ALTER TABLE public.erp_invoices DROP CONSTRAINT IF EXISTS erp_invoices_fx_source_check,
  DROP COLUMN IF EXISTS fx_rate_date, DROP COLUMN IF EXISTS fx_rate_source, DROP COLUMN IF EXISTS fx_rate_id;
ALTER TABLE public.erp_payments DROP CONSTRAINT IF EXISTS erp_payments_fx_source_check,
  DROP COLUMN IF EXISTS fx_rate_date, DROP COLUMN IF EXISTS fx_rate_source, DROP COLUMN IF EXISTS fx_rate_id;
ALTER TABLE public.erp_purchase_orders DROP CONSTRAINT IF EXISTS erp_purchase_orders_fx_source_check,
  DROP CONSTRAINT IF EXISTS erp_purchase_orders_currency_check, DROP COLUMN IF EXISTS base_total,
  DROP COLUMN IF EXISTS fx_rate_date, DROP COLUMN IF EXISTS fx_rate_source, DROP COLUMN IF EXISTS fx_rate_id,
  DROP COLUMN IF EXISTS fx_rate, DROP COLUMN IF EXISTS currency;
ALTER TABLE public.erp_sales_orders DROP CONSTRAINT IF EXISTS erp_sales_orders_fx_source_check,
  DROP CONSTRAINT IF EXISTS erp_sales_orders_currency_check, DROP COLUMN IF EXISTS base_total,
  DROP COLUMN IF EXISTS fx_rate_date, DROP COLUMN IF EXISTS fx_rate_source, DROP COLUMN IF EXISTS fx_rate_id,
  DROP COLUMN IF EXISTS fx_rate, DROP COLUMN IF EXISTS currency;
ALTER TABLE public.erp_fulfillment_events DROP CONSTRAINT IF EXISTS erp_fulfillment_events_fx_source_check,
  DROP CONSTRAINT IF EXISTS erp_fulfillment_events_currency_check,
  DROP COLUMN IF EXISTS fx_rate_date, DROP COLUMN IF EXISTS fx_rate_source, DROP COLUMN IF EXISTS fx_rate_id,
  DROP COLUMN IF EXISTS fx_rate, DROP COLUMN IF EXISTS currency;
ALTER TABLE public.erp_accounting_settings
  DROP COLUMN IF EXISTS base_currency_confirmed_at, DROP COLUMN IF EXISTS base_currency_confirmed_by;

-- New tables.
DROP TABLE IF EXISTS public.erp_currency_audit;
DROP TABLE IF EXISTS public.erp_exchange_rates;
DROP TABLE IF EXISTS public.erp_currencies;

COMMIT;
