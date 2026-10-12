// Operations on an installed ETNA that both the menu and the nightly task
// use: folder permissions, the scheduled tasks, start/stop, full backups and
// migrations.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  backupsToPrune,
  fullBackupName,
  listFullBackups,
  writeArchive,
} from './archive.mjs';
import {
  APP_PORT,
  BACKUP_TASK,
  DATABASE,
  OWNER,
  PG_SERVICE,
  SERVER_TASK,
  SERVICE_USER,
  TASK_FOLDER,
  paths,
} from './layout.mjs';
import { readEnvFile, writeEnvFile } from './envfile.mjs';
import { appliedMigrations, dumpDatabase, ownerClient, ownerUrl } from './postgres.mjs';
import { seal } from './sealed.mjs';
import {
  backupTaskXml,
  endTask,
  httpStatus,
  icacls,
  junctionTarget,
  portOpen,
  powershell,
  psq,
  randomPassword,
  registerTask,
  run,
  runTask,
  serverTaskXml,
  setLocalUser,
  startService,
  waitFor,
} from './sys.mjs';

const ADMINS = '*S-1-5-32-544';
const SYSTEM = '*S-1-5-18';
const NETWORK_SERVICE = '*S-1-5-20';

export const dbConfig = (inst) => ({ port: inst.pgPort, owner: OWNER, database: DATABASE });

/** The schema owner's password is read from <root>\config\pgpass.conf. */
export function useOwnerPassword(inst) {
  process.env.PGPASSFILE = paths(inst.root, inst.backupDir).pgpass;
}

export function managerLog(inst, text) {
  try {
    const p = paths(inst.root, inst.backupDir);
    fs.mkdirSync(p.logs, { recursive: true });
    fs.appendFileSync(path.join(p.logs, 'manager.log'), `[${new Date().toISOString()}] ${os.userInfo().username}: ${text}\r\n`);
  } catch {
    // Logging never stops an operation.
  }
}

