'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, History, Loader2, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { csvCell } from '@/lib/csv';
import { useWorkspace } from '../../lib/WorkspaceContext';
import {
  HrError,
  currentMonthRange,
  hrService,
  splitMinutes,
  toLocalInput,
  type AttendanceRow,
  type Employee,
} from '../../lib/hrService';

interface Summary {
  employeeId: string;
  name: string;
  days: number;
  worked: number;
  overtime: number;
  regularPay: number;
  overtimePay: number;
}

const inputCls =
  'rounded-lg border border-border bg-card px-3 py-2 text-[0.8rem] text-foreground outline-none focus:border-foreground/40';

export default function AttendanceHistoryPage() {
  const { t, fmt } = useI18n();
  const { active, hr, hrReady } = useWorkspace();
  const [range, setRange] = useState(currentMonthRange);
  const [employeeId, setEmployeeId] = useState('');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{
    row: AttendanceRow;
    clockIn: string;
    clockOut: string;
    reason: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const pay = hr.canManage;

  const errorText = useCallback(
    (err: unknown) => t(err instanceof HrError ? err.key : 'hr.err.failed'),
    [t]
  );

  const load = useCallback(async () => {
    setError('');
    try {
      setRows(await hrService.history(range.from, range.to, employeeId || null));
    } catch (err) {
      setRows([]);
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [range, employeeId, errorText]);

  useEffect(() => {
    if (!hrReady) return;
    setLoading(true);
    void load();
  }, [hrReady, active?.id, load]);

  useEffect(() => {
    if (!hrReady) return;
    hrService
      .employees(true)
      .then(setEmployees)
      .catch(() => setEmployees([]));
  }, [hrReady, active?.id]);

  const summary = useMemo<Summary[]>(() => {
    const byEmployee = new Map<string, Summary>();
    for (const r of rows) {
      const s = byEmployee.get(r.employeeId) ?? {
        employeeId: r.employeeId,
        name: r.employeeName,
        days: 0,
        worked: 0,
        overtime: 0,
        regularPay: 0,
        overtimePay: 0,
      };
      s.days += 1;
      s.worked += r.workedMinutes ?? 0;
      s.overtime += r.overtimeMinutes ?? 0;
      s.regularPay += r.regularPay ?? 0;
      s.overtimePay += r.overtimePay ?? 0;
      byEmployee.set(r.employeeId, s);
    }
    return [...byEmployee.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const totals = summary.reduce(
    (acc, s) => ({
      worked: acc.worked + s.worked,
      overtime: acc.overtime + s.overtime,
      regularPay: acc.regularPay + s.regularPay,
      overtimePay: acc.overtimePay + s.overtimePay,
    }),
    { worked: 0, overtime: 0, regularPay: 0, overtimePay: 0 }
  );

  const duration = (minutes: number | null) =>
    minutes === null ? '—' : t('hr.duration', splitMinutes(minutes));
  const hours = (minutes: number | null) =>
    minutes === null ? '' : Math.round((minutes / 60) * 100) / 100;

  function exportCsv() {
    const header = [
      t('hr.hist.date'),
      t('hr.emp.code'),
      t('hr.emp.name'),
      t('hr.hist.in'),
      t('hr.hist.out'),
      t('hr.hist.workedHours'),
      t('hr.hist.overtimeHours'),
      ...(pay
        ? [
            t('hr.emp.hourlyRate'),
            t('hr.emp.overtimeRate'),
            t('hr.hist.regularPay'),
            t('hr.hist.overtimePay'),
            t('hr.hist.totalPay'),
          ]
        : []),
      t('hr.hist.note'),
      t('hr.hist.correction'),
    ];
    const lines = rows.map((r) => [
      r.workDate,
      r.employeeCode,
      r.employeeName,
      r.clockIn,
      r.clockOut ?? '',
      hours(r.workedMinutes),
      hours(r.overtimeMinutes),
      ...(pay
        ? [
            r.hourlyRate ?? '',
            r.overtimeRate ?? '',
            r.regularPay ?? '',
            r.overtimePay ?? '',
            r.regularPay === null
              ? ''
              : Math.round(((r.regularPay ?? 0) + (r.overtimePay ?? 0)) * 100) / 100,
          ]
        : []),
      r.note,
      r.correctionReason,
    ]);
    const csv = [header, ...lines].map((line) => line.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `attendance-${range.from}-${range.to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function saveCorrection(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || saving) return;
    setSaving(true);
    setEditError('');
    try {
      const clockIn = new Date(editing.clockIn);
      const clockOut = editing.clockOut ? new Date(editing.clockOut) : null;
      if (Number.isNaN(clockIn.getTime()) || (clockOut && Number.isNaN(clockOut.getTime())))
        throw new HrError('hr.err.times');
      await hrService.correct(
        editing.row.id,
        clockIn.toISOString(),
        clockOut ? clockOut.toISOString() : null,
        editing.reason.trim()
      );
      toast.success(t('hr.hist.corrected'));
      setEditing(null);
      await load();
    } catch (err) {
      setEditError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">
            {t('erp.nav.attendanceHistory')}
          </h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">
            {t(pay ? 'hr.hist.subtitlePay' : 'hr.hist.subtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[0.8rem] text-foreground hover:bg-[var(--surface-3)] disabled:opacity-50 max-lg:min-h-11"
        >
          <Download size={14} /> {t('common.export')}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-[0.7rem] text-muted-foreground">
            {t('hr.hist.from')}
          </span>
          <input
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[0.7rem] text-muted-foreground">{t('hr.hist.to')}</span>
          <input
            type="date"
            value={range.to}
            min={range.from}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
            className={inputCls}
          />
        </label>
        <label className="block min-w-[12rem]">
          <span className="mb-1 block text-[0.7rem] text-muted-foreground">
            {t('hr.hist.employee')}
          </span>
          <select
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className={`${inputCls} w-full`}
          >
            <option value="">{t('common.all')}</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <p className="text-[0.8rem] text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 rounded-lg animate-pulse bg-[var(--surface-3)]" />
          ))}
        </div>
      ) : rows.length === 0 && !error ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center">
          <History size={32} className="mx-auto text-muted-foreground mb-3 opacity-40" />
          <p className="text-[0.8rem] text-muted-foreground">{t('hr.hist.empty')}</p>
        </div>
      ) : rows.length > 0 ? (
        <>
          <section aria-labelledby="overtime-summary" className="space-y-2">
            <h2 id="overtime-summary" className="text-[0.85rem] font-semibold text-foreground">
              {t('hr.hist.summary')}
            </h2>
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full text-[0.8rem]">
                <thead className="bg-[var(--surface-2)] text-left text-[0.7rem] text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('hr.emp.name')}</th>
                    <th className="px-4 py-2 font-medium text-right">{t('hr.hist.days')}</th>
                    <th className="px-4 py-2 font-medium text-right">{t('hr.hist.worked')}</th>
                    <th className="px-4 py-2 font-medium text-right">{t('hr.hist.overtime')}</th>
                    {pay && (
                      <th className="px-4 py-2 font-medium text-right">
                        {t('hr.hist.regularPay')}
                      </th>
                    )}
                    {pay && (
                      <th className="px-4 py-2 font-medium text-right">
                        {t('hr.hist.overtimePay')}
                      </th>
                    )}
                    {pay && (
                      <th className="px-4 py-2 font-medium text-right">{t('hr.hist.totalPay')}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {summary.map((s) => (
                    <tr key={s.employeeId} className="border-t border-border">
                      <td className="px-4 py-2 font-medium text-foreground">{s.name}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmt.number(s.days)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{duration(s.worked)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-amber-700 dark:text-amber-400">
                        {duration(s.overtime)}
                      </td>
                      {pay && (
                        <td className="px-4 py-2 text-right tabular-nums">
                          {fmt.money(s.regularPay)}
                        </td>
                      )}
                      {pay && (
                        <td className="px-4 py-2 text-right tabular-nums">
                          {fmt.money(s.overtimePay)}
                        </td>
                      )}
                      {pay && (
                        <td className="px-4 py-2 text-right tabular-nums font-medium">
                          {fmt.money(s.regularPay + s.overtimePay)}
                        </td>
                      )}
                    </tr>
                  ))}
                  <tr className="border-t border-border bg-[var(--surface-2)] font-semibold">
                    <td className="px-4 py-2">{t('hr.hist.total')}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt.number(rows.length)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{duration(totals.worked)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {duration(totals.overtime)}
                    </td>
                    {pay && (
                      <td className="px-4 py-2 text-right tabular-nums">
                        {fmt.money(totals.regularPay)}
                      </td>
                    )}
                    {pay && (
                      <td className="px-4 py-2 text-right tabular-nums">
                        {fmt.money(totals.overtimePay)}
                      </td>
                    )}
                    {pay && (
                      <td className="px-4 py-2 text-right tabular-nums">
                        {fmt.money(totals.regularPay + totals.overtimePay)}
                      </td>
                    )}
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="attendance-log" className="space-y-2">
            <h2 id="attendance-log" className="text-[0.85rem] font-semibold text-foreground">
              {t('hr.hist.log')}
            </h2>
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full text-[0.8rem]">
                <thead className="bg-[var(--surface-2)] text-left text-[0.7rem] text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('hr.hist.date')}</th>
                    <th className="px-4 py-2 font-medium">{t('hr.emp.name')}</th>
                    <th className="px-4 py-2 font-medium">{t('hr.hist.in')}</th>
                    <th className="px-4 py-2 font-medium">{t('hr.hist.out')}</th>
                    <th className="px-4 py-2 font-medium text-right">{t('hr.hist.worked')}</th>
                    <th className="px-4 py-2 font-medium text-right">{t('hr.hist.overtime')}</th>
                    {pay && (
                      <th className="px-4 py-2 font-medium text-right">{t('hr.hist.totalPay')}</th>
                    )}
                    {pay && (
                      <th className="px-4 py-2">
                        <span className="sr-only">{t('common.actions')}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-4 py-2 whitespace-nowrap">{fmt.date(r.workDate)}</td>
                      <td className="px-4 py-2">
                        <span className="text-foreground">{r.employeeName}</span>
                        {r.corrected && (
                          <span
                            className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[0.62rem] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                            title={r.correctionReason}
                          >
                            {t('hr.hist.correctedBadge')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                        {fmt.time(r.clockIn)}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                        {r.clockOut ? (
                          fmt.time(r.clockOut)
                        ) : (
                          <span className="text-green-700 dark:text-green-400">
                            {t('hr.hist.stillIn')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {duration(r.workedMinutes)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-amber-700 dark:text-amber-400">
                        {(r.overtimeMinutes ?? 0) > 0 ? duration(r.overtimeMinutes) : '—'}
                      </td>
                      {pay && (
                        <td className="px-4 py-2 text-right tabular-nums">
                          {r.regularPay === null
                            ? '—'
                            : fmt.money((r.regularPay ?? 0) + (r.overtimePay ?? 0))}
                        </td>
                      )}
                      {pay && (
                        <td className="px-2 py-1 text-right">
                          <button
                            type="button"
                            title={t('hr.hist.correct')}
                            aria-label={t('hr.hist.correct')}
                            onClick={() => {
                              setEditError('');
                              setEditing({
                                row: r,
                                clockIn: toLocalInput(r.clockIn),
                                clockOut: toLocalInput(r.clockOut),
                                reason: '',
                              });
                            }}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11"
                          >
                            <Pencil size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {editing && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setEditing(null);
          }}
        >
          <form
            onSubmit={saveCorrection}
            role="dialog"
            aria-modal="true"
            aria-labelledby="correct-title"
            className="w-full max-w-md rounded-2xl border border-border bg-card p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 id="correct-title" className="text-[1rem] font-semibold text-foreground">
                {t('hr.hist.correctTitle', { name: editing.row.employeeName })}
              </h2>
              <button
                type="button"
                onClick={() => setEditing(null)}
                aria-label={t('common.close')}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            <label className="block">
              <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                {t('hr.hist.in')}
              </span>
              <input
                type="datetime-local"
                required
                value={editing.clockIn}
                onChange={(e) => setEditing({ ...editing, clockIn: e.target.value })}
                className={`${inputCls} w-full`}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                {t('hr.hist.out')}
              </span>
              <input
                type="datetime-local"
                value={editing.clockOut}
                onChange={(e) => setEditing({ ...editing, clockOut: e.target.value })}
                className={`${inputCls} w-full`}
              />
              <span className="mt-1 block text-[0.7rem] text-muted-foreground">
                {t('hr.hist.outHint')}
              </span>
            </label>
            <label className="block">
              <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                {t('hr.hist.reason')}
              </span>
              <textarea
                required
                minLength={5}
                maxLength={500}
                rows={2}
                value={editing.reason}
                onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
                className={`${inputCls} w-full`}
              />
            </label>
            {editError && (
              <p className="text-[0.78rem] text-red-600 dark:text-red-400" role="alert">
                {editError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={saving || editing.reason.trim().length < 5}
                className="flex flex-1 items-center justify-center gap-2 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
              >
                {saving && <Loader2 size={13} className="animate-spin" />}
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
