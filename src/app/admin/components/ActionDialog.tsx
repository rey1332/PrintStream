'use client';

import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';

export interface ActionDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  /** A text box: its label and the minimum length (trimmed). */
  note?: { label: string; minLength: number };
  /** A checkbox, off by default. */
  option?: { label: string };
  /** A text the admin must type again (compared ignoring case) before confirming. */
  confirmText?: { label: string; expected: string };
  /** Resolves to an error message to show, or null when done. */
  onConfirm: (input: { note: string; option: boolean; typed: string }) => Promise<string | null>;
  onClose: () => void;
}

export function ActionDialog({
  title,
  description,
  confirmLabel,
  danger = false,
  note,
  option,
  confirmText,
  onConfirm,
  onClose,
}: ActionDialogProps) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready =
    (!note || text.trim().length >= note.minLength) &&
    (!confirmText || typed.trim().toLowerCase() === confirmText.expected.toLowerCase());

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    const problem = await onConfirm({ note: text.trim(), option: checked, typed: typed.trim() });
    setBusy(false);
    if (problem) setError(problem);
    else onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="action-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-4 rounded-xl border border-border bg-card p-5 shadow-lg"
      >
        <h2 id="action-title" className="text-[0.9rem] font-semibold text-foreground">
          {title}
        </h2>
        <p className="text-[0.78rem] text-muted-foreground">{description}</p>
        {note && (
          <label className="block space-y-1">
            <span className="text-[0.75rem] text-muted-foreground">{note.label}</span>
            <textarea
              autoFocus
              rows={3}
              maxLength={500}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[0.82rem] text-foreground outline-none focus:border-foreground/40"
            />
          </label>
        )}
        {confirmText && (
          <label className="block space-y-1">
            <span className="text-[0.75rem] text-muted-foreground">{confirmText.label}</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={320}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[0.82rem] text-foreground outline-none focus:border-foreground/40"
            />
          </label>
        )}
        {option && (
          <label className="flex items-start gap-2 text-[0.78rem] text-foreground">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5"
            />
            {option.label}
          </label>
        )}
        {error && (
          <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-border px-3 py-1.5 text-[0.78rem] text-muted-foreground hover:text-foreground max-lg:min-h-11"
          >
            {t('padmin.reauth.cancel')}
          </button>
          <button
            type="submit"
            disabled={!ready || busy}
            className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-[0.78rem] font-medium disabled:opacity-50 max-lg:min-h-11 ${
              danger ? 'bg-red-600 text-white' : 'bg-primary text-primary-foreground'
            }`}
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
