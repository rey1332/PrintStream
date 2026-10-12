-- ─── Sales tax (VAT / PPN) on invoices ──────────────────────────────────────
-- Additive. Invoices carry a tax rate and tax amount; the invoice total stays
-- the amount the customer owes (net + tax), so payments and balances work as
-- before. The ledger splits the invoice into revenue and output tax.
--
--   • erp_create_invoice_v3: invoice from a net amount and a tax rate.
--   • Invoices issued from sales orders get the workspace's default sales tax
--     rate (0 unless set in accounting settings, so nothing changes by default).
--   • Posting: Dr Accounts receivable (total) / Cr Sales revenue (net)
--                                             / Cr Output tax (tax).
-- Purchases are unchanged: record input tax with a manual journal for now.
--
-- Rollback: supabase/snippets/rollback_20260929010000_erp_sales_tax.sql

ALTER TABLE public.erp_invoices
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_invoices_tax_check') THEN
    ALTER TABLE public.erp_invoices ADD CONSTRAINT erp_invoices_tax_check
      CHECK (tax_rate BETWEEN 0 AND 100 AND tax_amount >= 0 AND tax_amount <= total);
  END IF;
END;
$$;

ALTER TABLE public.erp_accounting_settings
  ADD COLUMN IF NOT EXISTS sales_tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_accounting_settings_tax_check') THEN
    ALTER TABLE public.erp_accounting_settings ADD CONSTRAINT erp_accounting_settings_tax_check
      CHECK (sales_tax_rate BETWEEN 0 AND 100);
  END IF;
END;
$$;

-- Invoices issued from a sales order use the workspace's default rate.
CREATE OR REPLACE FUNCTION public.erp_apply_default_sales_tax()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE rate NUMERIC;
BEGIN
  IF NEW.sales_order_id IS NULL OR NEW.tax_rate <> 0 OR NEW.tax_amount <> 0 THEN RETURN NEW; END IF;
  SELECT sales_tax_rate INTO rate FROM public.erp_accounting_settings WHERE user_id = NEW.user_id;
  IF COALESCE(rate, 0) > 0 THEN
    NEW.tax_rate := rate;
    NEW.tax_amount := round(NEW.total * rate / 100, 2);
    NEW.total := NEW.total + NEW.tax_amount;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_apply_default_sales_tax() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_erp_invoice_default_tax ON public.erp_invoices;
CREATE TRIGGER trg_erp_invoice_default_tax BEFORE INSERT ON public.erp_invoices
  FOR EACH ROW EXECUTE FUNCTION public.erp_apply_default_sales_tax();

-- Same as erp_create_invoice_v2, from a net amount plus a tax rate.
CREATE OR REPLACE FUNCTION public.erp_create_invoice_v3(
  p_workspace_id UUID,
  p_customer_id UUID,
  p_customer_name TEXT,
  p_invoice_date DATE,
  p_due_date DATE,
  p_subtotal NUMERIC(15,2),
  p_tax_rate NUMERIC(5,2)
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
  tax NUMERIC(15,2);
  new_invoice_id UUID;
BEGIN
  workspace := public.erp__resolve_workspace(p_workspace_id, 'invoicing');
  SELECT owner_id INTO owner FROM public.erp_workspaces WHERE id = workspace;
  IF p_subtotal IS NULL OR p_subtotal < 0 THEN RAISE EXCEPTION 'Invoice total cannot be negative'; END IF;
  IF p_tax_rate IS NULL OR p_tax_rate < 0 OR p_tax_rate > 100 THEN
    RAISE EXCEPTION 'Tax rate must be between 0 and 100 percent';
  END IF;

  IF p_customer_id IS NOT NULL THEN
    SELECT name INTO canonical_customer_name FROM public.erp_customers
    WHERE id = p_customer_id AND workspace_id = workspace;
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this account'; END IF;
  ELSE
    canonical_customer_name := left(trim(COALESCE(p_customer_name, '')), 200);
    IF canonical_customer_name = '' THEN RAISE EXCEPTION 'Customer name is required'; END IF;
  END IF;

  tax := round(p_subtotal * p_tax_rate / 100, 2);
  INSERT INTO public.erp_invoices
    (user_id, workspace_id, created_by, customer_id, customer_name, invoice_date, due_date, status, total, tax_rate, tax_amount)
  VALUES
    (owner, workspace, auth.uid(), p_customer_id, canonical_customer_name,
     COALESCE(p_invoice_date, CURRENT_DATE), COALESCE(p_due_date, CURRENT_DATE), 'unpaid', p_subtotal + tax, p_tax_rate, tax)
  RETURNING id INTO new_invoice_id;
  RETURN new_invoice_id;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_create_invoice_v3(UUID, UUID, TEXT, DATE, DATE, NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_create_invoice_v3(UUID, UUID, TEXT, DATE, DATE, NUMERIC, NUMERIC) TO authenticated;

-- Posting with the tax split (replaces the version in 20260929000000).
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
        'invoice', NEW.id, 'invoice:' || NEW.id,
        jsonb_build_array(
          jsonb_build_object('key', 'ar', 'debit', NEW.total),
          jsonb_build_object('key', 'revenue', 'credit', NEW.total - NEW.tax_amount),
          jsonb_build_object('key', 'tax_out', 'credit', NEW.tax_amount)));
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

-- Settings functions gain the default sales tax rate.
DROP FUNCTION IF EXISTS public.erp_accounting_settings_get(UUID);
CREATE FUNCTION public.erp_accounting_settings_get(p_workspace_id UUID)
RETURNS TABLE (base_currency TEXT, lock_date DATE, sales_tax_rate NUMERIC, can_manage BOOLEAN, can_post BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE owner UUID := public.erp_gl__scope(p_workspace_id);
BEGIN
  PERFORM public.erp_gl__seed(owner);
  RETURN QUERY
  SELECT s.base_currency, s.lock_date, s.sales_tax_rate,
         owner = auth.uid() OR (p_workspace_id IS NOT NULL AND public.erp_has_permission(p_workspace_id, 'members')),
         owner = auth.uid() OR (p_workspace_id IS NOT NULL AND public.erp_has_permission(p_workspace_id, 'payments'))
  FROM public.erp_accounting_settings s WHERE s.user_id = owner;
END;
$$;

DROP FUNCTION IF EXISTS public.erp_accounting_settings_set(UUID, TEXT, DATE);
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

REVOKE ALL ON FUNCTION public.erp_accounting_settings_get(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_accounting_settings_set(UUID, TEXT, DATE, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_accounting_settings_get(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_accounting_settings_set(UUID, TEXT, DATE, NUMERIC) TO authenticated;
