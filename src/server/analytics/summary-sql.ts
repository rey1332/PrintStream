import {
  CATALOG,
  getRelation,
  isNumericType,
  type EntityKey,
  type FieldType,
} from '@/lib/analytics/catalog';
import type { QueryFilter } from '@/lib/analytics/query';
import {
  RECORD_COUNT,
  SUMMARY_LIMITS,
  currencyCheckedMeasures,
  inactiveRule,
  summaryColumns,
  summaryField,
  summaryRelations,
  type SummaryColumn,
  type SummaryGroup,
  type SummaryMeasure,
  type SummaryResult,
  type SummarySpec,
} from '@/lib/analytics/summary';

export interface SqlScope {
  column: 'user_id' | 'workspace_id';
  value: string;
}
export interface BuiltSql {
  sql: string;
  params: unknown[];
}

const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function engineSql(entity: EntityKey, key: string, alias: string): string {
  if (entity === 'invoices' && key === 'balance_due') {
    return `(CASE WHEN ${alias}."voided_at" IS NOT NULL THEN 0 ELSE round(${alias}."total" - ${alias}."amount_paid", 2) END)`;
  }
  throw new Error(`No SQL for calculated field ${entity}.${key}`);
}

const sameScope = (base: string, other: string) =>
  `(CASE WHEN ${base}."workspace_id" IS NOT NULL AND ${other}."workspace_id" IS NOT NULL ` +
  `THEN ${other}."workspace_id" = ${base}."workspace_id" ELSE ${other}."user_id" = ${base}."user_id" END)`;

interface Source {
  from: string;
  where: string[];
  alias: (relation?: string) => string;
  relations: { key: string; alias: string; column: string }[];
}

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function filterSql(entity: EntityKey, f: QueryFilter, params: Params): string {
  const col = `t0.${quote(f.field)}`;
  switch (f.op) {
    case 'eq':
      return `${col} = ${params.add(f.value)}`;
    case 'neq':
      return `${col} <> ${params.add(f.value)}`;
    case 'gt':
      return `${col} > ${params.add(f.value)}`;
    case 'gte':
      return `${col} >= ${params.add(f.value)}`;
    case 'lt':
      return `${col} < ${params.add(f.value)}`;
    case 'lte':
      return `${col} <= ${params.add(f.value)}`;
    case 'contains':
      return `${col} ILIKE ${params.add(likeContains(String(f.value)))}`;
    case 'in':
      return `${col}::text = ANY(${params.add((f.value as unknown[]).map(String))}::text[])`;
    case 'isNull':
      return `${col} IS NULL`;
    case 'notNull':
      return `${col} IS NOT NULL`;
    default:
      throw new Error(`Unsupported filter on ${entity}`);
  }
}

function buildSource(spec: SummarySpec, scope: SqlScope, params: Params): Source {
  const def = CATALOG[spec.entity];
  const parts = [`FROM public.${quote(def.table)} t0`];
  let scopeAlias = 't0';
  if (def.scopeVia) {
    // Lines carry no workspace of their own: they belong to their parent's.
    const via = getRelation(spec.entity, def.scopeVia)!;
    parts.push(
      `JOIN public.${quote(CATALOG[via.target].table)} s ON s."id" = t0.${quote(via.column)}`
    );
    scopeAlias = 's';
  }
  const relations = summaryRelations(spec).map((key, i) => {
    const relation = getRelation(spec.entity, key)!;
    const alias = `r${i}`;
    parts.push(
      `LEFT JOIN public.${quote(CATALOG[relation.target].table)} ${alias} ` +
        `ON ${alias}."id" = t0.${quote(relation.column)} AND ${sameScope(scopeAlias, alias)}`
    );
    return { key, alias, column: relation.column };
  });

  const where = [`${scopeAlias}.${quote(scope.column)} = ${params.add(scope.value)}`];
  for (const f of spec.filters) where.push(filterSql(spec.entity, f, params));
  const rule = spec.includeInactive ? null : inactiveRule(spec.entity);
  if (rule) {
    const a = rule.on === 'self' ? 't0' : 's';
    if (rule.status) where.push(`${a}."status"::text <> ${params.add(rule.status)}`);
    if (rule.column) where.push(`${a}.${quote(rule.column)} IS NULL`);
  }

  const aliases = new Map(relations.map((r) => [r.key, r.alias]));
  return {
    from: parts.join(' '),
    where,
    alias: (relation) => (relation ? aliases.get(relation)! : 't0'),
    relations,
  };
}

