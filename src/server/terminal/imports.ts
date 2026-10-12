// TERMINAL imports in the worker: reading the uploaded file (CSV streamed,
// Excel through SheetJS), analysing it, and committing its rows to a dataset
// or an ERP list as the user who started the import.

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {
  CsvParser,
  TabularError,
  analyzeRows,
  decodeBytes,
  detectDelimiter,
  type DecimalMark,
  type Delimiter,
} from '@/lib/terminal/tabular';
import { ERP_TARGETS, isErpTarget } from '@/lib/terminal/erpTargets';
import { companyFolder } from '@/server/documents/storage';
import type { Executor, SqlTx } from '@/server/db/executor';
import { loadDataset, shapeRow, writeBatch, type DatasetColumn, type Reject } from './datasets';
import { TerminalError, asUser, type RequestIdentity } from './session';

export interface ImportRecord {
  id: string;
  workspace_id: string;
  created_by: string;
  file_name: string;
  file_kind: 'csv' | 'xlsx';
  storage_key: string;
  storage_dir: string | null;
  status: string;
  analysis: any;
  mapping: any;
  target_dataset_id: string | null;
  target_erp_entity: string | null;
}

export interface ReadOptions {
  sheet?: string;
  header?: boolean;
  delimiter?: Delimiter;
  encoding?: string;
  decimal?: DecimalMark;
}

const KEY_RE = /^[0-9a-f-]{36}\.(csv|xlsx)$/;

export function importFilePath(
  rec: Pick<ImportRecord, 'workspace_id' | 'storage_dir' | 'storage_key'>
): string {
  if (!KEY_RE.test(rec.storage_key)) throw new TerminalError('invalid');
  return path.join(companyFolder(rec.workspace_id, rec.storage_dir, 'imports'), rec.storage_key);
}

const DELIMS = new Set([',', ';', '\t', '|']);
const ENCODINGS = new Set(['utf-8', 'utf-16le', 'utf-16be', 'windows-1252']);

export function readOptionsOf(value: any): ReadOptions {
  const o = value && typeof value === 'object' ? value : {};
  return {
    sheet: typeof o.sheet === 'string' ? o.sheet.slice(0, 100) : undefined,
    header: typeof o.header === 'boolean' ? o.header : undefined,
    delimiter: DELIMS.has(o.delimiter) ? o.delimiter : undefined,
    encoding: ENCODINGS.has(o.encoding) ? o.encoding : undefined,
    decimal: o.decimal === ',' || o.decimal === '.' ? o.decimal : undefined,
  };
}

interface TableSource {
  meta: { encoding?: string; delimiter?: Delimiter; sheets?: string[]; sheet?: string };
  /** Rows in batches; every row is the cells of one line. */
  batches(size: number): AsyncGenerator<unknown[][]>;
}

async function csvSource(file: string, options: ReadOptions): Promise<TableSource> {
  // Encoding and delimiter from the first 64 KB.
  const handle = await fs.open(file, 'r');
  const head = Buffer.alloc(65536);
  const { bytesRead } = await handle.read(head, 0, head.length, 0);
  await handle.close();
  const first = head.subarray(0, bytesRead);
  const decoded = decodeBytes(first, options.encoding);
  const encoding = decoded.encoding;
  const delimiter = options.delimiter ?? detectDelimiter(decoded.text.slice(0, 20000));
  const bom = encoding === 'utf-8' && first[0] === 0xef && first[1] === 0xbb && first[2] === 0xbf;
  return {
    meta: { encoding, delimiter },
    async *batches(size: number) {
      const decoder = new TextDecoder(encoding);
      const parser = new CsvParser(delimiter);
      let pending: unknown[][] = [];
      let skipBom = bom || encoding.startsWith('utf-16');
      for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) {
        let text = decoder.decode(chunk as Buffer, { stream: true });
        if (skipBom) {
          text = text.replace(/^\uFEFF/, '');
          skipBom = false;
        }
        for (const row of parser.push(text)) {
          if (row.length === 1 && row[0] === '') continue;
          pending.push(row);
          if (pending.length >= size) {
            yield pending;
            pending = [];
          }
        }
      }
      for (const row of parser.push(decoder.decode()))
        if (!(row.length === 1 && row[0] === '')) pending.push(row);
      for (const row of parser.end()) if (!(row.length === 1 && row[0] === '')) pending.push(row);
      if (pending.length) yield pending;
    },
  };
}

async function xlsxSource(file: string, options: ReadOptions): Promise<TableSource> {
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(await fs.readFile(file), { type: 'buffer', cellDates: true, dense: true });
  } catch {
    throw new TerminalError('unreadable');
  }
  const sheets = book.SheetNames;
  const sheet = options.sheet && sheets.includes(options.sheet) ? options.sheet : sheets[0];
  if (!sheet) throw new TerminalError('emptyFile');
  const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheet], {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
  return {
    meta: { sheets, sheet },
    async *batches(size: number) {
      for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
    },
  };
}

