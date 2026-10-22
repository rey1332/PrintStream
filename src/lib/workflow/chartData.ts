// The "Chart" output node (out.chart): one node, many chart kinds. The data
// is shaped here, on the server, so only the chart's points leave it: groups
// are aggregated with the same rules as the other nodes (currency checks,
// repeated values), series are capped at the eight colours of the categorical
// palette (the rest fold into "Other"), long inputs are sampled or binned.
// Rendering: src/app/pipelines/components/ChartOutput.tsx.

import type { DataTable, DataWarning } from './types';
import { WorkflowError } from './errors';

export const CHART_KINDS = [
  'bar',
  'stackedBar',
  'line',
  'area',
  'stackedArea',
  'combo',
  'pie',
  'donut',
  'scatter',
  'histogram',
  'heatmap',
  'pivot',
] as const;
export type ChartKind = (typeof CHART_KINDS)[number];
export const CHART_FORMATS = ['plain', 'compact', 'currency', 'percent'] as const;
export type ChartFormat = (typeof CHART_FORMATS)[number];
export const CHART_SORTS = ['byValue', 'byLabel'] as const;

/** The series name that stands for everything folded together. */
export const OTHER = '__other__';
/** The pivot's row and column of totals. */
export const TOTAL = '__total__';

/** One colour per series, never more (references the categorical palette). */
export const MAX_SERIES = 8;
const MAX_CATEGORIES = 50;
const MAX_POINTS = 1000;
const MAX_SCATTER = 2000;
const MAX_HEAT = 40;
const MAX_PIVOT_COLUMNS = 30;

export interface ChartMeta {
  kind: ChartKind;
  /** The x (category, time or number) column. */
  x: string;
  /** Value columns of the rows, in order (bars before lines for combo). */
  series: string[];
  format: ChartFormat;
  title?: string;
  /** The y column of a heatmap, the series column of a scatter. */
  y?: string;
  /** Categories left out (bar kinds) or points not drawn (scatter). */
  omitted?: number;
}

type Measure = (
  groups: Record<string, any>[][],
  column: string,
  operation: string
) => { values: (number | null)[]; warnings: DataWarning[]; partial: boolean };

