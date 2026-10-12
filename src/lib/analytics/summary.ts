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
import { validateFilters, type QueryError, type QueryFilter } from './query';

export const SUMMARY_LIMITS = {
  maxGroups: 3,
  maxMeasures: 8,
  defaultRows: 200,
  maxRows: 1000,
  drillPage: 50,
  maxDrillOffset: 10_000,
} as const;

export const BUCKETS = ['day', 'month', 'quarter', 'year'] as const;
export type Bucket = (typeof BUCKETS)[number];

export const MEASURE_OPS = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'] as const;
export type MeasureOp = (typeof MEASURE_OPS)[number];

export interface SummaryGroup {
  field: string;
  relation?: string;
  bucket?: Bucket;
}
export interface SummaryMeasure {
  op: MeasureOp;
  field?: string;
  relation?: string;
}

export interface SummarySpec {
  entity: EntityKey;
  groupBy: SummaryGroup[];
  measures: SummaryMeasure[];
  filters: QueryFilter[];
  includeInactive: boolean;
  sort: { column: string; direction: 'asc' | 'desc' } | null;
  limit: number;
}

export type SummaryErrorCode =
  | QueryError['code']
  | 'tooManyGroups'
  | 'tooManyMeasures'
  | 'invalidGroupField'
  | 'invalidBucket'
  | 'invalidMeasure'
  | 'repeatedMeasure'
  | 'duplicateColumn'
  | 'currencyGroupRequired';

export interface SummaryError {
  code: SummaryErrorCode;
  detail?: string;
}

export interface SummaryColumn {
  name: string;
  type: FieldType;
  role: 'group' | 'measure';
  entity: EntityKey;
  field?: string;
  relation?: string;
  bucket?: Bucket;
  op?: MeasureOp;
}

export interface SummaryResult {
  columns: SummaryColumn[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  mixedCurrencyRows: number;
  unresolvedRelations: number;
  recordCount: number;
  fetchedAt: string;
}

export const RECORD_COUNT = 'record_count';

const GROUP_TYPES: readonly FieldType[] = [
  'text',
  'enum',
  'boolean',
  'date',
  'datetime',
  'id',
  'integer',
];
const ORDERED_TYPES: readonly FieldType[] = ['integer', 'number', 'money', 'date', 'datetime'];

export function summaryField(
  entity: EntityKey,
  ref: { field?: string; relation?: string }
): { def: CatalogField; entity: EntityKey } | null {
  if (!ref.relation) {
    const def = getField(entity, String(ref.field ?? ''));
    return def ? { def, entity } : null;
  }
  const relation = getRelation(entity, ref.relation);
  if (!relation) return null;
  const def = getField(relation.target, String(ref.field ?? ''));
  return def ? { def, entity: relation.target } : null;
}

const refName = (ref: { field?: string; relation?: string }) =>
  ref.relation ? relatedFieldName(ref.relation, String(ref.field)) : String(ref.field);

export function groupColumnName(g: SummaryGroup): string {
  return g.bucket ? `${refName(g)}_${g.bucket}` : refName(g);
}

export function measureColumnName(m: SummaryMeasure): string {
  if (m.op === 'count') return RECORD_COUNT;
  if (m.op === 'countDistinct') return `distinct_${refName(m)}`;
  return `${m.op}_${refName(m)}`;
}

function measureType(m: SummaryMeasure, def: CatalogField | undefined): FieldType {
  if (m.op === 'count' || m.op === 'countDistinct') return 'integer';
  if (m.op === 'avg') return def?.type === 'money' ? 'money' : 'number';
  if (m.op === 'sum') return def?.type === 'integer' ? 'integer' : (def?.type ?? 'number');
  return def?.type ?? 'number';
}

export function validateSummary(
  input: unknown
): { ok: true; spec: SummarySpec } | { ok: false; errors: SummaryError[] } {
  const errors: SummaryError[] = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: [{ code: 'invalidSpec' }] };
  const raw = input as Record<string, any>;
  if (!isEntityKey(raw.entity))
    return { ok: false, errors: [{ code: 'unknownEntity', detail: String(raw.entity ?? '') }] };
  const entity: EntityKey = raw.entity;

