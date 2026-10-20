#!/usr/bin/env node
// Prepares a database for ETNA (migrations, new app role passwords) and
// writes its settings: .env.local in the app folder, or the file given with
// --settings (a Linux server's /etc/etna/etna.env, a container's
// /config/etna.env).
//
//   node scripts/setup-local.mjs                     asks for the owner connection and password
//   MIGRATION_DATABASE_URL=postgres://etna_owner@localhost:5432/etna node scripts/setup-local.mjs [--settings <path>] [--force]
//
// For .env.local (this PC), the owner connection is saved there without its
// password, and the password in this user's PostgreSQL password file
// (%APPDATA%\postgresql\pgpass.conf, ~/.pgpass): later `npm run db:migrate`
// and scripts/admin/users.mjs need no `set …_DATABASE_URL` and no password.
//
// Not --env-file: Node.js reads that option itself wherever it appears, also
// after the script name, and stops when the file does not exist yet.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import pg from 'pg';
import { newAppKeys, provision } from './db/provision.mjs';
import { saveOwnerPassword } from './db/owner.mjs';
import { readPassphrase } from './server/lib/secret-input.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = process.argv.indexOf('--settings');
if (at > 0 && !process.argv[at + 1]) {
  console.error('--settings needs a path. Nothing was changed.');
  process.exit(2);
}
const envFile = at > 0 ? path.resolve(process.argv[at + 1]) : path.join(root, '.env.local');
const force = process.argv.includes('--force');

const thisPc = at < 0;
if (fs.existsSync(envFile) && !force) {
  console.error(`${path.basename(envFile)} already exists. Keep it (it holds MFA_ENCRYPTION_KEY) or rerun with --force. Nothing was changed.`);
  process.exit(2);
}

let ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!ownerUrl && thisPc && process.stdin.isTTY) {
  const fallback = 'postgres://etna_owner@localhost:5432/etna';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const typed = await new Promise((resolve) => rl.question(`Database owner connection [${fallback}]: `, resolve));
  rl.close();
  ownerUrl = typed.trim() || fallback;
}
if (!ownerUrl) {
  console.error('Set MIGRATION_DATABASE_URL (the schema owner, e.g. etna_owner) and PGPASSWORD. Nothing was changed.');
  process.exit(2);
}
// Never kept in a URL: the password goes to the password file only.
const typedUrl = new URL(ownerUrl);
let password = decodeURIComponent(typedUrl.password) || process.env.PGPASSWORD || '';
typedUrl.password = '';
ownerUrl = typedUrl.toString();
if (!password && thisPc && process.stdin.isTTY) password = await readPassphrase(`Password of ${decodeURIComponent(typedUrl.username)} (not shown): `);
if (password) process.env.PGPASSWORD = password;

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
    // This PC's tools find the owner here (scripts/db/owner.mjs); its password is not in this file.
    ...(thisPc ? [`MIGRATION_DATABASE_URL=${ownerUrl}`] : []),
    '',
  ];
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, lines.join('\n'), { mode: 0o600 });
  console.log(`Wrote ${envFile} (app connections + new keys). Back it up in a password manager.`);
  if (thisPc && password) console.log(`Saved the owner's password in ${saveOwnerPassword(ownerUrl, password)} (only for this user): db:migrate and users.mjs need nothing set from now on.`);
  console.log('Next: create a user with scripts/admin/users.mjs, or import data with scripts/db/transfer.mjs, then npm run dev (and npm run worker for Terminal jobs).');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
