'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Gavel, HardDrive, KeyRound, Loader2, Power } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useAdmin } from './AdminShell';
import { adminChange, adminGet } from './api';
import { errorKey } from './labels';
import { Badge, Facts, Section, buttonCls, fieldCls, rowCls, tableCls, theadCls } from './ui';

interface Storage {
  quota_bytes: number | null;
  custom_quota: boolean;
  unlimited: boolean;
  used_bytes: number;
  used_datasets: number;
  used_files: number;
  used_erp_estimate: number;
  reserved_bytes: number;
  max_upload_bytes: number;
  storage_dir: string | null;
  measured_at: string | null;
  requests: {
    id: string;
    message: string;
    created_at: string;
    requested_by_email: string | null;
    handled_at: string | null;
  }[];
}
interface Termination {
  state: 'export_available' | 'deleting' | 'deleted' | 'cancelled';
  reason: string;
  started_at: string;
  export_until: string;
  started_by_email: string | null;
  confirmed_at: string | null;
  deleted_at: string | null;
  deletion_summary: Record<string, number> | null;
  legal_hold: boolean;
}
interface StaffSession {
  id: string;
  admin_email: string | null;
  reason: string;
  ticket_ref: string;
  starts_at: string;
  ends_at: string;
  ended_at: string | null;
  live: boolean;
}
interface Hold {
  id: string;
  reason: string;
  set_by_email: string | null;
  set_at: string;
  until: string | null;
  released_at: string | null;
}
interface Data {
  storage: Storage;
  termination: Termination | null;
  sessions: StaffSession[];
  holds: Hold[];
}