const listOf = (value: unknown): string[] =>
  String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function need(table: DataTable, column: string, field: string) {
  if (!column) throw new WorkflowError('wf.err.missingConfig', { field });
  if (!table.columns.includes(column)) throw new WorkflowError('wf.err.unknownColumn', { column });
  return column;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Numbers by value, everything else by text (ISO dates sort as dates). */
export function naturalCompare(a: string, b: string): number {
  const x = Number(a);
  const y = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return a.localeCompare(b, undefined, { numeric: true });
}

function groupBy(rows: Record<string, any>[], column: string) {
  const groups = new Map<string, Record<string, any>[]>();
  for (const r of rows) {
    const k = r[column] === null || r[column] === undefined ? '' : String(r[column]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return groups;
}

/** The keys with the largest totals first; past `keep`, the rest are one "Other". */
function topKeys(totals: Map<string, number>, keep: number) {
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  if (ranked.length <= keep) return { kept: ranked, folded: [] as string[] };
  return { kept: ranked.slice(0, keep - 1), folded: ranked.slice(keep - 1) };
}

/** Spreads n rows evenly down to at most `max` (deterministic, keeps the ends). */
function sample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const step = (rows.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => rows[Math.round(i * step)]);
}

export function shapeChart(
  cfg: Record<string, any>,
  table: DataTable,
  measure: Measure
): DataTable {
  const kind: ChartKind = CHART_KINDS.includes(cfg.chartKind) ? cfg.chartKind : 'bar';
  const format: ChartFormat = CHART_FORMATS.includes(cfg.numberFormat) ? cfg.numberFormat : 'plain';
  const op = ['sum', 'avg', 'count', 'min', 'max'].includes(cfg.aggregation)
    ? String(cfg.aggregation)
    : 'sum';
  const title = String(cfg.title ?? '').trim() || undefined;
  const x = String(cfg.xColumn ?? '').trim();
  const seriesColumn = String(cfg.seriesColumn ?? '').trim();
  const values = listOf(cfg.measures);
  for (const v of values) need(table, v, 'measures');
  if (seriesColumn) need(table, seriesColumn, 'seriesColumn');
  const warnings: DataWarning[] = [...(table.meta?.warnings ?? [])];
  let partial = false;
  const result = (
    columns: string[],
    rows: Record<string, any>[],
    chart: Omit<ChartMeta, 'kind' | 'format' | 'title'>
  ): DataTable => ({
    columns,
    rows,
    meta: {
      count: rows.length,
      fetchedAt: table.meta?.fetchedAt,
      warnings,
      preAggregated: true,
      sourceRows: table.rows.length,
      chart: { kind, format, title, ...chart },
      ...(partial || table.meta?.partial || table.meta?.truncated ? { partial: true } : {}),
    },
  });
  const measured = (groups: Record<string, any>[][], column: string, operation = op) => {
    const m = measure(groups, column, operation);
    warnings.push(...m.warnings.filter((w) => !warnings.some((x) => x.key === w.key)));
    partial ||= m.partial;
    return m.values;
  };

  // ─── A distribution of one number ─────────────────────────────────────────
  if (kind === 'histogram') {
    const column = need(table, values[0] ?? '', 'measures');
    const nums = table.rows.map((r) => num(r[column])).filter((v): v is number => v !== null);
    const bins = Math.min(100, Math.max(2, Math.floor(Number(cfg.bins) || 20)));
    if (!nums.length)
      return result(['bin', 'from', 'to', 'count'], [], { x: 'bin', series: ['count'] });
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of nums) {
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    }
    const width = hi === lo ? 1 : (hi - lo) / bins;
    const counts = new Array(hi === lo ? 1 : bins).fill(0);
    for (const n of nums) counts[Math.min(counts.length - 1, Math.floor((n - lo) / width))]++;
    const rows = counts.map((count, i) => ({
      bin: `${+(lo + i * width).toPrecision(6)} – ${+(lo + (i + 1) * width).toPrecision(6)}`,
      from: lo + i * width,
      to: lo + (i + 1) * width,
      count,
    }));
    return result(['bin', 'from', 'to', 'count'], rows, { x: 'bin', series: ['count'] });
  }

  // ─── Points: two numbers, optionally coloured by a category ───────────────
  if (kind === 'scatter') {
    need(table, x, 'xColumn');
    const yColumn = need(table, values[0] ?? '', 'measures');
    let points = table.rows
      .map((r) => ({
        x: num(r[x]),
        y: num(r[yColumn]),
        s: seriesColumn ? String(r[seriesColumn] ?? '') : '',
      }))
      .filter((p) => p.x !== null && p.y !== null);
    let series = [yColumn];
    if (seriesColumn) {
      const totals = new Map<string, number>();
      for (const p of points) totals.set(p.s, (totals.get(p.s) ?? 0) + 1);
      const { kept, folded } = topKeys(totals, MAX_SERIES);
      const fold = new Set(folded);
      points = points.map((p) => (fold.has(p.s) ? { ...p, s: OTHER } : p));
      series = folded.length ? [...kept, OTHER] : kept;
    }
    const drawn = sample(points, MAX_SCATTER);
    return result(
      [x, yColumn, 'series'],
      drawn.map((p) => ({ [x]: p.x, [yColumn]: p.y, series: seriesColumn ? p.s : yColumn })),
      {
        x,
        series,
        y: seriesColumn || undefined,
        omitted: points.length - drawn.length || undefined,
      }
    );
  }

  need(table, x, 'xColumn');
  const valueOf = (i = 0) => values[i] ?? (op === 'count' ? x : need(table, '', 'measures'));
  const groups = groupBy(table.rows, x);

  // ─── Two categories against one value ─────────────────────────────────────
  if (kind === 'heatmap' || kind === 'pivot') {
    const yColumn = need(table, seriesColumn, 'seriesColumn');
    const column = valueOf();
    const yGroups = groupBy(table.rows, yColumn);
    const xTotals = new Map([...groups].map(([k, rows]) => [k, rows.length]));
    const yTotals = new Map([...yGroups].map(([k, rows]) => [k, rows.length]));
    const xKeys = topKeys(xTotals, kind === 'heatmap' ? MAX_HEAT : 500).kept.sort(naturalCompare);
    const ySplit = topKeys(yTotals, kind === 'heatmap' ? MAX_HEAT : MAX_PIVOT_COLUMNS);
    const yKeys = ySplit.kept.sort(naturalCompare);
    if (kind === 'pivot' && ySplit.folded.length) yKeys.push(OTHER);
    const folded = new Set(ySplit.folded);
    const cell = (xk: string, yk: string) =>
      (groups.get(xk) ?? []).filter((r) => {
        const v = r[yColumn] === null || r[yColumn] === undefined ? '' : String(r[yColumn]);
        return yk === OTHER ? folded.has(v) : v === yk;
      });
    const pairs = xKeys.flatMap((xk) => yKeys.map((yk) => [xk, yk] as const));
    const cells = measured(
      pairs.map(([xk, yk]) => cell(xk, yk)),
      column
    );
    if (kind === 'heatmap') {
      const rows = pairs.map(([xk, yk], i) => ({ [x]: xk, [yColumn]: yk, value: cells[i] }));
      return result([x, yColumn, 'value'], rows, {
        x,
        y: yColumn,
        series: ['value'],
        omitted: Math.max(0, xTotals.size - xKeys.length) + ySplit.folded.length || undefined,
      });
    }
    // Pivot: one row per x, one column per y, totals measured on the rows themselves.
    const rowTotals = measured(
      xKeys.map((xk) => groups.get(xk) ?? []),
      column
    );
    const colTotals = measured(
      yKeys.map((yk) => xKeys.flatMap((xk) => cell(xk, yk))),
      column
    );
    const grand = measured([xKeys.flatMap((xk) => groups.get(xk) ?? [])], column)[0];
    const rows: Record<string, any>[] = xKeys.map((xk, i) => ({
      [x]: xk,
      ...Object.fromEntries(yKeys.map((yk, j) => [yk, cells[i * yKeys.length + j]])),
      [TOTAL]: rowTotals[i],
    }));
    rows.push({
      [x]: TOTAL,
      ...Object.fromEntries(yKeys.map((yk, j) => [yk, colTotals[j]])),
      [TOTAL]: grand,
    });
    return result([x, ...yKeys, TOTAL], rows, { x, y: yColumn, series: yKeys });
  }

  // ─── Categories (or time) against one or more values ──────────────────────
  let series: string[];
  let rows: Record<string, any>[];
  const keys = [...groups.keys()];
  if (seriesColumn && kind !== 'pie' && kind !== 'donut') {
    // One value, split into a series per value of seriesColumn.
    const column = valueOf();
    const sTotals = new Map<string, number>();
    for (const r of table.rows) {
      const s =
        r[seriesColumn] === null || r[seriesColumn] === undefined ? '' : String(r[seriesColumn]);
      sTotals.set(s, (sTotals.get(s) ?? 0) + Math.abs(num(r[column]) ?? 1));
    }
    const { kept, folded } = topKeys(sTotals, MAX_SERIES);
    series = folded.length ? [...kept, OTHER] : kept;
    const fold = new Set(folded);
    const pick = (members: Record<string, any>[], s: string) =>
      members.filter((r) => {
        const v =
          r[seriesColumn] === null || r[seriesColumn] === undefined ? '' : String(r[seriesColumn]);
        return s === OTHER ? fold.has(v) : v === s;
      });
    const pairs = keys.flatMap((k) => series.map((s) => pick(groups.get(k)!, s)));
    const cells = measured(pairs, column);
    rows = keys.map((k, i) => ({
      [x]: k,
      ...Object.fromEntries(series.map((s, j) => [s, cells[i * series.length + j]])),
    }));
  } else {
    // Counting rows needs no value column: the series is "count" (never the x column's name).
    const columns = values.length
      ? values.slice(0, kind === 'pie' || kind === 'donut' ? 1 : MAX_SERIES)
      : [valueOf()];
    series = values.length ? columns : ['count'];
    const perColumn = columns.map((c) =>
      measured(
        keys.map((k) => groups.get(k)!),
        c
      )
    );
    rows = keys.map((k, i) => ({
      [x]: k,
      ...Object.fromEntries(series.map((s, j) => [s, perColumn[j][i]])),
    }));
  }

  const total = (r: Record<string, any>) => series.reduce((n, s) => n + (num(r[s]) ?? 0), 0);
  const overTime = kind === 'line' || kind === 'area' || kind === 'stackedArea' || kind === 'combo';
  let omitted: number | undefined;
  if (overTime) {
    rows.sort((a, b) => naturalCompare(String(a[x]), String(b[x])));
    if (rows.length > MAX_POINTS) {
      omitted = rows.length - MAX_POINTS;
      rows = sample(rows, MAX_POINTS);
    }
  } else {
    rows.sort((a, b) =>
      cfg.chartSort === 'byLabel' ? naturalCompare(String(a[x]), String(b[x])) : total(b) - total(a)
    );
    const cap = kind === 'pie' || kind === 'donut' ? MAX_SERIES : MAX_CATEGORIES;
    if (rows.length > cap) {
      // Pie slices past the palette fold into "Other" (a sum); bars are cut, and say so.
      if (kind === 'pie' || kind === 'donut') {
        const byTotal = [...rows].sort((a, b) => total(b) - total(a));
        const rest = byTotal.slice(cap - 1);
        const kept = new Set(byTotal.slice(0, cap - 1));
        rows = rows.filter((r) => kept.has(r));
        rows.push({
          [x]: OTHER,
          [series[0]]: rest.reduce((n, r) => n + (num(r[series[0]]) ?? 0), 0),
        });
        if (op !== 'sum' && op !== 'count')
          warnings.push({ key: 'wf.notice.chartOtherSummed', vars: { count: rest.length } });
      } else {
        omitted = rows.length - cap;
        rows = rows.slice(0, cap);
      }
    }
  }
  return result([x, ...series], rows, { x, series, omitted });
}
