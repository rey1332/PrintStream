-- Payroll: monthly and daily wages everywhere; Indonesian rules per ERP.
--
-- Pay type per employee (every ERP):
--   hourly   as before: attendance at the hourly and overtime rates
--   daily    days attended on working days × daily rate (paid leave and
--            paid holidays at the daily rate)
--   monthly  the monthly salary (gaji pokok) plus the fixed allowance
--            (tunjangan tetap) once per calendar month: the month of the
--            run's last day, prorated by working days in the month the
--            employee joined, less unpaid leave days; leave and holidays are
--            included in the salary
--
-- Payroll rules per ERP (HR settings): 'basic' (as before: allowances,
-- deductions and employer contributions only from the employee's pay
-- items) or 'id' (Indonesia), which adds per employee:
--   * overtime for daily and monthly employees by law (PP 35/2021): hourly
--     wage = monthly wage / 173; on working days 1.5× the first hour, 2×
--     after; on rest days and holidays 2× the first 7 hours (6-day week) or
--     8 hours (5-day week), 3× the next hour, 4× after;
--   * BPJS Ketenagakerjaan on the wage (salary + fixed allowance, or base
--     pay for daily/hourly): JHT 3.7% company + 2% employee; JP 2% + 1% up
--     to the JP wage cap; JKK (rate by risk group, set per ERP; a quarry is
--     usually 1.74%) and JKM 0.30%, company only;
--   * BPJS Kesehatan 4% company + 1% employee, on the wage between the
--     floor (UMK, optional) and the cap;
--   * PPh 21 (PP 58/2023, PMK 168/2023): monthly employees at the TER rate
--     of their category (A/B/C from the PTKP status) on the gross that
--     includes the company's JKK, JKM and BPJS Kesehatan; in December the
--     year is recalculated with Article 17 rates (gross − 5% job expenses
--     up to 6 million − employee JHT/JP − PTKP) less what was withheld, so
--     December can be a refund. Daily and hourly employees (pegawai tidak
--     tetap) at the daily rate: 0% up to Rp 450,000 a day, 0.5% up to
--     Rp 2,500,000 a day (above that the monthly TER is used);
--   * THR when the run asks for it: once a calendar year, the monthly wage
--     × months of service / 12 (at least one month, at most 12).
-- The JP and BPJS Kesehatan caps change by regulation (JP every March);
-- they are settings, defaulting to the 2026 values (JP Rp 11,086,300 from
-- March 2026; Kesehatan Rp 12,000,000). An employee without NPWP/NIK is
-- not charged the 20% surcharge: record their NIK.
--
-- Statutory amounts go to their own liability accounts: PPh 21 payable
-- (2310) and BPJS payable (2320); other deductions stay in 2210.
-- erp_hr_payroll_run / _preview keep working (basic rules give the same
-- result as before); erp_hr_payroll_run_v2 / _preview_v2 add THR.
--
-- Rollback: db/rollback/rollback_20261012000027_erp_hr_indonesia.sql

