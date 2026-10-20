// The schema owner's connection for the command-line tools (migrate, users,
// setup), so it is typed once per PC instead of `set …_DATABASE_URL` before
// every command: the environment wins, else .env.local, where
// scripts/setup-local.mjs (or `npm run db:backup -- setup`) saved it without
// its password. The password comes from PGPASSWORD or this user's PostgreSQL
// password file (%APPDATA%\postgresql\pgpass.conf, ~/.pgpass), never .env.local.

import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile, parseUrl, pgpassPath, upsertPgpass } from './backup-core.mjs';

/** The first of `names` that is set, then MIGRATION_DATABASE_URL, then the backup's owner URL. */
export function ownerUrl(names = [], env = process.env) {
  for (const name of [...names, 'MIGRATION_DATABASE_URL', 'ETNA_BACKUP_DATABASE_URL']) if (env[name]) return env[name];
  return '';
}

/** Loads .env.local (without overriding the environment) and returns the owner URL. */
export function loadOwnerUrl(names = []) {
  loadEnvFile();
  return ownerUrl(names);
}

/** Saves the owner's password in this user's PostgreSQL password file (0600). */
export function saveOwnerPassword(url, password, env = process.env) {
  const file = pgpassPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, upsertPgpass(before, { ...parseUrl(url), password }), { mode: 0o600 });
  return file;
}

export const NO_OWNER =
  'The database owner connection is not known yet. Run once: node scripts/setup-local.mjs (it asks and saves it), or set MIGRATION_DATABASE_URL. Nothing was changed.';
