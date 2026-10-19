'use client';

// The workbench's object browser (pgAdmin's Object Explorer): this
// Terminal's datasets and their columns, its PostgreSQL connections and their
// tables (asked of the worker when opened), its pipelines, and the
// Terminal's other screens. Double-click a table to see its first rows.

import React, { useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Columns3,
  Database,
  FileUp,
  GitBranch,
  LayoutDashboard,
  Loader2,
  Plug,
  Sparkles,
  Table as TableIcon,
  TerminalSquare,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { TerminalApiError } from '@/lib/terminal/client';
import type { SqlTargets } from '@/lib/terminal/sql';
import { askWorker } from '../components/connectorAsk';
import { errorMessage } from '../components/shared';

export type ScreenTab =
  | 'home'
  | 'query'
  | 'datasets'
  | 'imports'
  | 'pipelines'
  | 'connections'
  | 'insights'
  | 'ai'
  | 'jobs';

const quoteName = (name: string) =>
  /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;

const row =
  'group flex w-full items-center gap-1 rounded-[2px] py-[3px] pr-1 text-left text-[12px] text-[var(--wb-text)] hover:bg-[var(--wb-hover)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--wb-accent)]';

function Branch({
  depth,
  icon: Icon,
  label,
  count,
  open,
  onToggle,
  onOpen,
  title,
  active,
}: {
  depth: number;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  count?: number;
  open?: boolean;
  onToggle?: () => void;
  onOpen?: () => void;
  title?: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${row} ${active ? 'bg-[var(--wb-active)]' : ''}`}
      style={{ paddingLeft: 4 + depth * 14 }}
      aria-expanded={onToggle ? !!open : undefined}
      onClick={onToggle ?? onOpen}
      onDoubleClick={onToggle ? onOpen : undefined}
      title={title}
    >
      <span className="w-3 shrink-0 text-[var(--wb-muted)]">
        {onToggle && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </span>
      <Icon size={13} className="shrink-0 text-[var(--wb-text-2)]" />
      <span className="min-w-0 truncate">{label}</span>
      {count !== undefined && (
        <span className="ml-auto shrink-0 pl-1 text-[11px] text-[var(--wb-muted)]">{count}</span>
      )}
    </button>
  );
}

export function ObjectExplorer({
  spaceName,
  targets,
  pipelines,
  tab,
  onTab,
  onQuery,
  onInsert,
}: {
  spaceName: string;
  targets: SqlTargets | null;
  pipelines: { id: string; name: string }[];
  tab: ScreenTab;
  onTab: (tab: ScreenTab) => void;
  /** Opens the query in the Query Tool on a target and runs it. */
  onQuery: (target: string, sql: string) => void;
  onInsert: (text: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<Record<string, boolean>>({ root: true, datasets: true });
  const [tables, setTables] = useState<
    Record<string, { schema: string; name: string; view: boolean }[] | 'loading' | string>
  >({});
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  const loadTables = async (id: string) => {
    if (tables[id] && tables[id] !== 'loading' && typeof tables[id] !== 'string') return;
    setTables((x) => ({ ...x, [id]: 'loading' }));
    try {
      const r = await askWorker<{ tables: { schema: string; name: string; view: boolean }[] }>(
        id,
        null
      );
      setTables((x) => ({ ...x, [id]: r.tables }));
    } catch (e) {
      setTables((x) => ({
        ...x,
        [id]: errorMessage(e instanceof TerminalApiError ? e : new TerminalApiError('failed'), t),
      }));
    }
  };

  const screens: { id: ScreenTab; icon: any; label: string }[] = [
    { id: 'home', icon: LayoutDashboard, label: t('ps.tab.home') },
    { id: 'imports', icon: FileUp, label: t('ps.tab.imports') },
    { id: 'insights', icon: Sparkles, label: t('ps.tab.insights') },
    { id: 'ai', icon: BrainCircuit, label: t('ps.tab.ai') },
    { id: 'jobs', icon: Activity, label: t('ps.tab.jobs') },
  ];

  return (
    <nav
      aria-label={t('ps.wb.explorer')}
      className="h-full overflow-auto bg-[var(--wb-panel)] py-1 text-[var(--wb-text)]"
    >
      <Branch
        depth={0}
        icon={TerminalSquare}
        label={spaceName}
        open={open.root}
        onToggle={() => toggle('root')}
      />
      {open.root && (
        <>
          <Branch
            depth={1}
            icon={TerminalSquare}
            label={t('ps.wb.queryTool')}
            onOpen={() => onTab('query')}
            active={tab === 'query'}
          />
          {/* Datasets */}
          <Branch
            depth={1}
            icon={Database}
            label={t('ps.tab.datasets')}
            count={targets?.datasets.length}
            open={open.datasets}
            onToggle={() => toggle('datasets')}
            onOpen={() => onTab('datasets')}
          />
          {open.datasets &&
            (targets?.datasets ?? []).map((d) => (
              <React.Fragment key={d.id}>
                <div className="flex items-center">
                  <Branch
                    depth={2}
                    icon={TableIcon}
                    label={d.name}
                    open={open[`ds:${d.id}`]}
                    onToggle={() => toggle(`ds:${d.id}`)}
                    onOpen={() =>
                      onQuery('datasets', `select *\nfrom ${quoteName(d.name)}\nlimit 100;`)
                    }
                    title={t('ps.wb.datasetHint', { rows: d.rows })}
                  />
                </div>
                {open[`ds:${d.id}`] && (
                  <>
                    <div
                      style={{ paddingLeft: 4 + 3 * 14 }}
                      className="flex gap-2 py-0.5 text-[11px]"
                    >
                      <button
                        type="button"
                        className="text-[var(--wb-accent)] hover:underline"
                        onClick={() =>
                          onQuery('datasets', `select *\nfrom ${quoteName(d.name)}\nlimit 100;`)
                        }
                      >
                        {t('ps.wb.viewData')}
                      </button>
                      <button
                        type="button"
                        className="text-[var(--wb-accent)] hover:underline"
                        onClick={() => onInsert(quoteName(d.name))}
                      >
                        {t('ps.wb.insertName')}
                      </button>
                      <Link
                        href={`/terminal/datasets/${d.id}`}
                        className="text-[var(--wb-accent)] hover:underline"
                      >
                        {t('ps.wb.openScreen')}
                      </Link>
                    </div>
                    {d.columns.map((c) => (
                      <Branch
                        key={c.name}
                        depth={3}
                        icon={Columns3}
                        label={`${c.name}`}
                        count={undefined}
                        onOpen={() => onInsert(quoteName(c.name))}
                        title={`${c.name} · ${c.type}${c.sensitive ? ` · ${t('ps.wb.sensitive')}` : ''}`}
                      />
                    ))}
                  </>
                )}
              </React.Fragment>
            ))}
          {open.datasets && targets && targets.datasets.length === 0 && (
            <p
              style={{ paddingLeft: 4 + 2 * 14 + 16 }}
              className="py-0.5 text-[11px] text-[var(--wb-muted)]"
            >
              {t('ps.wb.noDatasets')}
            </p>
          )}

          {/* PostgreSQL connections */}
          <Branch
            depth={1}
            icon={Plug}
            label={t('ps.tab.connections')}
            count={targets?.connections.length}
            open={open.connections}
            onToggle={() => toggle('connections')}
            onOpen={() => onTab('connections')}
          />
          {open.connections &&
            (targets?.connections ?? []).map((c) => {
              const list = tables[c.id];
              return (
                <React.Fragment key={c.id}>
                  <Branch
                    depth={2}
                    icon={Database}
                    label={c.name}
                    open={open[`cn:${c.id}`]}
                    onToggle={() => {
                      toggle(`cn:${c.id}`);
                      if (!open[`cn:${c.id}`]) void loadTables(c.id);
                    }}
                    title={[c.database, c.host].filter(Boolean).join(' @ ')}
                  />
                  {open[`cn:${c.id}`] &&
                    (list === 'loading' || list === undefined ? (
                      <p
                        style={{ paddingLeft: 4 + 3 * 14 + 16 }}
                        className="flex items-center gap-1 py-0.5 text-[11px] text-[var(--wb-muted)]"
                      >
                        <Loader2 size={11} className="animate-spin" /> {t('ps.wb.askingWorker')}
                      </p>
                    ) : typeof list === 'string' ? (
                      <p
                        style={{ paddingLeft: 4 + 3 * 14 + 16 }}
                        className="py-0.5 text-[11px] text-[var(--wb-error)]"
                      >
                        {list}
                      </p>
                    ) : (
                      list.map((tb) => (
                        <Branch
                          key={`${tb.schema}.${tb.name}`}
                          depth={3}
                          icon={TableIcon}
                          label={`${tb.schema}.${tb.name}`}
                          onOpen={() =>
                            onQuery(
                              c.id,
                              `select *\nfrom ${quoteName(tb.schema)}.${quoteName(tb.name)}\nlimit 100;`
                            )
                          }
                          title={tb.view ? t('ps.wb.view') : t('ps.wb.table')}
                        />
                      ))
                    ))}
                </React.Fragment>
              );
            })}

          {/* Pipelines */}
          <Branch
            depth={1}
            icon={GitBranch}
            label={t('ps.tab.pipelines')}
            count={pipelines.length}
            open={open.pipelines}
            onToggle={() => toggle('pipelines')}
            onOpen={() => onTab('pipelines')}
          />
          {open.pipelines &&
            pipelines.map((p) => (
              <Link
                key={p.id}
                href={`/pipelines/${p.id}`}
                className={row}
                style={{ paddingLeft: 4 + 2 * 14 + 16 }}
              >
                <GitBranch size={13} className="shrink-0 text-[var(--wb-text-2)]" />
                <span className="min-w-0 truncate">{p.name}</span>
              </Link>
            ))}

          {screens.map((s) => (
            <Branch
              key={s.id}
              depth={1}
              icon={s.icon}
              label={s.label}
              onOpen={() => onTab(s.id)}
              active={tab === s.id}
            />
          ))}
        </>
      )}
    </nav>
  );
}
