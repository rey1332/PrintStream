// Terminal connector jobs in the worker (20261012000041, 042, 046-048):
// testing a connection, finishing (or revoking) an OAuth authorisation,
// describing a database's tables and columns, an API's endpoints, a site's
// pages or an MCP server's tools, and syncing one ERP list (or a database's
// table or query, an API endpoint, a website source, or an MCP tool or
// resource) into its dataset. Rows are written as the user the job belongs to, through
// the same row functions as imports (row-level security, quotas, logs).

import {
  CONNECTORS,
  isConnectorKind,
  type ConnectorKind,
  type ObjectKey,
} from '@/lib/terminal/connectors';
import { parseDbSource } from '@/lib/terminal/dbSource';
import { parseRestSource } from '@/lib/terminal/restSource';
import { parseWebSource } from '@/lib/terminal/webSource';
import { parseMcpSource } from '@/lib/terminal/mcpSource';
import { ADAPTERS } from '@/server/connectors';
import { accurateExchangeCode } from '@/server/connectors/accurate';
import { GuardedHttp } from '@/server/connectors/http';
import { describeSource, listTables, readSource } from '@/server/connectors/postgres';
import {
  describeRest,
  listOperations,
  readRest,
  restExchangeCode,
  restRevoke,
} from '@/server/connectors/rest';
import { collectWeb, describeWeb } from '@/server/connectors/web';
import { McpClient, describeMcp, inThousands, readMcpOnce } from '@/server/connectors/mcp';
import type { ConnectorContext } from '@/server/connectors/types';
import type { Executor } from '@/server/db/executor';
import { openJson, sealJson } from '@/server/vault';
import { loadDataset, shapeRow, writeBatch, type Reject } from './datasets';
import { TerminalError, asUser, type RequestIdentity } from './session';

type Db = (sql: string, params?: unknown[]) => Promise<any[]>;

export interface ConnectorJobEnv {
  db: Db;
  executor: Executor;
  identity: RequestIdentity;
  beat: () => Promise<boolean>;
}

export async function connection(env: ConnectorJobEnv, id: unknown) {
  const [row] = await env.db('select ps_worker.connection_get($1) as c', [id]);
  const c = row?.c;
  if (!c) throw new TerminalError('notFound');
  if (!c.terminal_on) throw new TerminalError('terminal_off');
  if (!isConnectorKind(c.kind)) throw new TerminalError('invalid');
  return c as {
    id: string;
    workspace_id: string;
    kind: ConnectorKind;
    name: string;
    config: Record<string, any>;
    secret: string | null;
    private_hosts: string[];
  };
}

export function contextOf(
  env: ConnectorJobEnv,
  c: Awaited<ReturnType<typeof connection>>
): ConnectorContext {
  const secret = c.secret ? openJson<Record<string, any>>(c.secret) : {};
  // The system's own origin: a tunnel's access token goes there only.
  let origin: string | null = null;
  try {
    origin = new URL(String(c.config.base_url ?? c.config.url ?? c.config.mcp_url ?? '')).origin;
  } catch {
    origin = null;
  }
  const access =
    origin && c.config.cf_access_client_id && secret.cf_access_client_secret
      ? {
          origin,
          headers: {
            'CF-Access-Client-Id': String(c.config.cf_access_client_id),
            'CF-Access-Client-Secret': String(secret.cf_access_client_secret),
          },
        }
      : null;
  const ctx: ConnectorContext = {
    http: new GuardedHttp({
      privateHosts: c.private_hosts ?? [],
      fingerprint256: c.config.tls_fingerprint || null,
      clientCert: c.config.client_cert_pem || null,
      clientKey: secret.client_key_pem || null,
      originHeaders: access,
      // Websites are read politely: one request a second at most.
      rate: c.kind === 'web' ? 1 : undefined,
    }),
    privateHosts: c.private_hosts ?? [],
    config: { ...c.config },
    secret,
    saveSecret: async (next) => {
      await env.db('select ps_worker.connection_update($1, null, null, $2, null)', [
        c.id,
        sealJson(next),
      ]);
    },
    saveConfig: async (patch) => {
      Object.assign(ctx.config, patch);
      await env.db('select ps_worker.connection_update($1, null, null, null, $2::jsonb)', [
        c.id,
        JSON.stringify(patch),
      ]);
    },
    beat: async () => {
      if (await env.beat()) throw new TerminalError('cancelled');
    },
  };
  return ctx;
}

