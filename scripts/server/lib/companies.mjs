// Company storage folders (server manager → [14] Company storage).
//
// Each company (workspace) keeps its files — documents, import files, pipeline
// artifacts, temporary files — either in the shared places under
// ETNA_DATA_ROOT (default) or in a folder ETNA assigned to it, e.g.
// E:\ETNAStorage\PT Batu Jaya. The database records the folder
// (etna_admin.set_workspace_storage_dir); the app reads it per company
// (src/server/documents/storage.ts, companyFolder). Moving copies first,
// verifies, then switches; the old folder is never deleted here.

import path from 'node:path';

export const KINDS = ['documents', 'imports', 'artifacts', 'tmp'];

/** Where each kind of file of a company lives now (mirrors companyFolder in the app). */
export function companyLocations(root, workspaceId, storageDir, documentsDir = null) {
  const id = workspaceId.toLowerCase();
  const out = {};
  for (const kind of KINDS) {
    if (storageDir) out[kind] = path.join(storageDir, kind);
    else if (kind === 'documents') out[kind] = path.join(documentsDir || path.join(root, 'documents'), id);
    else out[kind] = path.join(root, 'companies', id, kind);
  }
  return out;
}

/** A folder name from a company name (letters, digits, space, dash, dot). */
export function folderName(name) {
  const clean = String(name || '')
    .replace(/[^\p{L}\p{N} .-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .slice(0, 60);
  return clean || 'company';
}

/** Problems with a company folder: system places of the installation are refused. */
export function companyFolderProblem(dir, root) {
  if (!path.isAbsolute(dir) || !/^[A-Za-z]:\\/.test(dir)) return 'root_not_absolute';
  if (/[%"^&|<>!]/.test(dir)) return 'root_bad_chars';
  if (path.parse(dir).root === dir) return 'root_is_drive';
  const lower = path.resolve(dir).toLowerCase();
  if (lower.includes('\\windows') || lower.includes('\\program files')) return 'root_system_folder';
  const r = path.resolve(root).toLowerCase();
  for (const reserved of ['app', 'config', 'postgres', 'backups', 'logs']) {
    const p = path.join(r, reserved);
    if (lower === p || lower.startsWith(`${p}\\`)) return 'cs.reserved';
  }
  if (lower === r) return 'cs.reserved';
  return null;
}
