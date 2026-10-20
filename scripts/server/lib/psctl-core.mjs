// The decisions behind psctl (scripts/server/psctl.mjs), kept free of side
// effects so they can be tested: where things live, how connection strings
// are retargeted, which migrations a restore replays, what `doctor` flags.

import path from 'node:path';

export const PATHS = Object.freeze({
  prefix: '/opt/etna',
  current: '/opt/etna/current',
  releases: '/opt/etna/releases',
  config: '/etc/etna',
  // The app's settings and keys (root:etna 0640): read by the services.
  envFile: '/etc/etna/etna.env',
  // psctl's own settings and the schema owner's password (root 0600): never
  // readable by the services, since the owner is not bound by row security.
  ctlFile: '/etc/etna/psctl.env',
  ownerPgpass: '/etc/etna/owner.pgpass',
  backupKeys: '/etc/etna/backup',
  dataRoot: '/var/lib/etna',
  backupDir: '/var/backups/etna',
});

// The connection settings a restored etna.env keeps from this server: the
// rest (keys, public URL, mail…) comes from the backup.
export const LOCAL_SETTINGS = Object.freeze([
  'DATABASE_URL',
  'AUTH_DATABASE_URL',
  'WORKER_DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'ETNA_DATA_ROOT',
  'ETNA_DOCUMENTS_DIR',
  'ETNA_HOST',
  'ETNA_PORT',
]);
export const APP_URLS = Object.freeze(['DATABASE_URL', 'AUTH_DATABASE_URL', 'WORKER_DATABASE_URL']);

