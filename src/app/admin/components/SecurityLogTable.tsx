'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { ACTOR_KIND_LABEL, EVENT_LABEL } from './labels';

export interface SecurityEvent {
  id: string;
  occurred_at: string;
  event_type: string;
  outcome: 'success' | 'failure';
  actor_kind: string;
  actor_email: string | null;
  target_email: string | null;
  workspace_id: string | null;
  session_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

export function SecurityLogTable({ events }: { events: SecurityEvent[] }) {
  const { t, fmt } = useI18n();
  const [open, setOpen] = useState<string | null>(null);

  const when = (value: string) => fmt.date(value, { dateStyle: 'medium', timeStyle: 'medium' });
  const label = (type: string) => (EVENT_LABEL[type] ? t(EVENT_LABEL[type]) : type);
  const actor = (e: SecurityEvent) =>
    e.actor_kind === 'user'
      ? (e.actor_email ?? '—')
      : `${t(ACTOR_KIND_LABEL[e.actor_kind] ?? 'padmin.log.actorKind.system')}: ${e.actor_email ?? '—'}`;

  if (events.length === 0)
    return <p className="px-5 py-6 text-[0.8rem] text-muted-foreground">{t('padmin.log.empty')}</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-[0.78rem]">
        <thead className="border-b border-border text-[0.72rem] text-muted-foreground">
          <tr>
            <th className="w-6 px-3 py-2" />
            <th className="px-3 py-2 font-medium">{t('padmin.log.col.time')}</th>
            <th className="px-3 py-2 font-medium">{t('padmin.log.col.event')}</th>
            <th className="px-3 py-2 font-medium">{t('padmin.log.col.actor')}</th>
            <th className="px-3 py-2 font-medium">{t('padmin.log.col.target')}</th>
            <th className="px-3 py-2 font-medium">{t('padmin.log.col.ip')}</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const expanded = open === e.id;
            return (
              <React.Fragment key={e.id}>
                <tr
                  onClick={() => setOpen(expanded ? null : e.id)}
                  className="cursor-pointer border-b border-border/60 hover:bg-[var(--surface-2)]"
                >
                  <td className="px-3 py-2 text-muted-foreground">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-label={t('padmin.log.details')}
                      className="flex items-center"
                    >
                      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {when(e.occurred_at)}
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2 text-foreground">
                      <span
                        aria-hidden
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          e.outcome === 'failure' ? 'bg-red-500' : 'bg-emerald-500'
                        }`}
                      />
                      {label(e.event_type)}
                      {e.outcome === 'failure' && (
                        <span className="sr-only">{t('padmin.log.outcome.failure')}</span>
                      )}
                    </span>
                  </td>
                  <td className="max-w-[220px] truncate px-3 py-2 text-foreground">{actor(e)}</td>
                  <td className="max-w-[220px] truncate px-3 py-2 text-foreground">
                    {e.target_email ??
                      (typeof e.metadata?.workspace_name === 'string'
                        ? e.metadata.workspace_name
                        : '—')}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[0.72rem] text-muted-foreground">
                    {e.ip ?? '—'}
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-b border-border/60 bg-[var(--surface-2)]">
                    <td />
                    <td colSpan={5} className="px-3 py-3">
                      <dl className="grid gap-x-6 gap-y-1.5 text-[0.75rem] sm:grid-cols-[auto_1fr]">
                        <dt className="text-muted-foreground">{t('padmin.log.col.event')}</dt>
                        <dd className="font-mono text-foreground">{e.event_type}</dd>
                        <dt className="text-muted-foreground">{t('padmin.log.session')}</dt>
                        <dd className="font-mono text-foreground">{e.session_id ?? '—'}</dd>
                        <dt className="text-muted-foreground">{t('padmin.log.workspace')}</dt>
                        <dd className="font-mono text-foreground">{e.workspace_id ?? '—'}</dd>
                        <dt className="text-muted-foreground">{t('padmin.log.device')}</dt>
                        <dd className="break-all text-foreground">{e.user_agent ?? '—'}</dd>
                        <dt className="text-muted-foreground">{t('padmin.log.details')}</dt>
                        <dd>
                          <pre className="whitespace-pre-wrap break-all font-mono text-[0.72rem] text-foreground">
                            {JSON.stringify(e.metadata, null, 2)}
                          </pre>
                        </dd>
                      </dl>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
