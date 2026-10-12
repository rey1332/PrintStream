'use client';

import { createClient } from '@/lib/data/client';
import type { MessageKey } from '@/lib/i18n/messages';
import { rpcWorkspaceId } from './workspace';
import type { WorkspaceRole } from './erpRules';

export interface Employee {
  id: string;
  employeeCode: string;
  name: string;
  position: string;
  phone: string;
  hourlyRate: number | null;
  overtimeRate: number | null;
  normalHours: number;
  isActive: boolean;
  hasAttendance: boolean;
}

export interface EmployeeInput {
  employee_code: string;
  name: string;
  position: string;
  phone: string;
  hourly_rate: number;
  overtime_rate: number;
  normal_hours: number;
  is_active: boolean;
}

export interface TodayRow {
  employeeId: string;
  employeeCode: string;
  name: string;
  position: string;
  attendanceId: string | null;
  workDate: string | null;
  clockIn: string | null;
  clockOut: string | null;
  workedMinutes: number | null;
  overtimeMinutes: number | null;
}

export interface AttendanceRow {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  workDate: string;
  clockIn: string;
  clockOut: string | null;
  workedMinutes: number | null;
  regularMinutes: number | null;
  overtimeMinutes: number | null;
  hourlyRate: number | null;
  overtimeRate: number | null;
  regularPay: number | null;
  overtimePay: number | null;
  note: string;
  corrected: boolean;
  correctionReason: string;
}

export const ATTENDANCE_ROLE_CHOICES: readonly WorkspaceRole[] = ['finance', 'sales', 'inventory'];

export class HrError extends Error {
  key: MessageKey;
  constructor(key: MessageKey) {
    super(key);
    this.key = key;
  }
}

const MESSAGES: [RegExp, MessageKey][] = [
  [/already has this code/, 'hr.err.duplicateCode'],
  [/Enter the employee/, 'hr.err.name'],
  [/cannot be negative/, 'hr.err.negativeRate'],
  [/Normal hours/, 'hr.err.normalHours'],
  [/already clocked in/, 'hr.err.alreadyIn'],
  [/already has attendance for today/, 'hr.err.alreadyToday'],
  [/not clocked in/, 'hr.err.notIn'],
  [/more than 24 hours ago/, 'hr.err.tooLong'],
  [/inactive/, 'hr.err.inactive'],
  [/Deactivate them instead/, 'hr.err.hasAttendance'],
  [/reason of at least/, 'hr.err.reason'],
  [/after clock-in and within 24 hours/, 'hr.err.times'],
  [/in the future/, 'hr.err.future'],
  [/at most one year/, 'hr.err.period'],
  [/already paid in a payroll run/, 'hr.err.paid'],
  [/Invalid pay terms/, 'hr.err.terms'],
  [/Invalid payroll settings/, 'hr.err.settings'],
  [/no unpaid, finished attendance/, 'hr.err.nothingToPay'],
  [/has no pay/, 'hr.err.zeroPay'],
  [/already reversed/, 'hr.err.alreadyReversed'],
  [/books are closed/, 'hr.err.booksClosed'],
  [/no working days/, 'hr.err.noWorkDays'],
  [/already has leave/, 'hr.err.leaveOverlap'],
  [/Not enough annual leave/, 'hr.err.quota'],
  [/already decided/, 'hr.err.decided'],
  [/at most three months/, 'hr.err.leavePeriod'],
  [/Deductions are larger/, 'hr.err.negative'],
  [/Enter an amount|between 0 and 100/, 'hr.err.itemAmount'],
  [/Give it a name/, 'hr.err.itemName'],
  [/date and name of the holiday/, 'hr.err.holiday'],
  [/at least one working day/, 'hr.err.workDays'],
  [/Annual leave must be between/, 'hr.err.quotaRange'],
];

function fail(error: { code?: string; message?: string }): never {
  const found = MESSAGES.find(([pattern]) => pattern.test(error.message ?? ''));
  if (found) throw new HrError(found[1]);
  if (error.code === '42501') throw new HrError('hr.err.forbidden');
  throw new HrError('hr.err.failed');
}

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn, args);
  if (error) fail(error);
  return data as T;
}

const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

