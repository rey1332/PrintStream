#!/usr/bin/env node
// Moving ETNA from one PC to another (docs/PANDUAN.md, 4.7 and 4.8): one
// encrypted .etnabak with everything (the database, the documents and
// company folders in storage/, and .env.local with the two-factor key), and
// one command on the new PC that puts all of it back. The file is the
// off-site format (scripts/db/offsite-core.mjs): a server restores it with
// `psctl restore` too.
//
//   npm run pc:backup                       a backup (the first time: folder and passphrase)
//   npm run pc:verify -- <file>             opens and checks one (passphrase)
//   npm run pc:restore -- <file> [--into <empty database>] [--yes]
//
// A restore never overwrites: it fills an empty database (a new PC's `etna`,
// or one named with --into), moves this PC's documents and .env.local aside
// first, and gives the app's login roles new passwords. The unpacked backup
// is removed afterwards, whatever happens.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import pg from 'pg';
import { ROOT, findTool, parseUrl, restoreList } from './backup-core.mjs';
import { listMigrations, migrate } from './migrator.mjs';
import { readBundle } from './offsite-core.mjs';
import { saveOwnerPassword } from './owner.mjs';
import { dataDirs, restoredSettings, sameServerLogins } from './pc-move-core.mjs';
import { newAppKeys, newLogin } from './provision.mjs';
import { readEnvFile, updateEnv } from '../server/lib/envfile.mjs';
import { restorePlan, stamp } from '../server/lib/psctl-core.mjs';
import { MIN_PASSPHRASE, newBackupKeys } from '../server/lib/sealed.mjs';
import { readPassphrase } from '../server/lib/secret-input.mjs';

const ENV_FILE = path.join(ROOT, '.env.local');
const KEYS_DIR = path.join(ROOT, 'storage', 'backup-keys');
const OFFSITE = path.join(ROOT, 'scripts', 'db', 'offsite.mjs');
const DEFAULT_OWNER = 'postgres://etna_owner@localhost:5432/etna';

const args = process.argv.slice(2);
const command = args[0];
const option = (name) => {
  const at = args.indexOf(name);
  return at > 0 ? args[at + 1] : undefined;
};
const yes = args.includes('--yes');
/** Stops the command; thrown (not process.exit) so that cleanup in `finally` still runs. */
class Stop extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
const fail = (message, code = 1) => {
  throw new Stop(message, code);
};
const say = (message) => console.log(`\n== ${message}`);

async function ask(question, fallback = '') {
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim() || fallback;
}

function runNode(script, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...argv], { stdio: 'inherit', windowsHide: true });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function runTool(file, argv, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `${path.basename(file)} exited with ${code}`))
    );
  });
}

const pgArgs = (url) => {
  const c = parseUrl(url);
  return ['--host', c.host, '--port', c.port, '--username', c.user, '--no-password', '--dbname', c.database];
};
const withDatabase = (url, database) => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};
const withoutPassword = (url) => {
  const u = new URL(url);
  u.password = '';
  return u.toString();
};

async function withClient(url, password, fn) {
  const client = new pg.Client({ connectionString: url, password: password || undefined, application_name: 'etna-pc-move' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}
const adapter = (client) => ({ exec: (sql) => client.query(sql), query: (sql, params) => client.query(sql, params) });

/** Moves a folder (a rename, or a copy across disks). */
function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error?.code !== 'EXDEV' && error?.code !== 'EPERM') throw error;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}
const filled = (dir) => fs.existsSync(dir) && fs.readdirSync(dir).length > 0;

// ─── backup ─────────────────────────────────────────────────────────────────

