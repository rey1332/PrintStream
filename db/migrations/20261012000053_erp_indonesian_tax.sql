-- Indonesian tax: e-Faktur through Coretax, supplier bills with PPh 23, and a
-- monthly tax summary (docs/ANALYSIS-QUARRY.md §3.7; docs/TAX.md).
--
-- 1. Tax data on customers and suppliers: NPWP (16 digits) or NIK, NITKU
--    (22 digits), PKP status, and the name and address for tax documents.
--    The company profile gets the seller's NITKU; products a Coretax goods /
--    services code and whether they are goods or a service.
-- 2. e-Faktur: each taxed sales invoice has a Coretax transaction code
--    (04 = DPP nilai lain 11/12, the usual case under the 12% regime; 01 = full
--    DPP). The app exports a month's invoices as Coretax XML
--    (src/server/tax/coretax.ts); the approved faktur number is stored here.
-- 3. Supplier bills (erp_supplier_bills) for services, rentals and expenses,
--    with the supplier's faktur (PPN masukan) and PPh 23 withheld:
--      Dr expense (DPP), Dr Input tax (PPN) / Cr Accounts payable (to pay),
--                                            Cr PPh 23 payable (withheld)
--    Paying a bill is an outgoing payment against it (Dr Accounts payable,
--    Cr Cash); voiding an unpaid bill reverses its entry. The bukti potong
--    number from e-Bupot is stored on the bill.
-- 4. PPh 23 withheld by a customer (hauling, services): recorded on the
--    invoice as a settlement (Dr Prepaid PPh 23, Cr Accounts receivable), with
--    the customer's bukti potong number.
-- 5. erp_tax_summary: per month, PPN keluaran and masukan, PPh 21, PPh 23
--    withheld and withheld from us, from the ledger.
--
-- Rights: customer / supplier tax data as the rest of their record; e-Faktur
-- and customer withholding with 'invoicing'; bills with 'purchasing' (record)
-- and 'payments' (pay); voids by the Owner or an Admin. The summary needs
-- 'read'.
--
-- Rollback: db/rollback/rollback_20261012000053_erp_indonesian_tax.sql

-- ─── 1. Tax data ─────────────────────────────────────────────────────────────

DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['erp_customers', 'erp_suppliers'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tax_id_type TEXT', target);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tax_id TEXT NOT NULL DEFAULT %L', target, '');
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS nitku TEXT NOT NULL DEFAULT %L', target, '');
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS is_pkp BOOLEAN NOT NULL DEFAULT false', target);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tax_name TEXT NOT NULL DEFAULT %L', target, '');
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tax_address TEXT NOT NULL DEFAULT %L', target, '');
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', target, target || '_tax_check');
    -- NPWP and NIK: 16 digits; NITKU: 22 digits (NPWP + 6); passport / other ID: up to 30 characters.
    -- COALESCE: a CHECK that comes out NULL passes, so no type must never mean "any ID".
    EXECUTE format($c$ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (
        ((tax_id_type IS NULL AND tax_id = '')
          OR (COALESCE(tax_id_type, '') IN ('npwp', 'nik') AND tax_id ~ '^[0-9]{16}$')
          OR (COALESCE(tax_id_type, '') IN ('passport', 'other') AND char_length(btrim(tax_id)) BETWEEN 1 AND 30))
        AND (nitku = '' OR nitku ~ '^[0-9]{22}$')
        AND char_length(tax_name) <= 200 AND char_length(tax_address) <= 500)$c$,
      target, target || '_tax_check');
  END LOOP;
END;
$$;

ALTER TABLE public.erp_company_profiles ADD COLUMN IF NOT EXISTS nitku TEXT NOT NULL DEFAULT '';
ALTER TABLE public.erp_company_profiles DROP CONSTRAINT IF EXISTS erp_company_profiles_nitku_check;
ALTER TABLE public.erp_company_profiles ADD CONSTRAINT erp_company_profiles_nitku_check CHECK (nitku = '' OR nitku ~ '^[0-9]{22}$');

ALTER TABLE public.erp_products ADD COLUMN IF NOT EXISTS tax_item_code TEXT NOT NULL DEFAULT '000000';
ALTER TABLE public.erp_products ADD COLUMN IF NOT EXISTS tax_item_kind TEXT NOT NULL DEFAULT 'goods';
ALTER TABLE public.erp_products DROP CONSTRAINT IF EXISTS erp_products_tax_item_check;
ALTER TABLE public.erp_products ADD CONSTRAINT erp_products_tax_item_check
  CHECK (tax_item_code ~ '^[0-9]{6}$' AND tax_item_kind IN ('goods', 'service'));

-- ─── 2. e-Faktur on invoices ─────────────────────────────────────────────────

ALTER TABLE public.erp_invoices ADD COLUMN IF NOT EXISTS tax_trx_code TEXT;
ALTER TABLE public.erp_invoices ADD COLUMN IF NOT EXISTS faktur_number TEXT;
ALTER TABLE public.erp_invoices ADD COLUMN IF NOT EXISTS faktur_date DATE;
ALTER TABLE public.erp_invoices ADD COLUMN IF NOT EXISTS faktur_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.erp_invoices ADD COLUMN IF NOT EXISTS faktur_exported_at TIMESTAMPTZ;
ALTER TABLE public.erp_invoices DROP CONSTRAINT IF EXISTS erp_invoices_faktur_check;
ALTER TABLE public.erp_invoices ADD CONSTRAINT erp_invoices_faktur_check CHECK (
  (tax_trx_code IS NULL OR tax_trx_code IN ('01', '02', '03', '04', '05', '06', '07', '08', '09', '10'))
  AND faktur_status IN ('none', 'exported', 'approved')
  AND (faktur_number IS NULL OR faktur_number ~ '^[0-9]{17}$')
  AND ((faktur_status = 'approved') = (faktur_number IS NOT NULL)));
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_invoices_faktur_number
  ON public.erp_invoices (workspace_id, faktur_number) WHERE faktur_number IS NOT NULL;