export const hrService = {
  async setAttendanceRoles(roles: WorkspaceRole[]): Promise<void> {
    await call('erp_hr_set_attendance_roles', { p_workspace_id: rpcWorkspaceId(), p_roles: roles });
  },

  async employees(includeInactive = false): Promise<Employee[]> {
    const rows = await call<any[]>('erp_hr_employees', {
      p_workspace_id: rpcWorkspaceId(),
      p_include_inactive: includeInactive,
    });
    return (rows ?? []).map((r) => ({
      id: r.id,
      employeeCode: r.employee_code ?? '',
      name: r.name,
      position: r.position ?? '',
      phone: r.phone ?? '',
      hourlyRate: num(r.hourly_rate),
      overtimeRate: num(r.overtime_rate),
      normalHours: Number(r.normal_hours),
      isActive: r.is_active === true,
      hasAttendance: r.has_attendance === true,
    }));
  },

  async saveEmployee(id: string | null, input: EmployeeInput): Promise<string> {
    return call<string>('erp_hr_employee_save', {
      p_workspace_id: rpcWorkspaceId(),
      p_employee_id: id,
      p_data: input,
    });
  },

  async deleteEmployee(id: string): Promise<void> {
    await call('erp_hr_employee_delete', { p_employee_id: id });
  },

  async today(): Promise<TodayRow[]> {
    const rows = await call<any[]>('erp_hr_today', {
      p_workspace_id: rpcWorkspaceId(),
      p_tz: timeZone(),
    });
    return (rows ?? []).map((r) => ({
      employeeId: r.employee_id,
      employeeCode: r.employee_code ?? '',
      name: r.name,
      position: r.position ?? '',
      attendanceId: r.attendance_id ?? null,
      workDate: r.work_date ?? null,
      clockIn: r.clock_in ?? null,
      clockOut: r.clock_out ?? null,
      workedMinutes: num(r.worked_minutes),
      overtimeMinutes: num(r.overtime_minutes),
    }));
  },

  async clockIn(employeeId: string, note = ''): Promise<void> {
    await call('erp_hr_clock_in', {
      p_workspace_id: rpcWorkspaceId(),
      p_employee_id: employeeId,
      p_tz: timeZone(),
      p_note: note,
    });
  },

  async clockOut(employeeId: string, note = ''): Promise<void> {
    await call('erp_hr_clock_out', {
      p_workspace_id: rpcWorkspaceId(),
      p_employee_id: employeeId,
      p_note: note,
    });
  },

  async history(from: string, to: string, employeeId: string | null): Promise<AttendanceRow[]> {
    const rows = await call<any[]>('erp_hr_attendance', {
      p_workspace_id: rpcWorkspaceId(),
      p_from: from,
      p_to: to,
      p_employee_id: employeeId,
    });
    return (rows ?? []).map((r) => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      employeeCode: r.employee_code ?? '',
      workDate: r.work_date,
      clockIn: r.clock_in,
      clockOut: r.clock_out ?? null,
      workedMinutes: num(r.worked_minutes),
      regularMinutes: num(r.regular_minutes),
      overtimeMinutes: num(r.overtime_minutes),
      hourlyRate: num(r.hourly_rate),
      overtimeRate: num(r.overtime_rate),
      regularPay: num(r.regular_pay),
      overtimePay: num(r.overtime_pay),
      note: r.note ?? '',
      corrected: r.corrected === true,
      correctionReason: r.correction_reason ?? '',
    }));
  },

  async correct(
    attendanceId: string,
    clockIn: string,
    clockOut: string | null,
    reason: string
  ): Promise<void> {
    await call('erp_hr_attendance_correct', {
      p_attendance_id: attendanceId,
      p_clock_in: clockIn,
      p_clock_out: clockOut,
      p_reason: reason,
    });
  },

  async payrollPreview(
    from: string,
    to: string,
    thr = false,
    payDate: string | null = null
  ): Promise<PayrollPreview> {
    const p = await call<any>('erp_hr_payroll_preview_v2', {
      p_workspace_id: rpcWorkspaceId(),
      p_from: from,
      p_to: to,
      p_thr: thr,
      p_pay_date: payDate || to,
    });
    const n = (key: string) => Number(p?.[key] ?? 0);
    return {
      records: n('records'),
      stillIn: n('still_in'),
      alreadyPaid: n('already_paid'),
      employees: n('employees'),
      regular: n('regular'),
      overtime: n('overtime'),
      leave: n('leave'),
      holiday: n('holiday'),
      allowances: n('allowances'),
      deductions: n('deductions'),
      employer: n('employer'),
      gross: n('gross'),
      net: n('net'),
      thr: n('thr'),
      pph21: n('pph21'),
      bpjs: n('bpjs'),
      negative: p?.negative === true,
      lines: (p?.lines ?? []).map(mapPayLine),
    };
  },

  async payrollRun(
    from: string,
    to: string,
    payDate: string,
    creditTo: 'cash' | 'payable',
    thr = false
  ): Promise<string> {
    return call<string>('erp_hr_payroll_run_v2', {
      p_workspace_id: rpcWorkspaceId(),
      p_from: from,
      p_to: to,
      p_pay_date: payDate,
      p_credit_to: creditTo,
      p_thr: thr,
    });
  },

  async payrollSettings(): Promise<PayrollSettings> {
    const s = await call<any>('erp_hr_payroll_settings_get', { p_workspace_id: rpcWorkspaceId() });
    return {
      rules: s?.payroll_rules === 'id' ? 'id' : 'basic',
      jkkRate: Number(s?.jkk_rate ?? 0.24),
      jkmRate: Number(s?.jkm_rate ?? 0.3),
      jpCap: Number(s?.jp_cap ?? 0),
      kesCap: Number(s?.kes_cap ?? 0),
      kesFloor: Number(s?.kes_floor ?? 0),
    };
  },

  async savePayrollSettings(s: PayrollSettings): Promise<void> {
    await call('erp_hr_payroll_settings_set', {
      p_workspace_id: rpcWorkspaceId(),
      p_settings: {
        payroll_rules: s.rules,
        jkk_rate: s.jkkRate,
        jkm_rate: s.jkmRate,
        jp_cap: s.jpCap,
        kes_cap: s.kesCap,
        kes_floor: s.kesFloor,
      },
    });
  },

  async employeeTerms(): Promise<Record<string, PayTerms>> {
    const rows = await call<any[]>('erp_hr_employee_terms', { p_workspace_id: rpcWorkspaceId() });
    return Object.fromEntries(
      (rows ?? []).map((r) => [
        r.employee_id,
        {
          payType: r.pay_type,
          monthlySalary: Number(r.monthly_salary ?? 0),
          fixedAllowance: Number(r.fixed_allowance ?? 0),
          dailyRate: Number(r.daily_rate ?? 0),
          joinDate: r.join_date ?? '',
          ptkpStatus: r.ptkp_status,
          npwp: r.npwp ?? '',
          bpjsTk: !!r.bpjs_tk,
          bpjsJp: !!r.bpjs_jp,
          bpjsKes: !!r.bpjs_kes,
        } satisfies PayTerms,
      ])
    );
  },

  async saveEmployeeTerms(employeeId: string, terms: PayTerms): Promise<void> {
    await call('erp_hr_employee_terms_save', {
      p_employee_id: employeeId,
      p_terms: {
        pay_type: terms.payType,
        monthly_salary: terms.monthlySalary,
        fixed_allowance: terms.fixedAllowance,
        daily_rate: terms.dailyRate,
        join_date: terms.joinDate || null,
        ptkp_status: terms.ptkpStatus,
        npwp: terms.npwp,
        bpjs_tk: terms.bpjsTk,
        bpjs_jp: terms.bpjsJp,
        bpjs_kes: terms.bpjsKes,
      },
    });
  },

  async payrollReverse(runId: string, reason: string): Promise<void> {
    await call('erp_hr_payroll_reverse', { p_run_id: runId, p_reason: reason });
  },

  async payrollRuns(): Promise<PayrollRun[]> {
    const rows = await call<any[]>('erp_hr_payroll_runs_v2', { p_workspace_id: rpcWorkspaceId() });
    return (rows ?? []).map((r) => ({
      id: r.id,
      periodFrom: r.period_from,
      periodTo: r.period_to,
      payDate: r.pay_date,
      creditTo: r.credit_to,
      records: Number(r.records),
      regularTotal: Number(r.regular_total),
      overtimeTotal: Number(r.overtime_total),
      total: Number(r.total),
      status: r.status,
      entryNo: r.entry_no ?? null,
      reverseReason: r.reverse_reason ?? '',
      createdAt: r.created_at,
      createdBy: r.created_by_email ?? null,
      leaveTotal: Number(r.leave_total ?? 0),
      holidayTotal: Number(r.holiday_total ?? 0),
      allowanceTotal: Number(r.allowance_total ?? 0),
      deductionTotal: Number(r.deduction_total ?? 0),
      employerTotal: Number(r.employer_total ?? 0),
      netTotal: Number(r.net_total ?? r.total),
      employees: Number(r.employees ?? 0),
    }));
  },

  async payslips(runId: string): Promise<Payslip[]> {
    const rows = await call<any[]>('erp_hr_payslips', { p_run_id: runId });
    return (rows ?? []).map((r) => ({
      ...mapPayLine(r),
      employeeCode: r.employee_code ?? '',
      position: r.position ?? '',
      hourlyRate: Number(r.hourly_rate ?? 0),
      overtimeRate: Number(r.overtime_rate ?? 0),
      normalHours: Number(r.normal_hours ?? 0),
      periodFrom: r.period_from,
      periodTo: r.period_to,
      payDate: r.pay_date,
      status: r.status,
      workspaceId: r.workspace_id,
    }));
  },

  // ── Leave and holidays ──

  async leaves(from: string, to: string): Promise<LeaveRequest[]> {
    const rows = await call<any[]>('erp_hr_leaves', {
      p_workspace_id: rpcWorkspaceId(),
      p_from: from,
      p_to: to,
    });
    return (rows ?? []).map((r) => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      type: r.leave_type,
      from: r.date_from,
      to: r.date_to,
      days: Number(r.days),
      reason: r.reason ?? '',
      status: r.status,
      requestedBy: r.requested_by_email ?? null,
      decidedBy: r.decided_by_email ?? null,
      decidedAt: r.decided_at ?? null,
      note: r.decision_note ?? '',
      paidDays: Number(r.paid_days ?? 0),
    }));
  },

  async requestLeave(
    employeeId: string,
    type: LeaveType,
    from: string,
    to: string,
    reason: string
  ): Promise<string> {
    return call<string>('erp_hr_leave_request', {
      p_workspace_id: rpcWorkspaceId(),
      p_employee_id: employeeId,
      p_type: type,
      p_from: from,
      p_to: to,
      p_reason: reason,
    });
  },

  async decideLeave(id: string, decision: 'approved' | 'rejected', note: string): Promise<void> {
    await call('erp_hr_leave_decide', { p_leave_id: id, p_decision: decision, p_note: note });
  },

  async cancelLeave(id: string, reason: string): Promise<void> {
    await call('erp_hr_leave_cancel', { p_leave_id: id, p_reason: reason });
  },

  async leaveBalances(year: number): Promise<LeaveBalance[]> {
    const rows = await call<any[]>('erp_hr_leave_balances', {
      p_workspace_id: rpcWorkspaceId(),
      p_year: year,
    });
    return (rows ?? []).map((r) => ({
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      quota: Number(r.quota),
      used: Number(r.used),
      remaining: Number(r.remaining),
    }));
  },

  async setLeaveQuota(employeeId: string, days: number): Promise<void> {
    await call('erp_hr_set_leave_quota', { p_employee_id: employeeId, p_days: days });
  },

  async holidays(year: number): Promise<Holiday[]> {
    const rows = await call<any[]>('erp_hr_holidays', {
      p_workspace_id: rpcWorkspaceId(),
      p_year: year,
    });
    return (rows ?? []).map((r) => ({
      id: r.id,
      date: r.holiday_date,
      name: r.name,
      paid: r.paid === true,
      paidOut: r.paid_out === true,
    }));
  },

  async saveHoliday(date: string, name: string, paid: boolean): Promise<void> {
    await call('erp_hr_holiday_save', {
      p_workspace_id: rpcWorkspaceId(),
      p_date: date,
      p_name: name,
      p_paid: paid,
    });
  },

  async deleteHoliday(id: string): Promise<void> {
    await call('erp_hr_holiday_delete', { p_holiday_id: id });
  },

  async workDays(): Promise<number[]> {
    const days = await call<number[] | null>('erp_hr_work_days_get', {
      p_workspace_id: rpcWorkspaceId(),
    });
    return (days ?? [1, 2, 3, 4, 5]).map(Number);
  },

  async setWorkDays(days: number[]): Promise<void> {
    await call('erp_hr_set_work_days', { p_workspace_id: rpcWorkspaceId(), p_days: days });
  },

  // ── Allowances and deductions ──

  async payItems(employeeId: string): Promise<PayItem[]> {
    const rows = await call<any[]>('erp_hr_pay_items', {
      p_workspace_id: rpcWorkspaceId(),
      p_employee_id: employeeId,
    });
    return (rows ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      method: r.method,
      amount: Number(r.amount),
    }));
  },

  async savePayItem(
    employeeId: string,
    id: string | null,
    item: Omit<PayItem, 'id'>
  ): Promise<void> {
    await call('erp_hr_pay_item_save', {
      p_workspace_id: rpcWorkspaceId(),
      p_employee_id: employeeId,
      p_item_id: id,
      p_data: item,
    });
  },

  async deletePayItem(id: string): Promise<void> {
    await call('erp_hr_pay_item_delete', { p_item_id: id });
  },
};

