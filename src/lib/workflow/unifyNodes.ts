// Terminal pipeline nodes for unified data: combining and cleaning tables,
// matching records across sources, reshaping, and checking quality. Each
// node is pure (rows in, rows out), so it runs alike in the editor and in the
// worker's background runs, and describes its output columns for the editor.

import {
  ArrowRightLeft,
  BadgeCheck,
  CalendarDays,
  CalendarRange,
  CopyMinus,
  Eraser,
  FileSearch,
  Grid3x3,
  Link2,
  ListChecks,
  Merge,
  PaintBucket,
  Replace,
  Rows3,
  ScanSearch,
  SplitSquareHorizontal,
  Type,
  Activity,
} from 'lucide-react';
import type { FieldType } from '@/lib/analytics/catalog';
import { coerce, parseDate, parseNumber, type ColumnType } from '@/lib/terminal/tabular';
import type { Schema, SchemaColumn } from './schema';
import type { DataTable, NodeCategory } from './types';
import { WorkflowError } from './errors';

type Row = Record<string, any>;

export interface UnifyMeta {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  icon: any;
  color: string;
  defaultConfig: Record<string, any>;
}

export interface UnifyRuntime {
  inputs: number;
  outputs: readonly string[];
  run: (cfg: any, inputs: DataTable[]) => Promise<DataTable | Record<string, DataTable>>;
}

export const UNIFY_COLORS = {
  combine: '#8b5cf6',
  match: '#ec4899',
  reshape: '#06b6d4',
  quality: '#ef4444',
} as const;

export const RULE_HANDLES = ['valid', 'invalid'] as const;

/** Most rows × candidates a fuzzy match compares in one run. */
export const MATCH_LIMIT = 4_000_000;
/** Most new columns a pivot makes. */
export const PIVOT_LIMIT = 200;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const listOf = (value: unknown): string[] =>
  String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const isBlank = (v: unknown) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function need(input: DataTable | undefined): DataTable {
  if (!input) throw new WorkflowError('wf.err.noInput');
  return input;
}

function column(table: DataTable, name: unknown, field: string): string {
  const c = String(name ?? '').trim();
  if (!c) throw new WorkflowError('wf.err.missingConfig', { field });
  if (!table.columns.includes(c)) throw new WorkflowError('wf.err.unknownColumn', { column: c });
  return c;
}

function columns(table: DataTable, value: unknown, fallback: string[] = table.columns): string[] {
  const list = listOf(value);
  for (const c of list)
    if (!table.columns.includes(c)) throw new WorkflowError('wf.err.unknownColumn', { column: c });
  return list.length ? list : fallback;
}

function newName(value: unknown, field: string): string {
  const name = String(value ?? '').trim();
  if (!name) throw new WorkflowError('wf.err.missingConfig', { field });
  return name;
}

/** A new table from rows, keeping the input's notes; column types are given or carried. */
function table(
  input: DataTable,
  cols: string[],
  rows: Row[],
  types: Record<string, FieldType | undefined> = {}
): DataTable {
  const columnTypes: Record<string, FieldType> = {};
  for (const c of cols) {
    const ty = c in types ? types[c] : input.meta?.columnTypes?.[c];
    if (ty) columnTypes[c] = ty;
  }
  const lineage = Object.fromEntries(
    Object.entries(input.meta?.lineage ?? {}).filter(([c]) => cols.includes(c) && !(c in types))
  );
  return {
    columns: cols,
    rows,
    meta: {
      ...input.meta,
      count: rows.length,
      columnTypes,
      lineage,
      repeated: (input.meta?.repeated ?? []).filter((c) => cols.includes(c) && !(c in types)),
    },
  };
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (isBlank(v) || typeof v === 'boolean') return null;
  const s = String(v);
  return parseNumber(s, '.') ?? parseNumber(s, ',');
}

