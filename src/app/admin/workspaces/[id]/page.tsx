'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Ban,
  History,
  Loader2,
  PlayCircle,
  ScrollText,
  UserPlus,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useAdmin, useAdminPath } from '../../components/AdminShell';
import { WorkspaceUsage } from '../../components/WorkspaceUsage';
import { GovernancePanels } from '../../components/GovernancePanels';
import { adminChange, adminGet } from '../../components/api';
import { ActionDialog, type ActionDialogProps } from '../../components/ActionDialog';
import { GrantWorkspaceDialog } from '../../components/GrantDialogs';
import { errorKey, workspaceRoleKey } from '../../components/labels';
import { SecurityLogTable, type SecurityEvent } from '../../components/SecurityLogTable';
import { Badge, Facts, Section, buttonCls, rowCls, tableCls, theadCls } from '../../components/ui';

interface Detail {
  workspace: {
    workspace_id: string;
    name: string;
    is_personal: boolean;
    owner_email: string | null;
    created_at: string;
    require_mfa: boolean;
    last_activity: string | null;
    suspended: boolean;
    /** Created from Add modules or New company: its ownership can move. */
    transferable: boolean;
  };
  members: {
    user_id: string;
    email: string;
    full_name: string;
    role: string;
    status: string;
    joined_at: string;
    disabled: boolean;
    is_container: boolean;
  }[];
  suspensions: {
    id: string;
    reason: string;
    suspended_at: string;
    suspended_by_email: string | null;
    disabled_members: number;
    lifted_at: string | null;
    lifted_by_email: string | null;
  }[];
}

type Dialog = Omit<ActionDialogProps, 'onClose'>;