function mapPayLine(l: any): PayLine {
  return {
    employeeId: l.employee_id,
    name: l.name ?? l.employee_name ?? '',
    records: Number(l.records ?? 0),
    workedMinutes: Number(l.worked_minutes ?? 0),
    overtimeMinutes: Number(l.overtime_minutes ?? 0),
    regular: Number(l.regular ?? 0),
    overtime: Number(l.overtime ?? 0),
    leaveDays: Number(l.leave_days ?? 0),
    leavePay: Number(l.leave_pay ?? 0),
    holidayDays: Number(l.holiday_days ?? 0),
    holidayPay: Number(l.holiday_pay ?? 0),
    allowances: Number(l.allowances ?? 0),
    deductions: Number(l.deductions ?? 0),
    employer: Number(l.employer ?? 0),
    gross: Number(l.gross ?? 0),
    net: Number(l.net ?? 0),
    // 'info' items (e.g. unpaid leave on a salary) are notes, not pay items.
    items: (l.items ?? [])
      .filter((i: any) => ['allowance', 'deduction', 'employer'].includes(i.kind))
      .map((i: any) => ({
        kind: i.kind,
        name: i.name,
        method: i.method,
        rate: Number(i.rate ?? 0),
        amount: Number(i.amount ?? 0),
      })),
  };
}

