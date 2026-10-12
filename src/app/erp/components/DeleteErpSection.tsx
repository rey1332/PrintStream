'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useWorkspace } from '../lib/WorkspaceContext';

interface DeleteErpSectionProps {
  workspaceId: string;
  name: string;
  inputClassName: string;
  mode?: 'delete' | 'empty';
  /** What is deleted: an ERP, or a TERMINAL on its own (same route, other words). */
  noun?: 'erp' | 'terminal';
  onDeleted?: () => void;
}

const ERRORS: Record<string, MessageKey> = {
  wrong_password: 'settings.wrongPassword',
  rate_limited: 'password.err.rateLimited',
  forbidden: 'settings.resetForbidden',
  personal: 'settings.deleteErpPersonal',
  name_mismatch: 'settings.deleteErpNameMismatch',
};

export function DeleteErpSection({
  workspaceId,
  name,
  inputClassName,
  mode = 'delete',
  noun = 'erp',
  onDeleted,
}: DeleteErpSectionProps) {
  const { t } = useI18n();
  const router = useRouter();
  const { workspaces, active, selectWorkspace, refresh } = useWorkspace();
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = confirm.trim() === name && !!password;
  const deleteLabel: MessageKey =
    noun === 'terminal' ? 'settings.deleteTerminal' : 'settings.deleteErp';

  async function remove() {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/erp/delete-erp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, confirmName: confirm.trim(), password }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success) {
        setError(t(ERRORS[result?.error] ?? 'settings.wipeFailed'));
        return;
      }
      const emptied = result.data?.emptied === true;
      toast.success(
        t(
          emptied
            ? 'settings.emptyErpDone'
            : noun === 'terminal'
              ? 'settings.deleteTerminalDone'
              : 'settings.deleteErpDone',
          {
            name: result.data?.name ?? name,
          }
        )
      );
      // Back to the person's own ERP.
      const personal = workspaces.find((w) => w.isOwner && w.isPersonal);
      if (!emptied && personal && (!onDeleted || active?.id === workspaceId))
        selectWorkspace(personal.id);
      await refresh();
      if (onDeleted) onDeleted();
      else router.push('/erp');
    } catch {
      setError(t('settings.wipeFailed'));
    } finally {
      setBusy(false);
      setPassword('');
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[0.85rem] font-medium text-foreground mb-1">
          {t(mode === 'empty' ? 'settings.emptyErp' : deleteLabel)}
        </p>
        <p className="text-[0.75rem] text-muted-foreground leading-relaxed">
          {t(
            mode === 'empty'
              ? 'settings.emptyErpDesc'
              : noun === 'terminal'
                ? 'settings.deleteTerminalDesc'
                : 'settings.deleteErpDesc'
          )}
        </p>
      </div>
      <div
        className="rounded-lg border p-4 space-y-3 bg-background"
        style={{ borderColor: 'rgba(220,38,38,0.2)' }}
      >
        <p className="text-[0.75rem] text-muted-foreground">
          {t('settings.typeToConfirm', { phrase: name })}
        </p>
        <input
          type="text"
          placeholder={name}
          aria-label={t('settings.typeToConfirm', { phrase: name })}
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            setError('');
          }}
          className={inputClassName}
        />
        <div>
          <p className="text-[0.75rem] text-muted-foreground mb-1.5 flex items-center gap-1.5">
            <Lock size={11} />
            {t('settings.enterPassword')}
          </p>
          <input
            type="password"
            placeholder={t('auth.password')}
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError('');
            }}
            className={inputClassName}
          />
        </div>
        <button
          type="button"
          onClick={() => void remove()}
          disabled={!ready || busy}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-[0.8rem] font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          style={{
            background: ready ? '#7f1d1d' : 'var(--muted)',
            color: ready ? '#fca5a5' : 'var(--muted-foreground)',
            border: '1px solid',
            borderColor: ready ? '#991b1b' : 'var(--border)',
          }}
        >
          <Trash2 size={13} />
          {busy ? t('settings.wiping') : t(mode === 'empty' ? 'settings.emptyErp' : deleteLabel)}
        </button>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-lg px-4 py-3 text-[0.8rem] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50"
        >
          {error}
        </div>
      )}
    </div>
  );
}
