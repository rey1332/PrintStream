'use client';

import React, { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { hasMessage } from '@/lib/i18n/labels';
import type { MessageKey } from '@/lib/i18n/messages';
import { cancelRun, listRuns, type RunHistoryEntry } from '@/lib/workflow/storage';

const STATUS_STYLE: Record<RunHistoryEntry['status'], string> = {
  queued: 'bg-[var(--surface-3)] text-muted-foreground',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300',
  success: 'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  cancelled: 'bg-[var(--surface-3)] text-muted-foreground',
};

interface Props {
  workflowId: string;
  refreshKey: number;
  onClose: () => void;
  nodeLabels: Record<string, string>;
}

export default function RunHistoryPanel({ workflowId, refreshKey, onClose, nodeLabels }: Props) {
  const { t, fmt } = useI18n();
  const [runs, setRuns] = useState<RunHistoryEntry[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  // Auto-refresh adds a run a minute; they are hidden unless asked for.
  const [showAuto, setShowAuto] = useState(false);

  useEffect(() => {
    let active = true;
    setError('');
    listRuns(workflowId, showAuto)
      .then((rows) => active && setRuns(rows))
      .catch((e) => active && setError(e instanceof Error ? e.message : t('wf.loadFailed')));
    return () => {
      active = false;
    };
  }, [workflowId, refreshKey, reload, showAuto, t]);

  const triggerLabel = (trigger?: string) =>
    t(
      `wf.run.trigger.${!trigger || trigger === 'manual' ? 'manual' : trigger === 'auto_refresh' ? 'auto_refresh' : 'other'}` as MessageKey
    );

  const kindLabel = (r: RunHistoryEntry) =>
    r.run_kind && r.run_kind !== 'draft'
      ? t(`wf.run.kind.${r.run_kind}`, { version: r.version ?? '?' })
      : t('wf.run.kind.draft');

  const codeLabel = (code?: string | null) => {
    const key = `wf.run.code.${code}`;
    return code && hasMessage(key) ? t(key as MessageKey) : '';
  };

  return (
    <aside
      className="w-full lg:w-80 lg:border-l bg-card h-full flex flex-col"
      style={{ borderColor: 'var(--border)' }}
      aria-label={t('wf.run.history')}
    >
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <p className="text-[0.78rem] font-semibold text-foreground">{t('wf.run.history')}</p>
        <button
          onClick={onClose}
          className="inline-flex items-center justify-center p-1 text-muted-foreground hover:text-foreground max-lg:h-11 max-lg:w-11"
          aria-label={t('wf.close')}
        >
          <X size={13} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        <p className="text-[0.62rem] text-muted-foreground">{t('wf.run.preview')}</p>
        <label className="flex items-center gap-1.5 text-[0.66rem] text-muted-foreground max-lg:min-h-11">
          <input
            type="checkbox"
            checked={showAuto}
            onChange={(e) => setShowAuto(e.target.checked)}
          />
          {t('wf.run.showAuto')}
        </label>
        {error && <p className="text-[0.72rem] text-red-600 dark:text-red-400">{error}</p>}
        {!runs && !error && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
        {runs?.length === 0 && (
          <p className="text-[0.72rem] text-muted-foreground">{t('wf.run.noHistory')}</p>
        )}
        <ul className="space-y-2">
          {runs?.map((r) => (
            <li key={r.id} className="rounded-md border border-border p-2 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`px-2 py-0.5 rounded-full text-[0.62rem] font-medium ${STATUS_STYLE[r.status]}`}
                >
                  {t(`wf.run.status.${r.status}`)}
                </span>
                <span className="text-[0.62rem] text-muted-foreground">
                  {fmt.dateTime(r.started_at)}
                </span>
              </div>
              <p className="text-[0.62rem] text-muted-foreground">
                {t('wf.run.trigger', { trigger: triggerLabel(r.triggered_by) })}
                {r.finished_at ? (
                  <> · {t('wf.run.ended', { time: fmt.dateTime(r.finished_at) })}</>
                ) : null}
              </p>
              <p className="text-[0.66rem] text-muted-foreground">
                {t('wf.run.meta', {
                  kind: kindLabel(r),
                  who: r.byMe ? t('wf.run.by.you') : t('wf.run.by.member'),
                  rows: r.row_count == null ? '—' : fmt.number(r.row_count),
                })}
                {r.duration_ms ? <> · {fmt.number(r.duration_ms)} ms</> : null}
              </p>
              {codeLabel(r.error_code) && (
                <p className="text-[0.66rem] text-foreground">{codeLabel(r.error_code)}</p>
              )}
              {r.error && hasMessage(r.error) && (
                <p className="text-[0.66rem] text-red-600 dark:text-red-400">
                  {t(r.error as MessageKey)}
                </p>
              )}
              {r.quality && Number(r.quality.checkedRows) > 0 && (
                <p
                  className={`text-[0.66rem] ${Number(r.quality.invalidRows) > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
                >
                  {t('wf.run.dq', {
                    invalid: fmt.number(Number(r.quality.invalidRows)),
                    checked: fmt.number(Number(r.quality.checkedRows)),
                  })}
                </p>
              )}
              {r.node_results && Object.keys(r.node_results).length > 0 && (
                <details className="text-[0.64rem]">
                  <summary className="cursor-pointer text-muted-foreground">
                    {t('wf.run.steps', { count: fmt.number(Object.keys(r.node_results).length) })}
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {Object.entries(r.node_results).map(([id, s]) => (
                      <li
                        key={id}
                        className="flex flex-wrap items-baseline justify-between gap-x-2"
                      >
                        <span
                          className={`truncate ${s.ok ? 'text-foreground' : s.skipped ? 'text-muted-foreground' : 'text-red-600 dark:text-red-400'}`}
                        >
                          {nodeLabels[id] ?? t('wf.run.removedStep')}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {s.skipped
                            ? t('wf.run.skipped')
                            : s.rows != null
                              ? t('wf.rowsCount', { count: fmt.number(s.rows) })
                              : ''}
                          {s.ms ? <> · {fmt.number(s.ms)} ms</> : null}
                        </span>
                        {!s.ok && !s.skipped && s.error?.key && hasMessage(s.error.key) && (
                          <span className="basis-full text-red-600 dark:text-red-400">
                            {t(s.error.key as MessageKey, s.error.vars)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {r.status === 'running' && r.byMe && !r.cancel_requested_at && (
                <button
                  type="button"
                  className="text-[0.66rem] text-muted-foreground hover:text-foreground underline underline-offset-2"
                  onClick={async () => {
                    await cancelRun(workflowId, { runId: r.id }).catch(() => undefined);
                    setReload((n) => n + 1);
                  }}
                >
                  {t('wf.run.cancel')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