/** The app version a folder holds (written by npm run package), or null. */
export function appPackage(appDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, 'etna-package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Only administrators and SYSTEM may change anything under the data root;
 * the service account reads the app and its settings and writes documents,
 * logs and backups; the PostgreSQL service (NetworkService) owns its data.
 */
export async function applyAcls(inst) {
  const p = paths(inst.root, inst.backupDir);
  await icacls(inst.root, ['/inheritance:r', '/grant:r', `${ADMINS}:(OI)(CI)F`, `${SYSTEM}:(OI)(CI)F`, `${SERVICE_USER}:(OI)(CI)RX`]);
  for (const dir of [p.documents, p.logs]) {
    fs.mkdirSync(dir, { recursive: true });
    await icacls(dir, ['/grant', `${SERVICE_USER}:(OI)(CI)M`]);
  }
  fs.mkdirSync(p.fullBackups, { recursive: true });
  if (inst.backupDir) {
    await icacls(p.backups, ['/inheritance:r', '/grant:r', `${ADMINS}:(OI)(CI)F`, `${SYSTEM}:(OI)(CI)F`, `${SERVICE_USER}:(OI)(CI)M`]);
  } else {
    await icacls(p.backups, ['/grant', `${SERVICE_USER}:(OI)(CI)M`]);
  }
  if (fs.existsSync(p.postgres)) await icacls(p.postgres, ['/grant', `${NETWORK_SERVICE}:(OI)(CI)F`]);
}

/**
 * Gives the service account a new random password (nobody needs to know it)
 * and registers both tasks with it. Run after installing, moving or changing
 * the schedule.
 */
export async function refreshTasks(inst) {
  const p = paths(inst.root, inst.backupDir);
  const password = randomPassword();
  await setLocalUser(SERVICE_USER, password, 'Runs ETNA (etna.bat)');
  await powershell(`Add-LocalGroupMember -SID 'S-1-5-32-545' -Member ${psq(SERVICE_USER)} -ErrorAction SilentlyContinue`);
  const scripts = path.join(p.current, 'scripts', 'server');
  await registerTask(TASK_FOLDER, SERVER_TASK, serverTaskXml({ node: inst.node, runner: path.join(scripts, 'run.mjs'), root: inst.root, workDir: p.current }), SERVICE_USER, password);
  await registerTask(TASK_FOLDER, BACKUP_TASK, backupTaskXml({ node: inst.node, manager: path.join(scripts, 'manager.mjs'), root: inst.root, workDir: p.current, time: inst.backupTime }), SERVICE_USER, password);
  if (inst.backupEnabled === false) await setTaskEnabled(BACKUP_TASK, false);
}

export async function setTaskEnabled(name, enabled) {
  await run('schtasks.exe', ['/Change', '/TN', `${TASK_FOLDER}${name}`, enabled ? '/ENABLE' : '/DISABLE']);
}

export const appHealthy = async () => (await httpStatus(`http://127.0.0.1:${APP_PORT}/api/health`)) === 200;

/** Starts PostgreSQL and the app; true once the app answers healthy. */
export async function startEtna(inst, { timeoutMs = 120_000 } = {}) {
  await startService(PG_SERVICE);
  if (await appHealthy()) return true;
  await runTask(TASK_FOLDER, SERVER_TASK);
  return waitFor(appHealthy, { timeoutMs });
}

/** Stops the app (the runner and its child), leaving PostgreSQL running. */
export async function stopEtna(inst) {
  const p = paths(inst.root, inst.backupDir);
  let pid = null;
  try {
    pid = Number(fs.readFileSync(p.pidFile, 'utf8').trim()) || null;
  } catch {
    // Not running from the task.
  }
  if (pid) await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
  await endTask(TASK_FOLDER, SERVER_TASK);
  fs.rmSync(p.pidFile, { force: true });
  return waitFor(async () => !(await portOpen(APP_PORT)), { timeoutMs: 30_000, everyMs: 1000 });
}

/** The migrations of an app folder, applied as the schema owner with its own migrator. */
export async function migrateWith(appDir, inst, log = () => {}) {
  const migrator = await import(pathToFileURL(path.join(appDir, 'scripts', 'db', 'migrator.mjs')).href);
  useOwnerPassword(inst);
  const client = await ownerClient(dbConfig(inst));
  try {
    const applied = await migrator.migrate(
      { exec: (sql) => client.query(sql), query: (sql, params) => client.query(sql, params) },
      { log, migrations: migrator.listMigrations() }
    );
    // Servers set up before the TERMINAL worker get its login on the first update.
    const envFile = paths(inst.root, inst.backupDir).envFile;
    const provision = await import(pathToFileURL(path.join(appDir, 'scripts', 'db', 'provision.mjs')).href);
    if (provision.newLogin && fs.existsSync(envFile) && !readEnvFile(envFile).WORKER_DATABASE_URL) {
      const url = await provision.newLogin(client, ownerUrl(dbConfig(inst)), 'etna_worker');
      writeEnvFile(envFile, { WORKER_DATABASE_URL: url });
      log('worker login');
    }
    return applied;
  } finally {
    await client.end().catch(() => {});
  }
}

/** The migrations an app folder ships. */
export async function shippedMigrations(appDir) {
  const migrator = await import(pathToFileURL(path.join(appDir, 'scripts', 'db', 'migrator.mjs')).href);
  return migrator.listMigrations().map((m) => m.name);
}

/** One full backup (see archive.mjs); old ones are pruned. */
export async function createFullBackup(inst, label = '', { log = () => {} } = {}) {
  const p = paths(inst.root, inst.backupDir);
  useOwnerPassword(inst);
  fs.mkdirSync(p.fullBackups, { recursive: true });
  const name = fullBackupName(new Date(), label);
  const staging = path.join(p.fullBackups, `.staging-${process.pid}-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    log('database');
    await dumpDatabase({ bin: inst.pgBin, cfg: dbConfig(inst), file: path.join(staging, 'database.dump') });
    const client = await ownerClient(dbConfig(inst));
    let migrations;
    let pgVersion;
    try {
      migrations = await appliedMigrations(client);
      pgVersion = (await client.query('show server_version')).rows[0].server_version;
    } finally {
      await client.end().catch(() => {});
    }
    log('settings');
    fs.writeFileSync(path.join(staging, 'secrets.sealed'), seal(fs.readFileSync(p.envFile, 'utf8'), fs.readFileSync(p.publicKey, 'utf8')));
    fs.copyFileSync(p.privateKey, path.join(staging, 'backup-key.enc.pem'));
    const staged = ['manifest.json', 'database.dump', 'secrets.sealed', 'backup-key.enc.pem'];
    if (fs.existsSync(p.pgConfCopy)) {
      fs.cpSync(p.pgConfCopy, path.join(staging, 'postgres-config'), { recursive: true });
      staged.push('postgres-config');
    }
    const version = path.basename(junctionTarget(p.current) || '');
    const manifest = {
      format: 'etna-full-backup-1',
      createdAt: new Date().toISOString(),
      label: label || 'manual',
      host: os.hostname(),
      dataRoot: inst.root,
      app: { folder: version, ...appPackage(p.current) },
      database: DATABASE,
      postgres: pgVersion,
      migrations,
    };
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
    log('files');
    await writeArchive({
      file: path.join(p.fullBackups, name),
      staging,
      stagedNames: staged,
      root: inst.root,
      rootFolders: ['documents', 'logs', ...(version ? [`app/${version}`] : [])],
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  for (const old of backupsToPrune(listFullBackups(p.fullBackups), inst.backupKeep ?? 14)) {
    fs.rmSync(path.join(p.fullBackups, old), { force: true });
  }
  return listFullBackups(p.fullBackups).find((b) => b.name === name);
}
