// Terminal pipeline nodes for business analysis: Pareto (ABC), RFM, aging,
// cohorts, period comparison, correlation and quantiles. Like the unified-data
// nodes (unifyNodes.ts) each is pure (rows in, rows out), runs alike in the
// editor and in the worker, and describes its output columns before running.

import {
  CalendarClock,
  ChartNoAxesColumn,
  Gauge,
  Layers,
  Network,
  Split,
  Users,
} from 'lucide-react';
import type { FieldType } from '@/lib/analytics/catalog';
import type { Schema, SchemaColumn } from './schema';
import type { DataTable } from './types';
import { WorkflowError } from './errors';
import {
  aggregate,
  column,
  columns,
  isBlank,
  need,
  newName,
  round,
  table,
  toDay,
  toNumber,
  type UnifyMeta,
  type UnifyRuntime,
} from './unifyNodes';

type Row = Record<string, any>;

export const ANALYTICS_COLOR = '#f59e0b';

export type Period = 'day' | 'week' | 'month' | 'quarter' | 'year';
/** The settings' values (their own labels: "day" etc. are Date Part's). */
export const PERIODS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;
export const COHORT_PERIODS = ['weekly', 'monthly', 'quarterly'] as const;
const PERIOD_OF: Record<string, Period> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  quarterly: 'quarter',
  yearly: 'year',
};

/** Most rows a period comparison makes (periods × groups, gaps included). */
export const PERIOD_ROW_LIMIT = 100_000;
/** Most columns a correlation compares (pairs grow with the square). */
export const CORRELATION_LIMIT = 30;

const meta = (
  type: string,
  label: string,
  description: string,
  icon: any,
  defaultConfig: Record<string, any>
): UnifyMeta => ({
  type,
  category: 'analysis',
  label,
  description,
  icon,
  color: ANALYTICS_COLOR,
  defaultConfig,
});

export const ANALYTICS_META: UnifyMeta[] = [
  meta(
    'an.pareto',
    'Pareto (ABC)',
    'Rank items by value, their share and running share, and class A, B or C',
    ChartNoAxesColumn,
    { itemColumn: '', valueColumn: '', aThreshold: 80, bThreshold: 95 }
  ),
  meta(
    'an.rfm',
    'RFM Segments',
    'Recency, frequency and value of each customer, scored 1–5, with a segment',
    Users,
    { customerColumn: '', dateColumn: '', amountColumn: '', asOf: '' }
  ),
  meta(
    'an.aging',
    'Aging',
    'Days overdue and aging bucket (current, 1–30, 31–60, 61–90, over 90), per row or per party',
    CalendarClock,
    { dateColumn: '', amountColumn: '', termsDays: 0, partyColumn: '', asOf: '' }
  ),
  meta(
    'an.cohort',
    'Cohort Retention',
    'Customers grouped by their first period, and how many come back in later periods',
    Layers,
    { customerColumn: '', dateColumn: '', cohortPeriod: 'monthly' }
  ),
  meta(
    'an.periodCompare',
    'Compare Periods',
    'Totals per period with change vs the previous period and last year, moving average and running total',
    Gauge,
    {
      dateColumn: '',
      valueColumn: '',
      operation: 'sum',
      period: 'monthly',
      groupBy: '',
      movingWindow: 3,
    }
  ),
  meta(
    'an.correlation',
    'Correlation',
    'How strongly numeric columns move together (Pearson), pair by pair',
    Network,
    { columns: '' }
  ),
  meta(
    'an.quantiles',
    'Quantiles',
    'Put each row in a quantile (e.g. quartile 1–4) of a column, with its percentile',
    Split,
    { column: '', buckets: 4, newColumn: 'quantile' }
  ),
];