export async function openTable(rec: ImportRecord, options: ReadOptions): Promise<TableSource> {
  const file = importFilePath(rec);
  try {
    await fs.access(file);
  } catch {
    throw new TerminalError('fileMissing');
  }
  return rec.file_kind === 'xlsx' ? xlsxSource(file, options) : csvSource(file, options);
}

/** Analysis: detected settings, columns with types, a preview, the row count. */
export async function analyzeImport(
  rec: ImportRecord,
  options: ReadOptions,
  beat: () => Promise<void>
) {
  const source = await openTable(rec, options);
  const head: unknown[][] = [];
  let total = 0;
  try {
    for await (const batch of source.batches(5000)) {
      if (head.length < 1001) head.push(...batch.slice(0, 1001 - head.length));
      total += batch.length;
      if (total % 50_000 < batch.length) await beat();
    }
  } catch (error) {
    if (error instanceof TabularError) throw new TerminalError(error.key);
    throw error;
  }
  if (!head.length) throw new TerminalError('emptyFile');
  const a = analyzeRows(head, { header: options.header, mark: options.decimal });
  return {
    analysis: { ...source.meta, ...a, options },
    rowsTotal: Math.max(0, total - (a.header ? 1 : 0)),
  };
}

interface CommitTarget {
  columns: DatasetColumn[];
  sourceOf: (c: DatasetColumn) => number;
}

/** Which file column feeds each target column. */
function targetOf(
  rec: ImportRecord,
  names: string[],
  dsColumns: DatasetColumn[] | null
): CommitTarget {
  const mapping = rec.mapping ?? {};
  const cols: any[] = Array.isArray(mapping.columns) ? mapping.columns : [];
  const index = (source: unknown) => names.findIndex((n) => n === source);
  const pairs: [DatasetColumn, number][] = [];
  if (mapping.target === 'new_dataset') {
    // The new dataset's columns were made from the mapped columns, in order.
    const used = cols.filter((c) => !c.skip);
    used.forEach((c, i) => {
      const col = dsColumns?.find((d) => d.position === i + 1);
      if (col && index(c.source) >= 0) pairs.push([col, index(c.source)]);
    });
  } else if (mapping.target === 'dataset') {
    for (const c of cols) {
      if (c.skip) continue;
      const col = dsColumns?.find((d) => d.physical === c.target && d.provisioned);
      if (col && index(c.source) >= 0) pairs.push([col, index(c.source)]);
    }
  } else if (mapping.target === 'erp' && isErpTarget(rec.target_erp_entity)) {
    for (const c of cols) {
      if (c.skip) continue;
      const field = ERP_TARGETS[rec.target_erp_entity].fields.find((f) => f.key === c.target);
      if (field && index(c.source) >= 0)
        pairs.push([
          {
            physical: field.key,
            position: 0,
            label: field.key,
            type: field.type,
            required: !!field.required,
            key: false,
            sensitive: false,
            hidden: false,
            description: '',
            unit: '',
            provisioned: true,
          },
          index(c.source),
        ]);
    }
    const required = ERP_TARGETS[rec.target_erp_entity].fields.filter((f) => f.required);
    if (required.some((f) => !pairs.some(([c]) => c.physical === f.key)))
      throw new TerminalError('requiredNotMapped');
  }
  if (!pairs.length) throw new TerminalError('noMatchingColumns');
  const map = new Map(pairs.map(([c, i]) => [c, i]));
  return { columns: pairs.map(([c]) => c), sourceOf: (c) => map.get(c)! };
}

