'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Building2, Loader2, Plus, Search } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { adminGet } from '../components/api';
import {
  Badge,
  Pager,
  Section,
  buttonCls,
  fieldCls,
  rowCls,
  tableCls,
  theadCls,
} from '../components/ui';
import { useAdmin, useAdminPath } from '../components/AdminShell';
import { CompanyDialog } from '../components/CompanyDialog';
import { ExportButton } from '../components/AccountPanels';

interface WorkspaceRow {
  workspace_id: string;
  name: string;
  owner_email: string | null;
  is_personal: boolean;
  members: number;
  created_at: string;
  last_activity: string | null;
  suspended: boolean;
}

const LIMIT = 50;
const FILTERS: { value: string; label: MessageKey }[] = [
  { value: 'all', label: 'padmin.ws.filter.all' },
  { value: 'suspended', label: 'padmin.ws.filter.suspended' },
  { value: 'shared', label: 'padmin.ws.filter.shared' },
  { value: 'personal', label: 'padmin.ws.filter.personal' },
];

export default function WorkspacesPage() {
  const ap = useAdminPath();
  const { t, fmt } = useI18n();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [applied, setApplied] = useState({ query: '', filter: 'all' });
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ rows: WorkspaceRow[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const { role } = useAdmin();

  const load = useCallback(async () => {
    const params = new URLSearchParams({
      filter: applied.filter,
      offset: String(offset),
      limit: String(LIMIT),
    });
    if (applied.query) params.set('q', applied.query);
    const result = await adminGet<{ rows: WorkspaceRow[]; total: number }>(
      `/api/admin/platform/workspaces?${params}`
    );
    if (result.ok) {
      setPage(result.data);
      setFailed(false);
    } else setFailed(true);
  }, [applied, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const when = (value: string | null) => fmt.date(value, { dateStyle: 'medium' });

  return (
    <Section
      title={t('padmin.nav.workspaces')}
      icon={Building2}
      actions={
        <>
          <ExportButton body={{ kind: 'workspaces', q: applied.query, filter: applied.filter }} />
          {role === 'super_admin' && (
            <button type="button" onClick={() => setCreating(true)} className={buttonCls}>
              <Plus size={13} />
              {t('padmin.co.new')}
            </button>
          )}
        </>
      }
    >
      {creating && (
        <CompanyDialog onClose={() => setCreating(false)} onCreated={() => void load()} />
      )}
      <p className="px-5 pt-3 text-[0.75rem] text-muted-foreground">{t('padmin.ws.subtitle')}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setApplied({ query: query.trim(), filter });
        }}
        className="flex flex-wrap items-center gap-2 px-5 py-3"
      >
        <label className="relative min-w-[220px] flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={query}
            maxLength={320}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('padmin.ws.search')}
            aria-label={t('padmin.ws.search')}
            className={`${fieldCls} w-full pl-8`}
          />
        </label>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label={t('padmin.users.filterLabel')}
          className={fieldCls}
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {t(f.label)}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-lg bg-primary px-3 py-2 text-[0.78rem] font-medium text-primary-foreground max-lg:min-h-11"
        >
          {t('padmin.log.apply')}
        </button>
      </form>

      {failed ? (
        <p role="alert" className="px-5 py-6 text-[0.8rem] text-red-600 dark:text-red-400">
          {t('padmin.err.failed')}
        </p>
      ) : !page ? (
        <div className="px-5 py-6">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      ) : page.rows.length === 0 ? (
        <p className="px-5 py-6 text-[0.8rem] text-muted-foreground">{t('padmin.log.empty')}</p>
      ) : (
        <div className="overflow-x-auto border-t border-border">
          <table className={`${tableCls} min-w-[760px]`}>
            <thead className={theadCls}>
              <tr>
                <th className="px-5 py-2 font-medium">{t('padmin.ws.col.name')}</th>
                <th className="px-3 py-2 font-medium">{t('padmin.ws.col.owner')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('padmin.ws.col.members')}</th>
                <th className="px-3 py-2 font-medium">{t('padmin.users.created')}</th>
                <th className="px-3 py-2 font-medium">{t('padmin.ws.col.lastActivity')}</th>
                <th className="px-3 py-2 font-medium">{t('padmin.users.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((w) => (
                <tr key={w.workspace_id} className={rowCls}>
                  <td className="px-5 py-2">
                    <Link
                      href={ap(`/workspaces/${w.workspace_id}`)}
                      className="text-foreground underline-offset-2 hover:underline"
                    >
                      {w.name}
                    </Link>
                    <div className="text-[0.72rem] text-muted-foreground">
                      {t(w.is_personal ? 'padmin.ws.personal' : 'padmin.ws.shared')}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{w.owner_email ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{w.members}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {when(w.created_at)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {when(w.last_activity)}
                  </td>
                  <td className="px-3 py-2">
                    {w.suspended ? (
                      <Badge tone="bad">{t('padmin.ws.suspended')}</Badge>
                    ) : (
                      <Badge tone="good">{t('padmin.users.active')}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page && <Pager offset={offset} limit={LIMIT} total={page.total} onChange={setOffset} />}
    </Section>
  );
}
