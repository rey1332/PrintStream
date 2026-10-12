import { canRead, isPermission, ROLE_PERMISSIONS, type Permission } from '@/app/erp/lib/erpRules';
import {
  ONTOLOGY,
  isOntologyType,
  type OntologyProperty,
  type OntologyTypeKey,
} from '@/lib/ontology/registry';
import { SEARCH_LIMITS, parseQuery, type SearchRequest } from '@/lib/ontology/query';
import type {
  OntologyItem,
  RecordResponse,
  RelatedGroup,
  SearchGroup,
  SearchResponse,
} from '@/lib/ontology/client';
import { beginAsUser, getCatalog, type RequestIdentity } from '@/server/db/execute';
import type { Executor, SqlTx } from '@/server/db/executor';
import { relatedRows, rowById, rowsByIds, type Scope } from './sql';

export type OntologyErrorCode =
  | 'invalidWorkspace'
  | 'notMember'
  | 'forbidden'
  | 'notFound'
  | 'invalid'
  | 'timeout'
  | 'queryFailed';

export class OntologyError extends Error {
  code: OntologyErrorCode;
  constructor(code: OntologyErrorCode) {
    super(code);
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OntologyContext {
  executor: Executor;
  identity: RequestIdentity;
  workspacesEnabled: boolean;
  path: string;
}

function shapeValue(
  prop: OntologyProperty | undefined,
  value: unknown
): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (prop && (prop.format === 'money' || prop.format === 'number')) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'boolean') return value;
  return String(value);
}

function shapeRow(type: OntologyTypeKey, row: Record<string, unknown>): OntologyItem {
  const defs = new Map(ONTOLOGY[type].properties.map((p) => [p.key, p]));
  const props: OntologyItem['props'] = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'id') continue;
    props[key] = shapeValue(defs.get(key), value);
  }
  return { id: String(row.id), type, props };
}

async function inTransaction<T>(ctx: OntologyContext, fn: (tx: SqlTx) => Promise<T>): Promise<T> {
  const catalog = await getCatalog(ctx.executor);
  try {
    return await ctx.executor.transaction(async (tx) => {
      await beginAsUser(tx, ctx.identity, ctx.path, 'POST', catalog);
      return fn(tx);
    });
  } catch (error) {
    if (error instanceof OntologyError) throw error;
    // Only the code is logged: messages can carry values.
    const code = (error as { code?: string })?.code;
    console.error('[ontology]', code || 'error');
    if (code === '57014') throw new OntologyError('timeout');
    if (code === '42501') throw new OntologyError('forbidden');
    if (code === '22023' || code === '22P02') throw new OntologyError('invalid');
    throw new OntologyError('queryFailed');
  }
}

async function resolveScope(
  ctx: OntologyContext,
  tx: SqlTx,
  workspaceId: unknown
): Promise<{ permissions: Permission[]; scope: Scope }> {
  if (
    !ctx.workspacesEnabled ||
    workspaceId === null ||
    workspaceId === undefined ||
    workspaceId === ''
  ) {
    // Workspaces off: people see their own records (the RLS "own rows" policies).
    return { permissions: ROLE_PERMISSIONS.owner, scope: { column: 'user_id', workspaceId: null } };
  }
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId))
    throw new OntologyError('invalidWorkspace');
  // The effective permissions (built-in or custom role); empty when not a member.
  const { rows } = await tx.query('SELECT public.erp_my_permissions($1::uuid) AS permissions', [
    workspaceId,
  ]);
  const raw: unknown = rows[0]?.permissions;
  const permissions = Array.isArray(raw) ? raw.filter(isPermission) : [];
  if (permissions.length === 0) throw new OntologyError('notMember');
  return { permissions, scope: { column: 'workspace_id', workspaceId } };
}

async function logAccess(
  tx: SqlTx,
  scope: Scope,
  action: 'search' | 'view',
  types: OntologyTypeKey[],
  objectId: string | null,
  count: number | null
) {
  await tx.query('SAVEPOINT access_log');
  try {
    await tx.query('SELECT public.erp_log_access($1::uuid, $2, $3::text[], $4::uuid, $5::int)', [
      scope.workspaceId,
      action,
      types,
      objectId,
      count,
    ]);
    await tx.query('RELEASE SAVEPOINT access_log');
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT access_log');
    console.error('[ontology] access log', (error as { code?: string })?.code || 'error');
  }
}

