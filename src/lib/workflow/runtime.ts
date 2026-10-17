import { CATALOG, getField, type EntityKey, type FieldType } from '@/lib/analytics/catalog';
import {
  QUERY_LIMITS,
  validateQuery,
  type QueryFilter,
  type QueryResult,
  type QuerySpec,
} from '@/lib/analytics/query';
import {
  SUMMARY_LIMITS,
  validateSummary,
  type SummaryResult,
  type SummarySpec,
} from '@/lib/analytics/summary';
import { ExpressionError, evaluate, parseExpression, type Expr } from '@/lib/analytics/expression';
import { joinTables, type JoinType } from '@/lib/analytics/join';
import {
  computeMean,
  computeMedian,
  computePercentile,
  computeStdDev,
} from '@/lib/stats/stats-helpers';
import { fitDistribution } from '@/lib/stats/fitting';
import type { ColumnLineage, DataTable, DataWarning } from './types';
import { WorkflowError } from './errors';
import { UNIFY_RUNTIME } from './unifyNodes';

export interface DatasetReadSpec {
  datasetId: string;
  limit: number;
}

export type DatasetWriteMode = 'append' | 'upsert' | 'replace';

export type ErpListTarget = 'customers' | 'suppliers' | 'products';
export type ErpWriteMode = 'add_new' | 'add_or_update';
export const ERP_LIST_TARGETS: readonly ErpListTarget[] = ['customers', 'suppliers', 'products'];
export const ERP_WRITE_MODES: readonly ErpWriteMode[] = ['add_new', 'add_or_update'];

export interface RuntimeContext {
  /**
   * ERP rows. `erp`: a linked ERP (a Terminal on its own reads ERPs it is
   * linked to); none: the pipeline's own workspace.
   */
  query: (spec: QuerySpec, erp?: string | null) => Promise<QueryResult>;
  summarize?: (spec: SummarySpec, erp?: string | null) => Promise<SummaryResult>;
  /** Only background runs add to ERP lists; runs in the editor show what would be written. */
  writeErpList?: (
    spec: { erpId: string | null; list: ErpListTarget; mode: ErpWriteMode },
    table: DataTable
  ) => Promise<{ added: number; updated: number; skipped: number; rejected: number }>;
  /** Terminal datasets: read in the editor and in background runs. */
  readDataset?: (spec: DatasetReadSpec) => Promise<DataTable>;
  /** Only background runs (the worker) write; runs in the editor show what would be written. */
  writeDataset?: (
    spec: { datasetId: string; mode: DatasetWriteMode },
    table: DataTable
  ) => Promise<{ written: number; rejected: number }>;
}

export const DATASET_READ_LIMIT = 100_000;
export const DATASET_WRITE_MODES: readonly DatasetWriteMode[] = ['append', 'upsert', 'replace'];

export type NodeOutput = DataTable | Record<string, DataTable>;

export interface NodeRuntime {
  inputs: number;
  outputs: readonly string[];
  run: (cfg: any, inputs: DataTable[], ctx: RuntimeContext) => Promise<NodeOutput>;
}