  const refError = (ref: any): SummaryError =>
    ref?.relation && !getRelation(entity, String(ref.relation))
      ? { code: 'unknownRelation', detail: String(ref.relation) }
      : {
          code: 'unknownField',
          detail: refName({
            field: String(ref?.field ?? ''),
            relation: ref?.relation ? String(ref.relation) : undefined,
          }),
        };

  const rawGroups = Array.isArray(raw.groupBy) ? raw.groupBy : [];
  if (rawGroups.length > SUMMARY_LIMITS.maxGroups) errors.push({ code: 'tooManyGroups' });
  const groupBy: SummaryGroup[] = [];
  for (const g of rawGroups.slice(0, SUMMARY_LIMITS.maxGroups)) {
    const found = summaryField(entity, g ?? {});
    if (!found) {
      errors.push(refError(g));
      continue;
    }
    const { def } = found;
    const group: SummaryGroup = {
      field: def.key,
      ...(g.relation ? { relation: String(g.relation) } : {}),
    };
    if (def.calculated === 'engine' || !GROUP_TYPES.includes(def.type)) {
      errors.push({ code: 'invalidGroupField', detail: refName(group) });
      continue;
    }
    if (g.bucket !== undefined && g.bucket !== null && g.bucket !== '') {
      if (
        !(BUCKETS as readonly string[]).includes(g.bucket) ||
        (def.type !== 'date' && def.type !== 'datetime')
      ) {
        errors.push({ code: 'invalidBucket', detail: refName(group) });
        continue;
      }
      group.bucket = g.bucket;
    }
    groupBy.push(group);
  }

  const rawMeasures = Array.isArray(raw.measures) ? raw.measures : [];
  if (rawMeasures.length > SUMMARY_LIMITS.maxMeasures) errors.push({ code: 'tooManyMeasures' });
  const measures: SummaryMeasure[] = [];
  for (const m of rawMeasures.slice(0, SUMMARY_LIMITS.maxMeasures)) {
    const op = m?.op as MeasureOp;
    if (!(MEASURE_OPS as readonly string[]).includes(op)) {
      errors.push({ code: 'invalidMeasure', detail: String(m?.op ?? '') });
      continue;
    }
    if (op === 'count') {
      measures.push({ op });
      continue;
    }
    const found = summaryField(entity, m ?? {});
    if (!found) {
      errors.push(refError(m));
      continue;
    }
    const { def } = found;
    const measure: SummaryMeasure = {
      op,
      field: def.key,
      ...(m.relation ? { relation: String(m.relation) } : {}),
    };
    const name = refName(measure);
    if (op === 'sum' || op === 'avg') {
      if (!isNumericType(def.type)) {
        errors.push({ code: 'invalidMeasure', detail: `${op} ${name}` });
        continue;
      }
      if (measure.relation) {
        errors.push({ code: 'repeatedMeasure', detail: name });
        continue;
      }
      const via = CATALOG[entity].scopeVia;
      if (
        def.currency === 'document' &&
        !getField(entity, 'currency') &&
        via &&
        !rawGroups.some((g: any) => g?.relation === via && g?.field === 'currency')
      ) {
        errors.push({ code: 'currencyGroupRequired', detail: name });
        continue;
      }
    }
    if ((op === 'min' || op === 'max') && !ORDERED_TYPES.includes(def.type)) {
      errors.push({ code: 'invalidMeasure', detail: `${op} ${name}` });
      continue;
    }
    if (op === 'countDistinct' && def.calculated === 'engine') {
      errors.push({ code: 'invalidMeasure', detail: `${op} ${name}` });
      continue;
    }
    if ((op === 'min' || op === 'max') && measure.relation && def.calculated === 'engine') {
      errors.push({ code: 'invalidMeasure', detail: `${op} ${name}` });
      continue;
    }
    measures.push(measure);
  }

  const filterErrors: QueryError[] = [];
  const filters = validateFilters(entity, raw.filters, filterErrors);
  errors.push(...filterErrors);

  const limit =
    raw.limit === undefined || raw.limit === null ? SUMMARY_LIMITS.defaultRows : Number(raw.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > SUMMARY_LIMITS.maxRows)
    errors.push({ code: 'invalidLimit' });