export default function WorkspaceDetailPage() {
  const ap = useAdminPath();
  const { id } = useParams<{ id: string }>();
  const { t, fmt } = useI18n();
  const { email: me, role, confirmIdentity } = useAdmin();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // Granting access (no member) or changing a member's role.
  const [granting, setGranting] = useState<{ email?: string; role?: string } | null>(null);

  const when = (value: string | null) =>
    fmt.date(value, { dateStyle: 'medium', timeStyle: 'short' });

  const load = useCallback(async () => {
    const [ws, log] = await Promise.all([
      adminGet<Detail>(`/api/admin/platform/workspaces/${id}`),
      adminGet<{ events: SecurityEvent[] }>(`/api/admin/platform/events?workspace=${id}&limit=50`),
    ]);
    if (ws.ok) setDetail(ws.data);
    else setMissing(true);
    if (log.ok) setEvents(log.data.events);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (missing)
    return <p className="text-[0.85rem] text-muted-foreground">{t('padmin.err.not_found')}</p>;
  if (!detail) return <Loader2 size={16} className="animate-spin text-muted-foreground" />;

  const { workspace: w } = detail;
  const people = detail.members.filter((m) => !m.is_container);

  async function change(body: Record<string, unknown>): Promise<string | null> {
    const result = await adminChange<{ members: number }>(
      confirmIdentity,
      `/api/admin/platform/workspaces/${id}`,
      body
    );
    if (!result.ok) return result.error === 'cancelled' ? null : t(errorKey(result.error));
    toast.success(
      t(body.action === 'suspend' ? 'padmin.ws.suspendedDone' : 'padmin.ws.reactivatedDone', {
        count: result.data.members,
      })
    );
    await load();
    return null;
  }

  async function removeAccess(userId: string, reason: string): Promise<string | null> {
    const result = await adminChange(confirmIdentity, `/api/admin/platform/workspaces/${id}`, {
      action: 'remove',
      userId,
      reason,
    });
    if (!result.ok) return result.error === 'cancelled' ? null : t(errorKey(result.error));
    toast.success(t('padmin.access.removed'));
    await load();
    return null;
  }

  async function transferTo(userId: string, reason: string): Promise<string | null> {
    const result = await adminChange(confirmIdentity, `/api/admin/platform/workspaces/${id}`, {
      action: 'transfer',
      userId,
      reason,
    });
    if (!result.ok) return result.error === 'cancelled' ? null : t(errorKey(result.error));
    toast.success(t('padmin.access.ownerChanged'));
    await load();
    return null;
  }

  const canGrant = role === 'super_admin';

  return (
    <div className="space-y-5">
      <Link
        href={ap('/workspaces')}
        className="inline-flex items-center gap-1 text-[0.75rem] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={12} />
        {t('padmin.nav.workspaces')}
      </Link>

      <section className="space-y-3 rounded-xl border border-border bg-card px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[1rem] font-semibold text-foreground">{w.name}</h1>
          <Badge>{t(w.is_personal ? 'padmin.ws.personal' : 'padmin.ws.shared')}</Badge>
          {w.suspended ? (
            <Badge tone="bad">{t('padmin.ws.suspended')}</Badge>
          ) : (
            <Badge tone="good">{t('padmin.users.active')}</Badge>
          )}
        </div>
        {role === 'super_admin' && (
          <div className="flex flex-wrap gap-2">
            {w.suspended ? (
              <button
                type="button"
                className={buttonCls}
                onClick={() =>
                  setDialog({
                    title: t('padmin.ws.reactivate'),
                    description: t('padmin.ws.reactivateBody', { name: w.name }),
                    confirmLabel: t('padmin.ws.reactivate'),
                    option:
                      (detail.suspensions[0]?.disabled_members ?? 0) > 0
                        ? {
                            label: t('padmin.ws.enableMembers', {
                              count: detail.suspensions[0].disabled_members,
                            }),
                          }
                        : undefined,
                    onConfirm: ({ option }) =>
                      change({ action: 'reactivate', enableMembers: option }),
                  })
                }
              >
                <PlayCircle size={13} />
                {t('padmin.ws.reactivate')}
              </button>
            ) : (
              <button
                type="button"
                className={buttonCls}
                onClick={() =>
                  setDialog({
                    title: t('padmin.ws.suspend'),
                    description: t('padmin.ws.suspendBody', { name: w.name }),
                    confirmLabel: t('padmin.ws.suspend'),
                    danger: true,
                    note: { label: t('padmin.users.reason'), minLength: 3 },
                    option: { label: t('padmin.ws.disableMembers') },
                    onConfirm: ({ note, option }) =>
                      change({ action: 'suspend', reason: note, disableMembers: option }),
                  })
                }
              >
                <Ban size={13} />
                {t('padmin.ws.suspend')}
              </button>
            )}
          </div>
        )}
      </section>

      <WorkspaceUsage workspaceId={w.workspace_id} />
      <GovernancePanels workspaceId={w.workspace_id} workspaceName={w.name} />

      <Section title={t('padmin.nav.overview')}>
        <Facts
          items={[
            [t('padmin.ws.col.owner'), w.owner_email ?? '—'],
            [t('padmin.users.created'), when(w.created_at)],
            [t('padmin.ws.col.lastActivity'), when(w.last_activity)],
            [
              t('padmin.ws.requireMfa'),
              t(w.require_mfa ? 'padmin.admins.twoFactorOn' : 'padmin.users.off'),
            ],
          ]}
        />
      </Section>

      <Section
        title={t('padmin.ws.members')}
        icon={Users}
        actions={
          canGrant ? (
            <button type="button" className={buttonCls} onClick={() => setGranting({})}>
              <UserPlus size={13} />
              {t('padmin.access.grant')}
            </button>
          ) : undefined
        }
      >
        <div className="overflow-x-auto">
          <table className={`${tableCls} min-w-[640px]`}>
            <thead className={theadCls}>
              <tr>
                <th className="px-5 py-2 font-medium">{t('padmin.admins.col.account')}</th>
                <th className="px-3 py-2 font-medium">{t('padmin.admins.col.role')}</th>
                <th className="px-3 py-2 font-medium">{t('padmin.ws.joined')}</th>
                <th className="px-3 py-2 font-medium">{t('padmin.users.col.status')}</th>
                {canGrant && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {people.map((m) => (
                <tr key={m.user_id} className={rowCls}>
                  <td className="px-5 py-2">
                    <Link
                      href={ap(`/users/${m.user_id}`)}
                      className="text-foreground underline-offset-2 hover:underline"
                    >
                      {m.email}
                    </Link>
                    {m.full_name && (
                      <div className="text-[0.72rem] text-muted-foreground">{m.full_name}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {workspaceRoleKey(m.role) ? t(workspaceRoleKey(m.role)!) : m.role}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {fmt.date(m.joined_at, { dateStyle: 'medium' })}
                  </td>
                  <td className="space-x-1 px-3 py-2">
                    {m.status !== 'active' && <Badge>{t('padmin.ws.left')}</Badge>}
                    {m.disabled && <Badge tone="bad">{t('padmin.users.disabled')}</Badge>}
                  </td>
                  {canGrant && (
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {m.status === 'active' &&
                        m.role !== 'owner' &&
                        m.email.toLowerCase() !== me.toLowerCase() && (
                          <button
                            type="button"
                            onClick={() => setGranting({ email: m.email, role: m.role })}
                            className="rounded-md border border-border px-2 py-1 text-[0.72rem] text-foreground hover:bg-[var(--surface-2)] max-lg:min-h-11"
                          >
                            {t('padmin.access.changeRole')}
                          </button>
                        )}
                      {w.transferable &&
                        m.status === 'active' &&
                        m.role !== 'owner' &&
                        !m.disabled &&
                        m.email.toLowerCase() !== me.toLowerCase() && (
                          <button
                            type="button"
                            onClick={() =>
                              setDialog({
                                title: t('padmin.access.makeOwner'),
                                description: t('padmin.access.makeOwnerBody', {
                                  email: m.email,
                                  name: w.name,
                                }),
                                confirmLabel: t('padmin.access.makeOwner'),
                                note: { label: t('padmin.users.reason'), minLength: 3 },
                                onConfirm: ({ note }) => transferTo(m.user_id, note),
                              })
                            }
                            className="ml-1 rounded-md border border-border px-2 py-1 text-[0.72rem] text-foreground hover:bg-[var(--surface-2)] max-lg:min-h-11"
                          >
                            {t('padmin.access.makeOwner')}
                          </button>
                        )}
                      {m.status === 'active' && m.role !== 'owner' && (
                        <button
                          type="button"
                          onClick={() =>
                            setDialog({
                              title: t('padmin.access.remove'),
                              description: t('padmin.access.removeBody', {
                                email: m.email,
                                name: w.name,
                              }),
                              confirmLabel: t('padmin.access.remove'),
                              danger: true,
                              note: { label: t('padmin.users.reason'), minLength: 3 },
                              onConfirm: ({ note }) => removeAccess(m.user_id, note),
                            })
                          }
                          className="ml-1 rounded-md border border-border px-2 py-1 text-[0.72rem] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30 max-lg:min-h-11"
                        >
                          {t('padmin.access.remove')}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {detail.suspensions.length > 0 && (
        <Section title={t('padmin.ws.history')} icon={History}>
          <ul className="divide-y divide-border">
            {detail.suspensions.map((s) => (
              <li key={s.id} className="space-y-1 px-5 py-3 text-[0.78rem]">
                <p className="text-foreground">
                  {t('padmin.ws.suspendedBy', {
                    when: when(s.suspended_at),
                    who: s.suspended_by_email ?? '—',
                  })}
                </p>
                <p className="text-muted-foreground">“{s.reason}”</p>
                {s.disabled_members > 0 && (
                  <p className="text-muted-foreground">
                    {t('padmin.ws.membersDisabled', { count: s.disabled_members })}
                  </p>
                )}
                {s.lifted_at && (
                  <p className="text-muted-foreground">
                    {t('padmin.ws.liftedBy', {
                      when: when(s.lifted_at),
                      who: s.lifted_by_email ?? '—',
                    })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

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
      {granting && (
        <GrantWorkspaceDialog
          workspace={{ id: w.workspace_id, name: w.name }}
          email={granting.email}
          role={granting.role}
          onDone={() => void load()}
          onClose={() => setGranting(null)}
        />
      )}
    </div>
  );
}
