'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  KeyRound,
  Link2,
  Loader2,
  LogOut,
  MonitorSmartphone,
  FileText,
  ScrollText,
  ShieldOff,
  UserCheck,
  UserMinus,
  UserX,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useAdmin, useAdminPath } from '../../components/AdminShell';
import { adminChange, adminGet } from '../../components/api';
import { ActionDialog } from '../../components/ActionDialog';
import { accountRights, closeDialog, type Dialog } from '../../components/accountActions';
import { ROLE_LABEL, errorKey, workspaceRoleKey, type AdminRole } from '../../components/labels';
import { LinkReveal } from '../../components/LinkReveal';
import { AccountLimitPanel, SignInHistory } from '../../components/AccountPanels';
import { SecurityLogTable, type SecurityEvent } from '../../components/SecurityLogTable';
import { Badge, Facts, Section, buttonCls, rowCls, tableCls, theadCls } from '../../components/ui';

interface Detail {
  user: {
    user_id: string;
    email: string;
    full_name: string;
    created_at: string;
    last_sign_in_at: string | null;
    disabled: boolean;
    has_password: boolean;
    admin_role: AdminRole | null;
  };
  mfa: {
    devices: { id: string; name: string | null; status: string; created_at: string }[];
    recovery_codes_left: number;
  };
  sessions: {
    id: string;
    aal: string;
    created_at: string;
    last_seen_at: string;
    ip: string | null;
    user_agent: string | null;
  }[];
  workspaces: {
    workspace_id: string;
    name: string;
    is_personal: boolean;
    role: string;
    status: string;
    joined_at: string;
    suspended: boolean;
  }[];
  password_links: {
    id: string;
    purpose: 'reset' | 'invite';
    created_at: string;
    expires_at: string;
    used_at: string | null;
    revoked_at: string | null;
    created_by_email: string | null;
  }[];
  closure: { closed_at: string; reason: string; closed_by_email: string | null } | null;
}

interface AcceptedTerms {
  version_id: string;
  label: string;
  accepted_at: string;
  locale: string;
  workspace_name: string | null;
  ip: string | null;
}

interface Issued {
  url: string;
  purpose: 'reset' | 'invite';
  expires_at: string;
  emailed?: 'sent' | 'failed' | 'off' | null;
}

