'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Archive, Cable, HardDrive, KeyRound, Loader2, Network } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useAdmin } from '../components/AdminShell';
import { adminChange, adminGet } from '../components/api';
import { errorKey } from '../components/labels';
import { formatBytes } from '../components/GovernancePanels';
import { TunnelAllowlist, type TunnelEntry } from '../components/TunnelAllowlist';
import { Badge, Section, buttonCls, fieldCls, rowCls, tableCls, theadCls } from '../components/ui';

interface Policy {
  log_type: string;
  min_days: number;
  max_days: number | null;
  default_days: number | null;
}
interface Data {
  hosts: string[];
  aiLocal: string[];
  tunnels: TunnelEntry[];
  policies: Policy[];
  defaults: {
    default_quota_bytes: number | null;
    default_max_upload_bytes: number;
    xlsx_max_upload_bytes: number;
  };
  sessions: {
    id: string;
    admin_email: string | null;
    workspace_id: string;
    workspace_name: string | null;
    reason: string;
    ends_at: string;
    live: boolean;
  }[];
  holds: {
    id: string;
    workspace_id: string;
    workspace_name: string | null;
    reason: string;
    released_at: string | null;
  }[];
}

const MB = 1024 ** 2;
/** An example local AI address (not translated). */
const AI_LOCAL_EXAMPLE = 'localhost:11434';
const GB = 1024 ** 3;

