'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { Check, Copy, KeyRound, LogOut, Shield, UserPlus, Users, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '../lib/WorkspaceContext';
import { isWellFormedAccessCode, type MemberRole, type WorkspaceRole } from '../lib/erpRules';
import { ReasonDialog } from './ReasonDialog';
import { RoleEditor, type CustomRole } from './RoleEditor';
import { clearPendingJoin, pendingJoin } from '../lib/pendingJoin';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { tr, translateServerMessage } from '@/lib/i18n/translate';
import type { MessageKey } from '@/lib/i18n/messages';

interface Member {
  user_id: string;
  email: string;
  full_name: string;
  role: MemberRole;
  joined_at: string;
  is_owner: boolean;
  custom_role_id?: string | null;
  custom_role_name?: string | null;
  /** The caller may change this member's role or remove them (erp__can_grant). */
  can_manage?: boolean;
}
interface Invitation {
  id: string;
  role: MemberRole;
  label: string;
  status: 'pending' | 'redeemed' | 'revoked' | 'expired';
  created_at: string;
  expires_at: string;
  created_by_email: string | null;
  redeemed_by_email: string | null;
}
interface AuditEntry {
  id: string;
  action: string;
  actor_email: string | null;
  target_email: string | null;
  details?: Record<string, unknown> | null;
  created_at: string;
}
interface NewCode {
  code: string;
  expiresAt: string;
  roleLabel: string;
  label: string;
  /** E-mail invitations: who it went to, whether the mail left, and a new account's password link. */
  email?: string;
  emailed?: 'sent' | 'failed' | 'off';
  passwordLink?: string | null;
}

const EXPIRY_HOURS = [1, 24, 72, 168] as const;

// Membership activity shows this many entries until the list is expanded.
const ACTIVITY_PREVIEW = 3;

const AUDIT_ACTIONS = [
  'workspace.created',
  'invitation.created',
  'invitation.redeemed',
  'invitation.revoked',
  'member.added',
  'member.role_changed',
  'member.removed',
  'member.left',
  'workspace.renamed',
  'workspace.mfa_required',
  'workspace.mfa_optional',
  'member.mfa_recovered',
  'document.uploaded',
  'document.deleted',
  'hr.attendance_roles_changed',
  'hr.employee_rates_changed',
  'hr.employee_deleted',
  'hr.attendance_corrected',
  'hr.work_days_changed',
  'hr.holiday_saved',
  'hr.holiday_deleted',
  'hr.leave_requested',
  'hr.leave_approved',
  'hr.leave_rejected',
  'hr.leave_cancelled',
  'hr.leave_quota_changed',
  'hr.pay_items_changed',
  'hr.payroll_posted',
  'hr.payroll_reversed',
  'settings.changed',
  'company.profile_changed',
  'sync.run',
  'sync.enabled',
  'sync.disabled',
  'sync.inbox_posted',
  'sync.inbox_dismissed',
  'workspace.reset',
  'erp.deleted',
  'role.created',
  'role.changed',
  'role.deleted',
  'invitation.emailed',
  'invitation.mail_sent',
  'invitation.mail_failed',
];

// A role choice in a select: a built-in role, or "custom:<id>".
const roleValue = (role: MemberRole, customId?: string | null) =>
  role === 'custom' && customId ? `custom:${customId}` : role;
function parseRoleValue(value: string): { role: string; customRoleId?: string } {
  return value.startsWith('custom:')
    ? { role: 'custom', customRoleId: value.slice(7) }
    : { role: value };
}

interface WorkspaceSecurity {
  require_mfa: boolean;
  my_mfa_enrolled: boolean;
  session_aal: string;
  access_blocked: boolean;
}

async function workspaceApi<T = any>(
  action: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch('/api/erp/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ action, ...payload }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.success) {
    throw new Error(
      result.error ? translateServerMessage(result.error) : tr('workspace.requestFailed')
    );
  }
  return result.data as T;
}

function timeLeft(value: string, t: ReturnType<typeof useI18n>['t']) {
  const ms = new Date(value).getTime() - Date.now();
  if (ms <= 0) return t('status.expired');
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24)
    return t('workspace.timeLeft.days', { days: Math.floor(hours / 24), hours: hours % 24 });
  if (hours >= 1) return t('workspace.timeLeft.hours', { hours });
  return t('workspace.timeLeft.minutes', { minutes: Math.max(1, Math.floor(ms / 60_000)) });
}

