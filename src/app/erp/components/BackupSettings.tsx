'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { DatabaseBackup, Loader2, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { isServerAdmin } from '@/lib/auth/serverAdmin';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';

interface BackupFile {
  name: string;
  size: number;
  createdAt: string;
  label: string;
}

interface State {
  configured: boolean;
  dir: string;
  backups: BackupFile[];
}

const ERRORS: Record<string, MessageKey> = {
  wrong_password: 'settings.wrongPassword',
  rate_limited: 'password.err.rateLimited',
  invalid: 'backup.err.confirm',
  forbidden: 'backup.err.forbidden',
  busy: 'backup.err.busy',
};

export function BackupSettings({ inputClassName }: { inputClassName: string }) {
  const { t, fmt } = useI18n();
  const [admin, setAdmin] = useState(false);
  // A listed administrator without two-factor: backups need it.
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState<BackupFile | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const load = useCallback(async () => {
    try {
      // Only the server's administrators are told about (and ask for) this.
      if (!(await isServerAdmin())) return;
      const response = await fetch('/api/admin/backup', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) return;
      setAdmin(result.data.admin === true);
      setNeedsTwoFactor(result.data.needsTwoFactor === true);
      if (result.data.admin) setState(result.data as State);
    } catch {
      // Not shown when it cannot be loaded.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    const response = await fetch('/api/admin/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => null);
    return { ok: response.ok && result?.success === true, result };
  }

  async function backupNow() {
    setBusy(true);
    setError('');
    try {
      const { ok, result } = await post({ action: 'backup' });
      if (!ok) {
        setError(result?.detail || t(ERRORS[result?.error as string] ?? 'backup.err.failed'));
        return;
      }
      toast.success(t('backup.done', { name: result.data.backup?.name ?? '' }));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function restoreNow(event: React.FormEvent) {
    event.preventDefault();
    if (!restoring || busy) return;
    setBusy(true);
    setError('');
    try {
      const { ok, result } = await post({
        action: 'restore',
        name: restoring.name,
        password,
        confirm,
      });
      if (!ok) {
        setError(result?.detail || t(ERRORS[result?.error as string] ?? 'backup.err.failed'));
        return;
      }
      toast.success(t('backup.restored', { name: restoring.name }));
      setRestoring(null);
      // Everything changed, including sign-ins: start again.
      setTimeout(() => window.location.assign('/erp'), 1500);
    } finally {
      setBusy(false);
      setPassword('');
    }
  }

  if (needsTwoFactor)
    return (
      <section className="rounded-xl border border-border bg-card px-5 py-4">
        <div className="flex items-center gap-2">
          <DatabaseBackup size={14} className="text-muted-foreground" />
          <h2 className="text-[0.85rem] font-semibold text-foreground">{t('backup.title')}</h2>
        </div>
        <p className="mt-1 text-[0.75rem] text-muted-foreground">{t('backup.needsTwoFactor')}</p>
      </section>
    );

  if (!admin || !state) return null;

  return (
    <section className="rounded-xl border border-border overflow-hidden bg-card">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <DatabaseBackup size={14} className="text-muted-foreground" />
          <div>
            <h2 className="text-[0.85rem] font-semibold text-foreground">{t('backup.title')}</h2>
            <p className="text-[0.72rem] text-muted-foreground">{t('backup.subtitle')}</p>
          </div>
        </div>
        {state.configured && (
          <button
            type="button"
            onClick={() => void backupNow()}
            disabled={busy}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[0.78rem] font-medium bg-primary text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
          >
            {busy && !restoring ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <DatabaseBackup size={13} />
            )}
            {t('backup.now')}
          </button>
        )}
      </div>
      <div className="p-5 space-y-3">
        {!state.configured ? (
          <div className="space-y-2 text-[0.8rem] text-muted-foreground">
            <p>{t('backup.notSetUp')}</p>
            <code className="block rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[0.78rem] text-foreground">
              npm run db:backup -- setup
            </code>
          </div>
        ) : (
          <>
            <p className="text-[0.75rem] text-muted-foreground">
              {t('backup.folder')}: <span className="font-mono text-foreground">{state.dir}</span>
              {' · '}
              {t('backup.auto')}
            </p>
            {state.backups.length === 0 ? (
              <p className="text-[0.8rem] text-muted-foreground">{t('backup.none')}</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-[0.78rem]">
                  <tbody>
                    {state.backups.map((b) => (
                      <tr key={b.name} className="border-b border-border last:border-b-0">
                        <td className="px-3 py-2 whitespace-nowrap">{fmt.dateTime(b.createdAt)}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {t(`backup.kind.${b.label}` as MessageKey)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {fmt.number(b.size / 1048576, { maximumFractionDigits: 1 })} MB
                        </td>
                        <td className="px-2 py-1 text-right">
                          <button
                            type="button"
                            onClick={() => {
                              setError('');
                              setConfirm('');
                              setPassword('');
                              setRestoring(b);
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[0.72rem] text-muted-foreground hover:text-red-600 max-lg:min-h-11"
                          >
                            <RotateCcw size={12} /> {t('backup.restore')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {error && !restoring && (
          <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>

      {restoring && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setRestoring(null);
          }}
        >
          <form
            onSubmit={restoreNow}
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-title"
            className="w-full max-w-md rounded-2xl border border-border bg-card p-5 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h2 id="restore-title" className="text-[1rem] font-semibold text-foreground">
                {t('backup.restoreTitle')}
              </h2>
              <button
                type="button"
                onClick={() => setRestoring(null)}
                disabled={busy}
                aria-label={t('common.close')}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            <p className="text-[0.8rem] text-muted-foreground">
              {t('backup.restoreBody', { date: fmt.dateTime(restoring.createdAt) })}
            </p>
            <label className="block">
              <span className="mb-1 block text-[0.72rem] text-muted-foreground">
                {t('backup.typeRestore')}
              </span>
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="RESTORE"
                className={inputClassName}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[0.72rem] text-muted-foreground">
                {t('settings.enterPassword')}
              </span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClassName}
              />
            </label>
            {error && (
              <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || confirm !== 'RESTORE' || !password}
              className="flex w-full items-center justify-center gap-2 py-2 rounded-lg text-[0.8rem] font-medium bg-red-600 text-white disabled:opacity-50"
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              {busy ? t('backup.restoring') : t('backup.restore')}
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
