'use client';

import React from 'react';
import { X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { hasMessage } from '@/lib/i18n/labels';
import { TerminalApiError } from '@/lib/terminal/client';

export const inputCls =
  'w-full rounded-lg border border-border bg-input px-2.5 py-1.5 text-[0.78rem] text-foreground outline-none focus:border-foreground/40 disabled:opacity-60';
export const buttonCls =
  'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[0.72rem] font-medium border border-border hover:bg-[var(--surface-3)] transition-colors disabled:opacity-50';
export const primaryCls =
  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.78rem] font-medium bg-primary text-primary-foreground disabled:opacity-50';

type T = ReturnType<typeof useI18n>['t'];

/** A TERMINAL error code as text. */
export function errorMessage(error: unknown, t: T): string {
  if (error instanceof TerminalApiError) {
    const key = `ps.err.${error.code}`;
    if (hasMessage(key)) return t(key as any, error.vars as any);
  }
  return t('ps.err.failed');
}

export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      className="overlay-mobile fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className={`w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-card p-5 space-y-4`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[1rem] font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const TONES: Record<string, string> = {
  ready: 'bg-green-500/15 text-green-700 dark:text-green-400',
  succeeded: 'bg-green-500/15 text-green-700 dark:text-green-400',
  success: 'bg-green-500/15 text-green-700 dark:text-green-400',
  committed: 'bg-green-500/15 text-green-700 dark:text-green-400',
  analyzed: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  failed: 'bg-red-500/15 text-red-700 dark:text-red-400',
  cancelled: 'bg-[var(--surface-3)] text-muted-foreground',
};

/** A status as a small coloured label. */
export function Status({ value }: { value: string }) {
  const { t } = useI18n();
  const key = `ps.status.${value}`;
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-[0.62rem] font-medium ${TONES[value] ?? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'}`}
    >
      {hasMessage(key) ? t(key as any) : value}
    </span>
  );
}

export function Empty({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: React.ElementType;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-10 text-center">
      <Icon size={30} className="mx-auto text-muted-foreground mb-3 opacity-40" />
      <p className="text-[0.85rem] text-foreground font-medium mb-1">{title}</p>
      {hint && <p className="text-[0.75rem] text-muted-foreground mb-4">{hint}</p>}
      {action}
    </div>
  );
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
