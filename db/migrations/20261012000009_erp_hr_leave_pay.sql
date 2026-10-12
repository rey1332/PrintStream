-- HR: leave, holidays, allowances and deductions, payslips.
--
-- Leave: a request (annual, sick or unpaid) for an employee, recorded by
-- anyone who records attendance and approved by the Owner or an Admin. On
-- approval it becomes one row per working day (the ERP's working weekdays,
-- holidays excluded), so leave across two pay periods is paid day by day and
-- never twice (one leave day per employee and date). Annual leave counts
-- against the employee's yearly quota (default 12 days).
--
-- Holidays: a calendar per ERP; each holiday is paid or not. A paid holiday
-- pays every active employee their normal hours that day, once.
--
-- Pay: approved annual and sick leave and paid holidays are paid at normal
-- hours × hourly rate. Per employee, allowances (added to pay), deductions
-- (withheld from pay: the employee's BPJS share, PPh 21) and employer
-- contributions (the company's BPJS share, a company cost) are a fixed amount
-- or a percentage: allowances of the base pay (attendance, leave, holidays),
-- deductions and employer contributions of the gross pay (base + allowances).
-- A payroll run now keeps one line per employee (the payslip) and posts
--   Dr Salaries and wages (regular, leave, holidays)   Dr Overtime pay
--   Dr Allowances   Dr Employer contributions
--   Cr Payroll deductions payable (deductions + employer contributions)
--   Cr Cash and bank / Wages payable (net pay)
-- Every amount is rounded before it is added, so the entry always balances.
-- Reversing a run frees its attendance, leave days and holiday pay again.
--
-- Rollback: db/rollback/rollback_20261012000009_erp_hr_leave_pay.sql

-- ─── 1. Tables ───────────────────────────────────────────────────────────────

ALTER TABLE public.erp_hr_settings
  ADD COLUMN IF NOT EXISTS work_days INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5}'
    CHECK (work_days <@ ARRAY[1,2,3,4,5,6,7] AND cardinality(work_days) > 0);
ALTER TABLE public.erp_employees
  ADD COLUMN IF NOT EXISTS annual_leave_days INTEGER NOT NULL DEFAULT 12 CHECK (annual_leave_days BETWEEN 0 AND 366);

CREATE TABLE IF NOT EXISTS public.erp_employee_pay_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.erp_employees(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('allowance', 'deduction', 'employer')),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  method TEXT NOT NULL CHECK (method IN ('fixed', 'percent')),
  amount NUMERIC(18, 4) NOT NULL CHECK (amount >= 0 AND (method = 'fixed' OR amount <= 100)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_erp_employee_pay_items ON public.erp_employee_pay_items(employee_id, kind, created_at);

CREATE TABLE IF NOT EXISTS public.erp_hr_holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  paid BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, holiday_date)
);

CREATE TABLE IF NOT EXISTS public.erp_leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.erp_employees(id) ON DELETE CASCADE,
  leave_type TEXT NOT NULL CHECK (leave_type IN ('annual', 'sick', 'unpaid')),
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  days INTEGER NOT NULL CHECK (days >= 0),
  reason TEXT NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT NOT NULL DEFAULT '' CHECK (char_length(decision_note) <= 500),
  CHECK (date_to >= date_from AND date_to - date_from <= 366)
);
CREATE INDEX IF NOT EXISTS idx_erp_leave_requests_ws ON public.erp_leave_requests(workspace_id, date_from DESC);