async function insertErpRows(
  tx: SqlTx,
  rec: ImportRecord,
  rows: Record<string, unknown>[],
  numbers: number[],
  rejects: Reject[]
): Promise<number> {
  if (!isErpTarget(rec.target_erp_entity)) throw new TerminalError('invalid');
  const target = ERP_TARGETS[rec.target_erp_entity];
  let ok = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const fields = target.fields.filter((f) => row[f.key] !== undefined && row[f.key] !== null);
    const tooLong = fields.find((f) => f.max && String(row[f.key]).length > f.max);
    if (tooLong) {
      rejects.push({ row: numbers[i], reason: 'too_long', column: tooLong.key });
      continue;
    }
    // Column names come from ERP_TARGETS only; values are parameters. The
    // record belongs to the ERP's owner, as when it is entered on the ERP's
    // screens (an ERP made with erp_create_erp_v2 has its own owner account).
    const cols = ['workspace_id', 'user_id', ...fields.map((f) => f.key)];
    const placeholders = [
      '$1',
      '(SELECT w.owner_id FROM public.erp_workspaces w WHERE w.id = $1)',
      ...fields.map((_, n) => `$${n + 2}`),
    ];
    const args = [rec.workspace_id, ...fields.map((f) => row[f.key])];
    // One savepoint per row: a row the ERP refuses is reported, the rest go in.
    await tx.query('SAVEPOINT erp_row');
    try {
      await tx.query(
        `INSERT INTO public.${target.table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
        args
      );
      await tx.query('RELEASE SAVEPOINT erp_row');
      ok += 1;
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT erp_row');
      const code = (error as { code?: string }).code;
      if (code === '42501') throw new TerminalError('forbidden');
      rejects.push({ row: numbers[i], reason: code === '23505' ? 'duplicate' : 'erp_rejected' });
    }
  }
  return ok;
}

/**
 * Commits an import: every row is typed for its target column, written in
 * batches of 1000 as the user; rows that do not fit are kept as rejects.
 */
export async function commitImport(
  executor: Executor,
  identity: RequestIdentity,
  rec: ImportRecord,
  hooks: {
    beat: () => Promise<void>;
    progress: (ok: number, rejected: number, rejects: Reject[]) => Promise<void>;
  }
): Promise<{ ok: number; rejected: number }> {
  const path = '/terminal/import/commit';
  const mapping = rec.mapping ?? {};
  const mode: 'append' | 'upsert' | 'replace' = ['append', 'upsert', 'replace'].includes(
    mapping.mode
  )
    ? mapping.mode
    : 'append';
  const options = readOptionsOf(rec.analysis?.options ?? {});
  const header: boolean = rec.analysis?.header ?? true;
  const mark: DecimalMark = rec.analysis?.decimal === ',' ? ',' : '.';
  const names: string[] = (rec.analysis?.columns ?? []).map((c: any) => c.name);
  const erp = mapping.target === 'erp';
  let dsColumns: DatasetColumn[] | null = null;
  if (!erp) {
    const ds = await asUser(executor, identity, path, (tx) =>
      loadDataset(tx, rec.target_dataset_id)
    );
    // A new dataset's table is built by an earlier job; until then, try again later.
    if (ds.status === 'provisioning' || ds.status === 'altering')
      throw new TerminalError('datasetNotReady');
    if (ds.status !== 'ready') throw new TerminalError('datasetFailed');
    dsColumns = ds.columns;
  }
  const target = targetOf(rec, names, dsColumns);
  const sourceId = `import:${rec.id}`;
  if (!erp && mode !== 'upsert')
    await asUser(executor, identity, path, (tx) =>
      tx.query('SELECT public.ps_rows_undo_source($1, $2)', [rec.target_dataset_id, sourceId])
    );

  const source = await openTable(rec, {
    ...options,
    sheet: rec.analysis?.sheet ?? options.sheet,
    delimiter: rec.analysis?.delimiter ?? options.delimiter,
    encoding: rec.analysis?.encoding ?? options.encoding,
  });
  let ok = 0;
  let rejected = 0;
  let line = 0;
  let skipHeader = header;
  try {
    for await (const batch of source.batches(1000)) {
      const rows: Record<string, unknown>[] = [];
      const numbers: number[] = [];
      const rejects: Reject[] = [];
      for (const cells of batch) {
        line += 1;
        if (skipHeader) {
          skipHeader = false;
          continue;
        }
        const shaped = shapeRow(target.columns, (c) => cells[target.sourceOf(c)], mark);
        if ('row' in shaped) {
          rows.push(shaped.row);
          numbers.push(line);
        } else {
          rejects.push({
            row: line,
            reason: shaped.reason,
            column: shaped.column,
            raw: Object.fromEntries(
              names
                .slice(0, 50)
                .map((n, i) => [n, cells[i] === undefined ? null : String(cells[i]).slice(0, 200)])
            ),
          });
        }
      }
      ok += await asUser(executor, identity, path, (tx) =>
        erp
          ? insertErpRows(tx, rec, rows, numbers, rejects)
          : writeBatch(
              tx,
              rec.target_dataset_id!,
              rows,
              // Replace with a key column updates by key; finish_replace then removes the rest.
              mode === 'replace' ? (dsColumns?.some((c) => c.key) ? 'upsert' : 'append') : mode,
              'import',
              sourceId
            )
      );
      rejected += rejects.length;
      await hooks.progress(ok, rejected, rejects);
      await hooks.beat();
    }
  } catch (error) {
    if (error instanceof TabularError) throw new TerminalError(error.key);
    throw error;
  }
  if (!erp && mode === 'replace')
    await asUser(executor, identity, path, (tx) =>
      tx.query('SELECT public.ps_rows_finish_replace($1, $2)', [rec.target_dataset_id, sourceId])
    );
  // Where the rows came from, and the access log entry for the write.
  await asUser(executor, identity, path, async (tx) => {
    const to = erp ? rec.target_erp_entity! : rec.target_dataset_id!;
    await tx.query(
      `SELECT public.ps_record_lineage($1, 'import', $2, $3, $4, 'import', $5::uuid, null)`,
      [rec.workspace_id, rec.id, erp ? 'erp_entity' : 'dataset', to, rec.id]
    );
    await tx.query(
      `SELECT public.erp_log_data_access($1::uuid, $2, $3, 'import', $4, '{}'::text[], null, $5::jsonb)`,
      [
        rec.workspace_id,
        erp ? 'erp_entity' : 'dataset',
        to,
        ok,
        JSON.stringify({ import_id: rec.id, file_name: rec.file_name, rejected }),
      ]
    );
  });
  return { ok, rejected };
}
