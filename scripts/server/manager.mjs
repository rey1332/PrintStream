#!/usr/bin/env node
// ETNA server manager, run as administrator: node scripts\server\manager.mjs
// (from a package: node app\scripts\server\manager.mjs).
//
//   node manager.mjs                         the menu
//   node manager.mjs backup --auto --root R  the nightly full backup (task \ETNA\Backup)
//
// Installs ETNA on one Windows server (no Docker): its own PostgreSQL cluster
// and service, the app, settings and keys, a service account, scheduled tasks
// for the app and the backups. Then starts, stops, checks, backs up, restores,
// updates and moves it. Nothing existing is overwritten or deleted without a
// typed confirmation. See docs/teknis/HOW TO ETNA.md and scripts/server/lib/layout.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { upsertPgpass } from '../db/backup-core.mjs';
import { newAppKeys, provision } from '../db/provision.mjs';
import { TAR, extractArchive, listFullBackups, migrationGap, readManifest, readMember } from './lib/archive.mjs';
import { readEnvFile, safeValue, writeEnvFile } from './lib/envfile.mjs';
import { healthCheck } from './lib/health.mjs';
import { KINDS, companyFolderProblem, companyLocations, folderName } from './lib/companies.mjs';
import {
  APP_PORT,
  BACKUP_TASK,
  DATABASE,
  OWNER,
  PG_SERVICE,
  SERVER_TASK,
  SERVICE_USER,
  TASK_FOLDER,
  appFolderProblem,
  installRecordPath,
  paths,
  readInstall,
  rootProblem,
  versionFolder,
  writeInstall,
} from './lib/layout.mjs';
import {
  appHealthy,
  appPackage,
  applyAcls,
  createFullBackup,
  dbConfig,
  managerLog,
  migrateWith,
  refreshTasks,
  setTaskEnabled,
  shippedMigrations,
  startEtna,
  stopEtna,
  useOwnerPassword,
} from './lib/ops.mjs';
import {
  MIN_MAJOR,
  RECOMMENDED_MAJOR,

  configureCluster,
  copyPgConf,
  createOwnerAndDatabase,
  findPostgres,
  initCluster,
  ownerClient,
  ownerUrl,
  registerService,
  restoreDatabase,
  unregisterService,
} from './lib/postgres.mjs';
import { MIN_PASSPHRASE, newBackupKeys, unseal } from './lib/sealed.mjs';
import {
  drives,
  folderStats,
  formatBytes,
  freeSpace,
  icacls,
  isAdmin,
  junctionTarget,
  mustRun,
  portFree,
  portOpen,
  powershell,
  psq,
  randomPassword,
  run,
  serviceState,
  setJunction,
  startService,
  stopService,
  taskInfo,
  waitFor,
  windowsInfo,
} from './lib/sys.mjs';
import { setLanguage, t } from './lib/text.mjs';
import * as ui from './lib/ui.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The app folder this manager belongs to: a package's app\ or <root>\app\<version>. */
const APP_DIR = path.resolve(here, '..', '..');
const GB = 1024 ** 3;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const yes = () => t('yesKey');
const no = () => t('noKey');
const confirm = (q, fallback = false) => ui.confirm(q, { yes: yes(), no: no(), fallback });
const pause = () => ui.pause(t('pressEnter'));

function installed() {
  const inst = readInstall();
  return inst && fs.existsSync(inst.root) ? inst : null;
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** True when this manager runs from a package (not from the installed app). */
function fromPackage(inst) {
  if (!appPackage(APP_DIR)) return false;
  if (!inst) return true;
  return realOrNull(APP_DIR) !== realOrNull(paths(inst.root).current);
}


// ─── Pickers ─────────────────────────────────────────────────────────────────

/** A folder on a drive from the list, or a typed one. Returns an absolute path or null. */
async function pickFolder(question, defaultName) {
  const list = await drives();
  const options = list.map((d, i) => ({
    key: String(i + 1),
    label: `${d.letter}\\  ${t('freeOf', { free: formatBytes(d.free), size: formatBytes(d.size) })}${d.label ? `  (${d.label})` : ''}`,
  }));
  options.push({ key: 'c', label: t('customFolder') });
  options.push({ key: '0', label: t('cancel') });
  console.log(`\n${question}`);
  const pick = await ui.choose(t('select'), options);
  if (pick === '0') return null;
  if (pick === 'c') {
    const typed = await ui.ask(t('typeFolder'));
    return typed ? path.resolve(typed) : null;
  }
  return path.join(`${list[Number(pick) - 1].letter}\\`, defaultName);
}

/** Checks a folder for ETNA data: room, a sane path, nothing of ETNA's in it. */
async function checkNewRoot(root, { minFree = 5 * GB, warnFree = 20 * GB } = {}) {
  const problem = rootProblem(root) || appFolderProblem(root, APP_DIR);
  if (problem) {
    console.log(ui.red(t(problem)));
    return false;
  }
  const free = freeSpace(root);
  if (free === null) {
    console.log(ui.red(t('driveMissing')));
    return false;
  }
  if (free < minFree) {
    console.log(ui.red(t('tooLittleSpace', { free: formatBytes(free), need: formatBytes(minFree) })));
    return false;
  }
  if (free < warnFree && !(await confirm(t('littleSpace', { free: formatBytes(free) })))) return false;
  if (fs.existsSync(path.join(root, 'postgres', 'data', 'PG_VERSION')) || fs.existsSync(path.join(root, 'config', 'etna.env'))) {
    console.log(ui.red(t('existingEtna', { root })));
    return false;
  }
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0 && !(await confirm(t('folderNotEmpty', { root })))) return false;
  return true;
}

async function firstFreePort(from, to) {
  for (let port = from; port <= to; port += 1) {
    if ((await portFree(port)) && !(await portOpen(port))) return port;
  }
  return null;
}

// ─── [1] Install ─────────────────────────────────────────────────────────────