/** A PostgreSQL identifier psctl creates or accepts: no quoting needed anywhere. */
export const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function databaseOf(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

export function withDatabase(url, database) {
  if (!DATABASE_NAME.test(database)) throw new Error(`Not a database name psctl uses: ${database}`);
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** The URL without its password, for messages and for psctl.env. */
export function withoutPassword(url) {
  const u = new URL(url);
  u.password = '';
  return u.toString();
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);
export const isLoopback = (host) => LOOPBACK.has(String(host).toLowerCase()) || String(host).startsWith('/');

function endpoint(url) {
  const u = new URL(url);
  const host = u.searchParams.get('host') || u.hostname;
  return { host: isLoopback(host) ? 'loopback' : host.toLowerCase(), port: u.port || '5432' };
}

/** Same PostgreSQL server (cluster): login roles and their passwords are shared. */
export function sameServer(a, b) {
  const x = endpoint(a);
  const y = endpoint(b);
  return x.host === y.host && x.port === y.port;
}

/** A database on another machine must be reached with a checked TLS certificate. */
export function tlsProblem(url) {
  const { host } = endpoint(url);
  if (host === 'loopback') return null;
  const mode = new URL(url).searchParams.get('sslmode');
  return mode === 'verify-full' || mode === 'verify-ca'
    ? null
    : `${host} is another machine: add ?sslmode=verify-full to the URL (docs/teknis/CONFIGURATION.md, "Database connections across the network").`;
}

/** One ~/.pgpass line; ':' and '\' are escaped. Any database of that server and role. */
export function pgpassLine(url, password) {
  const u = new URL(url);
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  const host = u.searchParams.get('host') || u.hostname || 'localhost';
  return `${esc(host.replace(/^\[|\]$/g, ''))}:${u.port || '5432'}:*:${esc(decodeURIComponent(u.username))}:${esc(password)}`;
}

/** Replaces the line for the same host, port and role, keeps the others. */
export function upsertPgpassLine(text, line) {
  // host:port:database:user — fields split on ':' that is not escaped.
  const key = (l) => {
    const f = [''];
    for (let i = 0; i < l.length; i += 1) {
      if (l[i] === '\\') f[f.length - 1] += l[i] + (l[++i] ?? '');
      else if (l[i] === ':') f.push('');
      else f[f.length - 1] += l[i];
    }
    return `${f[0]}:${f[1]}:${f[3]}`;
  };
  const kept = String(text || '')
    .split(/\r?\n/)
    .filter((l) => l && key(l) !== key(line));
  return `${[...kept, line].join('\n')}\n`;
}

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/**
 * A backup is replayed onto a database migrated exactly as far as the
 * backup's own (pg_restore then fills the same tables); the newer migrations
 * of this version run after it. A backup from a newer version cannot be
 * restored by this one.
 */
export function restorePlan(available, inBackup) {
  if (!Array.isArray(inBackup) || inBackup.length === 0)
    return { ok: false, reason: 'The backup does not say which migrations its database had (it was made by an older ETNA or without access to the database).' };
  const have = new Set(available);
  const unknown = inBackup.filter((name) => !have.has(name));
  if (unknown.length)
    return { ok: false, reason: `The backup was made by a newer ETNA (unknown migrations: ${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? '…' : ''}). Upgrade this server first.` };
  const wanted = new Set(inBackup);
  return { ok: true, replay: available.filter((name) => wanted.has(name)), after: available.filter((name) => !wanted.has(name)) };
}

/**
 * The etna.env changes that point the app at another database. With
 * `fromBackup` (the etna.env inside a backup), its keys and settings come
 * along, except what belongs to this machine.
 */
export function retargetSettings(current, { database, urls = null, fromBackup = null }) {
  const changes = {};
  if (fromBackup) {
    for (const [key, value] of Object.entries(fromBackup)) if (!LOCAL_SETTINGS.includes(key) && current[key] !== value) changes[key] = value;
  }
  for (const key of APP_URLS) {
    const next = urls?.[key] ?? (current[key] ? withDatabase(current[key], database) : null);
    if (next && next !== current[key]) changes[key] = next;
  }
  return changes;
}

/** What is in a database, from the owner's view: decides what an install may do with it. */
export function classifyDatabase({ etna, tables }) {
  if (etna) return 'etna';
  return tables > 0 ? 'foreign' : 'empty';
}

/** The release to go back to: the newest (releases oldest first) that is not running. */
export function previousRelease(releases, current) {
  return releases.filter((r) => r !== current).at(-1) ?? null;
}

/** The folder of an unpacked release: the folder itself or its only subfolder. */
export function releaseRoot(dir, entries) {
  const marker = (d) => entries.includes(path.join(d, 'deploy', 'linux', 'install.sh'));
  if (marker(dir)) return dir;
  const subdirs = [...new Set(entries.filter((e) => e.startsWith(dir + path.sep)).map((e) => e.slice(dir.length + 1).split(path.sep)[0]))];
  return subdirs.length === 1 && marker(path.join(dir, subdirs[0])) ? path.join(dir, subdirs[0]) : null;
}

/**
 * `psctl doctor`: findings from facts gathered on the server. Each is
 * { level: 'ok' | 'warn' | 'fail', text }.
 */
export function doctorFindings(f) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const mode = (m) => (m == null ? 'missing' : (m & 0o777).toString(8).padStart(3, '0'));

  if (f.envFile == null) add('fail', `${PATHS.envFile} does not exist: run deploy/linux/install.sh.`);
  else if (f.envFile.owner !== 'root:etna' || (f.envFile.mode & 0o777) !== 0o640)
    add('fail', `${PATHS.envFile} is ${f.envFile.owner} ${mode(f.envFile.mode)}: it should be root:etna 640 (it holds the two-factor key).`);
  else add('ok', `${PATHS.envFile} root:etna 640`);

  for (const [file, info] of [
    [PATHS.ctlFile, f.ctlFile],
    [PATHS.ownerPgpass, f.ownerPgpass],
  ]) {
    if (info == null) add('warn', `${file} does not exist: psctl cannot migrate, back up or restore (run deploy/linux/install.sh with the database owner).`);
    else if (info.owner !== 'root:root' || (info.mode & 0o077) !== 0) add('fail', `${file} is ${info.owner} ${mode(info.mode)}: it should be root:root 600.`);
    else add('ok', `${file} root only`);
  }

  for (const key of ['MFA_ENCRYPTION_KEY', 'SESSION_HINT_SECRET', ...APP_URLS])
    if (f.envFile && !f.settings?.[key]) add(key === 'WORKER_DATABASE_URL' ? 'warn' : 'fail', `${key} is not set in ${PATHS.envFile}.`);

  for (const key of APP_URLS) {
    const problem = f.settings?.[key] && tlsProblem(f.settings[key]);
    if (problem) add('fail', `${key}: ${problem}`);
  }
  if (f.ownerUrl && f.settings?.DATABASE_URL && databaseOf(f.ownerUrl) !== databaseOf(f.settings.DATABASE_URL))
    add('fail', `psctl.env points at database ${databaseOf(f.ownerUrl)} but the app at ${databaseOf(f.settings.DATABASE_URL)}.`);

  if (f.services) for (const [name, state] of Object.entries(f.services)) add(state === 'active' ? 'ok' : 'fail', `${name}: ${state}`);
  if (f.health != null) add(f.health ? 'ok' : 'fail', f.health ? 'the app answers /api/health' : 'the app does not answer /api/health');
  if (f.database) add(f.database.ok ? 'ok' : 'fail', f.database.text);
  if (f.pendingMigrations > 0) add('warn', `${f.pendingMigrations} migration(s) not applied yet (psctl migrate).`);

  if (!f.backup?.configured) add('warn', 'Encrypted backups are not set up: psctl backup-setup.');
  else if (f.backup.newestAgeHours == null) add('warn', 'No backup has been made yet: psctl backup.');
  else if (f.backup.newestAgeHours > 26) add('fail', `The newest backup is ${Math.round(f.backup.newestAgeHours)} hours old (journalctl -u etna-backup).`);
  else add('ok', `newest backup ${Math.round(f.backup.newestAgeHours)} hour(s) old`);
  if (f.backup?.configured && !f.backup.copyDir) add('warn', 'Backups stay on this machine only: set a second place with psctl backup-setup --copy-to <mounted folder>.');

  for (const d of f.disks ?? [])
    if (d.freeRatio < 0.1) add('fail', `${d.path}: only ${Math.round(d.freeRatio * 100)}% free.`);
    else if (d.freeRatio < 0.2) add('warn', `${d.path}: ${Math.round(d.freeRatio * 100)}% free.`);
  return out;
}