-- ─── 3. Supplier bills ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.erp_supplier_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES public.erp_suppliers(id) ON DELETE SET NULL,
  supplier_name TEXT NOT NULL CHECK (char_length(btrim(supplier_name)) BETWEEN 1 AND 200),
  bill_no TEXT NOT NULL DEFAULT '' CHECK (char_length(bill_no) <= 60),
  bill_date DATE NOT NULL,
  due_date DATE NOT NULL,
  description TEXT NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 300),
  expense_account_id UUID NOT NULL REFERENCES public.erp_gl_accounts(id),
  subtotal NUMERIC(15, 2) NOT NULL CHECK (subtotal > 0),
  ppn_amount NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (ppn_amount >= 0),
  faktur_number TEXT CHECK (faktur_number IS NULL OR faktur_number ~ '^[0-9]{17}$'),
  faktur_date DATE,
  pph23_rate NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (pph23_rate BETWEEN 0 AND 100),
  pph23_amount NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (pph23_amount >= 0),
  pph23_object_code TEXT NOT NULL DEFAULT '' CHECK (pph23_object_code = '' OR pph23_object_code ~ '^[0-9]{2}-[0-9]{3}-[0-9]{2}$'),
  bupot_number TEXT NOT NULL DEFAULT '' CHECK (char_length(bupot_number) <= 40),
  bupot_date DATE,
  total_payable NUMERIC(15, 2) NOT NULL,
  amount_paid NUMERIC(15, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
  void_reason TEXT NOT NULL DEFAULT '' CHECK (char_length(void_reason) <= 500),
  voided_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  voided_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (total_payable = subtotal + ppn_amount - pph23_amount AND total_payable >= 0),
  CHECK (amount_paid >= 0 AND amount_paid <= total_payable),
  CHECK ((faktur_number IS NULL) = (faktur_date IS NULL)),
  CHECK (pph23_amount = 0 OR pph23_object_code <> '')
);
CREATE INDEX IF NOT EXISTS idx_erp_supplier_bills_ws_date ON public.erp_supplier_bills (workspace_id, bill_date DESC);
CREATE INDEX IF NOT EXISTS idx_erp_supplier_bills_supplier ON public.erp_supplier_bills (supplier_id);

ALTER TABLE public.erp_payments ADD COLUMN IF NOT EXISTS supplier_bill_id UUID REFERENCES public.erp_supplier_bills(id);
CREATE INDEX IF NOT EXISTS idx_erp_payments_supplier_bill ON public.erp_payments (supplier_bill_id) WHERE supplier_bill_id IS NOT NULL;

DO $$
BEGIN
  DROP TRIGGER IF EXISTS trg_erp_assign_workspace ON public.erp_supplier_bills;
  CREATE TRIGGER trg_erp_assign_workspace BEFORE INSERT OR UPDATE ON public.erp_supplier_bills
    FOR EACH ROW EXECUTE FUNCTION public.erp_assign_workspace();
  DROP TRIGGER IF EXISTS trg_audit_erp_supplier_bills ON public.erp_supplier_bills;
  CREATE TRIGGER trg_audit_erp_supplier_bills AFTER INSERT OR UPDATE OR DELETE ON public.erp_supplier_bills
    FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn();
END;
$$;

-- Read like payments; written only through the functions below.
ALTER TABLE public.erp_supplier_bills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_supplier_bills FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_supplier_bills TO authenticated;
DROP POLICY IF EXISTS erp_supplier_bills_member_read ON public.erp_supplier_bills;
CREATE POLICY erp_supplier_bills_member_read ON public.erp_supplier_bills FOR SELECT TO authenticated
  USING (workspace_id IS NOT NULL AND public.erp_can_read(workspace_id, 'payments'));
DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.erp_supplier_bills;
CREATE POLICY erp_workspace_not_suspended ON public.erp_supplier_bills AS RESTRICTIVE FOR ALL TO authenticated
  USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]));

ALTER TABLE public.erp_journal_entries DROP CONSTRAINT IF EXISTS erp_journal_entries_source_type_check;
ALTER TABLE public.erp_journal_entries ADD CONSTRAINT erp_journal_entries_source_type_check CHECK (source_type IN (
  'invoice', 'invoice_void', 'invoice_adjust', 'payment', 'payment_void', 'payment_adjust', 'transaction',
  'purchase_receipt', 'sales_delivery', 'stock_adjustment', 'opening_stock', 'manual', 'manual_reversal',
  'fx_settlement', 'payroll', 'payroll_reversal', 'weigh_ticket', 'weigh_ticket_cancel',
  'production', 'production_reversal', 'fuel_issue', 'fuel_issue_reversal',
  'supplier_bill', 'supplier_bill_void'));

-- ─── Ledger accounts for PPh 23 ──────────────────────────────────────────────