const STATUS_STYLE: Record<Invitation['status'], string> = {
  pending: 'bg-blue-100 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400',
  redeemed: 'bg-green-100 dark:bg-green-950/30 text-green-700 dark:text-green-400',
  revoked: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
};

const sectionTitle =
  'text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground mb-2';
const inputCls =
  'w-full rounded-lg border px-2.5 py-1.5 text-[0.78rem] text-foreground outline-none focus:border-foreground/40';
const inputStyle = { background: 'var(--input)', borderColor: 'var(--border)' };

export function WorkspacePanel({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const { t, fmt } = useI18n();
  const formatDateTime = (value: string) => fmt.dateTime(value);
  const roleLabel = (r: MemberRole) => t(`role.${r}`);
  const { enabled, ready, unavailableReason, workspaces, active, can, selectWorkspace, refresh } =
    useWorkspace();
  const manage = enabled && can('members');
  const manageRoles = enabled && can('roles.manage');
  const grantable: WorkspaceRole[] = active?.grantableRoles ?? [];

  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [security, setSecurity] = useState<WorkspaceSecurity | null>(null);
  const [memberMfa, setMemberMfa] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [savingSecurity, setSavingSecurity] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const activityListId = useId();
  const [error, setError] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('sales');
  const [inviteEmail, setInviteEmail] = useState('');
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [linkCode] = useState<string | null>(() => pendingJoin());
  const [inviteHours, setInviteHours] = useState(72);
  const [inviteLabel, setInviteLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState<NewCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState(() => pendingJoin() ?? '');
  const [joining, setJoining] = useState(false);
  const [joinMessage, setJoinMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'revoke'; invitation: Invitation }
    | { kind: 'remove'; member: Member }
    | { kind: 'leave' }
    | null
  >(null);

  const load = useCallback(async () => {
    if (!enabled || !active) return;
    setError('');
    try {
      const [memberRows, invitationRows, auditRows] = await Promise.all([
        workspaceApi<Member[]>('list_members', { workspaceId: active.id }),
        manage
          ? workspaceApi<Invitation[]>('list_invitations', { workspaceId: active.id })
          : Promise.resolve([]),
        can('audit')
          ? workspaceApi<AuditEntry[]>('audit', { workspaceId: active.id })
          : Promise.resolve([]),
      ]);
      setMembers(memberRows);
      setInvitations(invitationRows);
      setAudit(auditRows);
      // Custom roles need the 20261012000030 migration; without it only built-in roles exist.
      setCustomRoles(
        manage
          ? await workspaceApi<CustomRole[]>('list_roles', { workspaceId: active.id }).catch(
              () => []
            )
          : []
      );
      // Security details need the 20260928 migration; the panel works without them.
      const [sec, mfaRows] = await Promise.all([
        workspaceApi<WorkspaceSecurity | null>('security', { workspaceId: active.id }).catch(
          () => null
        ),
        manage
          ? workspaceApi<{ user_id: string; mfa_enrolled: boolean }[]>('member_security', {
              workspaceId: active.id,
            }).catch(() => [])
          : Promise.resolve([]),
      ]);
      setSecurity(sec);
      setMemberMfa(Object.fromEntries(mfaRows.map((r) => [r.user_id, r.mfa_enrolled])));
    } catch (err: any) {
      setError(err.message);
    }
  }, [enabled, active, manage, can]);

  useEffect(() => {
    void load();
  }, [load]);

  // Each workspace starts with the compact activity list.
  useEffect(() => {
    setActivityExpanded(false);
  }, [active?.id]);

  useEffect(() => {
    setNewCode(null);
    setCopied(false);
  }, [active?.id]);
  // The roles this member may give: built-in ones the database allows, and custom roles
  // (the database refuses those broader than the caller's own permissions).
  const roleChoices = [
    ...grantable.map((r) => ({ value: r as string, label: roleLabel(r) })),
    ...customRoles.map((r) => ({ value: roleValue('custom', r.id), label: r.name })),
  ];
  const choiceLabel = (value: string) => roleChoices.find((c) => c.value === value)?.label ?? value;
  const choiceDescription = (value: string) => {
    const custom = customRoles.find((r) => roleValue('custom', r.id) === value);
    if (custom) return custom.description || t('roleDesc.custom');
    return t(`roleDesc.${value}` as MessageKey);
  };
  const memberLabel = (m: { role: MemberRole; custom_role_name?: string | null }) =>
    m.role === 'custom' ? (m.custom_role_name ?? roleLabel('custom')) : roleLabel(m.role);
  useEffect(() => {
    if (roleChoices.length > 0 && !roleChoices.some((c) => c.value === inviteRole))
      setInviteRole(roleChoices[roleChoices.length - 1].value);
  }, [roleChoices, inviteRole]);

  async function createInvitation(e: React.FormEvent) {
    e.preventDefault();
    if (!active) return;
    setCreating(true);
    setError('');
    setCopied(false);
    try {
      const email = inviteEmail.trim();
      const data = await workspaceApi<{
        accessCode: string;
        expiresAt: string;
        emailed?: 'sent' | 'failed' | 'off';
        passwordLink?: string | null;
      }>(email ? 'invite_email' : 'create_invitation', {
        workspaceId: active.id,
        ...parseRoleValue(inviteRole),
        expiresInHours: inviteHours,
        label: inviteLabel.trim(),
        email: email || undefined,
      });
      setNewCode({
        code: data.accessCode,
        expiresAt: data.expiresAt,
        roleLabel: choiceLabel(inviteRole),
        label: email || inviteLabel.trim(),
        email: email || undefined,
        emailed: data.emailed,
        passwordLink: data.passwordLink ?? null,
      });
      setInviteLabel('');
      setInviteEmail('');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function copyCode() {
    if (!newCode) return;
    try {
      await navigator.clipboard.writeText(newCode.code);
      setCopied(true);
    } catch {
      setError(t('workspace.copyFailed'));
    }
  }

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setJoinMessage(null);
    if (!isWellFormedAccessCode(joinCode)) {
      setJoinMessage({ ok: false, text: t('workspace.enterFullCode') });
      return;
    }
    setJoining(true);
    try {
      const data = await workspaceApi<{
        workspaceId: string;
        role: MemberRole;
        alreadyMember: boolean;
      }>('redeem', { code: joinCode });
      setJoinCode('');
      clearPendingJoin();
      await refresh();
      selectWorkspace(data.workspaceId);
      setJoinMessage({
        ok: true,
        text: data.alreadyMember
          ? t('workspace.alreadyMember')
          : t('workspace.joinedAs', { role: roleLabel(data.role) }),
      });
    } catch (err: any) {
      setJoinMessage({ ok: false, text: err.message });
    } finally {
      setJoining(false);
    }
  }

  async function changeRole(member: Member, nextRole: string) {
    if (!active) return;
    setError('');
    try {
      await workspaceApi('update_role', {
        workspaceId: active.id,
        userId: member.user_id,
        ...parseRoleValue(nextRole),
      });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!active || !newName.trim()) return;
    setError('');
    try {
      await workspaceApi('rename', { workspaceId: active.id, name: newName.trim() });
      setRenaming(false);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function setRequireMfa(required: boolean) {
    if (!active) return;
    setError('');
    setSavingSecurity(true);
    try {
      await workspaceApi('set_require_mfa', { workspaceId: active.id, required });
      await load();
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingSecurity(false);
    }
  }

  const membersWithoutMfa = members.filter((m) => memberMfa[m.user_id] === false).length;

  return (
    <aside
      className="fixed inset-y-0 right-0 z-50 w-full max-w-sm lg:static lg:z-auto lg:w-80 flex flex-col border-l h-full"
      // Phones: clear the notch and home indicator (0 on desktop browsers).
      style={{
        background: 'var(--surface-1)',
        borderColor: 'var(--border)',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
      aria-label={t('erp.workspaceAndMembers')}
    >
      <div
        className="h-12 border-b flex items-center justify-between px-4 flex-shrink-0"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-2">
          <Users size={14} className="text-muted-foreground" />
          <span className="text-[0.8rem] font-semibold text-foreground">
            {t('workspace.title')}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 max-lg:p-3 max-lg:-mr-2 rounded text-muted-foreground hover:text-foreground"
          aria-label={t('workspace.close')}
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {!ready ? (
          <p className="text-[0.78rem] text-muted-foreground">{t('workspace.loading')}</p>
        ) : !enabled ? (
          <div className="rounded-lg border border-border px-3 py-3 text-[0.78rem] text-muted-foreground">
            {unavailableReason === 'unavailable'
              ? t('workspace.notAvailable')
              : t('workspace.notEnabled')}{' '}
            {t('workspace.dataStays')}
          </div>
        ) : (
          <>
            <section>
              <p className={sectionTitle}>{t('workspace.current')}</p>
              {workspaces.length > 1 ? (
                <select
                  className={inputCls}
                  style={inputStyle}
                  value={active?.id ?? ''}
                  onChange={(e) => selectWorkspace(e.target.value)}
                >
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} · {w.customRoleName ?? roleLabel(w.role)}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-[0.85rem] font-medium text-foreground">{active?.name}</p>
              )}
              {manage && active && !renaming && (
                <button
                  type="button"
                  onClick={() => {
                    setNewName(active.name);
                    setRenaming(true);
                  }}
                  className="mt-1 text-[0.68rem] text-muted-foreground hover:text-foreground underline underline-offset-2"
                >
                  {t('ws.rename')}
                </button>
              )}
              {renaming && (
                <form onSubmit={saveName} className="mt-2 flex gap-1.5">
                  <input
                    aria-label={t('ws.renameLabel')}
                    className={inputCls}
                    style={inputStyle}
                    maxLength={80}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="px-2 rounded-lg text-[0.7rem] font-medium bg-primary text-primary-foreground whitespace-nowrap"
                  >
                    {t('ws.renameSave')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenaming(false)}
                    className="px-1 text-muted-foreground hover:text-foreground"
                    aria-label={t('common.cancel')}
                  >
                    <X size={12} />
                  </button>
                </form>
              )}
              {security?.access_blocked && (
                <p
                  className="mt-2 rounded-lg border border-amber-300/60 bg-amber-50/60 dark:bg-amber-950/20 px-2.5 py-2 text-[0.72rem] text-amber-800 dark:text-amber-300"
                  role="alert"
                >
                  {t('ws.security.blocked')}
                </p>
              )}
              {active && (
                <p className="text-[0.72rem] text-muted-foreground mt-1.5">
                  {t('workspace.yourRole')}{' '}
                  <span className="text-foreground font-medium">
                    {active.customRoleName ?? roleLabel(active.role)}
                  </span>{' '}
                  — {t(`roleDesc.${active.role}`)}
                  {!active.isOwner && active && (
                    <>
                      {' '}
                      ·{' '}
                      {t('workspace.owner', {
                        email: workspaces.find((w) => w.id === active.id)?.ownerEmail ?? '',
                      })}
                    </>
                  )}
                </p>
              )}
            </section>

            {error && <p className="text-[0.75rem] text-red-600 dark:text-red-400">{error}</p>}

            <section>
              <p className={sectionTitle}>{t('workspace.members', { count: members.length })}</p>
              <ul className="space-y-2">
                {members.map((m) => {
                  const editable =
                    manage && !m.is_owner && m.user_id !== user?.id && !!m.can_manage;
                  const current = roleValue(m.role, m.custom_role_id);
                  return (
                    <li key={m.user_id} className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[0.78rem] text-foreground truncate">
                          {m.full_name || m.email}
                          {m.user_id === user?.id ? ` ${t('workspace.you')}` : ''}
                        </p>
                        <p className="text-[0.68rem] text-muted-foreground truncate">
                          {m.email}
                          {m.user_id in memberMfa && (
                            <span
                              className={`ml-1.5 ${memberMfa[m.user_id] ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`}
                            >
                              ·{' '}
                              {memberMfa[m.user_id]
                                ? t('ws.security.memberMfaOn')
                                : t('ws.security.memberMfaOff')}
                            </span>
                          )}
                        </p>
                      </div>
                      {editable ? (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <select
                            aria-label={t('workspace.roleFor', { email: m.email })}
                            className="rounded border px-1.5 py-1 text-[0.7rem] text-foreground"
                            style={inputStyle}
                            value={current}
                            onChange={(e) => changeRole(m, e.target.value)}
                          >
                            {!roleChoices.some((c) => c.value === current) && (
                              <option value={current}>{memberLabel(m)}</option>
                            )}
                            {roleChoices.map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => setDialog({ kind: 'remove', member: m })}
                            className="p-1 text-muted-foreground hover:text-foreground"
                            title={t('workspace.removeMember')}
                            aria-label={t('workspace.removeNamed', { email: m.email })}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ) : (
                        <span className="text-[0.68rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex-shrink-0">
                          {memberLabel(m)}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {active && !active.isOwner && (
                <button
                  onClick={() => setDialog({ kind: 'leave' })}
                  className="mt-3 flex items-center gap-1.5 text-[0.72rem] text-muted-foreground hover:text-foreground"
                >
                  <LogOut size={12} /> {t('workspace.leave')}
                </button>
              )}
            </section>

            {manageRoles && active && (
              <section>
                <button
                  type="button"
                  onClick={() => setRolesOpen(true)}
                  className="flex items-center gap-1.5 text-[0.72rem] text-muted-foreground hover:text-foreground"
                >
                  <Shield size={12} /> {t('roles.manage')}
                </button>
              </section>
            )}

            {manage && (
              <section>
                <p className={sectionTitle}>{t('workspace.invite')}</p>
                {newCode ? (
                  <div
                    className="rounded-lg border border-border p-3 space-y-2"
                    style={{ background: 'var(--background)' }}
                  >
                    <p className="text-[0.72rem] text-muted-foreground">
                      {t('workspace.codeFor')}{' '}
                      <span className="text-foreground">{newCode.roleLabel}</span>
                      {newCode.label ? ` (${newCode.label})` : ''}.{' '}
                      {t('workspace.codeWorksOnce', { date: formatDateTime(newCode.expiresAt) })}
                    </p>
                    <div className="flex items-center gap-2">
                      <code
                        className="flex-1 select-all break-all rounded bg-muted px-2 py-1.5 text-[0.8rem] font-mono text-foreground"
                        aria-label={t('workspace.newCode')}
                      >
                        {newCode.code}
                      </code>
                      <button
                        onClick={copyCode}
                        className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[0.72rem] font-medium bg-primary text-primary-foreground"
                      >
                        {copied ? (
                          <>
                            <Check size={12} /> {t('common.copied')}
                          </>
                        ) : (
                          <>
                            <Copy size={12} /> {t('common.copy')}
                          </>
                        )}
                      </button>
                    </div>
                    {newCode.email && newCode.emailed === 'sent' && (
                      <p className="text-[0.68rem] text-green-700 dark:text-green-400">
                        {t('workspace.inviteSent', { email: newCode.email })}
                      </p>
                    )}
                    {newCode.email && newCode.emailed && newCode.emailed !== 'sent' && (
                      <p className="text-[0.68rem] text-amber-700 dark:text-amber-400">
                        {newCode.emailed === 'off'
                          ? t('workspace.inviteMailOff')
                          : t('workspace.inviteNotSent')}
                      </p>
                    )}
                    {newCode.passwordLink && (
                      <div className="space-y-1">
                        <p className="text-[0.68rem] text-muted-foreground">
                          {t('workspace.passwordLink')}
                        </p>
                        <code className="block select-all break-all rounded bg-muted px-2 py-1.5 text-[0.7rem] font-mono text-foreground">
                          {newCode.passwordLink}
                        </code>
                      </div>
                    )}
                    <p className="text-[0.68rem] text-amber-700 dark:text-amber-400">
                      {t('workspace.shownOnce')}
                    </p>
                    <button
                      onClick={() => {
                        setNewCode(null);
                        setCopied(false);
                      }}
                      className="text-[0.72rem] text-muted-foreground hover:text-foreground"
                    >
                      {t('common.done')}
                    </button>
                  </div>
                ) : (
                  <form onSubmit={createInvitation} className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        aria-label={t('workspace.role')}
                        className={inputCls}
                        style={inputStyle}
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value)}
                      >
                        {roleChoices.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={t('workspace.validFor')}
                        className={inputCls}
                        style={inputStyle}
                        value={inviteHours}
                        onChange={(e) => setInviteHours(Number(e.target.value))}
                      >
                        {EXPIRY_HOURS.map((hours) => (
                          <option key={hours} value={hours}>
                            {t('workspace.valid', { duration: t(`workspace.duration.${hours}`) })}
                          </option>
                        ))}
                      </select>
                    </div>
                    <p className="text-[0.68rem] text-muted-foreground">
                      {choiceDescription(inviteRole)}
                    </p>
                    <input
                      type="email"
                      className={inputCls}
                      style={inputStyle}
                      placeholder={t('workspace.inviteEmail')}
                      aria-label={t('workspace.inviteEmail')}
                      maxLength={254}
                      autoComplete="off"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                    />
                    <p className="text-[0.66rem] text-muted-foreground">
                      {t('workspace.inviteEmailHint')}
                    </p>
                    <input
                      className={inputCls}
                      style={inputStyle}
                      placeholder={t('workspace.labelPlaceholder')}
                      maxLength={120}
                      value={inviteLabel}
                      onChange={(e) => setInviteLabel(e.target.value)}
                    />
                    <button
                      type="submit"
                      disabled={creating}
                      className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[0.75rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
                    >
                      <UserPlus size={12} />{' '}
                      {creating
                        ? t('workspace.generating')
                        : inviteEmail.trim()
                          ? t('workspace.sendInvite')
                          : t('workspace.generate')}
                    </button>
                  </form>
                )}

                {invitations.length > 0 && (
                  <ul className="mt-4 space-y-2">
                    {invitations.slice(0, 15).map((inv) => (
                      <li key={inv.id} className="rounded-lg border border-border px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[0.75rem] text-foreground truncate">
                            {inv.label || roleLabel(inv.role)}
                          </span>
                          <span
                            className={`text-[0.62rem] px-1.5 py-0.5 rounded font-medium ${STATUS_STYLE[inv.status]}`}
                          >
                            {t(`status.${inv.status}`)}
                          </span>
                        </div>
                        <p className="text-[0.66rem] text-muted-foreground mt-0.5">
                          {roleLabel(inv.role)} ·{' '}
                          {inv.status === 'pending'
                            ? timeLeft(inv.expires_at, t)
                            : inv.status === 'redeemed'
                              ? t('workspace.usedBy', {
                                  email: inv.redeemed_by_email ?? t('workspace.aMember'),
                                })
                              : t('workspace.expires', { date: formatDateTime(inv.expires_at) })}
                        </p>
                        {inv.status === 'pending' &&
                          (inv.role === 'custom' || grantable.includes(inv.role)) && (
                            <button
                              onClick={() => setDialog({ kind: 'revoke', invitation: inv })}
                              className="mt-1 text-[0.68rem] text-muted-foreground hover:text-foreground underline underline-offset-2"
                            >
                              {t('workspace.revoke')}
                            </button>
                          )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {security && (
              <section>
                <p className={sectionTitle}>{t('ws.security.title')}</p>
                <label className="flex items-start gap-2 text-[0.75rem] text-foreground">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={security.require_mfa}
                    disabled={
                      !active?.isOwner ||
                      savingSecurity ||
                      (!security.require_mfa && !security.my_mfa_enrolled)
                    }
                    onChange={(e) => setRequireMfa(e.target.checked)}
                  />
                  <span>{t('ws.security.requireMfa')}</span>
                </label>
                <p className="text-[0.68rem] text-muted-foreground mt-1">
                  {t('ws.security.requireMfaDesc')}
                </p>
                {!active?.isOwner && (
                  <p className="text-[0.68rem] text-muted-foreground mt-1">
                    {t('ws.security.ownerOnly')}
                  </p>
                )}
                {active?.isOwner && !security.my_mfa_enrolled && !security.require_mfa && (
                  <p className="text-[0.68rem] text-amber-700 dark:text-amber-400 mt-1">
                    {t('ws.security.needOwnMfa')}
                  </p>
                )}
                {active?.isOwner &&
                  !security.require_mfa &&
                  membersWithoutMfa > 0 &&
                  security.my_mfa_enrolled && (
                    <p className="text-[0.68rem] text-amber-700 dark:text-amber-400 mt-1">
                      {t('ws.security.missing', { count: membersWithoutMfa })}
                    </p>
                  )}
              </section>
            )}

            {audit.length > 0 && (
              <section>
                <p className={sectionTitle}>{t('workspace.activity')}</p>
                <ul id={activityListId} className="space-y-1.5">
                  {(activityExpanded ? audit : audit.slice(0, ACTIVITY_PREVIEW)).map((entry) => (
                    <li key={entry.id} className="text-[0.68rem] text-muted-foreground break-words">
                      <span className="text-foreground">
                        {AUDIT_ACTIONS.includes(entry.action)
                          ? t(`audit.${entry.action}` as MessageKey)
                          : entry.action}
                      </span>
                      {entry.target_email && entry.target_email !== entry.actor_email
                        ? ` · ${entry.target_email}`
                        : ''}
                      {entry.actor_email
                        ? ` · ${t(
                            // Changed from ETNA's admin panel, not by a member.
                            entry.details?.via === 'etna_admin'
                              ? 'workspace.byEtna'
                              : 'workspace.by',
                            { email: entry.actor_email }
                          )}`
                        : ''}{' '}
                      · {formatDateTime(entry.created_at)}
                    </li>
                  ))}
                </ul>
                {audit.length > ACTIVITY_PREVIEW && (
                  <button
                    type="button"
                    onClick={() => setActivityExpanded((open) => !open)}
                    aria-expanded={activityExpanded}
                    aria-controls={activityListId}
                    className="mt-2 rounded text-[0.68rem] text-muted-foreground hover:text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {activityExpanded
                      ? t('workspace.activityShowLess')
                      : t('workspace.activityShowAll', { count: fmt.number(audit.length) })}
                  </button>
                )}
              </section>
            )}
          </>
        )}

        {enabled && (
          <section>
            <p className={sectionTitle}>{t('workspace.join')}</p>
            {linkCode && joinCode === linkCode && (
              <p className="mb-2 text-[0.7rem] text-muted-foreground">
                {t('workspace.joinPending')}
              </p>
            )}
            <form onSubmit={join} className="space-y-2">
              <input
                className={`${inputCls} font-mono uppercase`}
                style={inputStyle}
                placeholder="ETNA-XXXXX-XXXXX-XXXXX-XXXXX"
                aria-label={t('workspace.accessCode')}
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
              />
              <button
                type="submit"
                disabled={joining || !joinCode.trim()}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[0.75rem] font-medium border border-border text-foreground disabled:opacity-50"
              >
                <KeyRound size={12} />{' '}
                {joining ? t('workspace.checking') : t('workspace.joinWithCode')}
              </button>
              {joinMessage && (
                <p
                  className={`text-[0.72rem] ${joinMessage.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
                >
                  {joinMessage.text}
                </p>
              )}
            </form>
          </section>
        )}
      </div>

      {rolesOpen && active && (
        <RoleEditor
          workspaceId={active.id}
          myPermissions={active.permissions}
          api={workspaceApi}
          onClose={() => setRolesOpen(false)}
          onChanged={() => {
            void load();
            void refresh();
          }}
        />
      )}
      {dialog?.kind === 'revoke' && active && (
        <ReasonDialog
          title={t('workspace.revokeTitle')}
          description={t('workspace.revokeBody')}
          confirmLabel={t('workspace.revokeConfirm')}
          required={false}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            await workspaceApi('revoke_invitation', { invitationId: dialog.invitation.id, reason });
            await load();
          }}
        />
      )}
      {dialog?.kind === 'remove' && active && (
        <ReasonDialog
          title={t('workspace.removeNamed', { email: dialog.member.email })}
          description={t('workspace.removeBody')}
          confirmLabel={t('workspace.removeMember')}
          required={false}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            await workspaceApi('remove_member', {
              workspaceId: active.id,
              userId: dialog.member.user_id,
              reason,
            });
            await load();
          }}
        />
      )}
      {dialog?.kind === 'leave' && active && user && (
        <ReasonDialog
          title={t('workspace.leaveTitle')}
          description={t('workspace.leaveBody', { name: active.name })}
          confirmLabel={t('workspace.leaveConfirm')}
          required={false}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            await workspaceApi('remove_member', {
              workspaceId: active.id,
              userId: user.id,
              reason,
            });
            const personal = workspaces.find((w) => w.isOwner && w.isPersonal);
            if (personal) selectWorkspace(personal.id);
            await refresh();
          }}
        />
      )}
    </aside>
  );
}
