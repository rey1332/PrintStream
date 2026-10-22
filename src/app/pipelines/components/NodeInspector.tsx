'use client';

import { ChartOutput } from './ChartOutput';
import { CHART_FORMATS, CHART_KINDS, CHART_SORTS } from '@/lib/workflow/chartData';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NODE_REGISTRY } from '@/lib/workflow/registry';
import type { WorkflowNode, DataTable } from '@/lib/workflow/types';
import type { NodeRunResult } from '@/lib/workflow/executor';
import type { GraphIssue, NodeSchemaInfo } from '@/lib/workflow/schema';
import { X, Search, ChevronDown, Download, Check, Copy, Trash2 } from 'lucide-react';

const headerBtn =
  'inline-flex items-center justify-center p-1 text-muted-foreground hover:text-foreground max-lg:h-11 max-lg:w-11';
import { useAuth } from '@/contexts/AuthContext';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';
import { useI18n } from '@/lib/i18n/I18nProvider';
import {
  fieldLabel,
  nodeTypeDescription,
  nodeTypeLabel,
  optionLabel,
  pickerPlaceholder,
} from '@/lib/workflow/i18n';
import { hasMessage } from '@/lib/i18n/labels';
import { ErpTargetSelect } from './ErpTargetSelect';
import type { MessageKey } from '@/lib/i18n/messages';
import { typeLabel } from '@/lib/analytics/labels';
import { isNumericType } from '@/lib/analytics/catalog';
import ErpSourcePanel from './ErpSourcePanel';
import SummaryPanel from './SummaryPanel';
import DatasetNodePanel from './DatasetNodePanel';
import DrillDialog from './DrillDialog';
import { ColumnInfoRow, columnName } from './columnInfo';
import { csvCell } from '@/lib/csv';