-- As erp_hr__payroll_account: the first free code from a base, once per ledger.
CREATE OR REPLACE FUNCTION public.erp_tax__account(p_owner UUID, p_key TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  account UUID;
  base_code INTEGER := CASE p_key WHEN 'pph23_payable' THEN 2330 WHEN 'pph23_prepaid' THEN 1320 END;
  v_name TEXT := CASE p_key WHEN 'pph23_payable' THEN 'PPh 23 payable' WHEN 'pph23_prepaid' THEN 'Prepaid PPh 23' END;
  v_type TEXT := CASE p_key WHEN 'pph23_payable' THEN 'liability' ELSE 'asset' END;
  candidate INTEGER;
BEGIN
  IF base_code IS NULL THEN RAISE EXCEPTION 'Unknown tax account %', p_key; END IF;
  PERFORM public.erp_gl__seed(p_owner);
  SELECT id INTO account FROM public.erp_gl_accounts WHERE user_id = p_owner AND system_key = p_key;
  IF account IS NOT NULL THEN RETURN account; END IF;
  FOR candidate IN base_code .. base_code + 99 LOOP
    IF NOT EXISTS (SELECT 1 FROM public.erp_gl_accounts WHERE user_id = p_owner AND code = candidate::TEXT) THEN
      INSERT INTO public.erp_gl_accounts (user_id, code, name, account_type, system_key)
      VALUES (p_owner, candidate::TEXT, v_name, v_type, p_key)
      RETURNING id INTO account;
      RETURN account;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'No free account code for %', v_name;
END;
$$;

-- Payments: a payment against a supplier bill settles Accounts payable; an
-- incoming "payment" with method pph23 is PPh 23 withheld by the customer
-- (Prepaid PPh 23 instead of cash). Everything else as in 20261006000000.
CREATE OR REPLACE FUNCTION public.erp_gl__payment_lines(p public.erp_payments, p_amount NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cash_base NUMERIC := round(p_amount * p.fx_rate, 2);
  doc_rate NUMERIC;
  doc_base NUMERIC;
  debit_cash JSONB;
BEGIN
  IF p.payment_type::TEXT = 'incoming' AND p.invoice_id IS NOT NULL THEN
    SELECT fx_rate INTO doc_rate FROM public.erp_invoices WHERE id = p.invoice_id;
    doc_base := round(p_amount * COALESCE(doc_rate, p.fx_rate), 2);
    debit_cash := CASE WHEN p.method = 'pph23'
      THEN jsonb_build_object('account_id', public.erp_tax__account(p.user_id, 'pph23_prepaid'),
                              'debit', GREATEST(cash_base, 0), 'credit', GREATEST(-cash_base, 0), 'memo', 'PPh 23 withheld by the customer')
      ELSE jsonb_build_object('key', 'cash', 'debit', GREATEST(cash_base, 0), 'credit', GREATEST(-cash_base, 0)) END;
    RETURN jsonb_build_array(
      debit_cash,
      jsonb_build_object('key', 'ar', 'credit', GREATEST(doc_base, 0), 'debit', GREATEST(-doc_base, 0)),
      jsonb_build_object('key', 'fx', 'credit', GREATEST(cash_base - doc_base, 0), 'debit', GREATEST(doc_base - cash_base, 0)));
  ELSIF p.payment_type::TEXT = 'incoming' THEN
    RETURN public.erp_gl__pair('cash', 'other_income', cash_base);
  ELSIF p.supplier_bill_id IS NOT NULL THEN
    RETURN public.erp_gl__pair('ap', 'cash', cash_base);
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
$$;

-- ─── Helpers ─────────────────────────────────────────────────────────────────

-- The Coretax transaction code of an invoice: as set, else 04 for 11% (DPP
-- nilai lain 11/12 at 12%), 01 for any other rate.
CREATE OR REPLACE FUNCTION public.erp_tax__trx_code(p_invoice public.erp_invoices)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(p_invoice.tax_trx_code, CASE WHEN p_invoice.tax_rate = 11 THEN '04' ELSE '01' END);
$$;

CREATE OR REPLACE FUNCTION public.erp__bill_refresh(p_bill_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.erp_supplier_bills b
     SET amount_paid = COALESCE((SELECT sum(p.amount) FROM public.erp_payments p
                                  WHERE p.supplier_bill_id = b.id AND p.voided_at IS NULL), 0),
         status = CASE WHEN b.status = 'void' THEN 'void'
                       WHEN COALESCE((SELECT sum(p.amount) FROM public.erp_payments p
                                       WHERE p.supplier_bill_id = b.id AND p.voided_at IS NULL), 0) >= b.total_payable
                       THEN 'paid' ELSE 'open' END
   WHERE b.id = p_bill_id;
END;
$$;

-- ─── e-Faktur ────────────────────────────────────────────────────────────────

-- Taxed invoices of a period for Coretax, with what is missing for each.
CREATE OR REPLACE FUNCTION public.erp_tax_faktur_list(p_workspace_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (invoice_id UUID, doc_no TEXT, invoice_date DATE, customer_id UUID, customer_name TEXT,
               subtotal NUMERIC, tax_rate NUMERIC, tax_amount NUMERIC, total NUMERIC, currency TEXT,
               trx_code TEXT, faktur_status TEXT, faktur_number TEXT, faktur_date DATE, exported_at TIMESTAMPTZ,
               lines INTEGER, missing TEXT[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'invoicing');
  seller public.erp_company_profiles%ROWTYPE;
BEGIN
  SELECT * INTO seller FROM public.erp_company_profiles WHERE workspace_id = ws;
  RETURN QUERY
  SELECT i.id, i.doc_no, i.invoice_date, i.customer_id, i.customer_name,
         i.total - i.tax_amount, i.tax_rate, i.tax_amount, i.total, i.currency,
         public.erp_tax__trx_code(i), i.faktur_status, i.faktur_number, i.faktur_date, i.faktur_exported_at,
         (SELECT count(*)::INTEGER FROM public.erp_invoice_lines l WHERE l.invoice_id = i.id),
         array_remove(ARRAY[
           CASE WHEN COALESCE(seller.tax_id, '') !~ '^[0-9]{15,16}$' THEN 'seller_npwp' END,
           CASE WHEN COALESCE(seller.nitku, '') = '' THEN 'seller_nitku' END,
           CASE WHEN c.id IS NULL THEN 'customer' END,
           CASE WHEN c.id IS NOT NULL AND c.tax_id_type IS NULL THEN 'customer_tax_id' END,
           CASE WHEN c.id IS NOT NULL AND c.tax_id_type = 'npwp' AND c.nitku = '' THEN 'customer_nitku' END,
           CASE WHEN NOT EXISTS (SELECT 1 FROM public.erp_invoice_lines l WHERE l.invoice_id = i.id) THEN 'lines' END,
           CASE WHEN i.currency IS NOT NULL AND i.fx_rate <> 1 THEN 'currency' END
         ]::TEXT[], NULL)
    FROM public.erp_invoices i
    LEFT JOIN public.erp_customers c ON c.id = i.customer_id
   WHERE i.workspace_id = ws AND i.invoice_date BETWEEN p_from AND p_to
     AND i.status::TEXT <> 'void' AND i.tax_amount > 0
   ORDER BY i.invoice_date, i.doc_no NULLS LAST, i.created_at;
END;
$$;

-- Everything the Coretax XML needs for the given invoices (the app builds the
-- XML). With p_mark, they are marked exported: the app asks once without, to
-- check the file, and once with, when the file is good.
CREATE OR REPLACE FUNCTION public.erp_tax_faktur_export(p_workspace_id UUID, p_invoice_ids UUID[], p_mark BOOLEAN DEFAULT true)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'invoicing');
  seller public.erp_company_profiles%ROWTYPE;
  result JSONB;
BEGIN
  IF p_invoice_ids IS NULL OR cardinality(p_invoice_ids) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Choose between 1 and 500 invoices' USING ERRCODE = '22023', HINT = 'count';
  END IF;
  SELECT * INTO seller FROM public.erp_company_profiles WHERE workspace_id = ws;
  SELECT jsonb_build_object(
    'seller', jsonb_build_object('npwp', regexp_replace(COALESCE(seller.tax_id, ''), '[^0-9]', '', 'g'),
                                 'nitku', COALESCE(seller.nitku, ''), 'name', COALESCE(seller.legal_name, '')),
    'invoices', COALESCE(jsonb_agg(jsonb_build_object(
      'id', i.id, 'doc_no', COALESCE(i.doc_no, ''), 'date', i.invoice_date, 'trx_code', public.erp_tax__trx_code(i),
      'tax_rate', i.tax_rate, 'tax_amount', i.tax_amount, 'subtotal', i.total - i.tax_amount,
      'buyer', jsonb_build_object(
        'tax_id_type', c.tax_id_type, 'tax_id', COALESCE(c.tax_id, ''), 'nitku', COALESCE(c.nitku, ''),
        'name', COALESCE(NULLIF(c.tax_name, ''), c.name, i.customer_name),
        'address', COALESCE(NULLIF(c.tax_address, ''), NULLIF(btrim(COALESCE(c.address, '') || ' ' || COALESCE(c.city, '')), ''), ''),
        'email', COALESCE(c.email, '')),
      'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'description', l.description, 'qty', l.qty, 'unit', l.unit, 'price', l.price,
          'subtotal', COALESCE(l.subtotal, round(l.qty * l.price, 2)),
          'item_code', COALESCE(p.tax_item_code, '000000'), 'item_kind', COALESCE(p.tax_item_kind, 'goods'))
          ORDER BY l.position), '[]'::jsonb)
          FROM public.erp_invoice_lines l LEFT JOIN public.erp_products p ON p.id = l.product_id
         WHERE l.invoice_id = i.id)
    ) ORDER BY i.invoice_date, i.doc_no), '[]'::jsonb))
    INTO result
    FROM public.erp_invoices i
    LEFT JOIN public.erp_customers c ON c.id = i.customer_id
   WHERE i.workspace_id = ws AND i.id = ANY (p_invoice_ids) AND i.status::TEXT <> 'void' AND i.tax_amount > 0;
  IF jsonb_array_length(result -> 'invoices') <> cardinality(p_invoice_ids) THEN
    RAISE EXCEPTION 'Only taxed, not voided invoices of this ERP can be exported' USING ERRCODE = 'P0001', HINT = 'invoices';
  END IF;
  IF p_mark THEN
    UPDATE public.erp_invoices
       SET faktur_status = CASE WHEN faktur_status = 'approved' THEN 'approved' ELSE 'exported' END,
           faktur_exported_at = now()
     WHERE workspace_id = ws AND id = ANY (p_invoice_ids);
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    VALUES (ws, auth.uid(), 'tax.faktur_exported', jsonb_build_object('invoices', cardinality(p_invoice_ids)));
  END IF;
  RETURN result;
