-- ─── Foreign-currency invoices and payments ─────────────────────────────────
-- Additive. Invoices (and the payments that settle them) can be in another
-- currency with an exchange rate to the workspace's base currency. Existing
-- rows are base currency (currency NULL, rate 1) and behave as before.
--
--   • base_total / base_amount: the base-currency value (stored, generated).
--   • Payments on an invoice always use the invoice's currency; their rate
--     defaults to the invoice's rate.
--   • Ledger: invoices at the invoice rate; settlement at the payment rate;
--     the difference goes to "Exchange differences" (4200).
--   • Purchase orders stay in the base currency.
--
-- Rollback: supabase/snippets/rollback_20260930010000_erp_multi_currency.sql

ALTER TABLE public.erp_invoices
  ADD COLUMN IF NOT EXISTS currency TEXT,
  ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1;
ALTER TABLE public.erp_payments
  ADD COLUMN IF NOT EXISTS currency TEXT,
  ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'erp_invoices' AND column_name = 'base_total') THEN
    ALTER TABLE public.erp_invoices ADD COLUMN base_total NUMERIC(15,2) GENERATED ALWAYS AS (round(total * fx_rate, 2)) STORED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'erp_payments' AND column_name = 'base_amount') THEN
    ALTER TABLE public.erp_payments ADD COLUMN base_amount NUMERIC(15,2) GENERATED ALWAYS AS (round(amount * fx_rate, 2)) STORED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_invoices_currency_check') THEN
    ALTER TABLE public.erp_invoices ADD CONSTRAINT erp_invoices_currency_check
      CHECK ((currency IS NULL AND fx_rate = 1) OR (currency ~ '^[A-Z]{3}$' AND fx_rate > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_payments_currency_check') THEN
    ALTER TABLE public.erp_payments ADD CONSTRAINT erp_payments_currency_check
      CHECK ((currency IS NULL AND fx_rate = 1) OR (currency ~ '^[A-Z]{3}$' AND fx_rate > 0));
  END IF;
END;
$$;

-- Base currency is stored as NULL; a foreign currency needs its rate.
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

-- Payments on an invoice use its currency (rate defaults to the invoice's);
-- payments on purchase orders are in the base currency.
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

REVOKE ALL ON FUNCTION public.erp_normalize_invoice_currency() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_normalize_payment_currency() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_erp_invoice_currency ON public.erp_invoices;
CREATE TRIGGER trg_erp_invoice_currency BEFORE INSERT OR UPDATE OF currency, fx_rate ON public.erp_invoices
  FOR EACH ROW EXECUTE FUNCTION public.erp_normalize_invoice_currency();
-- Named to run before trg_validate_invoice_payment (triggers fire alphabetically).
DROP TRIGGER IF EXISTS trg_erp_payment_currency ON public.erp_payments;
CREATE TRIGGER trg_erp_payment_currency BEFORE INSERT OR UPDATE OF currency, fx_rate, invoice_id ON public.erp_payments
  FOR EACH ROW EXECUTE FUNCTION public.erp_normalize_payment_currency();

-- Invoice in a foreign currency (otherwise identical to erp_create_invoice_v3).
CREATE OR REPLACE FUNCTION public.erp_create_invoice_v4(
  p_workspace_id UUID, p_customer_id UUID, p_customer_name TEXT, p_invoice_date DATE, p_due_date DATE,
  p_subtotal NUMERIC(15,2), p_tax_rate NUMERIC(5,2), p_currency TEXT, p_fx_rate NUMERIC
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE new_id UUID;
BEGIN
  IF p_currency IS NOT NULL AND p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Currency must be a 3-letter ISO code';
  END IF;
  IF p_currency IS NOT NULL AND (p_fx_rate IS NULL OR p_fx_rate <= 0) THEN
    RAISE EXCEPTION 'Enter the exchange rate to the base currency';
  END IF;
  -- Currency and rate are set before the invoice is posted to the ledger.
  PERFORM set_config('erp.new_invoice_currency', COALESCE(p_currency, ''), true);
  PERFORM set_config('erp.new_invoice_rate', COALESCE(p_fx_rate, 1)::TEXT, true);
  new_id := public.erp_create_invoice_v3(p_workspace_id, p_customer_id, p_customer_name, p_invoice_date, p_due_date, p_subtotal, p_tax_rate);
  PERFORM set_config('erp.new_invoice_currency', '', true);
  PERFORM set_config('erp.new_invoice_rate', '', true);
  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_create_invoice_v4(UUID, UUID, TEXT, DATE, DATE, NUMERIC, NUMERIC, TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_create_invoice_v4(UUID, UUID, TEXT, DATE, DATE, NUMERIC, NUMERIC, TEXT, NUMERIC) TO authenticated;

-- Picks up the currency passed by erp_create_invoice_v4 (transaction-local).
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
REVOKE ALL ON FUNCTION public.erp_invoice_currency_from_request() FROM PUBLIC, anon, authenticated;
-- Runs before trg_erp_invoice_currency (alphabetical order).
DROP TRIGGER IF EXISTS trg_erp_invoice_a_currency_request ON public.erp_invoices;
CREATE TRIGGER trg_erp_invoice_a_currency_request BEFORE INSERT ON public.erp_invoices
  FOR EACH ROW EXECUTE FUNCTION public.erp_invoice_currency_from_request();

-- ─── Ledger ───────────────────────────────────────────────────────────────────

-- The default chart gains "Exchange differences" (existing charts get it on next use).
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
    (p_user_id, '4200', 'Exchange differences', 'income', 'fx'),
    (p_user_id, '5000', 'Cost of goods sold', 'expense', 'cogs'),
    (p_user_id, '6000', 'Operating expenses', 'expense', 'expenses'),
    (p_user_id, '6100', 'Inventory adjustments', 'expense', 'inventory_adjust')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.erp_accounting_settings (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
END;
$$;

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

-- Settlement at the payment rate; receivable released at the invoice rate.
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

-- The cash book is in the base currency: rows mirrored from a foreign-currency
-- payment (and its void reversal) carry the base amount. Runs after the
-- mirroring trigger (alphabetical order), as a nested bookkeeping update.
CREATE OR REPLACE FUNCTION public.erp_payment_cashbook_base()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.fx_rate = 1 THEN RETURN NULL; END IF;
  UPDATE public.erp_transactions SET amount = NEW.base_amount
  WHERE source_payment_id = NEW.id AND amount = NEW.amount AND amount <> NEW.base_amount;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_payment_cashbook_base() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_zz_payment_cashbook_base ON public.erp_payments;
CREATE TRIGGER trg_zz_payment_cashbook_base AFTER INSERT OR UPDATE OF voided_at ON public.erp_payments
  FOR EACH ROW EXECUTE FUNCTION public.erp_payment_cashbook_base();
