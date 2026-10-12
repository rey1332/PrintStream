-- ─── Multi-currency: rates, base-currency lock, foreign-currency orders ──────
-- Builds on 20260930010000_erp_multi_currency (foreign-currency invoices and
-- payments). Additive; existing amounts are never rewritten.
--
-- Three currencies are kept apart:
--   • transaction currency — what a document was entered in (`currency`;
--     NULL means the workspace base currency, as before);
--   • base (functional) currency — erp_accounting_settings.base_currency, used
--     by the ledger and financial reports; now confirmed once by the Owner and
--     then locked while financial records exist;
--   • display currency — a per-person viewing preference kept in the browser;
--     it never reaches the database.
--
-- 1. erp_currencies: ISO 4217 codes with their minor units (reference data).
-- 2. Exchange-rate precision on invoices/payments widened to NUMERIC(24,12)
--    (8 decimals cannot express e.g. 1 IDR = 0.0000615384 USD). The stored
--    base amounts are recomputed from identical values, so they do not change.
-- 3. erp_exchange_rates: append-only rates (pair, effective date, source,
--    provider, retrieval time, who). Corrections are new rows; the lookup
--    takes the latest effective date on or before the requested date.
-- 4. Rate provenance (date, source, rate row) on invoices, payments, orders
--    and receipts.
-- 5. Base currency: Owner-only, confirmed once with a dry-run preview
--    (erp_currency_preview) and locked afterwards; every change is logged in
--    erp_currency_audit.
-- 6. Purchase and sales orders in a foreign currency:
--    • receipts value stock and payables at the receipt-date rate;
--    • invoices from a sales order use the invoice-date rate;
--    • payments settle payables/receivables at the carrying rate, the
--      difference goes to "Exchange differences" (4200), and a document that
--      is fully settled has its remaining base-currency balance cleared to
--      4200 (source 'fx_settlement').
--
-- Rollback: db/rollback/rollback_20261006000000_erp_currency_rates.sql

-- ─── 1. Currencies ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.erp_currencies (
  code TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name TEXT NOT NULL,
  minor_units SMALLINT NOT NULL CHECK (minor_units BETWEEN 0 AND 4)
);
ALTER TABLE public.erp_currencies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_currencies FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_currencies TO authenticated;
DROP POLICY IF EXISTS erp_currencies_read ON public.erp_currencies;
CREATE POLICY erp_currencies_read ON public.erp_currencies FOR SELECT TO authenticated USING (true);

INSERT INTO public.erp_currencies (code, name, minor_units) VALUES
  ('AED', 'United Arab Emirates Dirham', 2),
  ('AFN', 'Afghan Afghani', 2),
  ('ALL', 'Albanian Lek', 2),
  ('AMD', 'Armenian Dram', 2),
  ('ANG', 'Netherlands Antillean Guilder', 2),
  ('AOA', 'Angolan Kwanza', 2),
  ('ARS', 'Argentine Peso', 2),
  ('AUD', 'Australian Dollar', 2),
  ('AWG', 'Aruban Florin', 2),
  ('AZN', 'Azerbaijani Manat', 2),
  ('BAM', 'Bosnia-Herzegovina Convertible Mark', 2),
  ('BBD', 'Barbadian Dollar', 2),
  ('BDT', 'Bangladeshi Taka', 2),
  ('BGN', 'Bulgarian Lev', 2),
  ('BHD', 'Bahraini Dinar', 3),
  ('BIF', 'Burundian Franc', 0),
  ('BMD', 'Bermudan Dollar', 2),
  ('BND', 'Brunei Dollar', 2),
  ('BOB', 'Bolivian Boliviano', 2),
  ('BRL', 'Brazilian Real', 2),
  ('BSD', 'Bahamian Dollar', 2),
  ('BTN', 'Bhutanese Ngultrum', 2),
  ('BWP', 'Botswanan Pula', 2),
  ('BYN', 'Belarusian Ruble', 2),
  ('BZD', 'Belize Dollar', 2),
  ('CAD', 'Canadian Dollar', 2),
  ('CDF', 'Congolese Franc', 2),
  ('CHF', 'Swiss Franc', 2),
  ('CLP', 'Chilean Peso', 0),
  ('CNY', 'Chinese Yuan', 2),
  ('COP', 'Colombian Peso', 2),
  ('CRC', 'Costa Rican Colón', 2),
  ('CUC', 'Cuban Convertible Peso', 2),
  ('CUP', 'Cuban Peso', 2),
  ('CVE', 'Cape Verdean Escudo', 2),
  ('CZK', 'Czech Koruna', 2),
  ('DJF', 'Djiboutian Franc', 0),
  ('DKK', 'Danish Krone', 2),
  ('DOP', 'Dominican Peso', 2),
  ('DZD', 'Algerian Dinar', 2),
  ('EGP', 'Egyptian Pound', 2),
  ('ERN', 'Eritrean Nakfa', 2),
  ('ETB', 'Ethiopian Birr', 2),
  ('EUR', 'Euro', 2),
  ('FJD', 'Fijian Dollar', 2),
  ('FKP', 'Falkland Islands Pound', 2),
  ('GBP', 'British Pound', 2),
  ('GEL', 'Georgian Lari', 2),
  ('GHS', 'Ghanaian Cedi', 2),
  ('GIP', 'Gibraltar Pound', 2),
  ('GMD', 'Gambian Dalasi', 2),
  ('GNF', 'Guinean Franc', 0),
  ('GTQ', 'Guatemalan Quetzal', 2),
  ('GYD', 'Guyanaese Dollar', 2),
  ('HKD', 'Hong Kong Dollar', 2),
  ('HNL', 'Honduran Lempira', 2),
  ('HRK', 'Croatian Kuna', 2),
  ('HTG', 'Haitian Gourde', 2),
  ('HUF', 'Hungarian Forint', 2),
  ('IDR', 'Indonesian Rupiah', 2),
  ('ILS', 'Israeli New Shekel', 2),
  ('INR', 'Indian Rupee', 2),
  ('IQD', 'Iraqi Dinar', 3),
  ('IRR', 'Iranian Rial', 2),
  ('ISK', 'Icelandic Króna', 0),
  ('JMD', 'Jamaican Dollar', 2),
  ('JOD', 'Jordanian Dinar', 3),
  ('JPY', 'Japanese Yen', 0),
  ('KES', 'Kenyan Shilling', 2),
  ('KGS', 'Kyrgyz Som', 2),
  ('KHR', 'Cambodian Riel', 2),
  ('KMF', 'Comorian Franc', 0),
  ('KPW', 'North Korean Won', 2),
  ('KRW', 'South Korean Won', 0),
  ('KWD', 'Kuwaiti Dinar', 3),
  ('KYD', 'Cayman Islands Dollar', 2),
  ('KZT', 'Kazakhstani Tenge', 2),
  ('LAK', 'Laotian Kip', 2),
  ('LBP', 'Lebanese Pound', 2),
  ('LKR', 'Sri Lankan Rupee', 2),
  ('LRD', 'Liberian Dollar', 2),
  ('LSL', 'Lesotho Loti', 2),
  ('LYD', 'Libyan Dinar', 3),
  ('MAD', 'Moroccan Dirham', 2),
  ('MDL', 'Moldovan Leu', 2),
  ('MGA', 'Malagasy Ariary', 2),
  ('MKD', 'Macedonian Denar', 2),
  ('MMK', 'Myanmar Kyat', 2),
  ('MNT', 'Mongolian Tugrik', 2),
  ('MOP', 'Macanese Pataca', 2),
  ('MRU', 'Mauritanian Ouguiya', 2),
  ('MUR', 'Mauritian Rupee', 2),
  ('MVR', 'Maldivian Rufiyaa', 2),
  ('MWK', 'Malawian Kwacha', 2),
  ('MXN', 'Mexican Peso', 2),
  ('MYR', 'Malaysian Ringgit', 2),
  ('MZN', 'Mozambican Metical', 2),
  ('NAD', 'Namibian Dollar', 2),
  ('NGN', 'Nigerian Naira', 2),
  ('NIO', 'Nicaraguan Córdoba', 2),
  ('NOK', 'Norwegian Krone', 2),
  ('NPR', 'Nepalese Rupee', 2),
  ('NZD', 'New Zealand Dollar', 2),
  ('OMR', 'Omani Rial', 3),
  ('PAB', 'Panamanian Balboa', 2),
  ('PEN', 'Peruvian Sol', 2),
  ('PGK', 'Papua New Guinean Kina', 2),
  ('PHP', 'Philippine Peso', 2),
  ('PKR', 'Pakistani Rupee', 2),
  ('PLN', 'Polish Zloty', 2),
  ('PYG', 'Paraguayan Guarani', 0),
  ('QAR', 'Qatari Riyal', 2),
  ('RON', 'Romanian Leu', 2),
  ('RSD', 'Serbian Dinar', 2),
  ('RUB', 'Russian Ruble', 2),
  ('RWF', 'Rwandan Franc', 0),
  ('SAR', 'Saudi Riyal', 2),
  ('SBD', 'Solomon Islands Dollar', 2),
  ('SCR', 'Seychellois Rupee', 2),
  ('SDG', 'Sudanese Pound', 2),
  ('SEK', 'Swedish Krona', 2),
  ('SGD', 'Singapore Dollar', 2),
  ('SHP', 'St. Helena Pound', 2),
  ('SLE', 'Sierra Leonean Leone', 2),
  ('SLL', 'Sierra Leonean Leone (1964—2022)', 2),
  ('SOS', 'Somali Shilling', 2),
  ('SRD', 'Surinamese Dollar', 2),
  ('SSP', 'South Sudanese Pound', 2),
  ('STN', 'São Tomé & Príncipe Dobra', 2),
  ('SVC', 'Salvadoran Colón', 2),
  ('SYP', 'Syrian Pound', 2),
  ('SZL', 'Swazi Lilangeni', 2),
  ('THB', 'Thai Baht', 2),
  ('TJS', 'Tajikistani Somoni', 2),
  ('TMT', 'Turkmenistani Manat', 2),
  ('TND', 'Tunisian Dinar', 3),
  ('TOP', 'Tongan Paʻanga', 2),
  ('TRY', 'Turkish Lira', 2),
  ('TTD', 'Trinidad & Tobago Dollar', 2),
  ('TWD', 'New Taiwan Dollar', 2),
  ('TZS', 'Tanzanian Shilling', 2),
  ('UAH', 'Ukrainian Hryvnia', 2),
  ('UGX', 'Ugandan Shilling', 0),
  ('USD', 'US Dollar', 2),
  ('UYU', 'Uruguayan Peso', 2),
  ('UZS', 'Uzbekistani Som', 2),
  ('VES', 'Venezuelan Bolívar', 2),
  ('VND', 'Vietnamese Dong', 0),
  ('VUV', 'Vanuatu Vatu', 0),
  ('WST', 'Samoan Tala', 2),
  ('XAF', 'Central African CFA Franc', 0),
  ('XCD', 'East Caribbean Dollar', 2),
  ('XCG', 'Caribbean guilder', 2),
  ('XDR', 'Special Drawing Rights', 2),
  ('XOF', 'West African CFA Franc', 0),
  ('XPF', 'CFP Franc', 0),
  ('XSU', 'Sucre', 2),
  ('YER', 'Yemeni Rial', 2),
  ('ZAR', 'South African Rand', 2),
  ('ZMW', 'Zambian Kwacha', 2),
  ('ZWG', 'Zimbabwean Gold', 2),
  ('ZWL', 'Zimbabwean Dollar (2009–2024)', 2)
