// Terminal database sources (20261012000042): what a sync of another
// PostgreSQL database reads (a table, or a read-only query), checked the same
// way by the screens, the app and the worker.

import { COLUMN_TYPES, type ColumnType } from './tabular';

export type DbSource =
  | { mode: 'table'; schema: string; table: string; key?: string | null; changed?: string | null }
  | { mode: 'query'; sql: string; key?: string | null; changed?: string | null };

export interface DbColumn {
  name: string;
  type: ColumnType;
  /** PostgreSQL's type name, to show. */
  pgType?: string;
  primaryKey?: boolean;
}

export const MAX_DB_COLUMNS = 200;
export const MAX_QUERY_LENGTH = 20_000;

/** A schema, table or column name as PostgreSQL keeps it (any text up to 63 bytes, no NUL). */
export const isDbName = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  !v.includes('\0') &&
  new TextEncoder().encode(v).length <= 63;

/** "a"."b" — always quoted, so any name is read as a name. */
export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** A query as given: trimmed, without a closing semicolon. */
export function cleanQuery(sql: string): string {
  return sql.trim().replace(/;\s*$/, '').trim();
}

/** The source to keep, or null when something is missing or wrong. */
export function parseDbSource(v: any): DbSource | null {
  if (!v || typeof v !== 'object') return null;
  const key = v.key == null || v.key === '' ? null : v.key;
  const changed = v.changed == null || v.changed === '' ? null : v.changed;
  if (key !== null && !isDbName(key)) return null;
  if (changed !== null && !isDbName(changed)) return null;
  if (v.mode === 'table') {
    if (!isDbName(v.schema) || !isDbName(v.table)) return null;
    return { mode: 'table', schema: v.schema, table: v.table, key, changed };
  }
  if (v.mode === 'query' && typeof v.sql === 'string') {
    const sql = cleanQuery(v.sql);
    if (!sql || sql.length > MAX_QUERY_LENGTH) return null;
    return { mode: 'query', sql, key, changed };
  }
  return null;
}

/** What a sync of this source is called on the screens. */
export const dbSourceLabel = (s: DbSource) =>
  s.mode === 'table'
    ? `${s.schema}.${s.table}`
    : s.sql.replace(/\s+/g, ' ').slice(0, 60) + (s.sql.length > 60 ? '…' : '');

/** The rows to read: the table or the query, as a sub-select. */
export function sourceSelect(s: DbSource): string {
  return s.mode === 'table'
    ? `SELECT * FROM ${quoteIdent(s.schema)}.${quoteIdent(s.table)}`
    : `SELECT * FROM (${s.sql}\n) AS q`;
}

/**
 * The read for a sync: everything, or (with a "changed" column and a value
 * from the last run) the rows changed since, oldest first. $1 is that value.
 */
export function readSql(s: DbSource, incremental: boolean): string {
  const base = `SELECT * FROM (${sourceSelect(s)}) AS src`;
  if (!s.changed) return base;
  const col = `src.${quoteIdent(s.changed)}`;
  return incremental ? `${base} WHERE ${col} >= $1 ORDER BY ${col}` : `${base} ORDER BY ${col}`;
}

// PostgreSQL type OIDs (pg_type) → dataset column types.
const BY_OID: Record<number, ColumnType> = {
  16: 'boolean',
  20: 'integer',
  21: 'integer',
  23: 'integer',
  700: 'decimal',
  701: 'decimal',
  1700: 'decimal',
  790: 'decimal',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamp',
  114: 'json',
  3802: 'json',
};
export const columnTypeOf = (oid: number): ColumnType => BY_OID[oid] ?? 'text';

/** Types a "changed since" column can have (compared with >=). */
export const CHANGED_TYPES: readonly ColumnType[] = ['timestamp', 'date', 'integer'];

/** The dataset columns for a sync, or why not. */
export function datasetColumns(
  columns: unknown,
  key: string | null | undefined,
  changed: string | null | undefined
): { label: string; type: ColumnType; key?: boolean }[] | null {
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > MAX_DB_COLUMNS)
    return null;
  const seen = new Set<string>();
  const out: { label: string; type: ColumnType; key?: boolean }[] = [];
  for (const c of columns) {
    if (!c || !isDbName(c.name) || !(COLUMN_TYPES as readonly string[]).includes(c.type))
      return null;
    // Dataset labels: up to 120 characters, unique ignoring case.
    const lower = c.name.trim().toLowerCase();
    if (!c.name.trim() || seen.has(lower)) return null;
    seen.add(lower);
    out.push({ label: c.name, type: c.type, ...(c.name === key ? { key: true } : {}) });
  }
  if (key && !out.some((c) => c.key)) return null;
  if (changed) {
    const col = out.find((c) => c.label === changed);
    if (!col || !CHANGED_TYPES.includes(col.type)) return null;
  }
  return out;
}
