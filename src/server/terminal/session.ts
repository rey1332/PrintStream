// TERMINAL: database work as a signed-in user (the app's routes) or as the
// user a job runs for (the worker). Either way the session is the user's:
// role authenticated, their claims, row-level security and the ERP's rules.

import { beginAsUser, getCatalog, type RequestIdentity } from '@/server/db/execute';
import type { Executor, SqlTx } from '@/server/db/executor';

export type { RequestIdentity } from '@/server/db/execute';

export class TerminalError extends Error {
  readonly code: string;
  readonly vars?: Record<string, string | number>;

  constructor(code: string, vars?: Record<string, string | number>) {
    super(code);
    this.code = code;
    this.vars = vars;
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_RE.test(value);

/** A database error as a TerminalError code the screens translate. */
export function terminalErrorOf(error: unknown): TerminalError {
  if (error instanceof TerminalError) return error;
  const e = error as { code?: string; hint?: string };
  if (e?.code === 'P0001' && e.hint) return new TerminalError(e.hint);
  if (e?.code === 'P0002') return new TerminalError('notFound');
  if (e?.code === '42501')
    return new TerminalError(e.hint === 'mfa_required' ? 'mfaRequired' : 'forbidden');
  if (e?.code === '23505') return new TerminalError('duplicate');
  if (e?.code === '57014') return new TerminalError('timeout');
  if (e?.code === '23514' || e?.code === '22023' || e?.code === '22P02' || e?.code === '23502')
    return new TerminalError('invalid');
  return new TerminalError('failed');
}

/** One transaction as the user. Database errors come back as TerminalError. */
export async function asUser<T>(
  executor: Executor,
  identity: RequestIdentity,
  path: string,
  fn: (tx: SqlTx) => Promise<T>,
  options: { timeout?: string } = {}
): Promise<T> {
  const catalog = await getCatalog(executor);
  try {
    return await executor.transaction(async (tx) => {
      await beginAsUser(tx, identity, path, 'POST', catalog);
      if (options.timeout)
        await tx.query(`select set_config('statement_timeout', $1, true)`, [options.timeout]);
      return fn(tx);
    });
  } catch (error) {
    const mapped = terminalErrorOf(error);
    if (mapped.code === 'failed')
      console.error('[terminal]', (error as { code?: string })?.code || 'error');
    throw mapped;
  }
}
