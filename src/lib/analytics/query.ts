import {
  CATALOG,
  getField,
  getRelation,
  isEntityKey,
  isNumericType,
  relatedFieldName,
  type CatalogField,
  type EntityKey,
  type FieldType,
} from './catalog';

export const QUERY_LIMITS = {
  defaultRows: 1000,
  maxRows: 5000,
  pageSize: 1000,
  maxFields: 60,
  maxFilters: 20,
  maxInValues: 100,
  maxTextValue: 200,
} as const;

export const FILTER_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
  'isNull',
  'notNull',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface QueryFilter {
  field: string;
  op: FilterOp;
  value?: unknown;
}

export interface QuerySpec {
  entity: EntityKey;
  fields: string[];
  related?: { relation: string; fields: string[] }[];
  filters?: QueryFilter[];
  sort?: { field: string; direction: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}

export type QueryErrorCode =
  | 'invalidSpec'
  | 'unknownEntity'
  | 'noFields'
  | 'tooManyFields'
  | 'unknownField'
  | 'unknownRelation'
  | 'tooManyFilters'
  | 'invalidOperator'
  | 'invalidValue'
  | 'calculatedNotFilterable'
  | 'invalidSort'
  | 'invalidLimit';

export interface QueryError {
  code: QueryErrorCode;
  detail?: string;
}

export function operatorsFor(type: FieldType, nullable: boolean): FilterOp[] {
  const nulls: FilterOp[] = nullable ? ['isNull', 'notNull'] : [];
  switch (type) {
    case 'integer':
    case 'number':
    case 'money':
    case 'date':
    case 'datetime':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', ...nulls];
    case 'enum':
      return ['eq', 'neq', 'in', ...nulls];
    case 'boolean':
      return ['eq', ...nulls];
    case 'id':
      return ['eq', 'neq', 'in', ...nulls];
    default:
      return ['eq', 'neq', 'contains', ...nulls];
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function normalizeValue(
  field: CatalogField,
  value: unknown
): string | number | boolean | null {
  switch (field.type) {
    case 'integer':
    case 'number':
    case 'money': {
      const n =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : NaN;
      if (!Number.isFinite(n)) return null;
      return field.type === 'integer' && !Number.isInteger(n) ? null : n;
    }
    case 'boolean':
      return value === true || value === 'true'
        ? true
        : value === false || value === 'false'
          ? false
          : null;
    case 'date':
      return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value))
        ? value
        : null;
    case 'datetime':
      return typeof value === 'string' && DATETIME.test(value) && !Number.isNaN(Date.parse(value))
        ? value
        : null;
    case 'enum':
      return typeof value === 'string' && field.enumValues?.includes(value) ? value : null;
    case 'id':
      return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
    default:
      return typeof value === 'string' && value.length <= QUERY_LIMITS.maxTextValue ? value : null;
  }
}

export type ValidationResult = { ok: true; spec: QuerySpec } | { ok: false; errors: QueryError[] };

export function validateFilters(
  entity: EntityKey,
  input: unknown,
  errors: QueryError[]
): QueryFilter[] {
  const filters: QueryFilter[] = [];
  const rawFilters = Array.isArray(input) ? input : [];
  if (rawFilters.length > QUERY_LIMITS.maxFilters) errors.push({ code: 'tooManyFilters' });
  for (const f of rawFilters.slice(0, QUERY_LIMITS.maxFilters)) {
    const def = getField(entity, String(f?.field ?? ''));
    if (!def) {
      errors.push({ code: 'unknownField', detail: String(f?.field ?? '') });
      continue;
    }
    if (def.calculated === 'engine') {
      errors.push({ code: 'calculatedNotFilterable', detail: def.key });
      continue;
    }
    const op = f.op as FilterOp;
    if (!operatorsFor(def.type, def.nullable).includes(op)) {
      errors.push({ code: 'invalidOperator', detail: `${def.key} ${String(f.op)}` });
      continue;
    }
    if (op === 'isNull' || op === 'notNull') {
      filters.push({ field: def.key, op });
      continue;
    }
    if (op === 'in') {
      const values = Array.isArray(f.value) ? f.value : [];
      const norm = values
        .slice(0, QUERY_LIMITS.maxInValues + 1)
        .map((v: unknown) => normalizeValue(def, v));
      if (
        !values.length ||
        values.length > QUERY_LIMITS.maxInValues ||
        norm.some((v: unknown) => v === null)
      ) {
        errors.push({ code: 'invalidValue', detail: def.key });
      } else filters.push({ field: def.key, op, value: norm });
      continue;
    }
    const value = normalizeValue(def, f.value);
    if (value === null) errors.push({ code: 'invalidValue', detail: def.key });
    else filters.push({ field: def.key, op, value });
  }
  return filters;
}

export function validateQuery(input: unknown): ValidationResult {
  const errors: QueryError[] = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: [{ code: 'invalidSpec' }] };
  const raw = input as Record<string, any>;
  if (!isEntityKey(raw.entity))
    return { ok: false, errors: [{ code: 'unknownEntity', detail: String(raw.entity ?? '') }] };
  const entity: EntityKey = raw.entity;

