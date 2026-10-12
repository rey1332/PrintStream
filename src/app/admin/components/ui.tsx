'use client';

import React from 'react';
import { useI18n } from '@/lib/i18n/I18nProvider';

export function Section({
  title,
  icon: Icon,
  actions,
  children,
}: {
  title: string;
  icon?: React.ElementType;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        {Icon && <Icon size={14} className="text-muted-foreground" />}
        <h2 className="text-[0.85rem] font-semibold text-foreground">{title}</h2>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

const TONES = {
  neutral: 'border-border text-muted-foreground',
  good: 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400',
  warn: 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400',
  bad: 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-400',
} as const;

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: keyof typeof TONES;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.68rem] font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Pager({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  const { t } = useI18n();
  if (total <= limit) return null;
  const button =
    'rounded-lg border border-border px-3 py-1.5 text-[0.75rem] text-muted-foreground hover:text-foreground disabled:opacity-40 max-lg:min-h-11';
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
      <span className="text-[0.75rem] text-muted-foreground">
        {t('padmin.pager.range', {
          from: offset + 1,
          to: Math.min(offset + limit, total),
          total,
        })}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(offset - limit, 0))}
          className={button}
        >
          {t('padmin.pager.previous')}
        </button>
        <button
          type="button"
          disabled={offset + limit >= total}
          onClick={() => onChange(offset + limit)}
          className={button}
        >
          {t('padmin.pager.next')}
        </button>
      </div>
    </div>
  );
}

export function Facts({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 px-5 py-4 text-[0.8rem] sm:grid-cols-[max-content_1fr]">
      {items.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-foreground">{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export const fieldCls =
  'rounded-lg border border-border bg-background px-3 py-2 text-[0.8rem] text-foreground outline-none focus:border-foreground/40';

export const buttonCls =
  'inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[0.75rem] text-foreground hover:bg-[var(--surface-2)] disabled:opacity-50 max-lg:min-h-11';

export const tableCls = 'w-full text-left text-[0.78rem]';
export const theadCls = 'border-b border-border text-[0.72rem] text-muted-foreground';
export const rowCls = 'border-b border-border/60 last:border-0';