END;
$$;

-- The transaction code (before the faktur is approved) and, once Coretax has
-- approved it, the faktur number (17 digits) and date.
CREATE OR REPLACE FUNCTION public.erp_tax_faktur_set(p_invoice_id UUID, p_trx_code TEXT, p_number TEXT, p_date DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i public.erp_invoices%ROWTYPE;
  v_number TEXT := NULLIF(regexp_replace(COALESCE(p_number, ''), '[^0-9]', '', 'g'), '');
BEGIN
  SELECT * INTO i FROM public.erp_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  PERFORM public.erp__resolve_workspace(i.workspace_id, 'invoicing');
  IF i.status::TEXT = 'void' OR i.tax_amount <= 0 THEN
    RAISE EXCEPTION 'Only taxed, not voided invoices have a faktur' USING ERRCODE = 'P0001', HINT = 'invoices';
  END IF;
  IF p_trx_code IS NOT NULL AND p_trx_code NOT IN ('01', '02', '03', '04', '05', '06', '07', '08', '09', '10') THEN
    RAISE EXCEPTION 'Unknown transaction code' USING ERRCODE = '22023', HINT = 'trx_code';
  END IF;
  IF v_number IS NOT NULL AND v_number !~ '^[0-9]{17}$' THEN
    RAISE EXCEPTION 'A faktur number has 17 digits' USING ERRCODE = '22023', HINT = 'faktur_number';
  END IF;
  IF i.faktur_status = 'approved' AND p_trx_code IS DISTINCT FROM i.tax_trx_code AND p_trx_code IS NOT NULL
     AND p_trx_code <> public.erp_tax__trx_code(i) THEN
    RAISE EXCEPTION 'The faktur is approved: its transaction code cannot change' USING ERRCODE = 'P0001', HINT = 'approved';
  END IF;
  UPDATE public.erp_invoices
     SET tax_trx_code = COALESCE(p_trx_code, tax_trx_code),
         faktur_number = v_number,
         faktur_date = CASE WHEN v_number IS NULL THEN NULL ELSE COALESCE(p_date, invoice_date) END,
         faktur_status = CASE WHEN v_number IS NOT NULL THEN 'approved'
                              WHEN faktur_exported_at IS NOT NULL THEN 'exported' ELSE 'none' END
   WHERE id = i.id;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'Another invoice already has this faktur number' USING ERRCODE = 'P0001', HINT = 'faktur_taken';
END;
$$;

-- ─── Supplier bills ──────────────────────────────────────────────────────────

-- p_bill: {supplier_id?, supplier_name?, bill_no?, bill_date, due_date?, description,
--   expense_account_id?, subtotal, ppn_amount?, faktur_number?, faktur_date?,
--   pph23_rate?, pph23_object_code?}
CREATE OR REPLACE FUNCTION public.erp_supplier_bill_create(p_workspace_id UUID, p_bill JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'purchasing');
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces WHERE id = ws);
  s public.erp_suppliers%ROWTYPE;
  v_name TEXT;
  v_date DATE;
  v_due DATE;
  v_subtotal NUMERIC;
  v_ppn NUMERIC;
  v_rate NUMERIC;
  v_pph NUMERIC;
  v_faktur TEXT := NULLIF(regexp_replace(COALESCE(p_bill ->> 'faktur_number', ''), '[^0-9]', '', 'g'), '');
  v_faktur_date DATE;
  v_account UUID;
  v_desc TEXT := left(btrim(COALESCE(p_bill ->> 'description', '')), 300);
  new_id UUID;
