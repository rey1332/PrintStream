// ETNA health check: four groups (machine & storage, PostgreSQL & database,
// app & tasks, configuration & exposure). Each check gives a status and, when
// something is wrong, a message key for the problem and one for the fix
// (texts in text.mjs, so the menu shows them in the chosen language).

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { listMigrations } from '../../db/migrator.mjs';
import { listFullBackups } from './archive.mjs';
import { readEnvFile } from './envfile.mjs';
import { APP_PORT, BACKUP_TASK, PG_SERVICE, SERVER_TASK, TASK_FOLDER, paths } from './layout.mjs';
import { listenAddresses } from './postgres.mjs';
import { freeSpace, httpStatus, isLink, portOpen, run, serviceState, taskInfo, windowsInfo } from './sys.mjs';

const GB = 1024 ** 3;

const ok = (group, key, vars = {}) => ({ group, key, status: 'ok', vars });
const warn = (group, key, vars = {}) => ({ group, key, status: 'warn', vars, problem: `${key}.problem`, fix: `${key}.fix` });
const fail = (group, key, vars = {}) => ({ group, key, status: 'fail', vars, problem: `${key}.problem`, fix: `${key}.fix` });

async function canConnect(connectionString) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Accounts other than admins, SYSTEM and the service account that can read a folder. */
async function looseReaders(folder) {
  const r = await run('icacls.exe', [folder]);
  if (r.code !== 0) return null;
  const open = /(Everyone|BUILTIN\\Users|Authenticated Users|NT AUTHORITY\\INTERACTIVE|\\Users:)/i;
  return r.stdout.split(/\r?\n/).filter((line) => open.test(line)).length;
}