  const spec: SummarySpec = {
    entity,
    groupBy,
    measures,
    filters,
    includeInactive: raw.includeInactive === true,
    sort: null,
    limit,
  };
  const names = summaryColumns(spec).map((c) => c.name);
  if (new Set(names).size !== names.length) errors.push({ code: 'duplicateColumn' });
  if (raw.sort) {
    if (!names.includes(String(raw.sort.column)) || !['asc', 'desc'].includes(raw.sort.direction))
      errors.push({ code: 'invalidSort' });
    else spec.sort = { column: String(raw.sort.column), direction: raw.sort.direction };
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, spec };
}

export function summaryColumns(
  spec: Pick<SummarySpec, 'entity' | 'groupBy' | 'measures'>
): SummaryColumn[] {
  const cols: SummaryColumn[] = [];
  for (const g of spec.groupBy) {
    const found = summaryField(spec.entity, g);
    cols.push({
      name: groupColumnName(g),
      type: g.bucket ? 'text' : (found?.def.type ?? 'text'),
      role: 'group',
      entity: found?.entity ?? spec.entity,
      field: g.field,
      relation: g.relation,
      bucket: g.bucket,
    });
  }
  const measures = spec.measures.some((m) => m.op === 'count')
    ? spec.measures
    : [...spec.measures, { op: 'count' as const }];
  for (const m of measures) {
    const found = m.op === 'count' ? null : summaryField(spec.entity, m);
    cols.push({
      name: measureColumnName(m),
      type: measureType(m, found?.def),
      role: 'measure',
      entity: found?.entity ?? spec.entity,
      field: m.field,
      relation: m.relation,
      op: m.op,
    });
  }
  return cols;
}

export function summaryRelations(spec: Pick<SummarySpec, 'groupBy' | 'measures'>): string[] {
  return [
    ...new Set(
      [...spec.groupBy, ...spec.measures]
        .map((r) => r.relation)
        .filter((r): r is string => Boolean(r))
    ),
  ];
}

export function summaryEntities(
  spec: Pick<SummarySpec, 'entity' | 'groupBy' | 'measures'>
): EntityKey[] {
  return [spec.entity, ...summaryRelations(spec).map((r) => getRelation(spec.entity, r)!.target)];
}

export function currencyCheckedMeasures(
  spec: Pick<SummarySpec, 'entity' | 'groupBy' | 'measures'>
): string[] {
  const hasCurrency = Boolean(getField(spec.entity, 'currency'));
  if (!hasCurrency || spec.groupBy.some((g) => !g.relation && g.field === 'currency')) return [];
  return spec.measures
    .filter(
      (m) =>
        (m.op === 'sum' || m.op === 'avg') &&
        !m.relation &&
        getField(spec.entity, String(m.field))?.currency === 'document'
    )
    .map(measureColumnName);
}

export function inactiveRule(
  entity: EntityKey
): { status?: string; column?: string; on: 'self' | 'parent' } | null {
  const def = CATALOG[entity];
  if (def.inactive) return { ...def.inactive, on: 'self' };
  if (def.scopeVia) {
    const parent = CATALOG[getRelation(entity, def.scopeVia)!.target];
    if (parent.inactive) return { ...parent.inactive, on: 'parent' };
  }
  return null;
}

export function defaultSummary(entity: EntityKey): SummarySpec {
  const def = CATALOG[entity];
  if (entity === 'journalLines') {
    // Balances per account (the trial balance's debit and credit columns).
    return {
      entity,
      groupBy: [
        { relation: 'account', field: 'code' },
        { relation: 'account', field: 'name' },
      ],
      measures: [{ op: 'sum', field: 'debit' }, { op: 'sum', field: 'credit' }, { op: 'count' }],
      filters: [],
      includeInactive: false,
      sort: null,
      limit: SUMMARY_LIMITS.defaultRows,
    };
  }
  const groupBy: SummaryGroup[] = def.dateField ? [{ field: def.dateField, bucket: 'month' }] : [];
  // Transactions only (records with a date); the base-currency amount when there is one.
  const amount = !def.dateField
    ? undefined
    : (def.fields.find(
        (f) => f.type === 'money' && f.currency !== 'document' && f.calculated !== 'engine'
      ) ?? def.fields.find((f) => f.type === 'money' && !f.calculated));
  const measures: SummaryMeasure[] = [
    { op: 'count' },
    ...(amount ? [{ op: 'sum' as const, field: amount.key }] : []),
  ];
  return {
    entity,
    groupBy,
    measures,
    filters: [],
    includeInactive: false,
    sort: null,
    limit: SUMMARY_LIMITS.defaultRows,
  };
}
