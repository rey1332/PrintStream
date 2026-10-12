import { promises as fs } from 'node:fs';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ETNA_DOCUMENTS_DIR, else <ETNA_DATA_ROOT>\documents (set by etna.bat), else
// storage/documents in the app folder.
export function documentsRoot(): string {
  const configured = process.env.ETNA_DOCUMENTS_DIR?.trim();
  const dataRoot = process.env.ETNA_DATA_ROOT?.trim();
  return path.resolve(
    configured ||
      (dataRoot
        ? path.join(dataRoot, 'documents')
        : path.join(process.cwd(), 'storage', 'documents'))
  );
}

/**
 * Where a company's files live: its own storage folder when ETNA assigned one
 * (etna.bat → Company storage; erp_workspace_storage_dir), else the shared
 * locations under ETNA_DATA_ROOT. `kind` is the sub-folder: documents,
 * imports, artifacts or tmp.
 */
export function companyFolder(
  workspaceId: string,
  storageDir: string | null | undefined,
  kind: 'documents' | 'imports' | 'artifacts' | 'tmp'
): string {
  if (!UUID.test(workspaceId)) throw new Error('Invalid company folder');
  if (storageDir) return path.join(path.resolve(storageDir), kind);
  if (kind === 'documents') return path.join(documentsRoot(), workspaceId.toLowerCase());
  const dataRoot = process.env.ETNA_DATA_ROOT?.trim();
  const base = dataRoot
    ? path.join(path.resolve(dataRoot), 'companies')
    : path.join(process.cwd(), 'storage', 'companies');
  return path.join(base, workspaceId.toLowerCase(), kind);
}

function filePath(workspaceId: string, documentId: string, storageDir?: string | null): string {
  if (!UUID.test(workspaceId) || !UUID.test(documentId))
    throw new Error('Invalid document location');
  return path.join(companyFolder(workspaceId, storageDir, 'documents'), documentId.toLowerCase());
}

export async function writeDocumentFile(
  workspaceId: string,
  documentId: string,
  bytes: Uint8Array,
  storageDir?: string | null
): Promise<void> {
  const target = filePath(workspaceId, documentId, storageDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, { flag: 'wx' });
}

export async function readDocumentFile(
  workspaceId: string,
  documentId: string,
  storageDir?: string | null
): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath(workspaceId, documentId, storageDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function removeDocumentFile(
  workspaceId: string,
  documentId: string,
  storageDir?: string | null
): Promise<void> {
  await fs.rm(filePath(workspaceId, documentId, storageDir), { force: true });
}

/** Removes a deleted ERP's documents from the shared folder (an assigned company folder is etna.bat's to clear). */
export async function removeWorkspaceDocuments(workspaceId: string): Promise<void> {
  if (!UUID.test(workspaceId)) throw new Error('Invalid document location');
  await fs.rm(path.join(documentsRoot(), workspaceId.toLowerCase()), {
    recursive: true,
    force: true,
  });
}
