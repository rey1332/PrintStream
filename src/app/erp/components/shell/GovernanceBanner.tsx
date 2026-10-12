'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Download, KeyRound, Loader2, Power } from 'lucide-react';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useWorkspace } from '../../lib/WorkspaceContext';

/**
 * Notices about the active ERP from ETNA's governance (20261012000032): an
 * open ETNA staff session (shown to the staff member, who acts with the
 * Owner's rights), and to the Owner an ending service with its export period.
 */
export function GovernanceBanner() {
  const { t, fmt } = useI18n();
  const { active } = useWorkspace();
  const [termination, setTermination] = useState<{ state: string; export_until: string } | null>(
    null
  );

  useEffect(() => {
    setTermination(null);
    if (!active?.isOwner || active.staffSessionUntil) return;
    let cancelled = false;
    createClient()
      .rpc('erp_my_termination', { p_workspace_id: active.id })
      .then(({ data, error }) => {
        // Missing function = governance not installed yet: nothing to show.
        if (!cancelled && !error && data)
          setTermination(data as { state: string; export_until: string });
      });
    return () => {
      cancelled = true;
    };
  }, [active?.id, active?.isOwner, active?.staffSessionUntil]);

  if (!active) return null;
  const exportOpen =
    termination?.state === 'export_available' && new Date(termination.export_until) > new Date();
  return (
    <>
      {active.staffSessionUntil && (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-[0.8rem] text-violet-900 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-200"
        >
          <KeyRound size={14} className="mt-0.5 shrink-0" aria-hidden />
          <p className="flex-1">
            {t('gs.staffBanner', {
              name: active.name,
              until: fmt.date(active.staffSessionUntil, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
          </p>
        </div>
      )}
      {termination && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-[0.8rem] text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200"
        >
          <Power size={14} className="mt-0.5 shrink-0" aria-hidden />
          <p className="flex-1">
            {termination.state === 'export_available'
              ? t('gs.terminationBanner', {
                  date: fmt.date(termination.export_until, { dateStyle: 'medium' }),
                })
              : t('gs.terminationDone')}
          </p>
        </div>
      )}
      {exportOpen && <CompanyExport workspaceId={active.id} />}
    </>
  );
}

interface ExportRow {
  id: string;
  status: 'preparing' | 'ready' | 'failed';
  size_bytes: number | null;
  created_at: string;
}

/** The Owner prepares and downloads the company's data during the export period. */
function CompanyExport({ workspaceId }: { workspaceId: string }) {
  const { t, fmt } = useI18n();
  const [rows, setRows] = useState<ExportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const call = useCallback(
    async (action: 'list' | 'request') => {
      const res = await fetch('/api/erp/company-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, workspaceId }),
      });
      return res.json().catch(() => null);
    },
    [workspaceId]
  );
  const load = useCallback(async () => {
    const json = await call('list');
    if (json?.success) setRows(json.data);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);
  const preparing = rows.some((r) => r.status === 'preparing');
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [preparing, load]);

  const request = async () => {
    setBusy(true);
    setError('');
    const json = await call('request');
    if (!json?.success)
      setError(json?.error === 'busy' ? t('gs.exportBusy') : t('gs.exportFailed'));
    await load();
    setBusy(false);
  };

  const latest = rows[0];
  return (
    <div className="mb-4 rounded-lg border border-border bg-card px-3 py-3 text-[0.8rem] space-y-2">
      <p className="text-foreground">{t('gs.exportIntro')}</p>
      {latest?.status === 'ready' && (
        <a
          href={`/api/erp/company-export?id=${latest.id}`}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[0.78rem] font-medium text-primary-foreground"
        >
          <Download size={13} aria-hidden />
          {t('gs.exportDownload', {
            date: fmt.date(latest.created_at, { dateStyle: 'medium', timeStyle: 'short' }),
            size: latest.size_bytes
              ? `${Math.max(1, Math.round(latest.size_bytes / 1024))} KB`
              : '',
          })}
        </a>
      )}
      {latest?.status === 'failed' && (
        <p className="text-red-600 dark:text-red-400">{t('gs.exportFailed')}</p>
      )}
      {preparing ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 size={13} className="animate-spin" aria-hidden /> {t('gs.exportPreparing')}
        </p>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={request}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[0.78rem] hover:bg-[var(--surface-3)] disabled:opacity-50"
        >
          {busy && <Loader2 size={13} className="animate-spin" aria-hidden />}
          {latest ? t('gs.exportAgain') : t('gs.exportPrepare')}
        </button>
      )}
      {error && (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