/** A day (UTC midnight) from a Date, ISO date or time, or dd/mm/yyyy; else null. */
function toDay(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (isBlank(v)) return null;
  const s = String(v).trim();
  const day = parseDate(s.slice(0, 10)) ?? parseDate(s);
  if (day) return new Date(`${day}T00:00:00Z`);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

const key = (row: Row, cols: string[]) => JSON.stringify(cols.map((c) => row[c] ?? null));
const round = (n: number, digits = 6) => Number(n.toFixed(digits));

function aggregate(values: unknown[], op: string): number | null {
  if (op === 'count') return values.filter((v) => !isBlank(v)).length;
  const nums = values.map(toNumber).filter((n): n is number => n !== null);
  if (!nums.length) return null;
  switch (op) {
    case 'avg':
      return round(nums.reduce((a, b) => a + b, 0) / nums.length);
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
    default:
      return round(nums.reduce((a, b) => a + b, 0));
  }
}

/** "PT. Batu Jaya Tbk" and "batu jaya" compare alike. */
const LEGAL = new Set([
  'pt',
  'cv',
  'ud',
  'tbk',
  'persero',
  'pd',
  'fa',
  'koperasi',
  'inc',
  'ltd',
  'llc',
  'co',
  'corp',
  'the',
]);
export function normalizeName(v: unknown): string {
  return String(v ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !LEGAL.has(w))
    .sort()
    .join(' ');
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i += 1) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** A shorter name all of whose words are in the longer one ("kerikil" in "kerikil makmur"). */
const CONTAINED = 0.85;

/**
 * How alike two normalized names are, 0 (nothing alike) to 1 (the same):
 * the Dice similarity of character pairs, and at least 0.85 when every word
 * (of three letters or more) of one is a word of the other.
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = bigrams(a);
  const y = bigrams(b);
  let common = 0;
  let total = 0;
  for (const [g, n] of x) {
    common += Math.min(n, y.get(g) ?? 0);
    total += n;
  }
  for (const n of y.values()) total += n;
  const dice = total ? (2 * common) / total : 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const words = short.split(' ');
  const longWords = new Set(long.split(' '));
  const contained = words.every((w) => w.length >= 3 && longWords.has(w));
  return Math.max(dice, contained ? CONTAINED : 0);
}

/** Pairs "from=to; from=to" (values may contain commas). */
function mappingOf(value: unknown): [string, string][] {
  return String(value ?? '')
    .split(/[;\n]/)
    .map((pair) => {
      const i = pair.indexOf('=');
      return i > 0
        ? ([pair.slice(0, i).trim(), pair.slice(i + 1).trim()] as [string, string])
        : null;
    })
    .filter((p): p is [string, string] => !!p && !!p[0]);
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** Where the right table's column goes in the result (renamed when the name is taken). */
function bringNames(left: string[], bring: string[], prefix: string): Map<string, string> {
  const taken = new Set(left);
  const out = new Map<string, string>();
  for (const c of bring) {
    const name = taken.has(c) ? `${prefix}.${c}` : c;
    taken.add(name);
    out.set(c, name);
  }
  return out;
}

const CAST: Record<string, ColumnType> = {
  text: 'text',
  number: 'decimal',
  integer: 'integer',
  date: 'date',
  boolean: 'boolean',
};
const CAST_FIELD: Record<string, FieldType> = {
  text: 'text',
  number: 'number',
  integer: 'integer',
  date: 'date',
  boolean: 'boolean',
};

// ─── Definitions ──────────────────────────────────────────────────────────────

const meta = (
  type: string,
  category: NodeCategory,
  label: string,
  description: string,
  icon: any,
  defaultConfig: Record<string, any>
): UnifyMeta => ({
  type,
  category,
  label,
  description,
  icon,
  color: UNIFY_COLORS[category as keyof typeof UNIFY_COLORS],
  defaultConfig,
});

export const UNIFY_META: UnifyMeta[] = [
  meta(
    'tf.union',
    'combine',
    'Stack Tables',
    'Put the rows of two tables together, matching columns by name',
    Rows3,
    {
      sourceColumn: '',
      firstLabel: 'A',
      secondLabel: 'B',
    }
  ),
  meta('tf.dedupe', 'combine', 'Remove Duplicates', 'Keep one row per key', CopyMinus, {
    keyColumns: '',
    keep: 'first',
  }),
  meta(
    'tf.fillMissing',
    'combine',
    'Fill Missing',
    'Fill empty cells with a value, the previous value, zero or the average',
    PaintBucket,
    {
      columns: '',
      fillMethod: 'value',
      fillValue: '',
    }
  ),
  meta(
    'tf.cast',
    'combine',
    'Change Type',
    'Read a column as text, number, whole number, date or yes/no',
    Type,
    {
      column: '',
      toType: 'number',
    }
  ),
  meta('tf.cleanText', 'combine', 'Clean Text', 'Trim spaces and change letter case', Eraser, {
    columns: '',
    textCase: 'none',
    trim: true,
    collapseSpaces: true,
  }),
  meta(
    'tf.split',
    'combine',
    'Split Column',
    'Split a column into several at a separator',
    SplitSquareHorizontal,
    {
      column: '',
      separator: ',',
      newColumns: '',
    }
  ),
  meta('tf.concat', 'combine', 'Combine Columns', 'Join several columns into one text', Merge, {
    columns: '',
    separator: ' ',
    newColumn: 'combined',
  }),

  meta(
    'tf.lookup',
    'match',
    'Lookup',
    'Add columns from a second table where the keys are equal',
    Link2,
    {
      key: '',
      lookupKey: '',
      bring: '',
    }
  ),
  meta(
    'tf.fuzzyMatch',
    'match',
    'Fuzzy Match',
    'Match names that are written differently (e.g. "PT Batu Jaya" and "Batu Jaya, PT")',
    ScanSearch,
    {
      matchColumn: '',
      candidateColumn: '',
      threshold: 0.8,
      bring: '',
    }
  ),
  meta(
    'tf.standardize',
    'match',
    'Standardize Values',
    'Replace values with one agreed spelling or code',
    Replace,
    {
      column: '',
      mapping: '',
      unmatched: 'keep',
    }
  ),

  meta('tf.pivot', 'reshape', 'Pivot', 'Turn the values of a column into columns', Grid3x3, {
    rowKey: '',
    pivotColumn: '',
    valueColumn: '',
    operation: 'sum',
  }),
  meta(
    'tf.unpivot',
    'reshape',
    'Unpivot',
    'Turn columns into rows of name and value',
    ArrowRightLeft,
    {
      idColumns: '',
      valueColumns: '',
      nameColumn: 'field',
      valueName: 'value',
    }
  ),
  meta(
    'tf.window',
    'reshape',
    'Running Values',
    'Running total, rank, previous value or share of total, per group',
    Activity,
    {
      windowOp: 'running_sum',
      column: '',
      partitionBy: '',
      orderBy: '',
      newColumn: 'result',
    }
  ),
  meta(
    'tf.dateParts',
    'reshape',
    'Date Part',
    'Year, quarter, month, week or weekday of a date',
    CalendarDays,
    {
      column: '',
      datePart: 'month',
      newColumn: '',
    }
  ),
  meta(
    'tf.dateDiff',
    'reshape',
    'Date Difference',
    'Days, weeks, months or years between two dates',
    CalendarRange,
    {
      startColumn: '',
      endColumn: '',
      diffUnit: 'days',
      newColumn: 'days',
    }
  ),

  meta(
    'an.profile',
    'quality',
    'Profile Columns',
    'Type, missing, distinct, smallest, largest and most common value of every column',
    FileSearch,
    {}
  ),
  meta(
    'tf.rules',
    'quality',
    'Check Rules',
    'Split rows that pass the rules from rows that do not (with the reason)',
    ListChecks,
    {
      requiredColumns: '',
      numericColumns: '',
      dateColumns: '',
      uniqueKey: '',
      rangeColumn: '',
      min: '',
      max: '',
      allowedColumn: '',
      allowedValues: '',
    }
  ),
  meta(
    'an.outliers',
    'quality',
    'Find Outliers',
    'Mark values far from the others (IQR or z-score)',
    BadgeCheck,
    {
      column: '',
      outlierMethod: 'iqr',
      threshold: 1.5,
    }
  ),
];

/** Column settings a node reads (checked against its input). */
export const UNIFY_COLUMN_KEYS: Record<string, string[]> = {
  'tf.cast': ['column'],
  'tf.split': ['column'],
  'tf.lookup': ['key'],
  'tf.fuzzyMatch': ['matchColumn'],
  'tf.standardize': ['column'],
  'tf.pivot': ['rowKey', 'pivotColumn', 'valueColumn'],
  'tf.window': ['column', 'partitionBy', 'orderBy'],
  'tf.dateParts': ['column'],
  'tf.dateDiff': ['startColumn', 'endColumn'],
  'tf.rules': ['rangeColumn', 'allowedColumn'],
  'an.outliers': ['column'],
};
export const UNIFY_LIST_KEYS: Record<string, string[]> = {
  'tf.dedupe': ['keyColumns'],
  'tf.fillMissing': ['columns'],
  'tf.cleanText': ['columns'],
  'tf.concat': ['columns'],
  'tf.unpivot': ['idColumns', 'valueColumns'],
  'tf.rules': ['requiredColumns', 'numericColumns', 'dateColumns', 'uniqueKey'],
};
export const UNIFY_REQUIRED_KEYS: Record<string, string[]> = {
  'tf.cast': ['column'],
  'tf.split': ['column', 'newColumns'],
  'tf.concat': ['columns', 'newColumn'],
  'tf.lookup': ['key', 'lookupKey'],
  'tf.fuzzyMatch': ['matchColumn', 'candidateColumn'],
  'tf.standardize': ['column', 'mapping'],
  'tf.pivot': ['rowKey', 'pivotColumn'],
  'tf.window': ['newColumn'],
  'tf.dateParts': ['column'],
  'tf.dateDiff': ['startColumn', 'endColumn', 'newColumn'],
  'an.outliers': ['column'],
};

// ─── Running ──────────────────────────────────────────────────────────────────

const one = (run: (cfg: any, input: DataTable) => DataTable, inputs = 1): UnifyRuntime => ({
  inputs,
  outputs: ['out'],
  run: async (cfg, ins) => run(cfg, need(ins[0])),
});
const two = (run: (cfg: any, left: DataTable, right: DataTable) => DataTable): UnifyRuntime => ({
  inputs: 2,
  outputs: ['out'],
  run: async (cfg, [left, right]) => {
    if (!left || !right) throw new WorkflowError('wf.err.needTwoInputs');
    return run(cfg, left, right);
  },
});

export const UNIFY_RUNTIME: Record<string, UnifyRuntime> = {
  'tf.union': two((cfg, a, b) => {
    const cols = [...a.columns, ...b.columns.filter((c) => !a.columns.includes(c))];
    const src = String(cfg.sourceColumn ?? '').trim();
    if (src && !cols.includes(src)) cols.push(src);
    const tag = (rows: Row[], label: string) =>
      rows.map((r) =>
        Object.fromEntries(cols.map((c) => [c, src && c === src ? label : (r[c] ?? null)]))
      );
    const rows = [
      ...tag(a.rows, String(cfg.firstLabel ?? 'A')),
      ...tag(b.rows, String(cfg.secondLabel ?? 'B')),
    ];
    const types: Record<string, FieldType | undefined> = {};
    for (const c of cols) {
      const ta = a.meta?.columnTypes?.[c];
      const tb = b.meta?.columnTypes?.[c];
      types[c] = c === src ? 'text' : ta && tb && ta !== tb ? 'text' : (ta ?? tb);
    }
    return table(a, cols, rows, types);
  }),

  'tf.dedupe': one((cfg, t) => {
    const keys = columns(t, cfg.keyColumns);
    const seen = new Map<string, number>();
    const rows: Row[] = [];
    for (const r of t.rows) {
      const k = key(r, keys);
      const at = seen.get(k);
      if (at === undefined) {
        seen.set(k, rows.length);
        rows.push(r);
      } else if (cfg.keep === 'last') rows[at] = r;
    }
    return table(t, t.columns, rows);
  }),

  'tf.fillMissing': one((cfg, t) => {
    const cols = columns(t, cfg.columns);
    const method = String(cfg.fillMethod ?? 'value');
    const means = new Map<string, number | null>();
    if (method === 'mean')
      for (const c of cols)
        means.set(
          c,
          aggregate(
            t.rows.map((r) => r[c]),
            'avg'
          )
        );
    const last = new Map<string, unknown>();
    const rows = t.rows.map((r) => {
      const out = { ...r };
      for (const c of cols) {
        if (!isBlank(out[c])) {
          last.set(c, out[c]);
          continue;
        }
        out[c] =
          method === 'previous'
            ? (last.get(c) ?? null)
            : method === 'zero'
              ? 0
              : method === 'mean'
                ? means.get(c)
                : String(cfg.fillValue ?? '');
      }
      return out;
    });
    return table(t, t.columns, rows);
  }),

  'tf.cast': one((cfg, t) => {
    const c = column(t, cfg.column, 'column');
    const to = CAST[String(cfg.toType)] ? String(cfg.toType) : 'text';
    let bad = 0;
    const rows = t.rows.map((r) => {
      const v = r[c];
      const res = coerce(v instanceof Date ? v.toISOString() : v, CAST[to], '.');
      const res2 =
        !res.ok && to !== 'text' && typeof v === 'string' ? coerce(v, CAST[to], ',') : res;
      if (!res2.ok) bad += 1;
      return { ...r, [c]: res2.ok ? res2.value : null };
    });
    const out = table(t, t.columns, rows, { [c]: CAST_FIELD[to] });
    if (bad)
      out.meta!.warnings = [
        ...(t.meta?.warnings ?? []),
        { key: 'wf.warn.castFailed', vars: { column: c, count: bad } },
      ];
    return out;
  }),

  'tf.cleanText': one((cfg, t) => {
    const cols = columns(
      t,
      cfg.columns,
      t.columns.filter((c) => t.rows.some((r) => typeof r[c] === 'string'))
    );
    const fix = (s: string) => {
      let v = s;
      if (cfg.trim !== false) v = v.trim();
      if (cfg.collapseSpaces !== false) v = v.replace(/\s+/g, ' ');
      if (cfg.textCase === 'upper') v = v.toUpperCase();
      else if (cfg.textCase === 'lower') v = v.toLowerCase();
      else if (cfg.textCase === 'title')
        v = v.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
      return v;
    };
    const rows = t.rows.map((r) => {
      const out = { ...r };
      for (const c of cols) if (typeof out[c] === 'string') out[c] = fix(out[c]);
      return out;
    });
    return table(t, t.columns, rows);
  }),

  'tf.split': one((cfg, t) => {
    const c = column(t, cfg.column, 'column');
    const names = listOf(cfg.newColumns);
    if (!names.length) throw new WorkflowError('wf.err.missingConfig', { field: 'newColumns' });
    const sep = String(cfg.separator ?? ',') || ',';
    const rows = t.rows.map((r) => {
      const parts = isBlank(r[c]) ? [] : String(r[c]).split(sep);
      const out = { ...r };
      names.forEach((n, i) => {
        // The last new column keeps the rest.
        const v = i === names.length - 1 ? parts.slice(i).join(sep) : parts[i];
        out[n] = v === undefined || v === '' ? null : v.trim();
      });
      return out;
    });
    const cols = [...t.columns.filter((x) => !names.includes(x)), ...names];
    return table(t, cols, rows, Object.fromEntries(names.map((n) => [n, 'text' as FieldType])));
  }),

  'tf.concat': one((cfg, t) => {
    const cols = columns(t, cfg.columns, []);
    if (!cols.length) throw new WorkflowError('wf.err.missingConfig', { field: 'columns' });
    const name = newName(cfg.newColumn, 'newColumn');
    const sep = String(cfg.separator ?? ' ');
    const rows = t.rows.map((r) => ({
      ...r,
      [name]: cols
        .map((c) => r[c])
        .filter((v) => !isBlank(v))
        .map(String)
        .join(sep),
    }));
    return table(t, [...t.columns.filter((c) => c !== name), name], rows, { [name]: 'text' });
  }),

  'tf.lookup': two((cfg, left, right) => {
    const k = column(left, cfg.key, 'key');
    const rk = column(right, cfg.lookupKey, 'lookupKey');
    const bring = columns(
      right,
      cfg.bring,
      right.columns.filter((c) => c !== rk)
    );
    const names = bringNames(left.columns, bring, 'lookup');
    const index = new Map<string, Row>();
    for (const r of right.rows) {
      const v = r[rk];
      if (!isBlank(v) && !index.has(String(v))) index.set(String(v), r);
    }
    const rows = left.rows.map((r) => {
      const hit = isBlank(r[k]) ? undefined : index.get(String(r[k]));
      const out = { ...r };
      for (const [c, n] of names) out[n] = hit ? (hit[c] ?? null) : null;
      return out;
    });
    const types: Record<string, FieldType | undefined> = {};
    for (const [c, n] of names) types[n] = right.meta?.columnTypes?.[c];
    return table(left, [...left.columns, ...names.values()], rows, types);
  }),

  'tf.fuzzyMatch': two((cfg, left, right) => {
    const mc = column(left, cfg.matchColumn, 'matchColumn');
    const cc = column(right, cfg.candidateColumn, 'candidateColumn');
    const threshold = Math.min(1, Math.max(0, Number(cfg.threshold ?? 0.8)));
    if (left.rows.length * right.rows.length > MATCH_LIMIT)
      throw new WorkflowError('wf.err.matchTooLarge', { max: MATCH_LIMIT });
    const bring = columns(right, cfg.bring, right.columns);
    const names = bringNames(left.columns, bring, 'match');
    const candidates = right.rows.map((r) => ({ row: r, norm: normalizeName(r[cc]) }));
    const exact = new Map<string, Row>();
    for (const c of candidates) if (c.norm && !exact.has(c.norm)) exact.set(c.norm, c.row);
    const rows = left.rows.map((r) => {
      const norm = normalizeName(r[mc]);
      let best: Row | null = norm ? (exact.get(norm) ?? null) : null;
      let score = best ? 1 : 0;
      if (!best && norm)
        for (const c of candidates) {
          const s = similarity(norm, c.norm);
          if (s > score) [score, best] = [s, c.row];
        }
      const ok = best && score >= threshold;
      const out: Row = { ...r };
      for (const [c, n] of names) out[n] = ok ? (best![c] ?? null) : null;
      out.match_score = ok ? round(score, 3) : null;
      return out;
    });
    const types: Record<string, FieldType | undefined> = { match_score: 'number' };
    for (const [c, n] of names) types[n] = right.meta?.columnTypes?.[c];
    return table(left, [...left.columns, ...names.values(), 'match_score'], rows, types);
  }),

  'tf.standardize': one((cfg, t) => {
    const c = column(t, cfg.column, 'column');
    const pairs = mappingOf(cfg.mapping);
    if (!pairs.length) throw new WorkflowError('wf.err.missingConfig', { field: 'mapping' });
    const map = new Map(pairs.map(([from, to]) => [from.toLowerCase(), to]));
    const rows = t.rows.map((r) => {
      if (isBlank(r[c])) return r;
      const to = map.get(String(r[c]).trim().toLowerCase());
      return { ...r, [c]: to ?? (cfg.unmatched === 'blank' ? null : r[c]) };
    });
    return table(t, t.columns, rows);
  }),

  'tf.pivot': one((cfg, t) => {
    const rk = column(t, cfg.rowKey, 'rowKey');
    const pc = column(t, cfg.pivotColumn, 'pivotColumn');
    const op = ['sum', 'avg', 'count', 'min', 'max'].includes(cfg.operation)
      ? cfg.operation
      : 'sum';
    const vc = op === 'count' && !cfg.valueColumn ? pc : column(t, cfg.valueColumn, 'valueColumn');
    const label = (v: unknown) => (isBlank(v) ? '(blank)' : String(v));
    const pivots: string[] = [];
    const groups = new Map<string, { key: unknown; cells: Map<string, unknown[]> }>();
    for (const r of t.rows) {
      const p = label(r[pc]);
      if (!pivots.includes(p)) {
        if (pivots.length >= PIVOT_LIMIT)
          throw new WorkflowError('wf.err.pivotTooWide', { max: PIVOT_LIMIT });
        pivots.push(p);
      }
      const g = String(r[rk] ?? '');
      if (!groups.has(g)) groups.set(g, { key: r[rk] ?? null, cells: new Map() });
      const cells = groups.get(g)!.cells;
      if (!cells.has(p)) cells.set(p, []);
      cells.get(p)!.push(r[vc]);
    }
    const names = pivots.map((p) => (p === rk ? `${p} (${op})` : p));
    const rows = [...groups.values()].map(({ key: k, cells }) =>
      Object.fromEntries([
        [rk, k],
        ...pivots.map((p, i) => [names[i], cells.has(p) ? aggregate(cells.get(p)!, op) : null]),
      ])
    );
    const types: Record<string, FieldType> = {};
    for (const n of names) types[n] = op === 'count' ? 'integer' : 'number';
    return table(t, [rk, ...names], rows, types);
  }),

  'tf.unpivot': one((cfg, t) => {
    const ids = columns(t, cfg.idColumns, []);
    const values = columns(
      t,
      cfg.valueColumns,
      t.columns.filter((c) => !ids.includes(c))
    );
    const nameCol = newName(cfg.nameColumn ?? 'field', 'nameColumn');
    const valueCol = newName(cfg.valueName ?? 'value', 'valueName');
    if (new Set([...ids, nameCol, valueCol]).size !== ids.length + 2)
      throw new WorkflowError('wf.err.duplicateColumn');
    const rows: Row[] = [];
    for (const r of t.rows)
      for (const c of values)
        rows.push({
          ...Object.fromEntries(ids.map((i) => [i, r[i]])),
          [nameCol]: c,
          [valueCol]: r[c] ?? null,
        });
    const vTypes = new Set(values.map((c) => t.meta?.columnTypes?.[c]));
    return table(t, [...ids, nameCol, valueCol], rows, {
      [nameCol]: 'text',
      [valueCol]: vTypes.size === 1 ? [...vTypes][0] : 'text',
    });
  }),

  'tf.window': one((cfg, t) => {
    const op = String(cfg.windowOp ?? 'running_sum');
    const needsValue = op !== 'row_number' && op !== 'running_count';
    const c = needsValue ? column(t, cfg.column, 'column') : '';
    const part = String(cfg.partitionBy ?? '').trim()
      ? column(t, cfg.partitionBy, 'partitionBy')
      : '';
    const ord = String(cfg.orderBy ?? '').trim() ? column(t, cfg.orderBy, 'orderBy') : '';
    const name = newName(cfg.newColumn, 'newColumn');
    const groups = new Map<string, number[]>();
    t.rows.forEach((r, i) => {
      const g = part ? String(r[part] ?? '') : '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(i);
    });
    const cmp = (a: unknown, b: unknown) => {
      const x = toNumber(a);
      const y = toNumber(b);
      if (x !== null && y !== null) return x - y;
      return String(a ?? '').localeCompare(String(b ?? ''));
    };
    const result = new Array<number | null | unknown>(t.rows.length).fill(null);
    for (const idx of groups.values()) {
      if (ord) idx.sort((a, b) => cmp(t.rows[a][ord], t.rows[b][ord]) || a - b);
      const vals = idx.map((i) => (needsValue ? toNumber(t.rows[i][c]) : null));
      if (op === 'rank') {
        const order = idx
          .map((i, k) => ({ i, v: vals[k] }))
          .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity));
        order.forEach((o, k) => {
          result[o.i] =
            o.v === null ? null : k > 0 && order[k - 1].v === o.v ? result[order[k - 1].i] : k + 1;
        });
        continue;
      }
      const total = op === 'percent_of_total' ? vals.reduce<number>((s, v) => s + (v ?? 0), 0) : 0;
      let running = 0;
      idx.forEach((i, k) => {
        const v = vals[k];
        if (op === 'running_sum') result[i] = round((running += v ?? 0));
        else if (op === 'running_count' || op === 'row_number') result[i] = k + 1;
        else if (op === 'previous') result[i] = k > 0 ? (t.rows[idx[k - 1]][c] ?? null) : null;
        else if (op === 'difference')
          result[i] = k > 0 && v !== null && vals[k - 1] !== null ? round(v - vals[k - 1]!) : null;
        else if (op === 'percent_of_total')
          result[i] = v === null || !total ? null : round((v / total) * 100, 4);
      });
    }
    const rows = t.rows.map((r, i) => ({ ...r, [name]: result[i] }));
    const ty: FieldType =
      op === 'previous'
        ? (t.meta?.columnTypes?.[c] ?? 'text')
        : op === 'rank' || op === 'row_number' || op === 'running_count'
          ? 'integer'
          : 'number';
    return table(t, [...t.columns.filter((x) => x !== name), name], rows, { [name]: ty });
  }),

  'tf.dateParts': one((cfg, t) => {
    const c = column(t, cfg.column, 'column');
    const part = String(cfg.datePart ?? 'month');
    const name = String(cfg.newColumn ?? '').trim() || `${c}_${part}`;
    const rows = t.rows.map((r) => {
      const d = toDay(r[c]);
      let v: number | string | null = null;
      if (d)
        v =
          part === 'year'
            ? d.getUTCFullYear()
            : part === 'quarter'
              ? Math.floor(d.getUTCMonth() / 3) + 1
              : part === 'week'
                ? isoWeek(d)
                : part === 'day'
                  ? d.getUTCDate()
                  : part === 'weekday'
                    ? d.getUTCDay() || 7
                    : part === 'year_month'
                      ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
                      : d.getUTCMonth() + 1;
      return { ...r, [name]: v };
    });
    return table(t, [...t.columns.filter((x) => x !== name), name], rows, {
      [name]: part === 'year_month' ? 'text' : 'integer',
    });
  }),

  'tf.dateDiff': one((cfg, t) => {
    const a = column(t, cfg.startColumn, 'startColumn');
    const b = column(t, cfg.endColumn, 'endColumn');
    const name = newName(cfg.newColumn, 'newColumn');
    const unit = String(cfg.diffUnit ?? 'days');
    const rows = t.rows.map((r) => {
      const s = toDay(r[a]);
      const e = toDay(r[b]);
      let v: number | null = null;
      if (s && e) {
        const days = Math.floor(
          (Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate()) -
            Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate())) /
            86_400_000
        );
        const months =
          (e.getUTCFullYear() - s.getUTCFullYear()) * 12 +
          (e.getUTCMonth() - s.getUTCMonth()) -
          (e.getUTCDate() < s.getUTCDate() ? 1 : 0);
        v =
          unit === 'weeks'
            ? Math.trunc(days / 7)
            : unit === 'months'
              ? months
              : unit === 'years'
                ? Math.trunc(months / 12)
                : days;
      }
      return { ...r, [name]: v };
    });
    return table(t, [...t.columns.filter((x) => x !== name), name], rows, { [name]: 'integer' });
  }),

  'an.profile': one((_cfg, t) => {
    const rows = t.columns.map((c) => {
      const values = t.rows.map((r) => r[c]);
      const present = values.filter((v) => !isBlank(v));
      const nums = present.map(toNumber);
      const allNumbers = present.length > 0 && nums.every((n) => n !== null);
      const days = allNumbers ? [] : present.map(toDay);
      const allDates = !allNumbers && present.length > 0 && days.every((d) => d !== null);
      const counts = new Map<string, number>();
      for (const v of present) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      let top: [string, number] | null = null;
      for (const e of counts) if (!top || e[1] > top[1]) top = e;
      let min: unknown = null;
      let max: unknown = null;
      if (allNumbers && nums.length) {
        min = Math.min(...(nums as number[]));
        max = Math.max(...(nums as number[]));
      } else if (allDates && days.length) {
        const ts = (days as Date[]).map((d) => d.getTime());
        min = new Date(Math.min(...ts)).toISOString().slice(0, 10);
        max = new Date(Math.max(...ts)).toISOString().slice(0, 10);
      } else if (present.length) {
        const sorted = present.map(String).sort((x, y) => x.localeCompare(y));
        min = sorted[0];
        max = sorted[sorted.length - 1];
      }
      return {
        column: c,
        type: t.meta?.columnTypes?.[c] ?? (allNumbers ? 'number' : allDates ? 'date' : 'text'),
        count: values.length,
        missing: values.length - present.length,
        missing_pct: values.length
          ? round(((values.length - present.length) / values.length) * 100, 2)
          : 0,
        distinct: counts.size,
        min: min === null ? null : String(min),
        max: max === null ? null : String(max),
        top_value: top ? top[0] : null,
        top_count: top ? top[1] : 0,
      };
    });
    return {
      columns: PROFILE_COLUMNS.map((c) => c.name),
      rows,
      meta: {
        count: rows.length,
        fetchedAt: t.meta?.fetchedAt,
        columnTypes: Object.fromEntries(PROFILE_COLUMNS.map((c) => [c.name, c.type!])),
      },
    };
  }),

  'tf.rules': {
    inputs: 1,
    outputs: RULE_HANDLES,
    run: async (cfg, [input]) => {
      const t = need(input);
      const required = columns(t, cfg.requiredColumns, []);
      const numeric = columns(t, cfg.numericColumns, []);
      const dates = columns(t, cfg.dateColumns, []);
      const unique = columns(t, cfg.uniqueKey, []);
      const range = String(cfg.rangeColumn ?? '').trim()
        ? column(t, cfg.rangeColumn, 'rangeColumn')
        : '';
      const min = String(cfg.min ?? '').trim() === '' ? null : toNumber(cfg.min);
      const max = String(cfg.max ?? '').trim() === '' ? null : toNumber(cfg.max);
      const allowedCol = String(cfg.allowedColumn ?? '').trim()
        ? column(t, cfg.allowedColumn, 'allowedColumn')
        : '';
      const allowed = new Set(listOf(cfg.allowedValues).map((v) => v.toLowerCase()));
      const seen = new Set<string>();
      const valid: Row[] = [];
      const invalid: Row[] = [];
      for (const r of t.rows) {
        let reason: string | null = null;
        for (const c of required) if (!reason && isBlank(r[c])) reason = `missing:${c}`;
        for (const c of numeric)
          if (!reason && !isBlank(r[c]) && toNumber(r[c]) === null) reason = `not_number:${c}`;
        for (const c of dates)
          if (!reason && !isBlank(r[c]) && !toDay(r[c])) reason = `not_date:${c}`;
        if (!reason && range && !isBlank(r[range])) {
          const v = toNumber(r[range]);
          if (v === null || (min !== null && v < min) || (max !== null && v > max))
            reason = `out_of_range:${range}`;
        }
        if (
          !reason &&
          allowedCol &&
          allowed.size &&
          !isBlank(r[allowedCol]) &&
          !allowed.has(String(r[allowedCol]).trim().toLowerCase())
        )
          reason = `not_allowed:${allowedCol}`;
        if (!reason && unique.length) {
          const k = key(r, unique);
          if (seen.has(k)) reason = `duplicate:${unique.join('+')}`;
          seen.add(k);
        }
        if (reason) invalid.push({ ...r, _reason: reason });
        else valid.push(r);
      }
      return {
        valid: table(t, t.columns, valid),
        invalid: table(t, [...t.columns, '_reason'], invalid, { _reason: 'text' }),
      };
    },
  },

  'an.outliers': one((cfg, t) => {
    const c = column(t, cfg.column, 'column');
    const method = cfg.outlierMethod === 'zscore' ? 'zscore' : 'iqr';
    const k = Number(cfg.threshold) > 0 ? Number(cfg.threshold) : method === 'iqr' ? 1.5 : 3;
    const vals = t.rows.map((r) => toNumber(r[c]));
    const nums = vals.filter((v): v is number => v !== null).sort((a, b) => a - b);
    const q = (p: number) => {
      if (!nums.length) return 0;
      const pos = (nums.length - 1) * p;
      const lo = Math.floor(pos);
      return nums[lo] + (nums[Math.min(lo + 1, nums.length - 1)] - nums[lo]) * (pos - lo);
    };
    const mean = nums.reduce((s, v) => s + v, 0) / (nums.length || 1);
    const sd = Math.sqrt(
      nums.reduce((s, v) => s + (v - mean) ** 2, 0) / (nums.length > 1 ? nums.length - 1 : 1)
    );
    const [q1, q3] = [q(0.25), q(0.75)];
    const iqr = q3 - q1;
    const rows = t.rows.map((r, i) => {
      const v = vals[i];
      if (v === null) return { ...r, is_outlier: null, outlier_score: null };
      const score =
        method === 'iqr'
          ? iqr
            ? v < q1
              ? (q1 - v) / iqr
              : v > q3
                ? (v - q3) / iqr
                : 0
            : 0
          : sd
            ? Math.abs(v - mean) / sd
            : 0;
      return { ...r, is_outlier: score > k, outlier_score: round(score, 3) };
    });
    return table(
      t,
      [
        ...t.columns.filter((x) => x !== 'is_outlier' && x !== 'outlier_score'),
        'is_outlier',
        'outlier_score',
      ],
      rows,
      {
        is_outlier: 'boolean',
        outlier_score: 'number',
      }
    );
  }),
};