/** Column settings a node reads (checked against its input). */
export const ANALYTICS_COLUMN_KEYS: Record<string, string[]> = {
  'an.pareto': ['itemColumn', 'valueColumn'],
  'an.rfm': ['customerColumn', 'dateColumn', 'amountColumn'],
  'an.aging': ['dateColumn', 'amountColumn', 'partyColumn'],
  'an.cohort': ['customerColumn', 'dateColumn'],
  'an.periodCompare': ['dateColumn', 'valueColumn', 'groupBy'],
  'an.quantiles': ['column'],
};
export const ANALYTICS_LIST_KEYS: Record<string, string[]> = {
  'an.correlation': ['columns'],
};
export const ANALYTICS_REQUIRED_KEYS: Record<string, string[]> = {
  'an.pareto': ['itemColumn', 'valueColumn'],
  'an.rfm': ['customerColumn', 'dateColumn', 'amountColumn'],
  'an.aging': ['dateColumn', 'amountColumn'],
  'an.cohort': ['customerColumn', 'dateColumn'],
  'an.periodCompare': ['dateColumn'],
  'an.quantiles': ['column', 'newColumn'],
};

// ─── Dates and periods (UTC days) ─────────────────────────────────────────────

const DAY = 86_400_000;

/** A day from a date, or the first of the month for a YYYY-MM month column. */
function dayOf(v: unknown): Date | null {
  if (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v.trim())) return toDay(`${v.trim()}-01`);
  return toDay(v);
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The first day of the period a day is in (weeks start on Monday). */
export function periodStart(d: Date, period: Period): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (period) {
    case 'day':
      return new Date(Date.UTC(y, m, d.getUTCDate()));
    case 'week': {
      const day = new Date(Date.UTC(y, m, d.getUTCDate()));
      return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY);
    }
    case 'month':
      return new Date(Date.UTC(y, m, 1));
    case 'quarter':
      return new Date(Date.UTC(y, m - (m % 3), 1));
    default:
      return new Date(Date.UTC(y, 0, 1));
  }
}

/** The start of the period n periods after (or before, n < 0) this one. */
export function shiftPeriod(start: Date, period: Period, n: number): Date {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  switch (period) {
    case 'day':
      return new Date(start.getTime() + n * DAY);
    case 'week':
      return new Date(start.getTime() + 7 * n * DAY);
    case 'month':
      return new Date(Date.UTC(y, m + n, 1));
    case 'quarter':
      return new Date(Date.UTC(y, m + 3 * n, 1));
    default:
      return new Date(Date.UTC(y + n, 0, 1));
  }
}

/** A label that sorts in time order: 2026-10-23, 2026-10-19 (week of), 2026-10, 2026-Q4, 2026. */
export function periodLabel(start: Date, period: Period): string {
  const y = start.getUTCFullYear();
  switch (period) {
    case 'day':
    case 'week':
      return iso(start);
    case 'month':
      return iso(start).slice(0, 7);
    case 'quarter':
      return `${y}-Q${Math.floor(start.getUTCMonth() / 3) + 1}`;
    default:
      return String(y);
  }
}

/** Whole periods from a to b (both period starts). */
function periodsBetween(a: Date, b: Date, period: Period): number {
  switch (period) {
    case 'day':
      return Math.round((b.getTime() - a.getTime()) / DAY);
    case 'week':
      return Math.round((b.getTime() - a.getTime()) / (7 * DAY));
    case 'month':
      return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
    case 'quarter':
      return Math.round(
        ((b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth()) / 3
      );
    default:
      return b.getUTCFullYear() - a.getUTCFullYear();
  }
}

const periodOf = (v: unknown, allowed: readonly string[]): Period =>
  allowed.includes(String(v)) ? PERIOD_OF[String(v)] : 'month';

/** The day results are measured on: the setting, else `fallback`. */
function asOfDay(value: unknown, fallback: () => Date): Date {
  if (isBlank(value)) return fallback();
  const d = toDay(value);
  if (!d) throw new WorkflowError('wf.err.badAsOf', { value: String(value) });
  return periodStart(d, 'day');
}

const today = () => periodStart(new Date(), 'day');
const pct = (part: number, whole: number) => (whole ? round((part / whole) * 100, 2) : null);

/** 1–5: the share of values below this one, in fifths (5 = the top fifth). */
function quintile(value: number, sorted: number[]): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(5, 1 + Math.floor((5 * lo) / Math.max(sorted.length, 1)));
}

