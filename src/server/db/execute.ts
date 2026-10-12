import type { RequestSpec, RestError, RestResult } from '@/lib/db/spec';
import { loadCatalog, type Catalog } from './catalog';
import { CompileError, compile } from './compile';
import type { Executor, SqlTx } from './executor';

export interface RequestIdentity {
  userId: string;
  email: string;
  aal: 'aal1' | 'aal2';
  /** The sign-in session (claim `sid`): admin checks and the security log use it. */
  sessionId?: string;
}

const STATEMENT_TIMEOUT = '15s';

const catalogs = new WeakMap<Executor, Promise<Catalog>>();

export function getCatalog(executor: Executor): Promise<Catalog> {
  let catalog = catalogs.get(executor);
  if (!catalog) {
    catalog = executor.transaction((tx) => loadCatalog(tx));
    catalogs.set(executor, catalog);
    catalog.catch(() => catalogs.delete(executor));
  }
  return catalog;
}

export function resetCatalog(executor: Executor): void {
  catalogs.delete(executor);
}

class SingleRowError extends Error {
  readonly rows: number;

  constructor(rows: number) {
    super('JSON object requested, multiple (or no) rows returned');
    this.rows = rows;
  }
}

function errorResult(error: RestError, status: number): RestResult {
  return { data: null, error, count: null, status };
}

function statusFor(code: string, signedIn: boolean): number {
  if (code === '42501') return signedIn ? 403 : 401;
  if (code === '23505' || code === '23503') return 409;
  if (code === 'PGRST116') return 406;
  if (code === 'P0001' || code.startsWith('22') || code.startsWith('23')) return 400;
  if (code === '57014') return 504;
  return 500;
}

