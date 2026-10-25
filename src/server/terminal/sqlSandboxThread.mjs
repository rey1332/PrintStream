// One Query Tool run over a Terminal's datasets, in a thread of its own: a new
// in-memory PostgreSQL (PGlite) gets copies of the datasets (rows the member
// may see, already masked), runs the query read-only, answers and ends. The
// thread is ended after the answer, on cancel and at the time limit
// (sqlJobs.ts), so a query never reaches PrintStream's database and nothing
// outlives it.
//
// Plain JavaScript: worker threads do not get the worker's TypeScript loader.

import { parentPort, workerData } from 'node:worker_threads';
import { PGlite } from '@electric-sql/pglite';
import { CURSOR_PREFIX, CURSOR_RE, EXPLAIN_PREFIX, errorOf, shift } from './sqlSandbox.mjs';

/** Dataset column types as PostgreSQL types. */
const PG_TYPES = {
  text: 'text',
  integer: 'bigint',
  decimal: 'numeric',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamptz',
  json: 'jsonb',
  // An ERP list's ids (src/lib/terminal/erpTables.ts).
  uuid: 'uuid',
};
// Dates and times as PostgreSQL writes them (as pgAdmin shows them), not as
// JavaScript dates: date, time, timestamp, timestamptz, timetz, interval.
const AS_TEXT = Object.fromEntries(
  [1082, 1083, 1114, 1184, 1266, 1186].map((oid) => [oid, (v) => v])
);

/** @param {string} name */
const quote = (name) => `"${name.replace(/"/g, '""')}"`;

/**
 * @param {{
 *   tables: { name: string; columns: { name: string; type: string }[]; rows: Record<string, unknown>[] }[];
 *   sql: string;
 *   mode: 'run' | 'explain' | 'analyze';
 *   maxRows: number;
 * }} input
 */
async function main(input) {
  const db = await PGlite.create();
  // PGlite turns sequential scans off; plans as on an ordinary PostgreSQL server.
  await db.exec('SET enable_seqscan = on');
  try {
    for (const t of input.tables) {
      const cols = t.columns
        .map((c) => `${quote(c.name)} ${PG_TYPES[c.type] ?? 'text'}`)
        .join(', ');
      await db.exec(`CREATE TABLE ${quote(t.name)} (${cols})`);
      for (let i = 0; i < t.rows.length; i += 5000) {
        await db.query(
          `INSERT INTO ${quote(t.name)} SELECT * FROM jsonb_populate_recordset(NULL::${quote(t.name)}, $1::jsonb)`,
          [JSON.stringify(t.rows.slice(i, i + 5000))]
        );
      }
      await db.exec(`ANALYZE ${quote(t.name)}`);
    }
  } catch (e) {
    await db.close().catch(() => undefined);
    return { ok: false, stage: 'load', error: errorOf(e) };
  }

  const sql = input.sql.trim().replace(/;\s*$/, '');
  const text = input.mode === 'run' ? sql : `${EXPLAIN_PREFIX[input.mode]}${sql}`;
  const started = performance.now();
  // What was put before the query: error positions are given in the query itself.
  let prefix = text.length - sql.length;
  try {
    await db.exec('BEGIN TRANSACTION READ ONLY');
    let r;
    if (input.mode === 'run' && CURSOR_RE.test(sql)) {
      prefix = CURSOR_PREFIX.length;
      await db.query(`${CURSOR_PREFIX}${sql}`);
      r = await db.query(`FETCH ${input.maxRows + 1} FROM ps_query`, [], {
        rowMode: 'array',
        parsers: AS_TEXT,
      });
    } else {
      r = await db.query(text, [], { rowMode: 'array', parsers: AS_TEXT });
    }
    const fields = r.fields;
    /** @type {unknown[][]} */
    let rows = r.rows;
    const more = rows.length > input.maxRows;
    if (more) rows = rows.slice(0, input.maxRows);
    const ms = Math.round(performance.now() - started);
    const oids = [...new Set(fields.map((f) => f.dataTypeID))];
    const names = new Map(
      (
        await db.query(
          'SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1)',
          [oids]
        )
      ).rows.map((x) => [x.oid, x.name])
    );
    await db.exec('ROLLBACK');
    return {
      ok: true,
      columns: fields.map((f) => ({
        name: f.name,
        type: names.get(f.dataTypeID) ?? String(f.dataTypeID),
      })),
      rows: rows.map((row) => row.map(plain)),
      more,
      ms,
      messages: [],
    };
  } catch (e) {
    return {
      ok: false,
      stage: 'query',
      error: shift(errorOf(e), prefix),
      ms: Math.round(performance.now() - started),
    };
  } finally {
    await db.close().catch(() => undefined);
  }
}

/**
 * A value as JSON keeps it: NULL stays null, dates as ISO text, objects as JSON text.
 * @param {unknown} v
 */
function plain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return `\\x${Buffer.from(v).toString('hex')}`;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v;
}

if (parentPort && workerData) {
  main(workerData).then(
    (out) => parentPort?.postMessage(out),
    (e) => parentPort?.postMessage({ ok: false, stage: 'load', error: errorOf(e) })
  );
}