export async function healthCheck(inst) {
  const results = [];
  const p = paths(inst.root, inst.backupDir);
  const env = readEnvFile(p.envFile);

  // ─── Machine & storage ────────────────────────────────────────────────────
  const G1 = 'machine';
  const info = await windowsInfo();
  results.push(info.build && info.build < 17763 ? warn(G1, 'h.windows', { windows: info.windows }) : ok(G1, 'h.windows', { windows: info.windows }));
  results.push(info.ramTotal < 7.5 * GB ? warn(G1, 'h.ram', { gb: Math.round(info.ramTotal / GB) }) : ok(G1, 'h.ram', { gb: Math.round(info.ramTotal / GB) }));
  const missing = ['config', 'documents', 'logs', 'postgres'].filter((f) => !fs.existsSync(path.join(inst.root, f)));
  if (!fs.existsSync(inst.root)) results.push(fail(G1, 'h.root', { root: inst.root }));
  else if (missing.length) results.push(fail(G1, 'h.folders', { folders: missing.join(', ') }));
  else results.push(ok(G1, 'h.folders', { root: inst.root }));
  const free = freeSpace(inst.root);
  const freeGb = free == null ? '?' : (free / GB).toFixed(1);
  results.push(free != null && free < 2 * GB ? fail(G1, 'h.space', { gb: freeGb }) : free != null && free < 10 * GB ? warn(G1, 'h.space', { gb: freeGb }) : ok(G1, 'h.space', { gb: freeGb }));
  if (!fs.existsSync(p.backups)) results.push(fail(G1, 'h.backupDrive', { dir: p.backups }));
  else {
    const bfree = freeSpace(p.backups);
    const bgb = bfree == null ? '?' : (bfree / GB).toFixed(1);
    results.push(bfree != null && bfree < 5 * GB ? warn(G1, 'h.backupSpace', { gb: bgb }) : ok(G1, 'h.backupSpace', { gb: bgb, dir: p.backups }));
  }

  // ─── PostgreSQL & database ────────────────────────────────────────────────
  const G2 = 'postgres';
  const state = await serviceState(PG_SERVICE);
  results.push(state === 'running' ? ok(G2, 'h.pgService') : fail(G2, 'h.pgService', { state }));
  const portUp = await portOpen(inst.pgPort);
  results.push(portUp ? ok(G2, 'h.pgPort', { port: inst.pgPort }) : fail(G2, 'h.pgPort', { port: inst.pgPort }));
  let ownerOk = false;
  if (portUp) {
    const prev = process.env.PGPASSFILE;
    process.env.PGPASSFILE = p.pgpass;
    const client = new pg.Client({ host: 'localhost', port: inst.pgPort, user: 'etna_owner', database: 'etna', connectionTimeoutMillis: 4000 });
    try {
      await client.connect();
      ownerOk = true;
      const { rows } = await client.query('select name from etna_meta.schema_migrations');
      const applied = new Set(rows.map((r) => r.name));
      const pending = listMigrations().filter((m) => !applied.has(m.name)).length;
      results.push(pending ? fail(G2, 'h.migrations', { count: pending }) : ok(G2, 'h.migrations', { count: applied.size }));
      // The Terminal worker reports every 30 seconds while it runs.
      if (applied.has('migrations/20261012000035_terminal_jobs.sql')) {
        const { rows: w } = await client.query(
          `select coalesce(max(seen_at) > now() - interval '2 minutes', false) as live,
                  (select count(*)::int from public.ps_jobs where status = 'queued' and run_after < now() - interval '10 minutes') as waiting
             from etna_platform.worker_status`
        );
        if (!env.WORKER_DATABASE_URL) results.push(fail(G2, 'h.workerLogin'));
        else if (!w[0].live) results.push(fail(G2, 'h.worker'));
        else if (w[0].waiting > 0) results.push(warn(G2, 'h.workerBacklog', { count: w[0].waiting }));
        else results.push(ok(G2, 'h.worker'));
      }
    } catch {
      // Reported below.
    } finally {
      await client.end().catch(() => {});
      if (prev === undefined) delete process.env.PGPASSFILE;
      else process.env.PGPASSFILE = prev;
    }
    results.push(ownerOk ? ok(G2, 'h.ownerLogin') : fail(G2, 'h.ownerLogin'));
    const appOk = env.DATABASE_URL ? await canConnect(env.DATABASE_URL) : false;
    results.push(appOk ? ok(G2, 'h.appLogin') : fail(G2, 'h.appLogin'));
  }

  // ─── ETNA app & tasks ─────────────────────────────────────────────────────
  const G3 = 'app';
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  results.push(nodeMajor < 20 ? fail(G3, 'h.node', { version: process.version }) : ok(G3, 'h.node', { version: process.version }));
  results.push(isLink(p.current) ? ok(G3, 'h.appFolder') : fail(G3, 'h.appFolder'));
  const status = await httpStatus(`http://127.0.0.1:${APP_PORT}/api/health`);
  results.push(status === 200 ? ok(G3, 'h.app', { port: APP_PORT }) : status === 503 ? fail(G3, 'h.appDb') : fail(G3, 'h.app', { port: APP_PORT }));
  const server = await taskInfo(TASK_FOLDER, SERVER_TASK);
  results.push(!server.exists ? fail(G3, 'h.serverTask') : server.state === 'Disabled' ? warn(G3, 'h.serverTaskOff') : ok(G3, 'h.serverTask', { state: server.state }));
  const backupTask = await taskInfo(TASK_FOLDER, BACKUP_TASK);
  results.push(!backupTask.exists ? warn(G3, 'h.backupTask') : backupTask.state === 'Disabled' ? warn(G3, 'h.backupTaskOff') : ok(G3, 'h.backupTask', { time: inst.backupTime }));
  const newest = listFullBackups(p.fullBackups)[0];
  const hours = newest ? (Date.now() - newest.createdAt.getTime()) / 3600_000 : null;
  results.push(
    hours == null ? fail(G3, 'h.lastBackup') : hours > 24 * 7 ? fail(G3, 'h.lastBackupOld', { hours: Math.round(hours) }) : hours > 36 ? warn(G3, 'h.lastBackupOld', { hours: Math.round(hours) }) : ok(G3, 'h.lastBackupOld', { hours: Math.round(hours) })
  );

  // ─── Configuration & exposure ─────────────────────────────────────────────
  const G4 = 'config';
  const required = ['ETNA_DATA_ROOT', 'DATABASE_URL', 'AUTH_DATABASE_URL', 'MFA_ENCRYPTION_KEY', 'SESSION_HINT_SECRET'].filter((k) => !env[k]);
  const keyBytes = env.MFA_ENCRYPTION_KEY ? Buffer.from(env.MFA_ENCRYPTION_KEY, 'base64').length : 0;
  if (required.length) results.push(fail(G4, 'h.settings', { keys: required.join(', ') }));
  else if (keyBytes !== 32 || (env.SESSION_HINT_SECRET || '').length < 32) results.push(fail(G4, 'h.keys'));
  else if (path.resolve(env.ETNA_DATA_ROOT).toLowerCase() !== path.resolve(inst.root).toLowerCase()) results.push(fail(G4, 'h.rootMismatch', { root: inst.root }));
  else results.push(ok(G4, 'h.settings'));
  results.push(/^https:\/\//.test(env.ETNA_PUBLIC_URL || '') ? ok(G4, 'h.publicUrl', { url: env.ETNA_PUBLIC_URL }) : warn(G4, 'h.publicUrl'));
  results.push(env.TRUST_PROXY === 'cloudflare' ? ok(G4, 'h.trustProxy') : warn(G4, 'h.trustProxy'));
  if (env.ETNA_ADMIN_EMAILS) results.push(warn(G4, 'h.legacyAdmins'));
  results.push(env.ETNA_BACKUP_DATABASE_URL ? warn(G4, 'h.inAppBackup') : ok(G4, 'h.inAppBackupOff'));
  const loose = await looseReaders(p.config);
  results.push(loose === null || loose > 0 ? fail(G4, 'h.configAcl') : ok(G4, 'h.configAcl'));
  const listen = listenAddresses(p.pgData);
  results.push(listen === 'localhost' || listen === '127.0.0.1' ? ok(G4, 'h.pgListen') : fail(G4, 'h.pgListen', { value: String(listen) }));
  const tunnel = await serviceState('cloudflared');
  results.push(tunnel === 'running' ? ok(G4, 'h.tunnel') : warn(G4, 'h.tunnel', { state: tunnel }));
  return results;
}