BEGIN
  BEGIN
    v_date := (p_bill ->> 'bill_date')::DATE;
    v_due := COALESCE(NULLIF(p_bill ->> 'due_date', '')::DATE, v_date);
    v_subtotal := round((p_bill ->> 'subtotal')::NUMERIC, 2);
    v_ppn := round(COALESCE(NULLIF(p_bill ->> 'ppn_amount', '')::NUMERIC, 0), 2);
    v_rate := round(COALESCE(NULLIF(p_bill ->> 'pph23_rate', '')::NUMERIC, 0), 2);
    v_faktur_date := NULLIF(p_bill ->> 'faktur_date', '')::DATE;
    v_account := NULLIF(p_bill ->> 'expense_account_id', '')::UUID;
    IF NULLIF(p_bill ->> 'supplier_id', '') IS NOT NULL THEN
      SELECT * INTO s FROM public.erp_suppliers WHERE id = (p_bill ->> 'supplier_id')::UUID AND workspace_id = ws;
      IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found'; END IF;
    END IF;
  EXCEPTION
    WHEN raise_exception THEN RAISE;
    WHEN OTHERS THEN RAISE EXCEPTION 'Invalid bill' USING ERRCODE = '22023';
  END;
  v_name := left(btrim(COALESCE(s.name, p_bill ->> 'supplier_name', '')), 200);
  IF v_date IS NULL OR v_name = '' OR v_desc = '' THEN
    RAISE EXCEPTION 'Enter the supplier, the date and what the bill is for' USING ERRCODE = '22023', HINT = 'required';
  END IF;
  IF v_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'The date cannot be in the future' USING ERRCODE = '22023', HINT = 'future';
  END IF;
  IF v_due < v_date THEN
    RAISE EXCEPTION 'The due date is before the bill date' USING ERRCODE = '22023', HINT = 'due';
  END IF;
  IF v_subtotal IS NULL OR v_subtotal <= 0 OR v_ppn < 0 OR v_rate < 0 OR v_rate > 100 THEN
    RAISE EXCEPTION 'Enter the amount before tax; tax amounts cannot be negative' USING ERRCODE = '22023', HINT = 'amounts';
  END IF;
  IF v_faktur IS NOT NULL AND v_faktur !~ '^[0-9]{17}$' THEN
    RAISE EXCEPTION 'A faktur number has 17 digits' USING ERRCODE = '22023', HINT = 'faktur_number';
  END IF;
  IF v_ppn > 0 AND v_faktur IS NULL THEN
    RAISE EXCEPTION 'Input PPN needs the supplier''s faktur number' USING ERRCODE = 'P0001', HINT = 'faktur_required';
  END IF;
  v_pph := round(v_subtotal * v_rate / 100, 2);
  IF v_pph > 0 AND btrim(COALESCE(p_bill ->> 'pph23_object_code', '')) = '' THEN
    RAISE EXCEPTION 'PPh 23 needs the tax object code' USING ERRCODE = '22023', HINT = 'object_code';
  END IF;
  IF v_account IS NULL THEN
    v_account := public.erp_gl__account(v_owner, 'expenses');
  ELSIF NOT EXISTS (SELECT 1 FROM public.erp_gl_accounts a WHERE a.id = v_account AND a.user_id = v_owner
                       AND a.account_type IN ('expense', 'asset') AND a.is_active) THEN
    RAISE EXCEPTION 'Choose an active expense or asset account' USING ERRCODE = 'P0001', HINT = 'account';
  END IF;

  INSERT INTO public.erp_supplier_bills
    (user_id, workspace_id, supplier_id, supplier_name, bill_no, bill_date, due_date, description, expense_account_id,
     subtotal, ppn_amount, faktur_number, faktur_date, pph23_rate, pph23_amount, pph23_object_code, total_payable, created_by)
  VALUES
    (v_owner, ws, s.id, v_name, left(btrim(COALESCE(p_bill ->> 'bill_no', '')), 60), v_date, v_due, v_desc, v_account,
     v_subtotal, v_ppn, v_faktur, CASE WHEN v_faktur IS NOT NULL THEN COALESCE(v_faktur_date, v_date) END,
     v_rate, v_pph, CASE WHEN v_pph > 0 THEN btrim(p_bill ->> 'pph23_object_code') ELSE '' END,
     v_subtotal + v_ppn - v_pph, auth.uid())
  RETURNING id INTO new_id;

  PERFORM public.erp_gl__post(v_owner, v_date, 'Bill from ' || v_name || ': ' || v_desc, 'supplier_bill', new_id,
    'supplier_bill:' || new_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_account, 'debit', v_subtotal),
      jsonb_build_object('key', 'tax_in', 'debit', v_ppn, 'memo', COALESCE('Faktur ' || v_faktur, '')),
      jsonb_build_object('key', 'ap', 'credit', v_subtotal + v_ppn - v_pph),
      jsonb_build_object('account_id', public.erp_tax__account(v_owner, 'pph23_payable'), 'credit', v_pph,
                         'memo', 'PPh 23 ' || trim_scale(v_rate) || '%')));
  RETURN new_id;
