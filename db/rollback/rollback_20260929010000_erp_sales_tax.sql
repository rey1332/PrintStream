-- Rollback for 20260929010000_erp_sales_tax.sql. Invoice totals already
-- issued (including tax) are kept; only the tax columns and defaults go.
BEGIN;
DROP TRIGGER IF EXISTS trg_erp_invoice_default_tax ON public.erp_invoices;
DROP FUNCTION IF EXISTS public.erp_apply_default_sales_tax();
DROP FUNCTION IF EXISTS public.erp_create_invoice_v3(UUID, UUID, TEXT, DATE, DATE, NUMERIC, NUMERIC);

CREATE OR REPLACE FUNCTION public.erp_gl__on_invoice()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

DROP FUNCTION IF EXISTS public.erp_accounting_settings_get(UUID);
CREATE FUNCTION public.erp_accounting_settings_get(p_workspace_id UUID)
RETURNS TABLE (base_currency TEXT, lock_date DATE, can_manage BOOLEAN, can_post BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
GRANT EXECUTE ON FUNCTION public.erp_accounting_settings_get(UUID) TO authenticated;
-- Re-create erp_accounting_settings_set(UUID, TEXT, DATE) from 20260929000000 if the app still calls it.
DROP FUNCTION IF EXISTS public.erp_accounting_settings_set(UUID, TEXT, DATE, NUMERIC);

ALTER TABLE public.erp_accounting_settings DROP CONSTRAINT IF EXISTS erp_accounting_settings_tax_check;
ALTER TABLE public.erp_accounting_settings DROP COLUMN IF EXISTS sales_tax_rate;
ALTER TABLE public.erp_invoices DROP CONSTRAINT IF EXISTS erp_invoices_tax_check;
ALTER TABLE public.erp_invoices DROP COLUMN IF EXISTS tax_amount, DROP COLUMN IF EXISTS tax_rate;
COMMIT;
