// Another PostgreSQL database as a TERMINAL source (20261012000042).
//
//  * The host is checked like an ERP's (src/server/connectors/http.ts): public
//    addresses only, unless ETNA allows the host or network; the client
//    connects to the checked address, so DNS cannot be switched afterwards.
//  * TLS with the certificate verified (system CAs, or the CA certificate
//    given with the connection); "verify-ca" skips only the host name check;
//    no TLS only for an allowed internal host.
//  * Every read is in a read-only transaction (the session's default too),
//    with a statement time limit; a query is sent with the extended protocol,
//    which takes one statement only.
//  * Errors are reported by kind; the database's own message (which can
//    contain data) is not kept.

import net from 'node:net';
import pg from 'pg';
import {
  columnTypeOf,
  quoteIdent,
  readSql,
  sourceSelect,
  type DbColumn,
  type DbSource,
} from '@/lib/terminal/dbSource';
import { TerminalError } from '@/server/terminal/session';
import { checkHost } from './http';
import { MAX_PAGES, type Adapter, type ConnectorContext, type Row } from './types';

const PAGE = 1000;
const STATEMENT_MS = 300_000;

/** PostgreSQL's "2026-10-01 08:00:00.5+07" as ISO 8601 ("2026-10-01T08:00:00.5+07:00"). */
export function isoTimestamp(v: string): string {
  const m =
    /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?)(?:([+-]\d\d)(?::?(\d\d))?(?::\d\d)?)?$/.exec(v);
  if (!m) return v;
  return `${m[1]}T${m[2]}${m[3] ? `${m[3]}:${m[4] ?? '00'}` : ''}`;
}

// Values as PostgreSQL writes them (big numbers stay exact as text), except
// booleans and small numbers, and timestamps as ISO 8601. Parsers are given
// here, not taken from pg's global ones, which the app changes for its own use.
const NATIVE = new Set([16, 21, 23, 700, 701]);
const types = {
  getTypeParser: (oid: number, format?: any) =>
    NATIVE.has(oid)
      ? pg.types.getTypeParser(oid, format)
      : oid === 1114 || oid === 1184
        ? isoTimestamp
        : (v: string) => v,
};

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/** A database or network error as a TerminalError the screens explain. */
export function pgFailure(e: any): TerminalError {
  if (e instanceof TerminalError) return e;
  const code = String(e?.code ?? '');
  if (code === '28P01' || code === '28000') return new TerminalError('authFailed');
  if (code === '3D000' || code === '42P01' || code === '3F000' || code === '42703')
    return new TerminalError('notFoundRemote');
  if (code === '42501') return new TerminalError('remoteForbidden');
  if (code === '25006') return new TerminalError('queryWrites');
  if (code === '57014') return new TerminalError('timeout');
  if (code === '53300' || code.startsWith('57P') || code.startsWith('08'))
    return new TerminalError('remoteDown');
  if (code.startsWith('42') || code.startsWith('22') || code === '0A000')
    return new TerminalError('queryInvalid');
  if (TLS_CODES.has(code)) return new TerminalError('tlsFailed');
  if (/does not support SSL/i.test(String(e?.message))) return new TerminalError('tlsUnsupported');
  if (NETWORK_CODES.has(code) || /timeout|terminated/i.test(String(e?.message)))
    return new TerminalError('remoteDown');
  return new TerminalError('failed');
}