async function readByIds(
  tx: SqlTx,
  type: OntologyTypeKey,
  ids: string[],
  scope: Scope
): Promise<OntologyItem[]> {
  if (ids.length === 0) return [];
  const built = rowsByIds(type, ids, scope);
  const { rows } = await tx.query(built.sql, built.params);
  const byId = new Map(rows.map((r: Record<string, unknown>) => [String(r.id), r]));
  // Keep the search order; rows RLS does not return are simply absent.
  return ids.filter((id) => byId.has(id)).map((id) => shapeRow(type, byId.get(id)!));
}

export async function searchOntology(
  ctx: OntologyContext,
  workspaceId: unknown,
  request: SearchRequest
): Promise<SearchResponse> {
  return inTransaction(ctx, async (tx) => {
    const { permissions, scope } = await resolveScope(ctx, tx, workspaceId);
    const allowed = request.types.filter((type) => canRead(permissions, ONTOLOGY[type].area));
    const excludedTypes = request.types.filter((type) => !allowed.includes(type));
    if (allowed.length === 0) throw new OntologyError('forbidden');

    const parsed = parseQuery(request.q);
    const single = allowed.length === 1;
    const limit = single ? SEARCH_LIMITS.pageRows : SEARCH_LIMITS.groupRows;
    const groups: SearchGroup[] = [];
    for (const type of allowed) {
      const { rows } = await tx.query(
        `SELECT public.erp_ontology_search($1::uuid, $2, $3::text[], $4::uuid, $5::uuid, $6::int, $7::text[], $8::date, $9::date, $10::int, $11::int) AS r`,
        [
          scope.workspaceId,
          type,
          parsed.patterns,
          parsed.idRange?.from ?? null,
          parsed.idRange?.to ?? null,
          ONTOLOGY[type].reference.style === 'entryNo' ? parsed.number : null,
          single ? request.statuses : null,
          request.dateFrom,
          request.dateTo,
          limit,
          single ? request.offset : 0,
        ]
      );
      const result = rows[0]?.r as { ids: string[]; total: number };
      const items = await readByIds(tx, type, result.ids, scope);
      const offset = single ? request.offset : 0;
      groups.push({
        type,
        total: result.total,
        offset,
        hasMore: result.total > offset + result.ids.length,
        items,
      });
    }

    await logAccess(
      tx,
      scope,
      'search',
      allowed,
      null,
      groups.reduce((n, g) => n + g.items.length, 0)
    );
    return { groups, excludedTypes };
  });
}

export async function readOntologyRecord(
  ctx: OntologyContext,
  workspaceId: unknown,
  type: unknown,
  id: unknown
): Promise<RecordResponse> {
  if (!isOntologyType(type) || typeof id !== 'string' || !UUID.test(id))
    throw new OntologyError('invalid');
  return inTransaction(ctx, async (tx) => {
    const { permissions, scope } = await resolveScope(ctx, tx, workspaceId);
    if (!canRead(permissions, ONTOLOGY[type].area)) throw new OntologyError('forbidden');

    const built = rowById(type, id, scope);
    const { rows } = await tx.query(built.sql, built.params);
    // Missing, in another workspace or not readable: all look the same.
    if (rows.length === 0) throw new OntologyError('notFound');
    const item = shapeRow(type, rows[0]);

    const relations: RelatedGroup[] = [];
    const hiddenRelations: string[] = [];
    for (const rel of ONTOLOGY[type].relations) {
      if (!canRead(permissions, ONTOLOGY[rel.target].area)) {
        hiddenRelations.push(rel.key);
        continue;
      }
      const limit = rel.cardinality === 'one' ? 1 : SEARCH_LIMITS.relatedRows;
      const q = relatedRows(type, rel.key, rel.target, id, scope, limit, SEARCH_LIMITS.countCap);
      const related = await tx.query(q.rows.sql, q.rows.params);
      const items = related.rows.map((r: Record<string, unknown>) => shapeRow(rel.target, r));
      const total =
        rel.cardinality === 'one' || items.length < limit
          ? items.length
          : Number((await tx.query(q.count.sql, q.count.params)).rows[0]?.n ?? items.length);
      relations.push({
        key: rel.key,
        target: rel.target,
        cardinality: rel.cardinality,
        total,
        items,
      });
    }

    await logAccess(tx, scope, 'view', [type], id, null);
    return { item, relations, hiddenRelations };
  });
}
