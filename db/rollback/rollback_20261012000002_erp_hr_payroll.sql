-- Rollback for 20261012000002_erp_hr_payroll.sql.
-- Run only after redeploying an app version from before payroll.
--
-- Refused while payroll entries exist in any ledger (reverse every run first,
-- or keep this migration): the journal's source types could not be restored.
-- Removes payroll runs; attendance records stay, no longer marked as paid.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.erp_journal_entries WHERE source_type IN ('payroll', 'payroll_reversal')) THEN
    RAISE EXCEPTION 'Payroll journal entries exist; this rollback would break the ledger. Nothing was changed.';
  END IF;
END;
$$;

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

DROP FUNCTION IF EXISTS public.erp_hr_payroll_runs(UUID);
DROP FUNCTION IF EXISTS public.erp_hr_payroll_reverse(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_hr_payroll_run(UUID, DATE, DATE, DATE, TEXT);
DROP FUNCTION IF EXISTS public.erp_hr_payroll_preview(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS public.erp_hr__payroll_account(UUID, TEXT);

ALTER TABLE public.erp_attendance DROP COLUMN IF EXISTS payroll_run_id;
DROP TABLE IF EXISTS public.erp_payroll_runs;

ALTER TABLE public.erp_journal_entries DROP CONSTRAINT IF EXISTS erp_journal_entries_source_type_check;
ALTER TABLE public.erp_journal_entries ADD CONSTRAINT erp_journal_entries_source_type_check CHECK (source_type IN (
  'invoice', 'invoice_void', 'invoice_adjust', 'payment', 'payment_void', 'payment_adjust', 'transaction',
  'purchase_receipt', 'sales_delivery', 'stock_adjustment', 'opening_stock', 'manual', 'manual_reversal',
  'fx_settlement'));

COMMIT;
