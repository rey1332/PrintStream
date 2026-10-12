'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Database, Loader2, Mail, Server } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useAdmin } from '../components/AdminShell';
import { adminChange, adminGet } from '../components/api';
import { errorKey } from '../components/labels';
import { formatBytes } from '../components/WorkspaceUsage';
import {
  Badge,
  Facts,
  Section,
  buttonCls,
  fieldCls,
  rowCls,
  tableCls,
  theadCls,
} from '../components/ui';

interface SystemDetail {
  database: { ok: boolean; ms: number | null; sizeBytes: number | null };
  app: { uptimeSeconds: number; node: string };
  disk: { free: number; total: number } | null;
  backupList: {
    configured: boolean;
    backups: { createdAt: string; size: number; label: string }[];
  } | null;
  email: { configured: boolean; sender: string | null };
}

export default function SystemPage() {
  const { t, fmt } = useI18n();
  const { role, email: me, confirmIdentity } = useAdmin();
  const [data, setData] = useState<SystemDetail | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    const result = await adminGet<SystemDetail>('/api/admin/platform/system?detail=1');
    if (result.ok) setData(result.data);
  }, []);

  useEffect(() => {
    void load();
    setTestTo(me ?? '');
  }, [load, me]);

  async function backup() {
    setBackingUp(true);
    const result = await adminChange(confirmIdentity, '/api/admin/platform/system', {
      action: 'backup',
    });
    setBackingUp(false);
    if (!result.ok) {
      if (result.error !== 'cancelled') toast.error(t(errorKey(result.error)));
      return;
    }
    toast.success(t('padmin.sys.backupDone'));
    await load();
  }

  async function testEmail() {
    setTesting(true);
    const result = await adminChange(confirmIdentity, '/api/admin/platform/system', {
      action: 'test_email',
      to: testTo.trim(),
    });
    setTesting(false);
    if (!result.ok) {
      if (result.error !== 'cancelled') toast.error(t(errorKey(result.error)));
      return;
    }
    toast.success(t('padmin.sys.testSent'));
  }

  if (!data)
    return (
      <Section title={t('padmin.nav.system')} icon={Server}>
        <div className="px-5 py-6">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      </Section>
    );

  const bytes = (n: number) => formatBytes(n, fmt.number);
  const lowDisk = data.disk && data.disk.total > 0 && data.disk.free / data.disk.total < 0.1;

  return (
    <div className="space-y-5">
      <Section title={t('padmin.nav.system')} icon={Server}>
        <p className="px-5 pt-3 text-[0.75rem] text-muted-foreground">{t('padmin.sys.subtitle')}</p>
        <Facts
          items={[
            [
              t('padmin.sys.database'),
              data.database.ok ? (
                <>
                  <Badge tone="good">{`${data.database.ms ?? '?'} ms`}</Badge>{' '}
                  {data.database.sizeBytes !== null &&
                    `${t('padmin.sys.size')}: ${bytes(data.database.sizeBytes)}`}
                </>
              ) : (
                <Badge tone="bad">{t('padmin.sys.down')}</Badge>
              ),
            ],
            [
              t('padmin.sys.disk'),
              data.disk ? (
                <span className={lowDisk ? 'text-red-600 dark:text-red-400' : ''}>
                  {t('padmin.sys.diskValue', {
                    free: bytes(data.disk.free),
                    total: bytes(data.disk.total),
                  })}
                  {lowDisk && ` — ${t('padmin.sys.diskLow')}`}
                </span>
              ) : (
                '—'
              ),
            ],
            [
              t('padmin.sys.app'),
              t('padmin.sys.uptime', {
                hours: fmt.number(Math.round(data.app.uptimeSeconds / 360) / 10),
                node: data.app.node,
              }),
            ],
          ]}
        />
      </Section>

      <Section
        title={t('padmin.sys.backups')}
        icon={Database}
        actions={
          role === 'super_admin' &&
          data.backupList?.configured && (
            <button
              type="button"
              disabled={backingUp}
              onClick={() => void backup()}
              className={buttonCls}
            >
              {backingUp && <Loader2 size={12} className="animate-spin" />}
              {t('padmin.sys.runBackup')}
            </button>
          )
        }
      >
        <p className="px-5 pt-3 text-[0.75rem] text-amber-700 dark:text-amber-400">
          {t('padmin.sys.offsite')}
        </p>
        {!data.backupList?.configured ? (
          <p className="px-5 py-4 text-[0.8rem] text-muted-foreground">
            {t('padmin.sys.backupOff')}
          </p>
        ) : data.backupList.backups.length === 0 ? (
          <p className="px-5 py-4 text-[0.8rem] text-muted-foreground">
            {t('padmin.sys.backupNone')}
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto border-t border-border">
            <table className={tableCls}>
              <thead className={theadCls}>
                <tr>
                  <th className="px-5 py-2 font-medium">{t('padmin.logins.when')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.sys.size')}</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {data.backupList.backups.map((b) => (
                  <tr key={b.createdAt} className={rowCls}>
                    <td className="px-5 py-2 whitespace-nowrap">
                      {fmt.date(b.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{bytes(b.size)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{b.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={t('padmin.sys.email')} icon={Mail}>
        <div className="space-y-3 px-5 py-4">
          {data.email.configured ? (
            <>
              <p className="text-[0.8rem] text-foreground">
                {t('padmin.sys.emailOn', { sender: data.email.sender ?? '' })}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="email"
                  value={testTo}
                  aria-label={t('padmin.sys.testTo')}
                  placeholder={t('padmin.sys.testTo')}
                  onChange={(e) => setTestTo(e.target.value)}
                  className={`${fieldCls} min-w-[240px]`}
                />
                <button
                  type="button"
                  disabled={testing || !testTo.trim()}
                  onClick={() => void testEmail()}
                  className={buttonCls}
                >
                  {testing && <Loader2 size={12} className="animate-spin" />}
                  {t('padmin.sys.test')}
                </button>
              </div>
            </>
          ) : (
            <p className="text-[0.8rem] text-muted-foreground">{t('padmin.sys.emailOff')}</p>
          )}
        </div>
      </Section>
    </div>
  );
}
