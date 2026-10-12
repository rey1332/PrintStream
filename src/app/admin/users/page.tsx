'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Link2,
  Loader2,
  MoreHorizontal,
  Search,
  UserCheck,
  UserMinus,
  UserPlus,
  UserX,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useAdmin } from '../components/AdminShell';
import { adminChange, adminGet } from '../components/api';
import { ROLE_LABEL, errorKey, workspaceRoleKey, type AdminRole } from '../components/labels';
import { LinkReveal } from '../components/LinkReveal';
import { ExportButton } from '../components/AccountPanels';
import { ActionDialog } from '../components/ActionDialog';
import {
  accountRights,
  closeDialog,
  disableDialog,
  enableDialog,
  type Dialog,
} from '../components/accountActions';
import {
  Badge,
  Pager,
  Section,
  buttonCls,
  fieldCls,
  rowCls,
  tableCls,
  theadCls,
} from '../components/ui';

interface UserRow {
  user_id: string;
  email: string;
  full_name: string;
  created_at: string;
  last_sign_in_at: string | null;
  disabled: boolean;
  closed: boolean;
  mfa_enrolled: boolean;
  active_sessions: number;
  workspaces: number;
  memberships: { workspace_id: string; name: string; role: string }[];
  admin_role: AdminRole | null;
}

interface Issued {
  url: string;
  purpose: 'reset' | 'invite';
  expires_at: string;
  emailed?: 'sent' | 'failed' | 'off' | null;
}

const LIMIT = 50;
const FILTERS: { value: string; label: MessageKey }[] = [
  { value: 'all', label: 'padmin.users.filter.all' },
  { value: 'disabled', label: 'padmin.users.filter.disabled' },
  { value: 'closed', label: 'padmin.users.filter.closed' },
  { value: 'no_mfa', label: 'padmin.users.filter.noMfa' },
  { value: 'admins', label: 'padmin.users.filter.admins' },
];
const SORTS: { value: string; label: MessageKey }[] = [
  { value: 'created_desc', label: 'padmin.users.sort.created_desc' },
  { value: 'created_asc', label: 'padmin.users.sort.created_asc' },
  { value: 'last_sign_in_desc', label: 'padmin.users.sort.last_sign_in_desc' },
  { value: 'email_asc', label: 'padmin.users.sort.email_asc' },
];
// ERPs shown in a row before "+N more".
const SHOWN_ERPS = 2;
const menuItemCls =
  'flex w-full items-center gap-2 px-3 py-2 text-left text-[0.78rem] hover:bg-muted max-lg:min-h-11';

