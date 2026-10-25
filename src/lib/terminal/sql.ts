// The Query Tool in the browser: what it can query, a run's answer and the
// history (src/server/terminal/sqlService.ts). Runs are done by the worker;
// the browser starts one and waits for its answer.

import { TerminalApiError, terminalApi } from './client';
import type { ErpTable } from './erpTables';

export type SqlMode = 'run' | 'explain' | 'analyze';

export interface SqlTargets {
  canQueryDatasets: boolean;
  canQueryConnections: boolean;
  twoFactor: boolean;
  datasets: {
    id: string;
    name: string;
    folder: string;
    rows: number;
    columns: { name: string; type: string; sensitive: boolean }[];
  }[];
  connections: {
    id: string;
    name: string;
    status: string;
    host: string | null;
    database: string | null;
    last_tested_at: string | null;
    last_error_key: string | null;
  }[];
  /** The Terminal's own ERP and the ERPs it is linked to (src/lib/terminal/erpTables.ts). */
  erps: {
    id: string;
    name: string;
    own: boolean;
    member: boolean;
    twoFactorOk: boolean;
    /** The ERP's lists the member may read there. */
    tables: ErpTable[];
  }[];
}

export interface SqlError {
  code?: string | null;
  message?: string;
  position?: number | null;
  hint?: string | null;
  detail?: string | null;
  /** PrintStream's own reason (the worker, a permission, a time limit). */
  key?: string;
}

export interface SqlMessage {
  severity: string;
  text?: string;
  key?: string;
  vars?: Record<string, string | number>;
}

export interface SqlResult {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  mode: SqlMode;
  connectionId: string | null;
  erpWorkspaceId: string | null;
  targetName: string;
  columns: { name: string; type: string }[] | null;
  rows: unknown[][] | null;
  rowCount: number | null;
  truncated: 'rows' | 'size' | null;
  messages: SqlMessage[];
  notifications: { channel: string; payload: string }[];
  error: SqlError | null;
  durationMs: number | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  expired: boolean;
}

export interface SqlHistoryEntry {
  id: string;
  sql: string;
  mode: SqlMode;
  status: string;
  connectionId: string | null;
  erpWorkspaceId: string | null;
  targetName: string;
  rowCount: number | null;
  durationMs: number | null;
  createdAt: string | null;
}

export const sqlTargets = (workspaceId: string) =>
  terminalApi<SqlTargets>('sql.targets', { workspaceId });

export const sqlHistory = (workspaceId: string) =>
  terminalApi<SqlHistoryEntry[]>('sql.history', { workspaceId });

export const sqlResult = (id: string) => terminalApi<SqlResult>('sql.result', { id });

const done = (r: SqlResult) => r.status !== 'queued' && r.status !== 'running';

/**
 * Starts a run and waits for its answer. `onStarted` gets the job (to cancel
 * it); `signal` stops waiting (the run itself is cancelled with the job).
 */
export async function runSql(
  args: {
    workspaceId: string;
    connectionId: string | null;
    erpWorkspaceId?: string | null;
    sql: string;
    mode: SqlMode;
  },
  options: {
    onStarted?: (ids: { runId: string; jobId: string }) => void;
    onState?: (status: SqlResult['status']) => void;
    signal?: AbortSignal;
  } = {}
): Promise<SqlResult> {
  const ids = await terminalApi<{ runId: string; jobId: string }>('sql.run', args);
  options.onStarted?.(ids);
  // The worker answers within the time limit (60 s) plus loading the data.
  const deadline = Date.now() + 180_000;
  for (let i = 0; Date.now() < deadline; i += 1) {
    await new Promise((r) => setTimeout(r, i < 10 ? 250 : i < 30 ? 500 : 1000));
    if (options.signal?.aborted) throw new TerminalApiError('cancelled');
    const r = await sqlResult(ids.runId);
    options.onState?.(r.status);
    if (done(r)) return r;
  }
  throw new TerminalApiError('workerSlow');
}

export const cancelSqlJob = (jobId: string) => terminalApi('job.cancel', { id: jobId });