export default function UserDetailPage() {
  const ap = useAdminPath();
  const { id } = useParams<{ id: string }>();
  const { t, fmt } = useI18n();
  const { role, email: me, confirmIdentity } = useAdmin();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [terms, setTerms] = useState<AcceptedTerms[] | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);

  const when = (value: string | null) =>
    fmt.date(value, { dateStyle: 'medium', timeStyle: 'short' });

  const load = useCallback(async () => {
    const [user, log, accepted] = await Promise.all([
      adminGet<Detail>(`/api/admin/platform/users/${id}`),
      adminGet<{ events: SecurityEvent[] }>(`/api/admin/platform/events?user=${id}&limit=50`),
      adminGet<{ accepted: AcceptedTerms[] }>(`/api/admin/platform/users/${id}/terms`),
    ]);
    if (user.ok) setDetail(user.data);
    else setMissing(true);
    if (log.ok) setEvents(log.data.events);
    if (accepted.ok) setTerms(accepted.data.accepted);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (missing)
    return <p className="text-[0.85rem] text-muted-foreground">{t('padmin.err.not_found')}</p>;
  if (!detail) return <Loader2 size={16} className="animate-spin text-muted-foreground" />;

  const { user } = detail;
  const self = user.email.toLowerCase() === me.toLowerCase();
  // Mirrors the database rules (etna_platform._target); the database decides.
  const rights = accountRights(role, { ...user, closed: detail.closure !== null }, self);
  const canAct = rights.manage;

  async function act(body: Record<string, unknown>, done: MessageKey): Promise<string | null> {
    const result = await adminChange(confirmIdentity, `/api/admin/platform/users/${id}`, body);
    if (!result.ok) return result.error === 'cancelled' ? null : t(errorKey(result.error));
    toast.success(t(done));
    await load();
    return null;
  }

  async function resetLink() {
    const result = await adminChange<Issued>(confirmIdentity, `/api/admin/platform/users/${id}`, {
      action: 'reset_link',
      sendEmail: true,
    });
    if (!result.ok) {
      if (result.error !== 'cancelled') toast.error(t(errorKey(result.error)));
      return;
    }
    setIssued(result.data);
    await load();
  }

  const linkStatus = (l: Detail['password_links'][number]) =>
    l.used_at ? (
      <Badge tone="good">{t('padmin.link.used')}</Badge>
    ) : l.revoked_at ? (
      <Badge>{t('padmin.link.cancelled')}</Badge>
    ) : new Date(l.expires_at) < new Date() ? (
      <Badge>{t('padmin.link.expired')}</Badge>
    ) : (
      <Badge tone="warn">{t('padmin.link.open')}</Badge>
    );

  return (
    <div className="space-y-5">
      <Link
        href={ap('/users')}
        className="inline-flex items-center gap-1 text-[0.75rem] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={12} />
        {t('padmin.nav.users')}
      </Link>

      <section className="space-y-3 rounded-xl border border-border bg-card px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[1rem] font-semibold text-foreground">{user.email}</h1>
          {detail.closure ? (
            <Badge>{t('padmin.users.closed')}</Badge>
          ) : user.disabled ? (
            <Badge tone="bad">{t('padmin.users.disabled')}</Badge>
          ) : (
            <Badge tone="good">{t('padmin.users.active')}</Badge>
          )}
          {user.admin_role && <Badge>{t(ROLE_LABEL[user.admin_role])}</Badge>}
          {!user.has_password && !detail.closure && (
            <Badge tone="warn">{t('padmin.users.noPassword')}</Badge>
          )}
        </div>
        {user.full_name && <p className="text-[0.8rem] text-muted-foreground">{user.full_name}</p>}

        {detail.closure && (
          <div className="space-y-2 rounded-lg border border-border bg-muted/40 px-4 py-3">
            <p className="text-[0.78rem] text-foreground">{t('padmin.users.closedHint')}</p>
            <Facts
              items={[
                [t('padmin.users.closedAt'), when(detail.closure.closed_at)],
                [t('padmin.users.closedBy'), detail.closure.closed_by_email ?? '—'],
                [t('padmin.users.closedReason'), detail.closure.reason],
              ]}
            />
          </div>
        )}

        {canAct && (
          <div className="flex flex-wrap gap-2">
            {!self &&
              (user.disabled ? (
                <button
                  type="button"
                  className={buttonCls}
                  onClick={() =>
                    setDialog({
                      title: t('padmin.users.enable'),
                      description: t('padmin.users.enableBody', { email: user.email }),
                      confirmLabel: t('padmin.users.enable'),
                      onConfirm: () => act({ action: 'enable' }, 'padmin.users.enabled'),
                    })
                  }
                >
                  <UserCheck size={13} />
                  {t('padmin.users.enable')}
                </button>
              ) : (
                <button
                  type="button"
                  className={buttonCls}
                  onClick={() =>
                    setDialog({
                      title: t('padmin.users.disable'),
                      description: t('padmin.users.disableBody', { email: user.email }),
                      confirmLabel: t('padmin.users.disable'),
                      danger: true,
                      note: { label: t('padmin.users.reason'), minLength: 3 },
                      onConfirm: ({ note }) =>
                        act({ action: 'disable', reason: note }, 'padmin.users.disabledDone'),
                    })
                  }
                >
                  <UserX size={13} />
                  {t('padmin.users.disable')}
                </button>
              ))}
            <button
              type="button"
              className={buttonCls}
              disabled={detail.sessions.length === 0}
              onClick={() =>
                setDialog({
                  title: t('padmin.users.endSessions'),
                  description: t('padmin.users.endSessionsBody', { email: user.email }),
                  confirmLabel: t('padmin.users.endSessions'),
                  onConfirm: () => act({ action: 'end_sessions' }, 'padmin.users.sessionsEnded'),
                })
              }
            >
              <LogOut size={13} />
              {t('padmin.users.endSessions')}
            </button>
            {!self && (
              <button type="button" className={buttonCls} onClick={() => void resetLink()}>
                <Link2 size={13} />
                {t('padmin.users.resetLink')}
              </button>
            )}
            {!self && detail.mfa.devices.length > 0 && (
              <button
                type="button"
                className={buttonCls}
                onClick={() =>
                  setDialog({
                    title: t('padmin.users.resetMfa'),
                    description: t('padmin.users.resetMfaBody', { email: user.email }),
                    confirmLabel: t('padmin.users.resetMfa'),
                    danger: true,
                    note: { label: t('padmin.users.verification'), minLength: 10 },
                    onConfirm: ({ note }) =>
                      act({ action: 'reset_mfa', verification: note }, 'padmin.users.mfaReset'),
                  })
                }
              >
                <ShieldOff size={13} />
                {t('padmin.users.resetMfa')}
              </button>
            )}
            {rights.close && (
              <button
                type="button"
                className={`${buttonCls} text-red-600 dark:text-red-400`}
                onClick={() => setDialog(closeDialog(t, user.email, act))}
              >
                <UserMinus size={13} />
                {t('padmin.users.close')}
              </button>
            )}
          </div>
        )}

        {issued && (
          <LinkReveal
            url={issued.url}
            purpose={issued.purpose}
            expiresAt={issued.expires_at}
            emailed={issued.emailed}
            onDismiss={() => setIssued(null)}
          />
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title={t('padmin.users.profile')}>
          <Facts
            items={[
              [t('padmin.users.created'), when(user.created_at)],
              [t('padmin.admins.col.lastSignIn'), when(user.last_sign_in_at)],
              [
                t('padmin.admins.col.twoFactor'),
                detail.mfa.devices.filter((d) => d.status === 'verified').length > 0
                  ? t('padmin.users.devices', {
                      count: detail.mfa.devices.filter((d) => d.status === 'verified').length,
                    })
                  : t('padmin.users.off'),
              ],
              [t('padmin.users.recoveryCodes'), String(detail.mfa.recovery_codes_left)],
            ]}
          />
        </Section>

        <AccountLimitPanel userId={id} />

        <Section title={t('padmin.users.workspaces')} icon={Building2}>
          {detail.workspaces.length === 0 ? (
            <p className="px-5 py-4 text-[0.8rem] text-muted-foreground">{t('padmin.log.empty')}</p>
          ) : (
            <table className={tableCls}>
              <tbody>
                {detail.workspaces.map((w) => (
                  <tr key={w.workspace_id} className={rowCls}>
                    <td className="px-5 py-2">
                      <Link
                        href={ap(`/workspaces/${w.workspace_id}`)}
                        className="text-foreground underline-offset-2 hover:underline"
                      >
                        {w.name}
                      </Link>
                      {w.is_personal && (
                        <span className="ml-2 text-[0.72rem] text-muted-foreground">
                          {t('padmin.ws.personal')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {workspaceRoleKey(w.role) ? t(workspaceRoleKey(w.role)!) : w.role}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {w.suspended && <Badge tone="bad">{t('padmin.ws.suspended')}</Badge>}
                      {w.status !== 'active' && <Badge>{t('padmin.ws.left')}</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>

      <Section title={t('padmin.users.sessions')} icon={MonitorSmartphone}>
        {detail.sessions.length === 0 ? (
          <p className="px-5 py-4 text-[0.8rem] text-muted-foreground">
            {t('padmin.users.noSessions')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={`${tableCls} min-w-[680px]`}>
              <thead className={theadCls}>
                <tr>
                  <th className="px-5 py-2 font-medium">{t('padmin.users.started')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.users.lastSeen')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.log.col.ip')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.log.device')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.admins.col.twoFactor')}</th>
                  {canAct && <th className="px-3 py-2" />}
                </tr>
              </thead>
              <tbody>
                {detail.sessions.map((s) => (
                  <tr key={s.id} className={rowCls}>
                    <td className="whitespace-nowrap px-5 py-2 text-muted-foreground">
                      {when(s.created_at)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {when(s.last_seen_at)}
                    </td>
                    <td className="px-3 py-2 font-mono text-[0.72rem]">{s.ip ?? '—'}</td>
                    <td className="max-w-[280px] truncate px-3 py-2 text-muted-foreground">
                      {s.user_agent ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      {s.aal === 'aal2' ? t('padmin.admins.twoFactorOn') : '—'}
                    </td>
                    {canAct && (
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          className={buttonCls}
                          onClick={() =>
                            setDialog({
                              title: t('padmin.users.endSession'),
                              description: t('padmin.users.endSessionBody'),
                              confirmLabel: t('padmin.users.endSession'),
                              onConfirm: () =>
                                act(
                                  { action: 'end_sessions', sessionId: s.id },
                                  'padmin.users.sessionsEnded'
                                ),
                            })
                          }
                        >
                          {t('padmin.users.endSession')}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {detail.password_links.length > 0 && (
        <Section title={t('padmin.users.links')} icon={KeyRound}>
          <div className="overflow-x-auto">
            <table className={`${tableCls} min-w-[560px]`}>
              <thead className={theadCls}>
                <tr>
                  <th className="px-5 py-2 font-medium">{t('padmin.users.linkKind')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.users.created')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.link.expires')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.log.col.actor')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.users.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.password_links.map((l) => (
                  <tr key={l.id} className={rowCls}>
                    <td className="px-5 py-2 text-foreground">
                      {t(l.purpose === 'invite' ? 'padmin.link.invite' : 'padmin.link.reset')}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {when(l.created_at)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {when(l.expires_at)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{l.created_by_email ?? '—'}</td>
                    <td className="px-3 py-2">{linkStatus(l)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Section title={t('padmin.nav.terms')} icon={FileText}>
        {!terms || terms.length === 0 ? (
          <p className="px-5 py-4 text-[0.8rem] text-muted-foreground">
            {t('padmin.terms.noneAccepted')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={`${tableCls} min-w-[640px]`}>
              <thead className={theadCls}>
                <tr>
                  <th className="px-5 py-2 font-medium">{t('padmin.terms.col.version')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.terms.col.acceptedAt')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.terms.col.language')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.log.workspace')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.log.col.ip')}</th>
                </tr>
              </thead>
              <tbody>
                {terms.map((a) => (
                  <tr key={a.version_id} className={rowCls}>
                    <td className="px-5 py-2">
                      <Link
                        href={ap(`/terms/${a.version_id}`)}
                        className="text-foreground underline-offset-2 hover:underline"
                      >
                        {a.label}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {when(a.accepted_at)}
                    </td>
                    <td className="px-3 py-2 uppercase text-muted-foreground">{a.locale}</td>
                    <td className="px-3 py-2 text-muted-foreground">{a.workspace_name ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-[0.72rem]">{a.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <SignInHistory events={events} />

      <Section title={t('padmin.nav.securityLog')} icon={ScrollText}>
        {events ? (
          <SecurityLogTable events={events} />
        ) : (
          <div className="px-5 py-4">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </div>
        )}
      </Section>

      {dialog && <ActionDialog {...dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
