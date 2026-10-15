-- Rollback for 20261012000053_erp_indonesian_tax.sql.
-- Run only after redeploying an app version from before this change.
-- Supplier bills and the tax fields are removed. Journal entries of bills
-- and the payments made against them stay (they explain the books); the
-- journal keeps allowing their source types.

BEGIN;

-- The previous versions (20261012000016 / 20261012000007 / 20261012000026).
CREATE OR REPLACE FUNCTION public.erp_gl__payment_lines(p erp_payments, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cash_base NUMERIC := round(p_amount * p.fx_rate, 2);
  doc_rate NUMERIC;
  doc_base NUMERIC;
BEGIN
  IF p.payment_type::TEXT = 'incoming' AND p.invoice_id IS NOT NULL THEN
    SELECT fx_rate INTO doc_rate FROM public.erp_invoices WHERE id = p.invoice_id;
    doc_base := round(p_amount * COALESCE(doc_rate, p.fx_rate), 2);
    RETURN jsonb_build_array(
      jsonb_build_object('key', 'cash', 'debit', GREATEST(cash_base, 0), 'credit', GREATEST(-cash_base, 0)),
      jsonb_build_object('key', 'ar', 'credit', GREATEST(doc_base, 0), 'debit', GREATEST(-doc_base, 0)),
      jsonb_build_object('key', 'fx', 'credit', GREATEST(cash_base - doc_base, 0), 'debit', GREATEST(doc_base - cash_base, 0)));
  ELSIF p.payment_type::TEXT = 'incoming' THEN
    RETURN public.erp_gl__pair('cash', 'other_income', cash_base);
  ELSIF p.purchase_order_id IS NOT NULL AND p.currency IS NOT NULL THEN
    doc_base := round(p_amount * public.erp_fx__po_carrying_rate(p.purchase_order_id, p.fx_rate), 2);
    RETURN jsonb_build_array(
      jsonb_build_object('key', 'ap', 'debit', GREATEST(doc_base, 0), 'credit', GREATEST(-doc_base, 0)),
      jsonb_build_object('key', 'cash', 'credit', GREATEST(cash_base, 0), 'debit', GREATEST(-cash_base, 0)),
      jsonb_build_object('key', 'fx', 'credit', GREATEST(doc_base - cash_base, 0), 'debit', GREATEST(cash_base - doc_base, 0)));
  ELSE
    RETURN public.erp_gl__pair(CASE WHEN p.purchase_order_id IS NOT NULL THEN 'ap' ELSE 'expenses' END, 'cash', cash_base);
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.erp_company_profile_set(p_workspace_id uuid, p_profile jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ws UUID := COALESCE(p_workspace_id, public.erp_personal_workspace_id(auth.uid()));
  v_logo TEXT := NULLIF(p_profile ->> 'logo', '');
  v_email TEXT := lower(btrim(COALESCE(p_profile ->> 'email', '')));
BEGIN
  IF NOT COALESCE(public.erp_workspace_role(ws) IN ('owner', 'admin'), false) OR NOT public.erp_workspace_mfa_ok(ws) THEN
    RAISE EXCEPTION 'Only an owner or admin can change the company profile' USING ERRCODE = '42501';
  END IF;
  IF v_email <> '' AND v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'Not an e-mail address: %', v_email USING ERRCODE = 'P0001', HINT = 'email';
  END IF;
  IF v_logo IS NOT NULL AND (v_logo !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' OR length(v_logo) > 409600) THEN
    RAISE EXCEPTION 'The logo must be a PNG, JPEG or WebP image of at most 300 KB' USING ERRCODE = 'P0001', HINT = 'logo';
  END IF;
  INSERT INTO public.erp_company_profiles AS c
    (workspace_id, legal_name, address, city, phone, email, website, tax_id, bank_details, footer_note, logo, updated_by, updated_at)
  VALUES (ws,
    left(btrim(COALESCE(p_profile ->> 'legal_name', '')), 200), left(btrim(COALESCE(p_profile ->> 'address', '')), 500),
    left(btrim(COALESCE(p_profile ->> 'city', '')), 100), left(btrim(COALESCE(p_profile ->> 'phone', '')), 50),
    left(v_email, 200), left(btrim(COALESCE(p_profile ->> 'website', '')), 200),
    left(btrim(COALESCE(p_profile ->> 'tax_id', '')), 50), left(btrim(COALESCE(p_profile ->> 'bank_details', '')), 500),
    left(btrim(COALESCE(p_profile ->> 'footer_note', '')), 500), v_logo, auth.uid(), now())
  ON CONFLICT (workspace_id) DO UPDATE SET
    legal_name = EXCLUDED.legal_name, address = EXCLUDED.address, city = EXCLUDED.city, phone = EXCLUDED.phone,
    email = EXCLUDED.email, website = EXCLUDED.website, tax_id = EXCLUDED.tax_id, bank_details = EXCLUDED.bank_details,
    footer_note = EXCLUDED.footer_note, logo = EXCLUDED.logo, updated_by = EXCLUDED.updated_by, updated_at = now();
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'company.profile_changed', jsonb_build_object('logo', v_logo IS NOT NULL));
END;
$function$;

CREATE OR REPLACE FUNCTION public.erp_company_profile_get(p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ws UUID := COALESCE(p_workspace_id, public.erp_personal_workspace_id(auth.uid()));
  v_role TEXT := public.erp_workspace_role(ws);
  p public.erp_company_profiles%ROWTYPE;
  v_name TEXT;
BEGIN
  IF v_role IS NULL OR NOT public.erp_workspace_mfa_ok(ws) THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO p FROM public.erp_company_profiles x WHERE x.workspace_id = ws;
  SELECT w.name INTO v_name FROM public.erp_workspaces w WHERE w.id = ws;
  RETURN jsonb_build_object(
    'can_edit', v_role IN ('owner', 'admin'),
    'erp_name', v_name,
    'legal_name', COALESCE(p.legal_name, ''), 'address', COALESCE(p.address, ''), 'city', COALESCE(p.city, ''),
    'phone', COALESCE(p.phone, ''), 'email', COALESCE(p.email, ''), 'website', COALESCE(p.website, ''),
    'tax_id', COALESCE(p.tax_id, ''), 'bank_details', COALESCE(p.bank_details, ''),
    'footer_note', COALESCE(p.footer_note, ''), 'logo', p.logo);
END;
$function$;

CREATE OR REPLACE FUNCTION public.erp__reset_modules(p_workspace_id uuid, p_scope text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.erp_weigh_tickets x WHERE x.workspace_id = p_workspace_id;
  DELETE FROM public.erp_production_runs x WHERE x.workspace_id = p_workspace_id;
  DELETE FROM public.erp_equipment_logs x WHERE x.workspace_id = p_workspace_id;
  UPDATE public.erp_equipment x SET hour_meter = x.initial_hour_meter, last_service_hours = NULL, last_service_date = NULL
   WHERE x.workspace_id = p_workspace_id;
  IF p_scope = 'all' THEN
    DELETE FROM public.erp_vehicles x WHERE x.workspace_id = p_workspace_id;
    DELETE FROM public.erp_equipment x WHERE x.workspace_id = p_workspace_id;
  END IF;
END;
$function$;

DROP TRIGGER IF EXISTS trg_erp_bill_payment ON public.erp_payments;
DROP FUNCTION IF EXISTS public.erp__bill_on_payment();
DROP FUNCTION IF EXISTS public.erp_tax_summary(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS public.erp_invoice_pph23_withheld(UUID, NUMERIC, DATE, TEXT);
DROP FUNCTION IF EXISTS public.erp_supplier_bill_bupot(UUID, TEXT, DATE);
DROP FUNCTION IF EXISTS public.erp_supplier_bill_void(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_supplier_bill_pay(UUID, NUMERIC, DATE, TEXT);
DROP FUNCTION IF EXISTS public.erp_supplier_bill_create(UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_tax_faktur_set(UUID, TEXT, TEXT, DATE);
DROP FUNCTION IF EXISTS public.erp_tax_faktur_export(UUID, UUID[], BOOLEAN);
DROP FUNCTION IF EXISTS public.erp_tax_faktur_list(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS public.erp__bill_refresh(UUID);
DROP FUNCTION IF EXISTS public.erp_tax__trx_code(public.erp_invoices);
-- erp_tax__account stays: payments recorded as PPh 23 withheld still post through it.

ALTER TABLE public.erp_payments DROP COLUMN IF EXISTS supplier_bill_id;
DROP TABLE IF EXISTS public.erp_supplier_bills;

DROP INDEX IF EXISTS public.uq_erp_invoices_faktur_number;
ALTER TABLE public.erp_invoices DROP CONSTRAINT IF EXISTS erp_invoices_faktur_check;
ALTER TABLE public.erp_invoices DROP COLUMN IF EXISTS faktur_exported_at;
ALTER TABLE public.erp_invoices DROP COLUMN IF EXISTS faktur_status;
ALTER TABLE public.erp_invoices DROP COLUMN IF EXISTS faktur_date;
ALTER TABLE public.erp_invoices DROP COLUMN IF EXISTS faktur_number;
ALTER TABLE public.erp_invoices DROP COLUMN IF EXISTS tax_trx_code;

ALTER TABLE public.erp_products DROP CONSTRAINT IF EXISTS erp_products_tax_item_check;
ALTER TABLE public.erp_products DROP COLUMN IF EXISTS tax_item_kind;
ALTER TABLE public.erp_products DROP COLUMN IF EXISTS tax_item_code;
ALTER TABLE public.erp_company_profiles DROP CONSTRAINT IF EXISTS erp_company_profiles_nitku_check;
ALTER TABLE public.erp_company_profiles DROP COLUMN IF EXISTS nitku;

DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['erp_customers', 'erp_suppliers'] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', target, target || '_tax_check');
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS tax_address, DROP COLUMN IF EXISTS tax_name, '
                   'DROP COLUMN IF EXISTS is_pkp, DROP COLUMN IF EXISTS nitku, DROP COLUMN IF EXISTS tax_id, '
                   'DROP COLUMN IF EXISTS tax_id_type', target);
  END LOOP;
END;
$$;

COMMIT;
