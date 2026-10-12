import type { createRouteClient } from '@/server/db/route-client';

type DataClient = ReturnType<typeof createRouteClient>;
import { CATALOG, getRelation, type EntityKey } from './catalog';
import {
  QUERY_LIMITS,
  buildSelect,
  likePattern,
  resultColumns,
  scopeFilterColumn,
  shapeRows,
  type QueryResult,
  type QuerySpec,
} from './query';
import { can, isPermission } from '@/app/erp/lib/erpRules';

export const WORKSPACES_ENABLED = process.env.NEXT_PUBLIC_ERP_WORKSPACES !== 'off';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ScopeErrorCode =
  | 'invalidWorkspace'
  | 'workspaceCheckFailed'
  | 'notMember'
  | 'forbidden';

export class QueryExecutionError extends Error {
  code: ScopeErrorCode | 'queryFailed' | 'timeout';
  constructor(code: QueryExecutionError['code']) {
    super(code);
    this.code = code;
  }
}

export interface QueryScope {
  column: 'user_id' | 'workspace_id';
  value: string;
}

export async function resolveScope(
  db: DataClient,
  userId: string,
  workspaceId: unknown,
  spec: QuerySpec
): Promise<QueryScope> {
  const entities = [
    spec.entity,
    ...(spec.related ?? []).map((r) => getRelation(spec.entity, r.relation)!.target),
  ];
  return resolveScopeFor(db, userId, workspaceId, entities);
}

export async function resolveScopeFor(
  db: DataClient,
  userId: string,
  workspaceId: unknown,
  entities: EntityKey[]
): Promise<QueryScope> {
  if (
    !WORKSPACES_ENABLED ||
    workspaceId === null ||
    workspaceId === undefined ||
    workspaceId === ''
  ) {
    return { column: 'user_id', value: userId };
  }
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId))
    throw new QueryExecutionError('invalidWorkspace');
  // The effective permissions (built-in or custom role); empty when not a member.
  const { data, error } = await db.rpc('erp_my_permissions', { p_workspace_id: workspaceId });
  if (error) throw new QueryExecutionError('workspaceCheckFailed');
  const permissions = Array.isArray(data) ? data.filter(isPermission) : [];
  if (permissions.length === 0) throw new QueryExecutionError('notMember');
  if (!entities.every((e) => can(permissions, CATALOG[e].permission)))
    throw new QueryExecutionError('forbidden');
  return { column: 'workspace_id', value: workspaceId };
}

function applyFilters(query: any, spec: QuerySpec) {
  let q = query;
  for (const f of spec.filters ?? []) {
    switch (f.op) {
      case 'eq':
        q = q.eq(f.field, f.value);
        break;
      case 'neq':
        q = q.neq(f.field, f.value);
        break;
      case 'gt':
        q = q.gt(f.field, f.value);
        break;
      case 'gte':
        q = q.gte(f.field, f.value);
        break;
      case 'lt':
        q = q.lt(f.field, f.value);
        break;
      case 'lte':
        q = q.lte(f.field, f.value);
        break;
      case 'contains':
        q = q.ilike(f.field, likePattern(String(f.value)));
        break;
      case 'in':
        q = q.in(f.field, f.value as unknown[]);
        break;
      case 'isNull':
        q = q.is(f.field, null);
        break;
      case 'notNull':
        q = q.not(f.field, 'is', null);
        break;
    }
  }
  return q;
}

export async function executeQuery(
  db: DataClient,
  spec: QuerySpec,
  scope: QueryScope,
  deadline: number
): Promise<QueryResult> {
  const entity = CATALOG[spec.entity];
  const select = buildSelect(spec);
  const sort = spec.sort ?? entity.defaultSort;
  const limit = spec.limit ?? QUERY_LIMITS.defaultRows;
  const offset = spec.offset ?? 0;
  // One extra row tells us whether more rows match than were returned.
  const wanted = limit + 1;

  const raw: Record<string, any>[] = [];
  let timedOut = false;
  while (raw.length < wanted) {
    if (Date.now() > deadline) {
      if (raw.length === 0) throw new QueryExecutionError('timeout');
      timedOut = true;
      break;
    }
    const from = offset + raw.length;
    const to = from + Math.min(QUERY_LIMITS.pageSize, wanted - raw.length) - 1;
    let query = db
      .from(entity.table)
      .select(select)
      .eq(scopeFilterColumn(spec.entity, scope.column), scope.value);
    query = applyFilters(query, spec)
      .order(sort.field, { ascending: sort.direction === 'asc', nullsFirst: false })
      // A unique tiebreaker keeps pages stable.
      .order('id', { ascending: true })
      .range(from, to);
    const { data, error } = await query;
    if (error) {
      console.error('[analytics query]', { entity: spec.entity, code: error.code });
      throw new QueryExecutionError('queryFailed');
    }
    const page = (data ?? []) as unknown as Record<string, any>[];
    raw.push(...page);
    if (page.length < to - from + 1) break;
  }

  const truncated = raw.length > limit || timedOut;
  const { rows, quality } = shapeRows(spec, raw.slice(0, limit));
  return {
    columns: resultColumns(spec),
    rows,
    meta: {
      entity: spec.entity,
      fetchedAt: new Date().toISOString(),
      rowCount: rows.length,
      offset,
      limit,
      truncated,
      quality,
    },
  };
}
