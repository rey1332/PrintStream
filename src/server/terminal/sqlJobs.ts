// The Query Tool's runs (db/migrations/20261012000058_terminal_query_tool.sql),
// in the worker, as the member who asked:
//
//  * sql.datasets: the datasets the query names are read as the member
//    (masked, in the data-access log) into a PGlite in its own thread
//    (sqlSandboxThread.ts), which runs the query read-only and is ended.
//  * sql.connection: a PostgreSQL connection, in a read-only transaction with
//    a time limit; NOTICEs come back as messages.
//
// A query's own error (a typo, a missing column) is the run's answer, not a
// failed job: it is kept with the run, for the member only, for an hour.

import { Worker } from 'node:worker_threads';
import type pg from 'pg';
import { cleanQuery } from '@/lib/terminal/dbSource';
import { DATASET_READ_LIMIT } from '@/lib/workflow/runtime';
import { openPg } from '@/server/connectors/postgres';
import { connection, contextOf, type ConnectorJobEnv } from './connectorJobs';
import { listDatasets, readRows, visibleColumns, type DatasetInfo } from './datasets';
import { TerminalError, asUser } from './session';
import { CURSOR_PREFIX, CURSOR_RE, EXPLAIN_PREFIX, errorOf, shift } from './sqlSandbox.mjs';

export const MAX_RESULT_ROWS = 2000;
const MAX_RESULT_BYTES = 16_000_000;
const QUERY_MS = 60_000;
const MAX_LOADED_ROWS = 500_000;
const PATH = '/terminal/sql';

type Mode = 'run' | 'explain' | 'analyze';
interface Run {
  id: string;
  workspace_id: string;
  user_id: string;
  connection_id: string | null;
  sql: string;
  mode: Mode;
}
interface SqlError {
  code: string | null;
  message: string;
  position: number | null;
  hint: string | null;
  detail: string | null;
}
/** A database's own message (text), or one of PrintStream's (key and values, translated on screen). */
interface Message {
  severity: string;
  text?: string;
  key?: string;
  vars?: Record<string, string | number>;
}
interface Outcome {
  status: 'succeeded' | 'failed' | 'cancelled';
  columns?: { name: string; type: string }[];
  rows?: unknown[][];
  more?: boolean;
  messages: Message[];
  notifications?: { channel: string; payload: string }[];
  error?: SqlError | { key: string };
  ms?: number;
}

/** A job of the Query Tool: runs it and keeps the answer with the run. */
export async function runSqlJob(env: ConnectorJobEnv, job: { id: string; payload: any }) {
  const [row] = await env.db('select ps_worker.sql_run_begin($1, $2) as r', [
    job.payload?.run_id,
    job.id,
  ]);
  const run = row?.r as Run | null;
  if (!run) return { skipped: true };
  if (run.user_id !== env.identity.userId) throw new TerminalError('forbidden');

  const started = Date.now();
  let outcome: Outcome;
  try {
    outcome = run.connection_id ? await onConnection(env, run) : await onDatasets(env, run);
  } catch (e) {
    outcome = {
      status: e instanceof TerminalError && e.code === 'cancelled' ? 'cancelled' : 'failed',
      messages: [],
      error: { key: e instanceof TerminalError ? e.code : 'failed' },
    };
  }

  // The rows kept: at most MAX_RESULT_ROWS and MAX_RESULT_BYTES, and it says so.
  let rows = outcome.rows ?? null;
  let truncated: 'rows' | 'size' | null = outcome.more ? 'rows' : null;
  while (rows && rows.length > 1 && JSON.stringify(rows).length > MAX_RESULT_BYTES) {
    rows = rows.slice(0, Math.floor(rows.length / 2));
    truncated = 'size';
  }
  await env.db(
    'select ps_worker.sql_run_finish($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)',
    [
      run.id,
      outcome.status,
      outcome.columns ? JSON.stringify(outcome.columns) : null,
      rows ? JSON.stringify(rows) : null,
      rows ? rows.length : null,
      truncated,
      JSON.stringify(outcome.messages.slice(0, 200)),
      outcome.notifications?.length ? JSON.stringify(outcome.notifications.slice(0, 200)) : null,
      outcome.error ? JSON.stringify(outcome.error) : null,
      outcome.ms ?? Date.now() - started,
    ]
  );
  return { status: outcome.status, rows: rows?.length ?? 0 };
}

