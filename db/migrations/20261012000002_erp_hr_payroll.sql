-- Payroll to the ledger (HR → Payroll).
--
-- The Owner or an Admin pays a period: every finished attendance record in it
-- that is not paid yet goes into one payroll run, posted as one journal entry
--   Dr 6200 Salaries and wages   (regular pay)
--   Dr 6210 Overtime pay         (overtime pay)
--   Cr 1000 Cash and bank        (paid now)  or  Cr 2200 Wages payable (paid later)
-- in the ERP's base currency, on the chosen pay date (closed periods are
-- refused by the ledger as for every entry). Paid records cannot be corrected
-- until the run is reversed; reversing posts the opposite entry and frees the
-- records for a new run. Runs and reversals are in the workspace audit trail.
--
-- Rollback: db/rollback/rollback_20261012000002_erp_hr_payroll.sql

-- ─── 1. Journal sources ──────────────────────────────────────────────────────
-- Keep in sync with JOURNAL_SOURCES (src/lib/analytics/catalog.ts) and the
-- ontology's journal statuses (src/lib/ontology/registry.ts).

ALTER TABLE public.erp_journal_entries DROP CONSTRAINT IF EXISTS erp_journal_entries_source_type_check;
ALTER TABLE public.erp_journal_entries ADD CONSTRAINT erp_journal_entries_source_type_check CHECK (source_type IN (
  'invoice', 'invoice_void', 'invoice_adjust', 'payment', 'payment_void', 'payment_adjust', 'transaction',
  'purchase_receipt', 'sales_delivery', 'stock_adjustment', 'opening_stock', 'manual', 'manual_reversal',
  'fx_settlement', 'payroll', 'payroll_reversal'));

-- ─── 2. Runs ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.erp_payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  pay_date DATE NOT NULL,
  credit_to TEXT NOT NULL CHECK (credit_to IN ('cash', 'payable')),
  records INTEGER NOT NULL CHECK (records > 0),
  regular_total NUMERIC(18, 2) NOT NULL,
  overtime_total NUMERIC(18, 2) NOT NULL,
  total NUMERIC(18, 2) NOT NULL,
  journal_entry_id UUID REFERENCES public.erp_journal_entries(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  reversal_entry_id UUID REFERENCES public.erp_journal_entries(id) ON DELETE SET NULL,
  reverse_reason TEXT NOT NULL DEFAULT '' CHECK (char_length(reverse_reason) <= 500),
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ,
  CHECK (period_to >= period_from)
);

CREATE INDEX IF NOT EXISTS idx_erp_payroll_runs_workspace ON public.erp_payroll_runs(workspace_id, created_at DESC);

ALTER TABLE public.erp_attendance
  ADD COLUMN IF NOT EXISTS payroll_run_id UUID REFERENCES public.erp_payroll_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_erp_attendance_payroll ON public.erp_attendance(payroll_run_id) WHERE payroll_run_id IS NOT NULL;

ALTER TABLE public.erp_payroll_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_payroll_runs FROM PUBLIC, anon, authenticated;

-- ─── 3. Ledger accounts ──────────────────────────────────────────────────────

-- The payroll account for a key, created on first use. If the usual code is
-- taken by an account the owner made, the next free code is used.
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

-- ─── 4. Preview, run, reverse, list ──────────────────────────────────────────

-- What a run for the period would contain (nothing is posted).
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