function RecordPicker({
  picker,
  nodeType,
  value,
  onChange,
}: {
  picker: any;
  nodeType: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const { user } = useAuth();
  const { t } = useI18n();
  const placeholder = pickerPlaceholder(nodeType, t);
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user?.id) return;
    setLoading(true);
    picker
      .loadRecords(user.id)
      .then((recs: any[]) => setRecords(recs || []))
      .catch(() => setRecords([]))
      .finally(() => setLoading(false));
  }, [user?.id, picker]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const selected = records.find((r) => String(r[picker.valueField]) === String(value));

  const filtered = useMemo(() => {
    if (!search) return records;
    const q = search.toLowerCase();
    const fields = picker.searchFields || [picker.displayField];
    return records.filter((r) =>
      fields.some((f: string) =>
        String(r[f] ?? '')
          .toLowerCase()
          .includes(q)
      )
    );
  }, [records, search, picker]);

  const displayText = selected
    ? `${selected[picker.displayField]}${picker.secondaryField && selected[picker.secondaryField] ? ` · ${selected[picker.secondaryField]}` : ''}`
    : placeholder;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center justify-between gap-2 rounded-md border border-zinc-200 dark:border-border bg-white dark:bg-input px-2.5 py-1.5 text-[0.75rem] text-zinc-900 dark:text-foreground outline-none hover:border-zinc-400 dark:hover:border-muted-foreground transition-colors"
      >
        <span className="truncate text-left">{loading ? t('wf.loadingDots') : displayText}</span>
        <ChevronDown
          size={12}
          className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-md border border-zinc-200 dark:border-border bg-white dark:bg-card shadow-lg overflow-hidden">
          <div className="p-1.5 border-b border-zinc-200 dark:border-border">
            <div className="relative">
              <Search
                size={11}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400"
              />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('wf.searchDots')}
                className="w-full pl-6 pr-2 py-1 text-[0.72rem] bg-transparent text-zinc-900 dark:text-foreground outline-none"
              />
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto">
            <button
              type="button"
              onClick={() => {
                onChange('');
                setOpen(false);
                setSearch('');
              }}
              className="w-full text-left px-3 py-1.5 text-[0.72rem] hover:bg-[var(--surface-3)] transition-colors flex items-center justify-between"
              style={{ color: 'var(--foreground)' }}
            >
              <span className="italic opacity-70">{placeholder}</span>
              {!value && <Check size={11} />}
            </button>
            {filtered.slice(0, 100).map((r) => {
              const v = String(r[picker.valueField]);
              const isSelected = v === String(value);
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    onChange(v);
                    setOpen(false);
                    setSearch('');
                  }}
                  className="w-full text-left px-3 py-1.5 text-[0.72rem] hover:bg-[var(--surface-3)] transition-colors flex items-center justify-between gap-2"
                  style={{ color: 'var(--foreground)' }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{r[picker.displayField] || v}</span>
                    {picker.secondaryField && r[picker.secondaryField] && (
                      <span className="block truncate text-[0.62rem] opacity-60">
                        {r[picker.secondaryField]}
                      </span>
                    )}
                  </span>
                  {isSelected && <Check size={11} className="flex-shrink-0" />}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p
                className="px-3 py-3 text-[0.7rem] text-center opacity-60"
                style={{ color: 'var(--foreground)' }}
              >
                {t('wf.noMatching')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TableOutput({
  data,
  maxRows = 200,
  onRowClick,
}: {
  data: DataTable;
  maxRows?: number;
  onRowClick?: (row: Record<string, any>) => void;
}) {
  const { t, fmt } = useI18n();
  const rows = data.rows.slice(0, maxRows);
  const types = data.meta?.columnTypes ?? {};
  return (
    <div className="rounded-md border border-zinc-200 dark:border-border overflow-hidden">
      <div className="overflow-auto max-h-[400px]">
        <table className="w-full text-[0.68rem]">
          <thead className="sticky top-0 bg-zinc-100 dark:bg-surface-3">
            <tr>
              <th className="text-left px-2 py-1.5 text-zinc-500 dark:text-muted-foreground font-medium whitespace-nowrap">
                #
              </th>
              {data.columns.map((c) => (
                <th
                  key={c}
                  className="text-left px-2 py-1.5 text-zinc-500 dark:text-muted-foreground font-medium whitespace-nowrap"
                  title={c}
                >
                  {columnName(c, data.meta?.lineage?.[c], t)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={i}
                className={`border-t border-zinc-200 dark:border-border ${onRowClick ? 'cursor-pointer hover:bg-[var(--surface-3)] focus-visible:bg-[var(--surface-3)]' : ''}`}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onRowClick(r);
                        }
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
                title={onRowClick ? t('sum.drill.hint') : undefined}
              >
                <td className="px-2 py-1 text-zinc-400 dark:text-muted-foreground tabular-nums">
                  {i + 1}
                </td>
                {data.columns.map((c) => {
                  const val = r[c];
                  const numeric = types[c] && isNumericType(types[c]) && typeof val === 'number';
                  const display =
                    val === null || val === undefined
                      ? '—'
                      : numeric
                        ? fmt.number(val, { maximumFractionDigits: 4 })
                        : typeof val === 'object'
                          ? JSON.stringify(val)
                          : String(val);
                  return (
                    <td
                      key={c}
                      className={`px-2 py-1 text-zinc-900 dark:text-foreground truncate max-w-[180px] ${numeric ? 'text-right tabular-nums' : ''}`}
                      title={display}
                    >
                      {display}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.rows.length > maxRows && (
        <div className="px-2 py-1 text-[0.65rem] text-center border-t border-zinc-200 dark:border-border text-zinc-500 dark:text-muted-foreground">
          {t('wf.showingRows', { shown: fmt.number(maxRows), total: fmt.number(data.rows.length) })}
        </div>
      )}
    </div>
  );
}

function BarChartOutput({ data, categoryColumn, valueColumn, aggregation = 'sum' }: any) {
  const { t, fmt } = useI18n();
  if (!categoryColumn || !valueColumn) {
    return <EmptyOutput message={t('wf.pickCategoryValue')} />;
  }
  // Server runs send the chart already aggregated (one row per category).
  const preAggregated = Boolean(data.meta?.preAggregated);
  const groups = new Map<string, number[]>();
  for (const r of preAggregated ? [] : data.rows) {
    const k = String(r[categoryColumn] ?? '—');
    if (!groups.has(k)) groups.set(k, []);
    const v = Number(r[valueColumn]);
    if (!isNaN(v)) groups.get(k)!.push(v);
  }
  const chartData: any[] = [];
  for (const [k, vals] of groups) {
    let agg = 0;
    switch (aggregation) {
      case 'sum':
        agg = vals.reduce((s, v) => s + v, 0);
        break;
      case 'avg':
        agg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
        break;
      case 'count':
        agg = vals.length;
        break;
    }
    chartData.push({ category: k, value: agg });
  }
  if (preAggregated) {
    for (const r of data.rows)
      chartData.push({
        category: String(r[categoryColumn] ?? '—'),
        value: Number(r[valueColumn]) || 0,
      });
  }
  chartData.sort((a, b) => b.value - a.value);
  const top = chartData.slice(0, 25);

  if (!top.length) return <EmptyOutput message={t('wf.noNumeric')} />;

  return (
    <div className="rounded-md border border-zinc-200 dark:border-border p-2">
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={top} margin={{ top: 8, right: 8, left: 0, bottom: 40 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="category"
            tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
            angle={-30}
            textAnchor="end"
            height={50}
            interval={0}
          />
          <YAxis tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} />
          <Tooltip
            contentStyle={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 11,
              color: 'var(--foreground)',
            }}
            formatter={(v: any) => [fmt.number(Number(v)), valueColumn]}
          />
          <Bar dataKey="value" fill="#3b82f6" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      {chartData.length > 25 && (
        <p
          className="text-[0.62rem] text-center mt-1 opacity-60"
          style={{ color: 'var(--foreground)' }}
        >
          {t('wf.topCategories', { count: fmt.number(chartData.length) })}
        </p>
      )}
    </div>
  );
}

function LineChartOutput({ data, xColumn, yColumn }: any) {
  const { t } = useI18n();
  if (!xColumn || !yColumn) {
    return <EmptyOutput message={t('wf.pickXY')} />;
  }
  const chartData = data.rows
    .map((r: any) => ({ x: r[xColumn], y: Number(r[yColumn]) }))
    .filter((p: any) => !isNaN(p.y));

  if (!chartData.length) return <EmptyOutput message={t('wf.noNumeric')} />;

  return (
    <div className="rounded-md border border-zinc-200 dark:border-border p-2">
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="x"
            tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
            angle={-30}
            textAnchor="end"
            height={50}
            interval="preserveStartEnd"
          />
          <YAxis tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} />
          <Tooltip
            contentStyle={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 11,
              color: 'var(--foreground)',
            }}
          />
          <Line
            type="monotone"
            dataKey="y"
            stroke="#3b82f6"
            strokeWidth={1.8}
            dot={chartData.length < 50}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function KPIOutput({ data }: { data: DataTable }) {
  const { t, fmt } = useI18n();
  const row = data.rows[0];
  if (!row) return <EmptyOutput message={t('wf.noData')} />;
  // An empty value (no numbers, or amounts in several currencies) stays empty, never 0.
  const value = row.value === null || row.value === undefined ? null : Number(row.value);
  const count = Number(row.count) || 0;
  return (
    <div className="rounded-md border border-zinc-200 dark:border-border p-4 text-center">
      <p
        className="text-[0.65rem] uppercase tracking-widest mb-1"
        style={{ color: 'var(--muted-foreground)' }}
      >
        {row.label || t('wf.node.out.kpi')}
      </p>
      <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--foreground)' }}>
        {value === null || Number.isNaN(value)
          ? '—'
          : fmt.number(value, { maximumFractionDigits: 2 })}
      </p>
      <p className="text-[0.65rem] mt-1" style={{ color: 'var(--muted-foreground)' }}>
        {t('wf.fromRecords', { count: fmt.number(count) })}
      </p>
      {data.meta?.partial && (
        <p className="mt-2 inline-block rounded border border-amber-400/50 px-1.5 py-0.5 text-[0.6rem] font-semibold text-amber-700 dark:text-amber-400">
          {t('sum.partial')}
        </p>
      )}
    </div>
  );
}

function CSVOutput({ data, filename }: { data: DataTable; filename: string }) {
  const { t, fmt } = useI18n();
  const handleDownload = () => {
    const csv = [
      data.columns.map(csvCell).join(','),
      ...data.rows.map((r) => data.columns.map((c) => csvCell(r[c])).join(',')),
    ].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'export.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-md border border-zinc-200 dark:border-border p-3 space-y-2">
      <p className="text-[0.72rem]" style={{ color: 'var(--foreground)' }}>
        {t('wf.rowsColumns', {
          rows: fmt.number(data.rows.length),
          cols: fmt.number(data.columns.length),
        })}
      </p>
      <button
        onClick={handleDownload}
        className="w-full flex items-center justify-center gap-2 py-2 rounded-md text-[0.75rem] font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
      >
        <Download size={13} /> {t('wf.download', { file: filename })}
      </button>
    </div>
  );
}

function DataNotices({ data }: { data: DataTable }) {
  const { t, fmt } = useI18n();
  const meta = data.meta;
  if (!meta) return null;
  const warnings = meta.warnings ?? [];
  const types = meta.columnTypes ?? {};
  return (
    <div className="space-y-1.5">
      {meta.fetchedAt && (
        <p className="text-[0.62rem] text-muted-foreground">
          {t('cat.notice.fetchedAt', { time: fmt.dateTime(meta.fetchedAt) })}
        </p>
      )}
      {meta.displayTruncated && (
        <p className="text-[0.62rem] text-muted-foreground">
          {t('wf.displayTruncated', {
            shown: fmt.number(data.rows.length),
            total: fmt.number(meta.count ?? data.rows.length),
          })}
        </p>
      )}
      {warnings.length > 0 && (
        <ul
          className="space-y-1 rounded-md border border-amber-300/50 bg-amber-50/50 dark:bg-amber-950/20 p-2"
          aria-label={t('wf.out.notices')}
        >
          {warnings.map((w, i) =>
            hasMessage(w.key) ? (
              <li key={i} className="text-[0.66rem] text-amber-700 dark:text-amber-400">
                {t(
                  w.key,
                  Object.fromEntries(
                    Object.entries(w.vars ?? {}).map(([k, v]) => [
                      k,
                      typeof v === 'number' ? fmt.number(v) : v,
                    ])
                  )
                )}
              </li>
            ) : null
          )}
        </ul>
      )}
      {Object.keys(types).length > 0 && (
        <details className="text-[0.62rem] text-muted-foreground">
          <summary className="cursor-pointer">
            {t('wf.out.types')} ({fmt.number(data.columns.length)})
          </summary>
          <ul className="mt-1 space-y-0.5">
            {data.columns.map((c) => (
              <li key={c} className="flex justify-between gap-2">
                <span className="truncate text-foreground" title={c}>
                  {columnName(c, meta.lineage?.[c], t)}
                </span>
                <span className="flex-shrink-0">{types[c] ? typeLabel(types[c], t) : '—'}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function EmptyOutput({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-dashed border-zinc-200 dark:border-border py-6 text-center">
      <p className="text-[0.72rem]" style={{ color: 'var(--muted-foreground)' }}>
        {message}
      </p>
    </div>
  );
}

function OutputRenderer({ node, result }: { node: WorkflowNode; result: any }) {
  const { t } = useI18n();
  if (!result?.ok) {
    return (
      <div className="rounded-md border border-red-300/40 bg-red-50/40 dark:bg-red-950/20 p-3">
        <p className="text-[0.72rem] text-red-600 dark:text-red-400">
          {errorText(result?.error, t)}
        </p>
      </div>
    );
  }
  const data = result.output as DataTable;
  if (!data || !data.columns) {
    return <EmptyOutput message={t('wf.noOutput')} />;
  }
  const cfg = node.data.config as any;

  switch (node.data.type) {
    case 'out.table':
      return <TableOutput data={data} maxRows={Number(cfg.maxRows) || 200} />;
    case 'out.barChart':
      return (
        <BarChartOutput
          data={data}
          categoryColumn={cfg.categoryColumn}
          valueColumn={cfg.valueColumn}
          aggregation={cfg.aggregation}
        />
      );
    case 'out.lineChart':
      return <LineChartOutput data={data} xColumn={cfg.xColumn} yColumn={cfg.yColumn} />;
    case 'out.kpi':
      return <KPIOutput data={data} />;
    case 'out.chart':
      return <ChartOutput data={data} />;
    case 'out.csv':
      return <CSVOutput data={data} filename={cfg.filename || 'export.csv'} />;
    default:
      return <TableOutput data={data} maxRows={50} />;
  }
}

type T = ReturnType<typeof useI18n>['t'];

export function errorText(error: unknown, t: T): string {
  if (!error) return t('wf.unknownError');
  if (typeof error === 'string') return error;
  const e = error as { key?: string; vars?: Record<string, string | number>; message?: string };
  if (e.key && hasMessage(e.key)) return t(e.key, e.vars);
  return e.message || t('wf.unknownError');
}

export function issueText(issue: GraphIssue, t: T): string {
  return hasMessage(issue.key) ? t(issue.key, issue.vars) : issue.key;
}

function DataQualityPanel({ data }: { data: DataTable }) {
  const { t, fmt } = useI18n();
  const q = data.meta?.quality;
  if (!q) return null;
  const rows: [MessageKey, number][] = [
    ['wf.dq.checked', q.checkedRows],
    ['wf.dq.invalidRows', q.invalidRows],
    ['wf.dq.missingRequired', q.missingRequired],
    ['wf.dq.invalidType', q.invalidType],
    ['wf.dq.duplicateKeys', q.duplicateKeys],
    ['wf.dq.failedRelationships', q.failedRelationships],
  ];
  const issues = data.meta?.issues ?? [];
  return (
    <div className="rounded-md border border-border p-2 space-y-2">
      <p className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
        {t('wf.dq.title')}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[0.68rem]">
        {rows.map(([key, value]) => (
          <React.Fragment key={key}>
            <dt className="text-muted-foreground">{t(key)}</dt>
            <dd
              className={`text-right tabular-nums ${value > 0 && key !== 'wf.dq.checked' ? 'text-amber-700 dark:text-amber-400 font-semibold' : 'text-foreground'}`}
            >
              {fmt.number(value)}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      {issues.length > 0 && (
        <details className="text-[0.66rem]">
          <summary className="cursor-pointer text-muted-foreground">
            {t('wf.dq.affected', { count: fmt.number(issues.length) })}
          </summary>
          <ul className="mt-1 max-h-40 overflow-y-auto space-y-0.5">
            {issues.map((issue, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span className="text-foreground">
                  {t('wf.dq.row', { row: fmt.number(issue.row + 1) })} ·{' '}
                  {columnName(issue.column, data.meta?.lineage?.[issue.column], t)}
                </span>
                <span className="text-amber-700 dark:text-amber-400">
                  {t(`wf.dq.problem.${issue.problem}`)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function TablePreview({
  data,
  onRowClick,
}: {
  data: DataTable;
  onRowClick?: (row: Record<string, any>) => void;
}) {
  const { t, fmt } = useI18n();
  const total = data.meta?.count ?? data.rows.length;
  const summary = data.meta?.summary;
  return (
    <>
      <p className="text-[0.68rem] text-muted-foreground">
        {t('wf.rowsCols', { rows: fmt.number(total), cols: fmt.number(data.columns.length) })}
        {summary ? <> · {t('sum.coverage', { count: fmt.number(summary.recordCount) })}</> : null}
      </p>
      <DataNotices data={data} />
      <DataQualityPanel data={data} />
      {onRowClick && <p className="text-[0.62rem] text-muted-foreground">{t('sum.drill.hint')}</p>}
      <TableOutput data={data} maxRows={summary ? 200 : 10} onRowClick={onRowClick} />
    </>
  );
}

const COLUMN_PICKERS: Record<string, number> = {
  column: 0,
  groupBy: 0,
  aggregateColumn: 0,
  colA: 0,
  colB: 0,
  categoryColumn: 0,
  valueColumn: 0,
  seriesColumn: 0,
  xColumn: 0,
  yColumn: 0,
  uniqueKey: 0,
  leftKey: 0,
  rightKey: 1,
  key: 0,
  lookupKey: 1,
  matchColumn: 0,
  candidateColumn: 1,
  rowKey: 0,
  pivotColumn: 0,
  partitionBy: 0,
  orderBy: 0,
  startColumn: 0,
  endColumn: 0,
  rangeColumn: 0,
  allowedColumn: 0,
};
const COLUMN_LISTS = new Set([
  'columns',
  'requiredColumns',
  'numericColumns',
  'dateColumns',
  'keyColumns',
  'idColumns',
  'valueColumns',
  'measures',
  'bring',
]);
/** Lists of columns of the second input (the others list the first's). */
const LIST_INPUT: Record<string, number> = { bring: 1 };

interface InspectorProps {
  node: WorkflowNode | null;
  runResult?: NodeRunResult;
  schema?: NodeSchemaInfo;
  readOnly?: boolean;
  onChange: (nodeId: string, config: Record<string, any>) => void;
  onClose: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  workflowId: string;
  runTarget: { target: 'draft' | 'published' | 'version'; versionId?: string };
}

interface DrillRequest {
  group: Record<string, unknown>;
  title: string;
  expected: number | null;
}

export default function NodeInspector({
  node,
  runResult,
  schema,
  readOnly = false,
  onChange,
  onClose,
  onDuplicate,
  onDelete,
  workflowId,
  runTarget,
}: InspectorProps) {
  const { t, fmt } = useI18n();
  const [drill, setDrill] = useState<DrillRequest | null>(null);
  useEffect(() => setDrill(null), [node?.id]);
  if (!node) {
    return (
      <div
        className="w-full lg:w-80 lg:border-l bg-card h-full flex items-center justify-center p-4"
        style={{ borderColor: 'var(--border)' }}
      >
        <p className="text-[0.75rem] text-muted-foreground text-center">{t('wf.selectNode')}</p>
      </div>
    );
  }

  const def = NODE_REGISTRY[node.data.type];
  if (!def) return null;

  const config = node.data.config as Record<string, any>;
  const update = (key: string, value: any) => {
    onChange(node.id, { ...config, [key]: value });
  };
  const issues = schema?.issues ?? [];
  const inputs = schema?.inputs ?? [];

  const inputCls =
    'w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-[0.75rem] text-foreground outline-none focus:border-foreground/40 disabled:opacity-60';

  const enumFields: Record<string, string[]> = {
    operator: ['=', '!=', '>', '>=', '<', '<=', 'contains'],
    direction: ['asc', 'desc'],
    operation: ['sum', 'avg', 'count', 'min', 'max'],
    joinType: ['inner', 'left', 'right', 'outer'],
    aggregation: ['sum', 'avg', 'count'],
    action: ['report', 'exclude'],
    keep: ['first', 'last'],
    fillMethod: ['value', 'previous', 'zero', 'mean'],
    toType: ['text', 'number', 'integer', 'date', 'boolean'],
    textCase: ['none', 'upper', 'lower', 'title'],
    unmatched: ['keep', 'blank'],
    windowOp: [
      'running_sum',
      'running_count',
      'row_number',
      'rank',
      'previous',
      'difference',
      'percent_of_total',
    ],
    datePart: ['year', 'quarter', 'month', 'week', 'day', 'weekday', 'year_month'],
    diffUnit: ['days', 'weeks', 'months', 'years'],
    outlierMethod: ['iqr', 'zscore'],
    list: ['customers', 'suppliers', 'products'],
    erpMode: ['add_new', 'add_or_update'],
    chartKind: [...CHART_KINDS],
    chartSort: [...CHART_SORTS],
    numberFormat: [...CHART_FORMATS],
    ...(node.data.type === 'out.chart'
      ? { aggregation: ['sum', 'avg', 'count', 'min', 'max'] }
      : {}),
  };

  const isOutput = def.category === 'output';
  const output = runResult?.output as any;
  const branchOutput =
    output && !Array.isArray(output.rows) && def.outputHandles.length > 0
      ? (output as Record<string, DataTable>)
      : null;

  // Summary rows open the records they counted.
  const openDrill =
    def.type === 'src.erpSummary' && output?.meta?.summary
      ? (row: Record<string, any>) => {
          const table = output as DataTable;
          const groupColumns = table.columns.filter(
            (c) => c !== 'record_count' && !table.meta?.lineage?.[c]?.op
          );
          const group = Object.fromEntries(groupColumns.map((c) => [c, row[c] ?? null]));
          const title = groupColumns.length
            ? groupColumns
                .map((c) => `${columnName(c, table.meta?.lineage?.[c], t)}: ${row[c] ?? '—'}`)
                .join(' · ')
            : t('sum.drill.allRecords');
          setDrill({
            group,
            title,
            expected: typeof row.record_count === 'number' ? row.record_count : null,
          });
        }
      : undefined;

  return (
    <div
      className="w-full lg:w-80 lg:border-l bg-card h-full flex flex-col"
      style={{ borderColor: 'var(--border)' }}
    >
      <div
        className="px-4 py-3 border-b flex items-center justify-between"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
            style={{ background: def.color + '22' }}
          >
            <def.icon size={12} style={{ color: def.color }} />
          </div>
          <div className="min-w-0">
            <p className="text-[0.78rem] font-semibold text-foreground truncate">
              {nodeTypeLabel(def.type, t)}
            </p>
            <p className="text-[0.62rem] text-muted-foreground truncate">
              {nodeTypeDescription(def.type, t)}
            </p>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center">
          {onDuplicate && (
            <button
              onClick={onDuplicate}
              className={headerBtn}
              aria-label={t('wf.duplicate')}
              title={t('wf.duplicate')}
            >
              <Copy size={12} />
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className={`${headerBtn} hover:!text-red-500`}
              aria-label={t('wf.delete')}
              title={t('wf.delete')}
            >
              <Trash2 size={12} />
            </button>
          )}
          <button onClick={onClose} className={headerBtn} aria-label={t('wf.close')}>
            <X size={13} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {issues.length > 0 && (
          <ul
            className="m-4 mb-0 space-y-1 rounded-md border border-red-300/40 bg-red-50/40 dark:bg-red-950/20 p-2"
            role="alert"
          >
            {issues.map((issue, i) => (
              <li
                key={i}
                className={`text-[0.68rem] ${issue.severity === 'error' ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`}
              >
                {issueText(issue, t)}
              </li>
            ))}
          </ul>
        )}

        {inputs.some((s) => s && s.length) && (
          <details className="mx-4 mt-3 text-[0.66rem] text-muted-foreground">
            <summary className="cursor-pointer">{t('wf.inputFields')}</summary>
            {inputs.map((s, i) => (
              <ul key={i} className="mt-1 divide-y divide-border">
                {(s ?? []).map((c) => (
                  <ColumnInfoRow
                    key={c.name}
                    name={c.name}
                    type={c.type}
                    lineage={c.lineage}
                    repeated={c.repeated}
                  />
                ))}
              </ul>
            ))}
          </details>
        )}

        <fieldset disabled={readOnly} className="contents">
          {'erpId' in def.defaultConfig && (
            <div className="p-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <ErpTargetSelect
                value={String(config.erpId ?? '')}
                onChange={(erpId) => update('erpId', erpId)}
                disabled={readOnly}
                className={inputCls}
              />
            </div>
          )}
          {def.picker && (
            <div className="p-4 border-b space-y-2" style={{ borderColor: 'var(--border)' }}>
              <label className="block text-[0.7rem] text-muted-foreground">{t('wf.record')}</label>
              <RecordPicker
                picker={def.picker}
                nodeType={def.type}
                value={config.selectedId || ''}
                onChange={(id) => update('selectedId', id)}
              />
              <p className="text-[0.62rem] text-muted-foreground">{t('wf.leaveEmpty')}</p>
            </div>
          )}

          {def.type === 'src.erp' && (
            <ErpSourcePanel
              config={config as any}
              onChange={(next) => onChange(node.id, next as any)}
            />
          )}

          {def.type === 'src.erpSummary' && (
            <SummaryPanel config={config} onChange={(next) => onChange(node.id, next)} />
          )}

          {(def.type === 'src.psDataset' || def.type === 'out.psDataset') && (
            <DatasetNodePanel
              type={def.type}
              config={config}
              onChange={(next) => onChange(node.id, next)}
            />
          )}

          {def.type !== 'src.erp' &&
            def.type !== 'src.erpSummary' &&
            def.type !== 'src.psDataset' &&
            def.type !== 'out.psDataset' &&
            Object.keys(def.defaultConfig).some((k) => k !== 'erpId' && k !== 'selectedId') && (
              <div className="p-4 border-b space-y-4" style={{ borderColor: 'var(--border)' }}>
                <p className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
                  {t('wf.configuration')}
                </p>
                {Object.entries(def.defaultConfig).map(([key, defVal]) => {
                  if (def.picker && key === 'selectedId') return null;
                  if (key === 'erpId') return null;
                  const inputId = `cfg-${node.id}-${key}`;
                  const pickFrom = key in COLUMN_PICKERS ? inputs[COLUMN_PICKERS[key]] : undefined;
                  const available =
                    key in COLUMN_PICKERS || COLUMN_LISTS.has(key)
                      ? inputs[COLUMN_PICKERS[key] ?? LIST_INPUT[key] ?? 0]
                      : undefined;
                  return (
                    <div key={key}>
                      <label
                        htmlFor={inputId}
                        className="block text-[0.7rem] text-muted-foreground mb-1"
                      >
                        {fieldLabel(key, t)}
                      </label>
                      {typeof defVal === 'number' ? (
                        <input
                          id={inputId}
                          type="number"
                          className={inputCls}
                          value={config[key] ?? defVal}
                          onChange={(e) => update(key, Number(e.target.value))}
                        />
                      ) : typeof defVal === 'boolean' ? (
                        <input
                          id={inputId}
                          type="checkbox"
                          checked={config[key] ?? defVal}
                          onChange={(e) => update(key, e.target.checked)}
                        />
                      ) : enumFields[key] ? (
                        <select
                          id={inputId}
                          className={inputCls}
                          value={config[key] ?? defVal}
                          onChange={(e) => update(key, e.target.value)}
                          style={{ colorScheme: 'light dark' }}
                        >
                          {enumFields[key].map((opt) => (
                            <option key={opt} value={opt}>
                              {optionLabel(opt, t)}
                            </option>
                          ))}
                        </select>
                      ) : pickFrom ? (
                        <select
                          id={inputId}
                          className={inputCls}
                          value={config[key] ?? ''}
                          onChange={(e) => update(key, e.target.value)}
                          style={{ colorScheme: 'light dark' }}
                        >
                          <option value="">{t('wf.pickColumn')}</option>
                          {config[key] && !pickFrom.some((c) => c.name === config[key]) && (
                            <option value={config[key]}>{config[key]}</option>
                          )}
                          {pickFrom.map((c) => (
                            <option key={c.name} value={c.name}>
                              {columnName(c.name, c.lineage, t)}
                              {columnName(c.name, c.lineage, t) !== c.name ? ` (${c.name})` : ''}
                              {c.type ? ` · ${typeLabel(c.type, t)}` : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={inputId}
                          className={inputCls}
                          value={config[key] ?? defVal}
                          onChange={(e) => update(key, e.target.value)}
                          placeholder={
                            key.toLowerCase().includes('column')
                              ? t('wf.columnPlaceholder')
                              : undefined
                          }
                        />
                      )}
                      {COLUMN_LISTS.has(key) && available && available.length > 0 && (
                        <p className="mt-1 text-[0.6rem] text-muted-foreground break-words">
                          {available.map((c) => c.name).join(', ')}
                        </p>
                      )}
                      {def.type === 'tf.calc' && key === 'formula' && (
                        <p className="mt-1 text-[0.6rem] text-muted-foreground">
                          {t('wf.calc.hint')}
                        </p>
                      )}
                      {hasMessage(`wf.hint.${def.type}.${key}`) && (
                        <p className="mt-1 text-[0.6rem] text-muted-foreground">
                          {t(`wf.hint.${def.type}.${key}` as MessageKey)}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
        </fieldset>

        {runResult && (
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
                {isOutput ? t('wf.result') : t('wf.outputPreview')}
              </p>
              {runResult.ok && (
                <span className="text-[0.62rem] text-muted-foreground tabular-nums">
                  {fmt.number(runResult.durationMs)} ms
                </span>
              )}
            </div>

            {!runResult.ok ? (
              <div className="rounded-md border border-red-300/40 bg-red-50/40 dark:bg-red-950/20 p-3">
                <p className="text-[0.72rem] text-red-600 dark:text-red-400">
                  {errorText(runResult.error, t)}
                </p>
              </div>
            ) : isOutput ? (
              <>
                {output?.meta && <DataNotices data={output} />}
                <OutputRenderer node={node} result={runResult} />
              </>
            ) : branchOutput ? (
              def.outputHandles.map((handle) => (
                <div key={handle} className="space-y-1.5">
                  <p className="text-[0.66rem] font-semibold text-foreground">
                    {hasMessage(`wf.handle.${handle}`)
                      ? t(`wf.handle.${handle}` as MessageKey)
                      : handle}
                  </p>
                  {branchOutput[handle] && <TablePreview data={branchOutput[handle]} />}
                </div>
              ))
            ) : output?.rows ? (
              <TablePreview data={output} onRowClick={openDrill} />
            ) : (
              <EmptyOutput message={t('wf.noOutput')} />
            )}
          </div>
        )}

        {!runResult && (
          <div className="p-6 text-center">
            <p className="text-[0.72rem] text-muted-foreground">
              {t('wf.clickRunBefore')} <strong>{t('wf.run')}</strong> {t('wf.clickRunAfter')}
            </p>
          </div>
        )}
      </div>
      {drill && (
        <DrillDialog
          workflowId={workflowId}
          nodeId={node.id}
          target={runTarget}
          group={drill.group}
          title={drill.title}
          expected={drill.expected}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