// ─── The Terminal's datasets ─────────────────────────────────────────────────

/** Whether the query names this dataset (quoted, or as a plain word). */
export function mentions(sql: string, name: string): boolean {
  const lower = sql.toLowerCase();
  const n = name.toLowerCase();
  if (lower.includes(`"${n.replace(/"/g, '""')}"`)) return true;
  if (!/^[a-z_][a-z0-9_$]*$/.test(n)) return false;
  return new RegExp(`(^|[^a-z0-9_$"])${n.replace(/\$/g, '\\$')}($|[^a-z0-9_$"])`).test(lower);
}

async function onDatasets(env: ConnectorJobEnv, run: Run): Promise<Outcome> {
  const messages: Message[] = [];
  const tables = await asUser(env.executor, env.identity, PATH, async (tx) => {
    const all = (await listDatasets(tx, run.workspace_id)).filter(
      (d) => (d.status === 'ready' || d.status === 'altering') && mentions(run.sql, d.name)
    );
    const out: { name: string; columns: { name: string; type: string }[]; rows: any[] }[] = [];
    let loaded = 0;
    for (const ds of all as DatasetInfo[]) {
      const ok = await tx.query(`SELECT public.ps_can_access_dataset($1, 'query') AS ok`, [ds.id]);
      if (ok.rows[0]?.ok !== true) {
        messages.push({ severity: 'WARNING', key: 'noAccess', vars: { name: ds.name } });
        continue;
      }
      const limit = Math.min(DATASET_READ_LIMIT, MAX_LOADED_ROWS - loaded);
      if (limit <= 0) {
        messages.push({
          severity: 'WARNING',
          key: 'notLoaded',
          vars: { name: ds.name, max: MAX_LOADED_ROWS },
        });
        continue;
      }
      const page = await readRows(tx, ds, { limit, operation: 'query' });
      const cols = visibleColumns(ds).filter((c) => c.provisioned);
      loaded += page.rows.length;
      messages.push({
        severity: page.total > page.rows.length ? 'WARNING' : 'INFO',
        key: page.total > page.rows.length ? 'partial' : 'loaded',
        vars: { name: ds.name, rows: page.rows.length, total: page.total },
      });
      out.push({
        name: ds.name,
        columns: cols.map((c) => ({ name: c.label, type: c.type })),
        rows: page.rows.map((r) =>
          Object.fromEntries(cols.map((c) => [c.label, (r as any)[c.physical] ?? null]))
        ),
      });
    }
    return out;
  });
  if (!tables.length) messages.push({ severity: 'INFO', key: 'noDatasets' });

  const answer: any = await inThread(
    { tables, sql: run.sql, mode: run.mode, maxRows: MAX_RESULT_ROWS },
    env.beat
  );
  if (!answer.ok)
    return {
      status: 'failed',
      messages,
      error: answer.error,
      ms: answer.ms,
    };
  return {
    status: 'succeeded',
    columns: answer.columns,
    rows: answer.rows,
    more: answer.more,
    messages: [...messages, ...answer.messages],
    ms: answer.ms,
  };
}

/** The sandbox thread's answer; ended on cancel and at the time limit. */
function inThread(input: unknown, beat: () => Promise<boolean>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sqlSandboxThread.mjs', import.meta.url), {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: 1536 },
    });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      clearInterval(watch);
      void worker.terminate();
      fn();
    };
    const limit = setTimeout(
      () => finish(() => resolve({ ok: false, error: { key: 'timeout' }, ms: QUERY_MS })),
      QUERY_MS + 30_000
    );
    const watch = setInterval(() => {
      void beat().then(
        (cancel) => cancel && finish(() => reject(new TerminalError('cancelled'))),
        () => undefined
      );
    }, 1000);
    worker.once('message', (m) => finish(() => resolve(m)));
    worker.once('error', (e) => finish(() => resolve({ ok: false, error: errorOf(e) })));
    worker.once('exit', (code) =>
      finish(() => resolve({ ok: false, error: { key: code ? 'sandboxStopped' : 'failed' } }))
    );
  });
}

// ─── A PostgreSQL connection ─────────────────────────────────────────────────