export async function beginAsUser(
  tx: SqlTx,
  identity: RequestIdentity | null,
  path: string,
  method: string,
  catalog: Catalog
): Promise<void> {
  await tx.query(identity ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE anon');
  const claims = identity
    ? {
        sub: identity.userId,
        email: identity.email,
        role: 'authenticated',
        aal: identity.aal,
        ...(identity.sessionId ? { sid: identity.sessionId } : {}),
      }
    : { role: 'anon' };
  await tx.query(
    `select set_config('request.jwt.claims', $1, true), set_config('request.path', $2, true),
            set_config('request.method', $3, true), set_config('statement_timeout', $4, true)`,
    [JSON.stringify(claims), path, method, STATEMENT_TIMEOUT]
  );
  if (catalog.functions.has('erp_check_request'))
    await tx.query('select public.erp_check_request()');
}

// ─── Data-access log (20261012000033) ───────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Functions that only describe the session or write logs themselves: not data access.
const UNLOGGED_FUNCTIONS = new Set([
  'erp_check_request',
  'erp_session_aal',
  'erp_mfa_satisfied',
  'erp_workspace_role',
  'erp_has_permission',
  'erp_can_read',
  'erp_my_permissions',
  'erp_my_workspaces',
  'erp_my_workspace_access',
  'erp_my_suspended_workspaces',
  'erp_my_mfa_required_workspaces',
  'erp_my_workspace_modules',
  'erp_my_terminals',
  'ps_my_spaces',
  'erp_my_workspace_quota',
  'erp_my_announcements',
  'erp_my_grantable_roles',
  'erp_my_termination',
  'erp_log_access',
  'erp_log_data_access',
  'erp_data_access_log',
  'api_rate_limit_hit',
]);

/** The workspace a request is about: its workspace_id filter, or the p_workspace_id argument. */
export function requestWorkspace(spec: RequestSpec): string | null {
  if (spec.kind === 'rpc') {
    const value = spec.args?.p_workspace_id;
    return typeof value === 'string' && UUID_RE.test(value) ? value : null;
  }
  for (const f of spec.filters ?? []) {
    if (
      f &&
      (f as { column?: string }).column === 'workspace_id' &&
      (f as { op?: string }).op === 'eq'
    ) {
      const value = (f as { value?: unknown }).value;
      if (typeof value === 'string' && UUID_RE.test(value)) return value;
    }
  }
  if (spec.kind !== 'select') {
    const values = (spec as { values?: unknown }).values;
    const first = Array.isArray(values) ? values[0] : values;
    const ws = (first as { workspace_id?: unknown } | undefined)?.workspace_id;
    if (typeof ws === 'string' && UUID_RE.test(ws)) return ws;
  }
  return null;
}

export function accessEntry(
  spec: RequestSpec,
  rows: number | null
): { objectId: string; operation: 'query' | 'write' | 'call'; rows: number | null } | null {
  if (spec.kind === 'rpc') {
    if (UNLOGGED_FUNCTIONS.has(spec.fn)) return null;
    return { objectId: spec.fn, operation: 'call', rows };
  }
  return { objectId: spec.table, operation: spec.kind === 'select' ? 'query' : 'write', rows };
}

/** One entry per request, in its transaction; a logging problem never fails the request. */
async function logAccess(tx: SqlTx, spec: RequestSpec, data: unknown, count: number | null) {
  const rows = Array.isArray(data) ? data.length : data === null || data === undefined ? 0 : 1;
  const entry = accessEntry(spec, count ?? rows);
  if (!entry) return;
  await tx.query('SAVEPOINT data_access_log');
  try {
    await tx.query(
      'select public.erp_log_data_access($1::uuid, $2, $3, $4, $5::int, $6::text[], null, null)',
      [requestWorkspace(spec), 'erp_entity', entry.objectId, entry.operation, entry.rows, []]
    );
    await tx.query('RELEASE SAVEPOINT data_access_log');
  } catch {
    // Not a member (personal mode without workspace), or the log is not installed yet.
    await tx.query('ROLLBACK TO SAVEPOINT data_access_log');
  }
}

export async function executeSpec(
  executor: Executor,
  identity: RequestIdentity | null,
  spec: RequestSpec
): Promise<RestResult> {
  let catalog: Catalog;
  try {
    catalog = await getCatalog(executor);
  } catch {
    return errorResult(
      { message: 'The database is not available', code: 'PGRST000', details: null, hint: null },
      503
    );
  }

  let compiled;
  try {
    compiled = compile(catalog, spec);
  } catch (error) {
    if (error instanceof CompileError) {
      return errorResult(
        { message: error.message, code: error.code, details: null, hint: null },
        error.status
      );
    }
    return errorResult(
      { message: (error as Error).message, code: 'PGRST100', details: null, hint: null },
      400
    );
  }

  const path = spec.kind === 'rpc' ? `/rpc/${spec.fn}` : `/${spec.table}`;
  const method =
    spec.kind === 'select'
      ? 'GET'
      : spec.kind === 'insert' || spec.kind === 'upsert' || spec.kind === 'rpc'
        ? 'POST'
        : spec.kind === 'update'
          ? 'PATCH'
          : 'DELETE';

  try {
    return await executor.transaction(async (tx) => {
      await beginAsUser(tx, identity, path, method, catalog);
      const result = await tx.query(compiled.sql, compiled.params);
      const row = result.rows[0] ?? {};
      let count: number | null = null;
      if (compiled.countSql) {
        const counted = await tx.query(compiled.countSql, compiled.countParams ?? []);
        count = Number(counted.rows[0]?.n ?? 0);
      } else if (spec.count === 'exact' && row.n !== undefined) {
        count = Number(row.n);
      }

      let data: unknown = null;
      if (compiled.shape !== 'none' && typeof row.body === 'string') data = JSON.parse(row.body);
      else if (compiled.shape === 'value' && row.body === null) data = null;

      if (spec.single) {
        const rows = Array.isArray(data) ? data : data === null ? [] : [data];
        // Mutations: PostgREST checks the affected rows even without a body.
        const affected =
          compiled.shape === 'none' && row.n !== undefined ? Number(row.n) : rows.length;
        if (affected > 1 || (affected === 0 && spec.single === 'one'))
          throw new SingleRowError(affected);
        data = compiled.shape === 'none' ? null : (rows[0] ?? null);
      }

      const status =
        spec.kind === 'insert' || spec.kind === 'upsert'
          ? 201
          : data === null && compiled.shape === 'none'
            ? 204
            : 200;
      if (identity && catalog.functions.has('erp_log_data_access'))
        await logAccess(
          tx,
          spec,
          data,
          compiled.shape === 'none' && row.n !== undefined ? Number(row.n) : count
        );
      return { data, error: null, count, status } satisfies RestResult;
    });
  } catch (error) {
    if (error instanceof SingleRowError) {
      return errorResult(
        {
          message: error.message,
          code: 'PGRST116',
          details: `The result contains ${error.rows} rows`,
          hint: null,
        },
        406
      );
    }
    return errorResult(...redactDbError(error, identity !== null));
  }
}

export function redactDbError(error: unknown, signedIn: boolean): [RestError, number] {
  const e = error as { code?: string; message?: string };
  const code = typeof e?.code === 'string' ? e.code : 'PGRST000';
  const status = statusFor(code, signedIn);
  if (status >= 500) {
    console.error('[db]', code);
    const message =
      status === 504 ? 'The request took too long' : 'The request could not be completed';
    return [{ message, code, details: null, hint: null }, status];
  }
  return [{ message: e?.message ?? 'Database error', code, details: null, hint: null }, status];
}