async function install() {
  const current = installed();
  if (current) {
    console.log(ui.yellow(t('alreadyInstalled', { root: current.root })));
    return;
  }
  const pkg = appPackage(APP_DIR);
  if (!pkg) {
    console.log(ui.red(t('notAPackage')));
    return;
  }

  console.log(`\n${ui.bold(t('install.checks'))}`);
  const info = await windowsInfo();
  const pgFound = await findPostgres();
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const problems = [];
  const show = (good, text) => console.log(`  [${good ? ui.green('OK') : ui.red('!!')}] ${text}`);
  show(!info.build || info.build >= 17134, t('check.windows', { windows: info.windows }));
  if (info.build && info.build < 17134) problems.push(t('check.windowsOld'));
  show(nodeMajor >= 20, t('check.node', { version: process.version }));
  if (nodeMajor < 20) problems.push(t('check.nodeOld'));
  if (pkg.node && Number(String(pkg.node).replace(/^v/, '').split('.')[0]) !== nodeMajor) {
    console.log(ui.yellow(`       ${t('check.nodeDiffers', { built: pkg.node, here: process.version })}`));
  }
  show(!!pgFound && pgFound.major >= MIN_MAJOR, pgFound ? t('check.pg', { version: pgFound.version, bin: pgFound.bin }) : t('check.pgMissing'));
  if (!pgFound) problems.push(t('check.pgInstall', { major: RECOMMENDED_MAJOR }));
  else if (pgFound.major < MIN_MAJOR) problems.push(t('check.pgOld', { major: RECOMMENDED_MAJOR }));
  const appPortFree = await portFree(APP_PORT);
  show(appPortFree, t('check.appPort', { port: APP_PORT }));
  if (!appPortFree) problems.push(t('check.appPortBusy', { port: APP_PORT }));
  const pgServiceState = await serviceState(PG_SERVICE);
  show(pgServiceState === 'missing', t('check.pgService', { name: PG_SERVICE }));
  if (pgServiceState !== 'missing') problems.push(t('check.pgServiceExists', { name: PG_SERVICE }));
  const tunnel = await serviceState('cloudflared');
  console.log(`  [${tunnel === 'running' ? ui.green('OK') : ui.yellow('--')}] ${t(tunnel === 'running' ? 'check.tunnel' : 'check.noTunnel')}`);
  if (problems.length) {
    console.log(`\n${ui.red(t('install.cannot'))}`);
    for (const p of problems) console.log(`  - ${p}`);
    return;
  }

  // Storage.
  let root = null;
  while (!root) {
    const picked = await pickFolder(t('install.whereStorage'), 'ETNA');
    if (!picked) return;
    if (await checkNewRoot(picked)) root = picked;
  }
  console.log(ui.green(t('install.storageAt', { root })));

  // Backups.
  let backupDir = null;
  console.log(`\n${t('install.backupWhere')}`);
  const where = await ui.choose(t('select'), [
    { key: '1', label: t('install.backupSame', { dir: path.join(root, 'backups') }) },
    { key: '2', label: t('install.backupOther') },
  ], '1');
  if (where === '2') {
    for (;;) {
      const picked = await pickFolder(t('install.backupPick'), 'ETNA-backups');
      if (!picked) break;
      if (picked.toLowerCase().startsWith(root.toLowerCase())) {
        console.log(ui.red(t('install.backupInsideRoot')));
        continue;
      }
      if (!rootProblem(picked) && !appFolderProblem(picked, APP_DIR) && freeSpace(picked) !== null) {
        backupDir = picked;
        break;
      }
      console.log(ui.red(t(rootProblem(picked) || appFolderProblem(picked, APP_DIR) || 'driveMissing')));
    }
  }
  if (backupDir && path.parse(backupDir).root.toLowerCase() === path.parse(root).root.toLowerCase()) {
    console.log(ui.yellow(t('install.backupSameDisk')));
  }

  // Database port.
  const pgPort = await firstFreePort(5432, 5450);
  if (!pgPort) {
    console.log(ui.red(t('install.noPgPort')));
    return;
  }

  // Public address (Cloudflare Tunnel).
  console.log(`\n${t('install.publicUrlIntro')}`);
  let publicUrl = '';
  for (;;) {
    publicUrl = (await ui.ask(t('install.publicUrl'))).replace(/\/+$/, '');
    if (!publicUrl || /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(publicUrl)) break;
    console.log(ui.red(t('install.publicUrlBad')));
  }

  // The first super admin.
  console.log(`\n${t('install.adminIntro')}`);
  let adminEmail = '';
  while (!EMAIL.test(adminEmail)) adminEmail = (await ui.ask(t('install.adminEmail'))).toLowerCase();
  const adminName = (await ui.ask(t('install.adminName'))).slice(0, 120);
  const adminPassword = await ui.newSecret(t('install.adminPassword'), t('again'), t('mismatch'), t('tooShort', { n: 12 }), 12);
  if (!adminPassword) return;

  // Backup passphrase.
  console.log(`\n${t('install.passphraseIntro')}`);
  const passphrase = await ui.newSecret(t('install.passphrase'), t('again'), t('mismatch'), t('tooShort', { n: MIN_PASSPHRASE }), MIN_PASSPHRASE);
  if (!passphrase) return;

  // Schedule.
  let backupTime = (await ui.ask(t('install.backupTime'))) || '02:00';
  while (!/^([01]\d|2[0-3]):[0-5]\d$/.test(backupTime)) backupTime = (await ui.ask(t('install.backupTime'))) || '02:00';

  console.log(`\n${ui.bold(t('install.summary'))}`);
  console.log(`  ${t('sum.version')}: ${pkg.version} (${pkg.builtAt})`);
  console.log(`  ETNA_DATA_ROOT: ${root}`);
  console.log(`  ${t('sum.backups')}: ${backupDir || path.join(root, 'backups')}`);
  console.log(`  PostgreSQL: ${pgFound.version}, ${t('sum.service')} ${PG_SERVICE}, ${t('sum.port')} ${pgPort} (localhost)`);
  console.log(`  ${t('sum.app')}: http://127.0.0.1:${APP_PORT}  ${publicUrl ? `→ ${publicUrl}` : ''}`);
  console.log(`  ${t('sum.account')}: ${SERVICE_USER}`);
  console.log(`  ${t('sum.admin')}: ${adminEmail}`);
  console.log(`  ${t('sum.schedule')}: ${backupTime}, ${t('sum.keep', { n: 14 })}`);
  if (backupDir) console.log(ui.yellow(`  ${t('install.backupLocked', { dir: backupDir })}`));
  if (!(await confirm(t('install.go')))) return;

  const inst = {
    root,
    backupDir,
    pgPort,
    pgBin: pgFound.bin,
    pgVersion: pgFound.version,
    node: process.execPath,
    backupTime,
    backupKeep: 14,
    backupEnabled: true,
    publicUrl,
    installedAt: new Date().toISOString(),
    language: t('code'),
  };
  const p = paths(root, backupDir);
  const done = [];
  const superPassword = randomPassword();
  const ownerPassword = randomPassword();
  const rootExisted = fs.existsSync(root);

  const stage = async (key, fn) => {
    ui.step(t(key));
    try {
      const out = await fn();
      ui.stepDone();
      done.push(key);
      return out;
    } catch (error) {
      ui.stepFailed();
      throw error;
    }
  };

  try {
    await stage('do.folders', async () => {
      for (const dir of [p.root, p.app, p.config, p.documents, p.logs, p.backups, p.fullBackups, p.postgres]) fs.mkdirSync(dir, { recursive: true });
    });
    await stage('do.app', async () => {
      const target = path.join(p.app, versionFolder(pkg));
      fs.cpSync(APP_DIR, target, { recursive: true });
      setJunction(p.current, target);
    });
    await stage('do.postgres', async () => {
      // initdb drops administrator rights while it runs, so this account needs its own grant meanwhile.
      const me = (await mustRun('whoami.exe')).trim();
      await icacls(p.postgres, ['/grant', `${me}:(OI)(CI)F`]);
      await initCluster({ bin: pgFound.bin, dataDir: p.pgData, superPassword });
      configureCluster(p.pgData, pgPort);
      await icacls(p.postgres, ['/grant', '*S-1-5-20:(OI)(CI)F']);
      await registerService({ bin: pgFound.bin, dataDir: p.pgData, name: PG_SERVICE });
      await startService(PG_SERVICE);
      if (!(await waitFor(() => portOpen(pgPort), { timeoutMs: 60_000, everyMs: 1000 }))) throw new Error(t('pgNoStart'));
      await icacls(p.postgres, ['/remove:g', me]).catch(() => {});
      copyPgConf(p.pgData, p.pgConfCopy);
    });
    await stage('do.database', async () => {
      await createOwnerAndDatabase({ port: pgPort, superPassword, owner: OWNER, ownerPassword, database: DATABASE });
      fs.writeFileSync(p.pgpass, upsertPgpass('', { host: 'localhost', port: String(pgPort), database: DATABASE, user: OWNER, password: ownerPassword }));
    });
    const db = await stage('do.migrate', async () => {
      useOwnerPassword(inst);
      const client = await ownerClient(dbConfig(inst));
      try {
        return await provision(client, ownerUrl(dbConfig(inst)));
      } finally {
        await client.end().catch(() => {});
      }
    });
    await stage('do.settings', async () => {
      const keys = newAppKeys();
      const settings = {
        ETNA_DATA_ROOT: root,
        DATABASE_URL: db.DATABASE_URL,
        AUTH_DATABASE_URL: db.AUTH_DATABASE_URL,
        WORKER_DATABASE_URL: db.WORKER_DATABASE_URL,
        MFA_ENCRYPTION_KEY: keys.MFA_ENCRYPTION_KEY,
        SESSION_HINT_SECRET: keys.SESSION_HINT_SECRET,
        TRUST_PROXY: 'cloudflare',
        ETNA_PUBLIC_URL: publicUrl || null,
        ETNA_BACKUP_DIR: backupDir || null,
        // In-app "Back up now" (/admin/system): the app may use the owner password in pgpass.conf.
        ETNA_BACKUP_DATABASE_URL: ownerUrl(dbConfig(inst)),
        PGPASSFILE: p.pgpass,
      };
      if (!Object.values(settings).every((v) => v === null || safeValue(v))) throw new Error('invalid setting');
      fs.writeFileSync(p.envFile, '# ETNA server settings — written by the ETNA server manager. Secret: never copy elsewhere.\r\n');
      writeEnvFile(p.envFile, settings);
      const backupKeys = newBackupKeys(passphrase);
      fs.writeFileSync(p.publicKey, backupKeys.publicKey);
      fs.writeFileSync(p.privateKey, backupKeys.privateKey);
    });
    await stage('do.admin', async () => {
      useOwnerPassword(inst);
      const client = await ownerClient(dbConfig(inst));
      try {
        await client.query('begin');
        const hash = await bcrypt.hash(adminPassword, 12);
        await client.query(
          `insert into auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
           values ($1, $2, jsonb_build_object('full_name', $3::text), now())`,
          [adminEmail, hash, adminName || adminEmail.split('@')[0]]
        );
        await client.query('select etna_admin.log_event($1, $2, $3)', ['USER_CREATED', adminEmail, JSON.stringify({ via: 'server-manager' })]);
        await client.query(`select etna_admin.grant_platform_admin($1, 'super_admin')`, [adminEmail]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        await client.end().catch(() => {});
      }
    });
    await stage('do.record', async () => {
      writeInstall(inst);
    });
    await stage('do.permissions', () => applyAcls(inst));
    await stage('do.tasks', () => refreshTasks(inst));
    await stage('do.start', async () => {
      if (!(await startEtna(inst))) throw new Error(t('appNoStart'));
      return true;
    });
    managerLog(inst, `installed ${pkg.version} (${pkg.builtAt}) at ${root}`);
  } catch (error) {
    console.log(ui.red(`\n${t('install.failed', { error: error instanceof Error ? error.message : String(error) })}`));
    if (done.length && (await confirm(t('install.undo')))) await undoInstall({ root, rootExisted, p, done, pgBin: pgFound.bin });
    else if (done.length) console.log(t('install.leftAsIs', { root }));
    return;
  }

  console.log(`\n${ui.green(ui.bold(t('install.done')))}`);
  console.log(ui.bold(t('install.writeDown')));
  console.log(`  PostgreSQL superuser (postgres): ${superPassword}`);
  console.log(`  ${OWNER}: ${ownerPassword}`);
  console.log(ui.yellow(t('install.writeDownWhy')));
  console.log(`\n${t('install.next', { url: publicUrl || `http://127.0.0.1:${APP_PORT}`, email: adminEmail })}`);
  if (tunnel !== 'running') console.log(ui.yellow(t('install.tunnelNext', { port: APP_PORT })));
  await whereThings(inst);
}

/** Addresses, folders, services and logs of an installation, and what to do when something breaks. */
async function whereThings(inst) {
  const p = paths(inst.root, inst.backupDir);
  console.log(`\n${ui.bold(t('where.title'))}`);
  console.log(`  ${t('where.url')}: http://127.0.0.1:${APP_PORT}${inst.publicUrl ? `  →  ${inst.publicUrl}` : ''}`);
  console.log(`  ${t('where.app')}: ${p.current}`);
  console.log(`  ${t('where.config')}: ${p.envFile}`);
  console.log(`  ${t('where.database')}: ${p.pgData}  (PostgreSQL ${inst.pgVersion ?? ''}, localhost:${inst.pgPort})`);
  console.log(`  ${t('where.documents')}: ${p.documents}`);
  console.log(`  ${t('where.backups')}: ${p.fullBackups}`);
  console.log(`  ${t('where.logs')}: ${p.logs}  (server-YYYYMMDD.log, manager.log)`);
  console.log(`  ${t('where.services')}: ${PG_SERVICE} = ${await serviceState(PG_SERVICE)} · ${TASK_FOLDER}${SERVER_TASK} · ${TASK_FOLDER}${BACKUP_TASK}`);
  console.log(`\n${t('where.backupHow', { time: inst.backupTime ?? '02:00' })}`);
  console.log(t('where.recovery', { launcher: `node "${path.join(p.current, 'scripts', 'server', 'manager.mjs')}"` }));
}

async function undoInstall({ root, rootExisted, p, done, pgBin }) {
  const quiet = async (fn) => {
    try {
      await fn();
    } catch {
      // Best effort.
    }
  };
  await quiet(() => run('schtasks.exe', ['/End', '/TN', `${TASK_FOLDER}${SERVER_TASK}`]));
  for (const name of [SERVER_TASK, BACKUP_TASK]) {
    await quiet(() => powershell(`Unregister-ScheduledTask -TaskPath ${psq(TASK_FOLDER)} -TaskName ${psq(name)} -Confirm:$false -ErrorAction SilentlyContinue`));
  }
  if (done.includes('do.tasks')) await quiet(() => powershell(`Remove-LocalUser -Name ${psq(SERVICE_USER)} -ErrorAction SilentlyContinue`));
  if ((await serviceState(PG_SERVICE)) !== 'missing') {
    await quiet(() => stopService(PG_SERVICE));
    await quiet(() => unregisterService({ bin: pgBin, name: PG_SERVICE }));
  }
  await quiet(() => fs.rmSync(installRecordPath(), { force: true }));
  // Only what this installation made; the folder itself only if it did not exist.
  await quiet(() => icacls(root, ['/reset', '/T']));
  for (const dir of [p.app, p.config, p.postgres, p.documents, p.logs, p.fullBackups]) await quiet(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const dir of [p.backups, root]) {
    if (dir === root && rootExisted) continue;
    await quiet(() => fs.rmdirSync(dir));
  }
  console.log(t('install.undone'));
}

// ─── [2]–[4] Start, stop, restart ────────────────────────────────────────────

async function start(inst) {
  ui.step(t('starting'));
  const ok = await startEtna(inst);
  if (ok) ui.stepDone();
  else ui.stepFailed();
  console.log(ok ? ui.green(t('started', { port: APP_PORT })) : ui.red(t('appNoStart')));
  managerLog(inst, ok ? 'started' : 'start failed');
}

async function stop(inst) {
  ui.step(t('stopping'));
  const ok = await stopEtna(inst);
  if (ok) ui.stepDone();
  else ui.stepFailed();
  console.log(ok ? t('stopped') : ui.red(t('notStopped', { port: APP_PORT })));
  managerLog(inst, ok ? 'stopped' : 'stop failed');
}

// ─── [5] Health check ────────────────────────────────────────────────────────

async function health(inst) {
  console.log(`\n${ui.bold(t('health.title'))}\n`);
  const results = await healthCheck(inst);
  let group = '';
  let bad = 0;
  for (const r of results) {
    if (r.group !== group) {
      group = r.group;
      console.log(ui.bold(t(`group.${group}`)));
    }
    const mark = r.status === 'ok' ? ui.green('OK') : r.status === 'warn' ? ui.yellow('!!') : ui.red('XX');
    console.log(`  [${mark}] ${t(r.key, r.vars)}`);
    if (r.status !== 'ok') {
      bad += 1;
      console.log(`       ${t(r.problem, r.vars)}`);
      console.log(`       ${ui.dim(t('fixLabel'))} ${t(r.fix, r.vars)}`);
    }
  }
  console.log(`\n${bad ? ui.yellow(t('health.issues', { n: bad })) : ui.green(t('health.allGood'))}`);
}

// ─── [6]–[8] Backups ─────────────────────────────────────────────────────────

async function backupNow(inst) {
  console.log(t('backup.running'));
  const made = await createFullBackup(inst, '', { log: (part) => console.log(`  ${t(`backup.part.${part}`)}`) });
  managerLog(inst, `backup ${made.name}`);
  console.log(ui.green(t('backup.done', { name: made.name, size: formatBytes(made.size) })));
  console.log(ui.yellow(t('backup.copyAway', { dir: paths(inst.root, inst.backupDir).fullBackups })));
}

function listBackups(inst) {
  const list = listFullBackups(paths(inst.root, inst.backupDir).fullBackups);
  if (!list.length) {
    console.log(t('backup.none'));
    return list;
  }
  list.forEach((b, i) => {
    console.log(`  [${i + 1}] ${b.createdAt.toLocaleString()}  ${t(`label.${b.label}`, {}, b.label).padEnd(16)} ${formatBytes(b.size).padStart(9)}  ${ui.dim(b.name)}`);
  });
  return list;
}

async function restore(inst) {
  const p = paths(inst.root, inst.backupDir);
  console.log(`\n${t('restore.pick')}`);
  const list = listBackups(inst);
  const answer = await ui.ask(t('restore.which'));
  if (!answer || answer === '0') return;
  const file = /^\d+$/.test(answer) ? list[Number(answer) - 1]?.file : path.resolve(answer);
  if (!file || !fs.existsSync(file)) {
    console.log(ui.red(t('restore.notFound')));
    return;
  }
  let manifest;
  try {
    manifest = await readManifest(file);
  } catch (error) {
    console.log(ui.red(error.message));
    return;
  }
  console.log(`\n  ${t('restore.made', { at: new Date(manifest.createdAt).toLocaleString(), host: manifest.host })}`);
  console.log(`  ${t('restore.appVersion', { version: manifest.app?.version ?? '?', built: manifest.app?.builtAt ?? '?' })}`);
  console.log(`  ${t('restore.migrations', { n: manifest.migrations.length })}`);

  // Which app runs afterwards: the current one, or the one inside the backup.
  let appDir = p.current;
  const currentPkg = appPackage(p.current);
  const sameApp = currentPkg && manifest.app?.buildId && currentPkg.buildId === manifest.app.buildId;
  let useBackupApp = false;
  if (!sameApp && manifest.app?.folder) {
    console.log(ui.yellow(t('restore.otherApp', { current: currentPkg?.version ?? '?', backup: manifest.app.version ?? '?' })));
    useBackupApp = await confirm(t('restore.useBackupApp'));
  }
  if (!useBackupApp) {
    const gap = migrationGap(manifest.migrations, await shippedMigrations(appDir));
    if (gap.length) {
      console.log(ui.red(t('restore.tooNew', { n: gap.length })));
      return;
    }
  }

  // Settings and keys need the passphrase.
  let secrets = null;
  const sealed = await readMember(file, 'secrets.sealed');
  const keyPem = await readMember(file, 'backup-key.enc.pem');
  for (;;) {
    const pass = await ui.ask(t('restore.passphrase'), { hidden: true });
    if (!pass) {
      if (await confirm(t('restore.withoutSecrets'))) break;
      continue;
    }
    try {
      secrets = readEnvFileText(unseal(sealed, keyPem, pass));
      break;
    } catch (error) {
      console.log(ui.red(t(error.message === 'wrong_passphrase' ? 'restore.wrongPassphrase' : 'restore.damaged')));
    }
  }

  console.log(ui.red(ui.bold(`\n${t('restore.warning')}`)));
  const typed = await ui.ask(t('restore.typeName', { name: DATABASE }));
  if (typed !== DATABASE) {
    console.log(t('notConfirmed'));
    return;
  }

  managerLog(inst, `restore ${path.basename(file)} started`);
  const work = path.join(p.fullBackups, `.restore-${Date.now()}`);
  try {
    ui.step(t('restore.safety'));
    const safety = await createFullBackup(inst, 'before-restore');
    ui.stepDone();
    console.log(`       ${safety.name}`);
    ui.step(t('stopping'));
    await stopEtna(inst);
    ui.stepDone();
    ui.step(t('restore.unpack'));
    await extractArchive(file, work);
    ui.stepDone();

    if (useBackupApp) {
      ui.step(t('restore.app'));
      const target = path.join(p.app, manifest.app.folder);
      if (!fs.existsSync(target)) fs.cpSync(path.join(work, 'app', manifest.app.folder), target, { recursive: true });
      setJunction(p.current, target);
      appDir = p.current;
      ui.stepDone();
    }

    ui.step(t('restore.database'));
    useOwnerPassword(inst);
    await restoreDatabase({ bin: inst.pgBin, cfg: dbConfig(inst), file: path.join(work, 'database.dump') });
    ui.stepDone();

    ui.step(t('restore.documents'));
    const keptDocs = `${p.documents}.before-restore-${Date.now()}`;
    if (fs.existsSync(p.documents)) fs.renameSync(p.documents, keptDocs);
    const restoredDocs = path.join(work, 'documents');
    if (fs.existsSync(restoredDocs)) fs.cpSync(restoredDocs, p.documents, { recursive: true });
    else fs.mkdirSync(p.documents, { recursive: true });
    ui.stepDone();
    console.log(`       ${t('restore.oldDocs', { dir: keptDocs })}`);

    if (secrets) {
      ui.step(t('restore.keys'));
      writeEnvFile(p.envFile, {
        MFA_ENCRYPTION_KEY: secrets.MFA_ENCRYPTION_KEY,
        SESSION_HINT_SECRET: secrets.SESSION_HINT_SECRET,
      });
      ui.stepDone();
    } else {
      console.log(ui.yellow(`       ${t('restore.keysKept')}`));
    }

    ui.step(t('do.migrate'));
    await migrateWith(appDir, inst);
    ui.stepDone();
    await applyAcls(inst);
    await start(inst);
    managerLog(inst, `restored ${path.basename(file)}`);
    console.log(ui.green(t('restore.done', { safety: safety.name })));
  } catch (error) {
    ui.stepFailed();
    console.log(ui.red(t('restore.failed', { error: error.message })));
    managerLog(inst, `restore failed: ${error.message}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function readEnvFileText(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// ─── [9] Schedule ────────────────────────────────────────────────────────────

async function schedule(inst) {
  const task = await taskInfo(TASK_FOLDER, BACKUP_TASK);
  console.log(`\n  ${t('schedule.now', { time: inst.backupTime, keep: inst.backupKeep ?? 14, state: task.exists ? task.state : '—' })}`);
  if (task.lastRun && !task.lastRun.startsWith('1999')) console.log(`  ${t('schedule.last', { at: new Date(task.lastRun).toLocaleString(), result: task.lastResult })}`);
  const pick = await ui.choose(t('select'), [
    { key: '1', label: t('schedule.time') },
    { key: '2', label: t('schedule.keep') },
    { key: '3', label: inst.backupEnabled === false ? t('schedule.on') : t('schedule.off') },
    { key: '0', label: t('back') },
  ]);
  if (pick === '0') return;
  if (pick === '1') {
    const time = await ui.ask(t('install.backupTime'));
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return;
    inst.backupTime = time;
  } else if (pick === '2') {
    const keep = Number(await ui.ask(t('schedule.keepAsk')));
    if (!Number.isInteger(keep) || keep < 2 || keep > 365) return;
    inst.backupKeep = keep;
  } else {
    inst.backupEnabled = inst.backupEnabled === false;
  }
  writeInstall(inst);
  if (pick === '3') await setTaskEnabled(BACKUP_TASK, inst.backupEnabled);
  else await refreshTasks(inst);
  managerLog(inst, `backup schedule ${inst.backupTime}, keep ${inst.backupKeep}, ${inst.backupEnabled === false ? 'off' : 'on'}`);
  console.log(ui.green(t('saved')));
}

// ─── [10] Logs ───────────────────────────────────────────────────────────────

async function logs(inst) {
  const dir = paths(inst.root, inst.backupDir).logs;
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort().reverse().slice(0, 12)
    : [];
  if (!files.length) {
    console.log(t('logs.none'));
    return;
  }
  const pick = await ui.choose(t('select'), [...files.map((f, i) => ({ key: String(i + 1), label: f })), { key: '0', label: t('back') }]);
  if (pick === '0') return;
  const file = path.join(dir, files[Number(pick) - 1]);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  console.log(ui.dim(`--- ${file} (${t('logs.last', { n: 60 })}) ---`));
  console.log(lines.slice(-61).join('\n'));
  if (await confirm(t('logs.open'))) await run('notepad.exe', [file]);
}

// ─── [11] Update ─────────────────────────────────────────────────────────────

async function update(inst) {
  const p = paths(inst.root, inst.backupDir);
  let source = fromPackage(inst) ? APP_DIR : null;
  if (!source) {
    const typed = await ui.ask(t('update.where'));
    if (!typed) return;
    const dir = path.resolve(typed);
    source = fs.existsSync(path.join(dir, 'app', 'etna-package.json')) ? path.join(dir, 'app') : dir;
  }
  const next = appPackage(source);
  const now = appPackage(p.current);
  if (!next) {
    console.log(ui.red(t('notAPackage')));
    return;
  }
  console.log(`  ${t('update.from', { version: now?.version ?? '?', built: now?.builtAt ?? '?' })}`);
  console.log(`  ${t('update.to', { version: next.version, built: next.builtAt })}`);
  if (now?.buildId && now.buildId === next.buildId) {
    console.log(t('update.same'));
    return;
  }
  // The new app must know every migration already applied (no downgrades).
  useOwnerPassword(inst);
  const client = await ownerClient(dbConfig(inst));
  let applied;
  try {
    applied = (await client.query('select name from etna_meta.schema_migrations')).rows.map((r) => r.name);
  } finally {
    await client.end().catch(() => {});
  }
  const shipped = await shippedMigrations(source);
  const unknown = migrationGap(applied, shipped);
  if (unknown.length) {
    console.log(ui.red(t('update.older', { n: unknown.length })));
    return;
  }
  const pending = shipped.filter((m) => !applied.includes(m)).length;
  console.log(`  ${t('update.pending', { n: pending })}`);
  if (!(await confirm(t('update.go')))) return;

  const previous = junctionTarget(p.current);
  const target = path.join(p.app, versionFolder(next));
  try {
    ui.step(t('update.backup'));
    const safety = await createFullBackup(inst, 'before-update');
    ui.stepDone();
    console.log(`       ${safety.name}`);
    ui.step(t('update.copy'));
    if (!fs.existsSync(target)) fs.cpSync(source, target, { recursive: true });
    ui.stepDone();
    ui.step(t('stopping'));
    await stopEtna(inst);
    ui.stepDone();
    setJunction(p.current, target);
    ui.step(t('do.migrate'));
    await migrateWith(p.current, inst);
    ui.stepDone();
    await applyAcls(inst);
    ui.step(t('starting'));
    if (await startEtna(inst)) {
      ui.stepDone();
      pruneAppVersions(p, [target, previous]);
      managerLog(inst, `updated to ${next.version} (${next.builtAt})`);
      console.log(ui.green(t('update.done', { version: next.version })));
      return;
    }
    ui.stepFailed();
    throw new Error(t('appNoStart'));
  } catch (error) {
    console.log(ui.red(t('update.failed', { error: error.message })));
    if (previous && fs.existsSync(previous)) {
      ui.step(t('update.rollback'));
      await stopEtna(inst);
      setJunction(p.current, previous);
      const back = await startEtna(inst);
      if (back) ui.stepDone();
      else ui.stepFailed();
      console.log(ui.yellow(t('update.rolledBack')));
    }
    managerLog(inst, `update to ${next.version} failed: ${error.message}`);
  }
}

/** Keeps the running version and the previous one. */
function pruneAppVersions(p, keep) {
  const wanted = new Set(keep.filter(Boolean).map((d) => path.resolve(d).toLowerCase()));
  for (const name of fs.readdirSync(p.app)) {
    const full = path.join(p.app, name);
    if (name === 'current' || wanted.has(path.resolve(full).toLowerCase())) continue;
    fs.rmSync(full, { recursive: true, force: true });
  }
}

// ─── [12] Move storage ───────────────────────────────────────────────────────

async function moveStorage(inst) {
  const p = paths(inst.root, inst.backupDir);
  const size = folderStats(inst.root);
  console.log(`\n  ${t('move.now', { root: inst.root, size: formatBytes(size.bytes), files: size.files })}`);
  const target = await pickFolder(t('move.where'), 'ETNA');
  if (!target) return;
  if (target.toLowerCase().startsWith(inst.root.toLowerCase()) || inst.root.toLowerCase().startsWith(target.toLowerCase())) {
    console.log(ui.red(t('move.nested')));
    return;
  }
  if (!(await checkNewRoot(target, { minFree: size.bytes * 1.1 + 2 * GB, warnFree: size.bytes * 1.5 + 10 * GB }))) return;
  console.log(ui.yellow(t('move.explain', { from: inst.root, to: target })));
  if (!(await confirm(t('move.go')))) return;

  const moved = { ...inst, root: target };
  const q = paths(target, inst.backupDir);
  managerLog(inst, `move to ${target} started`);
  try {
    ui.step(t('stopping'));
    await stopEtna(inst);
    await stopService(PG_SERVICE);
    ui.stepDone();
    ui.step(t('move.copy'));
    // /XJ: the app\current junction is made again below.
    const r = await run('robocopy.exe', [inst.root, target, '/E', '/COPY:DAT', '/DCOPY:DAT', '/XJ', '/R:2', '/W:2', '/NFL', '/NDL', '/NP']);
    if (r.code >= 8) throw new Error(`robocopy ${r.code}`);
    const after = folderStats(target);
    if (after.files < size.files) throw new Error(t('move.incomplete', { copied: after.files, total: size.files }));
    ui.stepDone();
    setJunction(q.current, path.join(q.app, path.basename(junctionTarget(p.current))));
    ui.step(t('move.service'));
    await unregisterService({ bin: inst.pgBin, name: PG_SERVICE });
    await registerService({ bin: inst.pgBin, dataDir: q.pgData, name: PG_SERVICE });
    ui.stepDone();
    writeEnvFile(q.envFile, { ETNA_DATA_ROOT: target, PGPASSFILE: q.pgpass });
    writeInstall(moved);
    await applyAcls(moved);
    await refreshTasks(moved);
    await startService(PG_SERVICE);
    await start(moved);
    managerLog(moved, `moved from ${inst.root}`);
    console.log(ui.green(t('move.done', { to: target, from: inst.root })));
  } catch (error) {
    ui.stepFailed();
    console.log(ui.red(t('move.failed', { error: error.message, from: inst.root })));
    // Back to the old place: its files were only copied, never removed.
    if ((await serviceState(PG_SERVICE)) === 'missing') await registerService({ bin: inst.pgBin, dataDir: p.pgData, name: PG_SERVICE }).catch(() => {});
    writeInstall(inst);
    await startService(PG_SERVICE).catch(() => {});
    await refreshTasks(inst).catch(() => {});
    await startEtna(inst).catch(() => {});
    managerLog(inst, `move failed: ${error.message}`);
  }
}

// ─── [13] Server info ────────────────────────────────────────────────────────

async function serverInfo(inst) {
  const info = await windowsInfo();
  console.log(`\n  Windows: ${info.windows}`);
  console.log(`  ${t('info.host')}: ${info.hostname}`);
  console.log(`  CPU: ${info.cpu} (${info.cores} ${t('info.cores')})`);
  console.log(`  RAM: ${formatBytes(info.ramTotal)} (${t('info.free')} ${formatBytes(info.ramFree)})`);
  console.log(`  Node.js: ${process.version} (${process.execPath})`);
  const pgFound = await findPostgres();
  console.log(`  PostgreSQL: ${pgFound ? `${pgFound.version} (${pgFound.bin})` : t('check.pgMissing')}`);
  console.log(`  tar.exe: ${(await run(TAR, ['--version'])).code === 0 ? 'OK' : t('info.missing')}`);
  console.log(`\n  ${t('info.drives')}`);
  for (const d of await drives()) console.log(`    ${d.letter}\\  ${t('freeOf', { free: formatBytes(d.free), size: formatBytes(d.size) })}${d.label ? `  (${d.label})` : ''}`);
  const ports = [APP_PORT, inst?.pgPort ?? 5432];
  console.log(`\n  ${t('info.ports')}`);
  for (const port of ports) console.log(`    ${port}: ${(await portOpen(port)) ? t('info.inUse') : t('info.freePort')}`);
  if (inst) {
    console.log(`\n  ETNA_DATA_ROOT: ${inst.root}`);
    console.log(`  ${t('sum.version')}: ${appPackage(paths(inst.root).current)?.version ?? '?'} (${appPackage(paths(inst.root).current)?.builtAt ?? '?'})`);
    console.log(`  ${PG_SERVICE}: ${await serviceState(PG_SERVICE)}  ·  ETNA: ${(await appHealthy()) ? t('running') : t('notRunning')}`);
  }
}

// ─── [14] Company storage ────────────────────────────────────────────────────

async function listCompanies(inst) {
  useOwnerPassword(inst);
  const client = await ownerClient(dbConfig(inst));
  try {
    // Companies (ERPs with an internal owner) and any ERP other people use.
    const { rows } = await client.query(`
      select w.id, w.name, ws.storage_dir, etna_platform.storage_state(w.id) as state
        from public.erp_workspaces w
        join auth.users u on u.id = w.owner_id
        left join etna_platform.workspace_storage ws on ws.workspace_id = w.id
       where coalesce(u.raw_user_meta_data ->> 'etna_kind', '') = 'erp_container'
          or (select count(*) from public.erp_workspace_members m where m.workspace_id = w.id and m.status = 'active') > 1
       order by lower(w.name)
       limit 200`);
    return rows;
  } finally {
    await client.end().catch(() => {});
  }
}

async function companyStorage(inst) {
  const companies = await listCompanies(inst);
  if (!companies.length) {
    console.log(t('cs.none'));
    return;
  }
  console.log(`\n${ui.bold(t('cs.title'))}`);
  companies.forEach((c, i) => {
    const s = c.state || {};
    const quota = s.quota_bytes ? formatBytes(Number(s.quota_bytes)) : t('cs.unlimited');
    console.log(
      `  [${i + 1}] ${c.name}  ${ui.dim(`${formatBytes(Number(s.used_bytes || 0))} / ${quota}`)}  ${c.storage_dir ?? ui.dim(t('cs.default'))}`
    );
  });
  const pick = await ui.ask(t('cs.which'));
  const company = companies[Number(pick) - 1];
  if (!company) return;
  const action = await ui.choose(t('select'), [
    { key: '1', label: t('cs.assign') },
    ...(company.storage_dir ? [{ key: '2', label: t('cs.toDefault') }] : []),
    { key: '0', label: t('back') },
  ]);
  if (action === '0') return;
  let target = null;
  if (action === '1') {
    target = await pickFolder(t('cs.where'), path.join('ETNAStorage', folderName(company.name)));
    if (!target) return;
    const problem = companyFolderProblem(target, inst.root);
    if (problem) {
      console.log(ui.red(t(problem)));
      return;
    }
  }
  await moveCompanyFiles(inst, company, target);
}

async function moveCompanyFiles(inst, company, target) {
  const env = readEnvFile(paths(inst.root, inst.backupDir).envFile);
  const from = companyLocations(inst.root, company.id, company.storage_dir, env.ETNA_DOCUMENTS_DIR || null);
  const to = companyLocations(inst.root, company.id, target, env.ETNA_DOCUMENTS_DIR || null);
  const sizes = Object.fromEntries(KINDS.map((k) => [k, folderStats(from[k])]));
  const total = KINDS.reduce((n, k) => n + sizes[k].bytes, 0);
  const files = KINDS.reduce((n, k) => n + sizes[k].files, 0);
  console.log(`\n  ${t('cs.plan', { files, size: formatBytes(total) })}`);
  for (const k of KINDS) console.log(`    ${k}: ${from[k]}  →  ${to[k]}`);
  const free = freeSpace(target ?? inst.root);
  if (free !== null && free < total * 1.1 + 512 * 1024 * 1024) {
    console.log(ui.red(t('tooLittleSpace', { free: formatBytes(free), need: formatBytes(total * 1.1) })));
    return;
  }
  if (!(await confirm(t('cs.go')))) return;

  managerLog(inst, `company folder of ${company.id} → ${target ?? 'default'} started`);
  ui.step(t('stopping'));
  await stopEtna(inst);
  ui.stepDone();
  try {
    ui.step(t('cs.copying'));
    for (const k of KINDS) {
      if (!fs.existsSync(from[k]) || sizes[k].files === 0) {
        fs.mkdirSync(to[k], { recursive: true });
        continue;
      }
      const r = await run('robocopy.exe', [from[k], to[k], '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:2', '/NFL', '/NDL', '/NP']);
      if (r.code >= 8) throw new Error(`robocopy ${r.code}`);
      const after = folderStats(to[k]);
      if (after.files < sizes[k].files || after.bytes < sizes[k].bytes) {
        throw new Error(t('move.incomplete', { copied: after.files, total: sizes[k].files }));
      }
    }
    ui.stepDone();
    if (target) {
      await icacls(target, ['/grant', `${SERVICE_USER}:(OI)(CI)M`, '/grant', '*S-1-5-32-544:(OI)(CI)F', '/grant', '*S-1-5-18:(OI)(CI)F']);
    }
    useOwnerPassword(inst);
    const client = await ownerClient(dbConfig(inst));
    try {
      await client.query('select etna_admin.set_workspace_storage_dir($1, $2)', [company.id, target]);
    } finally {
      await client.end().catch(() => {});
    }
    managerLog(inst, `company folder of ${company.id} → ${target ?? 'default'}`);
    console.log(ui.green(t('cs.done', { name: company.name })));
    console.log(ui.yellow(t('cs.oldKept', { dirs: KINDS.filter((k) => sizes[k].files > 0).map((k) => from[k]).join(', ') || '—' })));
  } catch (error) {
    ui.stepFailed();
    console.log(ui.red(t('cs.failed', { error: error.message })));
    managerLog(inst, `company folder move failed: ${error.message}`);
  } finally {
    await start(inst);
  }
}

// ─── [15] Limits ─────────────────────────────────────────────────────────────

async function limits(inst) {
  useOwnerPassword(inst);
  const client = await ownerClient(dbConfig(inst));
  try {
    const { rows } = await client.query(
      'select default_quota_bytes, default_max_upload_bytes, xlsx_max_upload_bytes from etna_platform.settings where id'
    );
    const s = rows[0];
    console.log(`\n  ${t('lim.now', {
      quota: s.default_quota_bytes ? formatBytes(Number(s.default_quota_bytes)) : t('cs.unlimited'),
      upload: formatBytes(Number(s.default_max_upload_bytes)),
      xlsx: formatBytes(Number(s.xlsx_max_upload_bytes)),
    })}`);
    console.log(ui.dim(`  ${t('lim.perCompany')}`));
    if (!(await confirm(t('lim.change')))) return;
    const quota = await ui.ask(t('lim.quota'));
    const upload = await ui.ask(t('lim.upload'));
    const xlsx = await ui.ask(t('lim.xlsx'));
    const MB = 1024 * 1024;
    const quotaBytes = quota.trim() === '' ? null : Math.round(Number(quota) * 1024 * MB);
    const uploadBytes = upload.trim() === '' ? Number(s.default_max_upload_bytes) : Number(upload) * MB;
    const xlsxBytes = xlsx.trim() === '' ? Number(s.xlsx_max_upload_bytes) : Number(xlsx) * MB;
    if ((quotaBytes !== null && !(quotaBytes > 0)) || !Number.isInteger(uploadBytes) || !Number.isInteger(xlsxBytes)) {
      console.log(ui.red(t('lim.invalid')));
      return;
    }
    await client.query('begin');
    await client.query(
      'update etna_platform.settings set default_quota_bytes = $1, default_max_upload_bytes = $2, xlsx_max_upload_bytes = $3, updated_at = now() where id',
      [quotaBytes, uploadBytes, xlsxBytes]
    );
    await client.query('select etna_admin._log($1, null, $2)', [
      'STORAGE_DEFAULTS_CHANGED',
      JSON.stringify({ default_quota_bytes: quotaBytes, default_max_upload_bytes: uploadBytes, xlsx_max_upload_bytes: xlsxBytes, via: 'server-manager' }),
    ]);
    await client.query('commit');
    managerLog(inst, `limits: quota ${quotaBytes ?? 'unlimited'}, upload ${uploadBytes}, xlsx ${xlsxBytes}`);
    console.log(ui.green(t('saved')));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    console.log(ui.red(t('lim.invalid')));
    managerLog(inst, `limits not saved: ${error.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

// ─── Menu ────────────────────────────────────────────────────────────────────

async function chooseLanguage() {
  // Chosen already for this run (ETNA_LANG).
  if (process.env.ETNA_LANG === 'id' || process.env.ETNA_LANG === 'en') {
    setLanguage(process.env.ETNA_LANG);
    const inst = readInstall();
    if (inst && inst.language !== t('code')) {
      try {
        writeInstall({ ...inst, language: t('code') });
      } catch {
        // Not important.
      }
    }
    return;
  }
  const remembered = readInstall()?.language;
  console.log('');
  const pick = await ui.choose('Language / Bahasa:', [
    { key: '1', label: 'English' },
    { key: '2', label: 'Bahasa Indonesia' },
  ], remembered === 'id' ? '2' : '1');
  setLanguage(pick === '2' ? 'id' : 'en');
  const inst = readInstall();
  if (inst && inst.language !== t('code')) {
    try {
      writeInstall({ ...inst, language: t('code') });
    } catch {
      // Not important.
    }
  }
}

// ─── [16] Repair ─────────────────────────────────────────────────────────────

/**
 * Puts back what the installation needs around its data, without touching
 * the data: the Node.js path, the PostgreSQL service, folder permissions, the
 * service account and the scheduled tasks. Then starts ETNA and checks it.
 */
async function repair(inst) {
  const p = paths(inst.root, inst.backupDir);
  console.log(`\n${ui.bold(t('repair.title'))}`);
  console.log(t('repair.intro'));
  const record = { ...inst, node: process.execPath };
  if (!fs.existsSync(path.join(record.pgBin ?? '', 'pg_ctl.exe'))) {
    const found = await findPostgres();
    const major = (v) => Number(String(v ?? '').split('.')[0]);
    if (!found || major(found.version) !== major(inst.pgVersion)) {
      console.log(ui.red(t('repair.pgGone', { version: inst.pgVersion ?? '?' })));
      return;
    }
    record.pgBin = found.bin;
    record.pgVersion = found.version;
  }
  if (!fs.existsSync(path.join(p.pgData, 'PG_VERSION'))) {
    console.log(ui.red(t('repair.noData', { dir: p.pgData })));
    return;
  }
  if (!(await confirm(t('repair.go')))) return;
  try {
    ui.step(t('repair.record'));
    writeInstall(record);
    ui.stepDone();
    if ((await serviceState(PG_SERVICE)) === 'missing') {
      ui.step(t('repair.pgService'));
      await registerService({ bin: record.pgBin, dataDir: p.pgData, name: PG_SERVICE });
      ui.stepDone();
    }
    ui.step(t('do.permissions'));
    await applyAcls(record);
    ui.stepDone();
    ui.step(t('do.tasks'));
    await refreshTasks(record);
    ui.stepDone();
    if (inst.backupEnabled === false) await setTaskEnabled(BACKUP_TASK, false);
  } catch (error) {
    ui.stepFailed();
    managerLog(inst, `repair failed: ${error.message}`);
    throw error;
  }
  managerLog(record, 'repaired');
  await start(record);
  await health(record);
}

// ─── [17] Prepare uninstall ──────────────────────────────────────────────────

/**
 * Takes ETNA off this server but keeps every byte of its data: a last full
 * backup, then the tasks, the service account and the PostgreSQL service are
 * removed. The data folder (database files, documents, backups, settings and
 * keys), Node.js and PostgreSQL stay; the administrator deletes them by hand
 * once the backup is safe elsewhere.
 */
async function prepareUninstall(inst) {
  const p = paths(inst.root, inst.backupDir);
  console.log(`\n${ui.bold(t('uninstall.title'))}`);
  console.log(t('uninstall.removes', { service: PG_SERVICE, tasks: `${TASK_FOLDER}${SERVER_TASK}, ${TASK_FOLDER}${BACKUP_TASK}`, account: SERVICE_USER }));
  console.log(ui.yellow(t('uninstall.keeps', { root: inst.root, backups: p.fullBackups })));
  const word = t('uninstall.word');
  const typed = await ui.ask(t('uninstall.type', { word }));
  if (typed !== word) {
    console.log(t('notConfirmed'));
    return;
  }
  ui.step(t('uninstall.backup'));
  let last;
  try {
    last = await createFullBackup(inst, 'before-uninstall');
    ui.stepDone();
    console.log(`       ${last.name}`);
  } catch (error) {
    ui.stepFailed();
    console.log(ui.red(t('uninstall.noBackup', { error: error.message })));
    return;
  }
  const quiet = async (fn) => {
    try {
      await fn();
    } catch {
      // Reported below by what is still there.
    }
  };
  ui.step(t('stopping'));
  await stopEtna(inst);
  ui.stepDone();
  for (const name of [SERVER_TASK, BACKUP_TASK]) {
    await quiet(() => powershell(`Unregister-ScheduledTask -TaskPath ${psq(TASK_FOLDER)} -TaskName ${psq(name)} -Confirm:$false -ErrorAction SilentlyContinue`));
  }
  await quiet(() => powershell(`Remove-LocalUser -Name ${psq(SERVICE_USER)} -ErrorAction SilentlyContinue`));
  if ((await serviceState(PG_SERVICE)) !== 'missing') {
    await quiet(() => stopService(PG_SERVICE));
    await quiet(() => unregisterService({ bin: inst.pgBin, name: PG_SERVICE }));
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const record = installRecordPath();
  const kept = path.join(path.dirname(record), `install-uninstalled-${stamp}.json`);
  await quiet(() => fs.renameSync(record, kept));
  managerLog(inst, `uninstall prepared (last backup ${last.name})`);
  const left = [];
  if ((await serviceState(PG_SERVICE)) !== 'missing') left.push(PG_SERVICE);
  if (await taskInfo(TASK_FOLDER, SERVER_TASK)) left.push(`${TASK_FOLDER}${SERVER_TASK}`);
  if (left.length) console.log(ui.yellow(t('uninstall.left', { items: left.join(', ') })));
  console.log(ui.green(t('uninstall.done')));
  console.log(t('uninstall.next', { root: inst.root, backup: path.join(p.fullBackups, last.name), record: kept }));
}

const MENU = [
  ['1', 'menu.install', install, false],
  ['2', 'menu.start', start, true],
  ['3', 'menu.stop', stop, true],
  ['4', 'menu.restart', async (inst) => {
    await stop(inst);
    await start(inst);
  }, true],
  ['5', 'menu.health', health, true],
  ['6', 'menu.backup', backupNow, true],
  ['7', 'menu.list', listBackups, true],
  ['8', 'menu.restore', restore, true],
  ['9', 'menu.schedule', schedule, true],
  ['10', 'menu.logs', logs, true],
  ['11', 'menu.update', update, true],
  ['12', 'menu.move', moveStorage, true],
  ['13', 'menu.info', serverInfo, false],
  ['14', 'menu.companies', companyStorage, true],
  ['15', 'menu.limits', limits, true],
  ['16', 'menu.repair', repair, true],
  ['17', 'menu.uninstall', prepareUninstall, true],
];

async function menu() {
  if (!(await isAdmin())) {
    console.log(
      ui.red(
        'Run this from a Command Prompt opened as administrator. / Jalankan dari Command Prompt yang dibuka sebagai administrator.'
      )
    );
    process.exitCode = 1;
    return;
  }
  await chooseLanguage();
  for (;;) {
    const inst = installed();
    console.log('');
    ui.title(t('title'));
    if (inst) {
      const pkg = appPackage(paths(inst.root).current);
      console.log(` ${t('status.installed', { root: inst.root, version: pkg?.version ?? '?', built: (pkg?.builtAt ?? '').slice(0, 10) })}`);
      console.log(` ${t('status.app')}: ${(await appHealthy()) ? ui.green(t('running')) : ui.yellow(t('notRunning'))}   PostgreSQL: ${await serviceState(PG_SERVICE)}`);
      if (fromPackage(inst)) console.log(ui.yellow(` ${t('status.fromPackage')}`));
    } else {
      console.log(` ${t('status.notInstalled')}`);
    }
    ui.line();
    for (const [key, label] of MENU) console.log(` [${key}] ${t(label)}`);
    console.log(` [0] ${t('menu.exit')}`);
    const pick = await ui.ask(`\n${t('select')} `);
    if (pick === '0') {
      ui.close();
      return;
    }
    const item = MENU.find(([key]) => key === pick);
    if (!item) continue;
    const [, , fn, needsInstall] = item;
    if (needsInstall && !inst) {
      console.log(ui.yellow(t('needInstall')));
      await pause();
      continue;
    }
    try {
      await fn(inst);
    } catch (error) {
      console.log(ui.red(`\n${t('error', { error: error instanceof Error ? error.message : String(error) })}`));
      if (inst) managerLog(inst, `error: ${error instanceof Error ? error.message : String(error)}`);
    }
    await pause();
  }
}

/** The nightly task: one full backup, quietly, logged in manager.log. */
async function autoBackup() {
  const inst = readInstall();
  if (!inst) {
    console.error('ETNA is not installed (no install record).');
    process.exitCode = 2;
    return;
  }
  try {
    const made = await createFullBackup(inst, 'auto');
    managerLog(inst, `nightly backup ${made.name} (${formatBytes(made.size)})`);
  } catch (error) {
    managerLog(inst, `nightly backup FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const [command] = process.argv.slice(2);
if (command === 'backup' && process.argv.includes('--auto')) await autoBackup();
else if (!command) await menu();
else {
  console.error('Usage: manager.mjs | manager.mjs backup --auto --root <root>');
  process.exitCode = 2;
}