ON CONFLICT (code) DO NOTHING;

-- ─── 2. Exchange-rate precision on invoices and payments ─────────────────────
-- A column used by a generated column or named in a trigger cannot change
-- type, so the generated base amount is dropped and re-added with the same
-- expression (its values are recomputed from the unchanged total/amount and
-- rate) and the currency triggers are re-created below (section 9).
DROP TRIGGER IF EXISTS trg_erp_invoice_currency ON public.erp_invoices;
DROP TRIGGER IF EXISTS trg_erp_payment_currency ON public.erp_payments;
DO $$
BEGIN
  IF (SELECT numeric_scale FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'erp_invoices' AND column_name = 'fx_rate') < 12 THEN
    ALTER TABLE public.erp_invoices DROP COLUMN IF EXISTS base_total;
    ALTER TABLE public.erp_invoices ALTER COLUMN fx_rate TYPE NUMERIC(24,12);
    ALTER TABLE public.erp_invoices ADD COLUMN base_total NUMERIC(15,2) GENERATED ALWAYS AS (round(total * fx_rate, 2)) STORED;
  END IF;
  IF (SELECT numeric_scale FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'erp_payments' AND column_name = 'fx_rate') < 12 THEN
    ALTER TABLE public.erp_payments DROP COLUMN IF EXISTS base_amount;
    ALTER TABLE public.erp_payments ALTER COLUMN fx_rate TYPE NUMERIC(24,12);
    ALTER TABLE public.erp_payments ADD COLUMN base_amount NUMERIC(15,2) GENERATED ALWAYS AS (round(amount * fx_rate, 2)) STORED;
  END IF;
END;
$$;

-- ─── 3. Exchange rates ────────────────────────────────────────────────────────
-- Scoped like the ledger: to the workspace owner's books (user_id), recorded
-- from a workspace. 1 from_currency = rate × to_currency.
CREATE TABLE IF NOT EXISTS public.erp_exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL,
  from_currency TEXT NOT NULL REFERENCES public.erp_currencies(code),
  to_currency TEXT NOT NULL REFERENCES public.erp_currencies(code),
  rate NUMERIC(24,12) NOT NULL CHECK (rate > 0),
  effective_date DATE NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'frankfurter')),
  provider TEXT NOT NULL DEFAULT '' CHECK (char_length(provider) <= 100),
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_currency <> to_currency)
);
CREATE INDEX IF NOT EXISTS idx_erp_exchange_rates_lookup
  ON public.erp_exchange_rates(user_id, from_currency, to_currency, effective_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_erp_exchange_rates_recent ON public.erp_exchange_rates(user_id, created_at DESC);

ALTER TABLE public.erp_exchange_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_exchange_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_exchange_rates TO authenticated;
DROP POLICY IF EXISTS erp_exchange_rates_read ON public.erp_exchange_rates;
CREATE POLICY erp_exchange_rates_read ON public.erp_exchange_rates
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, 'read')));

-- Rates are never edited: a correction is a new row (the latest wins).
CREATE OR REPLACE FUNCTION public.erp_exchange_rates_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Exchange rates cannot be changed; record a corrected rate instead' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.erp_exchange_rates_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_erp_exchange_rates_immutable ON public.erp_exchange_rates;
CREATE TRIGGER trg_erp_exchange_rates_immutable BEFORE UPDATE ON public.erp_exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public.erp_exchange_rates_immutable();

-- ─── 4. Currency audit log ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.erp_currency_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL,
  actor_id UUID,
  action TEXT NOT NULL CHECK (action IN ('base_confirmed', 'base_changed', 'rate_added', 'rates_imported')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_erp_currency_audit_owner ON public.erp_currency_audit(user_id, created_at DESC);
ALTER TABLE public.erp_currency_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_currency_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_currency_audit TO authenticated;
DROP POLICY IF EXISTS erp_currency_audit_read ON public.erp_currency_audit;
CREATE POLICY erp_currency_audit_read ON public.erp_currency_audit
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR actor_id = auth.uid()
         OR (workspace_id IS NOT NULL AND (public.erp_has_permission(workspace_id, 'audit')
                                           OR public.erp_has_permission(workspace_id, 'payments'))));

