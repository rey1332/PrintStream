import { createHash } from 'node:crypto';
import { beginAsUser, getCatalog, type RequestIdentity } from '@/server/db/execute';
import type { Executor, SqlTx } from '@/server/db/executor';
import {
  DOCUMENT_TYPES,
  MAX_DOCUMENT_BYTES,
  cleanDocumentName,
  extensionOf,
} from '@/lib/workspaces/limits';
import { readDocumentFile, removeDocumentFile, writeDocumentFile } from './storage';

export interface DocumentsContext {
  executor: Executor;
  identity: RequestIdentity;
  workspacesEnabled: boolean;
}

export class DocumentError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface DocumentRow {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedBy: string | null;
  canDelete: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function workspaceOf(ctx: DocumentsContext, workspaceId: unknown): string | null {
  if (
    !ctx.workspacesEnabled ||
    workspaceId === null ||
    workspaceId === undefined ||
    workspaceId === ''
  )
    return null;
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId))
    throw new DocumentError('invalidWorkspace');
  return workspaceId;
}

/** The company's own storage folder, when ETNA assigned one (20261012000034). */
async function storageDirOf(tx: SqlTx, workspaceId: string): Promise<string | null> {
  await tx.query('SAVEPOINT storage_dir');
  try {
    const { rows } = await tx.query('SELECT public.erp_workspace_storage_dir($1::uuid) AS d', [
      workspaceId,
    ]);
    await tx.query('RELEASE SAVEPOINT storage_dir');
    return rows[0]?.d ?? null;
  } catch {
    // Quotas not installed yet: the shared folder.
    await tx.query('ROLLBACK TO SAVEPOINT storage_dir');
    return null;
  }
}

function documentIdOf(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new DocumentError('notFound');
  return value;
}

async function inTx<T>(
  ctx: DocumentsContext,
  path: string,
  fn: (tx: SqlTx) => Promise<T>
): Promise<T> {
  const catalog = await getCatalog(ctx.executor);
  try {
    return await ctx.executor.transaction(async (tx) => {
      await beginAsUser(tx, ctx.identity, path, 'POST', catalog);
      return fn(tx);
    });
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    const e = error as { code?: string; hint?: string };
    console.error('[documents]', e.code || 'error');
    if (e.code === 'P0001' && e.hint) throw new DocumentError(e.hint);
    if (e.code === 'P0002') throw new DocumentError('notFound');
    if (e.code === '42501') throw new DocumentError('forbidden');
    if (e.code === '57014') throw new DocumentError('timeout');
    if (e.code === '23514' || e.code === '22023' || e.code === '22P02')
      throw new DocumentError('invalid');
    throw new DocumentError('failed');
  }
}

export async function listDocuments(
  ctx: DocumentsContext,
  workspaceId: unknown
): Promise<DocumentRow[]> {
  const ws = workspaceOf(ctx, workspaceId);
  return inTx(ctx, '/documents/list', async (tx) => {
    const { rows } = await tx.query('SELECT * FROM public.erp_documents_list($1::uuid)', [ws]);
    return rows.map((r: any) => ({
      id: r.id,
      fileName: r.file_name,
      contentType: r.content_type,
      sizeBytes: Number(r.size_bytes),
      createdAt: new Date(r.created_at).toISOString(),
      uploadedBy: r.uploaded_by_email ?? null,
      canDelete: r.can_delete === true,
    }));
  });
}

export async function uploadDocument(
  ctx: DocumentsContext,
  workspaceId: unknown,
  fileName: string,
  bytes: Uint8Array
): Promise<{ id: string }> {
  const ws = workspaceOf(ctx, workspaceId);
  const name = cleanDocumentName(fileName);
  const contentType = DOCUMENT_TYPES[extensionOf(name)];
  if (!name || !contentType) throw new DocumentError('fileType');
  if (bytes.byteLength === 0) throw new DocumentError('empty');
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentError('tooLarge');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  let written: { ws: string; id: string; dir: string | null } | null = null;
  try {
    return await inTx(ctx, '/documents/upload', async (tx) => {
      const { rows } = await tx.query(
        'SELECT public.erp_document_register($1::uuid, $2, $3, $4::bigint, $5) AS id',
        [ws, name, contentType, bytes.byteLength, sha256]
      );
      const id: string = rows[0].id;
      // The workspace the database chose (the personal one when none was given).
      const doc = (
        await tx.query('SELECT workspace_id FROM public.erp_document_get($1::uuid)', [id])
      ).rows[0];
      // The company's storage quota (20261012000034): room is reserved under a lock
      // on the company, so parallel uploads cannot pass it together.
      const catalog = await getCatalog(ctx.executor);
      let reservation: string | null = null;
      if (catalog.functions.has('erp_reserve_storage')) {
        const r = await tx.query(
          "SELECT public.erp_reserve_storage($1::uuid, $2::bigint, 'document', 'file') AS id",
          [doc.workspace_id, bytes.byteLength]
        );
        reservation = r.rows[0].id;
      }
      const dir = await storageDirOf(tx, doc.workspace_id);
      await writeDocumentFile(doc.workspace_id, id, bytes, dir);
      written = { ws: doc.workspace_id, id, dir };
      if (reservation)
        await tx.query('SELECT public.erp_release_storage($1::uuid, $2::bigint)', [
          reservation,
          bytes.byteLength,
        ]);
      return { id };
    });
  } catch (error) {
    const file = written as { ws: string; id: string; dir: string | null } | null;
    if (file) await removeDocumentFile(file.ws, file.id, file.dir).catch(() => undefined);
    throw error;
  }
}

export interface DocumentFile {
  fileName: string;
  contentType: string;
  bytes: Buffer;
}

export async function readDocument(
  ctx: DocumentsContext,
  documentId: unknown
): Promise<DocumentFile> {
  const id = documentIdOf(documentId);
  const doc = await inTx(ctx, '/documents/download', async (tx) => {
    const row = (await tx.query('SELECT * FROM public.erp_document_get($1::uuid)', [id])).rows[0];
    if (row?.workspace_id) row.storage_dir = await storageDirOf(tx, row.workspace_id);
    // Every download is in the data-access log (20261012000033), with the request.
    if (row?.workspace_id)
      await tx.query(
        `SELECT public.erp_log_data_access($1::uuid, 'document', $2, 'download', 1, '{}'::text[], null, null)`,
        [row.workspace_id, row.id]
      );
    return row;
  });
  if (!doc) throw new DocumentError('notFound');
  const bytes = await readDocumentFile(doc.workspace_id, doc.id, doc.storage_dir);
  // Missing or changed on disk: never serve something other than what was uploaded.
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== doc.sha256) {
    console.error('[documents] file missing or changed on disk', doc.id);
    throw new DocumentError('missing');
  }
  return { fileName: doc.file_name, contentType: doc.content_type, bytes };
}

export async function deleteDocument(ctx: DocumentsContext, documentId: unknown): Promise<void> {
  const id = documentIdOf(documentId);
  const { ws, dir } = await inTx(ctx, '/documents/delete', async (tx) => {
    const w: string = (await tx.query('SELECT public.erp_document_delete($1::uuid) AS w', [id]))
      .rows[0].w;
    return { ws: w, dir: await storageDirOf(tx, w) };
  });
  // After the commit: a failure here leaves an unreferenced file, never a dangling row.
  await removeDocumentFile(ws, id, dir).catch((error) =>
    console.error('[documents] could not remove file', id, error?.code)
  );
}
