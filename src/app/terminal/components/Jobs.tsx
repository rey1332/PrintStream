'use client';

// The Terminal's jobs: repeated ones folded into one line (×8), why a job
// failed or was cancelled, run again, and filters for the Jobs tab.

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { hasMessage } from '@/lib/i18n/labels';
import type { JobSummary } from '@/lib/terminal/client';
import { canRetry, filterJobs, groupJobs, kindFamilies, type JobFilter } from '@/lib/terminal/jobs';
import { Status } from './shared';

type T = ReturnType<typeof useI18n>['t'];

/** Why a job ended as it did, in words where we have them. */
export function jobReason(job: JobSummary, t: T): string | null {
  if (job.status === 'cancelled') {
    if (job.cancelled_by_email)
      return job.mine && job.cancelled_by === job.created_by
        ? t('ps.job.cancelledByYou')
        : t('ps.job.cancelledBy', { who: job.cancelled_by_email });
    if (job.error_key === 'cancelled_by_user') return t('ps.job.cancelledByUser');
  }
  if (!job.error_key || job.error_key === 'cancelled_by_user') return null;
  const key = `ps.err.${job.error_key}`;
  return hasMessage(key) ? t(key as never) : t('ps.job.error', { code: job.error_key });
}

export function JobList({
  jobs,
  datasetName,
  pipelineName,
  onCancel,
  onRetry,
  canRetryJob = () => true,
}: {
  jobs: JobSummary[];
  datasetName: Map<string, string>;
  pipelineName: Map<string, string>;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  /** Whether this member may start the job's kind again. */
  canRetryJob?: (job: JobSummary) => boolean;
}) {
  const { t, fmt } = useI18n();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = useMemo(() => groupJobs(jobs), [jobs]);
  if (!jobs.length)
    return <p className="text-[0.75rem] text-muted-foreground">{t('ps.job.empty')}</p>;

  const line = (j: JobSummary, count: number, nested = false) => {
    const what = j.pipeline_id
      ? pipelineName.get(j.pipeline_id)
      : j.dataset_id
        ? datasetName.get(j.dataset_id)
        : null;
    const reason = jobReason(j, t);
    const failed = j.status === 'failed';
    return (
      <div className={`flex flex-wrap items-center gap-2 text-[0.75rem] ${nested ? 'pl-6' : ''}`}>
        {count > 1 ? (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            aria-expanded={open.has(j.id)}
            aria-label={t('ps.job.showAll', { n: count })}
            onClick={() =>
              setOpen((s) => {
                const next = new Set(s);
                if (next.has(j.id)) next.delete(j.id);
                else next.add(j.id);
                return next;
              })
            }
          >
            {open.has(j.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          !nested && <span className="w-[13px]" />
        )}
        <Status value={j.status} />
        <span className="text-foreground">
          {hasMessage(`ps.job.kind.${j.kind}`) ? t(`ps.job.kind.${j.kind}` as never) : j.kind}
        </span>
        {count > 1 && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.62rem] font-medium tabular-nums text-muted-foreground">
            ×{count}
          </span>
        )}
        {what && <span className="max-w-[14rem] truncate text-muted-foreground">{what}</span>}
        {j.trigger !== 'manual' && (
          <span className="text-[0.62rem] text-muted-foreground">
            {t(`ps.job.trigger.${j.trigger}` as never)}
          </span>
        )}
        {j.retry_of && (
          <span className="text-[0.62rem] text-muted-foreground">{t('ps.job.retried')}</span>
        )}
        {failed && j.attempts > 1 && (
          <span className="text-[0.62rem] text-muted-foreground">
            {t('ps.job.attempts', { n: j.attempts, max: j.max_attempts })}
          </span>
        )}
        {reason && (
          <span
            className={`text-[0.68rem] ${failed ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
          >
            {reason}
          </span>
        )}
        <span className="ml-auto text-[0.66rem] text-muted-foreground">
          {count > 1 && !open.has(j.id)
            ? t('ps.job.lastOf', { when: fmt.dateTime(j.finished_at ?? j.created_at) })
            : fmt.dateTime(j.finished_at ?? j.started_at ?? j.created_at)}
        </span>
        {(j.status === 'queued' || j.status === 'running') && (
          <button
            type="button"
            className="text-[0.66rem] text-muted-foreground hover:text-red-500"
            onClick={() => onCancel(j.id)}
          >
            {t('ps.job.cancel')}
          </button>
        )}
        {!nested && canRetry(j) && canRetryJob(j) && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[0.66rem] text-muted-foreground hover:text-foreground"
            onClick={() => onRetry(j.id)}
          >
            <RotateCcw size={11} /> {t('ps.job.retry')}
          </button>
        )}
      </div>
    );
  };

  return (
    <ul className="divide-y divide-border">
      {groups.map((g) => (
        <li key={g.job.id} className="space-y-1.5 py-2">
          {line(g.job, g.jobs.length)}
          {g.jobs.length > 1 &&
            open.has(g.job.id) &&
            g.jobs.slice(1).map((j) => <div key={j.id}>{line(j, 1, true)}</div>)}
        </li>
      ))}
    </ul>
  );
}

const STATUS_FILTERS: JobFilter['status'][] = ['all', 'problems', 'active', 'succeeded'];

/** The Jobs tab: filters, then the list. */
export function JobsPanel(props: React.ComponentProps<typeof JobList>) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<JobFilter>({ status: 'all', kind: 'all' });
  const families = useMemo(() => kindFamilies(props.jobs), [props.jobs]);
  const shown = useMemo(() => filterJobs(props.jobs, filter), [props.jobs, filter]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t('ps.job.filter')}>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={filter.status === s}
              onClick={() => setFilter((f) => ({ ...f, status: s }))}
              className={`rounded-full border px-3 py-1 text-[0.7rem] ${
                filter.status === s
                  ? 'border-foreground text-foreground'
                  : 'border-border text-muted-foreground'
              }`}
            >
              {t(`ps.job.filter.${s}` as never)}
            </button>
          ))}
        </div>
        {families.length > 1 && (
          <select
            aria-label={t('ps.job.kindFilter')}
            className="rounded-lg border border-border bg-[var(--input,transparent)] px-2 py-1 text-[0.72rem] text-foreground"
            value={filter.kind}
            onChange={(e) => setFilter((f) => ({ ...f, kind: e.target.value }))}
          >
            <option value="all">{t('ps.job.kindAll')}</option>
            {families.map((k) => (
              <option key={k} value={k}>
                {hasMessage(`ps.job.family.${k}`) ? t(`ps.job.family.${k}` as never) : k}
              </option>
            ))}
          </select>
        )}
        <span className="ml-auto text-[0.68rem] text-muted-foreground">
          {t('ps.job.shown', { n: shown.length, total: props.jobs.length })}
        </span>
      </div>
      <JobList {...props} jobs={shown} />
    </div>
  );
}