-- ─── 1. Settings and employee pay terms ──────────────────────────────────────
ALTER TABLE public.erp_hr_settings
  ADD COLUMN IF NOT EXISTS payroll_rules TEXT NOT NULL DEFAULT 'basic' CHECK (payroll_rules IN ('basic', 'id')),
  ADD COLUMN IF NOT EXISTS id_jkk_rate NUMERIC(5, 2) NOT NULL DEFAULT 0.24 CHECK (id_jkk_rate BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS id_jkm_rate NUMERIC(5, 2) NOT NULL DEFAULT 0.30 CHECK (id_jkm_rate BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS id_jp_cap NUMERIC(18, 2) NOT NULL DEFAULT 11086300 CHECK (id_jp_cap > 0),
  ADD COLUMN IF NOT EXISTS id_kes_cap NUMERIC(18, 2) NOT NULL DEFAULT 12000000 CHECK (id_kes_cap > 0),
  ADD COLUMN IF NOT EXISTS id_kes_floor NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (id_kes_floor >= 0);

ALTER TABLE public.erp_employees
  ADD COLUMN IF NOT EXISTS pay_type TEXT NOT NULL DEFAULT 'hourly' CHECK (pay_type IN ('hourly', 'daily', 'monthly')),
  ADD COLUMN IF NOT EXISTS monthly_salary NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (monthly_salary >= 0),
  ADD COLUMN IF NOT EXISTS fixed_allowance NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (fixed_allowance >= 0),
  ADD COLUMN IF NOT EXISTS daily_rate NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (daily_rate >= 0),
  ADD COLUMN IF NOT EXISTS join_date DATE,
  ADD COLUMN IF NOT EXISTS ptkp_status TEXT NOT NULL DEFAULT 'TK/0'
    CHECK (ptkp_status IN ('TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3')),
  ADD COLUMN IF NOT EXISTS npwp TEXT NOT NULL DEFAULT '' CHECK (char_length(npwp) <= 30),
  ADD COLUMN IF NOT EXISTS bpjs_tk BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS bpjs_jp BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS bpjs_kes BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.erp_payroll_lines
  ADD COLUMN IF NOT EXISTS pay_type TEXT NOT NULL DEFAULT 'hourly',
  ADD COLUMN IF NOT EXISTS salary_month DATE,
  ADD COLUMN IF NOT EXISTS thr NUMERIC(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_gross NUMERIC(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pph21 NUMERIC(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ter_rate NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS bpjs_employee NUMERIC(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bpjs_employer NUMERIC(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pension_employee NUMERIC(18, 2) NOT NULL DEFAULT 0;
ALTER TABLE public.erp_payroll_runs
  ADD COLUMN IF NOT EXISTS thr_total NUMERIC(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pph21_total NUMERIC(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bpjs_total NUMERIC(18, 2) NOT NULL DEFAULT 0;

-- ─── 2. Tax tables ───────────────────────────────────────────────────────────
-- Monthly TER (PP 58/2023 Lampiran): income up to and including `upper`
-- (NULL = above the last bound) is taxed at `rate` percent.
CREATE TABLE IF NOT EXISTS public.erp_hr_ter_rates (
  category CHAR(1) NOT NULL CHECK (category IN ('A', 'B', 'C')),
  upper NUMERIC(18, 2),
  rate NUMERIC(5, 2) NOT NULL,
  UNIQUE (category, upper)
);
ALTER TABLE public.erp_hr_ter_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_hr_ter_rates FROM PUBLIC, anon, authenticated;
DELETE FROM public.erp_hr_ter_rates;
INSERT INTO public.erp_hr_ter_rates (category, upper, rate)
SELECT 'A', NULLIF(u, 0), r FROM unnest(
  ARRAY[5400000, 5650000, 5950000, 6300000, 6750000, 7500000, 8550000, 9650000, 10050000, 10350000, 10700000,
        11050000, 11600000, 12500000, 13750000, 15100000, 16950000, 19750000, 24150000, 26450000, 28000000,
        30050000, 32400000, 35400000, 39100000, 43850000, 47800000, 51400000, 56300000, 62200000, 68600000,
        77500000, 89000000, 103000000, 125000000, 157000000, 206000000, 337000000, 454000000, 550000000,
        695000000, 910000000, 1400000000, 0]::NUMERIC[],
  ARRAY[0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
        17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34]::NUMERIC[]) AS x(u, r);
INSERT INTO public.erp_hr_ter_rates (category, upper, rate)
SELECT 'B', NULLIF(u, 0), r FROM unnest(
  ARRAY[6200000, 6500000, 6850000, 7300000, 9200000, 10750000, 11250000, 11600000, 12600000, 13600000, 14950000,
        16400000, 18450000, 21850000, 26000000, 27700000, 29350000, 31450000, 33950000, 37100000, 41100000,
        45800000, 49500000, 53800000, 58500000, 64000000, 71000000, 80000000, 93000000, 109000000, 129000000,
        163000000, 211000000, 374000000, 459000000, 555000000, 704000000, 957000000, 1405000000, 0]::NUMERIC[],
  ARRAY[0, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
        22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34]::NUMERIC[]) AS x(u, r);
INSERT INTO public.erp_hr_ter_rates (category, upper, rate)
SELECT 'C', NULLIF(u, 0), r FROM unnest(
  ARRAY[6600000, 6950000, 7350000, 7800000, 8850000, 9800000, 10950000, 11200000, 12050000, 12950000, 14150000,
        15550000, 17050000, 19500000, 22700000, 26600000, 28100000, 30100000, 32600000, 35400000, 38900000,
        43000000, 47400000, 51200000, 55800000, 60400000, 66700000, 74500000, 83200000, 95600000, 110000000,
        134000000, 169000000, 221000000, 390000000, 463000000, 561000000, 709000000, 965000000, 1419000000, 0]::NUMERIC[],
  ARRAY[0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
        21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34]::NUMERIC[]) AS x(u, r);

CREATE OR REPLACE FUNCTION public.erp_hr__ter_category(p_status TEXT)
RETURNS CHAR(1) LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_status IN ('TK/0', 'TK/1', 'K/0') THEN 'A'
              WHEN p_status IN ('TK/2', 'TK/3', 'K/1', 'K/2') THEN 'B' ELSE 'C' END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr__ter_rate(p_status TEXT, p_gross NUMERIC)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.rate FROM public.erp_hr_ter_rates t
   WHERE t.category = public.erp_hr__ter_category(p_status) AND (t.upper IS NULL OR p_gross <= t.upper)
   ORDER BY t.upper NULLS LAST LIMIT 1;
$$;

-- PTKP a year: Rp 54,000,000, plus 4,500,000 when married and per dependant (max 3).
CREATE OR REPLACE FUNCTION public.erp_hr__ptkp(p_status TEXT)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT 54000000 + CASE WHEN p_status LIKE 'K/%' THEN 4500000 ELSE 0 END
       + 4500000 * split_part(p_status, '/', 2)::INTEGER;
$$;

-- Article 17 (UU HPP) on a year's taxable income.
CREATE OR REPLACE FUNCTION public.erp_hr__pasal17(p_pkp NUMERIC)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT floor(
      0.05 * least(greatest(p_pkp, 0), 60000000)
    + 0.15 * least(greatest(p_pkp - 60000000, 0), 190000000)
    + 0.25 * least(greatest(p_pkp - 250000000, 0), 250000000)
    + 0.30 * least(greatest(p_pkp - 500000000, 0), 4500000000)
    + 0.35 * greatest(p_pkp - 5000000000, 0));
$$;

-- ─── 3. Accounts: PPh 21 payable and BPJS payable ───────────────────────────
-- As in 20261012000009_erp_hr_leave_pay.sql, plus two liability accounts.
CREATE OR REPLACE FUNCTION public.erp_hr__payroll_account(p_owner UUID, p_key TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  account UUID;
  base_code INTEGER := CASE p_key WHEN 'wages' THEN 6200 WHEN 'overtime' THEN 6210 WHEN 'allowances' THEN 6220
                                  WHEN 'employer_contributions' THEN 6230 WHEN 'wages_payable' THEN 2200
                                  WHEN 'deductions_payable' THEN 2210 WHEN 'pph21_payable' THEN 2310
                                  WHEN 'bpjs_payable' THEN 2320 END;
  v_name TEXT := CASE p_key WHEN 'wages' THEN 'Salaries and wages' WHEN 'overtime' THEN 'Overtime pay'
                            WHEN 'allowances' THEN 'Allowances' WHEN 'employer_contributions' THEN 'Employer contributions (BPJS)'
                            WHEN 'wages_payable' THEN 'Wages payable'
                            WHEN 'deductions_payable' THEN 'Payroll deductions payable (BPJS, PPh 21)'
                            WHEN 'pph21_payable' THEN 'PPh 21 payable' WHEN 'bpjs_payable' THEN 'BPJS payable' END;
  v_type TEXT := CASE WHEN p_key IN ('wages_payable', 'deductions_payable', 'pph21_payable', 'bpjs_payable')
                      THEN 'liability' ELSE 'expense' END;
  candidate INTEGER;
BEGIN
  IF base_code IS NULL THEN RAISE EXCEPTION 'Unknown payroll account %', p_key; END IF;
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

-- ─── 4. Settings and pay terms functions ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.erp_hr_payroll_settings_get(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  s public.erp_hr_settings%ROWTYPE;
BEGIN
  PERFORM public.erp_hr__require(ws, 'manage');
  SELECT * INTO s FROM public.erp_hr_settings x WHERE x.workspace_id = ws;
  RETURN jsonb_build_object(
    'payroll_rules', COALESCE(s.payroll_rules, 'basic'), 'jkk_rate', COALESCE(s.id_jkk_rate, 0.24),
    'jkm_rate', COALESCE(s.id_jkm_rate, 0.30), 'jp_cap', COALESCE(s.id_jp_cap, 11086300),
    'kes_cap', COALESCE(s.id_kes_cap, 12000000), 'kes_floor', COALESCE(s.id_kes_floor, 0));
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_payroll_settings_set(p_workspace_id UUID, p_settings JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  v_rules TEXT := COALESCE(p_settings ->> 'payroll_rules', 'basic');
  v_jkk NUMERIC; v_jkm NUMERIC; v_jp NUMERIC; v_kes NUMERIC; v_floor NUMERIC;
BEGIN
  PERFORM public.erp_hr__require(ws, 'manage');
  BEGIN
    v_jkk := COALESCE((p_settings ->> 'jkk_rate')::NUMERIC, 0.24);
    v_jkm := COALESCE((p_settings ->> 'jkm_rate')::NUMERIC, 0.30);
    v_jp := COALESCE((p_settings ->> 'jp_cap')::NUMERIC, 11086300);
    v_kes := COALESCE((p_settings ->> 'kes_cap')::NUMERIC, 12000000);
    v_floor := COALESCE((p_settings ->> 'kes_floor')::NUMERIC, 0);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid payroll settings' USING ERRCODE = '22023';
  END;
  IF v_rules NOT IN ('basic', 'id') OR v_jkk NOT BETWEEN 0 AND 10 OR v_jkm NOT BETWEEN 0 AND 10
     OR v_jp <= 0 OR v_kes <= 0 OR v_floor < 0 THEN
    RAISE EXCEPTION 'Invalid payroll settings' USING ERRCODE = '22023', HINT = 'settings';
  END IF;
  INSERT INTO public.erp_hr_settings (workspace_id, payroll_rules, id_jkk_rate, id_jkm_rate, id_jp_cap, id_kes_cap,
                                      id_kes_floor, updated_by, updated_at)
  VALUES (ws, v_rules, v_jkk, v_jkm, v_jp, v_kes, v_floor, auth.uid(), now())
  ON CONFLICT (workspace_id) DO UPDATE
    SET payroll_rules = EXCLUDED.payroll_rules, id_jkk_rate = EXCLUDED.id_jkk_rate, id_jkm_rate = EXCLUDED.id_jkm_rate,
        id_jp_cap = EXCLUDED.id_jp_cap, id_kes_cap = EXCLUDED.id_kes_cap, id_kes_floor = EXCLUDED.id_kes_floor,
        updated_by = auth.uid(), updated_at = now();
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'hr.payroll_settings_changed', jsonb_build_object(
    'payroll_rules', v_rules, 'jkk_rate', v_jkk, 'jkm_rate', v_jkm, 'jp_cap', v_jp, 'kes_cap', v_kes, 'kes_floor', v_floor));
END;
$$;

-- Pay terms of the ERP's employees (rates stay in erp_hr_employees).
CREATE OR REPLACE FUNCTION public.erp_hr_employee_terms(p_workspace_id UUID)
RETURNS TABLE (employee_id UUID, pay_type TEXT, monthly_salary NUMERIC, fixed_allowance NUMERIC, daily_rate NUMERIC,
               join_date DATE, ptkp_status TEXT, npwp TEXT, bpjs_tk BOOLEAN, bpjs_jp BOOLEAN, bpjs_kes BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ws UUID := public.erp_hr__workspace(p_workspace_id);
BEGIN
  PERFORM public.erp_hr__require(ws, 'manage');
  RETURN QUERY
  SELECT e.id, e.pay_type, e.monthly_salary, e.fixed_allowance, e.daily_rate, COALESCE(e.join_date, e.created_at::DATE),
         e.ptkp_status, e.npwp, e.bpjs_tk, e.bpjs_jp, e.bpjs_kes
    FROM public.erp_employees e WHERE e.workspace_id = ws;
END;
$$;

-- p_terms: {pay_type, monthly_salary, fixed_allowance, daily_rate, join_date,
--   ptkp_status, npwp, bpjs_tk, bpjs_jp, bpjs_kes} (missing keys unchanged).
CREATE OR REPLACE FUNCTION public.erp_hr_employee_terms_save(p_employee_id UUID, p_terms JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.erp_employees%ROWTYPE;
  n public.erp_employees%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.erp_employees x WHERE x.id = p_employee_id FOR UPDATE;
  IF NOT FOUND OR public.erp_workspace_role(e.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.erp_hr__require(e.workspace_id, 'manage');
  n := e;
  BEGIN
    n.pay_type := COALESCE(p_terms ->> 'pay_type', e.pay_type);
    n.monthly_salary := round(COALESCE((p_terms ->> 'monthly_salary')::NUMERIC, e.monthly_salary), 2);
    n.fixed_allowance := round(COALESCE((p_terms ->> 'fixed_allowance')::NUMERIC, e.fixed_allowance), 2);
    n.daily_rate := round(COALESCE((p_terms ->> 'daily_rate')::NUMERIC, e.daily_rate), 2);
    n.join_date := CASE WHEN p_terms ? 'join_date' THEN NULLIF(p_terms ->> 'join_date', '')::DATE ELSE e.join_date END;
    n.ptkp_status := COALESCE(p_terms ->> 'ptkp_status', e.ptkp_status);
    n.npwp := btrim(COALESCE(p_terms ->> 'npwp', e.npwp));
    n.bpjs_tk := COALESCE((p_terms ->> 'bpjs_tk')::BOOLEAN, e.bpjs_tk);
    n.bpjs_jp := COALESCE((p_terms ->> 'bpjs_jp')::BOOLEAN, e.bpjs_jp);
    n.bpjs_kes := COALESCE((p_terms ->> 'bpjs_kes')::BOOLEAN, e.bpjs_kes);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid pay terms' USING ERRCODE = '22023', HINT = 'terms';
  END;
  IF n.pay_type NOT IN ('hourly', 'daily', 'monthly')
     OR n.ptkp_status NOT IN ('TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3')
     OR n.monthly_salary < 0 OR n.fixed_allowance < 0 OR n.daily_rate < 0 OR char_length(n.npwp) > 30 THEN
    RAISE EXCEPTION 'Invalid pay terms' USING ERRCODE = '22023', HINT = 'terms';
  END IF;
  UPDATE public.erp_employees x
     SET pay_type = n.pay_type, monthly_salary = n.monthly_salary, fixed_allowance = n.fixed_allowance,
         daily_rate = n.daily_rate, join_date = n.join_date, ptkp_status = n.ptkp_status, npwp = n.npwp,
         bpjs_tk = n.bpjs_tk, bpjs_jp = n.bpjs_jp, bpjs_kes = n.bpjs_kes, updated_at = now()
   WHERE x.id = e.id;
  IF (n.pay_type, n.monthly_salary, n.fixed_allowance, n.daily_rate)
     IS DISTINCT FROM (e.pay_type, e.monthly_salary, e.fixed_allowance, e.daily_rate) THEN
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    VALUES (e.workspace_id, auth.uid(), 'hr.employee_rates_changed', jsonb_build_object(
      'employee_id', e.id, 'name', e.name,
      'pay_type', jsonb_build_array(e.pay_type, n.pay_type),
      'monthly_salary', jsonb_build_array(e.monthly_salary, n.monthly_salary),
      'fixed_allowance', jsonb_build_array(e.fixed_allowance, n.fixed_allowance),
      'daily_rate', jsonb_build_array(e.daily_rate, n.daily_rate)));
  END IF;
END;
$$;

-- ─── 5. Payroll lines ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.erp_hr__payroll_lines_v2(p_workspace_id UUID, p_from DATE, p_to DATE, p_thr BOOLEAN,
                                                          p_pay_date DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.erp_hr_settings%ROWTYPE;
  rules TEXT;
  work_days INTEGER[] := public.erp_hr__work_days(p_workspace_id);
  six_day BOOLEAN;
  days_factor NUMERIC;
  sal_month DATE := date_trunc('month', p_to)::DATE;
  month_end DATE := (date_trunc('month', p_to) + interval '1 month - 1 day')::DATE;
  wd_month INTEGER;
  december BOOLEAN := extract(month FROM p_to) = 12;
  emp RECORD;
  item RECORD;
  att RECORD;
  lines JSONB := '[]'::jsonb;
  items JSONB;
  regular NUMERIC; overtime NUMERIC; leave_pay NUMERIC; holiday_pay NUMERIC;
  salary_paid BOOLEAN; salary NUMERIC; fixed NUMERIC; factor NUMERIC; unpaid_days INTEGER; unpaid NUMERIC;
  monthly_wage NUMERIC; thr NUMERIC; months INTEGER; joined DATE;
  base NUMERIC; allowances NUMERIC; gross NUMERIC; deductions NUMERIC; employer NUMERIC; amount NUMERIC;
  w NUMERIC; jht_ee NUMERIC; jht_er NUMERIC; jp_ee NUMERIC; jp_er NUMERIC; jkk NUMERIC; jkm NUMERIC;
  kes_ee NUMERIC; kes_er NUMERIC; kes_base NUMERIC;
  tax_gross NUMERIC; pph NUMERIC; ter NUMERIC; per_day NUMERIC; days INTEGER;
  prior RECORD; annual_gross NUMERIC; net_income NUMERIC; pkp NUMERIC;
BEGIN
  SELECT * INTO s FROM public.erp_hr_settings x WHERE x.workspace_id = p_workspace_id;
  rules := COALESCE(s.payroll_rules, 'basic');
  six_day := cardinality(work_days) >= 6;
  days_factor := CASE WHEN six_day THEN 25 ELSE 21 END;
  SELECT count(*) INTO wd_month FROM public.erp_hr__working_days(p_workspace_id, sal_month, month_end);

  FOR emp IN
    SELECT e.* FROM public.erp_employees e
     WHERE e.workspace_id = p_workspace_id
       AND (e.is_active
            OR EXISTS (SELECT 1 FROM public.erp_attendance a WHERE a.employee_id = e.id AND a.work_date BETWEEN p_from AND p_to
                         AND a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL)
            OR EXISTS (SELECT 1 FROM public.erp_leave_days d WHERE d.employee_id = e.id AND d.day BETWEEN p_from AND p_to
                         AND d.paid AND d.payroll_run_id IS NULL))
     ORDER BY lower(e.name)
  LOOP
    joined := COALESCE(emp.join_date, emp.created_at::DATE);
    -- Attendance: totals, and statutory overtime units per record (rest days and holidays count whole).
    SELECT count(*)::INTEGER AS records, COALESCE(sum(a.worked_minutes), 0)::INTEGER AS worked,
           COALESCE(sum(a.overtime_minutes), 0)::INTEGER AS overtime_min,
           COALESCE(sum(a.regular_pay), 0) AS regular, COALESCE(sum(a.overtime_pay), 0) AS overtime,
           count(*) FILTER (WHERE NOT x.rest)::INTEGER AS workday_records,
           COALESCE(sum(CASE WHEN x.rest THEN
               CASE WHEN six_day THEN 2 * least(x.w, 7) + 3 * least(greatest(x.w - 7, 0), 1) + 4 * greatest(x.w - 8, 0)
                    ELSE 2 * least(x.w, 8) + 3 * least(greatest(x.w - 8, 0), 1) + 4 * greatest(x.w - 9, 0) END
             ELSE 1.5 * least(x.h, 1) + 2 * greatest(x.h - 1, 0) END), 0) AS units
      INTO att
      FROM public.erp_attendance a
      CROSS JOIN LATERAL (SELECT
          NOT (extract(isodow FROM a.work_date)::INTEGER = ANY (work_days))
            OR EXISTS (SELECT 1 FROM public.erp_hr_holidays h WHERE h.workspace_id = p_workspace_id AND h.holiday_date = a.work_date) AS rest,
          COALESCE(a.worked_minutes, 0) / 60.0 AS w,
          COALESCE(a.overtime_minutes, 0) / 60.0 AS h) x
     WHERE a.employee_id = emp.id AND a.work_date BETWEEN p_from AND p_to
       AND a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL;

    regular := 0; overtime := round(att.overtime, 2); leave_pay := 0; holiday_pay := 0;
    salary := 0; fixed := 0; unpaid := 0; unpaid_days := 0; salary_paid := false; items := '[]'::jsonb;
    monthly_wage := CASE emp.pay_type WHEN 'monthly' THEN emp.monthly_salary + emp.fixed_allowance
                                      WHEN 'daily' THEN emp.daily_rate * days_factor
                                      ELSE emp.hourly_rate * emp.normal_hours * days_factor END;

    IF emp.pay_type = 'hourly' THEN
      regular := round(att.regular, 2);
      SELECT round(count(*) * emp.normal_hours * emp.hourly_rate, 2) INTO leave_pay
        FROM public.erp_leave_days d JOIN public.erp_leave_requests r ON r.id = d.leave_id
       WHERE d.employee_id = emp.id AND d.day BETWEEN p_from AND p_to AND d.paid AND d.payroll_run_id IS NULL AND r.status = 'approved';
      SELECT round(count(*) * emp.normal_hours * emp.hourly_rate, 2) INTO holiday_pay
        FROM public.erp_hr_holidays h
       WHERE h.workspace_id = p_workspace_id AND h.paid AND h.holiday_date BETWEEN p_from AND p_to
         AND emp.is_active AND joined <= h.holiday_date
         AND NOT EXISTS (SELECT 1 FROM public.erp_hr_holiday_pay p WHERE p.holiday_id = h.id AND p.employee_id = emp.id);
    ELSIF emp.pay_type = 'daily' THEN
      regular := round(att.workday_records * emp.daily_rate, 2);
      SELECT round(count(*) * emp.daily_rate, 2) INTO leave_pay
        FROM public.erp_leave_days d JOIN public.erp_leave_requests r ON r.id = d.leave_id
       WHERE d.employee_id = emp.id AND d.day BETWEEN p_from AND p_to AND d.paid AND d.payroll_run_id IS NULL AND r.status = 'approved';
      SELECT round(count(*) * emp.daily_rate, 2) INTO holiday_pay
        FROM public.erp_hr_holidays h
       WHERE h.workspace_id = p_workspace_id AND h.paid AND h.holiday_date BETWEEN p_from AND p_to
         AND emp.is_active AND joined <= h.holiday_date
         AND NOT EXISTS (SELECT 1 FROM public.erp_hr_holiday_pay p WHERE p.holiday_id = h.id AND p.employee_id = emp.id);
    ELSE
      -- Monthly: once per calendar month, the month of the run's last day.
      salary_paid := emp.is_active AND joined <= month_end AND NOT EXISTS (
        SELECT 1 FROM public.erp_payroll_lines l JOIN public.erp_payroll_runs r ON r.id = l.run_id
         WHERE l.employee_id = emp.id AND l.salary_month = sal_month AND r.status = 'posted');
      IF salary_paid THEN
        factor := 1;
        IF joined > sal_month AND wd_month > 0 THEN
          SELECT count(*)::NUMERIC / wd_month INTO factor FROM public.erp_hr__working_days(p_workspace_id, joined, month_end);
        END IF;
        salary := round(emp.monthly_salary * factor, 2);
        fixed := round(emp.fixed_allowance * factor, 2);
        SELECT count(*)::INTEGER INTO unpaid_days
          FROM public.erp_leave_days d JOIN public.erp_leave_requests r ON r.id = d.leave_id
         WHERE d.employee_id = emp.id AND d.day BETWEEN sal_month AND month_end AND NOT d.paid AND r.status = 'approved';
        IF unpaid_days > 0 AND wd_month > 0 THEN
          unpaid := least(salary, round(emp.monthly_salary * unpaid_days / wd_month, 2));
          items := items || jsonb_build_array(jsonb_build_object('kind', 'info', 'name', 'Unpaid leave', 'days', unpaid_days,
                                                                 'amount', -unpaid));
        END IF;
        regular := salary - unpaid;
      END IF;
    END IF;

    -- Statutory overtime for daily and monthly employees (Indonesia).
    IF rules = 'id' AND emp.pay_type IN ('daily', 'monthly') THEN
      overtime := round(monthly_wage / 173 * att.units, 2);
    END IF;

    -- THR: once a calendar year, at least one month of service.
    thr := 0;
    IF rules = 'id' AND p_thr AND emp.is_active AND NOT EXISTS (
         SELECT 1 FROM public.erp_payroll_lines l JOIN public.erp_payroll_runs r ON r.id = l.run_id
          WHERE l.employee_id = emp.id AND l.thr > 0 AND r.status = 'posted'
            AND extract(year FROM r.pay_date) = extract(year FROM p_pay_date)) THEN
      months := (extract(year FROM age(p_pay_date, joined)) * 12 + extract(month FROM age(p_pay_date, joined)))::INTEGER;
      IF months >= 1 THEN
        thr := round(monthly_wage * least(months, 12) / 12, 0);
      END IF;
    END IF;

    IF att.records = 0 AND leave_pay = 0 AND holiday_pay = 0 AND NOT salary_paid AND thr = 0 THEN
      CONTINUE;
    END IF;

    base := regular + overtime + leave_pay + holiday_pay;
    allowances := 0; deductions := 0; employer := 0;
    IF fixed > 0 THEN
      allowances := allowances + fixed;
      items := items || jsonb_build_array(jsonb_build_object('kind', 'allowance', 'name', 'Fixed allowance', 'method', 'fixed',
                                                             'rate', emp.fixed_allowance, 'amount', fixed));
    END IF;
    IF thr > 0 THEN
      allowances := allowances + thr;
      items := items || jsonb_build_array(jsonb_build_object('kind', 'allowance', 'name', 'THR', 'method', 'fixed',
                                                             'rate', thr, 'amount', thr, 'statutory', 'thr'));
    END IF;
    FOR item IN SELECT * FROM public.erp_employee_pay_items i WHERE i.employee_id = emp.id AND i.kind = 'allowance' ORDER BY i.created_at LOOP
      amount := round(CASE WHEN item.method = 'fixed' THEN item.amount ELSE base * item.amount / 100 END, 2);
      allowances := allowances + amount;
      items := items || jsonb_build_array(jsonb_build_object('kind', 'allowance', 'name', item.name, 'method', item.method, 'rate', item.amount, 'amount', amount));
    END LOOP;
    gross := base + allowances;
    FOR item IN SELECT * FROM public.erp_employee_pay_items i WHERE i.employee_id = emp.id AND i.kind IN ('deduction', 'employer')
                ORDER BY array_position(ARRAY['deduction', 'employer'], i.kind), i.created_at LOOP
      amount := round(CASE WHEN item.method = 'fixed' THEN item.amount ELSE gross * item.amount / 100 END, 2);
      IF item.kind = 'deduction' THEN deductions := deductions + amount; ELSE employer := employer + amount; END IF;
      items := items || jsonb_build_array(jsonb_build_object('kind', item.kind, 'name', item.name, 'method', item.method, 'rate', item.amount, 'amount', amount));
    END LOOP;

    jht_ee := 0; jht_er := 0; jp_ee := 0; jp_er := 0; jkk := 0; jkm := 0; kes_ee := 0; kes_er := 0;
    tax_gross := gross; pph := 0; ter := NULL;
    IF rules = 'id' THEN
      -- The BPJS wage: salary and fixed allowance, or the base pay of daily and hourly employees.
      w := CASE WHEN emp.pay_type = 'monthly' THEN salary + fixed ELSE regular + leave_pay + holiday_pay END;
      IF w > 0 AND emp.bpjs_tk THEN
        jht_ee := round(w * 0.02, 0); jht_er := round(w * 0.037, 0);
        jkk := round(w * COALESCE(s.id_jkk_rate, 0.24) / 100, 0); jkm := round(w * COALESCE(s.id_jkm_rate, 0.30) / 100, 0);
        IF emp.bpjs_jp THEN
          jp_ee := round(least(w, COALESCE(s.id_jp_cap, 11086300)) * 0.01, 0);
          jp_er := round(least(w, COALESCE(s.id_jp_cap, 11086300)) * 0.02, 0);
        END IF;
      END IF;
      IF w > 0 AND emp.bpjs_kes THEN
        kes_base := least(greatest(w, COALESCE(s.id_kes_floor, 0)), COALESCE(s.id_kes_cap, 12000000));
        kes_ee := round(kes_base * 0.01, 0); kes_er := round(kes_base * 0.04, 0);
      END IF;
      items := items || (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', k, 'name', n, 'method', 'percent', 'rate', r, 'amount', a,
                                                     'statutory', 'bpjs') ORDER BY o), '[]'::jsonb)
          FROM (VALUES (1, 'deduction', 'BPJS JHT (2%)', 2.0, jht_ee), (2, 'deduction', 'BPJS JP (1%)', 1.0, jp_ee),
                       (3, 'deduction', 'BPJS Kesehatan (1%)', 1.0, kes_ee),
                       (4, 'employer', 'BPJS JHT (3.7%)', 3.7, jht_er), (5, 'employer', 'BPJS JP (2%)', 2.0, jp_er),
                       (6, 'employer', 'BPJS JKK', COALESCE(s.id_jkk_rate, 0.24), jkk),
                       (7, 'employer', 'BPJS JKM', COALESCE(s.id_jkm_rate, 0.30), jkm),
                       (8, 'employer', 'BPJS Kesehatan (4%)', 4.0, kes_er)) v(o, k, n, r, a)
         WHERE a > 0);
      deductions := deductions + jht_ee + jp_ee + kes_ee;
      employer := employer + jht_er + jp_er + jkk + jkm + kes_er;

      -- PPh 21: the company's JKK, JKM and BPJS Kesehatan are taxable income.
      tax_gross := gross + jkk + jkm + kes_er;
      IF emp.pay_type = 'monthly' THEN
        IF december THEN
          SELECT COALESCE(sum(l.tax_gross), 0) AS tax_gross, COALESCE(sum(l.pph21), 0) AS pph21,
                 COALESCE(sum(l.pension_employee), 0) AS pension
            INTO prior
            FROM public.erp_payroll_lines l JOIN public.erp_payroll_runs r ON r.id = l.run_id
           WHERE l.employee_id = emp.id AND r.status = 'posted' AND extract(year FROM r.period_to) = extract(year FROM p_to);
          annual_gross := prior.tax_gross + tax_gross;
          net_income := annual_gross - least(round(annual_gross * 0.05, 2), 6000000) - prior.pension - jht_ee - jp_ee;
          pkp := floor(greatest(net_income - public.erp_hr__ptkp(emp.ptkp_status), 0) / 1000) * 1000;
          pph := public.erp_hr__pasal17(pkp) - prior.pph21;
        ELSE
          ter := public.erp_hr__ter_rate(emp.ptkp_status, tax_gross);
          pph := floor(tax_gross * ter / 100);
        END IF;
      ELSE
        -- Pegawai tidak tetap: per day worked.
        days := greatest(att.records, 1);
        per_day := tax_gross / days;
        IF per_day <= 450000 THEN
          pph := 0; ter := 0;
        ELSIF per_day <= 2500000 THEN
          ter := 0.5; pph := floor(tax_gross * 0.005);
        ELSE
          ter := public.erp_hr__ter_rate(emp.ptkp_status, tax_gross);
          pph := floor(tax_gross * ter / 100);
        END IF;
      END IF;
      IF pph <> 0 THEN
        items := items || jsonb_build_array(jsonb_build_object(
          'kind', 'deduction', 'name', CASE WHEN pph < 0 THEN 'PPh 21 (refund)' ELSE 'PPh 21' END,
          'method', CASE WHEN ter IS NULL THEN 'fixed' ELSE 'percent' END, 'rate', COALESCE(ter, pph), 'amount', pph,
          'statutory', 'pph21'));
        deductions := deductions + pph;
      END IF;
    END IF;

    lines := lines || jsonb_build_array(jsonb_build_object(
      'employee_id', emp.id, 'name', emp.name, 'pay_type', emp.pay_type, 'records', att.records,
      'worked_minutes', att.worked, 'overtime_minutes', att.overtime_min, 'regular', regular, 'overtime', overtime,
      'leave_days', (SELECT count(*) FROM public.erp_leave_days d JOIN public.erp_leave_requests r ON r.id = d.leave_id
                      WHERE d.employee_id = emp.id AND d.day BETWEEN p_from AND p_to AND d.paid AND d.payroll_run_id IS NULL
                        AND r.status = 'approved'),
      'leave_pay', leave_pay,
      'holiday_days', (SELECT count(*) FROM public.erp_hr_holidays h
                        WHERE h.workspace_id = p_workspace_id AND h.paid AND h.holiday_date BETWEEN p_from AND p_to
                          AND emp.is_active AND joined <= h.holiday_date
                          AND NOT EXISTS (SELECT 1 FROM public.erp_hr_holiday_pay p WHERE p.holiday_id = h.id AND p.employee_id = emp.id)),
      'holiday_pay', holiday_pay, 'allowances', allowances, 'deductions', deductions, 'employer', employer,
      'gross', gross, 'net', gross - deductions, 'items', items,
      'salary_month', CASE WHEN salary_paid THEN sal_month END, 'thr', thr, 'tax_gross', tax_gross, 'pph21', pph,
      'ter_rate', ter, 'bpjs_employee', jht_ee + jp_ee + kes_ee, 'bpjs_employer', jht_er + jp_er + jkk + jkm + kes_er,
      'pension_employee', jht_ee + jp_ee));
  END LOOP;
  RETURN lines;
END;
$$;

-- ─── 6. Preview and run ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.erp_hr_payroll_preview_v2(p_workspace_id UUID, p_from DATE, p_to DATE, p_thr BOOLEAN,
                                                           p_pay_date DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  lines JSONB;
  att JSONB;
BEGIN
  PERFORM public.erp_hr__require(ws, 'manage');
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'Choose a period of at most one year' USING ERRCODE = 'P0001', HINT = 'period';
  END IF;
  lines := public.erp_hr__payroll_lines_v2(ws, p_from, p_to, COALESCE(p_thr, false), COALESCE(p_pay_date, p_to));
  SELECT jsonb_build_object(
      'records', count(*) FILTER (WHERE a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL),
      'still_in', count(*) FILTER (WHERE a.clock_out IS NULL),
      'already_paid', count(*) FILTER (WHERE a.payroll_run_id IS NOT NULL))
    INTO att
  FROM public.erp_attendance a
  WHERE a.workspace_id = ws AND a.work_date BETWEEN p_from AND p_to;
  RETURN att || (
    SELECT jsonb_build_object(
      'employees', count(*),
      'regular', COALESCE(sum((l ->> 'regular')::NUMERIC), 0),
      'overtime', COALESCE(sum((l ->> 'overtime')::NUMERIC), 0),
      'leave', COALESCE(sum((l ->> 'leave_pay')::NUMERIC), 0),
      'holiday', COALESCE(sum((l ->> 'holiday_pay')::NUMERIC), 0),
      'allowances', COALESCE(sum((l ->> 'allowances')::NUMERIC), 0),
      'deductions', COALESCE(sum((l ->> 'deductions')::NUMERIC), 0),
      'employer', COALESCE(sum((l ->> 'employer')::NUMERIC), 0),
      'gross', COALESCE(sum((l ->> 'gross')::NUMERIC), 0),
      'net', COALESCE(sum((l ->> 'net')::NUMERIC), 0),
      'thr', COALESCE(sum((l ->> 'thr')::NUMERIC), 0),
      'pph21', COALESCE(sum((l ->> 'pph21')::NUMERIC), 0),
      'bpjs', COALESCE(sum((l ->> 'bpjs_employee')::NUMERIC + (l ->> 'bpjs_employer')::NUMERIC), 0),
      'negative', COALESCE(bool_or((l ->> 'net')::NUMERIC < 0), false),
      'lines', lines)
    FROM jsonb_array_elements(lines) l);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_payroll_run_v2(
  p_workspace_id UUID, p_from DATE, p_to DATE, p_pay_date DATE, p_credit_to TEXT, p_thr BOOLEAN
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  v_owner UUID;
  run_id UUID := gen_random_uuid();
  lines JSONB;
  l JSONB;
  t RECORD;
  entry UUID;
  other_liab NUMERIC;
BEGIN
  PERFORM public.erp_hr__require(ws, 'manage');
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'Choose a period of at most one year' USING ERRCODE = 'P0001', HINT = 'period';
  END IF;
  IF p_pay_date IS NULL THEN RAISE EXCEPTION 'Choose a pay date' USING ERRCODE = 'P0001', HINT = 'pay_date'; END IF;
  IF p_credit_to IS NULL OR p_credit_to NOT IN ('cash', 'payable') THEN
    RAISE EXCEPTION 'Choose how the wages are paid' USING ERRCODE = '22023';
  END IF;
  SELECT w.owner_id INTO v_owner FROM public.erp_workspaces w WHERE w.id = ws;

  -- One run at a time per ERP; what it pays is locked while it is paid.
  PERFORM pg_advisory_xact_lock(hashtext('erp_payroll'), hashtext(ws::TEXT));
  PERFORM 1 FROM public.erp_attendance a
  WHERE a.workspace_id = ws AND a.work_date BETWEEN p_from AND p_to
    AND a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL
  FOR UPDATE;
  PERFORM 1 FROM public.erp_leave_days d
  WHERE d.workspace_id = ws AND d.day BETWEEN p_from AND p_to AND d.payroll_run_id IS NULL
  FOR UPDATE;

  lines := public.erp_hr__payroll_lines_v2(ws, p_from, p_to, COALESCE(p_thr, false), p_pay_date);
  IF jsonb_array_length(lines) = 0 THEN
    RAISE EXCEPTION 'There is no unpaid, finished attendance in this period' USING ERRCODE = 'P0001', HINT = 'nothing';
  END IF;
  SELECT COALESCE(sum((x ->> 'records')::INTEGER), 0) AS records,
         COALESCE(sum((x ->> 'regular')::NUMERIC), 0) AS regular,
         COALESCE(sum((x ->> 'overtime')::NUMERIC), 0) AS overtime,
         COALESCE(sum((x ->> 'leave_pay')::NUMERIC), 0) AS leave,
         COALESCE(sum((x ->> 'holiday_pay')::NUMERIC), 0) AS holiday,
         COALESCE(sum((x ->> 'allowances')::NUMERIC), 0) AS allowances,
         COALESCE(sum((x ->> 'deductions')::NUMERIC), 0) AS deductions,
         COALESCE(sum((x ->> 'employer')::NUMERIC), 0) AS employer,
         COALESCE(sum((x ->> 'gross')::NUMERIC), 0) AS gross,
         COALESCE(sum((x ->> 'net')::NUMERIC), 0) AS net,
         COALESCE(sum((x ->> 'thr')::NUMERIC), 0) AS thr,
         COALESCE(sum((x ->> 'pph21')::NUMERIC), 0) AS pph21,
         COALESCE(sum((x ->> 'bpjs_employee')::NUMERIC), 0) AS bpjs_ee,
         COALESCE(sum((x ->> 'bpjs_employer')::NUMERIC), 0) AS bpjs_er,
         COALESCE(bool_or((x ->> 'net')::NUMERIC < 0), false) AS negative
    INTO t
  FROM jsonb_array_elements(lines) x;
  IF t.gross <= 0 THEN
    RAISE EXCEPTION 'The attendance in this period has no pay (rates are 0)' USING ERRCODE = 'P0001', HINT = 'zero';
  END IF;
  IF t.negative THEN
    RAISE EXCEPTION 'Deductions are larger than the pay of an employee; check their deductions' USING ERRCODE = 'P0001', HINT = 'negative';
  END IF;
  other_liab := t.deductions - t.pph21 - t.bpjs_ee + t.employer - t.bpjs_er;

  INSERT INTO public.erp_payroll_runs (id, workspace_id, period_from, period_to, pay_date, credit_to, records,
                                      regular_total, overtime_total, total, leave_total, holiday_total,
                                      allowance_total, deduction_total, employer_total, net_total,
                                      thr_total, pph21_total, bpjs_total, created_by)
  VALUES (run_id, ws, p_from, p_to, p_pay_date, p_credit_to, t.records, t.regular, t.overtime, t.gross,
          t.leave, t.holiday, t.allowances, t.deductions, t.employer, t.net, t.thr, t.pph21, t.bpjs_ee + t.bpjs_er,
          auth.uid());

  -- Liabilities are credits; a negative amount (a PPh 21 refund in December) is a debit.
  entry := public.erp_gl__post(v_owner, p_pay_date,
    'Payroll ' || to_char(p_from, 'YYYY-MM-DD') || ' – ' || to_char(p_to, 'YYYY-MM-DD'),
    'payroll', run_id, 'payroll:' || run_id,
    jsonb_build_array(
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'wages'),
                         'debit', t.regular + t.leave + t.holiday, 'memo', 'Salaries, wages, paid leave and holidays'),
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'overtime'), 'debit', t.overtime, 'memo', 'Overtime pay'),
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'allowances'), 'debit', t.allowances,
                         'memo', 'Allowances and THR'),
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'employer_contributions'), 'debit', t.employer,
                         'memo', 'Employer contributions'),
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'pph21_payable'),
                         'credit', greatest(t.pph21, 0), 'debit', greatest(-t.pph21, 0), 'memo', 'PPh 21'),
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'bpjs_payable'),
                         'credit', t.bpjs_ee + t.bpjs_er, 'memo', 'BPJS'),
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'deductions_payable'),
                         'credit', greatest(other_liab, 0), 'debit', greatest(-other_liab, 0),
                         'memo', 'Other deductions and employer contributions'),
      jsonb_build_object('account_id', CASE WHEN p_credit_to = 'cash' THEN public.erp_gl__account(v_owner, 'cash')
                                            ELSE public.erp_hr__payroll_account(v_owner, 'wages_payable') END,
                         'credit', t.net, 'memo', 'Net pay')));

  UPDATE public.erp_payroll_runs SET journal_entry_id = entry WHERE id = run_id;
  UPDATE public.erp_attendance a SET payroll_run_id = run_id
  WHERE a.workspace_id = ws AND a.work_date BETWEEN p_from AND p_to
    AND a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL;
  UPDATE public.erp_leave_days d
  SET payroll_run_id = run_id,
      amount = CASE e.pay_type WHEN 'monthly' THEN 0 WHEN 'daily' THEN e.daily_rate
                               ELSE round(e.normal_hours * e.hourly_rate, 2) END
  FROM public.erp_leave_requests r, public.erp_employees e
  WHERE r.id = d.leave_id AND e.id = d.employee_id AND d.workspace_id = ws AND d.day BETWEEN p_from AND p_to
    AND d.paid AND d.payroll_run_id IS NULL AND r.status = 'approved';
  INSERT INTO public.erp_hr_holiday_pay (holiday_id, employee_id, payroll_run_id, amount)
  SELECT h.id, e.id, run_id, CASE e.pay_type WHEN 'monthly' THEN 0 WHEN 'daily' THEN e.daily_rate
                                             ELSE round(e.normal_hours * e.hourly_rate, 2) END
  FROM public.erp_hr_holidays h
  JOIN public.erp_employees e ON e.workspace_id = h.workspace_id AND e.is_active
   AND COALESCE(e.join_date, e.created_at::DATE) <= h.holiday_date
  WHERE h.workspace_id = ws AND h.paid AND h.holiday_date BETWEEN p_from AND p_to
  ON CONFLICT (holiday_id, employee_id) DO NOTHING;
  FOR l IN SELECT * FROM jsonb_array_elements(lines) LOOP
    INSERT INTO public.erp_payroll_lines (run_id, employee_id, records, worked_minutes, overtime_minutes, regular, overtime,
                                         leave_days, leave_pay, holiday_days, holiday_pay, allowances, deductions,
                                         employer, gross, net, items, pay_type, salary_month, thr, tax_gross, pph21,
                                         ter_rate, bpjs_employee, bpjs_employer, pension_employee)
    VALUES (run_id, (l ->> 'employee_id')::UUID, (l ->> 'records')::INTEGER, (l ->> 'worked_minutes')::INTEGER,
            (l ->> 'overtime_minutes')::INTEGER, (l ->> 'regular')::NUMERIC, (l ->> 'overtime')::NUMERIC,
            (l ->> 'leave_days')::INTEGER, (l ->> 'leave_pay')::NUMERIC, (l ->> 'holiday_days')::INTEGER,
            (l ->> 'holiday_pay')::NUMERIC, (l ->> 'allowances')::NUMERIC, (l ->> 'deductions')::NUMERIC,
            (l ->> 'employer')::NUMERIC, (l ->> 'gross')::NUMERIC, (l ->> 'net')::NUMERIC, l -> 'items',
            l ->> 'pay_type', (l ->> 'salary_month')::DATE, (l ->> 'thr')::NUMERIC, (l ->> 'tax_gross')::NUMERIC,
            (l ->> 'pph21')::NUMERIC, (l ->> 'ter_rate')::NUMERIC, (l ->> 'bpjs_employee')::NUMERIC,
            (l ->> 'bpjs_employer')::NUMERIC, (l ->> 'pension_employee')::NUMERIC);
  END LOOP;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'hr.payroll_posted', jsonb_build_object(
    'run_id', run_id, 'from', p_from, 'to', p_to, 'records', t.records, 'total', t.gross, 'net', t.net,
    'thr', t.thr, 'pph21', t.pph21));
  RETURN run_id;
