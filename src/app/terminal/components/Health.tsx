'use client';

// The overview's "needs attention" panel: the background worker, pipelines
// whose last run failed, schedules that are late or stopped, failing syncs
// and datasets that should have changed and did not. Each says where to go.

import React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  GitBranch,
  PlugZap,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { hasMessage } from '@/lib/i18n/labels';
import type { TerminalHealth } from '@/lib/terminal/client';

type Tab = 'pipelines' | 'connections' | 'jobs' | 'datasets';

interface Item {
  key: string;
  icon: React.ElementType;
  tone: 'bad' | 'warn';
  title: string;
  detail?: string;
  href?: string;
  tab?: Tab;
}

export function HealthPanel({
  health,
  onTab,
}: {
  health: TerminalHealth;
  onTab: (tab: Tab) => void;
}) {
  const { t, fmt } = useI18n();
  const err = (key: string | null) => {
    if (!key) return undefined;
    const k = `ps.err.${key}`;
    return hasMessage(k) ? t(k as never) : t('ps.job.error', { code: key });
  };
  const items: Item[] = [];

  if (
    !health.workerOnline &&
    (health.waitingJobs > 0 || health.runningJobs > 0 || health.lateSchedules.length > 0)
  ) {
    items.push({
      key: 'worker',
      icon: Cpu,
      tone: 'bad',
      title: t('ps.health.workerOffline', { n: health.waitingJobs }),
      detail: health.workerSeenAt
        ? t('ps.health.workerSeen', { when: fmt.dateTime(health.workerSeenAt) })
        : t('ps.health.workerNever'),
      tab: 'jobs',
    });
  } else if (health.waitingJobs > 0) {
    items.push({
      key: 'waiting',
      icon: Clock,
      tone: 'warn',
      title: t('ps.health.waiting', { n: health.waitingJobs }),
      detail: t('ps.health.waitingHint'),
      tab: 'jobs',
    });
  }
  for (const p of health.failingPipelines)
    items.push({
      key: `p-${p.id}`,
      icon: GitBranch,
      tone: 'bad',
      title: t('ps.health.pipelineFailed', { name: p.name }),
      detail: [p.at ? fmt.dateTime(p.at) : null, err(p.errorCode)].filter(Boolean).join(' · '),
      href: `/pipelines/${p.id}`,
    });
  for (const s of health.lateSchedules)
    items.push({
      key: `l-${s.id}`,
      icon: Clock,
      tone: 'warn',
      title: t('ps.health.scheduleLate', { name: s.name }),
      detail: s.due ? t('ps.health.due', { when: fmt.dateTime(s.due) }) : undefined,
      tab: 'pipelines',
    });
  for (const s of health.stoppedSchedules)
    items.push({
      key: `s-${s.id}`,
      icon: Clock,
      tone: 'bad',
      title: t('ps.health.scheduleStopped', { name: s.name }),
      detail: hasMessage(`ps.health.stopped.${s.reason}`)
        ? t(`ps.health.stopped.${s.reason}` as never)
        : s.reason,
      tab: 'pipelines',
    });
  for (const y of health.failingSyncs)
    items.push({
      key: `y-${y.id}`,
      icon: PlugZap,
      tone: y.enabled ? 'warn' : 'bad',
      title: y.enabled
        ? t('ps.health.syncFailing', { connection: y.connection, object: y.object })
        : t('ps.health.syncStopped', { connection: y.connection, object: y.object }),
      detail: [y.streak > 1 ? t('ps.health.streak', { n: y.streak }) : null, err(y.errorKey)]
        .filter(Boolean)
        .join(' · '),
      tab: 'connections',
    });
  for (const d of health.staleDatasets)
    items.push({
      key: `d-${d.id}`,
      icon: Database,
      tone: 'warn',
      title: t('ps.health.stale', { name: d.name }),
      detail: d.updatedAt ? t('ps.health.changed', { when: fmt.date(d.updatedAt) }) : undefined,
      href: `/terminal/datasets/${d.id}`,
    });

  const { succeeded, failed, cancelled } = health.last24h;
  return (
    <section
      className="rounded-xl border border-border bg-card p-4 space-y-3"
      aria-label={t('ps.health.title')}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[0.85rem] font-semibold text-foreground">{t('ps.health.title')}</h2>
        <p className="text-[0.7rem] text-muted-foreground">
          {t('ps.health.last24h', { ok: succeeded, failed, cancelled })}
          {' · '}
          {health.workerOnline ? t('ps.health.workerOnline') : t('ps.health.workerIdle')}
        </p>
      </div>
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-[0.78rem] text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 size={15} /> {t('ps.health.allGood')}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((i) => {
            const body = (
              <>
                <i.icon
                  size={15}
                  className={`mt-0.5 shrink-0 ${i.tone === 'bad' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}
                />
                <span className="min-w-0">
                  <span className="block text-[0.78rem] text-foreground">{i.title}</span>
                  {i.detail && (
                    <span className="block text-[0.68rem] text-muted-foreground">{i.detail}</span>
                  )}
                </span>
              </>
            );
            const cls = 'flex w-full items-start gap-2 py-2 text-left hover:opacity-80';
            return (
              <li key={i.key}>
                {i.href ? (
                  <Link href={i.href} className={cls}>
                    {body}
                  </Link>
                ) : (
                  <button type="button" className={cls} onClick={() => i.tab && onTab(i.tab)}>
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {items.length > 0 && (
        <p className="flex items-center gap-1.5 text-[0.66rem] text-muted-foreground">
          <AlertTriangle size={11} /> {t('ps.health.hint')}
        </p>
      )}
    </section>
  );
}