EXCEPTION
  WHEN check_violation THEN
    RAISE EXCEPTION 'Check the bill: amounts, faktur number (17 digits) and tax object code (NN-NNN-NN)'
      USING ERRCODE = '22023', HINT = 'check';
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_supplier_bill_pay(p_bill_id UUID, p_amount NUMERIC, p_date DATE, p_method TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  b public.erp_supplier_bills%ROWTYPE;
  v_amount NUMERIC := round(p_amount, 2);
  v_date DATE := COALESCE(p_date, CURRENT_DATE);
  new_id UUID;
BEGIN
  SELECT * INTO b FROM public.erp_supplier_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  PERFORM public.erp__resolve_workspace(b.workspace_id, 'payments');
  IF b.status = 'void' THEN RAISE EXCEPTION 'This bill is void' USING ERRCODE = 'P0001', HINT = 'void'; END IF;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount > b.total_payable - b.amount_paid THEN
    RAISE EXCEPTION 'The amount must be positive and at most what is still owed (%)', b.total_payable - b.amount_paid
      USING ERRCODE = 'P0001', HINT = 'amount';
  END IF;
  IF v_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'The date cannot be in the future' USING ERRCODE = '22023', HINT = 'future';
  END IF;
  INSERT INTO public.erp_payments (user_id, workspace_id, payment_type, party, amount, payment_date, method, note, supplier_bill_id, created_by)
  VALUES (b.user_id, b.workspace_id, 'outgoing', b.supplier_name, v_amount, v_date,
          left(COALESCE(NULLIF(btrim(p_method), ''), 'transfer'), 40),
          left('Bill ' || COALESCE(NULLIF(b.bill_no, ''), b.description), 300), b.id, auth.uid())
  RETURNING id INTO new_id;
  PERFORM public.erp__bill_refresh(b.id);
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_supplier_bill_void(p_bill_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  b public.erp_supplier_bills%ROWTYPE;
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
BEGIN
  SELECT * INTO b FROM public.erp_supplier_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  PERFORM public.erp__resolve_workspace(b.workspace_id, 'purchasing');
  IF public.erp_workspace_role(b.workspace_id) NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the Owner or an Admin can void a bill' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Give a reason (at least 3 characters)' USING ERRCODE = '22023', HINT = 'reason';
  END IF;
  IF b.status = 'void' THEN RETURN; END IF;
  IF b.amount_paid > 0 THEN
    RAISE EXCEPTION 'Void its payments first' USING ERRCODE = 'P0001', HINT = 'paid';
  END IF;
  IF b.bupot_number <> '' THEN
    RAISE EXCEPTION 'A bukti potong was issued for this bill: cancel it in e-Bupot first' USING ERRCODE = 'P0001', HINT = 'bupot';
  END IF;
  PERFORM public.erp_gl__reverse(b.user_id, 'supplier_bill:' || b.id, CURRENT_DATE, 'Void of bill from ' || b.supplier_name,
                                 'supplier_bill_void', b.id, 'supplier_bill_void:' || b.id);
  UPDATE public.erp_supplier_bills
     SET status = 'void', void_reason = left(v_reason, 500), voided_by = auth.uid(), voided_at = now()
   WHERE id = b.id;
END;
$$;

-- The bukti potong (e-Bupot Unifikasi) issued for a bill's PPh 23.
CREATE OR REPLACE FUNCTION public.erp_supplier_bill_bupot(p_bill_id UUID, p_number TEXT, p_date DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  b public.erp_supplier_bills%ROWTYPE;
  v_number TEXT := left(btrim(COALESCE(p_number, '')), 40);
BEGIN
  SELECT * INTO b FROM public.erp_supplier_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  PERFORM public.erp__resolve_workspace(b.workspace_id, 'purchasing');
  IF b.pph23_amount <= 0 THEN
    RAISE EXCEPTION 'This bill has no PPh 23' USING ERRCODE = 'P0001', HINT = 'no_pph23';
  END IF;
  IF b.status = 'void' THEN RAISE EXCEPTION 'This bill is void' USING ERRCODE = 'P0001', HINT = 'void'; END IF;
  UPDATE public.erp_supplier_bills
     SET bupot_number = v_number, bupot_date = CASE WHEN v_number = '' THEN NULL ELSE COALESCE(p_date, CURRENT_DATE) END
   WHERE id = b.id;
END;
$$;

-- Keeps a bill's paid amount right when one of its payments is voided.
CREATE OR REPLACE FUNCTION public.erp__bill_on_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.supplier_bill_id IS NOT NULL THEN PERFORM public.erp__bill_refresh(NEW.supplier_bill_id); END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_erp_bill_payment ON public.erp_payments;
CREATE TRIGGER trg_erp_bill_payment AFTER UPDATE OF voided_at ON public.erp_payments
  FOR EACH ROW EXECUTE FUNCTION public.erp__bill_on_payment();

-- ─── PPh 23 withheld by a customer ───────────────────────────────────────────

-- Recorded like a payment of the invoice (it settles that much of it), on
-- Prepaid PPh 23 instead of cash; the bukti potong number is its note.
CREATE OR REPLACE FUNCTION public.erp_invoice_pph23_withheld(p_invoice_id UUID, p_amount NUMERIC, p_date DATE, p_bupot_number TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i public.erp_invoices%ROWTYPE;
  v_amount NUMERIC := round(p_amount, 2);
  v_bupot TEXT := left(btrim(COALESCE(p_bupot_number, '')), 40);
  new_id UUID;
BEGIN
  SELECT * INTO i FROM public.erp_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  PERFORM public.erp__resolve_workspace(i.workspace_id, 'invoicing');
  IF i.status::TEXT = 'void' THEN RAISE EXCEPTION 'This invoice is void' USING ERRCODE = 'P0001', HINT = 'void'; END IF;
  IF i.currency IS NOT NULL AND i.fx_rate <> 1 THEN
    RAISE EXCEPTION 'PPh 23 is recorded on invoices in the base currency' USING ERRCODE = 'P0001', HINT = 'currency';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount > i.total - i.amount_paid THEN
    RAISE EXCEPTION 'The amount must be positive and at most what is still open (%)', i.total - i.amount_paid
      USING ERRCODE = 'P0001', HINT = 'amount';
  END IF;
  IF v_bupot = '' THEN
    RAISE EXCEPTION 'Enter the customer''s bukti potong number' USING ERRCODE = '22023', HINT = 'bupot_required';
  END IF;
  IF COALESCE(p_date, CURRENT_DATE) > CURRENT_DATE THEN
    RAISE EXCEPTION 'The date cannot be in the future' USING ERRCODE = '22023', HINT = 'future';
  END IF;
  INSERT INTO public.erp_payments (user_id, workspace_id, payment_type, party, amount, payment_date, method, note, invoice_id, created_by)
  VALUES (i.user_id, i.workspace_id, 'incoming', i.customer_name, v_amount, COALESCE(p_date, CURRENT_DATE), 'pph23',
          'PPh 23 bukti potong ' || v_bupot, i.id, auth.uid())
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

-- ─── Monthly summary ─────────────────────────────────────────────────────────

-- Per month of the period, from the ledger: PPN keluaran (output tax credited)
-- and masukan (input tax debited), PPh 21 and PPh 23 withheld (payable
-- credited) and PPh 23 withheld from us (prepaid debited), plus the bills
-- with PPh 23 and their bukti potong count.
CREATE OR REPLACE FUNCTION public.erp_tax_summary(p_workspace_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (month DATE, ppn_out NUMERIC, ppn_in NUMERIC, ppn_net NUMERIC, pph21 NUMERIC, pph23_withheld NUMERIC,
               pph23_prepaid NUMERIC, bills_with_pph23 INTEGER, bills_without_bupot INTEGER,
               invoices_taxed INTEGER, invoices_without_faktur INTEGER)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'read');
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces WHERE id = ws);
BEGIN
  RETURN QUERY
  WITH months AS (
    SELECT generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month')::DATE AS m
  ), moves AS (
    SELECT date_trunc('month', e.entry_date)::DATE AS m, a.system_key, sum(l.debit) AS d, sum(l.credit) AS c
      FROM public.erp_journal_entries e
      JOIN public.erp_journal_lines l ON l.entry_id = e.id
      JOIN public.erp_gl_accounts a ON a.id = l.account_id
     WHERE e.user_id = v_owner AND e.entry_date BETWEEN p_from AND p_to
       AND a.system_key IN ('tax_out', 'tax_in', 'pph21_payable', 'pph23_payable', 'pph23_prepaid')
     GROUP BY 1, 2
  )
  SELECT mo.m,
         COALESCE(sum(x.c - x.d) FILTER (WHERE x.system_key = 'tax_out'), 0),
         COALESCE(sum(x.d - x.c) FILTER (WHERE x.system_key = 'tax_in'), 0),
         COALESCE(sum(x.c - x.d) FILTER (WHERE x.system_key = 'tax_out'), 0)
           - COALESCE(sum(x.d - x.c) FILTER (WHERE x.system_key = 'tax_in'), 0),
         COALESCE(sum(x.c - x.d) FILTER (WHERE x.system_key = 'pph21_payable'), 0),
         COALESCE(sum(x.c - x.d) FILTER (WHERE x.system_key = 'pph23_payable'), 0),
         COALESCE(sum(x.d - x.c) FILTER (WHERE x.system_key = 'pph23_prepaid'), 0),
         (SELECT count(*)::INTEGER FROM public.erp_supplier_bills b WHERE b.workspace_id = ws AND b.status <> 'void'
             AND b.pph23_amount > 0 AND date_trunc('month', b.bill_date) = mo.m),
         (SELECT count(*)::INTEGER FROM public.erp_supplier_bills b WHERE b.workspace_id = ws AND b.status <> 'void'
             AND b.pph23_amount > 0 AND b.bupot_number = '' AND date_trunc('month', b.bill_date) = mo.m),
         (SELECT count(*)::INTEGER FROM public.erp_invoices i WHERE i.workspace_id = ws AND i.status::TEXT <> 'void'
             AND i.tax_amount > 0 AND date_trunc('month', i.invoice_date) = mo.m),
         (SELECT count(*)::INTEGER FROM public.erp_invoices i WHERE i.workspace_id = ws AND i.status::TEXT <> 'void'
             AND i.tax_amount > 0 AND i.faktur_status <> 'approved' AND date_trunc('month', i.invoice_date) = mo.m)
    FROM months mo
    LEFT JOIN moves x ON x.m = mo.m
   GROUP BY mo.m
   ORDER BY mo.m;
END;
$$;

-- ─── Company profile: the seller's NITKU ─────────────────────────────────────
-- As in 20261012000007, plus nitku.
CREATE OR REPLACE FUNCTION public.erp_company_profile_set(p_workspace_id UUID, p_profile JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := COALESCE(p_workspace_id, public.erp_personal_workspace_id(auth.uid()));
  v_logo TEXT := NULLIF(p_profile ->> 'logo', '');
  v_email TEXT := lower(btrim(COALESCE(p_profile ->> 'email', '')));
  v_nitku TEXT := regexp_replace(COALESCE(p_profile ->> 'nitku', ''), '[^0-9]', '', 'g');
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
  IF v_nitku <> '' AND v_nitku !~ '^[0-9]{22}$' THEN
    RAISE EXCEPTION 'A NITKU has 22 digits' USING ERRCODE = 'P0001', HINT = 'nitku';
  END IF;
  INSERT INTO public.erp_company_profiles AS c
    (workspace_id, legal_name, address, city, phone, email, website, tax_id, nitku, bank_details, footer_note, logo, updated_by, updated_at)
  VALUES (ws,
    left(btrim(COALESCE(p_profile ->> 'legal_name', '')), 200), left(btrim(COALESCE(p_profile ->> 'address', '')), 500),
    left(btrim(COALESCE(p_profile ->> 'city', '')), 100), left(btrim(COALESCE(p_profile ->> 'phone', '')), 50),
    left(v_email, 200), left(btrim(COALESCE(p_profile ->> 'website', '')), 200),
    left(btrim(COALESCE(p_profile ->> 'tax_id', '')), 50), v_nitku, left(btrim(COALESCE(p_profile ->> 'bank_details', '')), 500),
    left(btrim(COALESCE(p_profile ->> 'footer_note', '')), 500), v_logo, auth.uid(), now())
  ON CONFLICT (workspace_id) DO UPDATE SET
    legal_name = EXCLUDED.legal_name, address = EXCLUDED.address, city = EXCLUDED.city, phone = EXCLUDED.phone,
    email = EXCLUDED.email, website = EXCLUDED.website, tax_id = EXCLUDED.tax_id, nitku = EXCLUDED.nitku,
    bank_details = EXCLUDED.bank_details, footer_note = EXCLUDED.footer_note, logo = EXCLUDED.logo,
    updated_by = EXCLUDED.updated_by, updated_at = now();
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'company.profile_changed', jsonb_build_object('logo', v_logo IS NOT NULL));
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_company_profile_get(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    'tax_id', COALESCE(p.tax_id, ''), 'nitku', COALESCE(p.nitku, ''), 'bank_details', COALESCE(p.bank_details, ''),
    'footer_note', COALESCE(p.footer_note, ''), 'logo', p.logo);
END;
$$;

-- ─── Reset: bills go with the documents ──────────────────────────────────────
-- As in 20261012000026, plus supplier bills (their payments go with the
-- payments; the ledger is cleared by the reset itself).
CREATE OR REPLACE FUNCTION public.erp__reset_modules(p_workspace_id UUID, p_scope TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.erp_weigh_tickets x WHERE x.workspace_id = p_workspace_id;
  DELETE FROM public.erp_production_runs x WHERE x.workspace_id = p_workspace_id;
  DELETE FROM public.erp_equipment_logs x WHERE x.workspace_id = p_workspace_id;
  UPDATE public.erp_equipment x SET hour_meter = x.initial_hour_meter, last_service_hours = NULL, last_service_date = NULL
   WHERE x.workspace_id = p_workspace_id;
  UPDATE public.erp_payments x SET supplier_bill_id = NULL WHERE x.workspace_id = p_workspace_id AND x.supplier_bill_id IS NOT NULL;
  DELETE FROM public.erp_supplier_bills x WHERE x.workspace_id = p_workspace_id;
  IF p_scope = 'all' THEN
    DELETE FROM public.erp_vehicles x WHERE x.workspace_id = p_workspace_id;
    DELETE FROM public.erp_equipment x WHERE x.workspace_id = p_workspace_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_tax__account(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_tax__trx_code(public.erp_invoices) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__bill_refresh(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__bill_on_payment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_tax_faktur_list(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_tax_faktur_export(UUID, UUID[], BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_tax_faktur_set(UUID, TEXT, TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_supplier_bill_create(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_supplier_bill_pay(UUID, NUMERIC, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_supplier_bill_void(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_supplier_bill_bupot(UUID, TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_invoice_pph23_withheld(UUID, NUMERIC, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_tax_summary(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_tax_faktur_list(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_tax_faktur_export(UUID, UUID[], BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_tax_faktur_set(UUID, TEXT, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_supplier_bill_create(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_supplier_bill_pay(UUID, NUMERIC, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_supplier_bill_void(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_supplier_bill_bupot(UUID, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_invoice_pph23_withheld(UUID, NUMERIC, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_tax_summary(UUID, DATE, DATE) TO authenticated;