export type PayItemKind = 'allowance' | 'deduction' | 'employer';

export interface PayItem {
  id: string;
  kind: PayItemKind;
  name: string;
  method: 'fixed' | 'percent';
  amount: number;
}

export interface PayLine {
  employeeId: string;
  name: string;
  records: number;
  workedMinutes: number;
  overtimeMinutes: number;
  regular: number;
  overtime: number;
  leaveDays: number;
  leavePay: number;
  holidayDays: number;
  holidayPay: number;
  allowances: number;
  deductions: number;
  employer: number;
  gross: number;
  net: number;
  items: {
    kind: PayItemKind;
    name: string;
    method: 'fixed' | 'percent';
    rate: number;
    amount: number;
  }[];
}

export interface Payslip extends PayLine {
  employeeCode: string;
  position: string;
  hourlyRate: number;
  overtimeRate: number;
  normalHours: number;
  periodFrom: string;
  periodTo: string;
  payDate: string;
  status: 'posted' | 'reversed';
  workspaceId: string;
}

export type LeaveType = 'annual' | 'sick' | 'unpaid';

export interface LeaveRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  type: LeaveType;
  from: string;
  to: string;
  days: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string;
  paidDays: number;
}

export interface LeaveBalance {
  employeeId: string;
  employeeName: string;
  quota: number;
  used: number;
  remaining: number;
}

