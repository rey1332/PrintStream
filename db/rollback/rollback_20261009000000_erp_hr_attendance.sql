-- Rollback for 20261009000000_erp_hr_attendance.sql.
-- Run only after redeploying an app version from before HR / attendance.
--
-- Drops employees, attendance and the HR settings with their data. Export
-- the attendance history first (HR → Attendance history → Export) if it is
-- needed. Audit entries about HR are kept.

BEGIN;

DROP FUNCTION IF EXISTS public.erp_hr_attendance(UUID, DATE, DATE, UUID);
DROP FUNCTION IF EXISTS public.erp_hr_today(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_hr_attendance_correct(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT);
DROP FUNCTION IF EXISTS public.erp_hr_clock_out(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_hr_clock_in(UUID, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.erp_hr__today(TEXT);
DROP FUNCTION IF EXISTS public.erp_hr__settle(UUID);
DROP FUNCTION IF EXISTS public.erp_hr_employee_delete(UUID);
DROP FUNCTION IF EXISTS public.erp_hr_employee_save(UUID, UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_hr_employees(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.erp_hr_set_attendance_roles(UUID, TEXT[]);
DROP FUNCTION IF EXISTS public.erp_hr_access(UUID);
DROP FUNCTION IF EXISTS public.erp_hr__require(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_hr_can_record(UUID);
DROP FUNCTION IF EXISTS public.erp_hr_can_manage(UUID);
DROP FUNCTION IF EXISTS public.erp_hr__role(UUID);
DROP FUNCTION IF EXISTS public.erp_hr__workspace(UUID);

DROP TABLE IF EXISTS public.erp_attendance;
DROP TABLE IF EXISTS public.erp_employees;
DROP TABLE IF EXISTS public.erp_hr_settings;

COMMIT;
