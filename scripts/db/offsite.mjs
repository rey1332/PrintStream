#!/usr/bin/env node
// Encrypted off-site backups of ETNA: database, documents and settings in one
// file, copied to another disk, a NAS or a network share (docs/teknis/OPERATIONS.md,
// "Off-site backups"). File format: scripts/db/offsite-core.mjs.
//
//   node scripts/db/offsite.mjs keys --dir <folder>          new key pair (passphrase on stdin)
//   node scripts/db/offsite.mjs run [--settings <etna.env>]  one backup (nightly; no passphrase)
//   node scripts/db/offsite.mjs list
//   node scripts/db/offsite.mjs verify <file>                 opens and checks it (passphrase on stdin)
//   node scripts/db/offsite.mjs restore <file> --to <folder> [--database <url>]
//
// Settings (environment, or the file given with --settings):
//   OFFSITE_DATABASE_URL  the schema owner, e.g. postgres://etna_owner@localhost:5432/etna
//                         (default MIGRATION_DATABASE_URL); its password from
//                         PGPASSWORD or the PostgreSQL password file
//   ETNA_OFFSITE_DIR      where the backups go (another disk, NAS, share)
//   ETNA_OFFSITE_KEY      the public key (offsite-key.pub.pem from `keys`); the
//                         passphrase-protected private key beside it
//                         (offsite-key.enc.pem) goes into every backup
//   ETNA_OFFSITE_KEEP     backups kept in ETNA_OFFSITE_DIR (default 14)
//   ETNA_DATA_ROOT, ETNA_DOCUMENTS_DIR   where the documents and company folders are
//                         (neither: storage/ in the app folder, as on a PC)
//
// With --settings, that file is included in the backup (it holds the
// two-factor key: without it, a restore makes everyone enroll again).
// On a PC, scripts/db/pc-move.mjs runs this with --settings .env.local.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, findTool, parseUrl, restoreList } from './backup-core.mjs';
import { dataDirs } from './pc-move-core.mjs';
import { bundleName, bundlesToPrune, filesUnder, listBundles, readBundle, readHeader, writeBundle } from './offsite-core.mjs';
import { readEnvFile } from '../server/lib/envfile.mjs';
import { MIN_PASSPHRASE, newBackupKeys } from '../server/lib/sealed.mjs';
import { readPassphrase } from '../server/lib/secret-input.mjs';

const args = process.argv.slice(2);
const command = args[0];
const option = (name) => {
  const at = args.indexOf(name);
  return at > 0 ? args[at + 1] : undefined;
};
const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

const settingsFile = option('--settings');
const settings = settingsFile ? readEnvFile(settingsFile) : {};
const env = { ...settings, ...process.env };
// The settings file says where this server keeps its data; the environment cannot move it.
for (const key of ['ETNA_DATA_ROOT', 'ETNA_DOCUMENTS_DIR']) if (settings[key]) env[key] = settings[key];

function run(file, argv, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { env: { ...process.env, ...extraEnv }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `${path.basename(file)} exited with ${code}`))
    );
  });
}

const connection = (url) => {
  const c = parseUrl(url);
  return ['--host', c.host, '--port', c.port, '--username', c.user, '--no-password', '--dbname', c.database];
};
// A password in the URL is passed to pg_dump / pg_restore as PGPASSWORD, never on their command line.
const passwordEnv = (url) => {
  const password = decodeURIComponent(new URL(url).password || '');
  return password ? { PGPASSWORD: password } : {};
};

function offsiteDir() {
  const dir = env.ETNA_OFFSITE_DIR;
  if (!dir) fail('Set ETNA_OFFSITE_DIR (another disk, a NAS or a network share).', 2);
  return path.resolve(dir);
}

async function keysCommand() {
  const dir = option('--dir');
  if (!dir) fail('Usage: offsite.mjs keys --dir <folder>', 2);
  const pub = path.join(dir, 'offsite-key.pub.pem');
  const priv = path.join(dir, 'offsite-key.enc.pem');
  if (fs.existsSync(pub) || fs.existsSync(priv)) fail(`${dir} already has off-site keys. Nothing was changed.`, 2);
  const passphrase = await readPassphrase(`Passphrase for off-site backups (at least ${MIN_PASSPHRASE} characters): `);
  if (passphrase.length < MIN_PASSPHRASE) fail(`The passphrase needs at least ${MIN_PASSPHRASE} characters. Nothing was changed.`, 2);
  const keys = newBackupKeys(passphrase);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pub, keys.publicKey, { mode: 0o644 });
  fs.writeFileSync(priv, keys.privateKey, { mode: 0o600 });
  console.log(`Wrote ${pub} and ${priv}.`);
  console.log('Set ETNA_OFFSITE_KEY to the .pub.pem file. Keep the passphrase in a password manager: without it no backup can be opened.');
}

