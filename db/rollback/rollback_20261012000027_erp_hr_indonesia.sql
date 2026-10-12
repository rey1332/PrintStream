-- Rollback for 20261012000027_erp_hr_indonesia.sql.
-- Run only after redeploying an app version from before this change.
-- Payroll goes back to the rules of 20261012000009 (hourly only). Posted
-- runs, their journal entries and payslip lines stay; the new columns of
-- employees, lines and runs are removed.

BEGIN;
-- As in 20261012000009_erp_hr_leave_pay.sql.
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
                                  WHEN 'deductions_payable' THEN 2210 END;
  v_name TEXT := CASE p_key WHEN 'wages' THEN 'Salaries and wages' WHEN 'overtime' THEN 'Overtime pay'
                            WHEN 'allowances' THEN 'Allowances' WHEN 'employer_contributions' THEN 'Employer contributions (BPJS)'
                            WHEN 'wages_payable' THEN 'Wages payable'
                            WHEN 'deductions_payable' THEN 'Payroll deductions payable (BPJS, PPh 21)' END;
  v_type TEXT := CASE WHEN p_key IN ('wages_payable', 'deductions_payable') THEN 'liability' ELSE 'expense' END;
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

CREATE OR REPLACE FUNCTION public.erp_hr_payroll_preview(p_workspace_id UUID, p_from DATE, p_to DATE)
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
  lines := public.erp_hr__payroll_lines(ws, p_from, p_to);
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
      'negative', COALESCE(bool_or((l ->> 'net')::NUMERIC < 0), false),
      'lines', lines)
    FROM jsonb_array_elements(lines) l);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_payroll_run(
  p_workspace_id UUID, p_from DATE, p_to DATE, p_pay_date DATE, p_credit_to TEXT
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

  lines := public.erp_hr__payroll_lines(ws, p_from, p_to);
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
         COALESCE(bool_or((x ->> 'net')::NUMERIC < 0), false) AS negative
    INTO t
  FROM jsonb_array_elements(lines) x;
  IF t.gross <= 0 THEN
    RAISE EXCEPTION 'The attendance in this period has no pay (rates are 0)' USING ERRCODE = 'P0001', HINT = 'zero';
  END IF;
  IF t.negative THEN
    RAISE EXCEPTION 'Deductions are larger than the pay of an employee; check their deductions' USING ERRCODE = 'P0001', HINT = 'negative';
  END IF;

  INSERT INTO public.erp_payroll_runs (id, workspace_id, period_from, period_to, pay_date, credit_to, records,
                                      regular_total, overtime_total, total, leave_total, holiday_total,
                                      allowance_total, deduction_total, employer_total, net_total, created_by)
  VALUES (run_id, ws, p_from, p_to, p_pay_date, p_credit_to, t.records, t.regular, t.overtime, t.gross,
          t.leave, t.holiday, t.allowances, t.deductions, t.employer, t.net, auth.uid());

  entry := public.erp_gl__post(v_owner, p_pay_date,
    'Payroll ' || to_char(p_from, 'YYYY-MM-DD') || ' – ' || to_char(p_to, 'YYYY-MM-DD'),
    'payroll', run_id, 'payroll:' || run_id,
    jsonb_build_array(
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'wages'),
                         'debit', t.regular + t.leave + t.holiday, 'memo', 'Regular pay, paid leave and holidays'),
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'overtime'), 'debit', t.overtime, 'memo', 'Overtime pay'),
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'allowances'), 'debit', t.allowances, 'memo', 'Allowances'),
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'employer_contributions'), 'debit', t.employer,
                         'memo', 'Employer contributions'),
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'deductions_payable'),
                         'credit', t.deductions + t.employer, 'memo', 'Deductions and employer contributions'),
      jsonb_build_object('account_id', CASE WHEN p_credit_to = 'cash' THEN public.erp_gl__account(v_owner, 'cash')
                                            ELSE public.erp_hr__payroll_account(v_owner, 'wages_payable') END,
                         'credit', t.net, 'memo', 'Net pay')));

  UPDATE public.erp_payroll_runs SET journal_entry_id = entry WHERE id = run_id;
  UPDATE public.erp_attendance a SET payroll_run_id = run_id
  WHERE a.workspace_id = ws AND a.work_date BETWEEN p_from AND p_to
    AND a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL;
  UPDATE public.erp_leave_days d
  SET payroll_run_id = run_id, amount = round(e.normal_hours * e.hourly_rate, 2)
  FROM public.erp_leave_requests r, public.erp_employees e
  WHERE r.id = d.leave_id AND e.id = d.employee_id AND d.workspace_id = ws AND d.day BETWEEN p_from AND p_to
    AND d.paid AND d.payroll_run_id IS NULL AND r.status = 'approved';
  INSERT INTO public.erp_hr_holiday_pay (holiday_id, employee_id, payroll_run_id, amount)
  SELECT h.id, e.id, run_id, round(e.normal_hours * e.hourly_rate, 2)
  FROM public.erp_hr_holidays h
  JOIN public.erp_employees e ON e.workspace_id = h.workspace_id AND e.is_active AND e.created_at::DATE <= h.holiday_date
  WHERE h.workspace_id = ws AND h.paid AND h.holiday_date BETWEEN p_from AND p_to
  ON CONFLICT (holiday_id, employee_id) DO NOTHING;
  FOR l IN SELECT * FROM jsonb_array_elements(lines) LOOP
    INSERT INTO public.erp_payroll_lines (run_id, employee_id, records, worked_minutes, overtime_minutes, regular, overtime,
                                         leave_days, leave_pay, holiday_days, holiday_pay, allowances, deductions,
                                         employer, gross, net, items)
    VALUES (run_id, (l ->> 'employee_id')::UUID, (l ->> 'records')::INTEGER, (l ->> 'worked_minutes')::INTEGER,
            (l ->> 'overtime_minutes')::INTEGER, (l ->> 'regular')::NUMERIC, (l ->> 'overtime')::NUMERIC,
            (l ->> 'leave_days')::INTEGER, (l ->> 'leave_pay')::NUMERIC, (l ->> 'holiday_days')::INTEGER,
            (l ->> 'holiday_pay')::NUMERIC, (l ->> 'allowances')::NUMERIC, (l ->> 'deductions')::NUMERIC,
            (l ->> 'employer')::NUMERIC, (l ->> 'gross')::NUMERIC, (l ->> 'net')::NUMERIC, l -> 'items');
  END LOOP;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'hr.payroll_posted', jsonb_build_object(
    'run_id', run_id, 'from', p_from, 'to', p_to, 'records', t.records, 'total', t.gross, 'net', t.net));
  RETURN run_id;