/** The first backup on this PC: where backups go, and the key pair with its passphrase. */
async function setupBackups(current) {
  if (!process.stdin.isTTY) fail('Backups are not set up on this PC: run npm run pc:backup once in a Command Prompt to choose the folder and the passphrase.', 2);
  console.log('Backups are not set up on this PC yet.');
  console.log('A backup holds every company\'s data and keys: put it on another disk (a USB drive, a NAS, a network share).');
  const typed = await ask(`Folder for the backups${current.ETNA_OFFSITE_DIR ? ` [${current.ETNA_OFFSITE_DIR}]` : ' (e.g. E:\\ETNA-backup)'}: `, current.ETNA_OFFSITE_DIR || '');
  if (!typed) fail('No folder given. Nothing was changed.', 2);
  const dir = path.resolve(typed);
  if (path.parse(dir).root.toLowerCase() === path.parse(ROOT).root.toLowerCase())
    console.log(`Note: ${dir} is on the same disk as ETNA (${path.parse(ROOT).root}). If this disk fails, the backup goes with it: copy the file elsewhere too.`);

  const pub = path.join(KEYS_DIR, 'offsite-key.pub.pem');
  const priv = path.join(KEYS_DIR, 'offsite-key.enc.pem');
  if (!fs.existsSync(pub) || !fs.existsSync(priv)) {
    console.log(`The passphrase opens the backups (at least ${MIN_PASSPHRASE} characters). Keep it in a password manager: without it no backup can be opened, and ETNA cannot recover it.`);
    const passphrase = await readPassphrase('Passphrase: ');
    if (passphrase.length < MIN_PASSPHRASE) fail(`The passphrase needs at least ${MIN_PASSPHRASE} characters. Nothing was changed.`, 2);
    if (process.stdin.isTTY && (await readPassphrase('Passphrase again: ')) !== passphrase) fail('The two passphrases differ. Nothing was changed.', 2);
    const keys = newBackupKeys(passphrase);
    fs.mkdirSync(KEYS_DIR, { recursive: true });
    fs.writeFileSync(pub, keys.publicKey, { mode: 0o644 });
    fs.writeFileSync(priv, keys.privateKey, { mode: 0o600 });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    ENV_FILE,
    updateEnv(fs.readFileSync(ENV_FILE, 'utf8'), { ETNA_OFFSITE_DIR: dir, ETNA_OFFSITE_KEY: pub, ETNA_OFFSITE_KEEP: current.ETNA_OFFSITE_KEEP || '14' })
  );
  console.log(`Saved in .env.local: backups go to ${dir}.`);
}

async function backupCommand() {
  if (!fs.existsSync(ENV_FILE)) fail('This PC has no .env.local: ETNA is not set up here (node scripts/setup-local.mjs), or restore a backup with npm run pc:restore.', 2);
  const current = readEnvFile(ENV_FILE);
  if (!current.ETNA_OFFSITE_DIR || !current.ETNA_OFFSITE_KEY || !fs.existsSync(current.ETNA_OFFSITE_KEY)) await setupBackups(current);
  // The database, storage/ and .env.local (the keys) in one encrypted file.
  process.exitCode = await runNode(OFFSITE, ['run', '--settings', ENV_FILE]);
}

// ─── restore ────────────────────────────────────────────────────────────────

