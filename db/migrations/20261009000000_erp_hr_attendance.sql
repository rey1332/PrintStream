-- HR: employees, hourly and overtime rates, attendance (clock in / clock out).
--
-- Who may do what, per workspace:
--   * Owner and Admin manage employees and their rates, correct attendance
--     and see pay;
--   * Owner and Admin record attendance, and so do the roles the Owner
--     chooses (Finance, Sales, Inventory; erp_hr_settings.attendance_roles).
--     Those roles see employees and hours, never rates or pay.
-- Clients have no table privileges: everything goes through the functions
-- below, which apply these rules and the workspace's two-factor requirement.
--
-- Pay: one attendance record per employee per day. Minutes beyond the
-- employee's normal hours are overtime. Regular minutes are paid at the
-- hourly rate, overtime minutes at the overtime rate; both rates (and the
-- normal hours) are copied onto the record at clock-in, so later rate
-- changes never rewrite history. Amounts are in the workspace's base
-- currency.

-- ─── 1. Tables ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.erp_hr_settings (
  workspace_id UUID PRIMARY KEY REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  attendance_roles TEXT[] NOT NULL DEFAULT '{}'
    CHECK (attendance_roles <@ ARRAY['finance', 'sales', 'inventory']::TEXT[]),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.erp_employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  employee_code TEXT NOT NULL DEFAULT '' CHECK (char_length(employee_code) <= 40),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  position TEXT NOT NULL DEFAULT '' CHECK (char_length(position) <= 120),
  phone TEXT NOT NULL DEFAULT '' CHECK (char_length(phone) <= 40),
  hourly_rate NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0),
  overtime_rate NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (overtime_rate >= 0),
  normal_hours NUMERIC(4, 2) NOT NULL DEFAULT 8 CHECK (normal_hours > 0 AND normal_hours <= 24),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_erp_employees_workspace ON public.erp_employees(workspace_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_employees_code
  ON public.erp_employees(workspace_id, lower(employee_code)) WHERE employee_code <> '';

CREATE TABLE IF NOT EXISTS public.erp_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.erp_employees(id) ON DELETE RESTRICT,
  work_date DATE NOT NULL,
  clock_in TIMESTAMPTZ NOT NULL,
  clock_out TIMESTAMPTZ,
  -- Copied from the employee at clock-in.
  hourly_rate NUMERIC(18, 2) NOT NULL,
  overtime_rate NUMERIC(18, 2) NOT NULL,
  normal_hours NUMERIC(4, 2) NOT NULL,
  -- Filled at clock-out (and on correction).
  worked_minutes INTEGER,
  regular_minutes INTEGER,
  overtime_minutes INTEGER,
  regular_pay NUMERIC(18, 2),
  overtime_pay NUMERIC(18, 2),
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  clocked_in_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  clocked_out_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  corrected_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  corrected_at TIMESTAMPTZ,
  correction_reason TEXT NOT NULL DEFAULT '' CHECK (char_length(correction_reason) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date),
  CHECK (clock_out IS NULL OR (clock_out > clock_in AND clock_out <= clock_in + interval '24 hours')),
  CHECK ((clock_out IS NULL) = (worked_minutes IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_erp_attendance_workspace_date ON public.erp_attendance(workspace_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_erp_attendance_open ON public.erp_attendance(employee_id) WHERE clock_out IS NULL;

ALTER TABLE public.erp_hr_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_attendance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_hr_settings, public.erp_employees, public.erp_attendance FROM PUBLIC, anon, authenticated;

-- ─── 2. Access ───────────────────────────────────────────────────────────────

-- The workspace a call is about: the given one, else the caller's personal one.
CREATE OR REPLACE FUNCTION public.erp_hr__workspace(p_workspace_id UUID)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(p_workspace_id, public.erp_personal_workspace_id(auth.uid()));
$$;

-- The caller's role, when they are an active member and meet the workspace's
-- two-factor requirement; otherwise NULL.
CREATE OR REPLACE FUNCTION public.erp_hr__role(p_workspace_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN public.erp_workspace_mfa_ok(p_workspace_id) THEN public.erp_workspace_role(p_workspace_id) END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_can_manage(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.erp_hr__role(p_workspace_id) IN ('owner', 'admin'), false);
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_can_record(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.erp_hr_can_manage(p_workspace_id)
      OR COALESCE(public.erp_hr__role(p_workspace_id) = ANY(COALESCE(
           (SELECT s.attendance_roles FROM public.erp_hr_settings s WHERE s.workspace_id = p_workspace_id), '{}'::TEXT[])), false);
$$;

CREATE OR REPLACE FUNCTION public.erp_hr__require(p_workspace_id UUID, p_level TEXT)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_level = 'manage' AND NOT public.erp_hr_can_manage(p_workspace_id) THEN
    RAISE EXCEPTION 'Only the owner or an admin can manage employees' USING ERRCODE = '42501';
  END IF;
  IF p_level = 'record' AND NOT public.erp_hr_can_record(p_workspace_id) THEN
    RAISE EXCEPTION 'You are not allowed to record attendance in this workspace' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- What the caller may do in HR (the app shows menus from this).
CREATE OR REPLACE FUNCTION public.erp_hr_access(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ws UUID := public.erp_hr__workspace(p_workspace_id);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'can_manage', public.erp_hr_can_manage(ws),
    'can_record', public.erp_hr_can_record(ws),
    'can_configure', COALESCE(public.erp_hr__role(ws) = 'owner', false),
    'attendance_roles', COALESCE((SELECT to_jsonb(s.attendance_roles) FROM public.erp_hr_settings s WHERE s.workspace_id = ws), '[]'::jsonb)
  );
END;
$$;

-- The Owner chooses which other roles record attendance.
CREATE OR REPLACE FUNCTION public.erp_hr_set_attendance_roles(p_workspace_id UUID, p_roles TEXT[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  roles TEXT[];
  previous TEXT[];
BEGIN
  IF COALESCE(public.erp_hr__role(ws) = 'owner', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only the owner can choose who records attendance' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT r ORDER BY r), '{}') INTO roles FROM unnest(COALESCE(p_roles, '{}')) r;
  IF NOT roles <@ ARRAY['finance', 'sales', 'inventory']::TEXT[] THEN
    RAISE EXCEPTION 'Choose from Finance, Sales and Inventory' USING ERRCODE = '22023';
  END IF;
  SELECT s.attendance_roles INTO previous FROM public.erp_hr_settings s WHERE s.workspace_id = ws;

  INSERT INTO public.erp_hr_settings (workspace_id, attendance_roles, updated_by, updated_at)
  VALUES (ws, roles, auth.uid(), now())
  ON CONFLICT (workspace_id) DO UPDATE
    SET attendance_roles = EXCLUDED.attendance_roles, updated_by = EXCLUDED.updated_by, updated_at = now();

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'hr.attendance_roles_changed',
          jsonb_build_object('from', COALESCE(previous, '{}'), 'to', roles));
END;
$$;

-- ─── 3. Employees ────────────────────────────────────────────────────────────

-- Rates are returned only to the Owner and Admins.
CREATE OR REPLACE FUNCTION public.erp_hr_employees(p_workspace_id UUID, p_include_inactive BOOLEAN DEFAULT false)
RETURNS TABLE (
  id UUID, employee_code TEXT, name TEXT, "position" TEXT, phone TEXT,
  hourly_rate NUMERIC, overtime_rate NUMERIC, normal_hours NUMERIC, is_active BOOLEAN, has_attendance BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  manage BOOLEAN;
BEGIN
  PERFORM public.erp_hr__require(ws, 'record');
  manage := public.erp_hr_can_manage(ws);
  RETURN QUERY
  SELECT e.id, e.employee_code, e.name, e.position, e.phone,
         CASE WHEN manage THEN e.hourly_rate END,
         CASE WHEN manage THEN e.overtime_rate END,
         e.normal_hours, e.is_active,
         EXISTS (SELECT 1 FROM public.erp_attendance a WHERE a.employee_id = e.id)
  FROM public.erp_employees e
  WHERE e.workspace_id = ws AND (e.is_active OR COALESCE(p_include_inactive, false))
  ORDER BY e.is_active DESC, lower(e.name)
  LIMIT 2000;
END;
$$;

-- Adds (p_employee_id NULL) or updates an employee. p_data keys:
-- employee_code, name, position, phone, hourly_rate, overtime_rate,
-- normal_hours, is_active (missing keys keep their value on update).
CREATE OR REPLACE FUNCTION public.erp_hr_employee_save(p_workspace_id UUID, p_employee_id UUID, p_data JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  existing public.erp_employees%ROWTYPE;
  v_code TEXT;
  v_name TEXT;
  v_hourly NUMERIC;
  v_overtime NUMERIC;
  v_normal NUMERIC;
  result UUID;
BEGIN
  PERFORM public.erp_hr__require(ws, 'manage');
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'Employee details are missing' USING ERRCODE = '22023';
  END IF;

  IF p_employee_id IS NOT NULL THEN
    SELECT * INTO existing FROM public.erp_employees e WHERE e.id = p_employee_id AND e.workspace_id = ws FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002'; END IF;
  END IF;

  v_code := btrim(COALESCE(p_data->>'employee_code', existing.employee_code, ''));
  v_name := btrim(COALESCE(p_data->>'name', existing.name, ''));
  v_hourly := COALESCE((p_data->>'hourly_rate')::NUMERIC, existing.hourly_rate, 0);
  v_overtime := COALESCE((p_data->>'overtime_rate')::NUMERIC, existing.overtime_rate, 0);
  v_normal := COALESCE((p_data->>'normal_hours')::NUMERIC, existing.normal_hours, 8);

  IF v_name = '' THEN RAISE EXCEPTION 'Enter the employee''s name' USING ERRCODE = 'P0001', HINT = 'name_required'; END IF;
  IF v_hourly < 0 OR v_overtime < 0 THEN
    RAISE EXCEPTION 'Rates cannot be negative' USING ERRCODE = 'P0001', HINT = 'negative_rate';
  END IF;
  IF v_normal <= 0 OR v_normal > 24 THEN
    RAISE EXCEPTION 'Normal hours must be between 0 and 24' USING ERRCODE = 'P0001', HINT = 'normal_hours';
  END IF;
  IF v_code <> '' AND EXISTS (
    SELECT 1 FROM public.erp_employees e
    WHERE e.workspace_id = ws AND lower(e.employee_code) = lower(v_code) AND e.id IS DISTINCT FROM p_employee_id
  ) THEN
    RAISE EXCEPTION 'Another employee already has this code' USING ERRCODE = 'P0001', HINT = 'duplicate_code';
  END IF;

  IF p_employee_id IS NULL THEN
    INSERT INTO public.erp_employees (workspace_id, employee_code, name, position, phone,
                                      hourly_rate, overtime_rate, normal_hours, is_active, created_by)
    VALUES (ws, v_code, v_name, btrim(COALESCE(p_data->>'position', '')), btrim(COALESCE(p_data->>'phone', '')),
            round(v_hourly, 2), round(v_overtime, 2), round(v_normal, 2),
            COALESCE((p_data->>'is_active')::BOOLEAN, true), auth.uid())
    RETURNING id INTO result;
  ELSE
    UPDATE public.erp_employees e
    SET employee_code = v_code, name = v_name,
        position = btrim(COALESCE(p_data->>'position', existing.position)),
        phone = btrim(COALESCE(p_data->>'phone', existing.phone)),
        hourly_rate = round(v_hourly, 2), overtime_rate = round(v_overtime, 2), normal_hours = round(v_normal, 2),
        is_active = COALESCE((p_data->>'is_active')::BOOLEAN, existing.is_active),
        updated_at = now()
    WHERE e.id = p_employee_id
    RETURNING e.id INTO result;

    IF round(v_hourly, 2) <> existing.hourly_rate OR round(v_overtime, 2) <> existing.overtime_rate
       OR round(v_normal, 2) <> existing.normal_hours THEN
      INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
      VALUES (ws, auth.uid(), 'hr.employee_rates_changed', jsonb_build_object(
        'employee_id', result, 'name', v_name,
        'hourly_rate', jsonb_build_array(existing.hourly_rate, round(v_hourly, 2)),
        'overtime_rate', jsonb_build_array(existing.overtime_rate, round(v_overtime, 2)),
        'normal_hours', jsonb_build_array(existing.normal_hours, round(v_normal, 2))));
    END IF;
  END IF;
  RETURN result;
END;
$$;

-- Deletes an employee without attendance; one with attendance is deactivated
-- instead (history keeps pointing at it).
CREATE OR REPLACE FUNCTION public.erp_hr_employee_delete(p_employee_id UUID)
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
  IF EXISTS (SELECT 1 FROM public.erp_attendance a WHERE a.employee_id = emp.id) THEN
    RAISE EXCEPTION 'This employee has attendance records. Deactivate them instead.'
      USING ERRCODE = 'P0001', HINT = 'has_attendance';
  END IF;
  DELETE FROM public.erp_employees WHERE id = emp.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (emp.workspace_id, auth.uid(), 'hr.employee_deleted', jsonb_build_object('employee_id', emp.id, 'name', emp.name));
END;
$$;

-- ─── 4. Attendance ───────────────────────────────────────────────────────────

-- Fills the worked / regular / overtime minutes and pay of a closed record.
CREATE OR REPLACE FUNCTION public.erp_hr__settle(p_attendance_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.erp_attendance a
  SET worked_minutes = calc.worked,
      overtime_minutes = calc.overtime,
      regular_minutes = calc.worked - calc.overtime,
      regular_pay = round((calc.worked - calc.overtime) * a.hourly_rate / 60.0, 2),
      overtime_pay = round(calc.overtime * a.overtime_rate / 60.0, 2)
  FROM (
    SELECT x.id,
           floor(extract(epoch FROM (x.clock_out - x.clock_in)) / 60)::INTEGER AS worked,
           greatest(0, floor(extract(epoch FROM (x.clock_out - x.clock_in)) / 60)::INTEGER
                       - round(x.normal_hours * 60)::INTEGER) AS overtime
    FROM public.erp_attendance x WHERE x.id = p_attendance_id
  ) calc
  WHERE a.id = calc.id;
END;
$$;

-- Today's date where the attendance is taken (the browser's time zone when
-- it is a valid name, else the database's).
CREATE OR REPLACE FUNCTION public.erp_hr__today(p_tz TEXT)
RETURNS DATE
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (now() AT TIME ZONE COALESCE(
    (SELECT n.name FROM pg_timezone_names n WHERE n.name = p_tz LIMIT 1),
    current_setting('TimeZone')))::DATE;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_clock_in(p_workspace_id UUID, p_employee_id UUID, p_tz TEXT DEFAULT NULL, p_note TEXT DEFAULT '')
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  emp public.erp_employees%ROWTYPE;
  v_day DATE := public.erp_hr__today(p_tz);
  result UUID;
BEGIN
  PERFORM public.erp_hr__require(ws, 'record');
  SELECT * INTO emp FROM public.erp_employees e WHERE e.id = p_employee_id AND e.workspace_id = ws FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT emp.is_active THEN
    RAISE EXCEPTION 'This employee is inactive' USING ERRCODE = 'P0001', HINT = 'inactive';
  END IF;
  IF EXISTS (SELECT 1 FROM public.erp_attendance a WHERE a.employee_id = emp.id AND a.clock_out IS NULL) THEN
    RAISE EXCEPTION 'This employee is already clocked in' USING ERRCODE = 'P0001', HINT = 'already_in';
  END IF;
  IF EXISTS (SELECT 1 FROM public.erp_attendance a WHERE a.employee_id = emp.id AND a.work_date = v_day) THEN
    RAISE EXCEPTION 'This employee already has attendance for today' USING ERRCODE = 'P0001', HINT = 'already_today';
  END IF;

  INSERT INTO public.erp_attendance (workspace_id, employee_id, work_date, clock_in, hourly_rate, overtime_rate,
                                     normal_hours, note, clocked_in_by)
  VALUES (ws, emp.id, v_day, now(), emp.hourly_rate, emp.overtime_rate, emp.normal_hours,
          left(btrim(COALESCE(p_note, '')), 500), auth.uid())
  RETURNING id INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_hr_clock_out(p_workspace_id UUID, p_employee_id UUID, p_note TEXT DEFAULT '')
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  att public.erp_attendance%ROWTYPE;
BEGIN
  PERFORM public.erp_hr__require(ws, 'record');
  SELECT * INTO att FROM public.erp_attendance a
  WHERE a.employee_id = p_employee_id AND a.workspace_id = ws AND a.clock_out IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This employee is not clocked in' USING ERRCODE = 'P0001', HINT = 'not_in';
  END IF;
  IF now() > att.clock_in + interval '24 hours' THEN
    RAISE EXCEPTION 'Clocked in more than 24 hours ago. Ask the owner or an admin to correct it.'
      USING ERRCODE = 'P0001', HINT = 'too_long';
  END IF;

  UPDATE public.erp_attendance a
  SET clock_out = greatest(now(), a.clock_in + interval '1 second'), clocked_out_by = auth.uid(),
      note = CASE WHEN btrim(COALESCE(p_note, '')) = '' THEN a.note
                  ELSE left(btrim(a.note || ' ' || btrim(p_note)), 500) END,
      worked_minutes = 0
  WHERE a.id = att.id;
  PERFORM public.erp_hr__settle(att.id);
  RETURN att.id;
END;
$$;

-- Owner / Admin correction of a record's times (a reason is required).
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

-- Active employees with today's record (or a record still open from an
-- earlier day), for the attendance board.
CREATE OR REPLACE FUNCTION public.erp_hr_today(p_workspace_id UUID, p_tz TEXT DEFAULT NULL)
RETURNS TABLE (
  employee_id UUID, employee_code TEXT, name TEXT, "position" TEXT,
  attendance_id UUID, work_date DATE, clock_in TIMESTAMPTZ, clock_out TIMESTAMPTZ,
  worked_minutes INTEGER, overtime_minutes INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  v_day DATE := public.erp_hr__today(p_tz);
BEGIN
  PERFORM public.erp_hr__require(ws, 'record');
  RETURN QUERY
  SELECT e.id, e.employee_code, e.name, e.position,
         a.id, a.work_date, a.clock_in, a.clock_out, a.worked_minutes, a.overtime_minutes
  FROM public.erp_employees e
  LEFT JOIN LATERAL (
    SELECT x.* FROM public.erp_attendance x
    WHERE x.employee_id = e.id AND (x.work_date = v_day OR x.clock_out IS NULL)
    ORDER BY (x.clock_out IS NULL) DESC, x.work_date DESC
    LIMIT 1
  ) a ON true
  WHERE e.workspace_id = ws AND e.is_active
  ORDER BY lower(e.name)
  LIMIT 2000;
END;
$$;

-- Attendance history. Pay is returned only to the Owner and Admins.
CREATE OR REPLACE FUNCTION public.erp_hr_attendance(
  p_workspace_id UUID, p_from DATE, p_to DATE, p_employee_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID, employee_id UUID, employee_name TEXT, employee_code TEXT, work_date DATE,
  clock_in TIMESTAMPTZ, clock_out TIMESTAMPTZ, worked_minutes INTEGER, regular_minutes INTEGER,
  overtime_minutes INTEGER, hourly_rate NUMERIC, overtime_rate NUMERIC, regular_pay NUMERIC, overtime_pay NUMERIC,
  note TEXT, corrected BOOLEAN, correction_reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp_hr__workspace(p_workspace_id);
  manage BOOLEAN;
BEGIN
  PERFORM public.erp_hr__require(ws, 'record');
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'Choose a period of at most one year' USING ERRCODE = 'P0001', HINT = 'period';
  END IF;
  manage := public.erp_hr_can_manage(ws);
  RETURN QUERY
  SELECT a.id, a.employee_id, e.name, e.employee_code, a.work_date, a.clock_in, a.clock_out,
         a.worked_minutes, a.regular_minutes, a.overtime_minutes,
         CASE WHEN manage THEN a.hourly_rate END, CASE WHEN manage THEN a.overtime_rate END,
         CASE WHEN manage THEN a.regular_pay END, CASE WHEN manage THEN a.overtime_pay END,
         a.note, a.corrected_at IS NOT NULL, a.correction_reason
  FROM public.erp_attendance a
  JOIN public.erp_employees e ON e.id = a.employee_id
  WHERE a.workspace_id = ws AND a.work_date BETWEEN p_from AND p_to
    AND (p_employee_id IS NULL OR a.employee_id = p_employee_id)
  ORDER BY a.work_date DESC, lower(e.name)
  LIMIT 5000;
END;
$$;

-- ─── 5. Privileges ───────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.erp_hr__workspace(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr__role(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr__require(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr__settle(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_hr__today(TEXT) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.erp_hr_can_manage(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_can_record(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_access(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_set_attendance_roles(UUID, TEXT[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_employees(UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_employee_save(UUID, UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_employee_delete(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_clock_in(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_clock_out(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_attendance_correct(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_today(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_hr_attendance(UUID, DATE, DATE, UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.erp_hr_can_manage(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_can_record(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_access(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_set_attendance_roles(UUID, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_employees(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_employee_save(UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_employee_delete(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_clock_in(UUID, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_clock_out(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_attendance_correct(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_today(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_attendance(UUID, DATE, DATE, UUID) TO authenticated;
