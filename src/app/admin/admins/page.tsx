'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, UserCog, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useAdmin } from '../components/AdminShell';
import { adminGet, adminPost, type AdminResult } from '../components/api';
import { ADMIN_ROLES, ROLE_LABEL, errorKey, type AdminRole } from '../components/labels';

interface AdminAccount {
  user_id: string;
  email: string;
  full_name: string;
  role: AdminRole;
  granted_at: string;
  granted_by_email: string | null;
  mfa_enrolled: boolean;
  last_sign_in_at: string | null;
}

const fieldCls =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-[0.85rem] text-foreground outline-none focus:border-foreground/40';

export default function AdminsPage() {
  const { t, fmt } = useI18n();
  const { email: me, role, confirmIdentity } = useAdmin();
  const canManage = role === 'super_admin';
  const [admins, setAdmins] = useState<AdminAccount[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<AdminRole>('support');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const result = await adminGet<{ admins: AdminAccount[] }>('/api/admin/platform/admins');
    if (result.ok) setAdmins(result.data.admins);
    else setFailed(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A change needs a two-factor code from the last 10 minutes: ask once, retry once.
  async function change(body: Record<string, unknown>): Promise<AdminResult<undefined>> {
    let result = await adminPost('/api/admin/platform/admins', body);
    if (!result.ok && result.error === 'reauth_required' && (await confirmIdentity()))
      result = await adminPost('/api/admin/platform/admins', body);
    return result;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const result = await change({ action: 'set', email: email.trim(), role: newRole });
    setBusy(false);
    if (!result.ok) {
      if (result.error !== 'reauth_required') setError(t(errorKey(result.error)));
      return;
    }
    toast.success(t('padmin.admins.saved'));
    setEmail('');
    await load();
  }

  async function remove(account: AdminAccount) {
    if (!window.confirm(t('padmin.admins.confirmRemove', { email: account.email }))) return;
    const result = await change({ action: 'revoke', email: account.email });
    if (!result.ok) {
      if (result.error !== 'reauth_required') toast.error(t(errorKey(result.error)));
      return;
    }
    toast.success(t('padmin.admins.removed'));
    await load();
  }

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-5 py-4">
          <Users size={14} className="text-muted-foreground" />
          <div>
            <h1 className="text-[0.9rem] font-semibold text-foreground">
              {t('padmin.nav.admins')}
            </h1>
            <p className="text-[0.72rem] text-muted-foreground">{t('padmin.admins.subtitle')}</p>
          </div>
        </div>
        {failed ? (
          <p role="alert" className="px-5 py-6 text-[0.8rem] text-red-600 dark:text-red-400">
            {t('padmin.err.failed')}
          </p>
        ) : !admins ? (
          <div className="px-5 py-6">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-[0.78rem]">
              <thead className="border-b border-border text-[0.72rem] text-muted-foreground">
                <tr>
                  <th className="px-5 py-2 font-medium">{t('padmin.admins.col.account')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.admins.col.role')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.admins.col.twoFactor')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.admins.col.lastSignIn')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.admins.col.grantedBy')}</th>
                  {canManage && <th className="px-3 py-2" />}
                </tr>
              </thead>
              <tbody>
                {admins.map((a) => {
                  const self = a.email.toLowerCase() === me.toLowerCase();
                  return (
                    <tr key={a.user_id} className="border-b border-border/60">
                      <td className="px-5 py-2">
                        <div className="text-foreground">
                          {a.email}
                          {self && (
                            <span className="ml-1 text-muted-foreground">
                              ({t('padmin.admins.you')})
                            </span>
                          )}
                        </div>
                        {a.full_name && (
                          <div className="text-[0.72rem] text-muted-foreground">{a.full_name}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-foreground">{t(ROLE_LABEL[a.role])}</td>
                      <td
                        className={`px-3 py-2 ${
                          a.mfa_enrolled ? 'text-foreground' : 'text-amber-600 dark:text-amber-400'
                        }`}
                      >
                        {t(
                          a.mfa_enrolled
                            ? 'padmin.admins.twoFactorOn'
                            : 'padmin.admins.twoFactorOff'
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {fmt.date(a.last_sign_in_at, { dateStyle: 'medium', timeStyle: 'short' })}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {a.granted_by_email ?? t('padmin.admins.commandLine')}
                      </td>
                      {canManage && (
                        <td className="px-3 py-2 text-right">
                          {!self && (
                            <button
                              type="button"
                              onClick={() => void remove(a)}
                              className="rounded-md border border-border px-2 py-1 text-[0.72rem] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30 max-lg:min-h-11"
                            >
                              {t('padmin.admins.remove')}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card px-5 py-4">
        <div className="mb-3 flex items-center gap-2">
          <UserCog size={14} className="text-muted-foreground" />
          <h2 className="text-[0.85rem] font-semibold text-foreground">
            {t('padmin.admins.formTitle')}
          </h2>
        </div>
        {!canManage ? (
          <p className="text-[0.78rem] text-muted-foreground">{t('padmin.admins.readOnly')}</p>
        ) : (
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-[1fr_200px_auto] sm:items-end">
            <label className="block space-y-1">
              <span className="text-[0.75rem] text-muted-foreground">
                {t('padmin.admins.email')}
              </span>
              <input
                type="email"
                required
                maxLength={254}
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={fieldCls}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[0.75rem] text-muted-foreground">
                {t('padmin.admins.role')}
              </span>
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as AdminRole)}
                className={fieldCls}
              >
                {ADMIN_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(ROLE_LABEL[r])}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-[0.78rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              {t('padmin.admins.save')}
            </button>
          </form>
        )}
        {error && (
          <p role="alert" className="mt-3 text-[0.78rem] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
