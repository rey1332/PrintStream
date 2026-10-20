#!/usr/bin/env node
// psctl — runs an ETNA server on Linux (docs/INSTALL-LINUX.md, "psctl").
// Installed as /usr/local/bin/psctl by deploy/linux/install.sh; run as root.
//
//   psctl status [--json]           services, health, version, database, backups, disk
//   psctl doctor                    checks settings, permissions, TLS, backups, disk
//   psctl start | stop | restart    the app and the Terminal worker
//   psctl logs [-f] [-n <lines>]    their journal
//   psctl migrate                   applies new migrations (as the schema owner)
//   psctl backup-setup [--copy-to <folder>] [--keep <n>]
//                                   key pair for encrypted backups + the nightly timer
//   psctl backup                    one encrypted backup: database, documents, settings
//   psctl backups                   lists them
//   psctl verify <file>             opens a backup and checks every file in it
//   psctl restore <file> [--into <empty database>] [--yes]
//                                   restores into a NEW database, then switches the app
//                                   to it when you confirm; the old database and files stay
//   psctl upgrade <folder | .tar.gz> [--yes]
//                                   installs another version (backup first, rollback on failure)
//   psctl rollback [--yes]          back to the previous release
//   psctl db move <owner url> [--yes]
//                                   copies the database to another PostgreSQL server
//                                   (a database VM) and switches the app to it
//   psctl databases                 the ETNA databases on this server
//   psctl users create-user --email you@example.com
//                                   accounts (scripts/admin/users.mjs, as the schema owner)
//
// psctl never drops, empties or overwrites a database: a restore and a move
// always fill a new or empty one, and what was there before is kept.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { readEnvFile, writeEnvFile } from './lib/envfile.mjs';
import { readPassphrase } from './lib/secret-input.mjs';
import {
  PATHS,
  classifyDatabase,
  databaseOf,
  doctorFindings,
  pgpassLine,
  previousRelease,
  releaseRoot,
  restorePlan,
  retargetSettings,
  sameServer,
  stamp,
  tlsProblem,
  upsertPgpassLine,
  withDatabase,
  withoutPassword,
} from './lib/psctl-core.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVICES = ['etna', 'etna-worker'];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith('-') && !(i > 0 && /^(--into|--copy-to|--keep|--lines|-n)$/.test(argv[i - 1])));

class Stop extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
const fail = (message, code = 1) => {
  throw new Stop(message, code);
};
const say = (text) => console.log(`\x1b[1m==>\x1b[0m ${text}`);
const warn = (text) => console.error(`\x1b[33m${text}\x1b[0m`);

// ─── Helpers ────────────────────────────────────────────────────────────────

function requireRoot() {
  if (process.getuid?.() !== 0) fail('Run psctl as root (sudo psctl …).', 2);
}

