'use client';

// MCP access for AI assistants (Claude, Cursor, …): personal tokens that let
// an assistant read this Terminal's pipelines, runs and datasets through
// /api/mcp with the member's own rights. A token is shown once.

import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { terminalApi, type McpToken } from '@/lib/terminal/client';
import { Dialog, buttonCls, errorMessage, inputCls, primaryCls } from './shared';

const DAYS = [30, 90, 180, 365];

function CopyBlock({ label, text }: { label: string; text: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] text-muted-foreground">{label}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[0.68rem] text-muted-foreground hover:text-foreground"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setDone(true);
              setTimeout(() => setDone(false), 1500);
            } catch {
              toast.error(t('ps.mcpAccess.copyFailed'));
            }
          }}
        >
          {done ? <Check size={12} /> : <Copy size={12} />}{' '}
          {t(done ? 'ps.mcpAccess.copied' : 'ps.mcpAccess.copy')}
        </button>
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-[var(--surface-3)] p-2 text-[0.68rem] text-foreground">
        {text}
      </pre>
    </div>
  );
}

export function McpAccess({
  workspaceId,
  permissions,
}: {
  workspaceId: string;
  permissions: string[];
}) {
  const { t, fmt } = useI18n();
  const [tokens, setTokens] = useState<McpToken[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const allowed = permissions.includes('pipelines.view');

  const load = useCallback(async () => {
    try {
      setTokens(await terminalApi<McpToken[]>('mcpTokens.list', { workspaceId }));
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  }, [workspaceId, t]);
  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  if (!allowed) return null;
  const url = typeof window === 'undefined' ? '/api/mcp' : `${window.location.origin}/api/mcp`;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await terminalApi<{ id: string; token: string }>('mcpToken.create', {
        workspaceId,
        name,
        days,
      });
      setCreating(false);
      setCreated({ name, token: r.token });
      setName('');
      await load();
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(tok: McpToken) {
    if (!confirm(t('ps.mcpAccess.revokeConfirm', { name: tok.name }))) return;
    try {
      await terminalApi('mcpToken.revoke', { id: tok.id });
      toast.success(t('ps.mcpAccess.revoked'));
      await load();
    } catch (err) {
      toast.error(errorMessage(err, t));
    }
  }

  const active = (tokens ?? []).filter(
    (x) => !x.revokedAt && (!x.expiresAt || new Date(x.expiresAt) > new Date())
  );
  const ended = (tokens ?? []).filter((x) => !active.includes(x));

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[0.85rem] font-semibold text-foreground">
            <KeyRound size={15} /> {t('ps.mcpAccess.title')}
          </h2>
          <p className="mt-0.5 max-w-2xl text-[0.72rem] text-muted-foreground">
            {t('ps.mcpAccess.intro')}
          </p>
        </div>
        <button type="button" className={primaryCls} onClick={() => setCreating(true)}>
          <Plus size={13} /> {t('ps.mcpAccess.new')}
        </button>
      </div>

      <div className="rounded-lg border border-border px-3 py-2 text-[0.72rem]">
        <span className="text-muted-foreground">{t('ps.mcpAccess.endpoint')} </span>
        <code className="break-all text-foreground">{url}</code>
        <p className="mt-1 text-[0.66rem] text-muted-foreground">{t('ps.mcpAccess.tools')}</p>
      </div>

      {tokens === null ? (
        <p className="text-[0.72rem] text-muted-foreground">{t('common.loading')}</p>
      ) : active.length === 0 ? (
        <p className="text-[0.72rem] text-muted-foreground">{t('ps.mcpAccess.none')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {active.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2 py-2 text-[0.75rem]">
              <span className="font-medium text-foreground">{x.name}</span>
              <code className="text-[0.66rem] text-muted-foreground">{x.prefix}…</code>
              {!x.mine && x.owner && (
                <span className="text-[0.68rem] text-muted-foreground">{x.owner}</span>
              )}
              <span className="text-[0.66rem] text-muted-foreground">
                {x.lastUsedAt
                  ? t('ps.mcpAccess.used', { when: fmt.dateTime(x.lastUsedAt), n: x.uses })
                  : t('ps.mcpAccess.neverUsed')}
              </span>
              <span className="ml-auto text-[0.66rem] text-muted-foreground">
                {x.expiresAt && t('ps.mcpAccess.expires', { when: fmt.date(x.expiresAt) })}
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-red-500"
                aria-label={t('ps.mcpAccess.revoke')}
                title={t('ps.mcpAccess.revoke')}
                onClick={() => revoke(x)}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {ended.length > 0 && (
        <p className="text-[0.66rem] text-muted-foreground">
          {t('ps.mcpAccess.ended', { n: ended.length })}
        </p>
      )}

      {creating && (
        <Dialog title={t('ps.mcpAccess.new')} onClose={() => setCreating(false)}>
          <form className="space-y-3" onSubmit={create}>
            <label className="block">
              <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                {t('ps.mcpAccess.name')}
              </span>
              <input
                className={inputCls}
                value={name}
                maxLength={80}
                autoFocus
                placeholder={t('ps.mcpAccess.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                {t('ps.mcpAccess.validFor')}
              </span>
              <select
                className={inputCls}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {t('ps.mcpAccess.days', { n: d })}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[0.68rem] text-muted-foreground">{t('ps.mcpAccess.rights')}</p>
            <div className="flex justify-end gap-2">
              <button type="button" className={buttonCls} onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </button>
              <button type="submit" className={primaryCls} disabled={busy || !name.trim()}>
                {t('ps.mcpAccess.create')}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {created && (
        <Dialog
          title={t('ps.mcpAccess.createdTitle', { name: created.name })}
          onClose={() => setCreated(null)}
          wide
        >
          <div className="space-y-3">
            <p className="text-[0.75rem] text-amber-700 dark:text-amber-300">
              {t('ps.mcpAccess.once')}
            </p>
            <CopyBlock label={t('ps.mcpAccess.token')} text={created.token} />
            <CopyBlock
              label={t('ps.mcpAccess.claudeCode')}
              text={`claude mcp add --transport http printstream ${url} --header "Authorization: Bearer ${created.token}"`}
            />
            <CopyBlock
              label={t('ps.mcpAccess.json')}
              text={JSON.stringify(
                {
                  mcpServers: {
                    printstream: {
                      type: 'http',
                      url,
                      headers: { Authorization: `Bearer ${created.token}` },
                    },
                  },
                },
                null,
                2
              )}
            />
            <div className="flex justify-end">
              <button type="button" className={primaryCls} onClick={() => setCreated(null)}>
                {t('ps.mcpAccess.done')}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
