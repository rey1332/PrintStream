'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { adminGet } from '../components/api';
import { Badge, Section, buttonCls, fieldCls, rowCls, tableCls, theadCls } from '../components/ui';

interface Entry {
  occurred_at: string;
  workspace_id: string | null;
  workspace_name: string | null;
  actor_email: string | null;
  actor_kind: string;
  object_kind: string;
  object_id: string | null;
  operation: string;
  rows: number | null;
  fields_unmasked: string[];
  ip: string | null;
}

const KINDS = ['', 'user', 'staff', 'schedule', 'system'];
const LIMIT = 100;

/** The data-access log (20261012000033): every read and change of workspace data. */
export default function AccessLogPage() {
  const { t, fmt } = useI18n();
  const [kind, setKind] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [more, setMore] = useState(false);

  const load = useCallback(
    async (before: string | null) => {
      const params = new URLSearchParams({ limit: String(LIMIT) });
      if (kind) params.set('kind', kind);
      if (workspace.trim()) params.set('workspace', workspace.trim());
      if (before) params.set('before', before);
      const r = await adminGet<{ entries: Entry[] }>(`/api/admin/platform/access-log?${params}`);
      if (!r.ok) return;
      setEntries((current) =>
        before && current ? [...current, ...r.data.entries] : r.data.entries
      );
      setMore(r.data.entries.length === LIMIT);
    },
    [kind, workspace]
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <Section title={t('gov.accessLog')} icon={Eye}>
      <p className="px-5 pt-3 text-[0.75rem] text-muted-foreground">{t('gov.accessLogIntro')}</p>
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        <select
          className={fieldCls}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label={t('gov.actorKind')}
        >
          {KINDS.map((k) => (
            <option key={k || 'all'} value={k}>
              {k ? t(`gov.actor.${k}` as MessageKey) : t('padmin.users.filter.all')}
            </option>
          ))}
        </select>
        <input
          className={`${fieldCls} min-w-[280px]`}
          placeholder={t('gov.workspaceIdFilter')}
          aria-label={t('gov.workspaceIdFilter')}
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
        />
      </div>
      {!entries ? (
        <div className="px-5 py-6">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      ) : entries.length === 0 ? (
        <p className="px-5 py-6 text-[0.8rem] text-muted-foreground">{t('padmin.log.empty')}</p>
      ) : (
        <div className="overflow-x-auto border-t border-border">
          <table className={`${tableCls} min-w-[900px]`}>
            <thead className={theadCls}>
              <tr>
                <th className="px-5 py-2 font-medium">{t('gov.when')}</th>
                <th className="px-2 py-2 font-medium">{t('gov.who')}</th>
                <th className="px-2 py-2 font-medium">{t('padmin.nav.workspaces')}</th>
                <th className="px-2 py-2 font-medium">{t('gov.what')}</th>
                <th className="px-2 py-2 text-right font-medium">{t('gov.rows')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.occurred_at}-${i}`} className={rowCls}>
                  <td className="whitespace-nowrap px-5 py-2 text-muted-foreground">
                    {fmt.date(e.occurred_at, { dateStyle: 'medium', timeStyle: 'medium' })}
                  </td>
                  <td className="px-2 py-2">
                    {e.actor_email ?? '—'}{' '}
                    {e.actor_kind !== 'user' && (
                      <Badge tone="warn">{t(`gov.actor.${e.actor_kind}` as MessageKey)}</Badge>
                    )}
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">{e.workspace_name ?? '—'}</td>
                  <td className="px-2 py-2">
                    {e.operation} · {e.object_kind}
                    {e.object_id ? ` · ${e.object_id}` : ''}
                    {e.fields_unmasked.length > 0 && (
                      <span className="ml-1 text-amber-700 dark:text-amber-400">
                        ({t('gov.unmasked')}: {e.fields_unmasked.join(', ')})
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{e.rows ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && entries && (
        <div className="px-5 py-3">
          <button
            type="button"
            className={buttonCls}
            onClick={() => void load(entries[entries.length - 1].occurred_at)}
          >
            {t('gov.older')}
          </button>
        </div>
      )}
    </Section>
  );
}