END;
$$;

DROP FUNCTION IF EXISTS public.erp_hr_payroll_run_v2(UUID, DATE, DATE, DATE, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.erp_hr_payroll_preview_v2(UUID, DATE, DATE, BOOLEAN, DATE);
DROP FUNCTION IF EXISTS public.erp_hr__payroll_lines_v2(UUID, DATE, DATE, BOOLEAN, DATE);
DROP FUNCTION IF EXISTS public.erp_hr_employee_terms_save(UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_hr_employee_terms(UUID);
DROP FUNCTION IF EXISTS public.erp_hr_payroll_settings_set(UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_hr_payroll_settings_get(UUID);
DROP FUNCTION IF EXISTS public.erp_hr__pasal17(NUMERIC);
DROP FUNCTION IF EXISTS public.erp_hr__ptkp(TEXT);
DROP FUNCTION IF EXISTS public.erp_hr__ter_rate(TEXT, NUMERIC);
DROP FUNCTION IF EXISTS public.erp_hr__ter_category(TEXT);
DROP TABLE IF EXISTS public.erp_hr_ter_rates;
ALTER TABLE public.erp_payroll_runs DROP COLUMN IF EXISTS thr_total, DROP COLUMN IF EXISTS pph21_total,
  DROP COLUMN IF EXISTS bpjs_total;
ALTER TABLE public.erp_payroll_lines DROP COLUMN IF EXISTS pay_type, DROP COLUMN IF EXISTS salary_month,
  DROP COLUMN IF EXISTS thr, DROP COLUMN IF EXISTS tax_gross, DROP COLUMN IF EXISTS pph21, DROP COLUMN IF EXISTS ter_rate,
  DROP COLUMN IF EXISTS bpjs_employee, DROP COLUMN IF EXISTS bpjs_employer, DROP COLUMN IF EXISTS pension_employee;
ALTER TABLE public.erp_employees DROP COLUMN IF EXISTS pay_type, DROP COLUMN IF EXISTS monthly_salary,
  DROP COLUMN IF EXISTS fixed_allowance, DROP COLUMN IF EXISTS daily_rate, DROP COLUMN IF EXISTS join_date,
  DROP COLUMN IF EXISTS ptkp_status, DROP COLUMN IF EXISTS npwp, DROP COLUMN IF EXISTS bpjs_tk,
  DROP COLUMN IF EXISTS bpjs_jp, DROP COLUMN IF EXISTS bpjs_kes;
ALTER TABLE public.erp_hr_settings DROP COLUMN IF EXISTS payroll_rules, DROP COLUMN IF EXISTS id_jkk_rate,
  DROP COLUMN IF EXISTS id_jkm_rate, DROP COLUMN IF EXISTS id_jp_cap, DROP COLUMN IF EXISTS id_kes_cap,
  DROP COLUMN IF EXISTS id_kes_floor;
COMMIT;
