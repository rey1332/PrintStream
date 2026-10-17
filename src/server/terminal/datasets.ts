// Terminal datasets on the server: their description, reading rows through
// the masking view (ps_data.dsv_*), and writing rows through the database's
// ps_rows_* functions. Every call runs inside a transaction as the user
// (session.ts); row-level security decides what they may see and change.

import type { FieldType } from '@/lib/analytics/catalog';
import type { DataTable } from '@/lib/workflow/types';
import { coerce, type ColumnType, type DecimalMark } from '@/lib/terminal/tabular';
import type { Executor, SqlTx } from '@/server/db/executor';
import { TerminalError, asUser, isUuid, type RequestIdentity } from './session';

export interface DatasetColumn {
  physical: string;
  position: number;
  label: string;
  type: ColumnType;
  required: boolean;
  key: boolean;
  sensitive: boolean;
  hidden: boolean;
  description: string;
  unit: string;
  provisioned: boolean;
}

export interface DatasetInfo {
  id: string;
  workspaceId: string;
  name: string;
  folder: string;
  description: string;
  access: 'workspace' | 'restricted';
  erpArea: string | null;
  status: 'provisioning' | 'ready' | 'altering' | 'failed' | 'deleted';
  error: string | null;
  physicalTable: string;
  rowCount: number;
  sizeBytes: number;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  columns: DatasetColumn[];
}

const TABLE_RE = /^ds_[0-9a-f]{32}$/;
const COLUMN_RE = /^c_[0-9]{1,4}$/;

export const FIELD_TYPES: Record<ColumnType, FieldType> = {
  text: 'text',
  integer: 'integer',
  decimal: 'number',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'datetime',
  json: 'text',
};

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : '');

function datasetOf(row: any, columns: DatasetColumn[]): DatasetInfo {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    folder: row.folder,
    description: row.description,
    access: row.access,
    erpArea: row.erp_area,
    status: row.status,
    error: row.error,
    physicalTable: row.physical_table,
    rowCount: Number(row.row_count),
    sizeBytes: Number(row.size_bytes),
    schemaVersion: row.schema_version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    columns,
  };
}

const columnOf = (c: any): DatasetColumn => ({
  physical: c.physical_name,
  position: c.position,
  label: c.label,
  type: c.type,
  required: c.required,
  key: c.is_key,
  sensitive: c.sensitive,
  hidden: c.hidden,
  description: c.description,
  unit: c.unit,
  provisioned: c.provisioned,
});

/** A dataset the user may open, with its columns (hidden ones included, for the editor). */
export async function loadDataset(tx: SqlTx, id: unknown): Promise<DatasetInfo> {
  if (!isUuid(id)) throw new TerminalError('notFound');
  const { rows } = await tx.query(
    'SELECT * FROM public.ps_datasets WHERE id = $1 AND deleted_at IS NULL',
    [id]
  );
  if (!rows[0]) throw new TerminalError('notFound');
  const cols = await tx.query(
    'SELECT * FROM public.ps_dataset_columns WHERE dataset_id = $1 ORDER BY position',
    [id]
  );
  return datasetOf(rows[0], cols.rows.map(columnOf));
}

export async function listDatasets(tx: SqlTx, workspaceId: string): Promise<DatasetInfo[]> {
  const { rows } = await tx.query(
    `SELECT d.*, COALESCE((SELECT jsonb_agg(c ORDER BY c.position) FROM public.ps_dataset_columns c WHERE c.dataset_id = d.id), '[]') AS cols
       FROM public.ps_datasets d
      WHERE d.workspace_id = $1 AND d.deleted_at IS NULL
      ORDER BY lower(d.folder), lower(d.name)
      LIMIT 2000`,
    [workspaceId]
  );
  return rows.map((r: any) => datasetOf(r, (r.cols as any[]).map(columnOf)));
}

/** The masking view a user reads a dataset through. */
export function viewOf(ds: DatasetInfo): string {
  if (!TABLE_RE.test(ds.physicalTable)) throw new TerminalError('invalid');
  return `ps_data.dsv_${ds.physicalTable.slice(3)}`;
}

/** Visible, provisioned columns: what the view shows. */
export const visibleColumns = (ds: DatasetInfo) =>
  ds.columns.filter((c) => !c.hidden && c.provisioned && COLUMN_RE.test(c.physical));

export interface RowPage {
  columns: DatasetColumn[];
  rows: Record<string, unknown>[];
  total: number;
  unmasked: boolean;
}

/**
 * A page of rows as { _id, c_n... }. Sorting is by one visible column; the
 * read is in the data-access log with the sensitive columns it showed unmasked.
 */
