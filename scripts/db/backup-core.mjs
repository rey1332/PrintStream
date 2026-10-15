import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const KEEP = 7;
export const MAX_AGE_HOURS = 24;
const NAME = /^etna-(\d{8})-(\d{6})(?:-([a-z-]+))?\.dump$/;

export function loadEnvFile(file = path.join(ROOT, '.env.local')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ETNA_BACKUP_DIR, else <ETNA_DATA_ROOT>\backups (set by etna.bat), else
// storage/backups in the app folder.
export function backupDir(env = process.env) {
  if (env.ETNA_BACKUP_DIR) return path.resolve(env.ETNA_BACKUP_DIR);
  if (env.ETNA_DATA_ROOT) return path.join(path.resolve(env.ETNA_DATA_ROOT), 'backups');
  return path.join(ROOT, 'storage', 'backups');
}

export function config(env = process.env) {
  const url = env.ETNA_BACKUP_DATABASE_URL || '';
  return { url, dir: backupDir(env), configured: !!url };
}

export function pgpassPath(env = process.env) {
  if (env.PGPASSFILE) return env.PGPASSFILE;
  return process.platform === 'win32'
    ? path.join(
        env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'postgresql',
        'pgpass.conf'
      )
    : path.join(os.homedir(), '.pgpass');
}

const escapePgpass = (value) => String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:');

export function upsertPgpass(content, { host, port, database, user, password }) {
  const key = [host, port, database, user].map(escapePgpass).join(':') + ':';
  const kept = (content || '').split(/\r?\n/).filter((line) => line && !line.startsWith(key));
  return [...kept, key + escapePgpass(password)].join(os.EOL) + os.EOL;
}

export function parseUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname || 'localhost',
    port: u.port || '5432',
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: decodeURIComponent(u.username),
  };
}

// The newest PostgreSQL tools win: a newer pg_restore reads older dumps, an
// older one refuses newer ones. On Debian / Ubuntu /usr/bin/pg_restore is a
// wrapper that picks a local cluster's version (often an older one), so the
// versioned directories are tried first.
export function findTool(name, { debianRoot = '/usr/lib/postgresql' } = {}) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  if (process.platform !== 'win32' && fs.existsSync(debianRoot)) {
    const versions = fs
      .readdirSync(debianRoot)
      .filter((v) => /^\d+$/.test(v))
      .sort((a, b) => Number(b) - Number(a));
    for (const v of versions) {
      const candidate = path.join(debianRoot, v, 'bin', exe);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  if (process.platform === 'win32') {
    const base = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL');
    if (fs.existsSync(base)) {
      const versions = fs
        .readdirSync(base)
        .filter((v) => /^\d+$/.test(v))
        .sort((a, b) => Number(b) - Number(a));
      for (const v of versions) {
        const candidate = path.join(base, v, 'bin', exe);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
export function backupName(date = new Date(), label = '') {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `etna-${stamp}${label ? `-${label}` : ''}.dump`;
}

export function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => NAME.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      const [, d, t, label] = name.match(NAME);
      const createdAt = new Date(
        Number(d.slice(0, 4)),
        Number(d.slice(4, 6)) - 1,
        Number(d.slice(6, 8)),
        Number(t.slice(0, 2)),
        Number(t.slice(2, 4)),
        Number(t.slice(4, 6))
      );
      return {
        name,
        size: stat.size,
        createdAt: createdAt.toISOString(),
        label: label || 'manual',
      };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

export function toPrune(backups, keep = KEEP) {
  return backups.slice(keep).map((b) => b.name);
}

export function resolveBackup(dir, name) {
  if (typeof name !== 'string' || !NAME.test(name)) return null;
  const full = path.join(dir, name);
  return fs.existsSync(full) ? full : null;
}

function run(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(
              stderr.trim().split(/\r?\n/).slice(-3).join(' ') ||
                `${path.basename(command)} exited with ${code}`
            )
          )
    );
  });
}

function connectionArgs(url) {
  const c = parseUrl(url);
  return [
    '--host',
    c.host,
    '--port',
    c.port,
    '--username',
    c.user,
    '--no-password',
    '--dbname',
    c.database,
  ];
}

export async function backup({ url, dir }, label = '', { prune = true } = {}) {
  const pgDump = findTool('pg_dump');
  if (!pgDump) throw new Error('pg_dump was not found. Install the PostgreSQL command-line tools.');
  fs.mkdirSync(dir, { recursive: true });
  const name = backupName(new Date(), label);
  const file = path.join(dir, name);
  const partial = `${file}.partial`;
  try {
    await run(pgDump, [...connectionArgs(url), '--format', 'custom', '--file', partial]);
    fs.renameSync(partial, file);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  if (prune)
    for (const old of toPrune(listBackups(dir))) fs.rmSync(path.join(dir, old), { force: true });
  return listBackups(dir).find((b) => b.name === name);
}

export async function backupIfDue(cfg, now = Date.now()) {
  const newest = listBackups(cfg.dir)[0];
  if (newest && now - new Date(newest.createdAt).getTime() < MAX_AGE_HOURS * 3600_000) return null;
  return backup(cfg, 'auto');
}

// The server's extensions and the schemas stay as they are: the restore
// target is always a migrated ETNA database that has all of them, dropping
// the schema that holds pgcrypto fails while the extension is in it, and
// some schemas belong to another role (ps_data to etna_ddl), which the
// schema owner may not drop. What is inside the schemas is restored.
export function restoreList(toc) {
  return toc
    .split(/\r?\n/)
    .filter(
      (line) =>
        line &&
        !/^\d+;\s*\d+\s+\d+\s+(EXTENSION|COMMENT - EXTENSION)\s/.test(line) &&
        !/^\d+;\s*\d+\s+\d+\s+(SCHEMA - |COMMENT - SCHEMA )\S+\s/.test(line)
    )
    .join('\n');
}

export async function restore(cfg, name) {
  const pgRestore = findTool('pg_restore');
  if (!pgRestore)
    throw new Error('pg_restore was not found. Install the PostgreSQL command-line tools.');
  const file = resolveBackup(cfg.dir, name);
  if (!file) throw new Error('Backup not found.');
  // Not pruned now: the backup being restored may be the oldest one.
  const before = await backup(cfg, 'before-restore', { prune: false });
  const listFile = path.join(os.tmpdir(), `etna-restore-${process.pid}-${Date.now()}.list`);
  try {
    fs.writeFileSync(listFile, restoreList(await run(pgRestore, ['--list', file])));
    await run(pgRestore, [
      ...connectionArgs(cfg.url),
      '--clean',
      '--if-exists',
      '--single-transaction',
      '--exit-on-error',
      '--no-owner',
      '--use-list',
      listFile,
      file,
    ]);
  } finally {
    fs.rmSync(listFile, { force: true });
  }
  return { restored: name, safetyBackup: before?.name ?? null };
}