export interface Holiday {
  id: string;
  date: string;
  name: string;
  paid: boolean;
  paidOut: boolean;
}

export interface PayrollPreview {
  records: number;
  stillIn: number;
  alreadyPaid: number;
  employees: number;
  regular: number;
  overtime: number;
  leave: number;
  holiday: number;
  allowances: number;
  deductions: number;
  employer: number;
  gross: number;
  net: number;
  thr: number;
  pph21: number;
  bpjs: number;
  negative: boolean;
  lines: PayLine[];
}

export type PayType = 'hourly' | 'daily' | 'monthly';
export const PTKP_STATUSES = ['TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3'] as const;

/** Monthly and daily pay, and the Indonesian tax and BPJS details (20261012000027). */
export interface PayTerms {
  payType: PayType;
  monthlySalary: number;
  fixedAllowance: number;
  dailyRate: number;
  joinDate: string;
  ptkpStatus: (typeof PTKP_STATUSES)[number];
  npwp: string;
  bpjsTk: boolean;
  bpjsJp: boolean;
  bpjsKes: boolean;
}

export interface PayrollSettings {
  rules: 'basic' | 'id';
  jkkRate: number;
  jkmRate: number;
  jpCap: number;
  kesCap: number;
  kesFloor: number;
}

export interface PayrollRun {
  id: string;
  periodFrom: string;
  periodTo: string;
  payDate: string;
  creditTo: 'cash' | 'payable';
  records: number;
  regularTotal: number;
  overtimeTotal: number;
  total: number;
  status: 'posted' | 'reversed';
  entryNo: number | null;
  reverseReason: string;
  createdAt: string;
  createdBy: string | null;
  leaveTotal: number;
  holidayTotal: number;
  allowanceTotal: number;
  deductionTotal: number;
  employerTotal: number;
  netTotal: number;
  employees: number;
}

export function splitMinutes(minutes: number): { h: number; m: number } {
  const total = Math.max(0, Math.round(minutes));
  return { h: Math.floor(total / 60), m: total % 60 };
}

export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return { from: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, to: today };
}
