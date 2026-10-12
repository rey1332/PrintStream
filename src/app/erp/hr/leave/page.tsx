'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Check, Loader2, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useWorkspace } from '../../lib/WorkspaceContext';
import {
  HrError,
  hrService,
  type Employee,
  type Holiday,
  type LeaveBalance,
  type LeaveRequest,
  type LeaveType,
} from '../../lib/hrService';

const inputCls =
  'rounded-lg border border-border bg-card px-3 py-2 text-[0.8rem] text-foreground outline-none focus:border-foreground/40';
const TYPES: LeaveType[] = ['annual', 'sick', 'unpaid'];
const DAYS = [1, 2, 3, 4, 5, 6, 7];

const statusCls: Record<LeaveRequest['status'], string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  approved: 'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300',
  rejected: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300',
  cancelled: 'bg-[var(--surface-3)] text-muted-foreground',
};

const todayIso = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function LeavePage() {
  const { t, fmt } = useI18n();
  const { active, hr, hrReady } = useWorkspace();
  const manage = hr.canManage;
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [workDays, setWorkDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [requesting, setRequesting] = useState<{
    employeeId: string;
    type: LeaveType;
    from: string;
    to: string;
    reason: string;
  } | null>(null);
  const [deciding, setDeciding] = useState<{
    leave: LeaveRequest;
    action: 'approved' | 'rejected' | 'cancel';
    note: string;
  } | null>(null);
  const [holidayForm, setHolidayForm] = useState({ date: '', name: '', paid: false });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const errorText = useCallback(
    (err: unknown) => t(err instanceof HrError ? err.key : 'hr.err.failed'),
    [t]
  );

  const load = useCallback(async () => {
    setError('');
    try {
      const [l, b, h, w] = await Promise.all([
        hrService.leaves(`${year}-01-01`, `${year}-12-31`),
        hrService.leaveBalances(year),
        hrService.holidays(year),
        hrService.workDays(),
      ]);
      setWorkDays(w);
      setLeaves(l);
      setBalances(b);
      setHolidays(h);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [year, errorText]);

  useEffect(() => {
    if (!hrReady) return;
    setLoading(true);
    void load();
  }, [hrReady, active?.id, load]);

  useEffect(() => {
    if (!hrReady) return;
    hrService
      .employees()
      .then(setEmployees)
      .catch(() => setEmployees([]));
  }, [hrReady, active?.id]);

  async function submitRequest(event: React.FormEvent) {
    event.preventDefault();
    if (!requesting || busy) return;
    setBusy(true);
    setFormError('');
    try {
      await hrService.requestLeave(
        requesting.employeeId,
        requesting.type,
        requesting.from,
        requesting.to,
        requesting.reason.trim()
      );
      toast.success(t('hr.leave.requested'));
      setRequesting(null);
      await load();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitDecision(event: React.FormEvent) {
    event.preventDefault();
    if (!deciding || busy) return;
    setBusy(true);
    setFormError('');
    try {
      if (deciding.action === 'cancel') {
        await hrService.cancelLeave(deciding.leave.id, deciding.note.trim());
        toast.success(t('hr.leave.cancelledToast'));
      } else {
        await hrService.decideLeave(deciding.leave.id, deciding.action, deciding.note.trim());
        toast.success(
          t(deciding.action === 'approved' ? 'hr.leave.approvedToast' : 'hr.leave.rejectedToast')
        );
      }
      setDeciding(null);
      await load();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function addHoliday(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await hrService.saveHoliday(holidayForm.date, holidayForm.name.trim(), holidayForm.paid);
      toast.success(t('hr.hol.saved'));
      setHolidayForm({ date: '', name: '', paid: false });
      await load();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeHoliday(h: Holiday) {
    try {
      await hrService.deleteHoliday(h.id);
      toast.success(t('hr.hol.deleted'));
      await load();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  async function toggleWorkDay(day: number) {
    const next = workDays.includes(day) ? workDays.filter((d) => d !== day) : [...workDays, day];
    try {
      await hrService.setWorkDays(next);
      setWorkDays(next.sort());
      toast.success(t('hr.work.saved'));
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  const typeLabel = (type: LeaveType) => t(`hr.leave.type.${type}` as MessageKey);
  const range = (from: string, to: string) =>
    from === to ? fmt.date(from) : `${fmt.date(from)} – ${fmt.date(to)}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('erp.nav.leave')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5 max-w-2xl">
            {t('hr.leave.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            aria-label={t('hr.hol.date')}
            className={inputCls}
          >
            {[-1, 0, 1].map((d) => {
              const y = new Date().getFullYear() + d;
              return (
                <option key={y} value={y}>
                  {y}
                </option>
              );
            })}
          </select>
          <button
            type="button"
            onClick={() => {
              setFormError('');
              setRequesting({
                employeeId: employees[0]?.id ?? '',
                type: 'annual',
                from: todayIso(),
                to: todayIso(),
                reason: '',
              });
            }}
            disabled={employees.length === 0}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[0.8rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
          >
            <Plus size={14} /> {t('hr.leave.request')}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-[0.8rem] text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <section aria-labelledby="leave-requests" className="space-y-2">
        <h2 id="leave-requests" className="text-[0.85rem] font-semibold text-foreground">
          {t('hr.leave.requests')}
        </h2>
        {loading ? (
          <div className="h-12 rounded-lg animate-pulse bg-[var(--surface-3)]" />
        ) : leaves.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <CalendarDays size={28} className="mx-auto mb-2 text-muted-foreground opacity-40" />
            <p className="text-[0.8rem] text-muted-foreground">{t('hr.leave.empty')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-[0.8rem]">
              <thead className="bg-[var(--surface-2)] text-left text-[0.7rem] text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('hr.leave.employee')}</th>
                  <th className="px-4 py-2 font-medium">{t('hr.leave.type')}</th>
                  <th className="px-4 py-2 font-medium">{t('hr.hol.date')}</th>
                  <th className="px-4 py-2 font-medium">{t('common.status')}</th>
                  <th className="px-4 py-2">
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {leaves.map((l) => (
                  <tr key={l.id} className="border-t border-border align-top">
                    <td className="px-4 py-2">
                      <span className="font-medium text-foreground">{l.employeeName}</span>
                      {l.reason && (
                        <span className="block text-[0.7rem] text-muted-foreground">
                          {l.reason}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">{typeLabel(l.type)}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {range(l.from, l.to)}
                      <span className="block text-[0.7rem] text-muted-foreground">
                        {t('hr.leave.days', { n: fmt.number(l.days) })}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[0.68rem] ${statusCls[l.status]}`}
                      >
                        {t(`hr.leave.status.${l.status}` as MessageKey)}
                      </span>
                      {l.paidDays > 0 && (
                        <span className="block text-[0.68rem] text-muted-foreground mt-0.5">
                          {t('hr.leave.paidDays', { n: fmt.number(l.paidDays) })}
                        </span>
                      )}
                      {l.note && (
                        <span className="block text-[0.68rem] text-muted-foreground mt-0.5">
                          {l.note}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">
                      {manage && l.status === 'pending' && (
                        <span className="inline-flex gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setFormError('');
                              setDeciding({ leave: l, action: 'approved', note: '' });
                            }}
                            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[0.75rem] font-medium text-primary-foreground max-lg:min-h-11"
                          >
                            <Check size={13} /> {t('hr.leave.approve')}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setFormError('');
                              setDeciding({ leave: l, action: 'rejected', note: '' });
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[0.75rem] text-muted-foreground hover:text-foreground max-lg:min-h-11"
                          >
                            <X size={13} /> {t('hr.leave.reject')}
                          </button>
                        </span>
                      )}
                      {manage && l.status === 'approved' && l.paidDays === 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setFormError('');
                            setDeciding({ leave: l, action: 'cancel', note: '' });
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[0.75rem] text-muted-foreground hover:text-red-600 max-lg:min-h-11"
                        >
                          {t('hr.leave.cancel')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!loading && balances.length > 0 && (
        <section aria-labelledby="leave-balances" className="space-y-2">
          <h2 id="leave-balances" className="text-[0.85rem] font-semibold text-foreground">
            {t('hr.leave.balances', { year })}
          </h2>
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-[0.8rem]">
              <thead className="bg-[var(--surface-2)] text-left text-[0.7rem] text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('hr.leave.employee')}</th>
                  <th className="px-4 py-2 font-medium text-right">{t('hr.leave.quota')}</th>
                  <th className="px-4 py-2 font-medium text-right">{t('hr.leave.used')}</th>
                  <th className="px-4 py-2 font-medium text-right">{t('hr.leave.remaining')}</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((b) => (
                  <tr key={b.employeeId} className="border-t border-border">
                    <td className="px-4 py-2 text-foreground">{b.employeeName}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt.number(b.quota)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt.number(b.used)}</td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums font-medium ${b.remaining <= 0 ? 'text-red-600 dark:text-red-400' : ''}`}
                    >
                      {fmt.number(b.remaining)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <section
          aria-labelledby="holidays"
          className="rounded-xl border border-border bg-card p-4 space-y-3"
        >
          <h2 id="holidays" className="text-[0.85rem] font-semibold text-foreground">
            {t('hr.hol.title', { year })}
          </h2>
          {holidays.length === 0 ? (
            <p className="text-[0.8rem] text-muted-foreground">{t('hr.hol.empty')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {holidays.map((h) => (
                <li
                  key={h.id}
                  className="flex items-center justify-between gap-3 py-2 text-[0.8rem]"
                >
                  <span>
                    <span className="font-medium text-foreground">{fmt.date(h.date)}</span>
                    <span className="ml-2 text-muted-foreground">{h.name}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-[0.7rem] text-muted-foreground">
                      {h.paidOut
                        ? t('hr.hol.paidOut')
                        : h.paid
                          ? t('hr.hol.paid')
                          : t('hr.hol.unpaid')}
                    </span>
                    {manage && !h.paidOut && (
                      <button
                        type="button"
                        onClick={() => void removeHoliday(h)}
                        aria-label={`${t('common.delete')}: ${h.name}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-red-600 max-lg:h-11 max-lg:w-11"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {manage && (
            <form
              onSubmit={addHoliday}
              className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
            >
              <label className="block">
                <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                  {t('hr.hol.date')}
                </span>
                <input
                  type="date"
                  required
                  value={holidayForm.date}
                  onChange={(e) => setHolidayForm({ ...holidayForm, date: e.target.value })}
                  className={inputCls}
                />
              </label>
              <label className="block flex-1 min-w-[10rem]">
                <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                  {t('hr.hol.name')}
                </span>
                <input
                  required
                  maxLength={120}
                  value={holidayForm.name}
                  onChange={(e) => setHolidayForm({ ...holidayForm, name: e.target.value })}
                  className={`${inputCls} w-full`}
                />
              </label>
              <label
                className="flex items-center gap-2 py-2 text-[0.8rem]"
                title={t('hr.hol.paidHint')}
              >
                <input
                  type="checkbox"
                  checked={holidayForm.paid}
                  onChange={(e) => setHolidayForm({ ...holidayForm, paid: e.target.checked })}
                  className="h-4 w-4 accent-[var(--primary)]"
                />
                {t('hr.hol.paid')}
              </label>
              <button
                type="submit"
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[0.8rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
              >
                <Plus size={13} /> {t('hr.hol.add')}
              </button>
              <p className="w-full text-[0.7rem] text-muted-foreground">{t('hr.hol.paidHint')}</p>
            </form>
          )}
        </section>

        <section
          aria-labelledby="work-days"
          className="rounded-xl border border-border bg-card p-4 space-y-3"
        >
          <h2 id="work-days" className="text-[0.85rem] font-semibold text-foreground">
            {t('hr.work.title')}
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d) => (
              <button
                key={d}
                type="button"
                disabled={!manage}
                aria-pressed={workDays.includes(d)}
                onClick={() => void toggleWorkDay(d)}
                className={`rounded-lg border px-3 py-1.5 text-[0.75rem] max-lg:min-h-11 ${
                  workDays.includes(d)
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border text-muted-foreground'
                } disabled:cursor-default`}
              >
                {t(`hr.day.${d}` as MessageKey)}
              </button>
            ))}
          </div>
          <p className="text-[0.7rem] text-muted-foreground">{t('hr.work.hint')}</p>
        </section>
      </div>

      {requesting && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setRequesting(null);
          }}
        >
          <form
            onSubmit={submitRequest}
            role="dialog"
            aria-modal="true"
            aria-labelledby="request-title"
            className="w-full max-w-md rounded-2xl border border-border bg-card p-5 space-y-3"
          >
            <h2 id="request-title" className="text-[1rem] font-semibold text-foreground">
              {t('hr.leave.request')}
            </h2>
            <label className="block">
              <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                {t('hr.leave.employee')}
              </span>
              <select
                required
                value={requesting.employeeId}
                onChange={(e) => setRequesting({ ...requesting, employeeId: e.target.value })}
                className={`${inputCls} w-full`}
              >
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                {t('hr.leave.type')}
              </span>
              <select
                value={requesting.type}
                onChange={(e) =>
                  setRequesting({ ...requesting, type: e.target.value as LeaveType })
                }
                className={`${inputCls} w-full`}
              >
                {TYPES.map((type) => (
                  <option key={type} value={type}>
                    {typeLabel(type)}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                  {t('hr.leave.from')}
                </span>
                <input
                  type="date"
                  required
                  value={requesting.from}
                  onChange={(e) =>
                    setRequesting({
                      ...requesting,
                      from: e.target.value,
                      to: requesting.to < e.target.value ? e.target.value : requesting.to,
                    })
                  }
                  className={`${inputCls} w-full`}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                  {t('hr.leave.to')}
                </span>
                <input
                  type="date"
                  required
                  min={requesting.from}
                  value={requesting.to}
                  onChange={(e) => setRequesting({ ...requesting, to: e.target.value })}
                  className={`${inputCls} w-full`}
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                {t('hr.leave.reason')}
              </span>
              <textarea
                rows={2}
                maxLength={500}
                value={requesting.reason}
                onChange={(e) => setRequesting({ ...requesting, reason: e.target.value })}
                className={`${inputCls} w-full`}
              />
            </label>
            {formError && (
              <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
                {formError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setRequesting(null)}
                disabled={busy}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={busy || !requesting.employeeId}
                className="flex flex-1 items-center justify-center gap-2 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                {t('hr.leave.submit')}
              </button>
            </div>
          </form>
        </div>
      )}

      {deciding && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setDeciding(null);
          }}
        >
          <form
            onSubmit={submitDecision}
            role="dialog"
            aria-modal="true"
            aria-labelledby="decide-title"
            className="w-full max-w-md rounded-2xl border border-border bg-card p-5 space-y-3"
          >
            <h2 id="decide-title" className="text-[1rem] font-semibold text-foreground">
              {t('hr.leave.decideTitle', {
                action: t(
                  deciding.action === 'approved'
                    ? 'hr.leave.approve'
                    : deciding.action === 'rejected'
                      ? 'hr.leave.reject'
                      : 'hr.leave.cancel'
                ),
                name: deciding.leave.employeeName,
              })}
            </h2>
            <p className="text-[0.8rem] text-muted-foreground">
              {typeLabel(deciding.leave.type)} · {range(deciding.leave.from, deciding.leave.to)} ·{' '}
              {t('hr.leave.days', { n: fmt.number(deciding.leave.days) })}
            </p>
            <label className="block">
              <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                {t('hr.leave.note')}
              </span>
              <textarea
                rows={2}
                maxLength={500}
                value={deciding.note}
                onChange={(e) => setDeciding({ ...deciding, note: e.target.value })}
                className={`${inputCls} w-full`}
              />
            </label>
            {formError && (
              <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
                {formError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setDeciding(null)}
                disabled={busy}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={busy}
                className={`flex flex-1 items-center justify-center gap-2 py-2 rounded-lg text-[0.8rem] font-medium disabled:opacity-50 ${
                  deciding.action === 'approved'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-red-600 text-white'
                }`}
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                {t(
                  deciding.action === 'approved'
                    ? 'hr.leave.approve'
                    : deciding.action === 'rejected'
                      ? 'hr.leave.reject'
                      : 'hr.leave.cancel'
                )}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
