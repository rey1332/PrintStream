'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import {
  PERMISSION_GROUPS,
  ROLE_PERMISSIONS,
  SENSITIVE_PERMISSIONS,
  WORKSPACE_ROLES,
  type Permission,
} from '../lib/erpRules';

export interface CustomRole {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  requires_mfa: boolean;
  members: number;
}

type Api = <T = unknown>(action: string, payload?: Record<string, unknown>) => Promise<T>;

const inputCls =
  'w-full rounded-lg border px-2.5 py-1.5 text-[0.78rem] text-foreground outline-none focus:border-foreground/40';
const inputStyle = { background: 'var(--input)', borderColor: 'var(--border)' };

/**
 * Custom roles of the active workspace: list, create, edit, delete. The
 * database decides (no escalation, two-factor, roles in use); this only
 * offers what the caller holds.
 */
export function RoleEditor({
  workspaceId,
  myPermissions,
  api,
  onClose,
  onChanged,
}: {
  workspaceId: string;
  myPermissions: readonly Permission[];
  api: Api;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [editing, setEditing] = useState<Partial<CustomRole> | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRoles(await api<CustomRole[]>('list_roles', { workspaceId }));
    } catch (err: any) {
      setError(err.message);
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const chosen = new Set(editing?.permissions ?? []);
  const needsMfa = [...chosen].some((p) => SENSITIVE_PERMISSIONS.includes(p));

  function toggle(permission: Permission) {
    if (!editing) return;
    const next = new Set(chosen);
    if (next.has(permission)) next.delete(permission);
    else next.add(permission);
    setEditing({ ...editing, permissions: [...next] });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('save_role', {
        workspaceId,
        roleId: editing.id ?? null,
        name: (editing.name ?? '').trim(),
        description: (editing.description ?? '').trim(),
        permissions: [...chosen],
        requiresMfa: needsMfa ? true : editing.requires_mfa !== false,
      });
      setEditing(null);
      setNotice(t('roles.saved'));
      await load();
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(role: CustomRole) {
    if (!window.confirm(t('roles.deleteBody', { name: role.name }))) return;
    setError('');
    try {
      await api('delete_role', { workspaceId, roleId: role.id });
      setNotice(t('roles.deleted'));
      await load();
      onChanged();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div
      className="overlay-mobile fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-card p-5 space-y-4"
        role="dialog"
        aria-modal="true"
        aria-label={t('roles.title')}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[1rem] font-semibold text-foreground">{t('roles.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>
        <p className="text-[0.75rem] text-muted-foreground">{t('roles.intro')}</p>
        {error && (
          <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        {notice && !error && (
          <p role="status" className="text-[0.75rem] text-green-700 dark:text-green-400">
            {notice}
          </p>
        )}

        {editing ? (
          <form onSubmit={save} className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-[0.7rem] text-muted-foreground">{t('roles.name')}</span>
                <input
                  className={inputCls}
                  style={inputStyle}
                  required
                  maxLength={60}
                  value={editing.name ?? ''}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  autoFocus
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[0.7rem] text-muted-foreground">
                  {t('roles.description')}
                </span>
                <input
                  className={inputCls}
                  style={inputStyle}
                  maxLength={300}
                  value={editing.description ?? ''}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                />
              </label>
            </div>
            {PERMISSION_GROUPS.map((group) => (
              <fieldset key={group.id} className="rounded-lg border border-border p-3">
                <legend className="px-1 text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t(`permGroup.${group.id}` as MessageKey)}
                </legend>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {group.permissions.map((permission) => {
                    const mine = myPermissions.includes(permission);
                    return (
                      <label
                        key={permission}
                        className={`flex items-start gap-2 text-[0.75rem] ${mine ? 'text-foreground' : 'text-muted-foreground'}`}
                        title={mine ? undefined : t('roles.notYours')}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={chosen.has(permission)}
                          disabled={!mine && !chosen.has(permission)}
                          onChange={() => toggle(permission)}
                        />
                        {t(`perm.${permission}` as MessageKey)}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
            <label className="flex items-start gap-2 text-[0.75rem] text-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={needsMfa || editing.requires_mfa !== false}
                disabled={needsMfa}
                onChange={(e) => setEditing({ ...editing, requires_mfa: e.target.checked })}
              />
              <span>
                {t('roles.requiresMfa')}
                {needsMfa && (
                  <span className="block text-[0.68rem] text-muted-foreground">
                    {t('roles.mfaForced')}
                  </span>
                )}
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-[0.75rem] text-muted-foreground hover:text-foreground"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={busy || !(editing.name ?? '').trim()}
                className="rounded-lg bg-primary px-3 py-1.5 text-[0.75rem] font-medium text-primary-foreground disabled:opacity-50"
              >
                {t('roles.save')}
              </button>
            </div>
          </form>
        ) : (
          <>
            <section className="space-y-1.5">
              <p className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('roles.builtIn')}
              </p>
              <ul className="space-y-1">
                {WORKSPACE_ROLES.map((role) => (
                  <li key={role} className="text-[0.75rem] text-foreground">
                    <span className="font-medium">{t(`role.${role}` as MessageKey)}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      ·{' '}
                      {t('roles.permissionsCount', {
                        count: ROLE_PERMISSIONS[role].length,
                      })}{' '}
                      · {t(`roleDesc.${role}` as MessageKey)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('roles.custom')}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setNotice('');
                    setEditing({ name: '', description: '', permissions: [], requires_mfa: true });
                  }}
                  className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-[0.72rem] font-medium text-primary-foreground"
                >
                  <Plus size={12} /> {t('roles.new')}
                </button>
              </div>
              {roles.length === 0 ? (
                <p className="text-[0.75rem] text-muted-foreground">{t('roles.none')}</p>
              ) : (
                <ul className="space-y-1.5">
                  {roles.map((role) => (
                    <li
                      key={role.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-[0.78rem] font-medium text-foreground truncate">
                          {role.name}
                        </p>
                        <p className="text-[0.68rem] text-muted-foreground truncate">
                          {t('roles.permissionsCount', { count: role.permissions.length })} ·{' '}
                          {t('roles.members', { count: role.members })}
                          {role.description ? ` · ${role.description}` : ''}
                        </p>
                      </div>
                      <div className="flex flex-shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setNotice('');
                            setEditing(role);
                          }}
                          className="p-1.5 text-muted-foreground hover:text-foreground"
                          aria-label={`${t('roles.edit')} ${role.name}`}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(role)}
                          disabled={role.members > 0}
                          className="p-1.5 text-muted-foreground hover:text-red-600 disabled:opacity-40"
                          aria-label={`${t('roles.delete')} ${role.name}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