const GB = 1024 ** 3;
export const formatBytes = (n: number | null | undefined) => {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

/** Storage, staff access, legal holds and termination of one company (workspace). */
export function GovernancePanels({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const { t, fmt } = useI18n();
  const { role, confirmIdentity } = useAdmin();
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [quotaGb, setQuotaGb] = useState('');
  const [unlimited, setUnlimited] = useState(false);
  const [uploadMb, setUploadMb] = useState('');
  const [quotaReason, setQuotaReason] = useState('');
  const [staffReason, setStaffReason] = useState('');
  const [staffTicket, setStaffTicket] = useState('');
  const [staffHours, setStaffHours] = useState(2);
  const [holdReason, setHoldReason] = useState('');
  const [holdUntil, setHoldUntil] = useState('');
  const [termReason, setTermReason] = useState('');
  const [graceDays, setGraceDays] = useState(30);
  const [confirmName, setConfirmName] = useState('');
  const when = (v: string | null) => fmt.date(v, { dateStyle: 'medium', timeStyle: 'short' });
  const url = `/api/admin/platform/workspaces/${workspaceId}/governance`;

  const load = useCallback(async () => {
    const r = await adminGet<Data>(url);
    if (r.ok) {
      setData(r.data);
      const s = r.data.storage;
      setUnlimited(s.unlimited);
      setQuotaGb(s.custom_quota && s.quota_bytes ? String(+(s.quota_bytes / GB).toFixed(2)) : '');
    }
  }, [url]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>, done: Parameters<typeof t>[0]) {
    setBusy(true);
    const r = await adminChange<{ emailed?: string }>(confirmIdentity, url, body);
    setBusy(false);
    if (!r.ok) {
      if (r.error !== 'cancelled') toast.error(t(errorKey(r.error)));
      return false;
    }
    toast.success(t(done));
    if (r.data?.emailed === 'failed') toast.warning(t('gov.ownerNotEmailed'));
    await load();
    return true;
  }

  if (!data) return <Loader2 size={16} className="animate-spin text-muted-foreground" />;
  const s = data.storage;
  const pct = s.quota_bytes
    ? Math.min(100, Math.round((100 * s.used_bytes) / s.quota_bytes))
    : null;
  const term = data.termination;
  const liveTerm = term && term.state !== 'cancelled';
  const isSuper = role === 'super_admin';
  const isOfficer = role === 'security_officer';

  return (
    <div className="space-y-5">
      <Section title={t('gov.storage')} icon={HardDrive}>
        <div className="space-y-3 px-5 py-4">
          <div>
            <div className="flex justify-between text-[0.78rem]">
              <span className="text-foreground">
                {formatBytes(s.used_bytes)}{' '}
                {s.quota_bytes ? `/ ${formatBytes(s.quota_bytes)}` : `· ${t('gov.unlimited')}`}
              </span>
              {pct !== null && <span className="text-muted-foreground">{pct}%</span>}
            </div>
            {pct !== null && (
              <div className="mt-1 h-2 overflow-hidden rounded bg-muted">
                <div
                  className={`h-full ${pct >= 90 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </div>
          <Facts
            items={[
              [t('gov.usedDatasets'), formatBytes(s.used_datasets)],
              [t('gov.usedFiles'), formatBytes(s.used_files)],
              [t('gov.usedErp'), `≈ ${formatBytes(s.used_erp_estimate)}`],
              [t('gov.reserved'), formatBytes(s.reserved_bytes)],
              [t('gov.maxUpload'), formatBytes(s.max_upload_bytes)],
              [t('gov.storageDir'), s.storage_dir ?? t('gov.storageDirDefault')],
              [t('gov.measuredAt'), when(s.measured_at)],
            ]}
          />
          {s.requests
            .filter((r) => !r.handled_at)
            .map((r) => (
              <p
                key={r.id}
                className="rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-[0.75rem] text-amber-800 dark:bg-amber-950/20 dark:text-amber-300"
              >
                {t('gov.request', { email: r.requested_by_email ?? '—', date: when(r.created_at) })}
                : {r.message}
              </p>
            ))}
          {isSuper && (
            <form
              className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end"
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await act(
                    {
                      action: 'set_quota',
                      quotaGb: unlimited ? null : quotaGb,
                      unlimited,
                      maxUploadMb: uploadMb || null,
                      reason: quotaReason,
                    },
                    'gov.quotaSaved'
                  )
                )
                  setQuotaReason('');
              }}
            >
              <label className="block space-y-1">
                <span className="text-[0.7rem] text-muted-foreground">{t('gov.quotaGb')}</span>
                <input
                  className={`${fieldCls} w-full`}
                  inputMode="decimal"
                  disabled={unlimited}
                  value={quotaGb}
                  placeholder={t('gov.platformDefault')}
                  onChange={(e) => setQuotaGb(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[0.7rem] text-muted-foreground">{t('gov.uploadMb')}</span>
                <input
                  className={`${fieldCls} w-full`}
                  inputMode="numeric"
                  value={uploadMb}
                  placeholder={t('gov.platformDefault')}
                  onChange={(e) => setUploadMb(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[0.7rem] text-muted-foreground">
                  {t('padmin.users.reason')}
                </span>
                <input
                  className={`${fieldCls} w-full`}
                  required
                  minLength={3}
                  maxLength={500}
                  value={quotaReason}
                  onChange={(e) => setQuotaReason(e.target.value)}
                />
              </label>
              <button type="submit" disabled={busy} className={buttonCls}>
                {t('gov.saveQuota')}
              </button>
              <label className="flex items-center gap-2 text-[0.75rem] text-foreground sm:col-span-4">
                <input
                  type="checkbox"
                  checked={unlimited}
                  onChange={(e) => setUnlimited(e.target.checked)}
                />
                {t('gov.noLimit')}
              </label>
            </form>
          )}
        </div>
      </Section>

      <Section title={t('gov.staffAccess')} icon={KeyRound}>
        <div className="space-y-3 px-5 py-4">
          <p className="text-[0.75rem] text-muted-foreground">{t('gov.staffIntro')}</p>
          {isSuper && (
            <form
              className="grid gap-2 sm:grid-cols-[2fr_1fr_auto_auto] sm:items-end"
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await act(
                    {
                      action: 'start_staff',
                      reason: staffReason,
                      ticket: staffTicket,
                      hours: staffHours,
                    },
                    'gov.staffStarted'
                  )
                ) {
                  setStaffReason('');
                  setStaffTicket('');
                }
              }}
            >
              <label className="block space-y-1">
                <span className="text-[0.7rem] text-muted-foreground">{t('gov.staffReason')}</span>
                <input
                  className={`${fieldCls} w-full`}
                  required
                  minLength={10}
                  maxLength={500}
                  value={staffReason}
                  onChange={(e) => setStaffReason(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[0.7rem] text-muted-foreground">{t('gov.ticket')}</span>
                <input
                  className={`${fieldCls} w-full`}
                  required
                  maxLength={100}
                  value={staffTicket}
                  onChange={(e) => setStaffTicket(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[0.7rem] text-muted-foreground">{t('gov.hours')}</span>
                <select
                  className={fieldCls}
                  value={staffHours}
                  onChange={(e) => setStaffHours(Number(e.target.value))}
                >
                  {[1, 2, 4, 8].map((h) => (
                    <option key={h} value={h}>
                      {t('gov.hoursN', { n: h })}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={busy} className={buttonCls}>
                {t('gov.openAsStaff')}
              </button>
            </form>
          )}
          {data.sessions.length > 0 && (
            <table className={tableCls}>
              <thead className={theadCls}>
                <tr>
                  <th className="py-2 font-medium">{t('gov.admin')}</th>
                  <th className="px-2 py-2 font-medium">{t('gov.staffReason')}</th>
                  <th className="px-2 py-2 font-medium">{t('gov.window')}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((x) => (
                  <tr key={x.id} className={rowCls}>
                    <td className="py-2">{x.admin_email}</td>
                    <td className="px-2 py-2 text-muted-foreground">
                      {x.reason} · {x.ticket_ref}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">
                      {when(x.starts_at)} → {when(x.ended_at ?? x.ends_at)}
                    </td>
                    <td className="py-2 text-right">
                      {x.live ? (
                        isSuper ? (
                          <button
                            type="button"
                            className={buttonCls}
                            disabled={busy}
                            onClick={() =>
                              void act({ action: 'end_staff', sessionId: x.id }, 'gov.staffEnded')
                            }
                          >
                            {t('gov.end')}
                          </button>
                        ) : (
                          <Badge tone="warn">{t('gov.live')}</Badge>
                        )
                      ) : (
                        <Badge>{t('gov.ended')}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Section>

      <Section title={t('gov.legalHolds')} icon={Gavel}>
        <div className="space-y-3 px-5 py-4">
          <p className="text-[0.75rem] text-muted-foreground">{t('gov.holdIntro')}</p>
          {data.holds.map((h) => (
            <div
              key={h.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-[0.75rem]"
            >
              <span>
                {h.reason} · {h.set_by_email} · {when(h.set_at)}
                {h.until ? ` · ${t('gov.until', { date: h.until })}` : ''}
              </span>
              {h.released_at ? (
                <Badge>{t('gov.released')}</Badge>
              ) : isOfficer ? (
                <button
                  type="button"
                  className={buttonCls}
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt(t('gov.releaseReason'));
                    if (reason)
                      void act(
                        { action: 'release_hold', holdId: h.id, reason },
                        'gov.holdReleased'
                      );
                  }}
                >
                  {t('gov.release')}
                </button>
              ) : (
                <Badge tone="warn">{t('gov.onHold')}</Badge>
              )}
            </div>
          ))}
          {isOfficer && (
            <form
              className="grid gap-2 sm:grid-cols-[2fr_1fr_auto] sm:items-end"
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await act(
                    { action: 'set_hold', reason: holdReason, until: holdUntil || null },
                    'gov.holdSet'
                  )
                ) {
                  setHoldReason('');
                  setHoldUntil('');
                }
              }}
            >
              <label className="block space-y-1">
                <span className="text-[0.7rem] text-muted-foreground">{t('gov.holdReason')}</span>
                <input
                  className={`${fieldCls} w-full`}
                  required
                  minLength={10}
                  maxLength={500}
                  value={holdReason}
                  onChange={(e) => setHoldReason(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[0.7rem] text-muted-foreground">{t('gov.holdUntil')}</span>
                <input
                  type="date"
                  className={`${fieldCls} w-full`}
                  value={holdUntil}
                  onChange={(e) => setHoldUntil(e.target.value)}
                />
              </label>
              <button type="submit" disabled={busy} className={buttonCls}>
                {t('gov.setHold')}
              </button>
            </form>
          )}
        </div>
      </Section>

      <Section title={t('gov.termination')} icon={Power}>
        <div className="space-y-3 px-5 py-4">
          {liveTerm ? (
            <>
              <Facts
                items={[
                  [t('gov.termState'), t(`gov.state.${term.state}`)],
                  [t('gov.termReason'), term.reason],
                  [
                    t('gov.termStarted'),
                    `${when(term.started_at)} · ${term.started_by_email ?? ''}`,
                  ],
                  [t('gov.exportUntil'), when(term.export_until)],
                  ...(term.deleted_at
                    ? ([[t('gov.deletedAt'), when(term.deleted_at)]] as [string, React.ReactNode][])
                    : []),
                ]}
              />
              {term.legal_hold && (
                <p className="text-[0.75rem] text-amber-700 dark:text-amber-400">
                  {t('gov.termOnHold')}
                </p>
              )}
              {term.state === 'export_available' && isSuper && (
                <button
                  type="button"
                  className={buttonCls}
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt(t('gov.cancelReason'));
                    if (reason)
                      void act({ action: 'cancel_termination', reason }, 'gov.termCancelled');
                  }}
                >
                  {t('gov.cancelTermination')}
                </button>
              )}
              {term.state === 'export_available' && isOfficer && (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await act({ action: 'confirm_termination', confirmName }, 'gov.termConfirmed')
                    )
                      setConfirmName('');
                  }}
                >
                  <label className="block flex-1 space-y-1">
                    <span className="text-[0.7rem] text-muted-foreground">
                      {t('gov.typeName', { name: workspaceName })}
                    </span>
                    <input
                      className={`${fieldCls} w-full`}
                      value={confirmName}
                      onChange={(e) => setConfirmName(e.target.value)}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy || confirmName !== workspaceName}
                    className="rounded-lg bg-red-600 px-3 py-2 text-[0.78rem] font-medium text-white disabled:opacity-50"
                  >
                    {t('gov.confirmDeletion')}
                  </button>
                </form>
              )}
              {term.deletion_summary && (
                <p className="text-[0.72rem] text-muted-foreground">
                  {Object.entries(term.deletion_summary)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-[0.75rem] text-muted-foreground">{t('gov.termIntro')}</p>
              {isSuper && (
                <form
                  className="grid gap-2 sm:grid-cols-[2fr_auto_auto] sm:items-end"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!window.confirm(t('gov.termConfirmStart', { name: workspaceName }))) return;
                    if (
                      await act(
                        { action: 'terminate', reason: termReason, graceDays },
                        'gov.termStartedDone'
                      )
                    )
                      setTermReason('');
                  }}
                >
                  <label className="block space-y-1">
                    <span className="text-[0.7rem] text-muted-foreground">
                      {t('gov.termReason')}
                    </span>
                    <input
                      className={`${fieldCls} w-full`}
                      required
                      minLength={10}
                      maxLength={500}
                      value={termReason}
                      onChange={(e) => setTermReason(e.target.value)}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[0.7rem] text-muted-foreground">
                      {t('gov.graceDays')}
                    </span>
                    <input
                      type="number"
                      min={7}
                      max={90}
                      className={`${fieldCls} w-24`}
                      value={graceDays}
                      onChange={(e) => setGraceDays(Number(e.target.value))}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-lg border border-red-300 px-3 py-2 text-[0.78rem] text-red-600 dark:text-red-400"
                  >
                    {t('gov.startTermination')}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </Section>
    </div>
  );
}