END;
$$;

-- The earlier entry points: same as v2 without THR.
CREATE OR REPLACE FUNCTION public.erp_hr_payroll_preview(p_workspace_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.erp_hr_payroll_preview_v2(p_workspace_id, p_from, p_to, false, p_to);
$$;
CREATE OR REPLACE FUNCTION public.erp_hr_payroll_run(
  p_workspace_id UUID, p_from DATE, p_to DATE, p_pay_date DATE, p_credit_to TEXT
)
RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.erp_hr_payroll_run_v2(p_workspace_id, p_from, p_to, p_pay_date, p_credit_to, false);
$$;

-- ─── 7. Privileges ───────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.erp_hr__ter_category(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr__ter_rate(TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr__ptkp(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr__pasal17(NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr__payroll_lines_v2(UUID, DATE, DATE, BOOLEAN, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr_payroll_settings_get(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_payroll_settings_set(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_employee_terms(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_employee_terms_save(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_payroll_preview_v2(UUID, DATE, DATE, BOOLEAN, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_payroll_run_v2(UUID, DATE, DATE, DATE, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_hr_payroll_settings_get(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_payroll_settings_set(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_employee_terms(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_employee_terms_save(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_payroll_preview_v2(UUID, DATE, DATE, BOOLEAN, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_payroll_run_v2(UUID, DATE, DATE, DATE, TEXT, BOOLEAN) TO authenticated;