/** A signed-in client for the connection (closed by the caller). */
export async function openPg(ctx: ConnectorContext): Promise<pg.Client> {
  const cfg = ctx.config;
  const host = String(cfg.host ?? '').trim();
  if (!host) throw new TerminalError('fieldRequired', { field: 'host' });
  const port = cfg.port ? Number(cfg.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new TerminalError('fieldInvalid', { field: 'port' });
  const target = await checkHost(host, ctx.privateHosts, port);
  const mode = cfg.ssl ?? 'verify-full';
  if (mode === 'disable' && !target.internal) throw new TerminalError('tlsRequired');
  if (mode === 'verify-ca' && !cfg.ca_pem)
    throw new TerminalError('fieldRequired', { field: 'ca_pem' });
  const client = new pg.Client({
    host: target.address,
    port,
    database: String(cfg.database ?? ''),
    user: String(cfg.username ?? ''),
    password: String(ctx.secret.password ?? ''),
    ssl:
      mode === 'disable'
        ? false
        : {
            rejectUnauthorized: true,
            ...(cfg.ca_pem ? { ca: String(cfg.ca_pem) } : {}),
            // The name to verify (and send as SNI), though the address is connected to.
            ...(net.isIP(host) ? {} : { servername: host }),
            ...(mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
          },
    connectionTimeoutMillis: 15_000,
    query_timeout: STATEMENT_MS + 10_000,
    statement_timeout: STATEMENT_MS,
    application_name: 'PrintStream TERMINAL',
    options: '-c default_transaction_read_only=on -c idle_in_transaction_session_timeout=600000',
    types,
  } as pg.ClientConfig);
  // A dropped connection surfaces through the query that was running.
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (e) {
    await client.end().catch(() => undefined);
    throw pgFailure(e);
  }
  return client;
}

async function withPg<T>(ctx: ConnectorContext, fn: (client: pg.Client) => Promise<T>) {
  const client = await openPg(ctx);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    throw pgFailure(e);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export const MAX_TABLES = 500;

/** Tables and views the user may read (for picking one). */
export function listTables(ctx: ConnectorContext) {
  return withPg(ctx, async (client) => {
    const { rows } = await client.query(
      `SELECT table_schema AS schema, table_name AS name, table_type = 'VIEW' AS view
         FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg\\_%'
        ORDER BY table_schema = 'public' DESC, 1, 2
        LIMIT ${MAX_TABLES + 1}`
    );
    return { tables: rows.slice(0, MAX_TABLES), truncated: rows.length > MAX_TABLES };
  });
}

/** The columns a table or query gives (and a table's one-column primary key). */
export function describeSource(ctx: ConnectorContext, source: DbSource) {
  return withPg(ctx, async (client) => {
    const res: pg.QueryResult = await client.query({
      text: `SELECT * FROM (${sourceSelect(source)}) AS src LIMIT 0`,
      queryMode: 'extended',
    } as any);
    const names = res.fields.map((f) => f.name);
    if (new Set(names).size !== names.length) throw new TerminalError('duplicateColumns');
    const typeNames = new Map<number, string>(
      (
        await client.query(
          'SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1)',
          [[...new Set(res.fields.map((f) => f.dataTypeID))]]
        )
      ).rows.map((r: any) => [r.oid, r.name])
    );
    let pk: string[] = [];
    if (source.mode === 'table')
      pk = (
        await client.query(
          `SELECT a.attname AS name
             FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
            WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary`,
          [quoteIdent(source.schema), quoteIdent(source.table)]
        )
      ).rows.map((r: any) => r.name);
    const columns: DbColumn[] = res.fields.map((f) => ({
      name: f.name,
      type: columnTypeOf(f.dataTypeID),
      pgType: typeNames.get(f.dataTypeID) ?? String(f.dataTypeID),
      ...(pk.length === 1 && pk[0] === f.name ? { primaryKey: true } : {}),
    }));
    return { columns, key: pk.length === 1 ? pk[0] : null };
  });
}

/**
 * The rows of a source in pages, through a cursor in one read-only
 * transaction (one consistent snapshot). With `since`, only rows whose
 * "changed" column is at or after it.
 */
export async function* readSource(
  ctx: ConnectorContext,
  source: DbSource,
  since: string | null
): AsyncGenerator<Row[]> {
  const client = await openPg(ctx);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const incremental = since !== null && !!source.changed;
    await client.query({
      text: `DECLARE etna_sync NO SCROLL CURSOR FOR ${readSql(source, incremental)}`,
      values: incremental ? [since] : [],
      queryMode: 'extended',
    } as any);
    for (let page = 0; page < MAX_PAGES; page += 1) {
      await ctx.beat();
      const { rows } = await client.query(`FETCH ${PAGE} FROM etna_sync`);
      if (rows.length) yield rows.map(plainRow);
      if (rows.length < PAGE) break;
    }
    await client.query('COMMIT');
  } catch (e) {
    throw pgFailure(e);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** JSON and arrays as text, so the dataset's types decide. */
function plainRow(r: Row): Row {
  for (const [k, v] of Object.entries(r))
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) r[k] = JSON.stringify(v);
  return r;
}

export const postgres: Adapter = {
  test: (ctx) =>
    withPg(ctx, async (client) => {
      const { rows } = await client.query(
        "SELECT current_setting('server_version') AS v, current_database() AS db"
      );
      return { version: `PostgreSQL ${String(rows[0].v).split(' ')[0]}`, database: rows[0].db };
    }),
  // eslint-disable-next-line require-yield
  async *read() {
    // A database is read by table or query (readSource), not by ERP list.
    throw new TerminalError('invalid');
  },
};
