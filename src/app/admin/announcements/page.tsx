'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Megaphone } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useAdmin } from '../components/AdminShell';
import { adminChange, adminGet } from '../components/api';
import { errorKey } from '../components/labels';
import { Badge, Section, buttonCls, fieldCls, rowCls, tableCls, theadCls } from '../components/ui';

interface Announcement {
  id: string;
  message: string;
  level: 'info' | 'warning' | 'maintenance';
  workspace_id: string | null;
  workspace_name: string | null;
  starts_at: string;
  ends_at: string | null;
  created_by_email: string | null;
  state: 'active' | 'scheduled' | 'ended' | 'cancelled';
}

const LEVELS = ['info', 'warning', 'maintenance'] as const;
const STATE_TONE = {
  active: 'good',
  scheduled: 'warn',
  ended: 'neutral',
  cancelled: 'neutral',
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AnnouncementsPage() {
  const { t, fmt } = useI18n();
  const { role, confirmIdentity } = useAdmin();
  const [rows, setRows] = useState<Announcement[] | null>(null);
  const [message, setMessage] = useState('');
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('info');
  const [workspaceId, setWorkspaceId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = role === 'super_admin' || role === 'support';

  const load = useCallback(async () => {
    const result = await adminGet<{ announcements: Announcement[] }>(
      '/api/admin/platform/announcements'
    );
    setRows(result.ok ? result.data.announcements : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await adminChange(confirmIdentity, '/api/admin/platform/announcements', {
      action: 'create',
      message: message.trim(),
      level,
      workspaceId: workspaceId.trim() || null,
      // datetime-local is the admin's own time; sent as an instant.
      startsAt: startsAt ? new Date(startsAt).toISOString() : null,
      endsAt: endsAt ? new Date(endsAt).toISOString() : null,
    });
    setBusy(false);
    if (!result.ok) {
      if (result.error !== 'cancelled') toast.error(t(errorKey(result.error)));
      return;
    }
    toast.success(t('padmin.ann.created'));
    setMessage('');
    setWorkspaceId('');
    setStartsAt('');
    setEndsAt('');
    await load();
  }

  async function cancel(id: string) {
    const result = await adminChange(confirmIdentity, '/api/admin/platform/announcements', {
      action: 'cancel',
      id,
    });
    if (!result.ok) {
      if (result.error !== 'cancelled') toast.error(t(errorKey(result.error)));
      return;
    }
    await load();
  }

  const label = 'block space-y-1';
  const caption = 'text-[0.75rem] text-muted-foreground';

  return (
    <div className="space-y-5">
      <Section title={t('padmin.nav.announcements')} icon={Megaphone}>
        <p className="px-5 pt-3 text-[0.75rem] text-muted-foreground">{t('padmin.ann.subtitle')}</p>
        {canEdit && (
          <form onSubmit={create} className="grid gap-3 px-5 py-4 sm:grid-cols-2">
            <label className={`${label} sm:col-span-2`}>
              <span className={caption}>{t('padmin.ann.message')}</span>
              <textarea
                required
                maxLength={500}
                rows={2}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className={`${fieldCls} w-full`}
              />
            </label>
            <label className={label}>
              <span className={caption}>{t('padmin.ann.level')}</span>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value as (typeof LEVELS)[number])}
                className={`${fieldCls} w-full`}
              >
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {t(`padmin.ann.level.${l}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              <span className={caption}>{t('padmin.ann.workspace')}</span>
              <input
                value={workspaceId}
                placeholder={t('padmin.ann.everyone')}
                onChange={(e) => setWorkspaceId(e.target.value)}
                className={`${fieldCls} w-full font-mono text-[0.72rem]`}
              />
            </label>
            <label className={label}>
              <span className={caption}>{t('padmin.ann.starts')}</span>
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className={`${fieldCls} w-full`}
              />
            </label>
            <label className={label}>
              <span className={caption}>{t('padmin.ann.ends')}</span>
              <input
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                className={`${fieldCls} w-full`}
              />
            </label>
            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={
                  busy ||
                  !message.trim() ||
                  (!!workspaceId.trim() && !UUID.test(workspaceId.trim()))
                }
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-[0.78rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                {t('padmin.ann.create')}
              </button>
            </div>
          </form>
        )}

        {!rows ? (
          <div className="px-5 py-4">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="border-t border-border px-5 py-4 text-[0.8rem] text-muted-foreground">
            {t('padmin.ann.empty')}
          </p>
        ) : (
          <div className="overflow-x-auto border-t border-border">
            <table className={`${tableCls} min-w-[720px]`}>
              <thead className={theadCls}>
                <tr>
                  <th className="px-5 py-2 font-medium">{t('padmin.ann.message')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.ann.scope')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.ann.starts')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.ann.ends')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.users.col.status')}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className={rowCls}>
                    <td className="px-5 py-2">
                      <Badge
                        tone={
                          a.level === 'info' ? 'neutral' : a.level === 'warning' ? 'warn' : 'bad'
                        }
                      >
                        {t(`padmin.ann.level.${a.level}` as MessageKey)}
                      </Badge>{' '}
                      {a.message}
                    </td>
                    <td className="px-3 py-2">{a.workspace_name ?? t('padmin.ann.everyone')}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {fmt.date(a.starts_at, { dateStyle: 'medium', timeStyle: 'short' })}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {a.ends_at
                        ? fmt.date(a.ends_at, { dateStyle: 'medium', timeStyle: 'short' })
                        : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={STATE_TONE[a.state]}>
                        {t(`padmin.ann.state.${a.state}` as MessageKey)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canEdit && (a.state === 'active' || a.state === 'scheduled') && (
                        <button
                          type="button"
                          onClick={() => void cancel(a.id)}
                          className={buttonCls}
                        >
                          {t('padmin.ann.cancel')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
