'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, UserPlus, Users } from 'lucide-react';
import { isServerAdmin } from '@/lib/auth/serverAdmin';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';

interface Account {
  email: string;
  full_name: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  locked: boolean;
  devices_2fa: number;
  active_sessions: number;
}

const ERRORS: Record<string, MessageKey> = {
  invalid_email: 'users.err.invalidEmail',
  exists: 'users.err.exists',
  forbidden: 'users.err.forbidden',
};

export function UserAdminSettings({ inputClassName }: { inputClassName: string }) {
  const { t, fmt } = useI18n();
  const [admin, setAdmin] = useState(false);
  // A listed administrator without two-factor: managing accounts needs it.
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [users, setUsers] = useState<Account[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Shown once, then dropped from memory.
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      // Only the server's administrators are told about (and ask for) this.
      if (!(await isServerAdmin())) return;
      const response = await fetch('/api/admin/users', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) return;
      setAdmin(result.data.admin === true);
      setNeedsTwoFactor(result.data.needsTwoFactor === true);
      if (result.data.admin) {
        setConfigured(result.data.configured !== false);
        setUsers(result.data.users as Account[]);
      }
    } catch {
      // Not shown when it cannot be loaded.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setCreated(null);
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', email, name }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success) {
        setError(t(ERRORS[result?.error as string] ?? 'users.err.failed'));
        return;
      }
      setCreated({ email: result.data.email, password: result.data.temporaryPassword });
      setCopied(false);
      setEmail('');
      setName('');
      await load();
    } catch {
      setError(t('users.err.failed'));
    } finally {
      setBusy(false);
    }
  }

  async function copyPassword() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.password);
      setCopied(true);
    } catch {
      // The password is still on screen to copy by hand.
    }
  }

  if (needsTwoFactor)
    return (
      <section className="rounded-xl border border-border bg-card px-5 py-4">
        <div className="flex items-center gap-2">
          <Users size={14} className="text-muted-foreground" />
          <h2 className="text-[0.85rem] font-semibold text-foreground">{t('users.title')}</h2>
        </div>
        <p className="mt-1 text-[0.75rem] text-muted-foreground">{t('users.needsTwoFactor')}</p>
      </section>
    );

  if (!admin) return null;

  return (
    <section className="rounded-xl border border-border overflow-hidden bg-card">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Users size={14} className="text-muted-foreground" />
        <div>
          <h2 className="text-[0.85rem] font-semibold text-foreground">{t('users.title')}</h2>
          <p className="text-[0.72rem] text-muted-foreground">{t('users.subtitle')}</p>
        </div>
      </div>
      <div className="p-5 space-y-4">
        {!configured ? (
          <div className="space-y-2 text-[0.8rem] text-muted-foreground">
            <p>{t('users.notSetUp')}</p>
            <code className="block rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[0.78rem] text-foreground">
              npm run db:backup -- setup
            </code>
          </div>
        ) : (
          <>
            <form
              onSubmit={createAccount}
              className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            >
              <label className="block space-y-1">
                <span className="text-[0.75rem] text-muted-foreground">{t('users.email')}</span>
                <input
                  type="email"
                  required
                  maxLength={254}
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClassName}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[0.75rem] text-muted-foreground">{t('users.name')}</span>
                <input
                  type="text"
                  maxLength={120}
                  autoComplete="off"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputClassName}
                />
              </label>
              <button
                type="submit"
                disabled={busy || !email.trim()}
                className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-[0.78rem] font-medium bg-primary text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />}
                {t('users.create')}
              </button>
            </form>

            {error && (
              <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            {created && (
              <div
                role="status"
                className="space-y-2 rounded-lg border border-border bg-[var(--surface-2)] p-3"
              >
                <p className="text-[0.8rem] font-medium text-foreground">
                  {t('users.created', { email: created.email })}
                </p>
                <p className="text-[0.75rem] text-muted-foreground">{t('users.tempPassword')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-md bg-card px-3 py-1.5 font-mono text-[0.85rem] text-foreground select-all">
                    {created.password}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyPassword()}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[0.72rem] text-muted-foreground hover:text-foreground max-lg:min-h-11"
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? t('users.copied') : t('users.copy')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreated(null)}
                    className="rounded-md border border-border px-2 py-1.5 text-[0.72rem] text-muted-foreground hover:text-foreground max-lg:min-h-11"
                  >
                    {t('users.dismiss')}
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <h3 className="text-[0.78rem] font-semibold text-foreground">{t('users.list')}</h3>
              {users.length === 0 ? (
                <p className="text-[0.8rem] text-muted-foreground">{t('users.none')}</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-[0.78rem]">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="px-3 py-2 font-medium">{t('users.col.account')}</th>
                        <th className="px-3 py-2 font-medium whitespace-nowrap">
                          {t('users.col.lastSignIn')}
                        </th>
                        <th className="px-3 py-2 font-medium">{t('users.col.twoFactor')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.email} className="border-b border-border last:border-b-0">
                          <td className="px-3 py-2">
                            <div className="text-foreground">{u.full_name || u.email}</div>
                            {u.full_name && <div className="text-muted-foreground">{u.email}</div>}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                            {u.last_sign_in_at ? fmt.dateTime(u.last_sign_in_at) : t('users.never')}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {u.locked ? (
                              <span className="text-red-600 dark:text-red-400">
                                {t('users.locked')}
                              </span>
                            ) : u.devices_2fa > 0 ? (
                              <Check size={13} aria-label={t('users.col.twoFactor')} />
                            ) : (
                              '–'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