export default function UsersPage() {
  const { t, fmt } = useI18n();
  const { role, email: me, confirmIdentity } = useAdmin();
  const canManage = role === 'super_admin' || role === 'support';
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('created_desc');
  const [applied, setApplied] = useState({ query: '', filter: 'all', sort: 'created_desc' });
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ rows: UserRow[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<Issued | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({
      filter: applied.filter,
      sort: applied.sort,
      offset: String(offset),
      limit: String(LIMIT),
    });
    if (applied.query) params.set('q', applied.query);
    const result = await adminGet<{ rows: UserRow[]; total: number }>(
      `/api/admin/platform/users?${params}`
    );
    if (result.ok) {
      setPage(result.data);
      setFailed(false);
    } else setFailed(true);
  }, [applied, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // The row menu closes on Escape or a click elsewhere.
  useEffect(() => {
    if (!menuFor) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event.target instanceof Element && event.target.closest('[data-row-menu]')) return;
      setMenuFor(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuFor]);

  const actOn =
    (userId: string) =>
    async (body: Record<string, unknown>, done: MessageKey): Promise<string | null> => {
      const result = await adminChange(
        confirmIdentity,
        `/api/admin/platform/users/${userId}`,
        body
      );
      if (!result.ok) return result.error === 'cancelled' ? null : t(errorKey(result.error));
      toast.success(t(done));
      await load();
      return null;
    };

  async function resetLink(userId: string) {
    const result = await adminChange<Issued>(
      confirmIdentity,
      `/api/admin/platform/users/${userId}`,
      { action: 'reset_link', sendEmail: true }
    );
    if (!result.ok) {
      if (result.error !== 'cancelled') toast.error(t(errorKey(result.error)));
      return;
    }
    setIssued(result.data);
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const result = await adminChange<Issued>(confirmIdentity, '/api/admin/platform/users', {
      email: email.trim(),
      name: name.trim(),
      sendEmail,
    });
    setBusy(false);
    if (!result.ok) {
      if (result.error !== 'cancelled') setError(t(errorKey(result.error)));
      return;
    }
    setIssued(result.data);
    setEmail('');
    setName('');
    setCreating(false);
    await load();
  }

  return (
    <div className="space-y-5">
      <Section
        title={t('padmin.nav.users')}
        icon={Users}
        actions={
          <>
            <ExportButton
              body={{ kind: 'users', q: applied.query, filter: applied.filter, sort: applied.sort }}
            />
            {canManage && (
              <button type="button" onClick={() => setCreating((v) => !v)} className={buttonCls}>
                <UserPlus size={13} />
                {t('padmin.users.new')}
              </button>
            )}
          </>
        }
      >
        <p className="px-5 pt-3 text-[0.75rem] text-muted-foreground">
          {t('padmin.users.subtitle')}
        </p>

        {issued && (
          <div className="px-5 pt-3">
            <LinkReveal
              url={issued.url}
              purpose={issued.purpose}
              expiresAt={issued.expires_at}
              emailed={issued.emailed}
              onDismiss={() => setIssued(null)}
            />
          </div>
        )}

        {creating && (
          <form
            onSubmit={create}
            className="mx-5 mt-3 grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
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
                className={`${fieldCls} w-full`}
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
                className={`${fieldCls} w-full`}
              />
            </label>
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-[0.78rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              {t('padmin.users.createInvite')}
            </button>
            <label className="flex items-center gap-2 text-[0.78rem] text-foreground sm:col-span-3">
              <input
                type="checkbox"
                checked={sendEmail}
                onChange={(e) => setSendEmail(e.target.checked)}
              />
              {t('padmin.mail.send')}
            </label>
            <p className="text-[0.72rem] text-muted-foreground sm:col-span-3">
              {t('padmin.users.inviteHint')}
            </p>
            {error && (
              <p
                role="alert"
                className="text-[0.78rem] text-red-600 dark:text-red-400 sm:col-span-3"
              >
                {error}
              </p>
            )}
          </form>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setApplied({ query: query.trim(), filter, sort });
          }}
          className="flex flex-wrap items-center gap-2 px-5 py-3"
        >
          <label className="relative min-w-[220px] flex-1">
            <Search
              size={13}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={query}
              maxLength={320}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('padmin.users.search')}
              aria-label={t('padmin.users.search')}
              className={`${fieldCls} w-full pl-8`}
            />
          </label>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label={t('padmin.users.filterLabel')}
            className={fieldCls}
          >
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {t(f.label)}
              </option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            aria-label={t('padmin.users.sortLabel')}
            className={fieldCls}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {t(s.label)}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-lg bg-primary px-3 py-2 text-[0.78rem] font-medium text-primary-foreground max-lg:min-h-11"
          >
            {t('padmin.log.apply')}
          </button>
        </form>

        {failed ? (
          <p role="alert" className="px-5 py-6 text-[0.8rem] text-red-600 dark:text-red-400">
            {t('padmin.err.failed')}
          </p>
        ) : !page ? (
          <div className="px-5 py-6">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </div>
        ) : page.rows.length === 0 ? (
          <p className="px-5 py-6 text-[0.8rem] text-muted-foreground">{t('padmin.log.empty')}</p>
        ) : (
          <div className="overflow-x-auto border-t border-border">
            <table className={`${tableCls} min-w-[1040px]`}>
              <thead className={theadCls}>
                <tr>
                  <th className="px-5 py-2 font-medium">{t('padmin.admins.col.account')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.users.col.status')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.admins.col.twoFactor')}</th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t('padmin.users.col.sessions')}
                  </th>
                  <th className="px-3 py-2 font-medium">{t('padmin.users.col.erps')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.users.created')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.admins.col.lastSignIn')}</th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t('padmin.users.col.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((u) => {
                  const rights = accountRights(role, u, u.email.toLowerCase() === me.toLowerCase());
                  const act = actOn(u.user_id);
                  return (
                    <tr key={u.user_id} className={rowCls}>
                      <td className="px-5 py-2">
                        <Link
                          href={`/admin/users/${u.user_id}`}
                          className="text-foreground underline-offset-2 hover:underline"
                        >
                          {u.email}
                        </Link>
                        <div className="flex items-center gap-2 text-[0.72rem] text-muted-foreground">
                          {u.full_name}
                          {u.admin_role && <Badge>{t(ROLE_LABEL[u.admin_role])}</Badge>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {u.closed ? (
                          <Badge>{t('padmin.users.closed')}</Badge>
                        ) : u.disabled ? (
                          <Badge tone="bad">{t('padmin.users.disabled')}</Badge>
                        ) : (
                          <Badge tone="good">{t('padmin.users.active')}</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {u.mfa_enrolled ? (
                          t('padmin.admins.twoFactorOn')
                        ) : (
                          <span className="text-amber-600 dark:text-amber-400">
                            {t('padmin.users.off')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{u.active_sessions}</td>
                      <td className="max-w-[240px] px-3 py-2 text-[0.75rem]">
                        {u.memberships.length === 0 ? (
                          <span className="text-muted-foreground">{t('padmin.users.noErps')}</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {u.memberships.slice(0, SHOWN_ERPS).map((m) => {
                              const roleKey = workspaceRoleKey(m.role);
                              return (
                                <li key={m.workspace_id} className="truncate">
                                  <Link
                                    href={`/admin/workspaces/${m.workspace_id}`}
                                    className="text-foreground underline-offset-2 hover:underline"
                                  >
                                    {m.name}
                                  </Link>
                                  <span className="text-muted-foreground">
                                    {' · '}
                                    {roleKey ? t(roleKey) : m.role}
                                  </span>
                                </li>
                              );
                            })}
                            {u.memberships.length > SHOWN_ERPS && (
                              <li className="text-muted-foreground">
                                {t('padmin.users.moreErps', {
                                  count: u.memberships.length - SHOWN_ERPS,
                                })}
                              </li>
                            )}
                          </ul>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {fmt.date(u.created_at, { dateStyle: 'medium' })}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {fmt.date(u.last_sign_in_at, { dateStyle: 'medium', timeStyle: 'short' })}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {(rights.toggle || rights.resetLink || rights.close) && (
                          <div className="relative inline-block" data-row-menu>
                            <button
                              type="button"
                              aria-haspopup="menu"
                              aria-expanded={menuFor === u.user_id}
                              aria-label={t('padmin.users.actionsFor', { email: u.email })}
                              onClick={() =>
                                setMenuFor((open) => (open === u.user_id ? null : u.user_id))
                              }
                              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground max-lg:min-h-11 max-lg:min-w-11"
                            >
                              <MoreHorizontal size={15} />
                            </button>
                            {menuFor === u.user_id && (
                              <div
                                role="menu"
                                className="absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-lg border border-border bg-card py-1 text-foreground shadow-lg"
                              >
                                {rights.toggle && (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className={menuItemCls}
                                    onClick={() => {
                                      setMenuFor(null);
                                      setDialog(
                                        u.disabled
                                          ? enableDialog(t, u.email, act)
                                          : disableDialog(t, u.email, act)
                                      );
                                    }}
                                  >
                                    {u.disabled ? <UserCheck size={13} /> : <UserX size={13} />}
                                    {t(u.disabled ? 'padmin.users.enable' : 'padmin.users.disable')}
                                  </button>
                                )}
                                {rights.resetLink && (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className={menuItemCls}
                                    onClick={() => {
                                      setMenuFor(null);
                                      void resetLink(u.user_id);
                                    }}
                                  >
                                    <Link2 size={13} />
                                    {t('padmin.users.resetLink')}
                                  </button>
                                )}
                                {rights.close && (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className={`${menuItemCls} text-red-600 dark:text-red-400`}
                                    onClick={() => {
                                      setMenuFor(null);
                                      setDialog(closeDialog(t, u.email, act));
                                    }}
                                  >
                                    <UserMinus size={13} />
                                    {t('padmin.users.close')}
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {page && <Pager offset={offset} limit={LIMIT} total={page.total} onChange={setOffset} />}
      </Section>
      {dialog && <ActionDialog {...dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