async function restoreCommand() {
  const name = args[1];
  if (!name || name.startsWith('--')) fail('Usage: npm run pc:restore -- <file.etnabak> [--into <empty database>] [--yes]', 2);
  const file = path.resolve(name);
  if (!fs.existsSync(file)) fail(`${file} does not exist.`, 2);
  const pgRestore = findTool('pg_restore');
  if (!pgRestore) fail('pg_restore was not found. Install PostgreSQL (with its command-line tools) first.', 2);

  // This PC: its settings (if ETNA ran here) and the schema owner.
  const current = fs.existsSync(ENV_FILE) ? readEnvFile(ENV_FILE) : {};
  let ownerUrl = current.MIGRATION_DATABASE_URL || (await ask(`Database owner connection [${DEFAULT_OWNER}]: `, DEFAULT_OWNER));
  ownerUrl = withoutPassword(ownerUrl);
  const into = option('--into');
  const target = into ? withDatabase(ownerUrl, into) : ownerUrl;
  const password =
    process.env.PGPASSWORD || (process.stdin.isTTY ? await readPassphrase(`Password of ${decodeURIComponent(new URL(target).username)} (not shown): `) : '');

  // The target must be empty: a restore never writes over data.
  let state;
  try {
    state = await withClient(target, password, async (client) => {
      const { rows } = await client.query(`
        select to_regclass('etna_meta.schema_migrations') is not null as etna,
               (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
                   and n.nspname not like 'pg_toast%') as tables`);
      return rows[0];
    });
  } catch (error) {
    fail(`Could not connect to ${parseUrl(target).database} as ${parseUrl(target).user}: ${error.message}. Create the owner and the database in pgAdmin first (docs/PANDUAN.md, bagian 4.3 dan 4.8).`, 2);
  }
  const database = parseUrl(target).database;
  if (state.tables > 0)
    fail(
      [
        `Database ${database} is not empty (${state.tables} tables${state.etna ? ', an ETNA database' : ''}): a restore never writes over data.`,
        'Make an empty one in pgAdmin (Query Tool, as postgres), then run again with --into:',
        `  CREATE DATABASE etna_restore OWNER ${parseUrl(target).user};`,
        `  npm run pc:restore -- "${file}" --into etna_restore`,
      ].join('\n'),
      2
    );

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'etna-pc-restore-'));
  const unpacked = path.join(work, 'bundle');
  try {
    say(`Opening ${path.basename(file)}`);
    let manifest;
    try {
      manifest = await readBundle(file, await readPassphrase('Backup passphrase: '), { into: unpacked });
    } catch (error) {
      fail(
        `Not restored: ${
          error?.message === 'wrong_passphrase'
            ? 'wrong passphrase.'
            : error?.message === 'damaged'
              ? 'the backup is damaged or was changed: it cannot be used.'
              : error?.message === 'not_a_bundle'
                ? 'this is not an ETNA backup.'
                : error?.message
        }`
      );
    }
    const settingsFile = path.join(unpacked, 'settings', 'etna.env');
    const fromBackup = fs.existsSync(settingsFile) ? readEnvFile(settingsFile) : null;
    const files = manifest.entries.filter((e) => e.name.startsWith('files/')).length;
    console.log(
      `Made ${manifest.createdAt} on ${manifest.host ?? '?'} by ETNA ${manifest.appVersion ?? '?'}: ${manifest.migrations?.length ?? '?'} migrations, ${files} document file(s), settings ${fromBackup ? 'included' : 'NOT included'}.`
    );
    if (!fromBackup) console.log('Without its settings the backup\'s two-factor key is not known: everyone enrols their authenticator again.');
    const all = listMigrations();
    const plan = restorePlan(
      all.map((m) => m.name),
      manifest.migrations
    );
    if (!plan.ok) fail(plan.reason, 2);

    const dirs = dataDirs(current, ROOT);
    const tag = stamp();
    const aside = path.join(ROOT, 'storage', `before-restore-${tag}`);
    console.log(
      [
        '',
        'This will:',
        `  - fill the empty database ${database} with the backup (and this version's newer migrations);`,
        sameServerLogins(current, target)
          ? `  - keep this PC's database logins (the same PostgreSQL server);`
          : `  - give the app's login roles new passwords;`,
        `  - put the backup's documents in ${dirs.documents} and ${dirs.companies}${filled(dirs.documents) || filled(dirs.companies) ? ` (this PC's move to ${aside})` : ''};`,
        fs.existsSync(ENV_FILE)
          ? `  - write a new .env.local (this PC's is kept as .env.local.before-restore-${tag}).`
          : '  - write .env.local.',
      ].join('\n')
    );
    if (!yes) {
      if (!process.stdin.isTTY) fail('Not confirmed: run in a Command Prompt, or add --yes. Nothing was changed.', 2);
      if ((await ask('Type restore to continue: ')).toLowerCase() !== 'restore') fail('Not confirmed. Nothing was changed.', 2);
    }

    say('Restoring the database');
    const dump = path.join(unpacked, 'database.dump');
    const replay = new Set(plan.replay);
    await withClient(target, password, (client) => migrate(adapter(client), { migrations: all.filter((m) => replay.has(m.name)) }));
    const listFile = `${dump}.list`;
    fs.writeFileSync(listFile, restoreList(await runTool(pgRestore, ['--list', dump])));
    try {
      await runTool(
        pgRestore,
        [...pgArgs(target), '--clean', '--if-exists', '--single-transaction', '--exit-on-error', '--no-owner', '--use-list', listFile, dump],
        password ? { PGPASSWORD: password } : {}
      );
    } catch (error) {
      fail(`pg_restore failed: ${error.message}. Nothing else was changed (the database ${database} has only the migrations; empty it or use another one).`);
    }
    const { applied, users, urls } = await withClient(target, password, async (client) => {
      const applied = await migrate(adapter(client), { log: (l) => console.log(l) });
      const users = (await client.query('select count(*)::int as n from auth.users')).rows[0].n;
      // The login roles are the PostgreSQL server's, shared by its every ETNA
      // database: on a server this PC already uses, its logins are kept (only
      // the database changes), so nothing else on it loses its connection.
      const urls = sameServerLogins(current, target) ?? {
        DATABASE_URL: await newLogin(client, target, 'etna_app'),
        AUTH_DATABASE_URL: await newLogin(client, target, 'etna_auth'),
        WORKER_DATABASE_URL: await newLogin(client, target, 'etna_worker'),
      };
      return { applied, users, urls };
    });
    console.log(`Database ${database}: ${users} user(s)${applied.length ? `, ${applied.length} newer migration(s) applied` : ''}.`);

    say('Putting back the documents');
    for (const [from, to] of [
      [path.join(unpacked, 'files', 'documents'), dirs.documents],
      [path.join(unpacked, 'files', 'companies'), dirs.companies],
    ]) {
      if (filled(to)) moveDir(to, path.join(aside, path.basename(to)));
      else fs.rmSync(to, { recursive: true, force: true });
      if (fs.existsSync(from)) moveDir(from, to);
      else fs.mkdirSync(to, { recursive: true });
    }

    say('Writing .env.local');
    if (fs.existsSync(ENV_FILE)) fs.copyFileSync(ENV_FILE, `${ENV_FILE}.before-restore-${tag}`);
    const next = restoredSettings({ fromBackup, current, urls, ownerUrl: withoutPassword(target), freshKeys: newAppKeys() });
    fs.writeFileSync(
      ENV_FILE,
      updateEnv(`# ETNA on PostgreSQL — restored from ${path.basename(file)} by scripts/db/pc-move.mjs. Never commit; back it up.\n`, next),
      { mode: 0o600 }
    );
    if (password) saveOwnerPassword(withoutPassword(target), password);

    // The app's own login works on the restored database.
    await withClient(urls.DATABASE_URL, null, (client) => client.query('select 1'));
    say(`Restored: ${users} user(s), ${files} document file(s)${fromBackup ? ', the backup\'s keys' : ''}.`);
    console.log('Start ETNA again: npm run dev (or npm run build, then npm start), and npm run worker for the Terminal.');
    console.log('Set up backups on this PC too: npm run pc:backup.');
    if (fs.existsSync(aside)) console.log(`This PC's previous documents are in ${aside} until you remove them.`);
  } finally {
    // The unpacked dump and settings hold everything: never left behind.
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ─── verify ─────────────────────────────────────────────────────────────────

async function verifyCommand() {
  if (!args[1]) fail('Usage: npm run pc:verify -- <file.etnabak>', 2);
  process.exitCode = await runNode(OFFSITE, ['verify', path.resolve(args[1])]);
}

const commands = { backup: backupCommand, restore: restoreCommand, verify: verifyCommand };
try {
  if (!commands[command]) fail('Usage: pc-move.mjs backup | verify <file> | restore <file> [--into <empty database>] [--yes]', 2);
  await commands[command]();
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  console.error(error.message);
  process.exitCode = error.code;
}
