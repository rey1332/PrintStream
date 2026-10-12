-- Rollback for 20261012000009_erp_hr_leave_pay.sql.
-- Run only after redeploying an app version from before leave and payslips.
--
-- Refused while payroll runs paid leave, holidays, allowances or deductions:
-- reverse those runs first (their entries would no longer match the runs).
-- Removes leave, holidays, allowances and deductions and payslip lines; the
-- payroll functions are restored as in 20261012000002_erp_hr_payroll.sql.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.erp_payroll_runs WHERE status = 'posted'
             AND (leave_total <> 0 OR holiday_total <> 0 OR allowance_total <> 0 OR deduction_total <> 0 OR employer_total <> 0)) THEN
    RAISE EXCEPTION 'Posted payroll runs include leave, holidays, allowances or deductions; reverse them first. Nothing was changed.';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.erp_hr_payslips(UUID);
DROP FUNCTION IF EXISTS public.erp_hr_payroll_runs_v2(UUID);
DROP FUNCTION IF EXISTS public.erp_hr_pay_item_delete(UUID);
DROP FUNCTION IF EXISTS public.erp_hr_pay_item_save(UUID, UUID, UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_hr_pay_items(UUID, UUID);
DROP FUNCTION IF EXISTS public.erp_hr_set_leave_quota(UUID, INTEGER);
DROP FUNCTION IF EXISTS public.erp_hr_leave_balances(UUID, INTEGER);
DROP FUNCTION IF EXISTS public.erp_hr_leaves(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS public.erp_hr_leave_cancel(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_hr_leave_decide(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.erp_hr__annual_used(UUID, INTEGER);
DROP FUNCTION IF EXISTS public.erp_hr_leave_request(UUID, UUID, TEXT, DATE, DATE, TEXT);
DROP FUNCTION IF EXISTS public.erp_hr_holiday_delete(UUID);
DROP FUNCTION IF EXISTS public.erp_hr_holiday_save(UUID, DATE, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.erp_hr_holidays(UUID, INTEGER);
DROP FUNCTION IF EXISTS public.erp_hr_set_work_days(UUID, INTEGER[]);
DROP FUNCTION IF EXISTS public.erp_hr_work_days_get(UUID);
DROP FUNCTION IF EXISTS public.erp_hr__payroll_lines(UUID, DATE, DATE);

-- Reversing and deleting as before.
DO $$
BEGIN
  EXECUTE replace(pg_get_functiondef('public.erp_hr_payroll_reverse(uuid,text)'::regprocedure),
    E'
  UPDATE public.erp_leave_days SET payroll_run_id = NULL, amount = NULL WHERE payroll_run_id = run.id;
  DELETE FROM public.erp_hr_holiday_pay WHERE payroll_run_id = run.id;', '');
  EXECUTE replace(pg_get_functiondef('public.erp_hr_employee_delete(uuid)'::regprocedure),
    E'
     OR EXISTS (SELECT 1 FROM public.erp_leave_requests l WHERE l.employee_id = emp.id)
     OR EXISTS (SELECT 1 FROM public.erp_payroll_lines p WHERE p.employee_id = emp.id)', '');
END;
$$;

DROP FUNCTION IF EXISTS public.erp_hr__working_days(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS public.erp_hr__work_days(UUID);

DROP TABLE IF EXISTS public.erp_hr_holiday_pay;
DROP TABLE IF EXISTS public.erp_leave_days;
DROP TABLE IF EXISTS public.erp_payroll_lines;
DROP TABLE IF EXISTS public.erp_leave_requests;
DROP TABLE IF EXISTS public.erp_hr_holidays;
DROP TABLE IF EXISTS public.erp_employee_pay_items;

ALTER TABLE public.erp_payroll_runs
  DROP COLUMN IF EXISTS leave_total, DROP COLUMN IF EXISTS holiday_total, DROP COLUMN IF EXISTS allowance_total,
  DROP COLUMN IF EXISTS deduction_total, DROP COLUMN IF EXISTS employer_total, DROP COLUMN IF EXISTS net_total;
DELETE FROM public.erp_payroll_runs WHERE records = 0 AND status = 'reversed';
ALTER TABLE public.erp_payroll_runs DROP CONSTRAINT IF EXISTS erp_payroll_runs_records_check;
ALTER TABLE public.erp_payroll_runs ADD CONSTRAINT erp_payroll_runs_records_check CHECK (records > 0) NOT VALID;
ALTER TABLE public.erp_employees DROP COLUMN IF EXISTS annual_leave_days;
ALTER TABLE public.erp_hr_settings DROP COLUMN IF EXISTS work_days;

-- The payroll functions as in 20261012000002_erp_hr_payroll.sql.
CREATE OR REPLACE FUNCTION public.erp_hr__payroll_account(p_owner UUID, p_key TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  account UUID;
  base_code INTEGER := CASE p_key WHEN 'wages' THEN 6200 WHEN 'overtime' THEN 6210 WHEN 'wages_payable' THEN 2200 END;
  v_name TEXT := CASE p_key WHEN 'wages' THEN 'Salaries and wages' WHEN 'overtime' THEN 'Overtime pay' WHEN 'wages_payable' THEN 'Wages payable' END;
  v_type TEXT := CASE p_key WHEN 'wages_payable' THEN 'liability' ELSE 'expense' END;
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
DECLARE ws UUID := public.erp_hr__workspace(p_workspace_id);
BEGIN
  PERFORM public.erp_hr__require(ws, 'manage');
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'Choose a period of at most one year' USING ERRCODE = 'P0001', HINT = 'period';
  END IF;
  RETURN (
    SELECT jsonb_build_object(
      'records', count(*) FILTER (WHERE a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL),
      'still_in', count(*) FILTER (WHERE a.clock_out IS NULL),
      'already_paid', count(*) FILTER (WHERE a.payroll_run_id IS NOT NULL),
      'regular', COALESCE(sum(a.regular_pay) FILTER (WHERE a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL), 0),
      'overtime', COALESCE(sum(a.overtime_pay) FILTER (WHERE a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL), 0),
      'employees', count(DISTINCT a.employee_id) FILTER (WHERE a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL))
    FROM public.erp_attendance a
    WHERE a.workspace_id = ws AND a.work_date BETWEEN p_from AND p_to
  );
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
  v_records INTEGER;
  v_regular NUMERIC;
  v_overtime NUMERIC;
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

  -- One run at a time per ERP; the records are locked while they are paid.
  PERFORM pg_advisory_xact_lock(hashtext('erp_payroll'), hashtext(ws::TEXT));
  PERFORM 1 FROM public.erp_attendance a
  WHERE a.workspace_id = ws AND a.work_date BETWEEN p_from AND p_to
    AND a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL
  FOR UPDATE;
  SELECT count(*), COALESCE(sum(a.regular_pay), 0), COALESCE(sum(a.overtime_pay), 0)
  INTO v_records, v_regular, v_overtime
  FROM public.erp_attendance a
  WHERE a.workspace_id = ws AND a.work_date BETWEEN p_from AND p_to
    AND a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL;
  IF v_records = 0 THEN
    RAISE EXCEPTION 'There is no unpaid, finished attendance in this period' USING ERRCODE = 'P0001', HINT = 'nothing';
  END IF;
  IF v_regular + v_overtime <= 0 THEN
    RAISE EXCEPTION 'The attendance in this period has no pay (rates are 0)' USING ERRCODE = 'P0001', HINT = 'zero';
  END IF;

  INSERT INTO public.erp_payroll_runs (id, workspace_id, period_from, period_to, pay_date, credit_to, records,
                                      regular_total, overtime_total, total, created_by)
  VALUES (run_id, ws, p_from, p_to, p_pay_date, p_credit_to, v_records, v_regular, v_overtime,
          v_regular + v_overtime, auth.uid());

  entry := public.erp_gl__post(v_owner, p_pay_date,
    'Payroll ' || to_char(p_from, 'YYYY-MM-DD') || ' – ' || to_char(p_to, 'YYYY-MM-DD'),
    'payroll', run_id, 'payroll:' || run_id,
    jsonb_build_array(
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'wages'), 'debit', v_regular, 'memo', 'Regular pay'),
      jsonb_build_object('account_id', public.erp_hr__payroll_account(v_owner, 'overtime'), 'debit', v_overtime, 'memo', 'Overtime pay'),
      jsonb_build_object('account_id', CASE WHEN p_credit_to = 'cash' THEN public.erp_gl__account(v_owner, 'cash')
                                            ELSE public.erp_hr__payroll_account(v_owner, 'wages_payable') END,
                         'credit', v_regular + v_overtime, 'memo', 'Wages')));

  UPDATE public.erp_payroll_runs SET journal_entry_id = entry WHERE id = run_id;
  UPDATE public.erp_attendance a SET payroll_run_id = run_id
  WHERE a.workspace_id = ws AND a.work_date BETWEEN p_from AND p_to
    AND a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'hr.payroll_posted', jsonb_build_object(
    'run_id', run_id, 'from', p_from, 'to', p_to, 'records', v_records, 'total', v_regular + v_overtime));
  RETURN run_id;
END;
$$;


REVOKE ALL ON FUNCTION public.erp_hr__payroll_account(UUID, TEXT) FROM PUBLIC, anon, authenticated;

COMMIT;