export function rfmSegment(r: number, f: number, m: number): string {
  const fm = (f + m) / 2;
  if (r >= 4 && fm >= 4) return 'Champions';
  if (r >= 3 && fm >= 3) return 'Loyal';
  if (r >= 4) return 'New';
  if (r <= 2 && fm >= 3) return 'At risk';
  if (r <= 2 && fm <= 2) return 'Lost';
  return 'Needs attention';
}

export const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
function agingBucket(daysOverdue: number): (typeof AGING_BUCKETS)[number] {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90_plus';
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

export function correlationStrength(r: number | null): string {
  if (r === null) return 'unknown';
  const a = Math.abs(r);
  const size = a >= 0.7 ? 'strong' : a >= 0.4 ? 'moderate' : a >= 0.2 ? 'weak' : 'none';
  return size === 'none' ? 'none' : `${size} ${r > 0 ? 'positive' : 'negative'}`;
}

/** Columns most of whose filled values are numbers (correlation without a list). */
function numericColumns(t: DataTable): string[] {
  return t.columns.filter((c) => {
    const ty = t.meta?.columnTypes?.[c];
    if (ty) return ty === 'number' || ty === 'integer';
    const filled = t.rows.map((r) => r[c]).filter((v) => !isBlank(v));
    return (
      filled.length > 0 && filled.filter((v) => toNumber(v) !== null).length / filled.length >= 0.9
    );
  });
}

// ─── Running ──────────────────────────────────────────────────────────────────

const one = (run: (cfg: any, input: DataTable) => DataTable): UnifyRuntime => ({
  inputs: 1,
  outputs: ['out'],
  run: async (cfg, ins) => run(cfg, need(ins[0])),
});

export const ANALYTICS_RUNTIME: Record<string, UnifyRuntime> = {
  'an.pareto': one((cfg, t) => {
    const item = column(t, cfg.itemColumn, 'itemColumn');
    const value = column(t, cfg.valueColumn, 'valueColumn');
    const a = Number(cfg.aThreshold) > 0 ? Number(cfg.aThreshold) : 80;
    const b = Number(cfg.bThreshold) > a ? Number(cfg.bThreshold) : Math.max(a, 95);
    const totals = new Map<string, number>();
    for (const r of t.rows) {
      const k = isBlank(r[item]) ? '' : String(r[item]);
      totals.set(k, (totals.get(k) ?? 0) + (toNumber(r[value]) ?? 0));
    }
    const ranked = [...totals].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
    const whole = ranked.reduce((s, [, v]) => s + Math.max(v, 0), 0);
    let before = 0;
    const rows = ranked.map(([k, v], i) => {
      const positive = Math.max(v, 0);
      // An item is A while the share before it is under the A line (so the item crossing it is A).
      const share = whole ? (before / whole) * 100 : 100;
      before += positive;
      return {
        [item]: k || null,
        [value]: round(v),
        rank: i + 1,
        share_pct: pct(positive, whole),
        cumulative_pct: pct(before, whole),
        abc_class: positive <= 0 ? 'C' : share < a ? 'A' : share < b ? 'B' : 'C',
      };
    });
    return table(t, [item, value, 'rank', 'share_pct', 'cumulative_pct', 'abc_class'], rows, {
      [value]: 'number',
      rank: 'number',
      share_pct: 'number',
      cumulative_pct: 'number',
      abc_class: 'text',
    });
  }),

  'an.rfm': one((cfg, t) => {
    const customer = column(t, cfg.customerColumn, 'customerColumn');
    const date = column(t, cfg.dateColumn, 'dateColumn');
    const amount = column(t, cfg.amountColumn, 'amountColumn');
    const people = new Map<string, { last: Date; orders: number; value: number }>();
    let latest: Date | null = null;
    for (const r of t.rows) {
      const d = dayOf(r[date]);
      if (!d || isBlank(r[customer])) continue;
      const k = String(r[customer]);
      const p = people.get(k) ?? { last: d, orders: 0, value: 0 };
      if (d > p.last) p.last = d;
      p.orders += 1;
      p.value += toNumber(r[amount]) ?? 0;
      people.set(k, p);
      if (!latest || d > latest) latest = d;
    }
    // Without a date: the newest order in the data, so old exports still read sensibly.
    const asOf = asOfDay(cfg.asOf, () => latest ?? today());
    const list = [...people].map(([k, p]) => ({
      k,
      recency: Math.max(
        0,
        Math.round((asOf.getTime() - periodStart(p.last, 'day').getTime()) / DAY)
      ),
      ...p,
    }));
    const sorted = (f: (x: (typeof list)[number]) => number) => list.map(f).sort((x, y) => x - y);
    const [rs, fs, ms] = [
      sorted((x) => x.recency),
      sorted((x) => x.orders),
      sorted((x) => x.value),
    ];
    const rows = list
      .map((x) => {
        // Fewer days since the last order is better: the most recent fifth scores 5.
        const r = 6 - quintile(x.recency, rs);
        const f = quintile(x.orders, fs);
        const m = quintile(x.value, ms);
        return {
          [customer]: x.k,
          last_date: iso(x.last),
          recency_days: x.recency,
          frequency: x.orders,
          monetary: round(x.value, 2),
          r_score: r,
          f_score: f,
          m_score: m,
          rfm: `${r}${f}${m}`,
          segment: rfmSegment(r, f, m),
        };
      })
      .sort(
        (x, y) => y.monetary - x.monetary || String(x[customer]).localeCompare(String(y[customer]))
      );
    return table(
      t,
      Object.keys(RFM_TYPES).map((c) => (c === '$customer' ? customer : c)),
      rows,
      {
        ...Object.fromEntries(Object.entries(RFM_TYPES).filter(([c]) => c !== '$customer')),
        [customer]: t.meta?.columnTypes?.[customer] ?? 'text',
      }
    );
  }),

  'an.aging': one((cfg, t) => {
    const date = column(t, cfg.dateColumn, 'dateColumn');
    const amount = column(t, cfg.amountColumn, 'amountColumn');
    const party = isBlank(cfg.partyColumn) ? null : column(t, cfg.partyColumn, 'partyColumn');
    const terms = Number.isFinite(Number(cfg.termsDays)) ? Math.trunc(Number(cfg.termsDays)) : 0;
    const asOf = asOfDay(cfg.asOf, today);
    const overdue = (r: Row) => {
      const d = dayOf(r[date]);
      return d
        ? Math.round((asOf.getTime() - periodStart(d, 'day').getTime()) / DAY) - terms
        : null;
    };
    if (!party) {
      const rows = t.rows.map((r) => {
        const days = overdue(r);
        return { ...r, days_overdue: days, aging_bucket: days === null ? null : agingBucket(days) };
      });
      const cols = [
        ...t.columns.filter((c) => c !== 'days_overdue' && c !== 'aging_bucket'),
        'days_overdue',
        'aging_bucket',
      ];
      return table(t, cols, rows, { days_overdue: 'number', aging_bucket: 'text' });
    }
    const byParty = new Map<string, Row>();
    for (const r of t.rows) {
      const days = overdue(r);
      const v = toNumber(r[amount]);
      if (days === null || v === null) continue;
      const k = isBlank(r[party]) ? '' : String(r[party]);
      const acc = byParty.get(k) ?? {
        [party]: k || null,
        ...Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])),
        total: 0,
        oldest_days: 0,
      };
      acc[agingBucket(days)] += v;
      acc.total += v;
      acc.oldest_days = Math.max(acc.oldest_days, days);
      byParty.set(k, acc);
    }
    const rows = [...byParty.values()]
      .map((r) => ({
        ...r,
        ...Object.fromEntries([...AGING_BUCKETS, 'total'].map((b) => [b, round(r[b], 2)])),
      }))
      // The largest amount first; at the same amount, the oldest debt.
      .sort((x, y) => y.total - x.total || y.oldest_days - x.oldest_days);
    return table(t, [party, ...AGING_BUCKETS, 'total', 'oldest_days'], rows, {
      ...Object.fromEntries(
        [...AGING_BUCKETS, 'total', 'oldest_days'].map((c) => [c, 'number' as FieldType])
      ),
      [party]: t.meta?.columnTypes?.[party] ?? 'text',
    });
  }),

  'an.cohort': one((cfg, t) => {
    const customer = column(t, cfg.customerColumn, 'customerColumn');
    const date = column(t, cfg.dateColumn, 'dateColumn');
    const period = periodOf(cfg.cohortPeriod, COHORT_PERIODS);
    const active = new Map<string, Set<number>>();
    for (const r of t.rows) {
      const d = dayOf(r[date]);
      if (!d || isBlank(r[customer])) continue;
      const k = String(r[customer]);
      const set = active.get(k) ?? new Set<number>();
      set.add(periodStart(d, period).getTime());
      active.set(k, set);
    }
    // cohort start → period index → customers active then
    const cohorts = new Map<number, Map<number, number>>();
    for (const set of active.values()) {
      const first = Math.min(...set);
      const counts = cohorts.get(first) ?? new Map<number, number>();
      for (const p of set) {
        const i = periodsBetween(new Date(first), new Date(p), period);
        counts.set(i, (counts.get(i) ?? 0) + 1);
      }
      cohorts.set(first, counts);
    }
    const rows: Row[] = [];
    for (const [start, counts] of [...cohorts].sort((x, y) => x[0] - y[0])) {
      const size = counts.get(0) ?? 0;
      const last = Math.max(...counts.keys());
      for (let i = 0; i <= last; i += 1) {
        const n = counts.get(i) ?? 0;
        rows.push({
          cohort: periodLabel(new Date(start), period),
          period_index: i,
          period: periodLabel(shiftPeriod(new Date(start), period, i), period),
          cohort_size: size,
          active_customers: n,
          retention_pct: pct(n, size),
        });
      }
    }
    return table(t, Object.keys(COHORT_TYPES), rows, COHORT_TYPES);
  }),

  'an.periodCompare': one((cfg, t) => {
    const date = column(t, cfg.dateColumn, 'dateColumn');
    const op = ['sum', 'avg', 'count', 'min', 'max'].includes(cfg.operation)
      ? cfg.operation
      : 'sum';
    const value =
      op === 'count' && isBlank(cfg.valueColumn) ? null : column(t, cfg.valueColumn, 'valueColumn');
    const group = isBlank(cfg.groupBy) ? null : column(t, cfg.groupBy, 'groupBy');
    const period = periodOf(cfg.period, PERIODS);
    const window = Math.min(Math.max(Math.trunc(Number(cfg.movingWindow)) || 3, 1), 60);
    const perYear = { day: 0, week: 52, month: 12, quarter: 4, year: 1 }[period];

    // group → period start → values
    const groups = new Map<string, Map<number, unknown[]>>();
    for (const r of t.rows) {
      const d = dayOf(r[date]);
      if (!d) continue;
      const g = group ? (isBlank(r[group]) ? '' : String(r[group])) : '';
      const p = periodStart(d, period).getTime();
      const byPeriod = groups.get(g) ?? new Map<number, unknown[]>();
      const vals = byPeriod.get(p) ?? [];
      vals.push(value ? r[value] : 1);
      byPeriod.set(p, vals);
      groups.set(g, byPeriod);
    }
    const rows: Row[] = [];
    for (const [g, byPeriod] of [...groups].sort((x, y) => x[0].localeCompare(y[0]))) {
      const starts = [...byPeriod.keys()];
      const first = new Date(Math.min(...starts));
      const span = periodsBetween(first, new Date(Math.max(...starts)), period);
      if (rows.length + span + 1 > PERIOD_ROW_LIMIT)
        throw new WorkflowError('wf.err.tooManyPeriods', { max: PERIOD_ROW_LIMIT });
      // Every period from the first to the last: a month without sales is 0, not missing.
      const series: { start: Date; v: number | null }[] = [];
      for (let i = 0; i <= span; i += 1) {
        const start = shiftPeriod(first, period, i);
        const vals = byPeriod.get(start.getTime());
        const v = vals ? aggregate(vals, op) : op === 'sum' || op === 'count' ? 0 : null;
        series.push({ start, v });
      }
      let running = 0;
      series.forEach(({ start, v }, i) => {
        const prev = i > 0 ? series[i - 1].v : null;
        const lastYear = perYear && i >= perYear ? series[i - perYear].v : null;
        const recent = series
          .slice(Math.max(0, i - window + 1), i + 1)
          .map((s) => s.v)
          .filter((x): x is number => x !== null);
        running += v ?? 0;
        rows.push({
          ...(group ? { [group]: g || null } : {}),
          period: periodLabel(start, period),
          period_start: iso(start),
          value: v,
          previous: prev,
          change: v !== null && prev !== null ? round(v - prev) : null,
          change_pct: v !== null && prev ? round(((v - prev) / Math.abs(prev)) * 100, 2) : null,
          last_year: lastYear,
          yoy_pct:
            v !== null && lastYear ? round(((v - lastYear) / Math.abs(lastYear)) * 100, 2) : null,
          moving_avg: recent.length
            ? round(recent.reduce((a, b) => a + b, 0) / recent.length)
            : null,
          running_total: round(running),
        });
      });
    }
    const cols = [...(group ? [group] : []), ...Object.keys(PERIOD_TYPES)];
    return table(t, cols, rows, {
      ...PERIOD_TYPES,
      ...(group ? { [group]: t.meta?.columnTypes?.[group] ?? 'text' } : {}),
    });
  }),

  'an.correlation': one((cfg, t) => {
    const cols = columns(t, cfg.columns, numericColumns(t));
    if (cols.length < 2) throw new WorkflowError('wf.err.needTwoNumeric');
    if (cols.length > CORRELATION_LIMIT)
      throw new WorkflowError('wf.err.tooManyColumns', { max: CORRELATION_LIMIT });
    const nums = Object.fromEntries(cols.map((c) => [c, t.rows.map((r) => toNumber(r[c]))]));
    const rows: Row[] = [];
    for (let i = 0; i < cols.length; i += 1)
      for (let j = i + 1; j < cols.length; j += 1) {
        const xs: number[] = [];
        const ys: number[] = [];
        nums[cols[i]].forEach((x, k) => {
          const y = nums[cols[j]][k];
          if (x !== null && y !== null) {
            xs.push(x);
            ys.push(y);
          }
        });
        const r = pearson(xs, ys);
        rows.push({
          column_a: cols[i],
          column_b: cols[j],
          correlation: r === null ? null : round(r, 4),
          pairs: xs.length,
          strength: correlationStrength(r),
        });
      }
    rows.sort((x, y) => Math.abs(y.correlation ?? 0) - Math.abs(x.correlation ?? 0));
    return table(t, Object.keys(CORRELATION_TYPES), rows, CORRELATION_TYPES);
  }),

  'an.quantiles': one((cfg, t) => {
    const c = column(t, cfg.column, 'column');
    const name = newName(cfg.newColumn, 'newColumn');
    const n = Math.min(Math.max(Math.trunc(Number(cfg.buckets)) || 4, 2), 100);
    const vals = t.rows.map((r) => toNumber(r[c]));
    const sorted = vals.filter((v): v is number => v !== null).sort((a, b) => a - b);
    const below = (v: number) => {
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const rows = t.rows.map((r, i) => {
      const v = vals[i];
      if (v === null) return { ...r, [name]: null, [`${name}_percentile`]: null };
      const less = below(v);
      const equal = below(v + Number.EPSILON * Math.max(1, Math.abs(v))) - less || 1;
      const p = ((less + equal / 2) / sorted.length) * 100;
      return {
        ...r,
        [name]: Math.min(n, Math.floor((less / sorted.length) * n) + 1),
        [`${name}_percentile`]: round(p, 2),
      };
    });
    const added = [name, `${name}_percentile`];
    return table(t, [...t.columns.filter((x) => !added.includes(x)), ...added], rows, {
      [name]: 'number',
      [`${name}_percentile`]: 'number',
    });
  }),
};

