// Runs a pipeline code step (tf.code) in scripts/server/code-sandbox.mjs: a
// separate process started with an empty environment, the member's code
// inside QuickJS there. Used by the editor's run route and by the worker.
// The result is checked here before the pipeline goes on: an array of flat
// objects, within the row and column limits.

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { DataTable } from '@/lib/workflow/types';
import { WorkflowError } from '@/lib/workflow/errors';

export const CODE_TIMEOUT_MS = 10_000;
export const CODE_MEMORY_MB = 128;
export const CODE_MAX_ROWS = 100_000;
export const CODE_MAX_COLUMNS = 200;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface CodeSpec {
  code: string;
  table: DataTable;
  timeoutMs?: number;
}

type SandboxReply =
  | { ok: true; rows: unknown; logs?: string[] }
  | { ok: false; error: { kind: string; message: string; line?: number } };

function sandboxScript() {
  // The app's own folder (the release, or the checkout in development).
  return path.join(process.cwd(), 'scripts', 'server', 'code-sandbox.mjs');
}

/** The process, its input and its answer; never longer than the step's time plus a margin. */
function runSandbox(input: object, timeoutMs: number): Promise<SandboxReply> {
  return new Promise((resolve, reject) => {
    // Nothing of the server's environment: no database, keys or paths.
    const env = (
      process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? '' } : {}
    ) as NodeJS.ProcessEnv;
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=512', '--disallow-code-generation-from-strings', sandboxScript()],
      {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: path.dirname(sandboxScript()),
      }
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(() => resolve({ ok: false, error: { kind: 'timeout', message: 'stopped' } }));
    }, timeoutMs + 5_000);
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        done(() => resolve({ ok: false, error: { kind: 'result', message: 'too large' } }));
        return;
      }
      chunks.push(c);
    });
    child.stderr.on('data', () => {});
    child.on('error', (e) => done(() => reject(e)));
    child.on('close', () =>
      done(() => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as SandboxReply);
        } catch {
          resolve({ ok: false, error: { kind: 'result', message: 'no answer' } });
        }
      })
    );
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

const flat = (v: unknown) =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    ? v
    : v === undefined
      ? null
      : JSON.stringify(v);

/** The step's rows as a table: columns in first-seen order, values flat (objects as JSON text). */
export function tableFromResult(rows: unknown, input: DataTable, logs: string[] = []): DataTable {
  if (!Array.isArray(rows)) throw new WorkflowError('wf.err.codeNotArray');
  if (rows.length > CODE_MAX_ROWS)
    throw new WorkflowError('wf.err.codeTooManyRows', { max: CODE_MAX_ROWS });
  const columns: string[] = [];
  const seen = new Set<string>();
  const out = rows.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new WorkflowError('wf.err.codeNotRow', { index: i + 1 });
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (!seen.has(k)) {
        if (seen.size >= CODE_MAX_COLUMNS)
          throw new WorkflowError('wf.err.codeTooManyColumns', { max: CODE_MAX_COLUMNS });
        seen.add(k);
        columns.push(k);
      }
      clean[k] = flat(v);
    }
    return clean;
  });
  // Columns that kept their name keep what is known about them (types, lineage).
  const keep = <T>(m: Record<string, T> | undefined) =>
    m ? Object.fromEntries(Object.entries(m).filter(([k]) => seen.has(k))) : undefined;
  return {
    columns,
    rows: out,
    meta: {
      count: out.length,
      fetchedAt: input.meta?.fetchedAt,
      columnTypes: keep(input.meta?.columnTypes),
      lineage: keep(input.meta?.lineage),
      warnings: [
        ...(input.meta?.warnings ?? []),
        ...logs.map((line) => ({ key: 'wf.notice.codeLog', vars: { line } })),
      ],
      ...(input.meta?.partial || input.meta?.truncated ? { partial: true } : {}),
    },
  };
}

export async function runCodeStep({ code, table, timeoutMs = CODE_TIMEOUT_MS }: CodeSpec) {
  if (!code.trim()) throw new WorkflowError('wf.err.codeEmpty');
  if (table.rows.length > CODE_MAX_ROWS)
    throw new WorkflowError('wf.err.codeTooManyRows', { max: CODE_MAX_ROWS });
  const reply = await runSandbox(
    { code, rows: table.rows, columns: table.columns, timeoutMs, memoryMb: CODE_MEMORY_MB },
    timeoutMs
  );
  if (!reply.ok) {
    const { kind, message, line } = reply.error;
    throw new WorkflowError(
      `wf.err.code.${['syntax', 'runtime', 'timeout', 'memory'].includes(kind) ? kind : 'result'}`,
      {
        message,
        line: line ?? '—',
        seconds: Math.round(timeoutMs / 1000),
        mb: CODE_MEMORY_MB,
      }
    );
  }
  return tableFromResult(reply.rows, table, reply.logs ?? []);
}