CREATE TABLE IF NOT EXISTS public.erp_payroll_lines (
  run_id UUID NOT NULL REFERENCES public.erp_payroll_runs(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.erp_employees(id) ON DELETE CASCADE,
  records INTEGER NOT NULL DEFAULT 0,
  worked_minutes INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  regular NUMERIC(18, 2) NOT NULL DEFAULT 0,
  overtime NUMERIC(18, 2) NOT NULL DEFAULT 0,
  leave_days INTEGER NOT NULL DEFAULT 0,
  leave_pay NUMERIC(18, 2) NOT NULL DEFAULT 0,
  holiday_days INTEGER NOT NULL DEFAULT 0,
  holiday_pay NUMERIC(18, 2) NOT NULL DEFAULT 0,
  allowances NUMERIC(18, 2) NOT NULL DEFAULT 0,
  deductions NUMERIC(18, 2) NOT NULL DEFAULT 0,
  employer NUMERIC(18, 2) NOT NULL DEFAULT 0,
  gross NUMERIC(18, 2) NOT NULL DEFAULT 0,
  net NUMERIC(18, 2) NOT NULL DEFAULT 0,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (run_id, employee_id)
);

CREATE TABLE IF NOT EXISTS public.erp_leave_days (
  leave_id UUID NOT NULL REFERENCES public.erp_leave_requests(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.erp_employees(id) ON DELETE CASCADE,
  paid BOOLEAN NOT NULL,
  payroll_run_id UUID REFERENCES public.erp_payroll_runs(id) ON DELETE SET NULL,
  amount NUMERIC(18, 2),
  PRIMARY KEY (leave_id, day),
  UNIQUE (employee_id, day)
);
CREATE INDEX IF NOT EXISTS idx_erp_leave_days_ws ON public.erp_leave_days(workspace_id, day) WHERE payroll_run_id IS NULL;

CREATE TABLE IF NOT EXISTS public.erp_hr_holiday_pay (
  holiday_id UUID NOT NULL REFERENCES public.erp_hr_holidays(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.erp_employees(id) ON DELETE CASCADE,
  payroll_run_id UUID NOT NULL REFERENCES public.erp_payroll_runs(id) ON DELETE CASCADE,
  amount NUMERIC(18, 2) NOT NULL,
  PRIMARY KEY (holiday_id, employee_id)
);

ALTER TABLE public.erp_payroll_runs DROP CONSTRAINT IF EXISTS erp_payroll_runs_records_check;
ALTER TABLE public.erp_payroll_runs ADD CONSTRAINT erp_payroll_runs_records_check CHECK (records >= 0);
ALTER TABLE public.erp_payroll_runs
  ADD COLUMN IF NOT EXISTS leave_total NUMERIC(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS holiday_total NUMERIC(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allowance_total NUMERIC(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduction_total NUMERIC(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_total NUMERIC(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_total NUMERIC(18, 2);
-- Runs from before: no deductions, so net pay is the total.
UPDATE public.erp_payroll_runs SET net_total = total WHERE net_total IS NULL;
ALTER TABLE public.erp_payroll_runs ALTER COLUMN net_total SET NOT NULL, ALTER COLUMN net_total SET DEFAULT 0;

ALTER TABLE public.erp_employee_pay_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_hr_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_leave_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_payroll_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_hr_holiday_pay ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_employee_pay_items, public.erp_hr_holidays, public.erp_leave_requests,
  public.erp_leave_days, public.erp_payroll_lines, public.erp_hr_holiday_pay FROM PUBLIC, anon, authenticated;

-- ─── 2. Ledger accounts ──────────────────────────────────────────────────────
-- Same as in 20261012000002_erp_hr_payroll.sql, with three more accounts.

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

-- ─── 3. Working days ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_hr__work_days(p_workspace_id UUID)
RETURNS INTEGER[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT s.work_days FROM public.erp_hr_settings s WHERE s.workspace_id = p_workspace_id), '{1,2,3,4,5}');
$$;

-- The ERP's working days in a range, holidays excluded.
CREATE OR REPLACE FUNCTION public.erp_hr__working_days(p_workspace_id UUID, p_from DATE, p_to DATE)
RETURNS SETOF DATE LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d::DATE FROM generate_series(p_from, p_to, interval '1 day') d
  WHERE extract(isodow FROM d)::INTEGER = ANY(public.erp_hr__work_days(p_workspace_id))
    AND NOT EXISTS (SELECT 1 FROM public.erp_hr_holidays h WHERE h.workspace_id = p_workspace_id AND h.holiday_date = d::DATE)
  ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_work_days_get(p_workspace_id UUID)
RETURNS INTEGER[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ws UUID := public.erp_hr__workspace(p_workspace_id);
BEGIN
  PERFORM public.erp_hr__require(ws, 'record');
  RETURN public.erp_hr__work_days(ws);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_set_work_days(p_workspace_id UUID, p_days INTEGER[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  days INTEGER[];
BEGIN
  PERFORM public.erp_hr__require(ws, 'manage');
  SELECT array_agg(DISTINCT d ORDER BY d) INTO days FROM unnest(p_days) d WHERE d BETWEEN 1 AND 7;
  IF days IS NULL THEN RAISE EXCEPTION 'Choose at least one working day' USING ERRCODE = 'P0001', HINT = 'work_days'; END IF;
  INSERT INTO public.erp_hr_settings (workspace_id, work_days, updated_by, updated_at)
  VALUES (ws, days, auth.uid(), now())
  ON CONFLICT (workspace_id) DO UPDATE SET work_days = EXCLUDED.work_days, updated_by = EXCLUDED.updated_by, updated_at = now();
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'hr.work_days_changed', jsonb_build_object('days', to_jsonb(days)));
END;
$$;

-- ─── 4. Holidays ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_hr_holidays(p_workspace_id UUID, p_year INTEGER)
RETURNS TABLE (id UUID, holiday_date DATE, name TEXT, paid BOOLEAN, paid_out BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ws UUID := public.erp_hr__workspace(p_workspace_id);
BEGIN
  PERFORM public.erp_hr__require(ws, 'record');
  RETURN QUERY
  SELECT h.id, h.holiday_date, h.name, h.paid,
         EXISTS (SELECT 1 FROM public.erp_hr_holiday_pay p WHERE p.holiday_id = h.id)
  FROM public.erp_hr_holidays h
  WHERE h.workspace_id = ws AND extract(year FROM h.holiday_date)::INTEGER = p_year
  ORDER BY h.holiday_date;
END;
$$;

-- Adds or changes the holiday on a date. Unpaid leave days on that date are
-- removed from their requests (a holiday is not a leave day).
CREATE OR REPLACE FUNCTION public.erp_hr_holiday_save(p_workspace_id UUID, p_date DATE, p_name TEXT, p_paid BOOLEAN)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  existing public.erp_hr_holidays%ROWTYPE;
  result UUID;
  v_leaves UUID[];
BEGIN
  PERFORM public.erp_hr__require(ws, 'manage');
  IF p_date IS NULL OR char_length(btrim(COALESCE(p_name, ''))) = 0 THEN
    RAISE EXCEPTION 'Enter the date and name of the holiday' USING ERRCODE = 'P0001', HINT = 'holiday';
  END IF;
  SELECT * INTO existing FROM public.erp_hr_holidays h WHERE h.workspace_id = ws AND h.holiday_date = p_date FOR UPDATE;
  IF FOUND AND existing.paid IS DISTINCT FROM COALESCE(p_paid, false)
     AND EXISTS (SELECT 1 FROM public.erp_hr_holiday_pay p WHERE p.holiday_id = existing.id) THEN
    RAISE EXCEPTION 'This holiday was already paid in a payroll run; reverse the run first' USING ERRCODE = 'P0001', HINT = 'paid';
  END IF;
  IF EXISTS (SELECT 1 FROM public.erp_leave_days d WHERE d.workspace_id = ws AND d.day = p_date AND d.payroll_run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Leave on this date was already paid in a payroll run; reverse the run first' USING ERRCODE = 'P0001', HINT = 'paid';
  END IF;
  INSERT INTO public.erp_hr_holidays (workspace_id, holiday_date, name, paid, created_by)
  VALUES (ws, p_date, left(btrim(p_name), 120), COALESCE(p_paid, false), auth.uid())
  ON CONFLICT (workspace_id, holiday_date) DO UPDATE SET name = EXCLUDED.name, paid = EXCLUDED.paid
  RETURNING id INTO result;
  -- Leave days on the holiday are not leave (two statements: the count must
  -- see the deletion).
  WITH removed AS (
    DELETE FROM public.erp_leave_days d WHERE d.workspace_id = ws AND d.day = p_date RETURNING d.leave_id
  )
  SELECT array_agg(DISTINCT removed.leave_id) INTO v_leaves FROM removed;
  UPDATE public.erp_leave_requests r SET days = (SELECT count(*) FROM public.erp_leave_days x WHERE x.leave_id = r.id)
  WHERE r.id = ANY(COALESCE(v_leaves, '{}'));
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'hr.holiday_saved', jsonb_build_object('date', p_date, 'name', left(btrim(p_name), 120), 'paid', COALESCE(p_paid, false)));
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_holiday_delete(p_holiday_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE h public.erp_hr_holidays%ROWTYPE;
BEGIN
  SELECT * INTO h FROM public.erp_hr_holidays x WHERE x.id = p_holiday_id FOR UPDATE;
  IF NOT FOUND OR public.erp_workspace_role(h.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Holiday not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.erp_hr__require(h.workspace_id, 'manage');
  IF EXISTS (SELECT 1 FROM public.erp_hr_holiday_pay p WHERE p.holiday_id = h.id) THEN
    RAISE EXCEPTION 'This holiday was already paid in a payroll run; reverse the run first' USING ERRCODE = 'P0001', HINT = 'paid';
  END IF;
  DELETE FROM public.erp_hr_holidays x WHERE x.id = h.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (h.workspace_id, auth.uid(), 'hr.holiday_deleted', jsonb_build_object('date', h.holiday_date, 'name', h.name));
END;
$$;

-- ─── 5. Leave ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_hr_leave_request(
  p_workspace_id UUID, p_employee_id UUID, p_type TEXT, p_from DATE, p_to DATE, p_reason TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  emp public.erp_employees%ROWTYPE;
  v_days INTEGER;
  result UUID;
BEGIN
  PERFORM public.erp_hr__require(ws, 'record');
  SELECT * INTO emp FROM public.erp_employees e WHERE e.id = p_employee_id AND e.workspace_id = ws;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT emp.is_active THEN RAISE EXCEPTION 'This employee is inactive' USING ERRCODE = 'P0001', HINT = 'inactive'; END IF;
  IF p_type IS NULL OR p_type NOT IN ('annual', 'sick', 'unpaid') THEN
    RAISE EXCEPTION 'Choose the type of leave' USING ERRCODE = '22023';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 92 THEN
    RAISE EXCEPTION 'Choose a leave of at most three months' USING ERRCODE = 'P0001', HINT = 'leave_period';
  END IF;
  SELECT count(*) INTO v_days FROM public.erp_hr__working_days(ws, p_from, p_to);
  IF v_days = 0 THEN
    RAISE EXCEPTION 'There are no working days in this period' USING ERRCODE = 'P0001', HINT = 'no_days';
  END IF;
  IF EXISTS (SELECT 1 FROM public.erp_leave_requests r
             WHERE r.employee_id = emp.id AND r.status IN ('pending', 'approved')
               AND r.date_from <= p_to AND r.date_to >= p_from) THEN
    RAISE EXCEPTION 'This employee already has leave in this period' USING ERRCODE = 'P0001', HINT = 'overlap';
  END IF;
  INSERT INTO public.erp_leave_requests (workspace_id, employee_id, leave_type, date_from, date_to, days, reason, requested_by)
  VALUES (ws, emp.id, p_type, p_from, p_to, v_days, left(btrim(COALESCE(p_reason, '')), 500), auth.uid())
  RETURNING id INTO result;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'hr.leave_requested', jsonb_build_object(
    'leave_id', result, 'employee', emp.name, 'type', p_type, 'from', p_from, 'to', p_to, 'days', v_days));
  RETURN result;
END;
$$;

-- Annual leave days approved for an employee in a year.
CREATE OR REPLACE FUNCTION public.erp_hr__annual_used(p_employee_id UUID, p_year INTEGER)
RETURNS INTEGER LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::INTEGER FROM public.erp_leave_days d
  JOIN public.erp_leave_requests r ON r.id = d.leave_id
  WHERE d.employee_id = p_employee_id AND r.leave_type = 'annual' AND r.status = 'approved'
    AND extract(year FROM d.day)::INTEGER = p_year;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_leave_decide(p_leave_id UUID, p_decision TEXT, p_note TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  req public.erp_leave_requests%ROWTYPE;
  emp public.erp_employees%ROWTYPE;
  v_year INTEGER;
  v_days INTEGER;
BEGIN
  SELECT * INTO req FROM public.erp_leave_requests r WHERE r.id = p_leave_id FOR UPDATE;
  IF NOT FOUND OR public.erp_workspace_role(req.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Leave not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.erp_hr__require(req.workspace_id, 'manage');
  IF req.status <> 'pending' THEN RAISE EXCEPTION 'This leave was already decided' USING ERRCODE = 'P0001', HINT = 'decided'; END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Approve or reject' USING ERRCODE = '22023';
  END IF;
  IF p_decision = 'approved' THEN
    SELECT * INTO emp FROM public.erp_employees e WHERE e.id = req.employee_id FOR UPDATE;
    -- One row per working day; a day already on leave is refused.
    BEGIN
      INSERT INTO public.erp_leave_days (leave_id, day, workspace_id, employee_id, paid)
      SELECT req.id, d, req.workspace_id, req.employee_id, req.leave_type IN ('annual', 'sick')
      FROM public.erp_hr__working_days(req.workspace_id, req.date_from, req.date_to) d;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'This employee already has leave on one of these days' USING ERRCODE = 'P0001', HINT = 'overlap';
    END;
    SELECT count(*) INTO v_days FROM public.erp_leave_days d WHERE d.leave_id = req.id;
    IF v_days = 0 THEN
      RAISE EXCEPTION 'There are no working days in this period' USING ERRCODE = 'P0001', HINT = 'no_days';
    END IF;
    IF req.leave_type = 'annual' THEN
      FOR v_year IN SELECT DISTINCT extract(year FROM d.day)::INTEGER FROM public.erp_leave_days d WHERE d.leave_id = req.id LOOP
        -- The status is still pending here, so count this request's days separately.
        IF public.erp_hr__annual_used(emp.id, v_year)
           + (SELECT count(*) FROM public.erp_leave_days d WHERE d.leave_id = req.id AND extract(year FROM d.day)::INTEGER = v_year)
           > emp.annual_leave_days THEN
          RAISE EXCEPTION 'Not enough annual leave left in % (% days a year)', v_year, emp.annual_leave_days
            USING ERRCODE = 'P0001', HINT = 'quota';
        END IF;
      END LOOP;
    END IF;
  END IF;
  UPDATE public.erp_leave_requests r
  SET status = p_decision, days = COALESCE(v_days, r.days), decided_by = auth.uid(), decided_at = now(),
      decision_note = left(btrim(COALESCE(p_note, '')), 500)
  WHERE r.id = req.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (req.workspace_id, auth.uid(), 'hr.leave_' || p_decision, jsonb_build_object(
    'leave_id', req.id, 'type', req.leave_type, 'from', req.date_from, 'to', req.date_to));
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_leave_cancel(p_leave_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE req public.erp_leave_requests%ROWTYPE;
BEGIN
  SELECT * INTO req FROM public.erp_leave_requests r WHERE r.id = p_leave_id FOR UPDATE;
  IF NOT FOUND OR public.erp_workspace_role(req.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Leave not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.erp_hr__require(req.workspace_id, 'manage');
  IF req.status NOT IN ('pending', 'approved') THEN
    RAISE EXCEPTION 'This leave was already decided' USING ERRCODE = 'P0001', HINT = 'decided';
  END IF;
  IF EXISTS (SELECT 1 FROM public.erp_leave_days d WHERE d.leave_id = req.id AND d.payroll_run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This leave was already paid in a payroll run; reverse the run first' USING ERRCODE = 'P0001', HINT = 'paid';
  END IF;
  DELETE FROM public.erp_leave_days d WHERE d.leave_id = req.id;
  UPDATE public.erp_leave_requests r
  SET status = 'cancelled', decided_by = auth.uid(), decided_at = now(), decision_note = left(btrim(COALESCE(p_reason, '')), 500)
  WHERE r.id = req.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (req.workspace_id, auth.uid(), 'hr.leave_cancelled', jsonb_build_object('leave_id', req.id));
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_leaves(p_workspace_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (
  id UUID, employee_id UUID, employee_name TEXT, leave_type TEXT, date_from DATE, date_to DATE, days INTEGER,
  reason TEXT, status TEXT, requested_by_email TEXT, decided_by_email TEXT, decided_at TIMESTAMPTZ,
  decision_note TEXT, paid_days INTEGER, created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ws UUID := public.erp_hr__workspace(p_workspace_id);
BEGIN
  PERFORM public.erp_hr__require(ws, 'record');
  RETURN QUERY
  SELECT r.id, r.employee_id, e.name, r.leave_type, r.date_from, r.date_to, r.days, r.reason, r.status,
         rq.email, dc.email, r.decided_at, r.decision_note,
         (SELECT count(*)::INTEGER FROM public.erp_leave_days d WHERE d.leave_id = r.id AND d.payroll_run_id IS NOT NULL),
         r.created_at
  FROM public.erp_leave_requests r
  JOIN public.erp_employees e ON e.id = r.employee_id
  LEFT JOIN public.user_profiles rq ON rq.id = r.requested_by
  LEFT JOIN public.user_profiles dc ON dc.id = r.decided_by
  WHERE r.workspace_id = ws AND r.date_from <= p_to AND r.date_to >= p_from
  ORDER BY (r.status = 'pending') DESC, r.date_from DESC
  LIMIT 1000;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_leave_balances(p_workspace_id UUID, p_year INTEGER)
RETURNS TABLE (employee_id UUID, employee_name TEXT, quota INTEGER, used INTEGER, remaining INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ws UUID := public.erp_hr__workspace(p_workspace_id);
BEGIN
  PERFORM public.erp_hr__require(ws, 'record');
  RETURN QUERY
  SELECT e.id, e.name, e.annual_leave_days, u.used, e.annual_leave_days - u.used
  FROM public.erp_employees e
  CROSS JOIN LATERAL (SELECT public.erp_hr__annual_used(e.id, p_year) AS used) u
  WHERE e.workspace_id = ws AND e.is_active
  ORDER BY lower(e.name);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_set_leave_quota(p_employee_id UUID, p_days INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE emp public.erp_employees%ROWTYPE;
BEGIN
  SELECT * INTO emp FROM public.erp_employees e WHERE e.id = p_employee_id FOR UPDATE;
  IF NOT FOUND OR public.erp_workspace_role(emp.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.erp_hr__require(emp.workspace_id, 'manage');
  IF p_days IS NULL OR p_days < 0 OR p_days > 366 THEN
    RAISE EXCEPTION 'Annual leave must be between 0 and 366 days' USING ERRCODE = 'P0001', HINT = 'quota';
  END IF;
  UPDATE public.erp_employees e SET annual_leave_days = p_days, updated_at = now() WHERE e.id = emp.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (emp.workspace_id, auth.uid(), 'hr.leave_quota_changed', jsonb_build_object(
    'employee', emp.name, 'from', emp.annual_leave_days, 'to', p_days));
END;
$$;

-- ─── 6. Allowances and deductions ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_hr_pay_items(p_workspace_id UUID, p_employee_id UUID)
RETURNS TABLE (id UUID, kind TEXT, name TEXT, method TEXT, amount NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ws UUID := public.erp_hr__workspace(p_workspace_id);
BEGIN
  PERFORM public.erp_hr__require(ws, 'manage');
  RETURN QUERY
  SELECT i.id, i.kind, i.name, i.method, i.amount FROM public.erp_employee_pay_items i
  WHERE i.workspace_id = ws AND i.employee_id = p_employee_id
  ORDER BY array_position(ARRAY['allowance', 'deduction', 'employer'], i.kind), i.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_pay_item_save(
  p_workspace_id UUID, p_employee_id UUID, p_item_id UUID, p_data JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  v_kind TEXT := p_data ->> 'kind';
  v_name TEXT := btrim(COALESCE(p_data ->> 'name', ''));
  v_method TEXT := p_data ->> 'method';
  v_amount NUMERIC := (p_data ->> 'amount')::NUMERIC;
  result UUID;
BEGIN
  PERFORM public.erp_hr__require(ws, 'manage');
  IF NOT EXISTS (SELECT 1 FROM public.erp_employees e WHERE e.id = p_employee_id AND e.workspace_id = ws) THEN
    RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('allowance', 'deduction', 'employer') OR v_method IS NULL
     OR v_method NOT IN ('fixed', 'percent') THEN
    RAISE EXCEPTION 'Choose the kind and how it is computed' USING ERRCODE = '22023';
  END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'Give it a name' USING ERRCODE = 'P0001', HINT = 'item_name'; END IF;
  IF v_amount IS NULL OR v_amount < 0 OR (v_method = 'percent' AND v_amount > 100) THEN
    RAISE EXCEPTION 'Enter an amount, or a percentage between 0 and 100' USING ERRCODE = 'P0001', HINT = 'item_amount';
  END IF;
  IF p_item_id IS NULL THEN
    INSERT INTO public.erp_employee_pay_items (workspace_id, employee_id, kind, name, method, amount)
    VALUES (ws, p_employee_id, v_kind, left(v_name, 80), v_method, round(v_amount, 4))
    RETURNING id INTO result;
  ELSE
    UPDATE public.erp_employee_pay_items i
    SET kind = v_kind, name = left(v_name, 80), method = v_method, amount = round(v_amount, 4)
    WHERE i.id = p_item_id AND i.workspace_id = ws AND i.employee_id = p_employee_id
    RETURNING i.id INTO result;
    IF result IS NULL THEN RAISE EXCEPTION 'Item not found' USING ERRCODE = 'P0002'; END IF;
  END IF;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'hr.pay_items_changed', jsonb_build_object(
    'employee_id', p_employee_id, 'kind', v_kind, 'name', left(v_name, 80), 'method', v_method, 'amount', v_amount));
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_pay_item_delete(p_item_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE item public.erp_employee_pay_items%ROWTYPE;
BEGIN
  SELECT * INTO item FROM public.erp_employee_pay_items i WHERE i.id = p_item_id;
  IF NOT FOUND OR public.erp_workspace_role(item.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Item not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.erp_hr__require(item.workspace_id, 'manage');
  DELETE FROM public.erp_employee_pay_items i WHERE i.id = item.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (item.workspace_id, auth.uid(), 'hr.pay_items_changed', jsonb_build_object(
    'employee_id', item.employee_id, 'removed', item.name));
END;
$$;

-- ─── 7. Payroll ──────────────────────────────────────────────────────────────

-- One line per employee with unpaid pay in the period (nothing is written).
CREATE OR REPLACE FUNCTION public.erp_hr__payroll_lines(p_workspace_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  emp RECORD;
  item RECORD;
  lines JSONB := '[]'::jsonb;
  base NUMERIC;
  allowances NUMERIC;
  gross NUMERIC;
  deductions NUMERIC;
  employer NUMERIC;
  amount NUMERIC;
  items JSONB;
BEGIN
  FOR emp IN
    WITH att AS (
      SELECT a.employee_id, count(*)::INTEGER AS records, COALESCE(sum(a.worked_minutes), 0)::INTEGER AS worked,
             COALESCE(sum(a.overtime_minutes), 0)::INTEGER AS overtime_min,
             COALESCE(sum(a.regular_pay), 0) AS regular, COALESCE(sum(a.overtime_pay), 0) AS overtime
      FROM public.erp_attendance a
      WHERE a.workspace_id = p_workspace_id AND a.work_date BETWEEN p_from AND p_to
        AND a.clock_out IS NOT NULL AND a.payroll_run_id IS NULL
      GROUP BY a.employee_id
    ), lv AS (
      SELECT d.employee_id, count(*)::INTEGER AS days
      FROM public.erp_leave_days d JOIN public.erp_leave_requests r ON r.id = d.leave_id
      WHERE d.workspace_id = p_workspace_id AND d.day BETWEEN p_from AND p_to AND d.paid
        AND d.payroll_run_id IS NULL AND r.status = 'approved'
      GROUP BY d.employee_id
    ), hol AS (
      SELECT e.id AS employee_id, count(*)::INTEGER AS days
      FROM public.erp_hr_holidays h
      JOIN public.erp_employees e ON e.workspace_id = h.workspace_id AND e.is_active AND e.created_at::DATE <= h.holiday_date
      WHERE h.workspace_id = p_workspace_id AND h.paid AND h.holiday_date BETWEEN p_from AND p_to
        AND NOT EXISTS (SELECT 1 FROM public.erp_hr_holiday_pay p WHERE p.holiday_id = h.id AND p.employee_id = e.id)
      GROUP BY e.id
    )
    SELECT e.id, e.name, e.hourly_rate, e.normal_hours,
           COALESCE(att.records, 0) AS records, COALESCE(att.worked, 0) AS worked, COALESCE(att.overtime_min, 0) AS overtime_min,
           COALESCE(att.regular, 0) AS regular, COALESCE(att.overtime, 0) AS overtime,
           COALESCE(lv.days, 0) AS leave_days, round(COALESCE(lv.days, 0) * e.normal_hours * e.hourly_rate, 2) AS leave_pay,
           COALESCE(hol.days, 0) AS holiday_days, round(COALESCE(hol.days, 0) * e.normal_hours * e.hourly_rate, 2) AS holiday_pay
    FROM public.erp_employees e
    LEFT JOIN att ON att.employee_id = e.id
    LEFT JOIN lv ON lv.employee_id = e.id
    LEFT JOIN hol ON hol.employee_id = e.id
    WHERE e.workspace_id = p_workspace_id AND (att.employee_id IS NOT NULL OR lv.employee_id IS NOT NULL OR hol.employee_id IS NOT NULL)
    ORDER BY lower(e.name)
  LOOP
    base := round(emp.regular, 2) + round(emp.overtime, 2) + emp.leave_pay + emp.holiday_pay;
    allowances := 0; deductions := 0; employer := 0; items := '[]'::jsonb;
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
    lines := lines || jsonb_build_array(jsonb_build_object(
      'employee_id', emp.id, 'name', emp.name, 'records', emp.records, 'worked_minutes', emp.worked,
      'overtime_minutes', emp.overtime_min, 'regular', round(emp.regular, 2), 'overtime', round(emp.overtime, 2),
      'leave_days', emp.leave_days, 'leave_pay', emp.leave_pay, 'holiday_days', emp.holiday_days,
      'holiday_pay', emp.holiday_pay, 'allowances', allowances, 'deductions', deductions, 'employer', employer,
      'gross', gross, 'net', gross - deductions, 'items', items));
  END LOOP;
  RETURN lines;
END;
$$;

-- Same result keys as before (20261012000002), plus leave, holidays,
-- allowances, deductions, employer contributions, net pay and the lines.
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

-- Reversing also frees leave days and holiday pay (same function as in
-- 20261012000002_erp_hr_payroll.sql otherwise).
DO $$
DECLARE def TEXT := pg_get_functiondef('public.erp_hr_payroll_reverse(uuid,text)'::regprocedure);
BEGIN
  IF position('erp_leave_days' IN def) = 0 THEN
    IF position('  UPDATE public.erp_attendance SET payroll_run_id = NULL WHERE payroll_run_id = run.id;' IN def) = 0 THEN
      RAISE EXCEPTION 'erp_hr_payroll_reverse changed; not patched';
    END IF;
    EXECUTE replace(def, '  UPDATE public.erp_attendance SET payroll_run_id = NULL WHERE payroll_run_id = run.id;',
      '  UPDATE public.erp_attendance SET payroll_run_id = NULL WHERE payroll_run_id = run.id;
  UPDATE public.erp_leave_days SET payroll_run_id = NULL, amount = NULL WHERE payroll_run_id = run.id;
  DELETE FROM public.erp_hr_holiday_pay WHERE payroll_run_id = run.id;');
  END IF;
END;
$$;

-- Employees with leave or payslips are deactivated, not deleted.
DO $$
DECLARE def TEXT := pg_get_functiondef('public.erp_hr_employee_delete(uuid)'::regprocedure);
BEGIN
  IF position('erp_leave_requests' IN def) = 0 THEN
    IF position('  IF EXISTS (SELECT 1 FROM public.erp_attendance a WHERE a.employee_id = emp.id) THEN' IN def) = 0 THEN
      RAISE EXCEPTION 'erp_hr_employee_delete changed; not patched';
    END IF;
    EXECUTE replace(def, '  IF EXISTS (SELECT 1 FROM public.erp_attendance a WHERE a.employee_id = emp.id) THEN',
      '  IF EXISTS (SELECT 1 FROM public.erp_attendance a WHERE a.employee_id = emp.id)
     OR EXISTS (SELECT 1 FROM public.erp_leave_requests l WHERE l.employee_id = emp.id)
     OR EXISTS (SELECT 1 FROM public.erp_payroll_lines p WHERE p.employee_id = emp.id) THEN');
  END IF;
END;
$$;

-- The runs with the new totals (erp_hr_payroll_runs keeps its columns: older
-- migrations re-create it with them).
CREATE OR REPLACE FUNCTION public.erp_hr_payroll_runs_v2(p_workspace_id UUID)
RETURNS TABLE (
  id UUID, period_from DATE, period_to DATE, pay_date DATE, credit_to TEXT, records INTEGER,
  regular_total NUMERIC, overtime_total NUMERIC, total NUMERIC, status TEXT, entry_no INTEGER,
  reverse_reason TEXT, created_at TIMESTAMPTZ, created_by_email TEXT,
  leave_total NUMERIC, holiday_total NUMERIC, allowance_total NUMERIC, deduction_total NUMERIC,
  employer_total NUMERIC, net_total NUMERIC, employees INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ws UUID := public.erp_hr__workspace(p_workspace_id);
BEGIN
  PERFORM public.erp_hr__require(ws, 'manage');
  RETURN QUERY
  SELECT r.id, r.period_from, r.period_to, r.pay_date, r.credit_to, r.records, r.regular_total, r.overtime_total,
         r.total, r.status, j.entry_no, r.reverse_reason, r.created_at, p.email,
         r.leave_total, r.holiday_total, r.allowance_total, r.deduction_total, r.employer_total, r.net_total,
         (SELECT count(*)::INTEGER FROM public.erp_payroll_lines x WHERE x.run_id = r.id)
  FROM public.erp_payroll_runs r
  LEFT JOIN public.erp_journal_entries j ON j.id = r.journal_entry_id
  LEFT JOIN public.user_profiles p ON p.id = r.created_by
  WHERE r.workspace_id = ws
  ORDER BY r.created_at DESC
  LIMIT 200;
END;
$$;

-- Payslips of a run: one per employee.
CREATE OR REPLACE FUNCTION public.erp_hr_payslips(p_run_id UUID)
RETURNS TABLE (
  employee_id UUID, employee_code TEXT, employee_name TEXT, "position" TEXT, hourly_rate NUMERIC,
  overtime_rate NUMERIC, normal_hours NUMERIC, records INTEGER, worked_minutes INTEGER, overtime_minutes INTEGER,
  regular NUMERIC, overtime NUMERIC, leave_days INTEGER, leave_pay NUMERIC, holiday_days INTEGER, holiday_pay NUMERIC,
  allowances NUMERIC, deductions NUMERIC, employer NUMERIC, gross NUMERIC, net NUMERIC, items JSONB,
  period_from DATE, period_to DATE, pay_date DATE, status TEXT, workspace_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE run public.erp_payroll_runs%ROWTYPE;
BEGIN
  SELECT * INTO run FROM public.erp_payroll_runs r WHERE r.id = p_run_id;
  IF NOT FOUND OR public.erp_workspace_role(run.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Payroll run not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.erp_hr__require(run.workspace_id, 'manage');
  RETURN QUERY
  SELECT e.id, e.employee_code, e.name, e.position, e.hourly_rate, e.overtime_rate, e.normal_hours,
         l.records, l.worked_minutes, l.overtime_minutes, l.regular, l.overtime, l.leave_days, l.leave_pay,
         l.holiday_days, l.holiday_pay, l.allowances, l.deductions, l.employer, l.gross, l.net, l.items,
         run.period_from, run.period_to, run.pay_date, run.status, run.workspace_id
  FROM public.erp_payroll_lines l
  JOIN public.erp_employees e ON e.id = l.employee_id
  WHERE l.run_id = run.id
  ORDER BY lower(e.name);
END;
$$;

-- ─── 8. Privileges ───────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.erp_hr__payroll_account(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr__work_days(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr__working_days(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr__annual_used(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr__payroll_lines(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr_set_work_days(UUID, INTEGER[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_work_days_get(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_holidays(UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_holiday_save(UUID, DATE, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_holiday_delete(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_leave_request(UUID, UUID, TEXT, DATE, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_leave_decide(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_leave_cancel(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_leaves(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_leave_balances(UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_set_leave_quota(UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_pay_items(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_pay_item_save(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_pay_item_delete(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_payroll_preview(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_payroll_run(UUID, DATE, DATE, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_payroll_runs_v2(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_payslips(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_hr_set_work_days(UUID, INTEGER[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_work_days_get(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_holidays(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_holiday_save(UUID, DATE, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_holiday_delete(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_leave_request(UUID, UUID, TEXT, DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_leave_decide(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_leave_cancel(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_leaves(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_leave_balances(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_set_leave_quota(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_pay_items(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_pay_item_save(UUID, UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_pay_item_delete(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_payroll_preview(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_payroll_run(UUID, DATE, DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_payroll_runs_v2(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_payslips(UUID) TO authenticated;
