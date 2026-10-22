'use client';

// The OAuth consent page for MCP clients (Claude's connectors and others):
// which app asks, where the sign-in goes back to, what it may read, and in
// which Terminal. Approving sends the browser back with a one-time code.

import React, { useEffect, useState } from 'react';
import { Check, GitBranch, KeyRound, ShieldCheck, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { MCP_WRITE_TOOLS, type McpScope } from '@/lib/terminal/mcpScope';
import { McpScopeEditor, fullScope } from '@/app/terminal/components/McpScopeEditor';

type Described = {
  client: { name: string; redirectHost: string };
  terminals: { id: string; name: string; canBuild: boolean }[];
  needsMfa?: boolean;
};

const PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
] as const;

async function call(
  action: string,
  request: Record<string, string>,
  extra: Record<string, unknown> = {}
) {
  const res = await fetch('/api/oauth/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ action, ...request, ...extra }),
  });
  // Signed out (or the session ended): sign in, then come back here.
  if (res.status === 401) {
    window.location.assign(
      `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
    );
    return { success: false, error: 'signin' };
  }
  return (await res.json().catch(() => ({ success: false, error: 'failed' }))) as {
    success: boolean;
    error?: string;
    data?: Described & { redirect?: string };
  };
}

export default function AuthorizePage() {
  const { t } = useI18n();
  const [request, setRequest] = useState<Record<string, string> | null>(null);
  const [info, setInfo] = useState<Described | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [build, setBuild] = useState(false);
  // The tools the app may call (all by default); data is limited later in the Terminal.
  const [scope, setScope] = useState<McpScope>(fullScope);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = Object.fromEntries(PARAMS.map((p) => [p, q.get(p) ?? ''])) as Record<string, string>;
    setRequest(r);
    call('describe', r).then((res) => {
      if (res.success && res.data?.redirect) window.location.assign(res.data.redirect);
      else if (res.success && res.data) {
        setInfo(res.data);
        setWorkspaceId(res.data.terminals[0]?.id ?? '');
      } else if (res.error !== 'signin')
        setError(t(res.error === 'invalid_client' ? 'oauth.err.client' : 'oauth.err.failed'));
    });
  }, [t]);

  async function decide(action: 'approve' | 'deny') {
    if (!request) return;
    setBusy(true);
    const canBuild = !!info?.terminals.find((x) => x.id === workspaceId)?.canBuild;
    const res = await call(action, request, {
      workspaceId,
      canWrite: canBuild && build,
      ...(scope.tools ? { tools: scope.tools } : {}),
    });
    if (res.success && res.data?.redirect) {
      window.location.assign(res.data.redirect);
      return;
    }
    setBusy(false);
    setError(
      t(
        res.error === 'mfaRequired'
          ? 'oauth.err.mfa'
          : res.error === 'invalid_client'
            ? 'oauth.err.client'
            : 'oauth.err.failed'
      )
    );
  }

  return (
    <main className="min-h-dvh flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 space-y-5">
        <div className="flex items-center gap-2 text-foreground">
          <KeyRound size={18} />
          <h1 className="text-[1.05rem] font-semibold">{t('oauth.title')}</h1>
        </div>

        {error && (
          <p role="alert" className="text-[0.82rem] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        {!info && !error && (
          <p className="text-[0.8rem] text-muted-foreground">{t('common.loading')}</p>
        )}

        {info && (
          <>
            <div className="space-y-1">
              <p className="text-[0.9rem] text-foreground">
                {t('oauth.asks', { name: info.client.name })}
              </p>
              <p className="text-[0.75rem] text-muted-foreground">
                {t('oauth.returnsTo', { host: info.client.redirectHost })}
              </p>
            </div>

            <ul className="space-y-2 text-[0.8rem] text-foreground">
              <li className="flex gap-2">
                <GitBranch size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
                {t('oauth.canRead')}
              </li>
              <li className="flex gap-2">
                <ShieldCheck size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
                {t('oauth.yourRights')}
              </li>
              <li className="flex gap-2">
                <X size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
                {t('oauth.cannot')}
              </li>
            </ul>

            {info.terminals.length === 0 ? (
              <p className="text-[0.8rem] text-amber-700 dark:text-amber-300">
                {t(info.needsMfa ? 'oauth.err.mfa' : 'oauth.noTerminal')}
              </p>
            ) : (
              <label className="block">
                <span className="mb-1 block text-[0.72rem] text-muted-foreground">
                  {t('oauth.terminal')}
                </span>
                <select
                  className="w-full rounded-lg border border-border bg-[var(--input,transparent)] px-3 py-2 text-[0.85rem] text-foreground"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                >
                  {info.terminals.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {info.terminals.find((x) => x.id === workspaceId)?.canBuild && (
              <label className="flex items-start gap-2 rounded-lg border border-border p-3 text-[0.8rem] text-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={build}
                  onChange={(e) => setBuild(e.target.checked)}
                />
                <span>
                  {t('oauth.allowBuild')}
                  <span className="mt-0.5 block text-[0.7rem] text-muted-foreground">
                    {t('oauth.allowBuildHint')}
                  </span>
                </span>
              </label>
            )}

            {info.terminals.length > 0 && (
              <details className="rounded-lg border border-border p-3">
                <summary className="cursor-pointer text-[0.78rem] text-foreground">
                  {t('oauth.chooseTools')}
                </summary>
                <div className="mt-3">
                  <McpScopeEditor
                    scope={scope}
                    onChange={setScope}
                    canWrite={!!info.terminals.find((x) => x.id === workspaceId)?.canBuild && build}
                    datasets={[]}
                    pipelines={[]}
                    dataLimits={false}
                  />
                  <p className="mt-2 text-[0.68rem] text-muted-foreground">
                    {t('oauth.dataLater')}
                  </p>
                </div>
              </details>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => decide('deny')}
                className="flex-1 rounded-lg border border-border py-2 text-[0.85rem] text-muted-foreground disabled:opacity-50"
              >
                {t('oauth.deny')}
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  !workspaceId ||
                  (scope.tools !== null &&
                    scope.tools.filter(
                      (n) =>
                        (build && info.terminals.find((x) => x.id === workspaceId)?.canBuild) ||
                        !MCP_WRITE_TOOLS.includes(n)
                    ).length === 0)
                }
                onClick={() => decide('approve')}
                className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary py-2 text-[0.85rem] font-medium text-primary-foreground disabled:opacity-50"
              >
                <Check size={15} /> {t('oauth.approve')}
              </button>
            </div>
            <p className="text-[0.7rem] text-muted-foreground">{t('oauth.revokeHint')}</p>
          </>
        )}
      </div>
    </main>
  );
}