const RFM_TYPES: Record<string, FieldType> = {
  $customer: 'text',
  last_date: 'date',
  recency_days: 'number',
  frequency: 'number',
  monetary: 'number',
  r_score: 'number',
  f_score: 'number',
  m_score: 'number',
  rfm: 'text',
  segment: 'text',
};
const COHORT_TYPES: Record<string, FieldType> = {
  cohort: 'text',
  period_index: 'number',
  period: 'text',
  cohort_size: 'number',
  active_customers: 'number',
  retention_pct: 'number',
};
const PERIOD_TYPES: Record<string, FieldType> = {
  period: 'text',
  period_start: 'date',
  value: 'number',
  previous: 'number',
  change: 'number',
  change_pct: 'number',
  last_year: 'number',
  yoy_pct: 'number',
  moving_avg: 'number',
  running_total: 'number',
};
const CORRELATION_TYPES: Record<string, FieldType> = {
  column_a: 'text',
  column_b: 'text',
  correlation: 'number',
  pairs: 'number',
  strength: 'text',
};

// ─── Output columns, for the editor (before running) ─────────────────────────

const cols = (types: Record<string, FieldType>): SchemaColumn[] =>
  Object.entries(types).map(([name, type]) => ({ name, type }));
const typeIn = (input: Schema, name: string): FieldType =>
  input?.find((c) => c.name === name)?.type ?? 'text';