export const SINGLE = ['out'] as const;
export const BRANCH_HANDLES = ['match', 'else'] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const listOf = (value: unknown): string[] =>
  String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function renameMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of listOf(value)) {
    const i = pair.indexOf(':');
    if (i > 0 && pair.slice(i + 1).trim()) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

function requireInput(input: DataTable | undefined): DataTable {
  if (!input) throw new WorkflowError('wf.err.noInput');
  return input;
}

function requireColumn(input: DataTable, column: string) {
  if (!input.columns.includes(column)) throw new WorkflowError('wf.err.unknownColumn', { column });
}

function withRows(
  input: DataTable,
  rows: Record<string, any>[],
  extra: Partial<NonNullable<DataTable['meta']>> = {}
): DataTable {
  return { ...input, rows, meta: { ...input.meta, ...extra, count: rows.length } };
}

const COMPARE_OPS = ['=', '!=', '>', '>=', '<', '<=', 'contains'] as const;

function compare(a: unknown, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a !== null && a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

export function matches(v: unknown, operator: string, value: string): boolean {
  switch (operator) {
    case '=':
      return String(v ?? '') === String(value);
    case '!=':
      return String(v ?? '') !== String(value);
    case '>':
      return compare(v, value) > 0;
    case '>=':
      return compare(v, value) >= 0;
    case '<':
      return compare(v, value) < 0;
    case '<=':
      return compare(v, value) <= 0;
    case 'contains':
      return String(v ?? '')
        .toLowerCase()
        .includes(String(value).toLowerCase());
    default:
      return true;
  }
}

const isPresent = (v: unknown) => v !== null && v !== '' && v !== undefined;
const tidy = (n: number) => Number(n.toPrecision(15));

export function aggregate(values: unknown[], operation: string, money = false): number | null {
  const present = values.filter(isPresent);
  if (operation === 'count') return present.length;
  const nums = present.map(Number).filter((v) => Number.isFinite(v));
  switch (operation) {
    case 'sum':
      return money
        ? nums.reduce((s, v) => s + Math.round(v * 100), 0) / 100
        : tidy(nums.reduce((s, v) => s + v, 0));
    case 'avg':
      return nums.length ? tidy(nums.reduce((s, v) => s + v, 0) / nums.length) : null;
    case 'min':
      return nums.length ? nums.reduce((a, b) => Math.min(a, b)) : null;
    case 'max':
      return nums.length ? nums.reduce((a, b) => Math.max(a, b)) : null;
    default:
      throw new WorkflowError('wf.err.invalidOption', { value: operation });
  }
}

const numbersOf = (rows: Record<string, any>[], column: string) =>
  rows
    .map((r) => r[column])
    .filter(isPresent)
    .map(Number)
    .filter((v) => !Number.isNaN(v));

function currencyColumnFor(table: DataTable, column: string): string | null | undefined {
  const origin = table.meta?.lineage?.[column];
  if (!origin?.field || origin.op === 'count' || origin.op === 'countDistinct') return undefined;
  if (getField(origin.entity, origin.field)?.currency !== 'document') return undefined;
  const match = table.columns.find((c) => {
    const l = table.meta?.lineage?.[c];
    return (
      l &&
      !l.op &&
      l.entity === origin.entity &&
      l.field === 'currency' &&
      (l.relation ?? '') === (origin.relation ?? '')
    );
  });
  return match ?? null;
}

function measureGroups(
  table: DataTable,
  groups: Record<string, any>[][],
  column: string,
  operation: string
) {
  if ((operation === 'sum' || operation === 'avg') && table.meta?.repeated?.includes(column)) {
    throw new WorkflowError('wf.err.repeatedValues', { column });
  }
  const money = table.meta?.columnTypes?.[column] === 'money';
  const currency = operation === 'count' ? undefined : currencyColumnFor(table, column);
  let mixed = 0;
  const values = groups.map((rows) => {
    if (currency) {
      const currencies = new Set(
        rows.filter((r) => isPresent(r[column])).map((r) => r[currency] ?? '')
      );
      if (currencies.size > 1) {
        mixed++;
        return null;
      }
    }
    return aggregate(
      rows.map((r) => r[column]),
      operation,
      money
    );
  });
  const warnings: DataWarning[] = [];
  if (currency === null) warnings.push({ key: 'wf.notice.currencyUnchecked', vars: { column } });
  if (mixed) warnings.push({ key: 'wf.notice.mixedCurrency', vars: { count: mixed, column } });
  const partial = Boolean(table.meta?.truncated || table.meta?.partial);
  if (partial)
    warnings.push({ key: 'wf.notice.partialTotals', vars: { count: table.rows.length } });
  return { values, warnings, partial };
}

function groupRows(
  rows: Record<string, any>[],
  column: string
): Map<string, Record<string, any>[]> {
  const groups = new Map<string, Record<string, any>[]>();
  for (const r of rows) {
    const k = String(r[column] ?? '');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return groups;
}

function carryColumns(meta: DataTable['meta'], pairs: [string, string][]) {
  const lineage: Record<string, ColumnLineage> = {};
  const repeated: string[] = [];
  for (const [from, to] of pairs) {
    const origin = meta?.lineage?.[from];
    if (origin) lineage[to] = origin;
    if (meta?.repeated?.includes(from)) repeated.push(to);
  }
  return { lineage, repeated };
}

export function variablesOf(expr: Expr, out = new Set<string>()): Set<string> {
  switch (expr.kind) {
    case 'var':
      out.add(expr.name);
      break;
    case 'neg':
      variablesOf(expr.arg, out);
      break;
    case 'bin':
      variablesOf(expr.left, out);
      variablesOf(expr.right, out);
      break;
    case 'call':
      expr.args.forEach((a) => variablesOf(a, out));
      break;
    default:
      break;
  }
  return out;
}

function withComputedColumn(
  meta: DataTable['meta'],
  column: string,
  rows: number,
  reads: Set<string>
): DataTable['meta'] {
  const lineage = { ...meta?.lineage };
  delete lineage[column];
  const repeated = (meta?.repeated ?? []).filter((c) => c !== column);
  if ([...reads].some((c) => meta?.repeated?.includes(c))) repeated.push(column);
  return {
    ...meta,
    count: rows,
    columnTypes: { ...meta?.columnTypes, [column]: 'number' },
    lineage,
    repeated,
  };
}

function parseFormula(formula: unknown, variables: readonly string[]) {
  try {
    return parseExpression(String(formula ?? ''), variables);
  } catch (e) {
    throw new WorkflowError('wf.err.formula', {
      detail: e instanceof ExpressionError ? e.detail || e.code : '',
    });
  }
}

// ─── ERP sources ──────────────────────────────────────────────────────────────

export interface ErpSourceConfig {
  entity: EntityKey;
  fields: string[];
  related: { relation: string; fields: string[] }[];
  filters: QueryFilter[];
  sort?: { field: string; direction: 'asc' | 'desc' } | null;
  limit: number;
  /** A linked ERP to read from (a Terminal on its own); empty: the pipeline's workspace. */
  erpId?: string;
}

export function erpSourceSpec(cfg: ErpSourceConfig): QuerySpec {
  return {
    entity: cfg.entity,
    fields: cfg.fields ?? [],
    related: (cfg.related ?? []).filter((r) => r.fields?.length),
    filters: cfg.filters ?? [],
    sort: cfg.sort ?? undefined,
    limit: cfg.limit ?? QUERY_LIMITS.defaultRows,
  };
}

export function fromQueryResult(result: QueryResult): DataTable {
  const warnings: DataWarning[] = [];
  const { truncated, rowCount, quality } = result.meta;
  if (truncated) warnings.push({ key: 'cat.notice.truncated', vars: { count: rowCount } });
  if (quality.relationMismatches)
    warnings.push({ key: 'cat.notice.mismatch', vars: { count: quality.relationMismatches } });
  if (quality.unresolvedRelations)
    warnings.push({ key: 'cat.notice.unresolved', vars: { count: quality.unresolvedRelations } });
  return {
    columns: result.columns.map((c) => c.name),
    rows: result.rows as Record<string, any>[],
    meta: {
      source: result.meta.entity,
      count: rowCount,
      fetchedAt: result.meta.fetchedAt,
      columnTypes: Object.fromEntries(result.columns.map((c) => [c.name, c.type])),
      lineage: Object.fromEntries(result.columns.map((c) => [c.name, lineageOf(c)])),
      // A related record's fields repeat on each of its base rows.
      repeated: result.columns.filter((c) => c.relation).map((c) => c.name),
      ...(truncated ? { truncated: true } : {}),
      warnings,
    },
  };
}

const lineageOf = (c: {
  entity: EntityKey;
  field?: string;
  relation?: string;
  op?: string;
  bucket?: string;
}): ColumnLineage =>
  Object.fromEntries(
    Object.entries({
      entity: c.entity,
      field: c.field,
      relation: c.relation,
      op: c.op,
      bucket: c.bucket,
    }).filter(([, v]) => v !== undefined)
  ) as unknown as ColumnLineage;

const SUMMARY_CODES = new Set([
  'tooManyGroups',
  'tooManyMeasures',
  'invalidGroupField',
  'invalidBucket',
  'invalidMeasure',
  'repeatedMeasure',
  'duplicateColumn',
  'invalidLimit',
  'currencyGroupRequired',
]);
export const summaryErrorKey = (code: string) =>
  SUMMARY_CODES.has(code) ? `sum.err.${code}` : `cat.err.${code}`;

export function fromSummaryResult(spec: SummarySpec, result: SummaryResult): DataTable {
  const warnings: DataWarning[] = [];
  if (result.truncated) warnings.push({ key: 'sum.notice.truncated', vars: { count: spec.limit } });
  if (result.mixedCurrencyRows)
    warnings.push({ key: 'sum.notice.mixedCurrency', vars: { count: result.mixedCurrencyRows } });
  if (result.unresolvedRelations)
    warnings.push({ key: 'cat.notice.unresolved', vars: { count: result.unresolvedRelations } });
  return {
    columns: result.columns.map((c) => c.name),
    rows: result.rows as Record<string, any>[],
    meta: {
      source: spec.entity,
      count: result.rows.length,
      fetchedAt: result.fetchedAt,
      columnTypes: Object.fromEntries(result.columns.map((c) => [c.name, c.type])),
      lineage: Object.fromEntries(result.columns.map((c) => [c.name, lineageOf(c)])),
      repeated: [],
      // Rows beyond the limit are missing: totals over this table would be partial.
      ...(result.truncated ? { truncated: true } : {}),
      summary: { entity: spec.entity, recordCount: result.recordCount },
      warnings,
    },
  };
}

export function summarySpecOf(cfg: any): unknown {
  return {
    entity: cfg?.entity,
    groupBy: cfg?.groupBy ?? [],
    measures: cfg?.measures ?? [],
    filters: cfg?.filters ?? [],
    includeInactive: cfg?.includeInactive === true,
    sort: cfg?.sort ?? null,
    limit: cfg?.limit ?? SUMMARY_LIMITS.defaultRows,
  };
}

const erpOf = (cfg: any): string | null =>
  typeof cfg?.erpId === 'string' && cfg.erpId ? cfg.erpId : null;

async function runQuery(
  spec: QuerySpec,
  ctx: RuntimeContext,
  erp: string | null = null
): Promise<DataTable> {
  const validation = validateQuery(spec);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new WorkflowError(`cat.err.${first.code}`, {
      detail: first.detail ?? '',
      max: first.code === 'tooManyFields' ? QUERY_LIMITS.maxFields : QUERY_LIMITS.maxRows,
    });
  }
  return fromQueryResult(await ctx.query(validation.spec, erp));
}

export const LEGACY_SOURCES: Record<string, EntityKey> = {
  'src.customers': 'customers',
  'src.suppliers': 'suppliers',
  'src.products': 'products',
  'src.invoices': 'invoices',
  'src.payments': 'payments',
  'src.transactions': 'transactions',
  'src.inventory': 'products',
  'src.salesOrders': 'salesOrders',
  'src.purchaseOrders': 'purchaseOrders',
};

export function legacySourceSpec(entity: EntityKey, selectedId?: string): QuerySpec {
  return {
    entity,
    fields: CATALOG[entity].fields.filter((f) => f.calculated !== 'engine').map((f) => f.key),
    filters: selectedId ? [{ field: 'id', op: 'eq', value: selectedId }] : [],
    limit: QUERY_LIMITS.maxRows,
  };
}

// ─── Data quality ─────────────────────────────────────────────────────────────

export interface QualityReport {
  checkedRows: number;
  invalidRows: number;
  missingRequired: number;
  invalidType: number;
  duplicateKeys: number;
  failedRelationships: number;
}

export interface QualityIssue {
  row: number;
  column: string;
  problem: 'missing' | 'type' | 'duplicate';
}

const MAX_ISSUES = 100;
const isBlank = (v: unknown) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const isDateLike = (v: unknown) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));