  const fields = Array.isArray(raw.fields)
    ? ([...new Set(raw.fields.map(String))] as string[])
    : [];
  for (const f of fields)
    if (!getField(entity, f)) errors.push({ code: 'unknownField', detail: f });

  const related: { relation: string; fields: string[] }[] = [];
  for (const r of Array.isArray(raw.related) ? raw.related : []) {
    const relation = getRelation(entity, String(r?.relation ?? ''));
    if (!relation) {
      errors.push({ code: 'unknownRelation', detail: String(r?.relation ?? '') });
      continue;
    }
    const relFields = Array.isArray(r.fields)
      ? ([...new Set(r.fields.map(String))] as string[])
      : [];
    for (const f of relFields) {
      const def = getField(relation.target, f);
      if (!def) errors.push({ code: 'unknownField', detail: relatedFieldName(relation.key, f) });
    }
    if (relFields.length) related.push({ relation: relation.key, fields: relFields });
  }

  const fieldCount = fields.length + related.reduce((n, r) => n + r.fields.length, 0);
  if (fieldCount === 0) errors.push({ code: 'noFields' });
  if (fieldCount > QUERY_LIMITS.maxFields) errors.push({ code: 'tooManyFields' });

  const filters = validateFilters(entity, raw.filters, errors);

  let sort: QuerySpec['sort'];
  if (raw.sort) {
    const def = getField(entity, String(raw.sort.field ?? ''));
    if (!def || def.calculated === 'engine' || !['asc', 'desc'].includes(raw.sort.direction))
      errors.push({ code: 'invalidSort' });
    else sort = { field: def.key, direction: raw.sort.direction };
  }

  const limit = raw.limit === undefined ? QUERY_LIMITS.defaultRows : Number(raw.limit);
  const offset = raw.offset === undefined ? 0 : Number(raw.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_LIMITS.maxRows)
    errors.push({ code: 'invalidLimit' });
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000)
    errors.push({ code: 'invalidLimit' });

  if (errors.length) return { ok: false, errors };
  return { ok: true, spec: { entity, fields, related, filters, sort, limit, offset } };
}

// ─── PostgREST select ─────────────────────────────────────────────────────────

const SCOPE_COLUMNS = ['user_id', 'workspace_id'];

function columnsFor(entity: EntityKey, fields: string[]): string[] {
  const cols = new Set<string>();
  for (const key of fields) {
    const def = getField(entity, key)!;
    if (def.calculated === 'engine') ENGINE_INPUTS[`${entity}.${key}`]?.forEach((c) => cols.add(c));
    else cols.add(key);
  }
  return [...cols];
}

const ENGINE_INPUTS: Record<string, string[]> = {
  'invoices.balance_due': ['total', 'amount_paid', 'voided_at'],
};

function engineValue(entity: EntityKey, key: string, row: Record<string, any>): unknown {
  if (entity === 'invoices' && key === 'balance_due') {
    if (row.voided_at) return 0;
    return Math.round((Number(row.total) - Number(row.amount_paid)) * 100) / 100;
  }
  return null;
}

const SCOPE_ALIAS = 'scope';

export function scopeFilterColumn(entity: EntityKey, column: 'user_id' | 'workspace_id'): string {
  return CATALOG[entity].scopeVia ? `${SCOPE_ALIAS}.${column}` : column;
}