/** The person the job runs for must still be allowed to use connections. */
async function requireUse(env: ConnectorJobEnv, workspaceId: string) {
  await asUser(env.executor, env.identity, '/terminal/connector', async (tx) => {
    const { rows } = await tx.query(
      `select public.erp_has_permission($1, 'integrations.use') as ok`,
      [workspaceId]
    );
    if (rows[0].ok !== true) throw new TerminalError('forbidden');
  });
}

const statusFor = (code: string) =>
  code === 'authFailed' || code === 'needsAuth' ? 'needs_auth' : 'failed';

async function recordFailure(env: ConnectorJobEnv, connectionId: string, error: unknown) {
  const code = error instanceof TerminalError ? error.code : 'failed';
  await env
    .db('select ps_worker.connection_update($1, $2, $3, null, null)', [
      connectionId,
      statusFor(code),
      code,
    ])
    .catch(() => undefined);
}

/** An MCP server's tools as it lists them now, kept for approval (ps_mcp_tools). */
async function recordMcpTools(env: ConnectorJobEnv, connectionId: string, ctx: ConnectorContext) {
  const client = await McpClient.open(ctx);
  try {
    const tools = await client.tools();
    await env.db('select ps_worker.mcp_tools_seen($1, $2::jsonb)', [
      connectionId,
      JSON.stringify(tools),
    ]);
    return { tools, resources: await client.resources(), server: client.server };
  } finally {
    await client.close();
  }
}

/** Whether a tool is approved exactly as the server describes it now. */
const mcpApproved =
  (env: ConnectorJobEnv, connectionId: string) => async (name: string, hash: string) => {
    const [row] = await env.db('select ps_worker.mcp_tool_approved($1, $2, $3) as ok', [
      connectionId,
      name,
      hash,
    ]);
    return row?.ok === true;
  };

export async function testConnection(env: ConnectorJobEnv, payload: any) {
  const c = await connection(env, payload.connection_id);
  await requireUse(env, c.workspace_id);
  const ctx = contextOf(env, c);
  try {
    const info = await ADAPTERS[c.kind].test(ctx);
    if (c.kind === 'mcp') await recordMcpTools(env, c.id, ctx);
    await env.db('select ps_worker.connection_update($1, $2, null, null, $3::jsonb)', [
      c.id,
      'ok',
      JSON.stringify({ info }),
    ]);
    return { ok: true };
  } catch (error) {
    await recordFailure(env, c.id, error);
    throw error;
  }
}

/**
 * The authorisation code (sealed by the callback route) becomes tokens:
 * Accurate, or a REST API signed in with OAuth2 authorisation code. With
 * `revoke`, a REST API's tokens are revoked at the provider and forgotten.
 */
export async function finishOauth(env: ConnectorJobEnv, payload: any) {
  const c = await connection(env, payload.connection_id);
  const restCode = (c.kind === 'rest' || c.kind === 'mcp') && c.config.auth === 'oauth2_code';
  if (c.kind !== 'accurate' && !restCode) throw new TerminalError('invalid');
  const ctx = contextOf(env, c);
  if (payload.revoke === true) {
    if (!restCode) throw new TerminalError('invalid');
    await restRevoke(ctx);
    await env.db('select ps_worker.connection_update($1, $2, $3, null, null)', [
      c.id,
      'needs_auth',
      'needsAuth',
    ]);
    return { revoked: true };
  }
  try {
    const { code, redirect_uri, verifier } = openJson<{
      code: string;
      redirect_uri: string;
      verifier?: string | null;
    }>(String(payload.code ?? ''));
    if (restCode) await restExchangeCode(ctx, code, redirect_uri, verifier ?? null);
    else await accurateExchangeCode(ctx, code, redirect_uri);
    const info = await ADAPTERS[c.kind].test(ctx);
    await env.db('select ps_worker.connection_update($1, $2, null, null, $3::jsonb)', [
      c.id,
      'ok',
      JSON.stringify({ info }),
    ]);
    return { ok: true };
  } catch (error) {
    await recordFailure(env, c.id, error);
    throw error;
  }
}

/**
 * A database connection's tables (no source), or the columns of one table or
 * query; an API's endpoints from its OpenAPI description (no source), or the
 * columns and first rows of one endpoint. A query can be any read-only SQL,
 * and a POST can change things in a careless API, so describing either needs
 * what creating its sync needs: managing connections, with two-factor.
 */