const PROFILE_COLUMNS: SchemaColumn[] = [
  { name: 'column', type: 'text' },
  { name: 'type', type: 'text' },
  { name: 'count', type: 'integer' },
  { name: 'missing', type: 'integer' },
  { name: 'missing_pct', type: 'number' },
  { name: 'distinct', type: 'integer' },
  { name: 'min', type: 'text' },
  { name: 'max', type: 'text' },
  { name: 'top_value', type: 'text' },
  { name: 'top_count', type: 'integer' },
];

// ─── Output columns, for the editor (before running) ─────────────────────────

/** Output columns of a node of this module, or undefined when it is not one. */
export function unifySchema(
  type: string,
  cfg: any,
  inputs: Schema[]
): Record<string, Schema> | undefined {
  if (!(type in UNIFY_RUNTIME)) return undefined;
  const [input, right] = inputs;
  const add = (cols: Schema, extra: SchemaColumn[]): Schema =>
    cols && [...cols.filter((c) => !extra.some((e) => e.name === c.name)), ...extra];
  const retype = (cols: Schema, name: string, ty: FieldType): Schema =>
    cols && cols.map((c) => (c.name === name ? { name: c.name, type: ty } : c));
  const brought = (prefix: string, bring: string[], pool: Schema): SchemaColumn[] => {
    if (!input || !pool) return [];
    const cols = bring.length ? pool.filter((c) => bring.includes(c.name)) : pool;
    const names = bringNames(
      input.map((c) => c.name),
      cols.map((c) => c.name),
      prefix
    );
    return cols.map((c) => ({ name: names.get(c.name)!, type: c.type }));
  };
  const name = (v: unknown) => String(v ?? '').trim();
  switch (type) {
    case 'tf.union': {
      if (!input || !right) return { out: null };
      const cols: SchemaColumn[] = [...input];
      for (const c of right) {
        const at = cols.findIndex((x) => x.name === c.name);
        if (at < 0) cols.push({ name: c.name, type: c.type });
        else if (cols[at].type !== c.type) cols[at] = { name: c.name, type: 'text' };
      }
      const src = name(cfg.sourceColumn);
      return { out: src ? add(cols, [{ name: src, type: 'text' }]) : cols };
    }
    case 'tf.dedupe':
    case 'tf.fillMissing':
    case 'tf.cleanText':
    case 'tf.standardize':
      return { out: input };
    case 'tf.cast':
      return { out: retype(input, name(cfg.column), CAST_FIELD[String(cfg.toType)] ?? 'text') };
    case 'tf.split':
      return {
        out: add(
          input,
          listOf(cfg.newColumns).map((n) => ({ name: n, type: 'text' as FieldType }))
        ),
      };
    case 'tf.concat':
      return {
        out: name(cfg.newColumn)
          ? add(input, [{ name: name(cfg.newColumn), type: 'text' }])
          : input,
      };
    case 'tf.lookup': {
      const pool = right ? right.filter((c) => c.name !== name(cfg.lookupKey)) : null;
      return {
        out: input && right ? [...input, ...brought('lookup', listOf(cfg.bring), pool)] : null,
      };
    }
    case 'tf.fuzzyMatch':
      return {
        out:
          input && right
            ? [
                ...input,
                ...brought('match', listOf(cfg.bring), right),
                { name: 'match_score', type: 'number' },
              ]
            : null,
      };
    case 'tf.pivot':
      // The new columns are the values found when it runs.
      return { out: null };
    case 'tf.unpivot': {
      if (!input) return { out: null };
      const ids = listOf(cfg.idColumns);
      return {
        out: [
          ...input.filter((c) => ids.includes(c.name)),
          { name: name(cfg.nameColumn) || 'field', type: 'text' },
          { name: name(cfg.valueName) || 'value' },
        ],
      };
    }
    case 'tf.window': {
      const op = String(cfg.windowOp ?? 'running_sum');
      const ty: FieldType | undefined =
        op === 'previous'
          ? input?.find((c) => c.name === name(cfg.column))?.type
          : op === 'rank' || op === 'row_number' || op === 'running_count'
            ? 'integer'
            : 'number';
      return {
        out: name(cfg.newColumn) ? add(input, [{ name: name(cfg.newColumn), type: ty }]) : input,
      };
    }
    case 'tf.dateParts': {
      const col =
        name(cfg.newColumn) ||
        (name(cfg.column) ? `${name(cfg.column)}_${cfg.datePart ?? 'month'}` : '');
      return {
        out: col
          ? add(input, [{ name: col, type: cfg.datePart === 'year_month' ? 'text' : 'integer' }])
          : input,
      };
    }
    case 'tf.dateDiff':
      return {
        out: name(cfg.newColumn)
          ? add(input, [{ name: name(cfg.newColumn), type: 'integer' }])
          : input,
      };
    case 'an.profile':
      return { out: PROFILE_COLUMNS };
    case 'tf.rules':
      return { valid: input, invalid: add(input, [{ name: '_reason', type: 'text' }]) };
    case 'an.outliers':
      return {
        out: add(input, [
          { name: 'is_outlier', type: 'boolean' },
          { name: 'outlier_score', type: 'number' },
        ]),
      };
    default:
      return { out: input };
  }
}
