'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, ScrollText, Search } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { ExportButton } from '../components/AccountPanels';
import { adminGet } from '../components/api';
import { EVENT_LABEL } from '../components/labels';
import { SecurityLogTable, type SecurityEvent } from '../components/SecurityLogTable';

const PAGE = 50;

interface Filters {
  q: string;
  type: string;
  outcome: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { q: '', type: '', outcome: '', from: '', to: '' };

// Links from elsewhere in the panel (e.g. the dashboard) may open the log
// filtered: ?q=<e-mail or IP>&type=<event>&outcome=<success|failure>.
function fromAddress(): Filters {
  const params = new URLSearchParams(window.location.search);
  const type = params.get('type') ?? '';
  const outcome = params.get('outcome') ?? '';
  return {
    ...EMPTY,
    q: (params.get('q') ?? '').slice(0, 320),
    type: EVENT_LABEL[type] ? type : '',
    outcome: outcome === 'success' || outcome === 'failure' ? outcome : '',
  };
}

// Dates are picked in the browser's time zone; "until" includes that whole day.
function query(filters: Filters, before: string | null): string {
  const params = new URLSearchParams({ limit: String(PAGE) });
  if (before) params.set('before', before);
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.type) params.set('type', filters.type);
  if (filters.outcome) params.set('outcome', filters.outcome);
  if (filters.from) params.set('from', new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) {
    const end = new Date(`${filters.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    params.set('to', end.toISOString());
  }
  return `/api/admin/platform/events?${params}`;
}

// The same filters for a CSV export (POST body instead of a query string).
function exportBody(filters: Filters): Record<string, unknown> {
  const params = new URL(query(filters, null), 'http://x').searchParams;
  return {
    kind: 'security-log',
    q: params.get('q'),
    type: params.get('type'),
    outcome: params.get('outcome'),
    from: params.get('from'),
    to: params.get('to'),
  };
}

const fieldCls =
  'rounded-lg border border-border bg-background px-3 py-2 text-[0.8rem] text-foreground outline-none focus:border-foreground/40';

export default function SecurityLogPage() {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters | null>(null);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (applied: Filters, before: string | null) => {
    setLoading(true);
    setFailed(false);
    const result = await adminGet<{ events: SecurityEvent[] }>(query(applied, before));
    setLoading(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    setEvents((current) => (before ? [...current, ...result.data.events] : result.data.events));
    setMore(result.data.events.length === PAGE);
  }, []);

  useEffect(() => {
    const initial = fromAddress();
    setDraft(initial);
    setFilters(initial);
  }, []);

  useEffect(() => {
    if (filters) void load(filters, null);
  }, [filters, load]);

  const set =
    (key: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setDraft((d) => ({ ...d, [key]: e.target.value }));

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-5 py-4">
        <ScrollText size={14} className="text-muted-foreground" />
        <div>
          <h1 className="text-[0.9rem] font-semibold text-foreground">
            {t('padmin.nav.securityLog')}
          </h1>
          <p className="text-[0.72rem] text-muted-foreground">{t('padmin.log.subtitle')}</p>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(draft);
        }}
        className="flex flex-wrap items-end gap-2 border-b border-border px-5 py-3"
      >
        <label className="relative min-w-[200px] flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={draft.q}
            onChange={set('q')}
            maxLength={320}
            placeholder={t('padmin.log.search')}
            aria-label={t('padmin.log.search')}
            className={`${fieldCls} w-full pl-8`}
          />
        </label>
        <select
          value={draft.type}
          onChange={set('type')}
          aria-label={t('padmin.log.col.event')}
          className={fieldCls}
        >
          <option value="">{t('padmin.log.allEvents')}</option>
          {Object.entries(EVENT_LABEL).map(([type, key]) => (
            <option key={type} value={type}>
              {t(key)}
            </option>
          ))}
        </select>
        <select
          value={draft.outcome}
          onChange={set('outcome')}
          aria-label={t('padmin.log.allOutcomes')}
          className={fieldCls}
        >
          <option value="">{t('padmin.log.allOutcomes')}</option>
          <option value="success">{t('padmin.log.outcome.success')}</option>
          <option value="failure">{t('padmin.log.outcome.failure')}</option>
        </select>
        <label className="flex flex-col gap-1">
          <span className="text-[0.7rem] text-muted-foreground">{t('padmin.log.from')}</span>
          <input type="date" value={draft.from} onChange={set('from')} className={fieldCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[0.7rem] text-muted-foreground">{t('padmin.log.to')}</span>
          <input type="date" value={draft.to} onChange={set('to')} className={fieldCls} />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-primary px-3 py-2 text-[0.78rem] font-medium text-primary-foreground max-lg:min-h-11"
        >
          {t('padmin.log.apply')}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(EMPTY);
            setFilters(EMPTY);
          }}
          className="rounded-lg border border-border px-3 py-2 text-[0.78rem] text-muted-foreground hover:text-foreground max-lg:min-h-11"
        >
          {t('padmin.log.clear')}
        </button>
        <ExportButton body={exportBody(filters ?? EMPTY)} />
      </form>

      {failed && (
        <p role="alert" className="px-5 py-3 text-[0.8rem] text-red-600 dark:text-red-400">
          {t('padmin.log.loadFailed')}
        </p>
      )}
      {(!loading || events.length > 0) && <SecurityLogTable events={events} />}
      <div className="flex justify-center px-5 py-3">
        {loading ? (
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        ) : (
          more && (
            <button
              type="button"
              onClick={() => void load(filters ?? EMPTY, events.at(-1)?.id ?? null)}
              className="rounded-lg border border-border px-3 py-1.5 text-[0.78rem] text-muted-foreground hover:text-foreground max-lg:min-h-11"
            >
              {t('padmin.log.loadMore')}
            </button>
          )
        )}
      </div>
    </section>
  );
}
