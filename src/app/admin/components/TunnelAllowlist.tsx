'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { adminGet } from './api';
import { buttonCls, fieldCls, rowCls, tableCls, theadCls } from './ui';
import { useAdminPath } from './AdminShell';

export interface TunnelEntry {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  host: string;
  purpose: string;
  created_at: string;
}

interface WorkspaceChoice {
  workspace_id: string;
  name: string;
}

/** Example entry (an address, not translated). */
const HOST_EXAMPLE = '10.20.0.5:50000';

/**
 * Tunnels (20261012000046): for one company only, the internal host:port its
 * zero-trust tunnel arrives at, which its Terminal connections may then reach.
 * Super admins add and remove entries; every change is in the security log.
 */
export function TunnelAllowlist({
  entries,
  editable,
  onChange,
}: {
  entries: TunnelEntry[];
  editable: boolean;
  onChange: (body: Record<string, unknown>) => Promise<void>;
}) {
  const ap = useAdminPath();
  const { t, fmt } = useI18n();
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<WorkspaceChoice[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceChoice | null>(null);
  const [host, setHost] = useState('');
  const [purpose, setPurpose] = useState('');

  useEffect(() => {
    if (!editable || workspace) return;
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
  }, [search, workspace, editable]);

  return (
    <div className="space-y-3 px-5 py-4">
      <p className="text-[0.75rem] text-muted-foreground">{t('gov.tunnelsIntro')}</p>
      {entries.length === 0 ? (
        <p className="text-[0.78rem] text-muted-foreground">{t('gov.noTunnels')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={`${tableCls} min-w-[560px]`}>
            <thead className={theadCls}>
              <tr>
                <th className="px-2 py-2 font-medium">{t('padmin.nav.workspaces')}</th>
                <th className="px-2 py-2 font-medium">{t('gov.tunnelHost')}</th>
                <th className="px-2 py-2 font-medium">{t('gov.tunnelPurpose')}</th>
                <th className="px-2 py-2 font-medium">{t('gov.tunnelAdded')}</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className={rowCls}>
                  <td className="px-2 py-2">
                    <Link
                      href={ap(`/workspaces/${e.workspace_id}`)}
                      className="underline-offset-2 hover:underline"
                    >
                      {e.workspace_name ?? e.workspace_id}
                    </Link>
                  </td>
                  <td className="px-2 py-2 font-mono">{e.host}</td>
                  <td className="px-2 py-2 text-muted-foreground">{e.purpose}</td>
                  <td className="px-2 py-2 text-muted-foreground">{fmt.date(e.created_at)}</td>
                  <td className="px-2 py-2 text-right">
                    {editable && (
                      <button
                        type="button"
                        className={buttonCls}
                        aria-label={t('gov.tunnelRemove')}
                        onClick={() =>
                          confirm(t('gov.tunnelRemoveConfirm', { host: e.host })) &&
                          void onChange({ action: 'remove_tunnel', id: e.id })
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editable && (
        <form
          className="grid gap-2 sm:grid-cols-[1fr_12rem_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!workspace) return;
            void onChange({
              action: 'add_tunnel',
              workspaceId: workspace.workspace_id,
              host,
              purpose,
            }).then(() => {
              setHost('');
              setPurpose('');
            });
          }}
        >
          <label className="block space-y-1">
            <span className="text-[0.7rem] text-muted-foreground">
              {t('padmin.nav.workspaces')}
            </span>
            {workspace ? (
              <button
                type="button"
                className={`${fieldCls} w-full text-left`}
                onClick={() => setWorkspace(null)}
              >
                {workspace.name}
              </button>
            ) : (
              <>
                <input
                  className={`${fieldCls} w-full`}
                  value={search}
                  placeholder={t('gov.tunnelFindCompany')}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {matches.length > 0 && (
                  <ul className="max-h-32 overflow-auto rounded border border-border text-[0.75rem]">
                    {matches.map((m) => (
                      <li key={m.workspace_id}>
                        <button
                          type="button"
                          className="w-full px-2 py-1 text-left hover:bg-[var(--surface-3)]"
                          onClick={() => setWorkspace(m)}
                        >
                          {m.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </label>
          <label className="block space-y-1">
            <span className="text-[0.7rem] text-muted-foreground">{t('gov.tunnelHost')}</span>
            <input
              className={`${fieldCls} w-full font-mono`}
              value={host}
              placeholder={HOST_EXAMPLE}
              onChange={(e) => setHost(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[0.7rem] text-muted-foreground">{t('gov.tunnelPurpose')}</span>
            <input
              className={`${fieldCls} w-full`}
              value={purpose}
              maxLength={200}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className={buttonCls}
            disabled={!workspace || !host.trim() || !purpose.trim()}
          >
            {t('gov.tunnelAdd')}
          </button>
        </form>
      )}
    </div>
  );
}
