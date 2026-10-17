'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Building2, Check, KeyRound, Loader2, Plus, TerminalSquare, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { isWellFormedAccessCode, type WorkspaceRole } from '@/app/erp/lib/erpRules';
import { cx } from '@/components/refined/RefinedSidebar';
import { createClient } from '@/lib/data/client';
import type { ErpDirectory } from '@/lib/workspaces/directory';
import { INDUSTRIES, INDUSTRY_HELP, INDUSTRY_LABEL, type Industry } from '@/lib/industry';
import { NewTerminalForm } from './NewTerminal';

interface AddModulesDialogProps {
  directory: ErpDirectory;
  onOpenErp: (id: string) => void;
  onOpenTerminal: (id: string) => void;
  onClose: () => void;
}

type JoinMessage = { ok: boolean; text: string } | null;

async function redeem(
  code: string
): Promise<{ workspaceId: string; role: WorkspaceRole; alreadyMember: boolean }> {
  const response = await fetch('/api/erp/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'redeem', code }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success) {
    // The route's message is shown as is (like Settings → Workspace); empty = generic text.
    const error = new Error(String(result?.error ?? '')) as Error & { code?: string };
    error.code = result?.code;
    throw error;
  }
  return result.data;
}

export function AddModulesDialog({
  directory,
  onOpenErp,
  onOpenTerminal,
  onClose,
}: AddModulesDialogProps) {
  const { t } = useI18n();
  const { erps, quota, refresh } = directory;
  const closeRef = useRef<HTMLButtonElement>(null);
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [message, setMessage] = useState<JoinMessage>(null);
  const [newName, setNewName] = useState('');
  const [industry, setIndustry] = useState<Industry>('general');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [terminalBusy, setTerminalBusy] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState('');

  const limit = quota?.limit ?? 3;
  const used = quota?.used ?? erps.length;
  const full = quota ? !quota.canJoin : used >= limit;

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function join(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (!isWellFormedAccessCode(code)) {
      setMessage({ ok: false, text: t('workspace.enterFullCode') });
      return;
    }
    setJoining(true);
    try {
      const data = await redeem(code);
      setCode('');
      const rows = await refresh();
      if (data.alreadyMember) {
        setMessage({ ok: true, text: t('workspace.alreadyMember') });
      } else {
        const joined = rows.find((w) => w.id === data.workspaceId);
        setMessage({
          ok: true,
          text: t('modules.join.joined', {
            name: joined?.name ?? 'ERP',
            role: t(`role.${data.role}` as MessageKey),
          }),
        });
      }
    } catch (error) {
      const e = error as Error & { code?: string };
      setMessage({
        ok: false,
        text:
          e.code === 'workspace_limit'
            ? t('modules.limitReached', { limit })
            : e.message || t('docs.error.failed'),
      });
      if (e.code === 'workspace_limit') void refresh();
    } finally {
      setJoining(false);
    }
  }

  async function createErp(event: React.FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError('');
    const { data, error } = await createClient().rpc('erp_create_erp_v2', {
      p_name: name,
      p_industry: industry,
    });
    if (error || !data) {
      setCreating(false);
      setCreateError(
        /maximum of/.test(error?.message ?? '')
          ? t('modules.limitReached', { limit })
          : t('docs.error.failed')
      );
      void refresh();
      return;
    }
    await refresh();
    setCreating(false);
    setNewName('');
    // Opens the new ERP (it becomes the active one).
    onOpenErp(String(data));
  }

  // Terminal is added per ERP by its Owner or an Admin; it does not use an ERP slot.
  async function setTerminal(id: string, enabled: boolean) {
    setTerminalBusy(id);
    setTerminalError('');
    const { error } = await createClient().rpc('erp_set_terminal', {
      p_workspace_id: id,
      p_enabled: enabled,
    });
    await refresh();
    setTerminalBusy(null);
    if (error) setTerminalError(t('modules.terminal.failed'));
    else if (enabled) onOpenTerminal(id);
  }

  // In <body>: the sidebar is transformed (drawer), which would trap a fixed overlay inside it.
  return createPortal(
    <div
      className="overlay-mobile fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-modules-title"
        className="ui-refined flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="add-modules-title" className="text-[1rem] font-semibold">
              {t('nav.addModules')}
            </h2>
            <p className="mt-0.5 text-[0.75rem] text-muted-foreground">
              {t('modules.subtitle', { limit })}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:bg-surface-3 hover:text-foreground max-lg:h-11 max-lg:w-11"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section aria-labelledby="modules-quota">
            <div className="flex items-center justify-between text-[0.75rem]">
              <span id="modules-quota" className="font-medium">
                {t('modules.yourErps')}
              </span>
              <span
                className={cx(
                  'tabular-nums',
                  full ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'
                )}
              >
                {t('modules.used', { used, limit })}
              </span>
            </div>
            <div className="mt-2 flex gap-1" aria-hidden>
              {Array.from({ length: limit }, (_, i) => (
                <span
                  key={i}
                  className={cx(
                    'h-1.5 flex-1 rounded-full',
                    i < used ? 'bg-foreground' : 'bg-surface-3'
                  )}
                />
              ))}
            </div>
            <ul className="mt-3 divide-y divide-border rounded-[var(--radius)] border border-border">
              {erps.map((erp) => (
                <li key={erp.id} className="flex items-center gap-3 px-3 py-2">
                  <Building2 size={15} className="shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.8125rem] font-medium">{erp.name}</p>
                    <p className="truncate text-[0.6875rem] text-muted-foreground">
                      {t(`role.${erp.role}` as MessageKey)}
                      {!erp.isOwner && erp.ownerEmail
                        ? ` · ${t('modules.ownedBy', { email: erp.ownerEmail })}`
                        : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenErp(erp.id)}
                    className="shrink-0 rounded-[var(--radius)] border border-border px-2.5 py-1 text-[0.75rem] hover:bg-surface-3 max-lg:min-h-11"
                  >
                    {t('modules.open')}
                  </button>
                </li>
              ))}
              {erps.length === 0 && (
                <li className="px-3 py-3 text-[0.75rem] text-muted-foreground">
                  {t('nav.file.noErps')}
                </li>
              )}
            </ul>
          </section>

          <section aria-labelledby="modules-terminal" className="space-y-2">
            <h3
              id="modules-terminal"
              className="flex items-center gap-2 text-[0.8125rem] font-medium"
            >
              <TerminalSquare size={14} aria-hidden /> {t('modules.terminal.title')}
            </h3>
            <p className="text-[0.75rem] text-muted-foreground">{t('modules.terminal.ownHelp')}</p>
            <NewTerminalForm onCreated={(id) => onOpenTerminal(id)} />
            <p className="pt-1 text-[0.75rem] text-muted-foreground">
              {t('modules.terminal.help')}
            </p>
            <ul className="divide-y divide-border rounded-[var(--radius)] border border-border">
              {erps.map((erp) => (
                <li key={erp.id} className="flex items-center gap-3 px-3 py-2">
                  <Building2 size={15} className="shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.8125rem] font-medium">{erp.name}</p>
                    <p className="truncate text-[0.6875rem] text-muted-foreground">
                      {erp.terminal
                        ? t('modules.terminal.added')
                        : erp.canManageTerminal
                          ? t('modules.terminal.notAdded')
                          : t('modules.terminal.askOwner')}
                    </p>
                  </div>
                  {erp.terminal && (
                    <button
                      type="button"
                      onClick={() => onOpenTerminal(erp.id)}
                      className="shrink-0 rounded-[var(--radius)] border border-border px-2.5 py-1 text-[0.75rem] hover:bg-surface-3 max-lg:min-h-11"
                    >
                      {t('modules.open')}
                    </button>
                  )}
                  {erp.canManageTerminal && (
                    <button
                      type="button"
                      disabled={terminalBusy !== null}
                      onClick={() => {
                        if (
                          erp.terminal &&
                          !confirm(t('modules.terminal.removeConfirm', { name: erp.name }))
                        )
                          return;
                        void setTerminal(erp.id, !erp.terminal);
                      }}
                      className={cx(
                        'inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius)] px-2.5 py-1 text-[0.75rem] disabled:opacity-50 max-lg:min-h-11',
                        erp.terminal
                          ? 'border border-border text-muted-foreground hover:bg-surface-3 hover:text-foreground'
                          : 'bg-primary font-medium text-primary-foreground'
                      )}
                    >
                      {terminalBusy === erp.id && (
                        <Loader2 size={12} className="animate-spin" aria-hidden />
                      )}
                      {erp.terminal ? t('modules.terminal.remove') : t('modules.terminal.add')}
                    </button>
                  )}
                </li>
              ))}
              {erps.length === 0 && (
                <li className="px-3 py-3 text-[0.75rem] text-muted-foreground">
                  {t('nav.file.noErps')}
                </li>
              )}
            </ul>
            {terminalError && (
              <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
                {terminalError}
              </p>
            )}
          </section>

          <section aria-labelledby="modules-join" className="space-y-2">
            <h3 id="modules-join" className="flex items-center gap-2 text-[0.8125rem] font-medium">
              <KeyRound size={14} aria-hidden /> {t('modules.join.title')}
            </h3>
            {full ? (
              <p
                className="rounded-[var(--radius)] border border-amber-300/60 bg-amber-50 px-3 py-2 text-[0.75rem] text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-300"
                role="status"
              >
                {t('modules.limitReached', { limit })}
              </p>
            ) : (
              <>
                <p className="text-[0.75rem] text-muted-foreground">{t('modules.join.help')}</p>
                <form onSubmit={join} className="flex gap-2">
                  <input
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="ETNA-XXXXX-XXXXX-XXXXX-XXXXX"
                    aria-label={t('modules.join.title')}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={64}
                    className="min-w-0 flex-1 rounded-[var(--radius)] border border-border bg-transparent px-3 py-2 font-mono text-[0.8rem] uppercase outline-none focus:border-foreground/40"
                  />
                  <button
                    type="submit"
                    disabled={joining || !code.trim()}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius)] bg-primary px-3 py-2 text-[0.8rem] font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {joining && <Loader2 size={13} className="animate-spin" aria-hidden />}
                    {joining ? t('modules.join.joining') : t('modules.join.submit')}
                  </button>
                </form>
              </>
            )}
            {message && (
              <p
                role={message.ok ? 'status' : 'alert'}
                className={cx(
                  'flex items-start gap-1.5 text-[0.75rem]',
                  message.ok
                    ? 'text-green-700 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400'
                )}
              >
                {message.ok && <Check size={13} className="mt-0.5 shrink-0" aria-hidden />}
                {message.text}
              </p>
            )}
          </section>

          <section aria-labelledby="modules-create" className="space-y-2">
            <h3
              id="modules-create"
              className="flex items-center gap-2 text-[0.8125rem] font-medium"
            >
              <Plus size={14} aria-hidden /> {t('modules.create.title')}
            </h3>
            {!full && (
              <>
                <p className="text-[0.75rem] text-muted-foreground">{t('modules.create.help')}</p>
                <form onSubmit={createErp} className="space-y-2">
                  <label className="block">
                    <span className="mb-1 block text-[0.72rem] font-medium">
                      {t('industry.label')}
                    </span>
                    <select
                      value={industry}
                      onChange={(event) => setIndustry(event.target.value as Industry)}
                      className="w-full rounded-[var(--radius)] border border-border bg-transparent px-3 py-2 text-[0.8rem] outline-none focus:border-foreground/40"
                    >
                      {INDUSTRIES.map((code) => (
                        <option key={code} value={code}>
                          {t(INDUSTRY_LABEL[code])}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1 block text-[0.7rem] text-muted-foreground">
                      {t(INDUSTRY_HELP[industry])}
                    </span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      value={newName}
                      onChange={(event) => setNewName(event.target.value)}
                      placeholder={t('modules.create.placeholder')}
                      aria-label={t('modules.create.title')}
                      maxLength={120}
                      className="min-w-0 flex-1 rounded-[var(--radius)] border border-border bg-transparent px-3 py-2 text-[0.8rem] outline-none focus:border-foreground/40"
                    />
                    <button
                      type="submit"
                      disabled={creating || !newName.trim()}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius)] bg-primary px-3 py-2 text-[0.8rem] font-medium text-primary-foreground disabled:opacity-50"
                    >
                      {creating && <Loader2 size={13} className="animate-spin" aria-hidden />}
                      {creating ? t('modules.create.creating') : t('modules.create.submit')}
                    </button>
                  </div>
                </form>
              </>
            )}
            {createError && (
              <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
                {createError}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body
  );
}
