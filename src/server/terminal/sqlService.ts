// The Query Tool for the app's routes (db/migrations/20261012000058_terminal_query_tool.sql):
// what it can query, starting a run, its answer and the history. Runs are
// done by the worker (sqlJobs.ts); everything here is the member's own
// transaction, and the database decides who may run what.

import type { SqlTx } from '@/server/db/executor';
import { listDatasets } from './datasets';
import { TerminalError, asUser, isUuid } from './session';
import type { TerminalContext } from './service';

const PATH = '/terminal/sql';
const run = <T>(ctx: TerminalContext, fn: (tx: SqlTx) => Promise<T>) =>
  asUser(ctx.executor, ctx.identity, PATH, fn);
const uuid = (v: unknown) => {
  if (!isUuid(v)) throw new TerminalError('invalid');
  return v;
};
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const MODES = ['run', 'explain', 'analyze'];

/** What the connection selector and the object browser show. */
export async function sqlTargets(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  return run(ctx, async (tx) => {
    const [perm] = (
      await tx.query(
        `SELECT public.erp_has_permission($1, 'datasets.query') AS datasets,
                public.erp_has_permission($1, 'integrations.manage') AS connections,
                public.erp_session_aal() = 'aal2' AS two_factor`,
        [ws]
      )
    ).rows;
    const datasets = (await listDatasets(tx, ws))
      .filter((d) => d.status === 'ready' || d.status === 'altering')
      .map((d) => ({
        id: d.id,
        name: d.name,
        folder: d.folder,
        rows: d.rowCount,
        columns: d.columns
          .filter((c) => !c.hidden && c.provisioned)
          .map((c) => ({ name: c.label, type: c.type, sensitive: c.sensitive })),
      }));
    const connections = (
      await tx.query(
        `SELECT id, name, status, config->>'host' AS host, config->>'database' AS database, last_tested_at, last_error_key
           FROM public.ps_connections WHERE workspace_id = $1 AND kind = 'postgres' ORDER BY lower(name)`,
        [ws]
      )
    ).rows.map((c: any) => ({ ...c, last_tested_at: iso(c.last_tested_at) }));
    return {
      canQueryDatasets: perm.datasets === true,
      canQueryConnections: perm.connections === true,
      twoFactor: perm.two_factor === true,
      datasets,
      connections,
    };
  });
}

/** Starts a run: { runId, jobId }. */
export async function sqlRun(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  const connectionId = body.connectionId == null ? null : uuid(body.connectionId);
  const mode = MODES.includes(body.mode) ? body.mode : 'run';
  if (typeof body.sql !== 'string') throw new TerminalError('invalid');
  return run(ctx, async (tx) => {
    const [{ id }] = (
      await tx.query('SELECT public.ps_sql_run_start($1, $2, $3, $4) AS id', [
        ws,
        connectionId,
        body.sql,
        mode,
      ])
    ).rows;
    const [r] = (await tx.query('SELECT job_id FROM public.ps_sql_runs WHERE id = $1', [id])).rows;
    return { runId: id as string, jobId: r.job_id as string };
  });
}

/** A run's state and, while kept, its answer (the job's state too, for one that never started). */
export async function sqlResult(ctx: TerminalContext, body: any) {
  const id = uuid(body.id);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      `SELECT r.id, r.status, r.mode, r.connection_id, r.target_name, r.columns, r.rows, r.row_count, r.truncated,
              r.messages, r.notifications, r.error, r.duration_ms, r.created_at, r.started_at, r.finished_at,
              j.status AS job_status, j.error_key AS job_error
         FROM public.ps_sql_runs r LEFT JOIN public.ps_jobs j ON j.id = r.job_id
        WHERE r.id = $1`,
      [id]
    );
    const r = rows[0];
    if (!r) throw new TerminalError('notFound');
    // A job that ended before it ran the query (cancelled while waiting, the worker refused it).
    let status = r.status;
    if (
      (status === 'queued' || status === 'running') &&
      ['failed', 'cancelled'].includes(r.job_status)
    )
      status = r.job_status;
    return {
      id: r.id,
      status,
      mode: r.mode,
      connectionId: r.connection_id,
      targetName: r.target_name,
      columns: r.columns,
      rows: r.rows,
      rowCount: r.row_count,
      truncated: r.truncated,
      messages: r.messages ?? [],
      notifications: r.notifications ?? [],
      error: r.error ?? (r.job_error && status !== r.status ? { key: r.job_error } : null),
      durationMs: r.duration_ms,
      createdAt: iso(r.created_at),
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at),
      expired: r.status === 'succeeded' && r.rows === null,
    };
  });
}

/** The member's latest runs in this Terminal (newest first, without results). */
export async function sqlHistory(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  return run(ctx, async (tx) =>
    (
      await tx.query(
        `SELECT id, sql, mode, status, connection_id, target_name, row_count, duration_ms, created_at
           FROM public.ps_sql_runs WHERE workspace_id = $1 AND user_id = auth.uid()
          ORDER BY created_at DESC LIMIT 200`,
        [ws]
      )
    ).rows.map((r: any) => ({
      id: r.id as string,
      sql: r.sql as string,
      mode: r.mode as string,
      status: r.status as string,
      connectionId: r.connection_id as string | null,
      targetName: r.target_name as string,
      rowCount: r.row_count as number | null,
      durationMs: r.duration_ms as number | null,
      createdAt: iso(r.created_at),
    }))
  );
}
