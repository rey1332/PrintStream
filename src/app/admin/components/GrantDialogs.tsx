'use client';

import React, { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useAdmin } from './AdminShell';
import { adminChange, adminGet } from './api';
import {
  ADMIN_ROLES,
  GRANTABLE_WORKSPACE_ROLES,
  ROLE_LABEL,
  errorKey,
  workspaceRoleKey,
  type AdminRole,
} from './labels';
import { fieldCls } from './ui';

// Dialogs that give access: an admin role, or a role in a client's workspace.
// Both need a super admin and a fresh two-factor code; the database checks it.

function Frame({
  title,
  description,
  busy,
  ready,
  error,
  confirmLabel,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  description: string;
  busy: boolean;
  ready: boolean;
  error: string;
  confirmLabel: string;
  onSubmit: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="grant-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) onSubmit();
        }}
        className="max-h-full w-full max-w-md space-y-4 overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-lg"
      >
        <h2 id="grant-title" className="text-[0.9rem] font-semibold text-foreground">
          {title}
        </h2>
        <p className="text-[0.78rem] text-muted-foreground">{description}</p>
        {children}
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
            className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-[0.78rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[0.75rem] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function GrantAdminDialog({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const { confirmIdentity } = useAdmin();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AdminRole>('support');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true);
    setError('');
    const result = await adminChange(confirmIdentity, '/api/admin/platform/admins', {
      action: 'set',
      email: email.trim(),
      role,
    });
    setBusy(false);
    if (!result.ok) {
      if (result.error !== 'cancelled') setError(t(errorKey(result.error)));
      return;
    }
    toast.success(t('padmin.admins.saved'));
    onDone();
    onClose();
  }

  return (
    <Frame
      title={t('padmin.dash.grantAdmin')}
      description={t('padmin.dash.grantAdminBody')}
      busy={busy}
      ready={email.trim().length > 3}
      error={error}
      confirmLabel={t('padmin.dash.grant')}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <Field label={t('padmin.admins.email')}>
        <input
          type="email"
          autoFocus
          required
          maxLength={254}
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={`w-full ${fieldCls}`}
        />
      </Field>
      <Field label={t('padmin.admins.role')}>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as AdminRole)}
          className={`w-full ${fieldCls}`}
        >
          {ADMIN_ROLES.map((r) => (
            <option key={r} value={r}>
              {t(ROLE_LABEL[r])}
            </option>
          ))}
        </select>
      </Field>
    </Frame>
  );
}

interface WorkspaceChoice {
  workspace_id: string;
  name: string;
  owner_email: string | null;
}

type GrantableRole = (typeof GRANTABLE_WORKSPACE_ROLES)[number];

/**
 * Adds an account to a workspace, or changes its role there. With `workspace`
 * the workspace is fixed (its page); without, the admin searches for one.
 * With `email` the account is fixed (changing a member's role).
 */
export function GrantWorkspaceDialog({
  workspace: fixedWorkspace,
  email: fixedEmail,
  role: currentRole,
  onDone,
  onClose,
}: {
  workspace?: { id: string; name: string };
  email?: string;
  role?: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { confirmIdentity } = useAdmin();
  const [workspace, setWorkspace] = useState(fixedWorkspace ?? null);
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<WorkspaceChoice[]>([]);
  const [email, setEmail] = useState(fixedEmail ?? '');
  const [role, setRole] = useState<GrantableRole>(
    GRANTABLE_WORKSPACE_ROLES.find((r) => r === currentRole) ?? 'finance'
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (workspace) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ limit: '8' });
      if (search.trim()) params.set('q', search.trim());
      const result = await adminGet<{ rows: WorkspaceChoice[] }>(
        `/api/admin/platform/workspaces?${params}`
      );
      if (!cancelled && result.ok) setMatches(result.data.rows);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, workspace]);

  async function submit() {
    if (!workspace) return;
    setBusy(true);
    setError('');
    const result = await adminChange<{ result: string }>(
      confirmIdentity,
      `/api/admin/platform/workspaces/${workspace.id}`,
      { action: 'grant', email: email.trim(), role, reason: reason.trim() }
    );
    setBusy(false);
    if (!result.ok) {
      if (result.error !== 'cancelled') setError(t(errorKey(result.error)));
      return;
    }
    toast.success(
      t(
        result.data.result === 'added'
          ? 'padmin.access.added'
          : result.data.result === 'changed'
            ? 'padmin.access.changed'
            : 'padmin.access.unchanged',
        { email: email.trim(), name: workspace.name }
      )
    );
    onDone();
    onClose();
  }

  return (
    <Frame
      title={t(fixedEmail ? 'padmin.access.changeRole' : 'padmin.access.grant')}
      description={t('padmin.access.grantBody')}
      busy={busy}
      ready={!!workspace && email.trim().length > 3 && reason.trim().length >= 3}
      error={error}
      confirmLabel={t(fixedEmail ? 'padmin.access.changeRole' : 'padmin.dash.grant')}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      {workspace ? (
        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[0.8rem]">
          <span className="text-muted-foreground">{t('padmin.access.workspace')}</span>
          <span className="truncate font-medium text-foreground">{workspace.name}</span>
          {!fixedWorkspace && (
            <button
              type="button"
              onClick={() => setWorkspace(null)}
              aria-label={t('padmin.access.pickOther')}
              className="ml-auto text-muted-foreground hover:text-foreground"
            >
              <X size={13} />
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          <Field label={t('padmin.access.findWorkspace')}>
            <input
              type="search"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('padmin.ws.search')}
              className={`w-full ${fieldCls}`}
            />
          </Field>
          <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {matches.length === 0 ? (
              <li className="px-3 py-2 text-[0.75rem] text-muted-foreground">
                {t('padmin.access.noMatch')}
              </li>
            ) : (
              matches.map((m) => (
                <li key={m.workspace_id}>
                  <button
                    type="button"
                    onClick={() => setWorkspace({ id: m.workspace_id, name: m.name })}
                    className="w-full px-3 py-2 text-left text-[0.78rem] hover:bg-[var(--surface-2)] max-lg:min-h-11"
                  >
                    <span className="text-foreground">{m.name}</span>
                    {m.owner_email && (
                      <span className="block text-[0.7rem] text-muted-foreground">
                        {m.owner_email}
                      </span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
      <Field label={t('padmin.access.account')}>
        <input
          type="email"
          required
          maxLength={254}
          autoComplete="off"
          readOnly={!!fixedEmail}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={`w-full ${fieldCls} ${fixedEmail ? 'opacity-70' : ''}`}
        />
      </Field>
      <Field label={t('padmin.admins.col.role')}>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as GrantableRole)}
          className={`w-full ${fieldCls}`}
        >
          {GRANTABLE_WORKSPACE_ROLES.map((r) => (
            <option key={r} value={r}>
              {t(workspaceRoleKey(r)!)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('padmin.users.reason')}>
        <textarea
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={`w-full ${fieldCls}`}
        />
      </Field>
      <p className="text-[0.72rem] text-muted-foreground">{t('padmin.access.visible')}</p>
    </Frame>
  );
}