function fieldSql(
  spec: SummarySpec,
  source: Source,
  ref: { field?: string; relation?: string }
): { sql: string; type: FieldType } {
  const found = summaryField(spec.entity, ref)!;
  const alias = source.alias(ref.relation);
  const sql =
    found.def.calculated === 'engine'
      ? engineSql(found.entity, found.def.key, alias)
      : `${alias}.${quote(found.def.key)}`;
  return { sql, type: found.def.type };
}

const BUCKET_FORMAT: Record<NonNullable<SummaryGroup['bucket']>, string> = {
  day: 'YYYY-MM-DD',
  month: 'YYYY-MM',
  quarter: 'YYYY-"Q"Q',
  year: 'YYYY',
};

function groupSql(spec: SummarySpec, source: Source, g: SummaryGroup): string {
  const { sql, type } = fieldSql(spec, source, g);
  if (g.bucket) return `to_char(${sql}, '${BUCKET_FORMAT[g.bucket]}')`;
  if (type === 'date') return `to_char(${sql}, 'YYYY-MM-DD')`;
  if (type === 'datetime' || type === 'id' || type === 'enum') return `${sql}::text`;
  return sql;
}

function measureSql(spec: SummarySpec, source: Source, m: SummaryMeasure): string {
  if (m.op === 'count') return 'count(*)';
  const { sql, type } = fieldSql(spec, source, m);
  switch (m.op) {
    case 'countDistinct':
      return `count(DISTINCT ${sql})`;
    case 'sum':
      return `sum(${sql})`;
    case 'avg':
      return `round(avg(${sql})::numeric, 4)`;
    default: {
      const fn = m.op === 'min' ? 'min' : 'max';
      return type === 'date' || type === 'datetime' ? `${fn}(${sql})::text` : `${fn}(${sql})`;
    }
  }
}

const measureOf = (c: SummaryColumn): SummaryMeasure => ({
  op: c.op!,
  field: c.field,
  relation: c.relation,
});

export function buildSummarySql(spec: SummarySpec, scope: SqlScope): BuiltSql {
  const params = new Params();
  const source = buildSource(spec, scope, params);
  const columns = summaryColumns(spec);
  const select: string[] = [];
  let g = 0;
  let m = 0;
  for (const c of columns) {
    if (c.role === 'group') select.push(`${groupSql(spec, source, spec.groupBy[g])} AS g${g++}`);
    else select.push(`${measureSql(spec, source, measureOf(c))} AS m${m++}`);
  }
  if (currencyCheckedMeasures(spec).length)
    select.push(`count(DISTINCT coalesce(t0."currency", '')) AS _currencies`);
  source.relations.forEach((r, i) => {
    select.push(
      `count(*) FILTER (WHERE t0.${quote(r.column)} IS NOT NULL AND ${r.alias}."id" IS NULL) AS _unresolved${i}`
    );
  });

  const groupCount = spec.groupBy.length;
  let sql = `SELECT ${select.join(', ')} ${source.from} WHERE ${source.where.join(' AND ')}`;
  if (groupCount) {
    sql += ` GROUP BY ${spec.groupBy.map((_, i) => i + 1).join(', ')}`;
    const order: string[] = [];
    if (spec.sort) {
      const index = columns.findIndex((c) => c.name === spec.sort!.column);
      const c = columns[index];
      const alias =
        c.role === 'group'
          ? `g${columns.slice(0, index).filter((x) => x.role === 'group').length}`
          : `m${columns.slice(0, index).filter((x) => x.role === 'measure').length}`;
      order.push(`${alias} ${spec.sort.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`);
    }
    for (let i = 0; i < groupCount; i++) order.push(`g${i} ASC NULLS LAST`);
    sql += ` ORDER BY ${order.join(', ')} LIMIT ${params.add(spec.limit + 1)}`;
  }
  return { sql, params: params.values };
}

