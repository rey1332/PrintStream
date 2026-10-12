// What every TERMINAL connector adapter provides (src/server/connectors/*).

import type { ObjectKey } from '@/lib/terminal/connectors';
import { TerminalError } from '@/server/terminal/session';
import type { GuardedHttp, HttpResponse } from './http';

export type Row = Record<string, unknown>;

export interface ConnectorContext {
  http: GuardedHttp;
  /** Internal hosts and networks ETNA allows (for connections that are not HTTP). */
  privateHosts: string[];
  /** Settings that are not secret (ps_connections.config). */
  config: Record<string, any>;
  /** The opened vault entry (passwords, keys, tokens). */
  secret: Record<string, any>;
  /** Keeps new tokens (sealed again by the caller). */
  saveSecret(next: Record<string, any>): Promise<void>;
  saveConfig(patch: Record<string, any>): Promise<void>;
  /** Keeps the job's lease; throws when it was cancelled. */
  beat(): Promise<void>;
}

export interface Adapter {
  /** Signs in and reads a little; returns facts to show (version, databases…). */
  test(ctx: ConnectorContext): Promise<Record<string, unknown>>;
  /**
   * The list's rows in pages, with the columns of OBJECT_COLUMNS[object].
   * `since` (ISO time) asks only for rows changed after it, where supported.
   */
  read(ctx: ConnectorContext, object: ObjectKey, since: string | null): AsyncGenerator<Row[]>;
}

/** Most pages to read in one run (with 100–500 rows a page). */
export const MAX_PAGES = 10_000;

/** The first value present among several possible field names. */
export function pick(source: any, ...names: string[]): unknown {
  for (const n of names) {
    let v: any = source;
    for (const part of n.split('.')) v = v == null ? undefined : v[part];
    if (v !== undefined && v !== null && v !== false && v !== '') return v;
  }
  return null;
}

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || v === false) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

export const text = (v: unknown): string | null =>
  v === null || v === undefined || v === false ? null : String(v);

/** An HTTP answer that is not a success, as a TerminalError the screens explain. */
export function failure(res: HttpResponse): TerminalError {
  if (res.status === 401 || res.status === 403) return new TerminalError('authFailed');
  if (res.status === 404) return new TerminalError('notFoundRemote');
  if (res.status === 429) return new TerminalError('rateLimited');
  if (res.status >= 500) return new TerminalError('remoteDown', { status: res.status });
  return new TerminalError('badRequest', { status: res.status });
}
