'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Clock, LogIn, LogOut, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useWorkspace } from '../../lib/WorkspaceContext';
import type { WorkspaceRole } from '../../lib/erpRules';
import {
  ATTENDANCE_ROLE_CHOICES,
  HrError,
  hrService,
  splitMinutes,
  type TodayRow,
} from '../../lib/hrService';

function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
}

function AttendanceAccess() {
  const { t } = useI18n();
  const { hr, refreshHr } = useWorkspace();
  const [roles, setRoles] = useState<WorkspaceRole[]>(hr.attendanceRoles);
  const [saving, setSaving] = useState(false);
  useEffect(() => setRoles(hr.attendanceRoles), [hr.attendanceRoles]);
  const changed =
    roles.length !== hr.attendanceRoles.length ||
    roles.some((r) => !hr.attendanceRoles.includes(r));

  async function save() {
    setSaving(true);
    try {
      await hrService.setAttendanceRoles(roles);
      toast.success(t('hr.access.saved'));
      refreshHr();
    } catch (error) {
      toast.error(t(error instanceof HrError ? error.key : 'hr.err.failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="rounded-xl border border-border bg-card p-4 space-y-3"
      aria-labelledby="attendance-access"
    >
      <div className="flex items-start gap-2">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <div>
          <h2 id="attendance-access" className="text-[0.85rem] font-semibold text-foreground">
            {t('hr.access.title')}
          </h2>
          <p className="text-[0.75rem] text-muted-foreground">{t('hr.access.help')}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {(['owner', 'admin'] as const).map((role) => (
          <span
            key={role}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-[var(--surface-2)] px-3 py-1.5 text-[0.78rem] text-muted-foreground"
          >
            <input type="checkbox" checked disabled aria-label={t(`role.${role}` as MessageKey)} />{' '}
            {t(`role.${role}` as MessageKey)}
          </span>
        ))}
        {ATTENDANCE_ROLE_CHOICES.map((role) => (
          <label
            key={role}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[0.78rem] text-foreground hover:bg-[var(--surface-3)] max-lg:min-h-11"
          >
            <input
              type="checkbox"
              checked={roles.includes(role)}
              onChange={(e) =>
                setRoles((current) =>
                  e.target.checked ? [...current, role] : current.filter((r) => r !== role)
                )
              }
            />
            {t(`role.${role}` as MessageKey)}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!changed || saving}
          className="rounded-lg bg-primary px-3 py-1.5 text-[0.78rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <p className="text-[0.7rem] text-muted-foreground">{t('hr.access.payNote')}</p>
      </div>
    </section>
  );
}

export default function AttendancePage() {
  const { t, fmt } = useI18n();
  const { active, hr, hrReady } = useWorkspace();
  const [rows, setRows] = useState<TodayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setRows(await hrService.today());
    } catch (error) {
      toast.error(t(error instanceof HrError ? error.key : 'hr.err.failed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!hrReady) return;
    setLoading(true);
    void load();
  }, [hrReady, active?.id, load]);

  // Running times tick every minute; the list itself refreshes every two.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    const refresh = setInterval(() => void load(), 120_000);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, [load]);

  async function act(row: TodayRow, kind: 'in' | 'out') {
    setBusy(row.employeeId);
    try {
      if (kind === 'in') await hrService.clockIn(row.employeeId);
      else await hrService.clockOut(row.employeeId);
      toast.success(
        t(kind === 'in' ? 'hr.att.clockedIn' : 'hr.att.clockedOut', { name: row.name })
      );
      setNow(Date.now());
      await load();
    } catch (error) {
      toast.error(t(error instanceof HrError ? error.key : 'hr.err.failed'));
    } finally {
      setBusy(null);
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? rows.filter((r) =>
          [r.name, r.employeeCode, r.position].some((v) => v.toLowerCase().includes(q))
        )
      : rows;
  }, [rows, query]);

  const working = rows.filter((r) => r.clockIn && !r.clockOut).length;
  const done = rows.filter((r) => r.clockOut).length;
  const duration = (minutes: number) => t('hr.duration', splitMinutes(minutes));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('erp.nav.attendance')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">
            {fmt.date(new Date(now), {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}{' '}
            · {fmt.time(new Date(now))}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/erp/hr/history"
            className="rounded-lg border border-border px-3 py-2 text-[0.78rem] text-foreground hover:bg-[var(--surface-3)] max-lg:min-h-11"
          >
            {t('erp.nav.attendanceHistory')}
          </Link>
          <button
            type="button"
            onClick={() => void load()}
            title={t('common.refresh')}
            aria-label={t('common.refresh')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {hr.canConfigure && <AttendanceAccess />}

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: t('hr.att.total'), value: rows.length },
          { label: t('hr.att.working'), value: working },
          { label: t('hr.att.done'), value: done },
        ].map((card) => (
          <div key={card.label} className="rounded-xl border border-border bg-card px-4 py-3">
            <p className="text-[0.7rem] text-muted-foreground">{card.label}</p>
            <p className="text-[1.25rem] font-semibold tabular-nums text-foreground">
              {fmt.number(card.value)}
            </p>
          </div>
        ))}
      </div>

      <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 sm:max-w-xs">
        <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('hr.emp.searchPlaceholder')}
          aria-label={t('hr.emp.searchPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-[0.8rem] text-foreground outline-none"
        />
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-lg animate-pulse bg-[var(--surface-3)]" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center">
          <Clock size={32} className="mx-auto text-muted-foreground mb-3 opacity-40" />
          <p className="text-[0.85rem] text-foreground font-medium mb-1">{t('hr.att.empty')}</p>
          {hr.canManage && (
            <Link
              href="/erp/hr/employees"
              className="text-[0.78rem] text-foreground underline underline-offset-2"
            >
              {t('hr.emp.add')}
            </Link>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {shown.map((row) => {
            const open = !!row.clockIn && !row.clockOut;
            const earlierDay =
              open &&
              row.workDate &&
              row.clockIn &&
              new Date(row.clockIn).toDateString() !== new Date(now).toDateString();
            const worked =
              open && row.clockIn ? minutesSince(row.clockIn, now) : (row.workedMinutes ?? 0);
            return (
              <li key={row.employeeId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.85rem] font-medium text-foreground">{row.name}</p>
                  <p className="truncate text-[0.72rem] text-muted-foreground">
                    {[row.employeeCode, row.position].filter(Boolean).join(' · ') || '—'}
                  </p>
                </div>
                <div className="min-w-[10rem] text-[0.75rem]">
                  {!row.clockIn ? (
                    <span className="text-muted-foreground">{t('hr.att.notIn')}</span>
                  ) : open ? (
                    <span className="text-green-700 dark:text-green-400">
                      {t('hr.att.workingSince', {
                        time: earlierDay ? fmt.dateTime(row.clockIn) : fmt.time(row.clockIn),
                      })}{' '}
                      · {duration(worked)}
                    </span>
                  ) : (
                    <span className="text-foreground">
                      {fmt.time(row.clockIn)}–{fmt.time(row.clockOut)} · {duration(worked)}
                      {(row.overtimeMinutes ?? 0) > 0 && (
                        <span className="ml-1 text-amber-700 dark:text-amber-400">
                          {t('hr.att.overtime', { duration: duration(row.overtimeMinutes ?? 0) })}
                        </span>
                      )}
                    </span>
                  )}
                </div>
                {!row.clockIn ? (
                  <button
                    type="button"
                    disabled={busy === row.employeeId}
                    onClick={() => void act(row, 'in')}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[0.78rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
                  >
                    <LogIn size={14} /> {t('hr.att.in')}
                  </button>
                ) : open ? (
                  <button
                    type="button"
                    disabled={busy === row.employeeId}
                    onClick={() => void act(row, 'out')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[0.78rem] font-medium text-foreground hover:bg-[var(--surface-3)] disabled:opacity-50 max-lg:min-h-11"
                  >
                    <LogOut size={14} /> {t('hr.att.out')}
                  </button>
                ) : (
                  <span className="rounded-full bg-[var(--surface-3)] px-2.5 py-1 text-[0.7rem] text-muted-foreground">
                    {t('hr.att.finished')}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