const toNumber = (v: unknown) =>
  v === null || v === undefined ? null : typeof v === 'number' ? v : Number(v);

export type ShapedSummary = Omit<SummaryResult, 'fetchedAt'>;

export function shapeSummary(spec: SummarySpec, raw: Record<string, unknown>[]): ShapedSummary {
  const columns = summaryColumns(spec);
  const checked = new Set(currencyCheckedMeasures(spec));
  const truncated = spec.groupBy.length > 0 && raw.length > spec.limit;
  let mixedCurrencyRows = 0;
  let unresolvedRelations = 0;
  let recordCount = 0;
  const rows = raw.slice(0, spec.limit).map((r) => {
    const out: Record<string, unknown> = {};
    let g = 0;
    let m = 0;
    const mixed = Number(r._currencies ?? 0) > 1;
    if (mixed) mixedCurrencyRows++;
    for (const c of columns) {
      const value = c.role === 'group' ? r[`g${g++}`] : r[`m${m++}`];
      if (c.role === 'measure' && mixed && checked.has(c.name)) out[c.name] = null;
      else if (isNumericType(c.type) || c.op === 'count' || c.op === 'countDistinct')
        out[c.name] = toNumber(value);
      else out[c.name] = value ?? null;
    }
    recordCount += Number(out[RECORD_COUNT] ?? 0);
    for (let i = 0; `_unresolved${i}` in r; i++)
      unresolvedRelations += Number(r[`_unresolved${i}`] ?? 0);
    return out;
  });
  return { columns, rows, truncated, mixedCurrencyRows, unresolvedRelations, recordCount };
}

// ─── Drill-down: the records behind one summary row ──────────────────────────

export function drillFields(entity: EntityKey) {
  return CATALOG[entity].fields;
}

export type GroupValues = Record<string, string | number | boolean | null>;

export function validGroupValues(spec: SummarySpec, group: unknown): group is GroupValues {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return false;
  const names = summaryColumns(spec)
    .filter((c) => c.role === 'group')
    .map((c) => c.name);
  const keys = Object.keys(group);
  if (keys.length !== names.length || !names.every((n) => keys.includes(n))) return false;
  return Object.values(group).every(
    (v) =>
      v === null || (['string', 'number', 'boolean'].includes(typeof v) && String(v).length <= 200)
  );
}

export function buildDrillSql(
  spec: SummarySpec,
  scope: SqlScope,
  group: GroupValues,
  offset: number
): BuiltSql {
  const params = new Params();
  const source = buildSource(spec, scope, params);
  const groups = summaryColumns(spec).filter((c) => c.role === 'group');
  const where = [...source.where];
  groups.forEach((c, i) => {
    const expr = groupSql(spec, source, spec.groupBy[i]);
    const value = group[c.name];
    where.push(value === null ? `${expr} IS NULL` : `${expr} = ${params.add(value)}`);
  });
  const select = drillFields(spec.entity).map((f) => {
    const sql =
      f.calculated === 'engine' ? engineSql(spec.entity, f.key, 't0') : `t0.${quote(f.key)}`;
    const cast =
      f.type === 'date' || f.type === 'datetime' || f.type === 'id' || f.type === 'enum'
        ? `${sql}::text`
        : sql;
    return `${cast} AS ${quote(f.key)}`;
  });
  const sort = CATALOG[spec.entity].defaultSort;
  const page = SUMMARY_LIMITS.drillPage;
  const sql =
    `SELECT ${select.join(', ')} ${source.from} WHERE ${where.join(' AND ')} ` +
    `ORDER BY t0.${quote(sort.field)} ${sort.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, t0."id" ASC ` +
    `LIMIT ${params.add(page + 1)} OFFSET ${params.add(Math.max(0, Math.min(offset, SUMMARY_LIMITS.maxDrillOffset)))}`;
  return { sql, params: params.values };
}

export function shapeDrillRows(
  entity: EntityKey,
  raw: Record<string, unknown>[]
): Record<string, unknown>[] {
  const fields = drillFields(entity);
  return raw.map((r) =>
    Object.fromEntries(
      fields.map((f) => [f.key, isNumericType(f.type) ? toNumber(r[f.key]) : (r[f.key] ?? null)])
    )
  );
}