export async function describe(env: ConnectorJobEnv, payload: any) {
  const c = await connection(env, payload.connection_id);
  const def = CONNECTORS[c.kind];
  if (!def.database && !def.rest && !def.web && !def.mcp) throw new TerminalError('invalid');
  await requireUse(env, c.workspace_id);
  const ctx = contextOf(env, c);
  if (def.mcp) {
    // No source: the tools (kept for approval) and resources; else one call.
    if (payload.source == null) return recordMcpTools(env, c.id, ctx);
    const call = parseMcpSource(payload.source);
    if (!call) throw new TerminalError('invalid');
    return describeMcp(ctx, call, mcpApproved(env, c.id));
  }
  if (def.web) {
    const page = parseWebSource(payload.source);
    if (!page) throw new TerminalError('invalid');
    return describeWeb(ctx, page);
  }
  if (payload.source == null) return def.rest ? listOperations(ctx) : listTables(ctx);
  const source = def.rest ? parseRestSource(payload.source) : parseDbSource(payload.source);
  if (!source) throw new TerminalError('invalid');
  if (
    (source.mode === 'query' && def.database) ||
    (source.mode === 'rest' && source.method === 'POST')
  )
    await asUser(env.executor, env.identity, '/terminal/connector', async (tx) => {
      const { rows } = await tx.query(
        `select public.erp_has_permission($1, 'integrations.manage') and public.erp_session_aal() = 'aal2' as ok`,
        [c.workspace_id]
      );
      if (rows[0].ok !== true) throw new TerminalError('mfaRequired');
    });
  return source.mode === 'rest' ? describeRest(ctx, source) : describeSource(ctx, source);
}

/** Rows already in memory, a thousand at a time (as a reader would give them). */
async function* inPages(rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 1000) yield rows.slice(i, i + 1000);
}

/** Whether a "changed" value is later than another (numbers, dates or text). */
export function later(a: unknown, b: unknown): boolean {
  if (b === null || b === undefined) return true;
  const x = String(a);
  const y = String(b);
  if (/^-?\d+$/.test(x) && /^-?\d+$/.test(y)) return BigInt(x) > BigInt(y);
  const tx = Date.parse(x);
  const ty = Date.parse(y);
  if (!Number.isNaN(tx) && !Number.isNaN(ty)) return tx > ty;
  return x > y;
}

/**
 * One ERP list (or a database's table or query) into its dataset.
 * Incremental runs ask only for rows changed since the last one and update
 * them by key; every few days (and always for ERPs without "changed since",
 * or tables without a key and a "changed" column) a full read updates every
 * row and then marks removed the rows the source no longer has.
 */