async function appliedMigrations(url) {
  // Loaded here: `keys` and `verify` work without the app's packages installed.
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url, application_name: 'etna-offsite' });
  try {
    await client.connect();
    const { rows } = await client.query('select name from etna_meta.schema_migrations order by name');
    return rows.map((r) => r.name);
  } catch {
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

async function runCommand() {
  const url = env.OFFSITE_DATABASE_URL || env.MIGRATION_DATABASE_URL;
  if (!url) fail('Set OFFSITE_DATABASE_URL (the schema owner) and its password (PGPASSWORD or the password file).', 2);
  const dir = offsiteDir();
  const keyFile = env.ETNA_OFFSITE_KEY;
  if (!keyFile || !fs.existsSync(keyFile)) fail('Set ETNA_OFFSITE_KEY to the public key made with `offsite.mjs keys`.', 2);
  const privateFile = keyFile.replace(/\.pub\.pem$/, '.enc.pem');
  if (privateFile === keyFile || !fs.existsSync(privateFile)) fail(`The private key ${privateFile} must be beside the public key.`, 2);
  const pgDump = findTool('pg_dump');
  if (!pgDump) fail('pg_dump was not found. Install the PostgreSQL command-line tools.', 2);

  // As the app finds them: without ETNA_DATA_ROOT (a PC), storage/ in the app folder.
  const { documents, companies } = dataDirs(env, ROOT);

  fs.mkdirSync(dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'etna-offsite-'));
  const name = bundleName();
  const partial = path.join(dir, `.${name}.partial`);
  try {
    const dump = path.join(work, 'database.dump');
    await run(pgDump, [...connection(url), '--format', 'custom', '--file', dump], passwordEnv(url));
    const entries = [
      { name: 'database.dump', file: dump },
      ...filesUnder(documents, 'files/documents'),
      ...filesUnder(companies, 'files/companies'),
      ...(settingsFile ? [{ name: 'settings/etna.env', file: path.resolve(settingsFile) }] : []),
    ];
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const manifest = await writeBundle(partial, entries, {
      publicKey: fs.readFileSync(keyFile, 'utf8'),
      privateKeyEncrypted: fs.readFileSync(privateFile, 'utf8'),
      info: {
        appVersion: pkg.version,
        host: os.hostname(),
        database: parseUrl(url).database,
        migrations: await appliedMigrations(url),
      },
    });
    fs.renameSync(partial, path.join(dir, name));
    const keep = Math.max(1, Number(env.ETNA_OFFSITE_KEEP) || 14);
    const pruned = bundlesToPrune(listBundles(dir), keep);
    for (const old of pruned) fs.rmSync(path.join(dir, old), { force: true });
    const files = manifest.entries.filter((e) => e.name.startsWith('files/')).length;
    const bytes = fs.statSync(path.join(dir, name)).size;
    console.log(
      `Wrote ${path.join(dir, name)} (${(bytes / 1048576).toFixed(1)} MB: database, ${files} document file(s)${settingsFile ? ', settings' : ''}).` +
        (pruned.length ? ` Removed ${pruned.length} older backup(s).` : '')
    );
  } catch (error) {
    fs.rmSync(partial, { force: true });
    // The log line the error alerts pick up (src/server/alerts.ts).
    console.error('[offsite] backup failed:', error instanceof Error ? error.message.slice(0, 200) : 'error');
    if (error?.code === 'EPERM' || error?.code === 'EACCES')
      console.error(`This Windows account may not write to ${dir}. Give it write permission there, or choose another folder (ETNA_OFFSITE_DIR in the settings).`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function listCommand() {
  const dir = offsiteDir();
  const bundles = listBundles(dir);
  if (!bundles.length) return console.log(`No off-site backups in ${dir}.`);
  for (const b of bundles) console.log(`${b.name}  ${(b.size / 1048576).toFixed(1)} MB  ${readHeader(path.join(dir, b.name)).header.created}`);
}

const bundlePath = (name) => {
  if (!name) fail(`Usage: offsite.mjs ${command} <file>`, 2);
  const file = fs.existsSync(name) ? name : env.ETNA_OFFSITE_DIR ? path.join(env.ETNA_OFFSITE_DIR, name) : name;
  if (!fs.existsSync(file)) fail(`${name} does not exist.`, 2);
  return path.resolve(file);
};

const explain = (error) =>
  error?.message === 'wrong_passphrase'
    ? 'Wrong passphrase.'
    : error?.message === 'damaged'
      ? 'The backup is damaged or was changed: it cannot be used.'
      : error?.message === 'not_a_bundle'
        ? 'This is not an ETNA off-site backup.'
        : error instanceof Error
          ? error.message
          : String(error);

function summary(manifest) {
  const files = manifest.entries.filter((e) => e.name.startsWith('files/'));
  const size = manifest.entries.reduce((n, e) => n + e.size, 0);
  return [
    `Made ${manifest.createdAt} on ${manifest.host ?? '?'} by ETNA ${manifest.appVersion ?? '?'}`,
    `Database ${manifest.database ?? '?'}${manifest.migrations ? `, ${manifest.migrations.length} migrations applied` : ''}`,
    `${files.length} document file(s), ${(size / 1048576).toFixed(1)} MB in all${manifest.entries.some((e) => e.name === 'settings/etna.env') ? ', settings included' : ', settings not included'}`,
  ].join('\n');
}

async function verifyCommand() {
  const file = bundlePath(args[1]);
  const passphrase = await readPassphrase('Passphrase: ');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'etna-verify-'));
  const into = path.join(work, 'bundle');
  try {
    const manifest = await readBundle(file, passphrase, { into });
    const pgRestore = findTool('pg_restore');
    let toc = 'pg_restore not found: the dump itself was not read';
    if (pgRestore) {
      const list = await run(pgRestore, ['--list', path.join(into, 'database.dump')]);
      toc = `the dump lists ${list.split(/\r?\n/).filter((l) => /^\d+;/.test(l)).length} objects`;
    }
    console.log(`OK: ${path.basename(file)} opens, every file matches its checksum, ${toc}.`);
    console.log(summary(manifest));
  } catch (error) {
    fail(`NOT OK: ${explain(error)}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function restoreCommand() {
  const file = bundlePath(args[1]);
  const to = option('--to');
  if (!to) fail('Usage: offsite.mjs restore <file> --to <new folder> [--database <url>]', 2);
  const database = option('--database');
  const passphrase = await readPassphrase('Passphrase: ');
  let manifest;
  try {
    manifest = await readBundle(file, passphrase, { into: to });
  } catch (error) {
    fail(`Not restored: ${explain(error)}`);
  }
  console.log(`Unpacked into ${path.resolve(to)}:`);
  console.log(summary(manifest));
  if (database) {
    const pgRestore = findTool('pg_restore');
    if (!pgRestore) fail('pg_restore was not found. Install the PostgreSQL command-line tools.', 2);
    const dump = path.join(to, 'database.dump');
    const listFile = path.join(os.tmpdir(), `etna-offsite-restore-${process.pid}.list`);
    try {
      fs.writeFileSync(listFile, restoreList(await run(pgRestore, ['--list', dump])));
      await run(
        pgRestore,
        [...connection(database), '--clean', '--if-exists', '--single-transaction', '--exit-on-error', '--no-owner', '--use-list', listFile, dump],
        passwordEnv(database)
      );
    } catch (error) {
      fail(`The database was not restored (nothing changed in it): ${explain(error)}`);
    } finally {
      fs.rmSync(listFile, { force: true });
    }
    console.log(`Restored the database into ${parseUrl(database).database}.`);
  }
  console.log('');
  console.log('Next (docs/teknis/OPERATIONS.md, "Off-site backups"):');
  if (!database) console.log(`  - database: run again with --database <url of a database prepared with this ETNA version>`);
  console.log(`  - documents: copy ${path.join(to, 'files', 'documents')} to <ETNA_DATA_ROOT>/documents and ${path.join(to, 'files', 'companies')} to <ETNA_DATA_ROOT>/companies`);
  console.log(`  - settings: ${manifest.entries.some((e) => e.name === 'settings/etna.env') ? `${path.join(to, 'settings', 'etna.env')} holds the keys (MFA_ENCRYPTION_KEY)` : 'not in this backup: use the etna.env kept in your password manager'}`);
}

const commands = { keys: keysCommand, run: runCommand, list: listCommand, verify: verifyCommand, restore: restoreCommand };
if (!commands[command]) fail('Usage: offsite.mjs keys | run | list | verify <file> | restore <file> --to <folder> [--database <url>]', 2);
await commands[command]();
