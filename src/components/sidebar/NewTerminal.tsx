'use client';

// Creating a PrintStream Terminal on its own (20261012000043): a name, and
// the creator is its Owner. It does not use one of the account's ERP slots.

import React, { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { createClient } from '@/lib/data/client';

type CreateProblem = 'limit' | 'mfa' | 'failed';

/** The new Terminal's id, or what stopped it. */
export async function createTerminal(
  name: string
): Promise<{ id: string } | { problem: CreateProblem }> {
  const { data, error } = await createClient().rpc('erp_create_terminal', { p_name: name });
  if (!error && data) return { id: String(data) };
  const text = error?.message ?? '';
  const problem: CreateProblem = /maximum of/.test(text)
    ? 'limit'
    : /two-factor/i.test(text)
      ? 'mfa'
      : 'failed';
  return { problem };
}

export function NewTerminalForm({
  onCreated,
  autoFocus = false,
}: {
  onCreated: (id: string) => void | Promise<void>;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError('');
    const result = await createTerminal(clean);
    setBusy(false);
    if ('id' in result) {
      setName('');
      await onCreated(result.id);
      return;
    }
    setError(
      t(
        result.problem === 'limit'
          ? 'terminal.create.limit'
          : result.problem === 'mfa'
            ? 'terminal.create.mfa'
            : 'docs.error.failed'
      )
    );
  };

  return (
    <form onSubmit={submit} className="space-y-1.5">
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('terminal.create.placeholder')}
          aria-label={t('terminal.create.title')}
          maxLength={120}
          autoFocus={autoFocus}
          className="min-w-0 flex-1 rounded-[var(--radius)] border border-border bg-transparent px-3 py-2 text-[0.8rem] outline-none focus:border-foreground/40"
        />
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius)] bg-primary px-3 py-2 text-[0.8rem] font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? (
            <Loader2 size={13} className="animate-spin" aria-hidden />
          ) : (
            <Plus size={13} aria-hidden />
          )}
          {t('terminal.create.submit')}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-left text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}

/** A button that opens the form (where there is no room for it until asked). */
export function NewTerminalButton({
  onCreated,
}: {
  onCreated: (id: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <div className="w-full max-w-sm">
        <NewTerminalForm onCreated={onCreated} autoFocus />
      </div>
    );
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[0.78rem] font-medium text-primary-foreground"
    >
      <Plus size={13} aria-hidden /> {t('terminal.create.title')}
    </button>
  );
}
