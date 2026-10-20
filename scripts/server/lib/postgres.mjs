// ETNA's own PostgreSQL cluster: created with the binaries of an installed
// PostgreSQL (EDB installer), data in <root>\postgres\data, run by the Windows
// service etna-postgres as NetworkService, listening on localhost only. Other
// PostgreSQL services and databases on the machine are never touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { restoreList } from '../../db/backup-core.mjs';
import { mustRun, run } from './sys.mjs';

export const MIN_MAJOR = 17;
export const RECOMMENDED_MAJOR = 18;
const SERVICE_ACCOUNT = 'NT AUTHORITY\\NetworkService';

/** The newest installed PostgreSQL with server binaries: { bin, major, version } or null. */
export async function findPostgres(env = process.env) {
  const bases = [path.join(env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL')];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    const versions = fs.readdirSync(base).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a));
    for (const v of versions) {
      const bin = path.join(base, v, 'bin');
      if (!['initdb.exe', 'pg_ctl.exe', 'pg_dump.exe', 'pg_restore.exe'].every((f) => fs.existsSync(path.join(bin, f)))) continue;
      const r = await run(path.join(bin, 'postgres.exe'), ['-V']);
      const m = r.stdout.match(/(\d+)(?:\.(\d+))?/);
      if (m) return { bin, major: Number(m[1]), version: m[0] };
    }
  }
  return null;
}

export const tool = (bin, name) => path.join(bin, `${name}.exe`);

/** A new cluster. Tries an ICU collation first (natural sort order), then plain C.UTF-8. */
export async function initCluster({ bin, dataDir, superPassword }) {
  fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length > 0) {
    throw new Error(`${dataDir} is not empty`);
  }
  const pwfile = path.join(os.tmpdir(), `etna-pw-${process.pid}-${Date.now()}`);
  fs.writeFileSync(pwfile, `${superPassword}\n`, { mode: 0o600 });
  try {
    const common = ['-D', dataDir, '-U', 'postgres', `--pwfile=${pwfile}`, '-E', 'UTF8', '-A', 'scram-sha-256'];
    let r = await run(tool(bin, 'initdb'), [...common, '--locale-provider=icu', '--icu-locale=und', '--locale=C']);
    if (r.code !== 0) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      r = await run(tool(bin, 'initdb'), [...common, '--locale-provider=builtin', '--builtin-locale=C.UTF-8', '--locale=C']);
    }
    if (r.code !== 0) throw new Error(`initdb failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' ')}`);
  } finally {
    fs.rmSync(pwfile, { force: true });
  }
}

/** Localhost only, on our port. Later settings in postgresql.conf win, so they are appended. */
export function configureCluster(dataDir, port) {
  const conf = path.join(dataDir, 'postgresql.conf');
  // Kept as first written (2026-10): existing clusters are found by it.
  const marker = '# ─── ETNA (ETNA-SETUP.bat) ───';
  let text = fs.readFileSync(conf, 'utf8');
  const at = text.indexOf(marker);
  if (at >= 0) text = text.slice(0, at).trimEnd() + '\n';
  text += `\n${marker}\nlisten_addresses = 'localhost'\nport = ${Number(port)}\npassword_encryption = 'scram-sha-256'\n`;
  fs.writeFileSync(conf, text);
}

/** The port in a cluster's postgresql.conf (the last setting wins), or null. */
export function clusterPort(dataDir) {
  try {
    const lines = fs.readFileSync(path.join(dataDir, 'postgresql.conf'), 'utf8').split(/\r?\n/);
    let port = null;
    for (const line of lines) {
      const m = line.match(/^\s*port\s*=\s*(\d+)/);
      if (m) port = Number(m[1]);
    }
    return port;
  } catch {
    return null;
  }
}

/** listen_addresses from postgresql.conf ('localhost' when only the default comment is there). */
export function listenAddresses(dataDir) {
  try {
    let value = 'localhost';
    for (const line of fs.readFileSync(path.join(dataDir, 'postgresql.conf'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*listen_addresses\s*=\s*'([^']*)'/);
      if (m) value = m[1];
    }
    return value;
  } catch {
    return null;
  }
}

export async function registerService({ bin, dataDir, name }) {
  await mustRun(tool(bin, 'pg_ctl'), ['register', '-N', name, '-U', SERVICE_ACCOUNT, '-D', dataDir, '-S', 'auto', '-w']);
  await run('sc.exe', ['description', name, 'PostgreSQL for ETNA (managed by the ETNA server manager)']);
}

export async function unregisterService({ bin, name }) {
  await mustRun(tool(bin, 'pg_ctl'), ['unregister', '-N', name]);
}

/** The schema owner and the empty ETNA database, as the cluster's superuser. */
export async function createOwnerAndDatabase({ port, superPassword, owner, ownerPassword, database }) {
  const client = new pg.Client({ host: 'localhost', port, user: 'postgres', password: superPassword, database: 'postgres' });
  await client.connect();
  try {
    const exists = await client.query('select 1 from pg_roles where rolname = $1', [owner]);
    if (exists.rowCount === 0) {
      const { rows } = await client.query(`select format('CREATE ROLE %I LOGIN CREATEROLE PASSWORD %L', $1::text, $2::text) as sql`, [owner, ownerPassword]);
      await client.query(rows[0].sql);
    }
    const db = await client.query('select 1 from pg_database where datname = $1', [database]);
    if (db.rowCount > 0) throw new Error(`The database ${database} already exists in this cluster`);
    const { rows } = await client.query(`select format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', $1::text, $2::text) as sql`, [database, owner]);
    await client.query(rows[0].sql);
  } finally {
    await client.end().catch(() => {});
  }
}

export function ownerUrl({ port, owner, database }) {
  return `postgres://${owner}@localhost:${port}/${database}`;
}

/** A client as the schema owner; the password comes from PGPASSFILE. */
export async function ownerClient(cfg) {
  const client = new pg.Client({ connectionString: ownerUrl(cfg), application_name: 'etna-setup' });
  await client.connect();
  return client;
}

export async function appliedMigrations(client) {
  const { rows } = await client.query(
    `select name from etna_meta.schema_migrations order by name`
  );
  return rows.map((r) => r.name);
}

const connArgs = ({ port, owner, database }) => ['--host', 'localhost', '--port', String(port), '--username', owner, '--no-password', '--dbname', database];

export async function dumpDatabase({ bin, cfg, file, env }) {
  const partial = `${file}.partial`;
  const r = await run(tool(bin, 'pg_dump'), [...connArgs(cfg), '--format', 'custom', '--file', partial], { env });
  if (r.code !== 0) {
    fs.rmSync(partial, { force: true });
    throw new Error(`pg_dump failed: ${r.stderr.trim().split(/\r?\n/).slice(-2).join(' ')}`);
  }
  fs.renameSync(partial, file);
}

/** Replaces the database contents with a dump, in one transaction. */
export async function restoreDatabase({ bin, cfg, file, env }) {
  const list = path.join(os.tmpdir(), `etna-restore-${process.pid}-${Date.now()}.list`);
  try {
    const toc = await mustRun(tool(bin, 'pg_restore'), ['--list', file], { env });
    fs.writeFileSync(list, restoreList(toc));
    await mustRun(tool(bin, 'pg_restore'), [
      ...connArgs(cfg), '--clean', '--if-exists', '--single-transaction', '--exit-on-error', '--no-owner', '--use-list', list, file,
    ], { env });
  } finally {
    fs.rmSync(list, { force: true });
  }
}

export function copyPgConf(dataDir, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['postgresql.conf', 'pg_hba.conf']) {
    const src = path.join(dataDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
  }
}
