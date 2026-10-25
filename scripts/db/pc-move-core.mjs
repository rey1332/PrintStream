// The decisions behind moving ETNA from one PC to another (scripts/db/pc-move.mjs),
// kept free of side effects so they can be tested: where a PC keeps its
// documents, which settings come from a backup and which stay this PC's.

import path from 'node:path';
import { LOCAL_SETTINGS } from '../server/lib/psctl-core.mjs';

/**
 * Where the documents and company folders are (as src/server/documents/storage.ts
 * finds them): ETNA_DOCUMENTS_DIR, else <ETNA_DATA_ROOT>, else storage/ in the app folder.
 */
export function dataDirs(env, appRoot) {
  const base = env.ETNA_DATA_ROOT ? path.resolve(env.ETNA_DATA_ROOT) : path.join(appRoot, 'storage');
  return {
    documents: env.ETNA_DOCUMENTS_DIR ? path.resolve(env.ETNA_DOCUMENTS_DIR) : path.join(base, 'documents'),
    companies: path.join(base, 'companies'),
  };
}

/** Settings that belong to the PC that made a backup, never carried to another one. */
export const PC_SETTINGS = Object.freeze([...LOCAL_SETTINGS, 'PGPASSFILE']);

/**
 * The settings of this PC after a restore: the backup's keys and settings
 * (two-factor key, session secret, public address, mail…), this PC's
 * connections (new passwords) and where it keeps its data. Without the
 * backup's settings, `freshKeys` are used: everyone enrols two-factor again.
 */
export function restoredSettings({ fromBackup, current = {}, urls, ownerUrl, freshKeys }) {
  const out = {};
  if (fromBackup) {
    for (const [key, value] of Object.entries(fromBackup)) if (!PC_SETTINGS.includes(key)) out[key] = value;
  } else Object.assign(out, freshKeys);
  for (const key of PC_SETTINGS) if (current[key] && !(key in urls) && key !== 'MIGRATION_DATABASE_URL') out[key] = current[key];
  Object.assign(out, urls);
  out.MIGRATION_DATABASE_URL = ownerUrl;
  return out;
}