export function checkQuality(
  input: DataTable,
  cfg: {
    requiredColumns?: string;
    numericColumns?: string;
    dateColumns?: string;
    uniqueKey?: string;
  }
): { report: QualityReport; issues: QualityIssue[]; invalid: Set<number> } {
  const required = listOf(cfg.requiredColumns);
  const numeric = listOf(cfg.numericColumns);
  const dates = listOf(cfg.dateColumns);
  const key = String(cfg.uniqueKey ?? '').trim();
  for (const column of [...required, ...numeric, ...dates, ...(key ? [key] : [])])
    requireColumn(input, column);

  const report: QualityReport = {
    checkedRows: input.rows.length,
    invalidRows: 0,
    missingRequired: 0,
    invalidType: 0,
    duplicateKeys: 0,
    failedRelationships: 0,
  };
  const issues: QualityIssue[] = [];
  const invalid = new Set<number>();
  const flag = (row: number, column: string, problem: QualityIssue['problem']) => {
    invalid.add(row);
    if (issues.length < MAX_ISSUES) issues.push({ row, column, problem });
  };
  const seen = new Map<string, number>();

  input.rows.forEach((r, i) => {
    for (const c of required)
      if (isBlank(r[c])) {
        report.missingRequired++;
        flag(i, c, 'missing');
      }
    for (const c of numeric)
      if (!isBlank(r[c]) && Number.isNaN(Number(r[c]))) {
        report.invalidType++;
        flag(i, c, 'type');
      }
    for (const c of dates)
      if (!isBlank(r[c]) && !isDateLike(r[c])) {
        report.invalidType++;
        flag(i, c, 'type');
      }
    if (key && !isBlank(r[key])) {
      const k = String(r[key]);
      if (seen.has(k)) {
        report.duplicateKeys++;
        flag(i, key, 'duplicate');
      } else seen.set(k, i);
    }
  });
  // Links the ERP source could not resolve are counted from its notices.
  for (const w of input.meta?.warnings ?? []) {
    if (w.key === 'cat.notice.unresolved' || w.key === 'cat.notice.mismatch')
      report.failedRelationships += Number(w.vars?.count ?? 0);
  }
  report.invalidRows = invalid.size;
  return { report, issues, invalid };
}