CREATE OR REPLACE FUNCTION public.erp_hr_payroll_reverse(p_run_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  run public.erp_payroll_runs%ROWTYPE;
  v_owner UUID;
  entry UUID;
BEGIN
  SELECT * INTO run FROM public.erp_payroll_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR public.erp_workspace_role(run.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Payroll run not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.erp_hr__require(run.workspace_id, 'manage');
  IF run.status = 'reversed' THEN RAISE EXCEPTION 'This payroll run was already reversed' USING ERRCODE = 'P0001', HINT = 'reversed'; END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'Give a reason of at least 5 characters' USING ERRCODE = 'P0001', HINT = 'reason';
  END IF;
  SELECT w.owner_id INTO v_owner FROM public.erp_workspaces w WHERE w.id = run.workspace_id;

  entry := public.erp_gl__reverse(v_owner, 'payroll:' || run.id, CURRENT_DATE,
    'Reversal of payroll ' || to_char(run.period_from, 'YYYY-MM-DD') || ' – ' || to_char(run.period_to, 'YYYY-MM-DD')
      || ': ' || btrim(p_reason),
    'payroll_reversal', run.id, 'payroll_reversal:' || run.id);

  UPDATE public.erp_payroll_runs
  SET status = 'reversed', reversal_entry_id = entry, reversed_by = auth.uid(), reversed_at = now(),
      reverse_reason = left(btrim(p_reason), 500)
  WHERE id = run.id;
  UPDATE public.erp_attendance SET payroll_run_id = NULL WHERE payroll_run_id = run.id;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (run.workspace_id, auth.uid(), 'hr.payroll_reversed', jsonb_build_object(
    'run_id', run.id, 'total', run.total, 'reason', left(btrim(p_reason), 500)));
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_payroll_runs(p_workspace_id UUID)
RETURNS TABLE (
  id UUID, period_from DATE, period_to DATE, pay_date DATE, credit_to TEXT, records INTEGER,
  regular_total NUMERIC, overtime_total NUMERIC, total NUMERIC, status TEXT, entry_no INTEGER,
  reverse_reason TEXT, created_at TIMESTAMPTZ, created_by_email TEXT
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
         r.total, r.status, j.entry_no, r.reverse_reason, r.created_at, p.email
  FROM public.erp_payroll_runs r
  LEFT JOIN public.erp_journal_entries j ON j.id = r.journal_entry_id
  LEFT JOIN public.user_profiles p ON p.id = r.created_by
  WHERE r.workspace_id = ws
  ORDER BY r.created_at DESC
  LIMIT 200;
END;
$$;

-- ─── 5. Paid attendance is not corrected ─────────────────────────────────────
-- Same definition as 20261009000000_erp_hr_attendance.sql, plus the check.

CREATE OR REPLACE FUNCTION public.erp_hr_attendance_correct(
  p_attendance_id UUID, p_clock_in TIMESTAMPTZ, p_clock_out TIMESTAMPTZ, p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE att public.erp_attendance%ROWTYPE;
BEGIN
  SELECT * INTO att FROM public.erp_attendance a WHERE a.id = p_attendance_id FOR UPDATE;
  IF NOT FOUND OR public.erp_workspace_role(att.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Attendance not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.erp_hr__require(att.workspace_id, 'manage');
  IF att.payroll_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'This attendance is already paid in a payroll run; reverse the run first'
      USING ERRCODE = 'P0001', HINT = 'paid';
  END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'Give a reason of at least 5 characters' USING ERRCODE = 'P0001', HINT = 'reason';
  END IF;
  IF p_clock_in IS NULL OR (p_clock_out IS NOT NULL AND
     (p_clock_out <= p_clock_in OR p_clock_out > p_clock_in + interval '24 hours')) THEN
    RAISE EXCEPTION 'Clock-out must be after clock-in and within 24 hours' USING ERRCODE = 'P0001', HINT = 'times';
  END IF;
  IF p_clock_in > now() OR p_clock_out > now() THEN
    RAISE EXCEPTION 'Times cannot be in the future' USING ERRCODE = 'P0001', HINT = 'future';
  END IF;
  IF p_clock_out IS NULL AND EXISTS (
    SELECT 1 FROM public.erp_attendance a WHERE a.employee_id = att.employee_id AND a.clock_out IS NULL AND a.id <> att.id
  ) THEN
    RAISE EXCEPTION 'This employee is already clocked in on another day' USING ERRCODE = 'P0001', HINT = 'already_in';
  END IF;

  UPDATE public.erp_attendance a
  SET clock_in = p_clock_in, clock_out = p_clock_out,
      worked_minutes = CASE WHEN p_clock_out IS NULL THEN NULL ELSE 0 END,
      regular_minutes = NULL, overtime_minutes = NULL, regular_pay = NULL, overtime_pay = NULL,
      corrected_by = auth.uid(), corrected_at = now(), correction_reason = left(btrim(p_reason), 500)
  WHERE a.id = att.id;
  IF p_clock_out IS NOT NULL THEN PERFORM public.erp_hr__settle(att.id); END IF;

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (att.workspace_id, auth.uid(), 'hr.attendance_corrected', jsonb_build_object(
    'attendance_id', att.id, 'employee_id', att.employee_id, 'work_date', att.work_date,
    'from', jsonb_build_array(att.clock_in, att.clock_out), 'to', jsonb_build_array(p_clock_in, p_clock_out),
    'reason', left(btrim(p_reason), 500)));
END;
$$;

-- ─── 6. Privileges ───────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.erp_hr__payroll_account(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr_payroll_preview(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_payroll_run(UUID, DATE, DATE, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_payroll_reverse(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_payroll_runs(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_attendance_correct(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_hr_payroll_preview(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_payroll_run(UUID, DATE, DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_payroll_reverse(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_payroll_runs(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_attendance_correct(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated;