CREATE OR REPLACE FUNCTION public.erp_fx__audit(p_owner UUID, p_workspace_id UUID, p_action TEXT, p_details JSONB)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.erp_currency_audit (user_id, workspace_id, actor_id, action, details)
  VALUES (p_owner, p_workspace_id, auth.uid(), p_action, COALESCE(p_details, '{}'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.erp_fx__audit(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- ─── 5. Provenance and foreign-currency orders ───────────────────────────────
ALTER TABLE public.erp_invoices
  ADD COLUMN IF NOT EXISTS fx_rate_date DATE,
  ADD COLUMN IF NOT EXISTS fx_rate_source TEXT,
  ADD COLUMN IF NOT EXISTS fx_rate_id UUID REFERENCES public.erp_exchange_rates(id);
ALTER TABLE public.erp_payments
  ADD COLUMN IF NOT EXISTS fx_rate_date DATE,
  ADD COLUMN IF NOT EXISTS fx_rate_source TEXT,
  ADD COLUMN IF NOT EXISTS fx_rate_id UUID REFERENCES public.erp_exchange_rates(id);
ALTER TABLE public.erp_purchase_orders
  ADD COLUMN IF NOT EXISTS currency TEXT,
  ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(24,12) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fx_rate_date DATE,
  ADD COLUMN IF NOT EXISTS fx_rate_source TEXT,
  ADD COLUMN IF NOT EXISTS fx_rate_id UUID REFERENCES public.erp_exchange_rates(id);
ALTER TABLE public.erp_sales_orders
  ADD COLUMN IF NOT EXISTS currency TEXT,
  ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(24,12) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fx_rate_date DATE,
  ADD COLUMN IF NOT EXISTS fx_rate_source TEXT,
  ADD COLUMN IF NOT EXISTS fx_rate_id UUID REFERENCES public.erp_exchange_rates(id);
ALTER TABLE public.erp_fulfillment_events
  ADD COLUMN IF NOT EXISTS currency TEXT,
  ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(24,12) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fx_rate_date DATE,
  ADD COLUMN IF NOT EXISTS fx_rate_source TEXT,
  ADD COLUMN IF NOT EXISTS fx_rate_id UUID REFERENCES public.erp_exchange_rates(id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['erp_invoices', 'erp_payments', 'erp_purchase_orders', 'erp_sales_orders', 'erp_fulfillment_events'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_fx_source_check') THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (fx_rate_source IS NULL OR fx_rate_source IN (''manual'', ''rate_table'', ''document''))',
        t, t || '_fx_source_check');
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['erp_purchase_orders', 'erp_sales_orders', 'erp_fulfillment_events'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_currency_check') THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK ((currency IS NULL AND fx_rate = 1) OR (currency ~ ''^[A-Z]{3}$'' AND fx_rate > 0))',
        t, t || '_currency_check');
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'erp_purchase_orders' AND column_name = 'base_total') THEN
    ALTER TABLE public.erp_purchase_orders ADD COLUMN base_total NUMERIC(15,2) GENERATED ALWAYS AS (round(total * fx_rate, 2)) STORED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'erp_sales_orders' AND column_name = 'base_total') THEN
    ALTER TABLE public.erp_sales_orders ADD COLUMN base_total NUMERIC(15,2) GENERATED ALWAYS AS (round(total * fx_rate, 2)) STORED;
  END IF;
END;
$$;

-- Settlement differences get their own journal source.
ALTER TABLE public.erp_journal_entries DROP CONSTRAINT IF EXISTS erp_journal_entries_source_type_check;
ALTER TABLE public.erp_journal_entries ADD CONSTRAINT erp_journal_entries_source_type_check CHECK (source_type IN (
  'invoice', 'invoice_void', 'invoice_adjust', 'payment', 'payment_void', 'payment_adjust', 'transaction',
  'purchase_receipt', 'sales_delivery', 'stock_adjustment', 'opening_stock', 'manual', 'manual_reversal',
  'fx_settlement'));

-- ─── 6. Settings: confirmation and lock ──────────────────────────────────────
ALTER TABLE public.erp_accounting_settings
  ADD COLUMN IF NOT EXISTS base_currency_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS base_currency_confirmed_by UUID;

-- The base currency changes only through the functions below.
CREATE OR REPLACE FUNCTION public.erp_guard_base_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.base_currency IS DISTINCT FROM OLD.base_currency
     AND current_setting('erp.base_currency_change', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'The base currency can only be changed in Settings → Currencies' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_guard_base_currency() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_erp_guard_base_currency ON public.erp_accounting_settings;
CREATE TRIGGER trg_erp_guard_base_currency BEFORE UPDATE OF base_currency ON public.erp_accounting_settings
  FOR EACH ROW EXECUTE FUNCTION public.erp_guard_base_currency();

CREATE OR REPLACE FUNCTION public.erp_fx__base(p_owner UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT base_currency FROM public.erp_accounting_settings WHERE user_id = p_owner), 'USD');
$$;
REVOKE ALL ON FUNCTION public.erp_fx__base(UUID) FROM PUBLIC, anon, authenticated;

-- Any financial record in the owner's books.
CREATE OR REPLACE FUNCTION public.erp_fx__has_records(p_owner UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.erp_invoices WHERE user_id = p_owner)
      OR EXISTS (SELECT 1 FROM public.erp_payments WHERE user_id = p_owner)
      OR EXISTS (SELECT 1 FROM public.erp_purchase_orders WHERE user_id = p_owner)
      OR EXISTS (SELECT 1 FROM public.erp_sales_orders WHERE user_id = p_owner)
      OR EXISTS (SELECT 1 FROM public.erp_transactions WHERE user_id = p_owner)
      OR EXISTS (SELECT 1 FROM public.erp_journal_entries WHERE user_id = p_owner);
$$;
REVOKE ALL ON FUNCTION public.erp_fx__has_records(UUID) FROM PUBLIC, anon, authenticated;

-- ─── 7. Rate lookup ───────────────────────────────────────────────────────────
-- The rate on or before p_date: the latest effective date wins, then the
-- latest recorded (a correction). A stored inverse pair is used as 1/rate
-- (rounded to 12 decimals) when it is more recent than the direct pair.
-- Same data and date, same answer.
CREATE OR REPLACE FUNCTION public.erp_fx__find_rate(p_owner UUID, p_from TEXT, p_to TEXT, p_date DATE)
RETURNS TABLE (rate NUMERIC, rate_date DATE, source TEXT, provider TEXT, rate_id UUID, method TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d RECORD;
  i RECORD;
BEGIN
  IF p_from = p_to THEN
    RETURN QUERY SELECT 1::NUMERIC, p_date, 'identity'::TEXT, ''::TEXT, NULL::UUID, 'identity'::TEXT;
    RETURN;
  END IF;
  SELECT r.* INTO d FROM public.erp_exchange_rates r
  WHERE r.user_id = p_owner AND r.from_currency = p_from AND r.to_currency = p_to AND r.effective_date <= p_date
  ORDER BY r.effective_date DESC, r.created_at DESC, r.id DESC LIMIT 1;
  SELECT r.* INTO i FROM public.erp_exchange_rates r
  WHERE r.user_id = p_owner AND r.from_currency = p_to AND r.to_currency = p_from AND r.effective_date <= p_date
  ORDER BY r.effective_date DESC, r.created_at DESC, r.id DESC LIMIT 1;
  IF d.id IS NOT NULL AND (i.id IS NULL OR d.effective_date >= i.effective_date) THEN
    RETURN QUERY SELECT d.rate, d.effective_date, d.source, d.provider, d.id, 'direct'::TEXT;
  ELSIF i.id IS NOT NULL THEN
    RETURN QUERY SELECT round(1 / i.rate, 12), i.effective_date, i.source, i.provider, i.id, 'inverse'::TEXT;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_fx__find_rate(UUID, TEXT, TEXT, DATE) FROM PUBLIC, anon, authenticated;

-- Rates older than this (before the transaction date) are not used automatically.
CREATE OR REPLACE FUNCTION public.erp_fx__max_age_days()
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT 7 $$;

CREATE OR REPLACE FUNCTION public.erp_fx__require_rate(p_owner UUID, p_from TEXT, p_to TEXT, p_date DATE)
RETURNS TABLE (rate NUMERIC, rate_date DATE, source TEXT, rate_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM public.erp_fx__find_rate(p_owner, p_from, p_to, p_date);
  IF r.rate IS NULL THEN
    RAISE EXCEPTION 'No exchange rate from % to % on or before %. Add one in Settings → Currencies, or enter the rate.', p_from, p_to, p_date
      USING ERRCODE = 'P0001', HINT = 'fx_missing';
  END IF;
  IF p_date - r.rate_date > public.erp_fx__max_age_days() THEN
    RAISE EXCEPTION 'The latest % to % rate is from % (more than % days before %). Add a current rate, or enter the rate.',
      p_from, p_to, r.rate_date, public.erp_fx__max_age_days(), p_date
      USING ERRCODE = 'P0001', HINT = 'fx_stale';
  END IF;
  RETURN QUERY SELECT r.rate, r.rate_date, 'rate_table'::TEXT, r.rate_id;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_fx__require_rate(UUID, TEXT, TEXT, DATE) FROM PUBLIC, anon, authenticated;

-- The rate a new document uses: the one entered, or the stored rate for its date.
CREATE OR REPLACE FUNCTION public.erp_fx__resolve(p_owner UUID, p_currency TEXT, p_date DATE, p_manual_rate NUMERIC)
RETURNS TABLE (currency TEXT, rate NUMERIC, rate_date DATE, source TEXT, rate_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  base TEXT := public.erp_fx__base(p_owner);
  r RECORD;
BEGIN
  IF p_currency IS NULL OR p_currency = base THEN
    RETURN QUERY SELECT NULL::TEXT, 1::NUMERIC, NULL::DATE, NULL::TEXT, NULL::UUID;
    RETURN;
  END IF;
  IF p_currency !~ '^[A-Z]{3}$' OR NOT EXISTS (SELECT 1 FROM public.erp_currencies WHERE code = p_currency) THEN
    RAISE EXCEPTION 'Unknown currency %', p_currency USING ERRCODE = 'P0001';
  END IF;
  IF p_manual_rate IS NOT NULL THEN
    IF p_manual_rate <= 0 THEN RAISE EXCEPTION 'The exchange rate must be greater than zero' USING ERRCODE = 'P0001'; END IF;
    RETURN QUERY SELECT p_currency, round(p_manual_rate, 12), p_date, 'manual'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  SELECT * INTO r FROM public.erp_fx__require_rate(p_owner, p_currency, base, p_date);
  RETURN QUERY SELECT p_currency, r.rate, r.rate_date, r.source, r.rate_id;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_fx__resolve(UUID, TEXT, DATE, NUMERIC) FROM PUBLIC, anon, authenticated;

-- Public lookup for the forms (read permission).
CREATE OR REPLACE FUNCTION public.erp_exchange_rate_lookup(p_workspace_id UUID, p_from TEXT, p_to TEXT, p_date DATE)
RETURNS TABLE (rate NUMERIC, rate_date DATE, source TEXT, provider TEXT, rate_id UUID, method TEXT, age_days INTEGER, stale BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE owner UUID := public.erp_gl__scope(p_workspace_id, 'read');
BEGIN
  RETURN QUERY
  SELECT f.rate, f.rate_date, f.source, f.provider, f.rate_id, f.method,
         (COALESCE(p_date, CURRENT_DATE) - f.rate_date)::INTEGER,
         (COALESCE(p_date, CURRENT_DATE) - f.rate_date) > public.erp_fx__max_age_days()
  FROM public.erp_fx__find_rate(owner, upper(p_from), upper(p_to), COALESCE(p_date, CURRENT_DATE)) f;
END;
$$;

-- Manual rates: Owner, Admin and Finance (payments permission).
CREATE OR REPLACE FUNCTION public.erp_add_exchange_rate(
  p_workspace_id UUID, p_from TEXT, p_to TEXT, p_rate NUMERIC, p_effective_date DATE, p_note TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner UUID := public.erp_gl__scope(p_workspace_id, 'payments');
  new_id UUID;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from = p_to
     OR NOT EXISTS (SELECT 1 FROM public.erp_currencies WHERE code = p_from)
     OR NOT EXISTS (SELECT 1 FROM public.erp_currencies WHERE code = p_to) THEN
    RAISE EXCEPTION 'Choose two different ISO currencies' USING ERRCODE = 'P0001';
  END IF;
  IF p_rate IS NULL OR p_rate <= 0 THEN RAISE EXCEPTION 'The exchange rate must be greater than zero' USING ERRCODE = 'P0001'; END IF;
  IF p_effective_date IS NULL OR p_effective_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'The rate date cannot be in the future' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.erp_exchange_rates
    (user_id, workspace_id, from_currency, to_currency, rate, effective_date, source, provider, note, created_by)
  VALUES (owner, p_workspace_id, p_from, p_to, round(p_rate, 12), p_effective_date, 'manual', '',
          left(COALESCE(p_note, ''), 300), auth.uid())
  RETURNING id INTO new_id;
  PERFORM public.erp_fx__audit(owner, p_workspace_id, 'rate_added',
    jsonb_build_object('rate_id', new_id, 'from', p_from, 'to', p_to, 'rate', round(p_rate, 12), 'date', p_effective_date));
  RETURN new_id;
END;
$$;

-- Rates fetched by the server from the configured provider. Only the ETNA
-- server's rate route can call it (request.path is set by the server; the
-- data API sets /rpc/<name>), so a browser cannot store rates labelled as
-- provider rates. Anyone who records foreign-currency transactions may
-- trigger a fetch.
CREATE OR REPLACE FUNCTION public.erp_import_exchange_rates(
  p_workspace_id UUID, p_provider TEXT, p_retrieved_at TIMESTAMPTZ, p_rows JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner UUID := public.erp_gl__scope(p_workspace_id, 'read');
  row JSONB;
  inserted INTEGER := 0;
  v_from TEXT; v_to TEXT; v_rate NUMERIC; v_date DATE;
BEGIN
  IF current_setting('request.path', true) IS DISTINCT FROM '/currency/import' THEN
    RAISE EXCEPTION 'Provider rates are recorded by the ETNA server only' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NOT NULL AND NOT (
       public.erp_has_permission(p_workspace_id, 'invoicing') OR public.erp_has_permission(p_workspace_id, 'payments')
    OR public.erp_has_permission(p_workspace_id, 'purchasing') OR public.erp_has_permission(p_workspace_id, 'sales')) THEN
    RAISE EXCEPTION 'Your workspace role does not allow this action' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 200 THEN
    RAISE EXCEPTION 'Invalid rates' USING ERRCODE = '22023';
  END IF;
  FOR row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    BEGIN
      v_from := row->>'from'; v_to := row->>'to';
      v_rate := (row->>'rate')::NUMERIC; v_date := (row->>'date')::DATE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid rate row' USING ERRCODE = '22023';
    END;
    IF v_from = v_to OR v_rate IS NULL OR v_rate <= 0 OR v_date IS NULL OR v_date > CURRENT_DATE
       OR NOT EXISTS (SELECT 1 FROM public.erp_currencies WHERE code = v_from)
       OR NOT EXISTS (SELECT 1 FROM public.erp_currencies WHERE code = v_to) THEN
      RAISE EXCEPTION 'Invalid rate row' USING ERRCODE = '22023';
    END IF;
    -- The same published rate is stored once.
    IF NOT EXISTS (SELECT 1 FROM public.erp_exchange_rates
                   WHERE user_id = owner AND from_currency = v_from AND to_currency = v_to
                     AND effective_date = v_date AND source = 'frankfurter' AND rate = round(v_rate, 12)) THEN
      INSERT INTO public.erp_exchange_rates
        (user_id, workspace_id, from_currency, to_currency, rate, effective_date, source, provider, retrieved_at, created_by)
      VALUES (owner, p_workspace_id, v_from, v_to, round(v_rate, 12), v_date, 'frankfurter',
              left(COALESCE(p_provider, ''), 100), COALESCE(p_retrieved_at, now()), auth.uid());
      inserted := inserted + 1;
    END IF;
  END LOOP;
  IF inserted > 0 THEN
    PERFORM public.erp_fx__audit(owner, p_workspace_id, 'rates_imported',
      jsonb_build_object('provider', left(COALESCE(p_provider, ''), 100), 'count', inserted, 'retrieved_at', p_retrieved_at));
  END IF;
  RETURN inserted;
END;
$$;

-- ─── 8. Base currency: settings, preview, confirmation ──────────────────────

CREATE OR REPLACE FUNCTION public.erp_currency_settings_get(p_workspace_id UUID)
RETURNS TABLE (
  base_currency TEXT, confirmed_at TIMESTAMPTZ, locked BOOLEAN, has_records BOOLEAN,
  can_change_base BOOLEAN, can_manage_rates BOOLEAN, can_fetch_rates BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner UUID := public.erp_gl__scope(p_workspace_id, 'read');
  records BOOLEAN := public.erp_fx__has_records(owner);
BEGIN
  PERFORM public.erp_gl__seed(owner);
  RETURN QUERY
  SELECT s.base_currency, s.base_currency_confirmed_at, s.base_currency_confirmed_at IS NOT NULL AND records, records,
         owner = auth.uid(),
         owner = auth.uid() OR (p_workspace_id IS NOT NULL AND public.erp_has_permission(p_workspace_id, 'payments')),
         owner = auth.uid() OR (p_workspace_id IS NOT NULL AND (
           public.erp_has_permission(p_workspace_id, 'invoicing') OR public.erp_has_permission(p_workspace_id, 'payments')
           OR public.erp_has_permission(p_workspace_id, 'purchasing') OR public.erp_has_permission(p_workspace_id, 'sales')))
  FROM public.erp_accounting_settings s WHERE s.user_id = owner;
END;
$$;

-- Dry run: which records carry no currency code (they mean "the base
-- currency"), whether their currency is certain, and their totals for
-- reconciliation. Changes nothing.
CREATE OR REPLACE FUNCTION public.erp_currency_preview(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner UUID := public.erp_gl__scope(p_workspace_id, 'read');
  s public.erp_accounting_settings;
  saved_at TIMESTAMPTZ;
  tables JSONB;
  base_rows BIGINT;
  uncertain BIGINT;
  foreign_docs BIGINT;
  status TEXT;
BEGIN
  IF p_workspace_id IS NOT NULL AND NOT (public.erp_has_permission(p_workspace_id, 'members')
                                         OR public.erp_has_permission(p_workspace_id, 'payments')) THEN
    RAISE EXCEPTION 'Your workspace role does not allow this action' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public.erp_accounting_settings WHERE user_id = owner;
  -- A person saved the accounting settings (the base currency was on that form).
  saved_at := CASE WHEN s.updated_by IS NOT NULL THEN s.updated_at END;

  WITH t AS (
    SELECT 'invoices' AS tbl, currency, total AS amount, invoice_date AS doc_date, created_at FROM public.erp_invoices WHERE user_id = owner
    UNION ALL SELECT 'payments', currency, amount, payment_date, created_at FROM public.erp_payments WHERE user_id = owner
    UNION ALL SELECT 'purchaseOrders', currency, total, order_date, created_at FROM public.erp_purchase_orders WHERE user_id = owner
    UNION ALL SELECT 'salesOrders', currency, total, order_date, created_at FROM public.erp_sales_orders WHERE user_id = owner
    UNION ALL SELECT 'cashTransactions', NULL, amount, transaction_date, created_at FROM public.erp_transactions WHERE user_id = owner
    UNION ALL SELECT 'journalEntries', NULL, NULL, entry_date, created_at FROM public.erp_journal_entries WHERE user_id = owner
    UNION ALL SELECT 'products', NULL, NULL, created_at::date, created_at FROM public.erp_products WHERE user_id = owner
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'table'), '[]'::jsonb) INTO tables FROM (
    SELECT jsonb_build_object(
      'table', tbl,
      'baseRows', count(*) FILTER (WHERE currency IS NULL),
      'baseSum', COALESCE(sum(amount) FILTER (WHERE currency IS NULL), 0),
      'baseRowsCertain', count(*) FILTER (WHERE currency IS NULL AND saved_at IS NOT NULL AND created_at > saved_at),
      'firstDate', min(doc_date) FILTER (WHERE currency IS NULL),
      'lastDate', max(doc_date) FILTER (WHERE currency IS NULL),
      'foreignRows', count(*) FILTER (WHERE currency IS NOT NULL),
      'foreignCurrencies', COALESCE(to_jsonb(array_agg(DISTINCT currency) FILTER (WHERE currency IS NOT NULL)), '[]'::jsonb)
    ) AS x
    FROM t GROUP BY tbl
  ) q;

  SELECT COALESCE(sum((x->>'baseRows')::BIGINT), 0), COALESCE(sum((x->>'baseRows')::BIGINT - (x->>'baseRowsCertain')::BIGINT), 0),
         COALESCE(sum((x->>'foreignRows')::BIGINT), 0)
  INTO base_rows, uncertain, foreign_docs FROM jsonb_array_elements(tables) x;

  status := CASE
    WHEN s.base_currency_confirmed_at IS NOT NULL THEN 'confirmed'
    WHEN base_rows = 0 AND foreign_docs = 0 THEN 'noRecords'
    WHEN uncertain = 0 THEN 'unambiguous'
    ELSE 'needsDecision' END;

  RETURN jsonb_build_object(
    'baseCurrency', s.base_currency,
    'confirmedAt', s.base_currency_confirmed_at,
    'settingsSavedAt', saved_at,
    'baseCurrencyIsDefault', saved_at IS NULL,
    'status', status,
    'baseRows', base_rows,
    'uncertainRows', uncertain,
    'foreignDocuments', foreign_docs,
    'tables', tables);
END;
$$;

-- The Owner states which currency the existing base-currency records are in.
-- Nothing is rewritten: those records keep "no code = base currency", and the
-- base currency is then locked, so their meaning cannot drift. p_base_rows is
-- the count the Owner reviewed; if records changed since, review again.
CREATE OR REPLACE FUNCTION public.erp_confirm_base_currency(p_workspace_id UUID, p_currency TEXT, p_base_rows BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner UUID := public.erp_gl__scope(p_workspace_id, 'read');
  s public.erp_accounting_settings;
  preview JSONB;
  minor INTEGER;
BEGIN
  IF owner IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the workspace owner can confirm the base currency' USING ERRCODE = '42501';
  END IF;
  SELECT minor_units INTO minor FROM public.erp_currencies WHERE code = p_currency;
  IF minor IS NULL THEN RAISE EXCEPTION 'Unknown currency %', p_currency USING ERRCODE = 'P0001'; END IF;
  IF minor > 2 THEN
    RAISE EXCEPTION '% has % decimals; the ledger keeps 2, so it cannot be the base currency', p_currency, minor USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.erp_gl__seed(owner);
  SELECT * INTO s FROM public.erp_accounting_settings WHERE user_id = owner FOR UPDATE;
  preview := public.erp_currency_preview(p_workspace_id);

  IF s.base_currency_confirmed_at IS NOT NULL THEN
    IF s.base_currency = p_currency THEN RETURN preview; END IF;
    RAISE EXCEPTION 'The base currency is already confirmed as % and locked', s.base_currency USING ERRCODE = 'P0001';
  END IF;
  IF p_base_rows IS DISTINCT FROM (preview->>'baseRows')::BIGINT THEN
    RAISE EXCEPTION 'Records changed since the preview (% now); review the preview again', preview->>'baseRows'
      USING ERRCODE = 'P0001', HINT = 'fx_preview_changed';
  END IF;
  -- Foreign-currency documents carry rates to the current base currency; a
  -- different base would make those rates wrong. That needs a decision per
  -- document, which ETNA does not guess.
  IF p_currency <> s.base_currency AND (preview->>'foreignDocuments')::BIGINT > 0 THEN
    RAISE EXCEPTION '% foreign-currency documents have exchange rates to %; they must be reviewed before the base currency can be declared as %',
      preview->>'foreignDocuments', s.base_currency, p_currency USING ERRCODE = 'P0001', HINT = 'fx_foreign_documents';
  END IF;

  PERFORM set_config('erp.base_currency_change', 'on', true);
  UPDATE public.erp_accounting_settings
  SET base_currency = p_currency, base_currency_confirmed_at = now(), base_currency_confirmed_by = auth.uid(),
      updated_at = now(), updated_by = auth.uid()
  WHERE user_id = owner;
  PERFORM set_config('erp.base_currency_change', '', true);

  PERFORM public.erp_fx__audit(owner, p_workspace_id, 'base_confirmed', jsonb_build_object(
    'previous', s.base_currency, 'currency', p_currency, 'status', preview->>'status', 'tables', preview->'tables'));
  RETURN public.erp_currency_preview(p_workspace_id);
END;
$$;

-- Changing the base currency: Owner only; free while the books are empty;
-- otherwise through the confirmation above, and never once confirmed.
CREATE OR REPLACE FUNCTION public.erp_fx__change_base(p_owner UUID, p_workspace_id UUID, p_currency TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.erp_accounting_settings;
  minor INTEGER;
BEGIN
  SELECT * INTO s FROM public.erp_accounting_settings WHERE user_id = p_owner FOR UPDATE;
  IF s.base_currency = p_currency THEN RETURN; END IF;
  IF p_owner IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the workspace owner can change the base currency' USING ERRCODE = '42501';
  END IF;
  SELECT minor_units INTO minor FROM public.erp_currencies WHERE code = p_currency;
  IF minor IS NULL OR minor > 2 THEN
    RAISE EXCEPTION '% cannot be the base currency', p_currency USING ERRCODE = 'P0001';
  END IF;
  IF public.erp_fx__has_records(p_owner) THEN
    IF s.base_currency_confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'The base currency is locked as % because financial records exist', s.base_currency USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'Financial records already exist. Review them and confirm their currency in Settings → Currencies'
      USING ERRCODE = 'P0001', HINT = 'fx_confirm_required';
  END IF;
  PERFORM set_config('erp.base_currency_change', 'on', true);
  UPDATE public.erp_accounting_settings SET base_currency = p_currency, updated_at = now(), updated_by = auth.uid()
  WHERE user_id = p_owner;
  PERFORM set_config('erp.base_currency_change', '', true);
  PERFORM public.erp_fx__audit(p_owner, p_workspace_id, 'base_changed', jsonb_build_object('previous', s.base_currency, 'currency', p_currency));
END;
$$;
REVOKE ALL ON FUNCTION public.erp_fx__change_base(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- The accounting settings form keeps working; a different base currency goes
-- through the rules above.
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
  IF p_base_currency <> current.base_currency THEN
    PERFORM public.erp_fx__change_base(owner, p_workspace_id, p_base_currency);
  END IF;
  UPDATE public.erp_accounting_settings
  SET lock_date = p_lock_date, sales_tax_rate = p_sales_tax_rate, updated_at = now(), updated_by = auth.uid()
  WHERE user_id = owner;
END;
$$;

-- ─── 9. Documents ─────────────────────────────────────────────────────────────

-- Invoice currency: a known ISO code, NULL for the base currency.
CREATE OR REPLACE FUNCTION public.erp_normalize_invoice_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.currency IS NOT NULL THEN
    IF NEW.currency = public.erp_fx__base(NEW.user_id) THEN
      NEW.currency := NULL;
    ELSIF NOT EXISTS (SELECT 1 FROM public.erp_currencies WHERE code = NEW.currency) THEN
      RAISE EXCEPTION 'Unknown currency %', NEW.currency USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.currency IS NULL THEN
    NEW.fx_rate := 1; NEW.fx_rate_date := NULL; NEW.fx_rate_source := NULL; NEW.fx_rate_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_erp_invoice_currency ON public.erp_invoices;
CREATE TRIGGER trg_erp_invoice_currency BEFORE INSERT OR UPDATE OF currency, fx_rate ON public.erp_invoices
  FOR EACH ROW EXECUTE FUNCTION public.erp_normalize_invoice_currency();

-- Picks up the currency, rate and its provenance passed by the invoice
-- functions (transaction-local settings).
CREATE OR REPLACE FUNCTION public.erp_invoice_currency_from_request()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(current_setting('erp.new_invoice_currency', true), '') <> '' THEN
    NEW.currency := current_setting('erp.new_invoice_currency', true);
    NEW.fx_rate := current_setting('erp.new_invoice_rate', true)::NUMERIC;
    NEW.fx_rate_source := COALESCE(NULLIF(current_setting('erp.new_invoice_rate_source', true), ''), 'manual');
    NEW.fx_rate_date := COALESCE(NULLIF(current_setting('erp.new_invoice_rate_date', true), '')::DATE, NEW.invoice_date);
    NEW.fx_rate_id := NULLIF(current_setting('erp.new_invoice_rate_id', true), '')::UUID;
  END IF;
  RETURN NEW;
END;
$$;

-- Invoice in any currency; without p_fx_rate the stored rate for the invoice
-- date is used (and recorded with its source), or an error names the missing rate.
CREATE OR REPLACE FUNCTION public.erp_create_invoice_v5(
  p_workspace_id UUID, p_customer_id UUID, p_customer_name TEXT, p_invoice_date DATE, p_due_date DATE,
  p_subtotal NUMERIC(15,2), p_tax_rate NUMERIC(5,2), p_currency TEXT, p_fx_rate NUMERIC
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  workspace UUID := public.erp__resolve_workspace(p_workspace_id, 'invoicing');
  owner UUID;
  r RECORD;
  new_id UUID;
BEGIN
  SELECT owner_id INTO owner FROM public.erp_workspaces WHERE id = workspace;
  SELECT * INTO r FROM public.erp_fx__resolve(owner, upper(NULLIF(p_currency, '')), COALESCE(p_invoice_date, CURRENT_DATE), p_fx_rate);
  PERFORM set_config('erp.new_invoice_currency', COALESCE(r.currency, ''), true);
  PERFORM set_config('erp.new_invoice_rate', r.rate::TEXT, true);
  PERFORM set_config('erp.new_invoice_rate_source', COALESCE(r.source, ''), true);
  PERFORM set_config('erp.new_invoice_rate_date', COALESCE(r.rate_date::TEXT, ''), true);
  PERFORM set_config('erp.new_invoice_rate_id', COALESCE(r.rate_id::TEXT, ''), true);
  new_id := public.erp_create_invoice_v3(workspace, p_customer_id, p_customer_name, p_invoice_date, p_due_date, p_subtotal, p_tax_rate);
  PERFORM set_config('erp.new_invoice_currency', '', true);
  PERFORM set_config('erp.new_invoice_rate', '', true);
  PERFORM set_config('erp.new_invoice_rate_source', '', true);
  PERFORM set_config('erp.new_invoice_rate_date', '', true);
  PERFORM set_config('erp.new_invoice_rate_id', '', true);
  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_create_invoice_v5(UUID, UUID, TEXT, DATE, DATE, NUMERIC, NUMERIC, TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_create_invoice_v5(UUID, UUID, TEXT, DATE, DATE, NUMERIC, NUMERIC, TEXT, NUMERIC) TO authenticated;

-- Orders: a known ISO code, NULL for the base currency.
CREATE OR REPLACE FUNCTION public.erp_normalize_order_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.currency IS NOT NULL THEN
    IF NEW.currency = public.erp_fx__base(NEW.user_id) THEN
      NEW.currency := NULL;
    ELSIF NOT EXISTS (SELECT 1 FROM public.erp_currencies WHERE code = NEW.currency) THEN
      RAISE EXCEPTION 'Unknown currency %', NEW.currency USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.currency IS NULL THEN
    NEW.fx_rate := 1; NEW.fx_rate_date := NULL; NEW.fx_rate_source := NULL; NEW.fx_rate_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_normalize_order_currency() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_erp_po_currency ON public.erp_purchase_orders;
CREATE TRIGGER trg_erp_po_currency BEFORE INSERT OR UPDATE OF currency, fx_rate ON public.erp_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.erp_normalize_order_currency();
DROP TRIGGER IF EXISTS trg_erp_so_currency ON public.erp_sales_orders;
CREATE TRIGGER trg_erp_so_currency BEFORE INSERT OR UPDATE OF currency, fx_rate ON public.erp_sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.erp_normalize_order_currency();

-- Purchase order in any currency. The order-date rate is recorded for
-- reference and the approval threshold (a base-currency amount); stock and
-- payables are valued at the receipt-date rate.
CREATE OR REPLACE FUNCTION public.erp_create_purchase_order_v3(
  p_workspace_id UUID, p_supplier_id UUID, p_supplier_name TEXT, p_order_date DATE, p_notes TEXT, p_items JSONB,
  p_currency TEXT, p_fx_rate NUMERIC
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  workspace UUID;
  owner UUID;
  new_order_id UUID;
  canonical_supplier_name TEXT;
  order_total NUMERIC(15,2);
  config public.erp_approval_settings%ROWTYPE;
  r RECORD;
  base_equivalent NUMERIC;
BEGIN
  workspace := public.erp__resolve_workspace(p_workspace_id, 'purchasing');
  SELECT owner_id INTO owner FROM public.erp_workspaces WHERE id = workspace;
  SELECT * INTO r FROM public.erp_fx__resolve(owner, upper(NULLIF(p_currency, '')), COALESCE(p_order_date, CURRENT_DATE), p_fx_rate);

  IF p_supplier_id IS NOT NULL THEN
    SELECT name INTO canonical_supplier_name FROM public.erp_suppliers
    WHERE id = p_supplier_id AND workspace_id = workspace;
    IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found for this account'; END IF;
  ELSE
    canonical_supplier_name := left(trim(COALESCE(p_supplier_name, '')), 200);
    IF canonical_supplier_name = '' THEN RAISE EXCEPTION 'Supplier name is required'; END IF;
  END IF;

  INSERT INTO public.erp_purchase_orders
    (user_id, workspace_id, created_by, supplier_id, supplier_name, order_date, status, total, notes,
     currency, fx_rate, fx_rate_date, fx_rate_source, fx_rate_id)
  VALUES
    (owner, workspace, auth.uid(), p_supplier_id, canonical_supplier_name,
     COALESCE(p_order_date, CURRENT_DATE), 'pending', 0, left(COALESCE(p_notes, ''), 2000),
     r.currency, r.rate, r.rate_date, r.source, r.rate_id)
  RETURNING id INTO new_order_id;

  order_total := public.erp__insert_order_items('purchase', new_order_id, workspace, p_items);
  UPDATE public.erp_purchase_orders SET total = order_total WHERE id = new_order_id;
  base_equivalent := round(order_total * r.rate, 2);

  SELECT * INTO config FROM public.erp_approval_settings WHERE owner_id = owner;
  IF FOUND AND config.po_approval_threshold > 0
     AND base_equivalent >= config.po_approval_threshold
     AND cardinality(config.approver_emails) > 0 THEN
    INSERT INTO public.erp_approval_requests
      (owner_id, requested_by, purchase_order_id, supplier_name, admin_email, amount, approver_emails)
    VALUES
      (owner, auth.uid(), new_order_id, canonical_supplier_name,
       config.admin_email, base_equivalent, config.approver_emails)
    ON CONFLICT (purchase_order_id) DO NOTHING;
  END IF;
  RETURN new_order_id;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_create_purchase_order_v3(UUID, UUID, TEXT, DATE, TEXT, JSONB, TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_create_purchase_order_v3(UUID, UUID, TEXT, DATE, TEXT, JSONB, TEXT, NUMERIC) TO authenticated;

-- Sales order in any currency (order-date rate recorded for reference;
-- revenue is recognised on the invoice at the invoice-date rate).
CREATE OR REPLACE FUNCTION public.erp_create_sales_order_v3(
  p_workspace_id UUID, p_customer_id UUID, p_customer_name TEXT, p_order_date DATE, p_notes TEXT, p_items JSONB,
  p_currency TEXT, p_fx_rate NUMERIC
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  workspace UUID;
  owner UUID;
  new_order_id UUID;
  canonical_customer_name TEXT;
  order_total NUMERIC(15,2);
  r RECORD;
BEGIN
  workspace := public.erp__resolve_workspace(p_workspace_id, 'sales');
  SELECT owner_id INTO owner FROM public.erp_workspaces WHERE id = workspace;
  SELECT * INTO r FROM public.erp_fx__resolve(owner, upper(NULLIF(p_currency, '')), COALESCE(p_order_date, CURRENT_DATE), p_fx_rate);

  IF p_customer_id IS NOT NULL THEN
    SELECT name INTO canonical_customer_name FROM public.erp_customers
    WHERE id = p_customer_id AND workspace_id = workspace;
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this account'; END IF;
  ELSE
    canonical_customer_name := left(trim(COALESCE(p_customer_name, '')), 200);
    IF canonical_customer_name = '' THEN RAISE EXCEPTION 'Customer name is required'; END IF;
  END IF;

  INSERT INTO public.erp_sales_orders
    (user_id, workspace_id, created_by, customer_id, customer_name, order_date, status, total, notes,
     currency, fx_rate, fx_rate_date, fx_rate_source, fx_rate_id)
  VALUES
    (owner, workspace, auth.uid(), p_customer_id, canonical_customer_name,
     COALESCE(p_order_date, CURRENT_DATE), 'draft', 0, left(COALESCE(p_notes, ''), 2000),
     r.currency, r.rate, r.rate_date, r.source, r.rate_id)
  RETURNING id INTO new_order_id;

  order_total := public.erp__insert_order_items('sales', new_order_id, workspace, p_items);
  UPDATE public.erp_sales_orders SET total = order_total WHERE id = new_order_id;
  PERFORM public.erp__reserve_sales_order(new_order_id);
  RETURN new_order_id;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_create_sales_order_v3(UUID, UUID, TEXT, DATE, TEXT, JSONB, TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_create_sales_order_v3(UUID, UUID, TEXT, DATE, TEXT, JSONB, TEXT, NUMERIC) TO authenticated;

-- The invoice for a sales order is in the order's currency, at the rate for
-- the invoice date (entered, or the stored rate).
CREATE OR REPLACE FUNCTION public.erp_issue_invoice_from_sales_order_v2(p_sales_order_id UUID, p_due_date DATE, p_fx_rate NUMERIC)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  order_row public.erp_sales_orders%ROWTYPE;
  invoice_id UUID;
  r RECORD;
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

  SELECT * INTO r FROM public.erp_fx__resolve(order_row.user_id, order_row.currency, CURRENT_DATE, p_fx_rate);

  INSERT INTO public.erp_invoices
    (user_id, workspace_id, created_by, customer_id, customer_name, invoice_date, due_date, status, total, sales_order_id,
     currency, fx_rate, fx_rate_date, fx_rate_source, fx_rate_id)
  VALUES
    (order_row.user_id, order_row.workspace_id, auth.uid(), order_row.customer_id, order_row.customer_name,
     CURRENT_DATE, GREATEST(COALESCE(p_due_date, CURRENT_DATE + 30), CURRENT_DATE), 'unpaid', order_row.total, order_row.id,
     r.currency, r.rate, r.rate_date, r.source, r.rate_id)
  RETURNING id INTO invoice_id;

  UPDATE public.erp_sales_orders SET status = 'invoiced', updated_at = NOW()
  WHERE id = order_row.id;
  RETURN invoice_id;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_issue_invoice_from_sales_order_v2(UUID, DATE, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_issue_invoice_from_sales_order_v2(UUID, DATE, NUMERIC) TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_issue_invoice_from_sales_order(p_sales_order_id UUID, p_due_date DATE DEFAULT (CURRENT_DATE + 30))
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.erp_issue_invoice_from_sales_order_v2(p_sales_order_id, p_due_date, NULL);
$$;

-- Payments are in their document's currency (invoice or purchase order).
-- Rate: 'rate_table' is always re-read from the table for the payment date
-- (never trusted from the client); 'manual' keeps the rate entered; older
-- clients that send no source get the table rate, else the document's rate.
CREATE OR REPLACE FUNCTION public.erp_normalize_payment_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  base TEXT := public.erp_fx__base(NEW.user_id);
  doc_currency TEXT;
  doc_rate NUMERIC;
  doc_rate_date DATE;
  has_document BOOLEAN := NEW.invoice_id IS NOT NULL OR NEW.purchase_order_id IS NOT NULL;
  r RECORD;
BEGIN
  IF NEW.currency = base THEN NEW.currency := NULL; END IF;
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT currency, fx_rate, COALESCE(fx_rate_date, invoice_date) INTO doc_currency, doc_rate, doc_rate_date
    FROM public.erp_invoices WHERE id = NEW.invoice_id;
  ELSIF NEW.purchase_order_id IS NOT NULL THEN
    SELECT currency, fx_rate, COALESCE(fx_rate_date, order_date) INTO doc_currency, doc_rate, doc_rate_date
    FROM public.erp_purchase_orders WHERE id = NEW.purchase_order_id;
  END IF;
  IF has_document THEN
    IF NEW.currency IS NOT NULL AND NEW.currency IS DISTINCT FROM doc_currency THEN
      RAISE EXCEPTION 'A payment must be in the % currency (%)',
        CASE WHEN NEW.invoice_id IS NOT NULL THEN 'invoice' ELSE 'purchase order' END, COALESCE(doc_currency, base);
    END IF;
    NEW.currency := doc_currency;
  END IF;

  IF NEW.currency IS NULL THEN
    NEW.fx_rate := 1; NEW.fx_rate_date := NULL; NEW.fx_rate_source := NULL; NEW.fx_rate_id := NULL;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.erp_currencies WHERE code = NEW.currency) THEN
    RAISE EXCEPTION 'Unknown currency %', NEW.currency USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;

  IF NEW.fx_rate_source = 'rate_table' THEN
    SELECT * INTO r FROM public.erp_fx__require_rate(NEW.user_id, NEW.currency, base, NEW.payment_date);
    NEW.fx_rate := r.rate; NEW.fx_rate_date := r.rate_date; NEW.fx_rate_id := r.rate_id;
  ELSIF NEW.fx_rate_source = 'manual' OR (NEW.fx_rate_source IS NULL AND NEW.fx_rate IS NOT NULL AND NEW.fx_rate <> 1) THEN
    IF NEW.fx_rate IS NULL OR NEW.fx_rate <= 0 THEN
      RAISE EXCEPTION 'The exchange rate must be greater than zero' USING ERRCODE = 'P0001';
    END IF;
    NEW.fx_rate_source := 'manual'; NEW.fx_rate_date := NEW.payment_date; NEW.fx_rate_id := NULL;
  ELSE
    SELECT f.rate, f.rate_date, f.rate_id INTO r
    FROM public.erp_fx__find_rate(NEW.user_id, NEW.currency, base, NEW.payment_date) f
    WHERE NEW.payment_date - f.rate_date <= public.erp_fx__max_age_days();
    IF r.rate IS NOT NULL THEN
      NEW.fx_rate := r.rate; NEW.fx_rate_date := r.rate_date; NEW.fx_rate_id := r.rate_id; NEW.fx_rate_source := 'rate_table';
    ELSIF has_document AND doc_rate IS NOT NULL THEN
      NEW.fx_rate := doc_rate; NEW.fx_rate_date := doc_rate_date; NEW.fx_rate_id := NULL; NEW.fx_rate_source := 'document';
    ELSE
      PERFORM public.erp_fx__require_rate(NEW.user_id, NEW.currency, base, NEW.payment_date);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_erp_payment_currency ON public.erp_payments;
CREATE TRIGGER trg_erp_payment_currency BEFORE INSERT OR UPDATE OF currency, fx_rate, invoice_id, purchase_order_id ON public.erp_payments
  FOR EACH ROW EXECUTE FUNCTION public.erp_normalize_payment_currency();

-- ─── 10. Receipts of foreign-currency purchase orders ────────────────────────
-- A receipt records the rate for its date (or the rate entered for it); a
-- reversal uses the rate of the receipt it reverses.
CREATE OR REPLACE FUNCTION public.erp_fx_receipt_rate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  order_currency TEXT;
  original public.erp_fulfillment_events;
  manual NUMERIC := NULLIF(current_setting('erp.receipt_fx_rate', true), '')::NUMERIC;
  r RECORD;
BEGIN
  IF NEW.kind <> 'purchase_receipt' THEN RETURN NEW; END IF;
  IF NEW.is_reversal AND NEW.reverses_event_id IS NOT NULL THEN
    SELECT * INTO original FROM public.erp_fulfillment_events WHERE id = NEW.reverses_event_id;
    NEW.currency := original.currency; NEW.fx_rate := original.fx_rate; NEW.fx_rate_date := original.fx_rate_date;
    NEW.fx_rate_source := original.fx_rate_source; NEW.fx_rate_id := original.fx_rate_id;
    RETURN NEW;
  END IF;
  SELECT currency INTO order_currency FROM public.erp_purchase_orders WHERE id = NEW.purchase_order_id;
  IF order_currency IS NULL THEN
    NEW.currency := NULL; NEW.fx_rate := 1;
    RETURN NEW;
  END IF;
  SELECT * INTO r FROM public.erp_fx__resolve(NEW.user_id, order_currency, COALESCE(NEW.created_at, now())::DATE, manual);
  NEW.currency := r.currency; NEW.fx_rate := r.rate; NEW.fx_rate_date := r.rate_date;
  NEW.fx_rate_source := r.source; NEW.fx_rate_id := r.rate_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_fx_receipt_rate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_erp_fx_receipt_rate ON public.erp_fulfillment_events;
CREATE TRIGGER trg_erp_fx_receipt_rate BEFORE INSERT ON public.erp_fulfillment_events
  FOR EACH ROW EXECUTE FUNCTION public.erp_fx_receipt_rate();

-- Receipt with an entered rate (otherwise identical to erp_record_purchase_receipt).
CREATE OR REPLACE FUNCTION public.erp_record_purchase_receipt_v2(
  p_purchase_order_id UUID, p_lines JSONB, p_request_id UUID, p_note TEXT, p_fx_rate NUMERIC
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE result UUID;
BEGIN
  IF p_fx_rate IS NOT NULL AND p_fx_rate <= 0 THEN
    RAISE EXCEPTION 'The exchange rate must be greater than zero' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('erp.receipt_fx_rate', COALESCE(p_fx_rate::TEXT, ''), true);
  result := public.erp_record_purchase_receipt(p_purchase_order_id, p_lines, p_request_id, COALESCE(p_note, ''));
  PERFORM set_config('erp.receipt_fx_rate', '', true);
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_record_purchase_receipt_v2(UUID, JSONB, UUID, TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_record_purchase_receipt_v2(UUID, JSONB, UUID, TEXT, NUMERIC) TO authenticated;

-- Received lines are costed in the base currency: order price × receipt rate
-- (a reversal line takes the cost of the line it reverses).
CREATE OR REPLACE FUNCTION public.erp_fulfillment_line_cost()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ev public.erp_fulfillment_events;
BEGIN
  IF NEW.unit_cost IS NULL THEN
    IF NEW.purchase_order_item_id IS NOT NULL THEN
      SELECT * INTO ev FROM public.erp_fulfillment_events WHERE id = NEW.event_id;
      IF ev.is_reversal AND ev.reverses_event_id IS NOT NULL THEN
        SELECT l.unit_cost INTO NEW.unit_cost FROM public.erp_fulfillment_event_lines l
        WHERE l.event_id = ev.reverses_event_id AND l.purchase_order_item_id = NEW.purchase_order_item_id
        ORDER BY l.id LIMIT 1;
      END IF;
      IF NEW.unit_cost IS NULL THEN
        SELECT round(price * COALESCE(ev.fx_rate, 1), 4) INTO NEW.unit_cost
        FROM public.erp_purchase_order_items WHERE id = NEW.purchase_order_item_id;
      END IF;
    ELSIF NEW.product_id IS NOT NULL THEN
      NEW.unit_cost := public.erp__unit_cost(NEW.product_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ─── 11. Ledger: settlement at the carrying rate ─────────────────────────────

-- Rates in ledger memos without trailing zeros (16250.000000000000 → 16250).
CREATE OR REPLACE FUNCTION public.erp_fx__num(p NUMERIC)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$ SELECT CASE WHEN p::TEXT LIKE '%.%' THEN rtrim(rtrim(p::TEXT, '0'), '.') ELSE p::TEXT END $$;

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
        'Invoice to ' || NEW.customer_name || CASE WHEN NEW.currency IS NOT NULL THEN ' (' || NEW.total || ' ' || NEW.currency || ' @ ' || public.erp_fx__num(NEW.fx_rate) || ')' ELSE '' END,
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


-- Rate at which a purchase order's payable was booked: receipts weighted by
-- their order value (net of reversals); before any receipt, the fallback.
CREATE OR REPLACE FUNCTION public.erp_fx__po_carrying_rate(p_purchase_order_id UUID, p_fallback NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN COALESCE(sum(v), 0) > 0 THEN round(sum(v * rate) / sum(v), 12) ELSE p_fallback END
  FROM (
    SELECT e.fx_rate AS rate,
           sum(l.quantity * i.price) * CASE WHEN e.is_reversal THEN -1 ELSE 1 END AS v
    FROM public.erp_fulfillment_events e
    JOIN public.erp_fulfillment_event_lines l ON l.event_id = e.id
    JOIN public.erp_purchase_order_items i ON i.id = l.purchase_order_item_id
    WHERE e.purchase_order_id = p_purchase_order_id AND e.kind = 'purchase_receipt'
    GROUP BY e.id, e.fx_rate, e.is_reversal
  ) x;
$$;
REVOKE ALL ON FUNCTION public.erp_fx__po_carrying_rate(UUID, NUMERIC) FROM PUBLIC, anon, authenticated;

-- Incoming invoice payments: cash at the payment rate, receivable released at
-- the invoice rate. Outgoing payments on a foreign-currency purchase order:
-- cash at the payment rate, payable released at its carrying rate. The
-- difference goes to Exchange differences (4200).
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
$$;

-- When a foreign-currency document is fully settled in its own currency, any
-- base-currency balance left on its receivable/payable (rate differences,
-- rounding) is cleared to Exchange differences. If it later becomes unsettled
-- again (a payment voided), the clearing is reversed.
CREATE OR REPLACE FUNCTION public.erp_fx__settle(p_kind TEXT, p_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner UUID;
  doc_currency TEXT;
  account UUID;
  balance NUMERIC;
  cleared NUMERIC;
  settled BOOLEAN;
  delta NUMERIC;
  n INTEGER;
  memo TEXT;
BEGIN
  IF p_kind = 'purchase_order' THEN
    SELECT o.user_id, o.currency,
           NOT EXISTS (SELECT 1 FROM public.erp_purchase_order_items i WHERE i.purchase_order_id = o.id AND i.qty_received < i.qty)
           AND abs(COALESCE((SELECT sum(amount) FROM public.erp_payments p WHERE p.purchase_order_id = o.id AND p.voided_at IS NULL), 0) - o.total) < 0.005,
           'Exchange difference on settlement of purchase order ' || upper(left(o.id::TEXT, 8))
    INTO owner, doc_currency, settled, memo
    FROM public.erp_purchase_orders o WHERE o.id = p_id;
    IF owner IS NULL OR doc_currency IS NULL THEN RETURN NULL; END IF;
    account := public.erp_gl__account(owner, 'ap');
    -- Payable: credit − debit.
    SELECT COALESCE(sum(l.credit - l.debit), 0),
           COALESCE(sum(l.credit - l.debit) FILTER (WHERE e.source_type = 'fx_settlement'), 0)
    INTO balance, cleared
    FROM public.erp_journal_lines l JOIN public.erp_journal_entries e ON e.id = l.entry_id
    WHERE e.user_id = owner AND l.account_id = account AND (
         (e.source_type = 'purchase_receipt' AND e.source_id IN (SELECT id FROM public.erp_fulfillment_events WHERE purchase_order_id = p_id))
      OR (e.source_type IN ('payment', 'payment_void', 'payment_adjust') AND e.source_id IN (SELECT id FROM public.erp_payments WHERE purchase_order_id = p_id))
      OR (e.source_type = 'fx_settlement' AND e.source_id = p_id));
  ELSIF p_kind = 'invoice' THEN
    SELECT i.user_id, i.currency,
           i.status::TEXT <> 'void'
           AND abs(COALESCE((SELECT sum(amount) FROM public.erp_payments p WHERE p.invoice_id = i.id AND p.voided_at IS NULL), 0) - i.total) < 0.005,
           'Exchange difference on settlement of invoice ' || upper(left(i.id::TEXT, 8))
    INTO owner, doc_currency, settled, memo
    FROM public.erp_invoices i WHERE i.id = p_id;
    IF owner IS NULL OR doc_currency IS NULL THEN RETURN NULL; END IF;
    account := public.erp_gl__account(owner, 'ar');
    -- Receivable: debit − credit, expressed as "credit − debit" negated below.
    SELECT COALESCE(sum(l.credit - l.debit), 0),
           COALESCE(sum(l.credit - l.debit) FILTER (WHERE e.source_type = 'fx_settlement'), 0)
    INTO balance, cleared
    FROM public.erp_journal_lines l JOIN public.erp_journal_entries e ON e.id = l.entry_id
    WHERE e.user_id = owner AND l.account_id = account AND (
         (e.source_type IN ('invoice', 'invoice_void', 'invoice_adjust') AND e.source_id = p_id)
      OR (e.source_type IN ('payment', 'payment_void', 'payment_adjust') AND e.source_id IN (SELECT id FROM public.erp_payments WHERE invoice_id = p_id))
      OR (e.source_type = 'fx_settlement' AND e.source_id = p_id));
  ELSE
    RETURN NULL;
  END IF;

  -- Change to the account's (credit − debit) that this entry makes.
  delta := CASE WHEN settled THEN -balance ELSE -cleared END;
  IF abs(delta) < 0.005 THEN RETURN NULL; END IF;
  SELECT count(*) + 1 INTO n FROM public.erp_journal_entries WHERE user_id = owner AND source_type = 'fx_settlement' AND source_id = p_id;
  RETURN public.erp_gl__post(owner, CURRENT_DATE, memo, 'fx_settlement', p_id, 'fx_settlement:' || p_id || ':' || n,
    jsonb_build_array(
      jsonb_build_object('account_id', account, 'credit', GREATEST(delta, 0), 'debit', GREATEST(-delta, 0)),
      jsonb_build_object('key', 'fx', 'debit', GREATEST(delta, 0), 'credit', GREATEST(-delta, 0))));
END;
$$;
REVOKE ALL ON FUNCTION public.erp_fx__settle(TEXT, UUID) FROM PUBLIC, anon, authenticated;

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
        CASE WHEN NEW.payment_type::TEXT = 'incoming' THEN 'Payment from ' ELSE 'Payment to ' END || NEW.party
          || CASE WHEN NEW.currency IS NOT NULL THEN ' (' || NEW.amount || ' ' || NEW.currency || ' @ ' || public.erp_fx__num(NEW.fx_rate) || ')' ELSE '' END,
        'payment', NEW.id, 'payment:' || NEW.id, public.erp_gl__payment_lines(NEW, NEW.amount));
    END IF;
  ELSIF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    PERFORM public.erp_gl__reverse(NEW.user_id, 'payment:' || NEW.id, NEW.voided_at::DATE,
      'Void of payment (' || NEW.party || ')', 'payment_void', NEW.id, 'payment_void:' || NEW.id);
  ELSIF NEW.voided_at IS NULL AND NEW.amount IS DISTINCT FROM OLD.amount THEN
    PERFORM public.erp_gl__post(NEW.user_id, CURRENT_DATE, 'Payment amount changed (' || NEW.party || ')',
      'payment_adjust', NEW.id, NULL, public.erp_gl__payment_lines(NEW, NEW.amount - OLD.amount));
  END IF;
  IF NEW.currency IS NOT NULL THEN
    IF NEW.invoice_id IS NOT NULL THEN PERFORM public.erp_fx__settle('invoice', NEW.invoice_id); END IF;
    IF NEW.purchase_order_id IS NOT NULL THEN PERFORM public.erp_fx__settle('purchase_order', NEW.purchase_order_id); END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_gl__on_fulfillment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.erp_gl__post_fulfillment(NEW.id);
  IF NEW.kind = 'purchase_receipt' AND NEW.currency IS NOT NULL THEN
    PERFORM public.erp_fx__settle('purchase_order', NEW.purchase_order_id);
  END IF;
  RETURN NULL;
END;
$$;

-- Receipt memo names the currency and rate.
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
    memo := 'Goods received' || CASE WHEN ev.currency IS NOT NULL THEN ' (' || ev.currency || ' @ ' || public.erp_fx__num(ev.fx_rate) || ')' ELSE '' END;
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

-- ─── 12. Grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.erp_fx__max_age_days() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_fx__num(NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_exchange_rate_lookup(UUID, TEXT, TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_add_exchange_rate(UUID, TEXT, TEXT, NUMERIC, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_import_exchange_rates(UUID, TEXT, TIMESTAMPTZ, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_currency_settings_get(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_currency_preview(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_confirm_base_currency(UUID, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_exchange_rate_lookup(UUID, TEXT, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_add_exchange_rate(UUID, TEXT, TEXT, NUMERIC, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_import_exchange_rates(UUID, TEXT, TIMESTAMPTZ, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_currency_settings_get(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_currency_preview(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_confirm_base_currency(UUID, TEXT, BIGINT) TO authenticated;