export async function runSync(env: ConnectorJobEnv, payload: any, jobId: string) {
  const [srow] = await env.db('select ps_worker.sync_get($1) as s', [payload.sync_id]);
  const sync = srow?.s;
  if (!sync) throw new TerminalError('notFound');
  const c = await connection(env, sync.connection_id);
  const object = sync.object as ObjectKey;
  const def = CONNECTORS[c.kind];
  const db = def.database ? parseDbSource(sync.source) : null;
  const api = def.rest ? parseRestSource(sync.source) : null;
  const site = def.web ? parseWebSource(sync.source) : null;
  const call = def.mcp ? parseMcpSource(sync.source) : null;
  if (
    def.database
      ? !db
      : def.rest
        ? !api
        : def.web
          ? !site
          : def.mcp
            ? !call
            : !def.objects.includes(object)
  )
    throw new TerminalError('invalid');
  const path = '/terminal/connector/sync';
  // ERP lists are keyed by id and changed by updated_at; a database or an API
  // by its chosen columns (an API also needs its "changed since" parameter).
  // A website is read in full every time (its change detection is a hash of everything).
  // An MCP call is made in full every time too.
  const chosen = db ?? api ?? site ?? call;
  const keyed = chosen ? !!chosen.key : true;
  const changedColumn = db ? db.changed : api ? api.changed : chosen ? null : 'updated_at';
  const canIncrement = db
    ? keyed && !!db.changed
    : api
      ? keyed && !!api.changed && !!api.since_param
      : chosen
        ? false
        : def.incremental.includes(object);

  let rows = 0;
  let removed = 0;
  const rejects: Reject[] = [];
  const lastFull = sync.last_full_at ? new Date(sync.last_full_at).getTime() : 0;
  const full =
    !sync.cursor?.since ||
    !canIncrement ||
    Date.now() - lastFull > Number(sync.full_every_days ?? 7) * 86_400_000;
  let newest: string | null = full ? null : sync.cursor.since;
  try {
    const ds = await asUser(env.executor, env.identity, path, (tx) =>
      loadDataset(tx, sync.dataset_id)
    );
    if (ds.status === 'provisioning' || ds.status === 'altering')
      throw new TerminalError('datasetNotReady');
    if (ds.status !== 'ready') throw new TerminalError('datasetFailed');
    const columns = ds.columns.filter((col) => col.provisioned && !col.hidden);
    const sourceId = full ? `sync:${jobId}` : `sync:${sync.id}`;
    const ctx = contextOf(env, c);
    const since = full ? null : sync.cursor.since;
    // A website: read everything first; when it is exactly as last time, nothing is written.
    let collected: Awaited<ReturnType<typeof collectWeb>> | null = null;
    if (site) {
      collected = await collectWeb(ctx, site);
      if (sync.cursor?.hash && sync.cursor.hash === collected.hash) {
        await env.db('select ps_worker.sync_finished($1, true, $2::jsonb, $3, 0, 0, null)', [
          sync.id,
          JSON.stringify(sync.cursor),
          true,
        ]);
        await env.db(`select ps_worker.connection_update($1, 'ok', null, null, null)`, [c.id]);
        return { rows: 0, removed: 0, rejected: 0, full: true, unchanged: true };
      }
    }
    // Without a key, rows are added and the older ones removed at the end; a
    // retried run first takes back what its earlier attempt added.
    if (!keyed)
      await asUser(env.executor, env.identity, path, (tx) =>
        tx.query('SELECT public.ps_rows_undo_source($1, $2)', [ds.id, sourceId])
      );
    const pages = db
      ? readSource(ctx, db, since)
      : api
        ? readRest(ctx, api, since)
        : collected
          ? inPages(collected.rows)
          : call
            ? inThousands((await readMcpOnce(ctx, call, mcpApproved(env, c.id))).rows)
            : ADAPTERS[c.kind].read(ctx, object, since);
    for await (const page of pages) {
      const batch: Record<string, unknown>[] = [];
      for (const r of page) {
        const shaped = shapeRow(columns, (col) => r[col.label], '.');
        if ('row' in shaped) batch.push(shaped.row);
        else if (rejects.length < 100)
          rejects.push({
            row: rows + batch.length + rejects.length + 1,
            reason: shaped.reason,
            column: shaped.column,
          });
        let u = changedColumn ? r[changedColumn] : null;
        if (u instanceof Date) u = u.toISOString();
        if ((typeof u === 'string' || typeof u === 'number') && later(u, newest))
          newest = String(u);
      }
      // Updated by key: a row read twice (an overlapping "since") is never doubled.
      rows += await asUser(env.executor, env.identity, path, (tx) =>
        writeBatch(tx, ds.id, batch, keyed ? 'upsert' : 'append', 'connector', sourceId)
      );
    }
    if (full)
      removed = await asUser(env.executor, env.identity, path, async (tx) =>
        Number(
          (await tx.query('SELECT public.ps_rows_finish_replace($1, $2) AS n', [ds.id, sourceId]))
            .rows[0].n
        )
      );
    // Without a key every row is new each time: "removed" is how many fewer there are.
    if (!keyed) removed = Math.max(0, removed - rows);
    await asUser(env.executor, env.identity, path, async (tx) => {
      await tx.query(
        `SELECT public.ps_record_lineage($1, 'connector', $2, 'dataset', $3, 'import', null, null)`,
        [c.workspace_id, `${c.id}:${chosen ? sync.id : object}`, ds.id]
      );
      await tx.query(
        `SELECT public.erp_log_data_access($1::uuid, 'dataset', $2, 'import', $3, '{}'::text[], null, $4::jsonb)`,
        [
          c.workspace_id,
          ds.id,
          rows,
          JSON.stringify({
            connection: c.name,
            kind: c.kind,
            object: sync.label ?? object,
            full,
            removed,
            rejected: rejects.length,
          }),
        ]
      );
    });
    await env.db('select ps_worker.sync_finished($1, true, $2::jsonb, $3, $4, $5, null)', [
      sync.id,
      JSON.stringify(
        collected ? { hash: collected.hash } : newest ? { since: newest } : (sync.cursor ?? null)
      ),
      full,
      rows,
      removed,
    ]);
    await env.db(`select ps_worker.connection_update($1, 'ok', null, null, null)`, [c.id]);
    return { rows, removed, rejected: rejects.length, full };
  } catch (error) {
    const code = error instanceof TerminalError ? error.code : 'failed';
    await env
      .db('select ps_worker.sync_finished($1, false, null, $2, $3, 0, $4)', [
        sync.id,
        full,
        rows,
        code,
      ])
      .catch(() => undefined);
    if (code === 'authFailed' || code === 'needsAuth') await recordFailure(env, c.id, error);
    throw error;
  }
}
