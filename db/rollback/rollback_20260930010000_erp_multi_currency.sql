-- Rollback for 20260930010000_erp_multi_currency.sql. Only safe while no
-- foreign-currency invoice or payment exists (otherwise their amounts would
-- be read as base currency).
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.erp_invoices WHERE currency IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.erp_payments WHERE currency IS NOT NULL) THEN
    RAISE EXCEPTION 'Foreign-currency documents exist; convert or void them before rolling back';
  END IF;
END;
$$;
DROP TRIGGER IF EXISTS trg_zz_payment_cashbook_base ON public.erp_payments;
DROP TRIGGER IF EXISTS trg_erp_payment_currency ON public.erp_payments;
DROP TRIGGER IF EXISTS trg_erp_invoice_currency ON public.erp_invoices;
DROP TRIGGER IF EXISTS trg_erp_invoice_a_currency_request ON public.erp_invoices;
DROP FUNCTION IF EXISTS public.erp_payment_cashbook_base();
DROP FUNCTION IF EXISTS public.erp_normalize_payment_currency();
DROP FUNCTION IF EXISTS public.erp_normalize_invoice_currency();
DROP FUNCTION IF EXISTS public.erp_invoice_currency_from_request();
DROP FUNCTION IF EXISTS public.erp_create_invoice_v4(UUID, UUID, TEXT, DATE, DATE, NUMERIC, NUMERIC, TEXT, NUMERIC);
ALTER TABLE public.erp_invoices DROP CONSTRAINT IF EXISTS erp_invoices_currency_check;
ALTER TABLE public.erp_payments DROP CONSTRAINT IF EXISTS erp_payments_currency_check;
ALTER TABLE public.erp_invoices DROP COLUMN IF EXISTS base_total, DROP COLUMN IF EXISTS fx_rate, DROP COLUMN IF EXISTS currency;
ALTER TABLE public.erp_payments DROP COLUMN IF EXISTS base_amount, DROP COLUMN IF EXISTS fx_rate, DROP COLUMN IF EXISTS currency;
-- erp_gl__on_invoice / erp_gl__payment_lines: re-run 20260929010000 to restore the base-only versions.
COMMIT;