export function buildSelect(spec: QuerySpec): string {
  const def = CATALOG[spec.entity];
  const parts = [
    ...new Set([...columnsFor(spec.entity, spec.fields), ...(def.scopeVia ? [] : SCOPE_COLUMNS)]),
  ];
  if (def.scopeVia) {
    const via = getRelation(spec.entity, def.scopeVia)!;
    // !inner makes the parent's scope filter restrict which lines are returned.
    parts.push(
      `${SCOPE_ALIAS}:${CATALOG[via.target].table}!${via.column}!inner(${SCOPE_COLUMNS.join(',')})`
    );
  }
  for (const r of spec.related ?? []) {
    const relation = getRelation(spec.entity, r.relation)!;
    if (!parts.includes(relation.column)) parts.push(relation.column);
    const target = CATALOG[relation.target];
    const cols = [...new Set([...columnsFor(relation.target, r.fields), ...SCOPE_COLUMNS])];
    parts.push(`${relation.key}:${target.table}!${relation.column}(${cols.join(',')})`);
  }
  return parts.join(',');
}

export function likePattern(value: string): string {
  return `*${value.replace(/[\\%_*]/g, (c) => `\\${c}`)}*`;
}

// ─── Result shaping ───────────────────────────────────────────────────────────

export interface ResultColumn {
  name: string;
  type: FieldType;
  nullable: boolean;
  entity: EntityKey;
  field: string;
  relation?: string;
  calculated?: 'database' | 'engine';
}

export interface QualitySummary {
  relationMismatches: number;
  unresolvedRelations: number;
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: Record<string, unknown>[];
  meta: {
    entity: EntityKey;
    fetchedAt: string;
    rowCount: number;
    offset: number;
    limit: number;
    truncated: boolean;
    quality: QualitySummary;
  };
}

export function resultColumns(spec: QuerySpec): ResultColumn[] {
  const cols: ResultColumn[] = spec.fields.map((key) => {
    const f = getField(spec.entity, key)!;
    return {
      name: key,
      type: f.type,
      nullable: f.nullable,
      entity: spec.entity,
      field: key,
      calculated: f.calculated,
    };
  });
  for (const r of spec.related ?? []) {
    const relation = getRelation(spec.entity, r.relation)!;
    for (const key of r.fields) {
      const f = getField(relation.target, key)!;
      cols.push({
        name: relatedFieldName(relation.key, key),
        type: f.type,
        // A missing link makes every related field empty.
        nullable: true,
        entity: relation.target,
        field: key,
        relation: relation.key,
        calculated: f.calculated,
      });
    }
  }
  return cols;
}

const sameScope = (a: Record<string, any>, b: Record<string, any>) =>
  a.workspace_id && b.workspace_id ? a.workspace_id === b.workspace_id : a.user_id === b.user_id;

export function shapeRows(
  spec: QuerySpec,
  rawRows: Record<string, any>[]
): { rows: Record<string, unknown>[]; quality: QualitySummary } {
  const quality: QualitySummary = { relationMismatches: 0, unresolvedRelations: 0 };
  const scopedVia = Boolean(CATALOG[spec.entity].scopeVia);
  const rows = rawRows.map((raw) => {
    const out: Record<string, unknown> = {};
    const baseScope: Record<string, any> = scopedVia
      ? ((Array.isArray(raw[SCOPE_ALIAS]) ? raw[SCOPE_ALIAS][0] : raw[SCOPE_ALIAS]) ?? {})
      : raw;
    for (const key of spec.fields) {
      const f = getField(spec.entity, key)!;
      out[key] =
        f.calculated === 'engine' ? engineValue(spec.entity, key, raw) : (raw[key] ?? null);
    }
    for (const r of spec.related ?? []) {
      const relation = getRelation(spec.entity, r.relation)!;
      let target = raw[relation.key] as Record<string, any> | null | undefined;
      if (Array.isArray(target)) target = target[0];
      if (target && !sameScope(baseScope, target)) {
        quality.relationMismatches++;
        target = null;
      } else if (!target && raw[relation.column]) quality.unresolvedRelations++;
      for (const key of r.fields) {
        const f = getField(relation.target, key)!;
        const value = !target
          ? null
          : f.calculated === 'engine'
            ? engineValue(relation.target, key, target)
            : (target[key] ?? null);
        out[relatedFieldName(relation.key, key)] = value;
      }
    }
    return out;
  });
  return { rows, quality };
}

export const isNumericColumn = (c: ResultColumn) => isNumericType(c.type);