const name = (v: unknown) => String(v ?? '').trim();

/** Output columns of a node of this module, or undefined when it is not one. */
export function analyticsSchema(
  type: string,
  cfg: any,
  inputs: Schema[]
): Record<string, Schema> | undefined {
  if (!(type in ANALYTICS_RUNTIME)) return undefined;
  const [input] = inputs;
  switch (type) {
    case 'an.pareto': {
      if (!name(cfg.itemColumn) || !name(cfg.valueColumn)) return { out: null };
      return {
        out: [
          { name: name(cfg.itemColumn), type: typeIn(input, name(cfg.itemColumn)) },
          { name: name(cfg.valueColumn), type: 'number' },
          ...cols({
            rank: 'number',
            share_pct: 'number',
            cumulative_pct: 'number',
            abc_class: 'text',
          }),
        ],
      };
    }
    case 'an.rfm': {
      const c = name(cfg.customerColumn);
      if (!c) return { out: null };
      return {
        out: Object.entries(RFM_TYPES).map(([n, ty]) =>
          n === '$customer' ? { name: c, type: typeIn(input, c) } : { name: n, type: ty }
        ),
      };
    }
    case 'an.aging': {
      const party = name(cfg.partyColumn);
      if (party)
        return {
          out: [
            { name: party, type: typeIn(input, party) },
            ...[...AGING_BUCKETS, 'total', 'oldest_days'].map((n) => ({
              name: n,
              type: 'number' as FieldType,
            })),
          ],
        };
      return {
        out: input && [
          ...input.filter((c) => c.name !== 'days_overdue' && c.name !== 'aging_bucket'),
          { name: 'days_overdue', type: 'number' },
          { name: 'aging_bucket', type: 'text' },
        ],
      };
    }
    case 'an.cohort':
      return { out: cols(COHORT_TYPES) };
    case 'an.periodCompare': {
      const g = name(cfg.groupBy);
      return { out: [...(g ? [{ name: g, type: typeIn(input, g) }] : []), ...cols(PERIOD_TYPES)] };
    }
    case 'an.correlation':
      return { out: cols(CORRELATION_TYPES) };
    case 'an.quantiles': {
      const n = name(cfg.newColumn);
      if (!n) return { out: input };
      const added = [n, `${n}_percentile`];
      return {
        out: input && [
          ...input.filter((c) => !added.includes(c.name)),
          ...added.map((x) => ({ name: x, type: 'number' as FieldType })),
        ],
      };
    }
    default:
      return { out: input };
  }
}