function run(file, args, { env = {}, input, inherit = false, allowFail = false } = {}) {
  const r = spawnSync(file, args, {
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) fail(`${file}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) fail(`${path.basename(file)} ${args[0] ?? ''} failed: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
  return r;
}

/** Runs and waits, output shown as it comes (long steps: pg_restore, install.sh). */
function stream(file, args, { env = {}, stdin = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: { ...process.env, ...env }, stdio: [stdin, 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function confirm(question, word) {
  if (flag('--yes')) return true;
  if (!process.stdin.isTTY) fail(`${question}\nNot asked (no terminal): run again with --yes to go ahead.`, 2);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question}\nType ${word} to go ahead: `, resolve));
  rl.close();
  return answer.trim() === word;
}

function ctl() {
  return readEnvFile(PATHS.ctlFile);
}

/** psctl's settings, plus the owner's password file for every child. */
function ownerEnv() {
  const settings = ctl();
  if (!settings.MIGRATION_DATABASE_URL)
    fail(`${PATHS.ctlFile} has no MIGRATION_DATABASE_URL (the schema owner). Run deploy/linux/install.sh with the owner's connection.`, 2);
  return { url: settings.MIGRATION_DATABASE_URL, env: { PGPASSFILE: PATHS.ownerPgpass }, settings };
}

// The owner's password comes from its password file (PGPASSFILE, set below
// for psctl and every child), never from a command line.
async function withClient(url, _env, fn) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url, application_name: 'psctl' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

const adapter = (client) => ({ exec: (sql) => client.query(sql), query: (sql, params) => client.query(sql, params) });

async function databaseState(client) {
  const { rows } = await client.query(`
    select to_regclass('etna_meta.schema_migrations') is not null as etna,
           (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
               and n.nspname not like 'pg_toast%') as tables,
           pg_database_size(current_database())::bigint as bytes`);
  const s = rows[0];
  const out = { kind: classifyDatabase(s), tables: s.tables, bytes: Number(s.bytes), migrations: 0, users: null };
  if (s.etna) {
    out.migrations = (await client.query('select count(*)::int as n from etna_meta.schema_migrations')).rows[0].n;
    out.users = (await client.query(`select count(*)::int as n from auth.users`).catch(() => ({ rows: [{ n: null }] }))).rows[0].n;
  }
  return out;
}

async function health(port, { tries = 1, wait = 2000 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    if (i + 1 < tries) await new Promise((r) => setTimeout(r, wait));
  }
  return false;
}

const appPort = () => readEnvFile(PATHS.envFile).ETNA_PORT || '4028';
const systemctl = (...args) => run('systemctl', args, { allowFail: true });
const serviceState = (name) => systemctl('is-active', `${name}.service`).stdout.trim() || 'unknown';

async function restartAndCheck() {
  run('systemctl', ['restart', ...SERVICES.map((s) => `${s}.service`)]);
  return health(appPort(), { tries: 45 });
}

function statOf(file) {
  try {
    const s = fs.statSync(file);
    const name = (id, db) => {
      const line = fs.readFileSync(db, 'utf8').split('\n').find((l) => l.split(':')[2] === String(id));
      return line ? line.split(':')[0] : String(id);
    };
    return { owner: `${name(s.uid, '/etc/passwd')}:${name(s.gid, '/etc/group')}`, mode: s.mode };
  } catch {
    return null;
  }
}

function writeRootFile(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function setCtl(changes) {
  writeEnvFile(PATHS.ctlFile, changes);
  fs.chmodSync(PATHS.ctlFile, 0o600);
}

function setAppEnv(changes) {
  writeEnvFile(PATHS.envFile, changes);
  run('chown', ['root:etna', PATHS.envFile]);
  fs.chmodSync(PATHS.envFile, 0o640);
}

async function offsite() {
  const { listBundles, readBundle, readHeader } = await import('../db/offsite-core.mjs');
  return { listBundles, readBundle, readHeader };
}

function backupSettings() {
  const s = ctl();
  return {
    dir: s.ETNA_BACKUP_DIR || PATHS.backupDir,
    key: s.ETNA_BACKUP_KEY || '',
    keep: s.ETNA_BACKUP_KEEP || '14',
    copyDir: s.ETNA_BACKUP_COPY_DIR || '',
    configured: Boolean(s.ETNA_BACKUP_KEY && fs.existsSync(s.ETNA_BACKUP_KEY)),
  };
}

const explainBundleError = (error) =>
  error?.message === 'wrong_passphrase'
    ? 'Wrong passphrase.'
    : error?.message === 'damaged'
      ? 'The backup is damaged or was changed: it cannot be used.'
      : error?.message === 'not_a_bundle'
        ? 'This is not an ETNA backup.'
        : error instanceof Error
          ? error.message
          : String(error);

async function resolveBackupFile(name) {
  if (!name) fail('Name the backup file (psctl backups lists them).', 2);
  if (fs.existsSync(name)) return path.resolve(name);
  const inDir = path.join(backupSettings().dir, path.basename(name));
  if (fs.existsSync(inDir)) return inDir;
  fail(`${name} does not exist.`, 2);
}

function pgTool(name) {
  // The newest installed major: dumps of a PostgreSQL 18 server need pg_dump 18.
  const root = '/usr/lib/postgresql';
  const majors = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^\d+$/.test(d)).sort((a, b) => b - a) : [];
  for (const major of majors) {
    const file = path.join(root, major, 'bin', name);
    if (fs.existsSync(file)) return file;
  }
  const found = run('sh', ['-c', `command -v ${name}`], { allowFail: true }).stdout.trim();
  if (!found) fail(`${name} was not found. Install the PostgreSQL client: apt install postgresql-client-18`, 2);
  return found;
}

/** pg_dump / pg_restore take the whole URL (with its TLS settings) as --dbname; never a password. */
const pgArgs = (url) => ['--no-password', '--dbname', withoutPassword(url)];

/** TLS settings of the URL for offsite.mjs, which passes host and port to pg_dump separately. */
function pgTlsEnv(url) {
  const q = new URL(url).searchParams;
  const env = {};
  for (const [param, name] of [
    ['sslmode', 'PGSSLMODE'],
    ['sslrootcert', 'PGSSLROOTCERT'],
  ])
    if (q.get(param)) env[name] = q.get(param);
  return env;
}

// ─── status / doctor ────────────────────────────────────────────────────────

/** Installed releases, oldest first: by the install time in the name (etna-<version>-<time>). */
function releases() {
  if (!fs.existsSync(PATHS.releases)) return [];
  const installed = (d) => d.slice(d.lastIndexOf('-') + 1);
  return fs
    .readdirSync(PATHS.releases)
    .filter((d) => d.startsWith('etna-'))
    .sort((a, b) => installed(a).localeCompare(installed(b)))
    .map((d) => path.join(PATHS.releases, d));
}

function currentRelease() {
  try {
    return fs.realpathSync(PATHS.current);
  } catch {
    return null;
  }
}

function newestBackupAgeHours(dir, listBundles) {
  const newest = listBundles(dir)[0];
  if (!newest) return null;
  return (Date.now() - fs.statSync(path.join(dir, newest.name)).mtimeMs) / 3600_000;
}

function disk(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { path: dir, freeRatio: s.bavail / s.blocks, freeGb: (s.bavail * s.bsize) / 1e9 };
  } catch {
    return null;
  }
}

async function gather() {
  const { listBundles } = await offsite();
  const settings = readEnvFile(PATHS.envFile);
  const control = ctl();
  const facts = {
    envFile: statOf(PATHS.envFile),
    ctlFile: statOf(PATHS.ctlFile),
    ownerPgpass: statOf(PATHS.ownerPgpass),
    settings,
    ownerUrl: control.MIGRATION_DATABASE_URL,
    services: Object.fromEntries(SERVICES.map((s) => [s, serviceState(s)])),
    health: await health(settings.ETNA_PORT || '4028'),
    release: currentRelease(),
    version: null,
    pendingMigrations: 0,
    database: null,
    backup: null,
    disks: [PATHS.dataRoot, backupSettings().dir, '/'].map(disk).filter(Boolean),
  };
  try {
    facts.version = JSON.parse(fs.readFileSync(path.join(PATHS.current, 'package.json'), 'utf8')).version;
  } catch {
    // not installed
  }
  if (control.MIGRATION_DATABASE_URL) {
    try {
      const { migrate } = await import('../db/migrator.mjs');
      await withClient(control.MIGRATION_DATABASE_URL, { PGPASSFILE: PATHS.ownerPgpass }, async (client) => {
        const state = await databaseState(client);
        facts.pendingMigrations = (await migrate(adapter(client), { dryRun: true })).length;
        facts.database = {
          ok: state.kind === 'etna',
          name: databaseOf(control.MIGRATION_DATABASE_URL),
          ...state,
          text: `database ${databaseOf(control.MIGRATION_DATABASE_URL)} on ${new URL(control.MIGRATION_DATABASE_URL).host}: ${state.migrations} migrations, ${state.users ?? '?'} user(s), ${(state.bytes / 1048576).toFixed(0)} MB`,
        };
      });
    } catch (error) {
      facts.database = { ok: false, text: `the database cannot be reached as its owner: ${error.message}` };
    }
  }
  const b = backupSettings();
  facts.backup = { configured: b.configured, dir: b.dir, copyDir: b.copyDir, newestAgeHours: b.configured ? newestBackupAgeHours(b.dir, listBundles) : null };
  return facts;
}

async function statusCommand() {
  const f = await gather();
  if (flag('--json')) {
    const { settings, ...rest } = f;
    // Never the settings themselves: they hold keys and passwords.
    return console.log(JSON.stringify({ ...rest, settings: Object.keys(settings) }, null, 2));
  }
  const line = (label, value) => console.log(`${label.padEnd(12)} ${value}`);
  line('Version', f.version ? `${f.version} (${f.release ? path.basename(f.release) : '?'})` : 'not installed');
  for (const [name, state] of Object.entries(f.services)) line(name, state);
  line('Health', f.health ? 'ok' : 'NOT answering');
  line('Database', f.database ? f.database.text : 'unknown (no owner connection in psctl.env)');
  if (f.pendingMigrations) line('Migrations', `${f.pendingMigrations} pending (psctl migrate)`);
  line(
    'Backups',
    !f.backup.configured
      ? 'not set up (psctl backup-setup)'
      : f.backup.newestAgeHours == null
        ? `none yet in ${f.backup.dir}`
        : `newest ${f.backup.newestAgeHours.toFixed(1)} h ago in ${f.backup.dir}${f.backup.copyDir ? ` (+ ${f.backup.copyDir})` : ''}`
  );
  for (const d of f.disks) line('Disk', `${d.path}: ${d.freeGb.toFixed(1)} GB free (${Math.round(d.freeRatio * 100)}%)`);
  if (!f.health || Object.values(f.services).some((s) => s !== 'active')) process.exitCode = 1;
}

async function doctorCommand() {
  const findings = doctorFindings(await gather());
  const mark = { ok: '\x1b[32mok  \x1b[0m', warn: '\x1b[33mwarn\x1b[0m', fail: '\x1b[31mFAIL\x1b[0m' };
  for (const f of findings) console.log(`${mark[f.level]} ${f.text}`);
  if (findings.some((f) => f.level === 'fail')) process.exitCode = 1;
}

// ─── services ───────────────────────────────────────────────────────────────

function servicesCommand(action) {
  run('systemctl', [action, ...SERVICES.map((s) => `${s}.service`)], { inherit: true });
}

function logsCommand() {
  const args = ['-u', 'etna', '-u', 'etna-worker', '-u', 'etna-backup', '--no-pager', '-n', option('-n') || option('--lines') || '200'];
  if (flag('-f') || flag('--follow')) args.push('-f');
  const r = spawnSync('journalctl', args, { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}

async function migrateCommand() {
  const { url, env } = ownerEnv();
  const { migrate } = await import('../db/migrator.mjs');
  const applied = await withClient(url, env, (client) => migrate(adapter(client), { log: (l) => console.log(l) }));
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
}

// ─── backups ────────────────────────────────────────────────────────────────

async function backupSetupCommand() {
  const keyDir = PATHS.backupKeys;
  const pub = path.join(keyDir, 'offsite-key.pub.pem');
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(keyDir, 0o700);
  if (!fs.existsSync(pub)) {
    console.log('Backups are encrypted. Choose a passphrase (at least 12 characters) and keep it in a password manager:');
    console.log('without it no backup can be opened, with it any backup file is enough to restore.');
    const code = await stream(process.execPath, [path.join(APP, 'scripts', 'db', 'offsite.mjs'), 'keys', '--dir', keyDir]);
    if (code !== 0) fail('No keys were made.', code);
  } else console.log(`Keeping the existing key pair in ${keyDir}.`);
  const dir = ctl().ETNA_BACKUP_DIR || PATHS.backupDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const changes = { ETNA_BACKUP_DIR: dir, ETNA_BACKUP_KEY: pub };
  if (option('--keep')) {
    if (!/^\d+$/.test(option('--keep')) || Number(option('--keep')) < 1) fail('--keep needs a number of backups (1 or more).', 2);
    changes.ETNA_BACKUP_KEEP = option('--keep');
  }
  if (option('--copy-to')) {
    const copy = path.resolve(option('--copy-to'));
    if (!fs.existsSync(copy) || !fs.statSync(copy).isDirectory()) fail(`${copy} is not a folder (mount the NAS or disk first).`, 2);
    if (copy.startsWith(dir + path.sep) || copy === dir) fail('The second place must not be inside the backup folder.', 2);
    changes.ETNA_BACKUP_COPY_DIR = copy;
  }
  setCtl(changes);
  systemctl('daemon-reload');
  run('systemctl', ['enable', '--now', 'etna-backup.timer']);
  say(`Nightly encrypted backups into ${dir}${changes.ETNA_BACKUP_COPY_DIR ? `, copied to ${changes.ETNA_BACKUP_COPY_DIR}` : ''} (etna-backup.timer).`);
  console.log('Make the first one now: psctl backup');
}

async function backupCommand() {
  const b = backupSettings();
  if (!b.configured) fail('Backups are not set up yet: psctl backup-setup', 2);
  const { url, env } = ownerEnv();
  const work = path.join(b.dir, '.work');
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  const code = await stream(process.execPath, [path.join(APP, 'scripts', 'db', 'offsite.mjs'), 'run', '--settings', PATHS.envFile], {
    stdin: 'ignore',
    env: {
      ...env,
      ...pgTlsEnv(url),
      OFFSITE_DATABASE_URL: url,
      ETNA_OFFSITE_DIR: b.dir,
      ETNA_OFFSITE_KEY: b.key,
      ETNA_OFFSITE_KEEP: b.keep,
      TMPDIR: work,
    },
  });
  if (code !== 0) fail('The backup failed (see above).', code);
  if (b.copyDir) {
    const { listBundles } = await offsite();
    const newest = listBundles(b.dir)[0];
    if (!fs.existsSync(b.copyDir)) fail(`The second place ${b.copyDir} is not there (is it mounted?). The backup stays in ${b.dir}.`);
    const partial = path.join(b.copyDir, `.${newest.name}.partial`);
    fs.copyFileSync(path.join(b.dir, newest.name), partial);
    fs.renameSync(partial, path.join(b.copyDir, newest.name));
    const keep = Number(b.keep) || 14;
    for (const old of listBundles(b.copyDir).slice(keep)) fs.rmSync(path.join(b.copyDir, old.name), { force: true });
    console.log(`Copied to ${path.join(b.copyDir, newest.name)}.`);
  }
}

async function backupsCommand() {
  const { listBundles, readHeader } = await offsite();
  const b = backupSettings();
  for (const dir of [b.dir, b.copyDir].filter(Boolean)) {
    const list = listBundles(dir);
    console.log(`${dir}: ${list.length ? '' : 'no backups'}`);
    for (const x of list) console.log(`  ${x.name}  ${(x.size / 1048576).toFixed(1)} MB  ${readHeader(path.join(dir, x.name)).header.created}`);
  }
}

async function verifyCommand() {
  const file = await resolveBackupFile(positional[1]);
  const code = await stream(process.execPath, [path.join(APP, 'scripts', 'db', 'offsite.mjs'), 'verify', file]);
  process.exitCode = code;
}

// ─── restore / move ─────────────────────────────────────────────────────────

/** A new, empty database on the owner's server (or the named empty one). */
async function prepareTarget(url, env, into, local) {
  if (into) {
    const target = withDatabase(url, into);
    const state = await withClient(target, env, databaseState);
    if (state.kind !== 'empty') fail(`Database ${into} is not empty (${state.tables} tables). psctl only fills a new or empty database.`, 2);
    return target;
  }
  const name = `${databaseOf(url).replace(/_restore_\d{8}_\d{6}$/, '')}_restore_${stamp()}`.slice(0, 63);
  const owner = decodeURIComponent(new URL(url).username);
  if (local) {
    run('runuser', ['-u', 'postgres', '--', 'createdb', '--port', new URL(url).port || '5432', '--owner', owner, name]);
  } else {
    await withClient(url, env, async (client) => {
      const { rows } = await client.query(`select format('CREATE DATABASE %I', $1::text) as sql`, [name]);
      await client.query(rows[0].sql).catch((error) => {
        fail(`Could not create database ${name} (${error.message}). Create an empty database owned by ${owner} on that server and run again with --into <name>.`, 2);
      });
    });
  }
  console.log(`Created the new database ${name}.`);
  return withDatabase(url, name);
}

/** Migrations as far as the dump's, the dump itself, then this version's newer migrations. */
async function fillDatabase(target, env, dump, inBackup) {
  const { listMigrations, migrate } = await import('../db/migrator.mjs');
  const { restoreList } = await import('../db/backup-core.mjs');
  const all = listMigrations();
  const plan = restorePlan(
    all.map((m) => m.name),
    inBackup
  );
  if (!plan.ok) fail(plan.reason, 2);
  const replay = new Set(plan.replay);
  await withClient(target, env, (client) => migrate(adapter(client), { migrations: all.filter((m) => replay.has(m.name)) }));
  say(`Restoring the data (${(fs.statSync(dump).size / 1048576).toFixed(1)} MB dump)`);
  const pgRestore = pgTool('pg_restore');
  const listFile = `${dump}.list`;
  fs.writeFileSync(listFile, restoreList(run(pgRestore, ['--list', dump]).stdout));
  const code = await stream(
    pgRestore,
    [...pgArgs(target), '--clean', '--if-exists', '--single-transaction', '--exit-on-error', '--no-owner', '--use-list', listFile, dump],
    { env: { ...env, ...pgTlsEnv(target) }, stdin: 'ignore' }
  );
  fs.rmSync(listFile, { force: true });
  if (code !== 0) fail('pg_restore failed (above). The new database is left as it is for a look; the app was not touched.');
  return withClient(target, env, async (client) => {
    const applied = await migrate(adapter(client), { log: (l) => console.log(l) });
    return { applied, state: await databaseState(client) };
  });
}

/** New passwords for the app's login roles on another PostgreSQL server; their URLs. */
async function newAppLogins(target, env) {
  const { newLogin } = await import('../db/provision.mjs');
  return withClient(target, env, async (client) => ({
    DATABASE_URL: await newLogin(client, target, 'etna_app'),
    AUTH_DATABASE_URL: await newLogin(client, target, 'etna_auth'),
    WORKER_DATABASE_URL: await newLogin(client, target, 'etna_worker'),
  }));
}

/**
 * Points the app at `target` (stopped while switching). Returns an undo
 * function; it is called by itself when the app does not answer afterwards.
 */
async function switchApp({ target, urls, fromBackup, files }) {
  const tag = stamp();
  const envBefore = fs.readFileSync(PATHS.envFile, 'utf8');
  const ctlBefore = fs.readFileSync(PATHS.ctlFile, 'utf8');
  fs.writeFileSync(`${PATHS.envFile}.before-${tag}`, envBefore, { mode: 0o600 });
  fs.writeFileSync(`${PATHS.ctlFile}.before-${tag}`, ctlBefore, { mode: 0o600 });
  const settings = readEnvFile(PATHS.envFile);
  const moved = [];

  say('Stopping the app');
  run('systemctl', ['stop', ...SERVICES.map((s) => `${s}.service`)]);
  const undo = async () => {
    warn('Going back: the previous settings, files and database.');
    run('systemctl', ['stop', ...SERVICES.map((s) => `${s}.service`)], { allowFail: true });
    for (const { from, to } of moved.reverse()) {
      fs.rmSync(from, { recursive: true, force: true });
      if (to) fs.renameSync(to, from);
    }
    fs.writeFileSync(PATHS.envFile, envBefore);
    fs.writeFileSync(PATHS.ctlFile, ctlBefore);
    return restartAndCheck();
  };
  try {
    if (files) {
      const keep = path.join(PATHS.dataRoot, `before-restore-${tag}`);
      fs.mkdirSync(keep, { mode: 0o750 });
      run('chown', ['etna:etna', keep]);
      for (const { from: restored, to: live } of files) {
        const aside = fs.existsSync(live) ? path.join(keep, path.basename(live)) : null;
        if (aside) fs.renameSync(live, aside);
        moved.push({ from: live, to: aside });
        if (fs.existsSync(restored)) {
          fs.renameSync(restored, live);
          run('chown', ['-R', 'etna:etna', live]);
        } else fs.mkdirSync(live, { recursive: true });
      }
    }
    setAppEnv(retargetSettings(settings, { database: databaseOf(target), urls, fromBackup }));
    setCtl({ MIGRATION_DATABASE_URL: withoutPassword(target) });
  } catch (error) {
    await undo();
    throw error;
  }
  say('Starting the app on the new database');
  if (await restartAndCheck()) return { ok: true, tag };
  const back = await undo();
  fail(`The app did not answer on the new database: journalctl -u etna -n 80. ${back ? 'It runs again as before.' : 'It does not answer as before either: psctl doctor.'}`);
}

async function restoreCommand() {
  const file = await resolveBackupFile(positional[1]);
  const into = option('--into');
  const { url, env, settings: control } = ownerEnv();
  const { readBundle } = await offsite();
  const passphrase = await readPassphrase('Backup passphrase: ');

  const work = path.join(PATHS.dataRoot, `.restore-${stamp()}`);
  fs.mkdirSync(work, { mode: 0o700 });
  // readBundle makes this folder itself (it refuses one that exists).
  const unpacked = path.join(work, 'bundle');
  try {
    say(`Opening ${path.basename(file)}`);
    let manifest;
    try {
      manifest = await readBundle(file, passphrase, { into: unpacked });
    } catch (error) {
      fail(`Not restored: ${explainBundleError(error)}`);
    }
    const files = manifest.entries.filter((e) => e.name.startsWith('files/')).length;
    const fromBackup = fs.existsSync(path.join(unpacked, 'settings', 'etna.env')) ? readEnvFile(path.join(unpacked, 'settings', 'etna.env')) : null;
    console.log(`Made ${manifest.createdAt} on ${manifest.host ?? '?'} by ETNA ${manifest.appVersion ?? '?'}: ${manifest.migrations?.length ?? '?'} migrations, ${files} document file(s), settings ${fromBackup ? 'included' : 'NOT included'}.`);
    if (!fromBackup) warn('Without the settings, the two-factor key stays this server\'s: users of the backup must enrol their authenticator again.');

    const target = await prepareTarget(url, env, into, control.ETNA_LOCAL_POSTGRES === '1');
    const { applied, state } = await fillDatabase(target, env, path.join(unpacked, 'database.dump'), manifest.migrations);
    console.log(`Database ${databaseOf(target)}: ${state.migrations} migrations${applied.length ? ` (${applied.length} newer applied)` : ''}, ${state.users ?? '?'} user(s), ${state.tables} tables.`);

    const live = readEnvFile(PATHS.envFile);
    const documents = live.ETNA_DOCUMENTS_DIR || path.join(PATHS.dataRoot, 'documents');
    const question = [
      '',
      `Switch the app to ${databaseOf(target)} and the backup's documents now?`,
      `  - the app stops for a moment;`,
      `  - the current database ${databaseOf(url)} is kept as it is;`,
      `  - the current documents move to ${PATHS.dataRoot}/before-restore-<time>/;`,
      fromBackup ? '  - the keys and settings of the backup replace this server\'s (connections stay);' : '  - this server\'s keys and settings stay;',
      '  - if the app does not answer afterwards, all of it goes back by itself.',
    ].join('\n');
    if (!(await confirm(question, 'switch'))) {
      console.log(`Not switched. The restored database ${databaseOf(target)} stays for a look; the app still uses ${databaseOf(url)}.`);
      return;
    }
    const urls = sameServer(target, live.DATABASE_URL || url) ? null : await newAppLogins(target, env);
    const { tag } = await switchApp({
      target,
      urls,
      fromBackup,
      files: [
        { from: path.join(unpacked, 'files', 'documents'), to: documents },
        { from: path.join(unpacked, 'files', 'companies'), to: path.join(PATHS.dataRoot, 'companies') },
      ],
    });
    say(`Restored. The app runs on ${databaseOf(target)}.`);
    console.log(`Kept, until you remove them yourself:`);
    console.log(`  - the previous database ${databaseOf(url)} (psctl databases)`);
    console.log(`  - the previous documents in ${PATHS.dataRoot}/before-restore-${tag}/`);
    console.log(`  - the previous settings in ${PATHS.envFile}.before-${tag}`);
  } finally {
    // The unpacked dump and settings hold everything: never left behind.
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function dbMoveCommand() {
  const to = positional[2];
  if (!to) fail('Usage: psctl db move postgres://etna_owner@<database server>:5432/etna?sslmode=verify-full [--yes]', 2);
  const problem = tlsProblem(to);
  if (problem) fail(problem, 2);
  const { url, env } = ownerEnv();
  if (sameServer(to, url) && databaseOf(to) === databaseOf(url)) fail('That is the database the app uses now.', 2);

  // The new server's owner password: typed (or on stdin), kept in the owner's password file.
  const password = decodeURIComponent(new URL(to).password) || process.env.PGPASSWORD || (await readPassphrase(`Password of ${decodeURIComponent(new URL(to).username)} on ${new URL(to).host}: `));
  const target = withoutPassword(to);
  const pgpass = upsertPgpassLine(fs.existsSync(PATHS.ownerPgpass) ? fs.readFileSync(PATHS.ownerPgpass, 'utf8') : '', pgpassLine(target, password));
  const pgpassBefore = fs.existsSync(PATHS.ownerPgpass) ? fs.readFileSync(PATHS.ownerPgpass, 'utf8') : '';
  writeRootFile(PATHS.ownerPgpass, pgpass);

  try {
    const state = await withClient(target, env, databaseState);
    if (state.kind !== 'empty') fail(`${databaseOf(target)} on ${new URL(target).host} is not empty (${state.tables} tables). psctl only fills an empty database.`, 2);
    const question = [
      '',
      `Copy the database ${databaseOf(url)} to ${new URL(target).host}/${databaseOf(target)} and switch the app to it?`,
      '  - the app is stopped while copying (so nothing written is lost);',
      `  - the current database stays as it is on ${new URL(url).host};`,
      '  - if the app does not answer afterwards, it goes back by itself.',
    ].join('\n');
    if (!(await confirm(question, 'move'))) return console.log('Nothing was changed.');

    say('Stopping the app');
    run('systemctl', ['stop', ...SERVICES.map((s) => `${s}.service`)]);
    const work = fs.mkdtempSync(path.join(PATHS.dataRoot, '.move-'));
    try {
      const dump = path.join(work, 'database.dump');
      say('Copying the database');
      const code = await stream(pgTool('pg_dump'), [...pgArgs(url), '--format', 'custom', '--file', dump], { env: { ...env, ...pgTlsEnv(url) }, stdin: 'ignore' });
      if (code !== 0) fail('pg_dump failed (above).');
      const migrations = await withClient(url, env, async (c) => (await c.query('select name from etna_meta.schema_migrations order by name')).rows.map((r) => r.name));
      await fillDatabase(target, env, dump, migrations);
    } catch (error) {
      run('systemctl', ['start', ...SERVICES.map((s) => `${s}.service`)], { allowFail: true });
      throw error;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    const urls = await newAppLogins(target, env);
    await switchApp({ target, urls, fromBackup: null, files: null });
    setCtl({ ETNA_LOCAL_POSTGRES: null });
    say(`The app now uses ${new URL(target).host}/${databaseOf(target)}.`);
    console.log(`The old database ${databaseOf(url)} on ${new URL(url).host} is kept: remove it yourself once you are sure.`);
    console.log('Other app servers of this ETNA need the new connection too: copy /etc/etna/etna.env to them and restart them.');
  } catch (error) {
    // The new server's password is kept only when the app moved there.
    if (ctl().MIGRATION_DATABASE_URL !== target) writeRootFile(PATHS.ownerPgpass, pgpassBefore);
    throw error;
  }
}

async function databasesCommand() {
  const { url, env } = ownerEnv();
  const rows = await withClient(url, env, async (client) => {
    const owner = decodeURIComponent(new URL(url).username);
    return (
      await client.query(
        `select datname, pg_database_size(datname)::bigint as bytes from pg_database d
          where pg_get_userbyid(datdba) = $1 and not datistemplate order by datname`,
        [owner]
      )
    ).rows;
  });
  for (const r of rows) console.log(`${r.datname === databaseOf(url) ? '*' : ' '} ${r.datname.padEnd(40)} ${(Number(r.bytes) / 1048576).toFixed(0)} MB`);
  console.log('\n* the one the app uses. psctl never drops a database; to remove an old one yourself:');
  console.log(`  sudo -u postgres dropdb <name>     (on the database server, after a backup)`);
}

// ─── upgrade / rollback ─────────────────────────────────────────────────────

async function upgradeCommand() {
  const from = positional[1];
  if (!from || !fs.existsSync(from)) fail('Usage: psctl upgrade <ETNA folder | etna-*.tar.gz> [--yes]', 2);
  let source = path.resolve(from);
  let unpacked = null;
  if (fs.statSync(source).isFile()) {
    if (!/\.(tar\.gz|tgz)$/.test(source)) fail('A release file must be a .tar.gz.', 2);
    unpacked = fs.mkdtempSync(path.join('/var/tmp', 'etna-upgrade-'));
    run('tar', ['-xzf', source, '-C', unpacked, '--no-same-owner']);
    const entries = run('find', [unpacked, '-maxdepth', '4', '-path', '*/deploy/linux/install.sh']).stdout.trim().split('\n').filter(Boolean);
    source = releaseRoot(unpacked, entries);
    if (!source) {
      fs.rmSync(unpacked, { recursive: true, force: true });
      fail('That file does not hold an ETNA release (deploy/linux/install.sh).', 2);
    }
  }
  try {
    if (!fs.existsSync(path.join(source, 'deploy', 'linux', 'install.sh'))) fail(`${source} is not an ETNA folder.`, 2);
    const next = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
    let now = '?';
    try {
      now = JSON.parse(fs.readFileSync(path.join(PATHS.current, 'package.json'), 'utf8')).version;
    } catch {
      // first install through psctl
    }
    if (!(await confirm(`Install ETNA ${next} over ${now}? A backup is made first (when set up); a failed start goes back to ${now}.`, 'upgrade')))
      return console.log('Nothing was changed.');
    const code = await stream('bash', [path.join(source, 'deploy', 'linux', 'install.sh'), '--yes']);
    process.exitCode = code;
  } finally {
    if (unpacked) fs.rmSync(unpacked, { recursive: true, force: true });
  }
}

async function rollbackCommand() {
  const current = currentRelease();
  const previous = previousRelease(releases(), current);
  if (!previous) fail('There is no previous release to go back to.', 2);
  const question = `Go back from ${path.basename(current ?? '?')} to ${path.basename(previous)}?\nThe database keeps the newer migrations (they only add); if the old version does not run with them, restore the backup made before the upgrade.`;
  if (!(await confirm(question, 'rollback'))) return console.log('Nothing was changed.');
  fs.rmSync(`${PATHS.current}.new`, { force: true });
  fs.symlinkSync(previous, `${PATHS.current}.new`);
  fs.renameSync(`${PATHS.current}.new`, PATHS.current);
  if (await restartAndCheck()) say(`Now running ${path.basename(previous)}.`);
  else fail(`${path.basename(previous)} does not answer: journalctl -u etna -n 80`);
}

// ─── main ───────────────────────────────────────────────────────────────────

const commands = {
  status: statusCommand,
  doctor: doctorCommand,
  start: () => servicesCommand('start'),
  stop: () => servicesCommand('stop'),
  restart: () => servicesCommand('restart'),
  logs: logsCommand,
  migrate: migrateCommand,
  'backup-setup': backupSetupCommand,
  backup: backupCommand,
  backups: backupsCommand,
  verify: verifyCommand,
  restore: restoreCommand,
  upgrade: upgradeCommand,
  rollback: rollbackCommand,
  databases: databasesCommand,
  db: () => (positional[1] === 'move' ? dbMoveCommand() : fail('Usage: psctl db move <owner url>', 2)),
  users: () => {
    const { url } = ownerEnv();
    const r = spawnSync(process.execPath, [path.join(APP, 'scripts', 'admin', 'users.mjs'), ...argv.slice(argv.indexOf('users') + 1)], {
      stdio: 'inherit',
      env: { ...process.env, ADMIN_DATABASE_URL: url },
    });
    process.exitCode = r.status ?? 1;
  },
  version: () => console.log(JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version),
};

const command = positional[0];
process.env.PGPASSFILE ||= PATHS.ownerPgpass;
try {
  if (!commands[command]) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 27).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exitCode = command ? 2 : 0;
  } else {
    if (command !== 'version') requireRoot();
    await commands[command]();
  }
} catch (error) {
  if (error instanceof Stop) {
    console.error(`\x1b[31m${error.message}\x1b[0m`);
    process.exitCode = error.code;
  } else {
    console.error(`\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
    process.exitCode = 1;
  }
}