function PolicyRow({
  policy,
  editable,
  onSave,
}: {
  policy: Policy;
  editable: boolean;
  onSave: (p: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [min, setMin] = useState(String(policy.min_days));
  const [max, setMax] = useState(policy.max_days == null ? '' : String(policy.max_days));
  const [def, setDef] = useState(policy.default_days == null ? '' : String(policy.default_days));
  return (
    <tr className={rowCls}>
      <td className="px-5 py-2 text-foreground">{t(`gov.log.${policy.log_type}` as MessageKey)}</td>
      {[
        [min, setMin],
        [max, setMax],
        [def, setDef],
      ].map(([value, set], i) => (
        <td key={i} className="px-2 py-2">
          <input
            className={`${fieldCls} w-24`}
            inputMode="numeric"
            disabled={!editable}
            value={value as string}
            placeholder={i === 0 ? '' : t('gov.forever')}
            onChange={(e) => (set as (v: string) => void)(e.target.value)}
          />
        </td>
      ))}
      <td className="px-2 py-2 text-right">
        {editable && (
          <button
            type="button"
            className={buttonCls}
            onClick={() =>
              void onSave({
                action: 'set_retention',
                logType: policy.log_type,
                minDays: min,
                maxDays: max,
                defaultDays: def,
              })
            }
          >
            {t('common.save')}
          </button>
        )}
      </td>
    </tr>
  );
}

export default function GovernancePage() {
  const { t, fmt } = useI18n();
  const { role, confirmIdentity } = useAdmin();
  const [data, setData] = useState<Data | null>(null);
  const [quotaGb, setQuotaGb] = useState('');
  const [uploadMb, setUploadMb] = useState('');
  const [xlsxMb, setXlsxMb] = useState('');
  const [hosts, setHosts] = useState('');
  const [aiLocal, setAiLocal] = useState('');

  const load = useCallback(async () => {
    const r = await adminGet<Data>('/api/admin/platform/governance');
    if (r.ok) {
      setData(r.data);
      setQuotaGb(
        r.data.defaults.default_quota_bytes
          ? String(+(r.data.defaults.default_quota_bytes / GB).toFixed(2))
          : ''
      );
      setUploadMb(String(Math.round(r.data.defaults.default_max_upload_bytes / MB)));
      setXlsxMb(String(Math.round(r.data.defaults.xlsx_max_upload_bytes / MB)));
      setHosts((r.data.hosts ?? []).join('\n'));
      setAiLocal((r.data.aiLocal ?? []).join('\n'));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(body: Record<string, unknown>) {
    const r = await adminChange(confirmIdentity, '/api/admin/platform/governance', body);
    if (!r.ok) {
      if (r.error !== 'cancelled') toast.error(t(errorKey(r.error)));
      return;
    }
    toast.success(t('gov.saved'));
    await load();
  }

  if (!data) return <Loader2 size={16} className="animate-spin text-muted-foreground" />;
  const canRetention = role === 'super_admin' || role === 'security_officer';
  const isSuper = role === 'super_admin';

  return (
    <div className="space-y-5">
      <Section title={t('gov.retention')} icon={Archive}>
        <p className="px-5 pt-3 text-[0.75rem] text-muted-foreground">{t('gov.retentionIntro')}</p>
        <div className="overflow-x-auto">
          <table className={`${tableCls} min-w-[620px]`}>
            <thead className={theadCls}>
              <tr>
                <th className="px-5 py-2 font-medium">{t('gov.logType')}</th>
                <th className="px-2 py-2 font-medium">{t('gov.minDays')}</th>
                <th className="px-2 py-2 font-medium">{t('gov.maxDays')}</th>
                <th className="px-2 py-2 font-medium">{t('gov.defaultDays')}</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.policies.map((p) => (
                <PolicyRow key={p.log_type} policy={p} editable={canRetention} onSave={save} />
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={t('gov.storageDefaults')} icon={HardDrive}>
        <form
          className="grid gap-2 px-5 py-4 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void save({
              action: 'set_storage_defaults',
              defaultQuotaGb: quotaGb,
              defaultMaxUploadMb: uploadMb,
              xlsxMaxUploadMb: xlsxMb,
            });
          }}
        >
          <label className="block space-y-1">
            <span className="text-[0.7rem] text-muted-foreground">{t('gov.defaultQuotaGb')}</span>
            <input
              className={`${fieldCls} w-full`}
              disabled={!isSuper}
              value={quotaGb}
              placeholder={t('gov.unlimited')}
              onChange={(e) => setQuotaGb(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[0.7rem] text-muted-foreground">{t('gov.uploadMb')}</span>
            <input
              className={`${fieldCls} w-full`}
              disabled={!isSuper}
              value={uploadMb}
              onChange={(e) => setUploadMb(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[0.7rem] text-muted-foreground">{t('gov.xlsxMb')}</span>
            <input
              className={`${fieldCls} w-full`}
              disabled={!isSuper}
              value={xlsxMb}
              onChange={(e) => setXlsxMb(e.target.value)}
            />
          </label>
          {isSuper && (
            <button type="submit" className={buttonCls}>
              {t('common.save')}
            </button>
          )}
          <p className="text-[0.7rem] text-muted-foreground sm:col-span-4">
            {t('gov.defaultsNow', {
              quota: data.defaults.default_quota_bytes
                ? formatBytes(data.defaults.default_quota_bytes)
                : t('gov.unlimited'),
              upload: formatBytes(data.defaults.default_max_upload_bytes),
            })}
          </p>
        </form>
      </Section>

      <Section title={t('gov.connectorHosts')} icon={Network}>
        <form
          className="space-y-2 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ action: 'set_connector_hosts', hosts });
          }}
        >
          <p className="text-[0.75rem] text-muted-foreground">{t('gov.connectorHostsIntro')}</p>
          <textarea
            className={`${fieldCls} w-full font-mono`}
            rows={4}
            disabled={!isSuper}
            value={hosts}
            placeholder={'sap.pt-batu.local\n10.10.0.0/16'}
            onChange={(e) => setHosts(e.target.value)}
          />
          {isSuper && (
            <button type="submit" className={buttonCls}>
              {t('common.save')}
            </button>
          )}
        </form>
      </Section>

      <Section title={t('gov.aiLocal')} icon={Network}>
        <form
          className="space-y-2 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ action: 'set_ai_local_endpoints', endpoints: aiLocal });
          }}
        >
          <p className="text-[0.75rem] text-muted-foreground">{t('gov.aiLocalIntro')}</p>
          <textarea
            className={`${fieldCls} w-full font-mono`}
            rows={2}
            disabled={!isSuper}
            value={aiLocal}
            placeholder={AI_LOCAL_EXAMPLE}
            onChange={(e) => setAiLocal(e.target.value)}
          />
          {isSuper && (
            <button type="submit" className={buttonCls}>
              {t('common.save')}
            </button>
          )}
        </form>
      </Section>

      <Section title={t('gov.tunnels')} icon={Cable}>
        <TunnelAllowlist entries={data.tunnels ?? []} editable={isSuper} onChange={save} />
      </Section>

      <Section title={t('gov.liveStaff')} icon={KeyRound}>
        {data.sessions.filter((s) => s.live).length === 0 ? (
          <p className="px-5 py-4 text-[0.78rem] text-muted-foreground">{t('gov.noLiveStaff')}</p>
        ) : (
          <table className={tableCls}>
            <thead className={theadCls}>
              <tr>
                <th className="px-5 py-2 font-medium">{t('gov.admin')}</th>
                <th className="px-2 py-2 font-medium">{t('padmin.nav.workspaces')}</th>
                <th className="px-2 py-2 font-medium">{t('gov.staffReason')}</th>
                <th className="px-2 py-2 font-medium">{t('gov.endsAt')}</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions
                .filter((s) => s.live)
                .map((s) => (
                  <tr key={s.id} className={rowCls}>
                    <td className="px-5 py-2">{s.admin_email}</td>
                    <td className="px-2 py-2">
                      <Link
                        href={`/admin/workspaces/${s.workspace_id}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {s.workspace_name}
                      </Link>
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">{s.reason}</td>
                    <td className="px-2 py-2 text-muted-foreground">
                      {fmt.date(s.ends_at, { timeStyle: 'short', dateStyle: 'medium' })}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={t('gov.legalHolds')}>
        {data.holds.filter((h) => !h.released_at).length === 0 ? (
          <p className="px-5 py-4 text-[0.78rem] text-muted-foreground">{t('gov.noHolds')}</p>
        ) : (
          <ul className="space-y-1 px-5 py-4">
            {data.holds
              .filter((h) => !h.released_at)
              .map((h) => (
                <li key={h.id} className="text-[0.78rem]">
                  <Link
                    href={`/admin/workspaces/${h.workspace_id}`}
                    className="underline-offset-2 hover:underline"
                  >
                    {h.workspace_name}
                  </Link>{' '}
                  <span className="text-muted-foreground">· {h.reason}</span>{' '}
                  <Badge tone="warn">{t('gov.onHold')}</Badge>
                </li>
              ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
