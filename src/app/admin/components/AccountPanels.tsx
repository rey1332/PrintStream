'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Building2, KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useAdmin } from './AdminShell';
import { adminChange, adminExport, adminGet } from './api';
import { EVENT_LABEL, errorKey } from './labels';
import type { SecurityEvent } from './SecurityLogTable';
import { Badge, Section, buttonCls, fieldCls, rowCls, tableCls, theadCls } from './ui';

interface Limit {
  limit: number;
  default: number;
  custom: boolean;
  used: number;
  unlimited: boolean;
}

/** Account page: how many ERPs the account may belong to (super admin changes it). */
export function AccountLimitPanel({ userId }: { userId: string }) {
  const { t } = useI18n();
  const { role, confirmIdentity } = useAdmin();
  const [limit, setLimit] = useState<Limit | null>(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await adminGet<Limit>(`/api/admin/platform/users/${userId}/limit`);
    if (result.ok) setLimit(result.data);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    const result = await adminChange(confirmIdentity, `/api/admin/platform/users/${userId}/limit`, {
      limit: value.trim() === '' ? null : Number(value),
      reason: reason.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      if (result.error !== 'cancelled') toast.error(t(errorKey(result.error)));
      return;
    }
    toast.success(t('padmin.limit.saved'));
    setValue('');
    setReason('');
    await load();
  }

  return (
    <Section title={t('padmin.limit.title')} icon={Building2}>
      <div className="space-y-3 px-5 py-4">
        {!limit ? (
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        ) : limit.unlimited ? (
          <p className="text-[0.8rem] text-muted-foreground">{t('padmin.limit.unlimited')}</p>
        ) : (
          <p className="text-[0.8rem] text-foreground">
            {t('padmin.limit.value', { limit: limit.limit, used: limit.used })}{' '}
            <Badge tone={limit.custom ? 'warn' : 'neutral'}>
              {t(limit.custom ? 'padmin.limit.custom' : 'padmin.limit.default')}
            </Badge>
          </p>
        )}
        {role === 'super_admin' && limit && !limit.unlimited && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              min={1}
              max={100}
              value={value}
              placeholder={String(limit.default)}
              aria-label={t('padmin.limit.new')}
              title={t('padmin.limit.new')}
              onChange={(e) => setValue(e.target.value)}
              className={`${fieldCls} w-24`}
            />
            <input
              value={reason}
              maxLength={500}
              placeholder={t('padmin.usage.reason')}
              aria-label={t('padmin.usage.reason')}
              onChange={(e) => setReason(e.target.value)}
              className={`${fieldCls} min-w-[200px] flex-1`}
            />
            <button
              type="button"
              disabled={busy || reason.trim().length < 3}
              onClick={() => void save()}
              className={buttonCls}
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              {t('padmin.limit.save')}
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}

const SIGN_IN_EVENTS = new Set([
  'LOGIN_SUCCEEDED',
  'LOGIN_FAILED',
  'LOGIN_RATE_LIMITED',
  'LOGOUT',
  'MFA_CHALLENGE_SUCCEEDED',
  'MFA_CHALLENGE_FAILED',
  'MFA_RATE_LIMITED',
  'PASSWORD_RESET_COMPLETED',
  'PASSWORD_RESET_FAILED',
]);

/** Account page: sign-ins, two-factor checks and sign-outs, with address and device. */
export function SignInHistory({ events }: { events: SecurityEvent[] | null }) {
  const { t, fmt } = useI18n();
  const rows = (events ?? []).filter((e) => SIGN_IN_EVENTS.has(e.event_type));
  return (
    <Section title={t('padmin.logins.title')} icon={KeyRound}>
      {!events ? (
        <div className="px-5 py-4">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-5 py-4 text-[0.8rem] text-muted-foreground">{t('padmin.logins.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={`${tableCls} min-w-[640px]`}>
            <thead className={theadCls}>
              <tr>
                <th className="px-5 py-2 font-medium">{t('padmin.logins.when')}</th>
                <th className="px-3 py-2 font-medium">{t('padmin.logins.what')}</th>
                <th className="px-3 py-2 font-medium">{t('padmin.logins.ip')}</th>
                <th className="px-3 py-2 font-medium">{t('padmin.logins.device')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={rowCls}>
                  <td className="px-5 py-2 whitespace-nowrap">
                    {fmt.date(e.occurred_at, { dateStyle: 'medium', timeStyle: 'short' })}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={e.outcome === 'failure' ? 'bad' : 'neutral'}>
                      {EVENT_LABEL[e.event_type] ? t(EVENT_LABEL[e.event_type]) : e.event_type}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 font-mono text-[0.72rem]">{e.ip ?? '—'}</td>
                  <td
                    className="max-w-[320px] truncate px-3 py-2 text-[0.72rem] text-muted-foreground"
                    title={e.user_agent ?? ''}
                  >
                    {e.user_agent ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/** "Export CSV" for an admin list, with the list's current filters. */
export function ExportButton({ body }: { body: Record<string, unknown> }) {
  const { t } = useI18n();
  const { confirmIdentity } = useAdmin();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const result = await adminExport(confirmIdentity, body);
        setBusy(false);
        if (!result.ok && result.error !== 'cancelled') toast.error(t(errorKey(result.error)));
      }}
      className={buttonCls}
    >
      {busy && <Loader2 size={12} className="animate-spin" />}
      {t('padmin.export.csv')}
    </button>
  );
}
