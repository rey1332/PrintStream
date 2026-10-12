'use client';

// Small form pieces shared by the industry modules (weighbridge, production, equipment).

import React from 'react';
import { X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';

export const inputCls =
  'w-full rounded-lg border border-border bg-[var(--input,transparent)] px-3 py-2 text-[0.8rem] text-foreground outline-none focus:border-foreground/40';

/** Today as YYYY-MM-DD in the browser's time zone (the site's day, not UTC). */
export function todayIso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The message of a module service error (WeighError, ProductionError, …), else `fallback`. */
export function errorKey(error: unknown, fallback: MessageKey = 'wb.err.failed'): MessageKey {
  const key = (error as { key?: unknown } | null)?.key;
  return typeof key === 'string' && key.includes('.') ? (key as MessageKey) : fallback;
}

export function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1 block text-[0.7rem] text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[0.68rem] text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function Dialog({
  title,
  onClose,
  onSubmit,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} max-h-[90dvh] overflow-y-auto rounded-2xl border border-border bg-card p-5 space-y-4`}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[1rem] font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1 text-muted-foreground hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </form>
    </div>
  );
}

export function DialogButtons({
  busy,
  disabled,
  label,
  onCancel,
}: {
  busy: boolean;
  disabled?: boolean;
  label: string;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border max-lg:min-h-11"
      >
        {t('common.cancel')}
      </button>
      <button
        type="submit"
        disabled={busy || disabled}
        className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
      >
        {busy ? t('common.saving') : label}
      </button>
    </div>
  );
}

export function FormError({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="text-[0.78rem] text-red-600 dark:text-red-400" role="alert">
      {text}
    </p>
  );
}