export async function readRows(
  tx: SqlTx,
  ds: DatasetInfo,
  options: {
    limit: number;
    offset?: number;
    sort?: string;
    desc?: boolean;
    operation?: 'view' | 'query' | 'preview' | 'export';
    requestId?: string | null;
  }
): Promise<RowPage> {
  const columns = visibleColumns(ds);
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit)),
    options.operation === 'export' ? 1_000_000 : 100_000
  );
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const sortCol = columns.find((c) => c.physical === options.sort);
  const order = sortCol
    ? `"${sortCol.physical}" ${options.desc ? 'DESC' : 'ASC'} NULLS LAST, _id`
    : '_id';
  const view = viewOf(ds);
  const list = ['_id', ...columns.map((c) => `"${c.physical}"`)].join(', ');
  const { rows } = await tx.query(
    `SELECT ${list} FROM ${view} ORDER BY ${order} LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const total = Number((await tx.query(`SELECT count(*) AS n FROM ${view}`)).rows[0].n);
  const unmasked =
    (await tx.query('SELECT public.ps_can_unmask($1) AS ok', [ds.workspaceId])).rows[0].ok === true;
  const sensitive = columns.filter((c) => c.sensitive).map((c) => c.label);
  await tx.query(
    `SELECT public.erp_log_data_access($1::uuid, 'dataset', $2, $3, $4, $5::text[], $6, $7::jsonb)`,
    [
      ds.workspaceId,
      ds.id,
      options.operation ?? 'view',
      rows.length,
      unmasked ? sensitive : [],
      options.requestId ?? null,
      JSON.stringify({ name: ds.name, offset }),
    ]
  );
  return {
    columns,
    rows: rows.map((r: any) => ({ ...r, _id: Number(r._id) })),
    total,
    unmasked,
  };
}

/** Rows as a pipeline table: columns named by their labels. */
export function asDataTable(ds: DatasetInfo, page: RowPage): DataTable {
  const names = page.columns.map((c) => c.label);
  return {
    columns: names,
    rows: page.rows.map((r) =>
      Object.fromEntries(page.columns.map((c) => [c.label, r[c.physical] ?? null]))
    ),
    meta: {
      source: `dataset:${ds.id}`,
      count: page.total,
      fetchedAt: new Date().toISOString(),
      columnTypes: Object.fromEntries(page.columns.map((c) => [c.label, FIELD_TYPES[c.type]])),
      truncated: page.rows.length < page.total,
    },
  };
}

export interface Reject {
  row: number;
  reason: string;
  column?: string;
  raw?: Record<string, unknown>;
}

/**
 * Typed values for the dataset's columns, from a row keyed by `sourceOf(column)`.
 * Returns the row for ps_rows_write, or the reason it does not fit.
 */
export function shapeRow(
  columns: DatasetColumn[],
  get: (column: DatasetColumn) => unknown,
  mark: DecimalMark
): { row: Record<string, unknown> } | { reason: string; column: string } {
  const row: Record<string, unknown> = {};
  for (const c of columns) {
    const value = get(c);
    const result = coerce(value, c.type, mark);
    if (!result.ok) return { reason: result.reason, column: c.label };
    if (result.value === null && (c.required || c.key))
      return { reason: 'required_missing', column: c.label };
    row[c.physical] = result.value;
  }
  return { row };
}

export const WRITE_BATCH = 1000;

/** Writes one batch of shaped rows (≤ 10,000) as the user. */
export async function writeBatch(
  tx: SqlTx,
  datasetId: string,
  rows: Record<string, unknown>[],
  mode: 'append' | 'upsert' | 'replace',
  sourceKind: 'import' | 'pipeline' | 'manual' | 'connector',
  sourceId: string,
  op: 'import' | 'edit' = 'import'
): Promise<number> {
  if (!rows.length) return 0;
  const { rows: out } = await tx.query(
    'SELECT public.ps_rows_write($1, $2::jsonb, $3, $4, $5, $6) AS n',
    [datasetId, JSON.stringify(rows), mode, sourceKind, sourceId, op]
  );
  return Number(out[0].n);
}

/**
 * A pipeline's table into a dataset (background runs). Table columns match
 * dataset columns by label (ignoring case); rows that do not fit are counted
 * and skipped. Replace marks older rows removed only after every batch is in.
 */
export async function writeTable(
  executor: Executor,
  identity: RequestIdentity,
  datasetId: string,
  table: DataTable,
  mode: 'append' | 'upsert' | 'replace',
  sourceId: string,
  heartbeat: () => Promise<void>
): Promise<{ written: number; rejected: number; rejects: Reject[] }> {
  const path = '/terminal/pipeline/write';
  const ds = await asUser(executor, identity, path, (tx) => loadDataset(tx, datasetId));
  if (ds.status !== 'ready') throw new TerminalError('datasetNotReady');
  const columns = ds.columns.filter((c) => c.provisioned && COLUMN_RE.test(c.physical));
  const byLabel = new Map(table.columns.map((name) => [name.trim().toLowerCase(), name]));
  const mapped = columns.filter((c) => byLabel.has(c.label.trim().toLowerCase()));
  if (!mapped.length) throw new TerminalError('noMatchingColumns');
  // A retried run starts over: what an earlier attempt added goes first. (An
  // upsert is safe to repeat, and undoing it would delete rows it updated.)
  if (mode !== 'upsert')
    await asUser(executor, identity, path, (tx) =>
      tx.query('SELECT public.ps_rows_undo_source($1, $2)', [ds.id, sourceId])
    );
  let written = 0;
  const rejects: Reject[] = [];
  let rejected = 0;
  for (let start = 0; start < table.rows.length; start += WRITE_BATCH) {
    const batch: Record<string, unknown>[] = [];
    table.rows.slice(start, start + WRITE_BATCH).forEach((r, i) => {
      const shaped = shapeRow(mapped, (c) => r[byLabel.get(c.label.trim().toLowerCase())!], '.');
      if ('row' in shaped) batch.push(shaped.row);
      else {
        rejected += 1;
        if (rejects.length < 100)
          rejects.push({ row: start + i + 1, reason: shaped.reason, column: shaped.column });
      }
    });
    written += await asUser(executor, identity, path, (tx) =>
      // Replace with a key column updates by key; finish_replace then removes the rest.
      writeBatch(
        tx,
        ds.id,
        batch,
        mode === 'replace' ? (mapped.some((c) => c.key) ? 'upsert' : 'append') : mode,
        'pipeline',
        sourceId
      )
    );
    await heartbeat();
  }
  if (mode === 'replace')
    await asUser(executor, identity, path, (tx) =>
      tx.query('SELECT public.ps_rows_finish_replace($1, $2)', [ds.id, sourceId])
    );
  return { written, rejected, rejects };
}