// ─── Nodes ────────────────────────────────────────────────────────────────────

const source = (run: NodeRuntime['run']): NodeRuntime => ({ inputs: 0, outputs: SINGLE, run });
const transform = (run: NodeRuntime['run'], inputs = 1): NodeRuntime => ({
  inputs,
  outputs: SINGLE,
  run,
});
const output = (run: NodeRuntime['run']): NodeRuntime => ({ inputs: 1, outputs: [], run });

export const RUNTIME: Record<string, NodeRuntime> = {
  'src.erp': source(async (cfg: ErpSourceConfig, _in, ctx) =>
    runQuery(erpSourceSpec(cfg), ctx, erpOf(cfg))
  ),

  // Grouped totals computed by the database over every matching record.
  'src.erpSummary': source(async (cfg, _in, ctx) => {
    const validation = validateSummary(summarySpecOf(cfg));
    if (!validation.ok) {
      const first = validation.errors[0];
      throw new WorkflowError(summaryErrorKey(first.code), {
        detail: first.detail ?? '',
        max: SUMMARY_LIMITS.maxRows,
      });
    }
    if (!ctx.summarize) throw new WorkflowError('wf.err.summaryUnavailable');
    return fromSummaryResult(validation.spec, await ctx.summarize(validation.spec, erpOf(cfg)));
  }),
  ...Object.fromEntries(
    Object.entries(LEGACY_SOURCES).map(([type, entity]) => [
      type,
      source(async (cfg, _in, ctx) =>
        runQuery(legacySourceSpec(entity, cfg.selectedId || undefined), ctx, erpOf(cfg))
      ),
    ])
  ),

  'tf.filter': transform(async (cfg, [input]) => {
    const table = requireInput(input);
    const { column, operator, value } = cfg;
    if (!column) return table;
    requireColumn(table, column);
    return withRows(
      table,
      table.rows.filter((r) => matches(r[column], operator, value))
    );
  }),

  'tf.sort': transform(async (cfg, [input]) => {
    const table = requireInput(input);
    const { column, direction } = cfg;
    if (!column) return table;
    requireColumn(table, column);
    const rows = [...table.rows].sort((a, b) => {
      const r = compare(a[column], String(b[column] ?? ''));
      return direction === 'desc' ? -r : r;
    });
    return withRows(table, rows);
  }),

  'tf.limit': transform(async (cfg, [input]) => {
    const table = requireInput(input);
    return withRows(table, table.rows.slice(0, Math.max(0, Number(cfg.n) || 100)));
  }),

  'tf.aggregate': transform(async (cfg, [input]) => {
    const table = requireInput(input);
    const { groupBy, aggregateColumn, operation } = cfg;
    if (!groupBy || !aggregateColumn) return table;
    requireColumn(table, groupBy);
    requireColumn(table, aggregateColumn);
    const groups = [...groupRows(table.rows, groupBy)];
    const measured = measureGroups(
      table,
      groups.map(([, members]) => members),
      aggregateColumn,
      operation
    );
    const valueColumn = `${operation}_${aggregateColumn}`;
    const rows = groups.map(([k, members], i) => ({
      [groupBy]: k,
      [valueColumn]: measured.values[i],
      record_count: members.length,
    }));
    const origin = table.meta?.lineage?.[aggregateColumn];
    return {
      columns: [groupBy, valueColumn, 'record_count'],
      rows,
      meta: {
        count: rows.length,
        fetchedAt: table.meta?.fetchedAt,
        warnings: [...(table.meta?.warnings ?? []), ...measured.warnings],
        columnTypes: {
          [groupBy]: table.meta?.columnTypes?.[groupBy] ?? 'text',
          [valueColumn]:
            operation === 'count'
              ? 'integer'
              : table.meta?.columnTypes?.[aggregateColumn] === 'money' && operation !== 'avg'
                ? 'money'
                : 'number',
          record_count: 'integer',
        },
        lineage: {
          ...carryColumns(table.meta, [[groupBy, groupBy]]).lineage,
          ...(origin && operation !== 'count'
            ? { [valueColumn]: { ...origin, op: operation } }
            : {}),
        },
        repeated: [],
        ...(measured.partial ? { partial: true } : {}),
      },
    };
  }),

  'tf.mapColumn': transform(async (cfg, [input]) => {
    const table = requireInput(input);
    const { newColumn, colA, colB, formula } = cfg;
    // Formulas are parsed as arithmetic only; they are never run as code.
    const expr = parseFormula(formula, ['a', 'b']);
    const rows = table.rows.map((r) => ({
      ...r,
      [newColumn]: evaluate(expr, { a: Number(r[colA]) || 0, b: Number(r[colB]) || 0 }),
    }));
    return {
      columns: [...new Set([...table.columns, newColumn])],
      rows,
      meta: withComputedColumn(table.meta, newColumn, rows.length, new Set([colA, colB])),
    };
  }),

  'tf.calc': transform(async (cfg, [input]) => {
    const table = requireInput(input);
    const newColumn = String(cfg.newColumn ?? '').trim();
    if (!newColumn) throw new WorkflowError('wf.err.missingConfig', { field: 'newColumn' });
    const expr = parseFormula(cfg.formula, table.columns);
    const rows = table.rows.map((r) => {
      const vars: Record<string, number> = {};
      for (const c of table.columns) vars[c] = r[c] === null || r[c] === '' ? NaN : Number(r[c]);
      return { ...r, [newColumn]: evaluate(expr, vars) };
    });
    return {
      columns: [...new Set([...table.columns, newColumn])],
      rows,
      meta: withComputedColumn(table.meta, newColumn, rows.length, variablesOf(expr)),
    };
  }),

  'tf.select': transform(async (cfg, [input]) => {
    const table = requireInput(input);
    const keep = listOf(cfg.columns);
    const rename = renameMap(cfg.rename);
    const chosen = keep.length ? keep : table.columns;
    for (const c of [...chosen, ...Object.keys(rename)]) requireColumn(table, c);
    const names = chosen.map((c) => rename[c] ?? c);
    if (new Set(names).size !== names.length) throw new WorkflowError('wf.err.duplicateColumn');
    const rows = table.rows.map((r) => Object.fromEntries(chosen.map((c, i) => [names[i], r[c]])));
    const types: Record<string, FieldType> = {};
    chosen.forEach((c, i) => {
      const ty = table.meta?.columnTypes?.[c];
      if (ty) types[names[i]] = ty;
    });
    const carried = carryColumns(
      table.meta,
      chosen.map((c, i) => [c, names[i]])
    );
    return {
      columns: names,
      rows,
      meta: { ...table.meta, count: rows.length, columnTypes: types, ...carried },
    };
  }),

  'tf.join': transform(async (cfg, [left, right]) => {
    if (!left || !right) throw new WorkflowError('wf.err.needTwoInputs');
    return joinTables(left, right, {
      leftKey: cfg.leftKey,
      rightKey: cfg.rightKey,
      joinType: cfg.joinType as JoinType,
    });
  }, 2),

  'tf.validate': transform(async (cfg, [input]) => {
    const table = requireInput(input);
    const { report, issues, invalid } = checkQuality(table, cfg);
    const rows =
      cfg.action === 'exclude' ? table.rows.filter((_, i) => !invalid.has(i)) : table.rows;
    return withRows(table, rows, { quality: report, issues });
  }),

  'tf.branch': {
    inputs: 1,
    outputs: BRANCH_HANDLES,
    run: async (cfg, [input]) => {
      const table = requireInput(input);
      const { column, operator, value } = cfg;
      if (!column) throw new WorkflowError('wf.err.missingConfig', { field: 'column' });
      requireColumn(table, column);
      const yes: Record<string, any>[] = [];
      const no: Record<string, any>[] = [];
      for (const r of table.rows) (matches(r[column], operator, value) ? yes : no).push(r);
      return { match: withRows(table, yes), else: withRows(table, no) };
    },
  },

  'an.describe': transform(async (cfg, [input]) => {
    const table = requireInput(input);
    const { column } = cfg;
    if (!column) throw new WorkflowError('wf.err.pickColumnDescribe');
    requireColumn(table, column);
    // Statistics of a parent's value repeated per row would weight it by its row count.
    if (table.meta?.repeated?.includes(column))
      throw new WorkflowError('wf.err.repeatedValues', { column });
    const vals = numbersOf(table.rows, column);
    if (!vals.length) throw new WorkflowError('wf.err.noNumericColumn', { column });
    const stats = {
      column,
      count: vals.length,
      mean: computeMean(vals),
      stdDev: computeStdDev(vals),
      median: computeMedian(vals),
      min: Math.min(...vals),
      max: Math.max(...vals),
      p25: computePercentile(vals, 0.25),
      p75: computePercentile(vals, 0.75),
    };
    return {
      columns: Object.keys(stats),
      rows: [stats],
      meta: { count: 1, fetchedAt: table.meta?.fetchedAt },
    };
  }),

  'an.fitDistribution': transform(async (cfg, [input]) => {
    const table = requireInput(input);
    if (cfg.column) requireColumn(table, cfg.column);
    const fit = fitDistribution(numbersOf(table.rows, cfg.column));
    if (!fit) return { columns: [], rows: [], meta: { count: 0 } };
    const row = { distribution: fit.name, aic: fit.aic, ...fit.params };
    return {
      columns: Object.keys(row),
      rows: [row],
      meta: { count: 1, fetchedAt: table.meta?.fetchedAt },
    };
  }),

  'src.psDataset': source(async (cfg, _in, ctx) => {
    const datasetId = String(cfg.datasetId ?? '');
    if (!datasetId) throw new WorkflowError('wf.err.pickDataset');
    if (!ctx.readDataset) throw new WorkflowError('wf.err.datasetUnavailable');
    const limit = Math.min(
      Math.max(1, Math.floor(Number(cfg.limit) || 10_000)),
      DATASET_READ_LIMIT
    );
    return ctx.readDataset({ datasetId, limit });
  }),

  // Combining, matching, reshaping and checking (./unifyNodes.ts).
  ...UNIFY_RUNTIME,

  'out.table': output(async (_cfg, [input]) => requireInput(input)),
  'out.psDataset': output(async (cfg, [input], ctx) => {
    const table = requireInput(input);
    const datasetId = String(cfg.datasetId ?? '');
    if (!datasetId) throw new WorkflowError('wf.err.pickDataset');
    const mode = DATASET_WRITE_MODES.includes(cfg.mode) ? (cfg.mode as DatasetWriteMode) : 'append';
    const warnings = table.meta?.warnings ?? [];
    if (!ctx.writeDataset) {
      return withRows(table, table.rows, {
        warnings: [...warnings, { key: 'wf.warn.wouldWrite', vars: { rows: table.rows.length } }],
      });
    }
    const { written, rejected } = await ctx.writeDataset({ datasetId, mode }, table);
    return withRows(table, table.rows, {
      warnings: [...warnings, { key: 'wf.warn.written', vars: { rows: written, rejected } }],
    });
  }),
  // Adds the rows to an ERP's customers, suppliers or products (master data
  // only), through the ERP's own rules and the runner's rights there.
  'out.erpList': output(async (cfg, [input], ctx) => {
    const table = requireInput(input);
    const list = ERP_LIST_TARGETS.includes(cfg.list) ? (cfg.list as ErpListTarget) : null;
    if (!list) throw new WorkflowError('wf.err.missingConfig', { field: 'list' });
    if (!table.columns.some((c) => c.toLowerCase() === 'name'))
      throw new WorkflowError('wf.err.erpNameColumn');
    const mode = ERP_WRITE_MODES.includes(cfg.erpMode) ? (cfg.erpMode as ErpWriteMode) : 'add_new';
    const warnings = table.meta?.warnings ?? [];
    if (!ctx.writeErpList)
      return withRows(table, table.rows, {
        warnings: [
          ...warnings,
          { key: 'wf.warn.wouldWriteErp', vars: { rows: table.rows.length } },
        ],
      });
    const r = await ctx.writeErpList({ erpId: erpOf(cfg), list, mode }, table);
    return withRows(table, table.rows, {
      warnings: [...warnings, { key: 'wf.warn.writtenErp', vars: { ...r } }],
    });
  }),
  'out.csv': output(async (_cfg, [input]) => requireInput(input)),
  'out.dataset': output(async (cfg, [input]) =>
    withRows(requireInput(input), requireInput(input).rows, { dataset: String(cfg.name ?? '') })
  ),

  // Charts are aggregated here, so only the chart's points leave the server.
  'out.barChart': output(async (cfg, [input]) => {
    const table = requireInput(input);
    const { categoryColumn, valueColumn, aggregation = 'sum' } = cfg;
    if (!categoryColumn || !valueColumn)
      return { columns: [], rows: [], meta: { count: 0, fetchedAt: table.meta?.fetchedAt } };
    requireColumn(table, categoryColumn);
    requireColumn(table, valueColumn);
    const groups = [...groupRows(table.rows, categoryColumn)];
    const measured = measureGroups(
      table,
      groups.map(([, members]) => members),
      valueColumn,
      aggregation
    );
    const rows = groups
      .map(([k], i) => ({ [categoryColumn]: k, [valueColumn]: measured.values[i] }))
      .sort((a, b) => Number(b[valueColumn] ?? -Infinity) - Number(a[valueColumn] ?? -Infinity));
    return {
      columns: [categoryColumn, valueColumn],
      rows,
      meta: {
        count: rows.length,
        fetchedAt: table.meta?.fetchedAt,
        warnings: [...(table.meta?.warnings ?? []), ...measured.warnings],
        preAggregated: true,
        sourceRows: table.rows.length,
        ...(measured.partial ? { partial: true } : {}),
      },
    };
  }),

  'out.lineChart': output(async (cfg, [input]) => {
    const table = requireInput(input);
    if (cfg.xColumn) requireColumn(table, cfg.xColumn);
    if (cfg.yColumn) requireColumn(table, cfg.yColumn);
    return table;
  }),

  'out.kpi': output(async (cfg, [input]) => {
    const table = requireInput(input);
    const { column, operation } = cfg;
    if (!column) throw new WorkflowError('wf.err.pickColumn');
    requireColumn(table, column);
    const measured = measureGroups(table, [table.rows], column, operation);
    return {
      columns: ['label', 'value', 'count'],
      rows: [
        {
          label: cfg.label,
          value: measured.values[0],
          count: table.rows.filter((r) => isPresent(r[column])).length,
        },
      ],
      meta: {
        count: 1,
        fetchedAt: table.meta?.fetchedAt,
        warnings: [...(table.meta?.warnings ?? []), ...measured.warnings],
        ...(measured.partial ? { partial: true } : {}),
      },
    };
  }),
};

export const COMPARISON_OPERATORS = COMPARE_OPS;