async function onConnection(env: ConnectorJobEnv, run: Run): Promise<Outcome> {
  const c = await connection(env, run.connection_id);
  if (c.kind !== 'postgres' || c.workspace_id !== run.workspace_id)
    throw new TerminalError('notFound');
  // Still allowed, with two-factor (as describing a query of the connection).
  await asUser(env.executor, env.identity, PATH, async (tx) => {
    const { rows } = await tx.query(
      `select public.erp_has_permission($1, 'integrations.manage') and public.erp_session_aal() = 'aal2' as ok`,
      [run.workspace_id]
    );
    if (rows[0].ok !== true) throw new TerminalError('mfaRequired');
  });

  const messages: Message[] = [];
  const notifications: { channel: string; payload: string }[] = [];
  const client: pg.Client = await openPg(contextOf(env, c));
  client.on('notice', (n: any) =>
    messages.push({
      severity: String(n.severity ?? 'NOTICE'),
      text: String(n.message ?? '').slice(0, 2000),
    })
  );
  client.on('notification', (n: any) =>
    notifications.push({ channel: String(n.channel), payload: String(n.payload ?? '') })
  );
  let cancelled = false;
  const watch = setInterval(() => {
    void env.beat().then(
      (cancel) => {
        if (cancel && !cancelled) {
          cancelled = true;
          // Ending the session ends the query on the server too.
          void client.end().catch(() => undefined);
        }
      },
      () => undefined
    );
  }, 1000);
  const sql = cleanQuery(run.sql);
  const started = Date.now();
  let prefix = 0;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${QUERY_MS}`);
    let res: pg.QueryResult<any[]>;
    let more = false;
    if (run.mode === 'run' && CURSOR_RE.test(sql)) {
      prefix = CURSOR_PREFIX.length;
      await client.query({ text: `${CURSOR_PREFIX}${sql}`, queryMode: 'extended' } as any);
      res = await client.query({
        text: `FETCH ${MAX_RESULT_ROWS + 1} FROM ps_query`,
        rowMode: 'array',
      });
    } else {
      const text = run.mode === 'run' ? sql : `${EXPLAIN_PREFIX[run.mode]}${sql}`;
      prefix = text.length - sql.length;
      res = await client.query({ text, rowMode: 'array', queryMode: 'extended' } as any);
    }
    const ms = Date.now() - started;
    let rows = (res.rows ?? []) as unknown[][];
    if (rows.length > MAX_RESULT_ROWS) {
      rows = rows.slice(0, MAX_RESULT_ROWS);
      more = true;
    }
    const fields = res.fields ?? [];
    const names = new Map<number, string>(
      fields.length
        ? (
            await client.query(
              'SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1)',
              [[...new Set(fields.map((f) => f.dataTypeID))]]
            )
          ).rows.map((r: any) => [r.oid, r.name])
        : []
    );
    await client.query('ROLLBACK');
    if (!fields.length && res.command)
      messages.push({
        severity: 'INFO',
        key: 'command',
        vars: { command: res.command, rows: res.rowCount ?? 0 },
      });
    await asUser(env.executor, env.identity, PATH, (tx) =>
      tx.query(
        `SELECT public.erp_log_data_access($1::uuid, 'connection', $2, 'query', $3, '{}'::text[], null, $4::jsonb)`,
        [run.workspace_id, c.id, rows.length, JSON.stringify({ name: c.name, via: 'query_tool' })]
      )
    );
    return {
      status: 'succeeded',
      columns: fields.map((f) => ({
        name: f.name,
        type: names.get(f.dataTypeID) ?? String(f.dataTypeID),
      })),
      rows: rows.map((r) => r.map(plain)),
      more,
      messages,
      notifications,
      ms,
    };
  } catch (e) {
    if (cancelled) return { status: 'cancelled', messages, notifications };
    const code = String((e as any)?.code ?? '');
    // The database's answer to the query (syntax, names, types, time limit…).
    if (/^[0-9A-Z]{5}$/.test(code))
      return {
        status: 'failed',
        messages,
        notifications,
        error: shift(errorOf(e), prefix),
        ms: Date.now() - started,
      };
    throw e;
  } finally {
    clearInterval(watch);
    await client.end().catch(() => undefined);
  }
}

function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `\\x${v.toString('hex')}`;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
