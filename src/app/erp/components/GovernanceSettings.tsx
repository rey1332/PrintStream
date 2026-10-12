'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Archive, Eye, HardDrive, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useWorkspace } from '../lib/WorkspaceContext';

interface Usage {
  quota_bytes: number | null;
  used_bytes: number;
  used_datasets: number;
  used_files: number;
  used_erp_estimate: number;
  reserved_bytes: number;
  max_upload_bytes: number;
  measured_at: string | null;
}
interface Retention {
  log_type: string;
  min_days: number;
  max_days: number | null;
  default_days: number | null;
  chosen_days: number | null;
  effective_days: number | null;
  legal_hold: boolean;
}
interface Access {
  occurred_at: string;
  actor_email: string | null;
  actor_kind: string;
  object_kind: string;
  object_id: string | null;
  operation: string;
  rows: number | null;
}

const formatBytes = (n: number | null | undefined) => {
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

const panel = 'rounded-xl border border-border overflow-hidden bg-card';
const head = 'px-5 py-4 border-b border-border flex items-center gap-2';

/**
 * Settings → Storage, retention and data access (20261012000032-34): the
 * company's storage use and quota (and asking ETNA for more), how long its
 * logs are kept, and who accessed its data. Each part shows only to roles
 * that may see it; the database checks again.
 */
export function GovernanceSettings() {
  const { t, fmt } = useI18n();
  const { active, can } = useWorkspace();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [retention, setRetention] = useState<Retention[] | null>(null);
  const [access, setAccess] = useState<Access[] | null>(null);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const showStorage = can('storage.view');
  const manageRetention = can('policies.manage');
  const showAccess = can('audit');

  const load = useCallback(async () => {
    if (!active) return;
    const db = createClient();
    if (showStorage) {
      const { data } = await db.rpc('erp_storage_usage', { p_workspace_id: active.id });
      setUsage((data as Usage) ?? null);
    }
    const { data: rows } = await db.rpc('erp_workspace_retention', { p_workspace_id: active.id });
    if (Array.isArray(rows)) {
      setRetention(rows as Retention[]);
      setChoices(
        Object.fromEntries(
          (rows as Retention[]).map((r) => [
            r.log_type,
            r.chosen_days == null ? '' : String(r.chosen_days),
          ])
        )
      );
    }
    if (showAccess) {
      const { data: log } = await db.rpc('erp_data_access_log', {
        p_workspace_id: active.id,
        p_limit: 50,
      });
      setAccess(Array.isArray(log) ? (log as Access[]) : []);
    }
  }, [active, showStorage, showAccess]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!active) return null;

  async function requestMore(e: React.FormEvent) {
    e.preventDefault();
    if (!active) return;
    setError('');
    const { error: rpcError } = await createClient().rpc('erp_request_storage', {
      p_workspace_id: active.id,
      p_message: message,
    });
    if (rpcError) {
      setError(t('gs.requestFailed'));
      return;
    }
    setMessage('');
    setNotice(t('gs.requestSent'));
  }

  async function saveRetention(logType: string) {
    if (!active) return;
    setError('');
    const raw = choices[logType];
    const { error: rpcError } = await createClient().rpc('erp_set_workspace_retention', {
      p_workspace_id: active.id,
      p_log_type: logType,
      p_days: raw === '' ? null : Number(raw),
    });
    if (rpcError) {
      setError(rpcError.message || t('gs.saveFailed'));
      return;
    }
    setNotice(t('common.saved'));
    await load();
  }

  const pct = usage?.quota_bytes
    ? Math.min(100, Math.round((100 * usage.used_bytes) / usage.quota_bytes))
    : null;

  return (
    <>
      {error && (
        <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {notice && !error && (
        <p role="status" className="text-[0.75rem] text-green-700 dark:text-green-400">
          {notice}
        </p>
      )}

      {showStorage && (
        <section className={panel}>
          <div className={head}>
            <HardDrive size={14} className="text-muted-foreground" />
            <div>
              <h2 className="text-[0.85rem] font-semibold text-foreground">{t('gs.storage')}</h2>
              <p className="text-[0.72rem] text-muted-foreground">{t('gs.storageSubtitle')}</p>
            </div>
          </div>
          <div className="p-5 space-y-3">
            {!usage ? (
              <Loader2 size={14} className="animate-spin text-muted-foreground" />
            ) : (
              <>
                <p className="text-[0.8rem] text-foreground">
                  {usage.quota_bytes
                    ? t('gs.usedOf', {
                        used: formatBytes(usage.used_bytes),
                        quota: formatBytes(usage.quota_bytes),
                      })
                    : t('gs.usedNoLimit', { used: formatBytes(usage.used_bytes) })}
                </p>
                {pct !== null && (
                  <div className="h-2 overflow-hidden rounded bg-muted">
                    <div
                      className={`h-full ${pct >= 90 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
                <p className="text-[0.72rem] text-muted-foreground">
                  {t('gs.breakdown', {
                    datasets: formatBytes(usage.used_datasets),
                    files: formatBytes(usage.used_files),
                    erp: formatBytes(usage.used_erp_estimate),
                    upload: formatBytes(usage.max_upload_bytes),
                  })}
                </p>
                <form onSubmit={requestMore} className="flex flex-wrap gap-2">
                  <input
                    className="min-w-[240px] flex-1 rounded-lg border border-border bg-input px-2.5 py-1.5 text-[0.78rem] text-foreground"
                    maxLength={500}
                    required
                    placeholder={t('gs.requestPlaceholder')}
                    aria-label={t('gs.requestPlaceholder')}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="rounded-lg border border-border px-3 py-1.5 text-[0.75rem] text-foreground"
                  >
                    {t('gs.requestMore')}
                  </button>
                </form>
              </>
            )}
          </div>
        </section>
      )}

      {retention && (
        <section className={panel}>
          <div className={head}>
            <Archive size={14} className="text-muted-foreground" />
            <div>
              <h2 className="text-[0.85rem] font-semibold text-foreground">{t('gs.retention')}</h2>
              <p className="text-[0.72rem] text-muted-foreground">{t('gs.retentionSubtitle')}</p>
            </div>
          </div>
          <div className="p-5 space-y-2">
            {retention.some((r) => r.legal_hold) && (
              <p className="text-[0.75rem] text-amber-700 dark:text-amber-400">{t('gs.onHold')}</p>
            )}
            {retention.map((r) => (
              <div key={r.log_type} className="flex flex-wrap items-center gap-2 text-[0.78rem]">
                <span className="min-w-[180px] text-foreground">
                  {t(`gov.log.${r.log_type}` as MessageKey)}
                </span>
                <span className="text-muted-foreground">
                  {r.effective_days == null
                    ? t('gov.forever')
                    : t('gs.days', { n: r.effective_days })}
                </span>
                {manageRetention && (
                  <>
                    <input
                      className="w-24 rounded-lg border border-border bg-input px-2 py-1 text-[0.75rem] text-foreground"
                      inputMode="numeric"
                      aria-label={t('gs.chooseDays')}
                      placeholder={t('gs.range', { min: r.min_days, max: r.max_days ?? '∞' })}
                      value={choices[r.log_type] ?? ''}
                      onChange={(e) => setChoices((c) => ({ ...c, [r.log_type]: e.target.value }))}
                    />
                    <button
                      type="button"
                      onClick={() => void saveRetention(r.log_type)}
                      className="rounded-lg border border-border px-2.5 py-1 text-[0.72rem] text-foreground"
                    >
                      {t('common.save')}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {showAccess && (
        <section className={panel}>
          <div className={head}>
            <Eye size={14} className="text-muted-foreground" />
            <div>
              <h2 className="text-[0.85rem] font-semibold text-foreground">{t('gov.accessLog')}</h2>
              <p className="text-[0.72rem] text-muted-foreground">{t('gs.accessSubtitle')}</p>
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto p-5">
            {!access ? (
              <Loader2 size={14} className="animate-spin text-muted-foreground" />
            ) : access.length === 0 ? (
              <p className="text-[0.75rem] text-muted-foreground">{t('padmin.log.empty')}</p>
            ) : (
              <ul className="space-y-1">
                {access.map((a, i) => (
                  <li
                    key={`${a.occurred_at}-${i}`}
                    className="text-[0.72rem] text-muted-foreground"
                  >
                    <span className="text-foreground">{a.actor_email ?? '—'}</span>
                    {a.actor_kind === 'staff' ? ` (${t('gov.actor.staff')})` : ''} · {a.operation} ·{' '}
                    {a.object_kind}
                    {a.object_id ? ` · ${a.object_id}` : ''}
                    {a.rows != null ? ` · ${a.rows}` : ''} ·{' '}
                    {fmt.date(a.occurred_at, { dateStyle: 'medium', timeStyle: 'short' })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </>
  );
}
