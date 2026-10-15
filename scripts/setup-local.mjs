#!/usr/bin/env node
// Prepares a database for ETNA (migrations, new app role passwords) and
// writes its settings: .env.local in the app folder, or the file given with
// --settings (a Linux server's /etc/etna/etna.env, a container's
// /config/etna.env).
//
//   MIGRATION_DATABASE_URL=postgres://etna_owner@localhost:5432/etna node scripts/setup-local.mjs [--settings <path>] [--force]
//
// Not --env-file: Node.js reads that option itself wherever it appears, also
// after the script name, and stops when the file does not exist yet.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { newAppKeys, provision } from './db/provision.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = process.argv.indexOf('--settings');
if (at > 0 && !process.argv[at + 1]) {
  console.error('--settings needs a path. Nothing was changed.');
  process.exit(2);
}
const envFile = at > 0 ? path.resolve(process.argv[at + 1]) : path.join(root, '.env.local');
const force = process.argv.includes('--force');

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!ownerUrl) {
  console.error('Set MIGRATION_DATABASE_URL (the schema owner, e.g. etna_owner) and PGPASSWORD. Nothing was changed.');
  process.exit(2);
}
if (fs.existsSync(envFile) && !force) {
  console.error(`${path.basename(envFile)} already exists. Keep it (it holds MFA_ENCRYPTION_KEY) or rerun with --force. Nothing was changed.`);
  process.exit(2);
}

const target = new URL(ownerUrl);
const client = new pg.Client({ connectionString: ownerUrl, application_name: 'etna-setup' });

try {
  await client.connect();
  const db = await provision(client, ownerUrl, { log: (line) => console.log(line) });
  console.log(db.applied.length ? `Applied ${db.applied.length} migration file(s).` : 'Schema already up to date.');

  const keys = newAppKeys();
  const lines = [
    '# ETNA on PostgreSQL — written by scripts/setup-local.mjs. Never commit; back it up.',
    `# Database: ${target.hostname}:${target.port || 5432}${target.pathname}`,
    `DATABASE_URL=${db.DATABASE_URL}`,
    `AUTH_DATABASE_URL=${db.AUTH_DATABASE_URL}`,
    `WORKER_DATABASE_URL=${db.WORKER_DATABASE_URL}`,
    `MFA_ENCRYPTION_KEY=${keys.MFA_ENCRYPTION_KEY}`,
    `SESSION_HINT_SECRET=${keys.SESSION_HINT_SECRET}`,
    '',
  ];
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, lines.join('\n'), { mode: 0o600 });
  console.log(`Wrote ${envFile} (app connections + new keys). Back it up in a password manager.`);
  console.log('Next: create a user with scripts/admin/users.mjs, or import data with scripts/db/transfer.mjs, then npm run dev (and npm run worker for TERMINAL jobs).');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
