'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import {
  INDUSTRIES,
  INDUSTRY_LABEL,
  MODULES,
  MODULE_LABEL,
  isIndustry,
  parseModules,
  type Industry,
  type ModuleCode,
} from '@/lib/industry';
import { useAdmin } from './AdminShell';
import { adminChange, adminGet } from './api';
import { errorKey } from './labels';
import { Section, buttonCls, fieldCls } from './ui';

interface Usage {
  industry: string;
  modules: string[];
  counts: Record<string, number>;
  documents: number;
  document_bytes: number;
  members: number;
  last_activity: string | null;
}

const COUNT_KEYS = [
  'customers',
  'suppliers',
  'products',
  'sales_orders',
  'purchase_orders',
  'invoices',
  'payments',
  'journal_entries',
  'employees',
  'weigh_tickets',
  'production_runs',
  'equipment',
] as const;

export function formatBytes(bytes: number, number: (n: number) => string): string {
  if (bytes < 1024 * 1024) return `${number(Math.round(bytes / 102.4) / 10)} KB`;
  if (bytes < 1024 ** 3) return `${number(Math.round(bytes / 1024 / 102.4) / 10)} MB`;
  return `${number(Math.round(bytes / 1024 ** 2 / 102.4) / 10)} GB`;
}

/** Workspace page: what the ERP holds, and its industry and modules (super admin changes them). */
export function WorkspaceUsage({ workspaceId }: { workspaceId: string }) {
  const { t, fmt } = useI18n();
  const { role, confirmIdentity } = useAdmin();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [industry, setIndustry] = useState<Industry>('general');
  const [modules, setModules] = useState<ModuleCode[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await adminGet<Usage>(`/api/admin/platform/workspaces/${workspaceId}/usage`);
    if (!result.ok) return;
    setUsage(result.data);
    setIndustry(isIndustry(result.data.industry) ? result.data.industry : 'general');
    setModules(parseModules(result.data.modules));
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    const result = await adminChange(
      confirmIdentity,
      `/api/admin/platform/workspaces/${workspaceId}/usage`,
      { industry, modules, reason: reason.trim() }
    );
    setBusy(false);
    if (!result.ok) {
      if (result.error !== 'cancelled') toast.error(t(errorKey(result.error)));
      return;
    }
    toast.success(t('padmin.usage.saved'));
    setReason('');
    await load();
  }

  if (!usage)
    return (
      <Section title={t('padmin.usage.title')} icon={BarChart3}>
        <div className="px-5 py-4">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      </Section>
    );

  const canEdit = role === 'super_admin';
  const dirty =
    industry !== usage.industry ||
    modules.length !== usage.modules.length ||
    modules.some((m) => !usage.modules.includes(m));

  return (
    <Section title={t('padmin.usage.title')} icon={BarChart3}>
      <dl className="grid grid-cols-2 gap-2 px-5 py-4 sm:grid-cols-4">
        {COUNT_KEYS.filter((k) => k in usage.counts).map((k) => (
          <div key={k} className="rounded-lg bg-[var(--surface-2)] px-3 py-2">
            <dt className="text-[0.68rem] text-muted-foreground">
              {t(`padmin.usage.${k}` as MessageKey)}
            </dt>
            <dd className="text-[0.95rem] font-semibold tabular-nums text-foreground">
              {fmt.number(usage.counts[k] ?? 0)}
            </dd>
          </div>
        ))}
        <div className="rounded-lg bg-[var(--surface-2)] px-3 py-2">
          <dt className="text-[0.68rem] text-muted-foreground">{t('padmin.usage.documents')}</dt>
          <dd className="text-[0.85rem] font-semibold tabular-nums text-foreground">
            {t('padmin.usage.documentsValue', {
              count: fmt.number(usage.documents),
              size: formatBytes(usage.document_bytes, fmt.number),
            })}
          </dd>
        </div>
      </dl>
      <div className="space-y-3 border-t border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[0.8rem]">
            <span className="text-muted-foreground">{t('industry.label')}</span>
            <select
              value={industry}
              disabled={!canEdit}
              onChange={(e) => setIndustry(e.target.value as Industry)}
              className={fieldCls}
            >
              {INDUSTRIES.map((code) => (
                <option key={code} value={code}>
                  {t(INDUSTRY_LABEL[code])}
                </option>
              ))}
            </select>
          </label>
          {MODULES.map((code) => (
            <label key={code} className="flex items-center gap-1.5 text-[0.8rem] text-foreground">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={modules.includes(code)}
                onChange={() =>
                  setModules((m) => (m.includes(code) ? m.filter((x) => x !== code) : [...m, code]))
                }
              />
              {t(MODULE_LABEL[code])}
            </label>
          ))}
        </div>
        {canEdit && dirty && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={reason}
              maxLength={500}
              placeholder={t('padmin.usage.reason')}
              aria-label={t('padmin.usage.reason')}
              onChange={(e) => setReason(e.target.value)}
              className={`${fieldCls} min-w-[220px] flex-1`}
            />
            <button
              type="button"
              disabled={busy || reason.trim().length < 3}
              onClick={() => void save()}
              className={buttonCls}
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              {t('padmin.usage.save')}
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}
