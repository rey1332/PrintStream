// Where an installed ETNA keeps everything, from one folder: ETNA_DATA_ROOT.
//
//   <root>\app\<version>\  the app versions (the current and the previous one)
//   <root>\app\current     junction to the version that runs
//   <root>\config\         etna.env (settings and keys), pgpass.conf, backup key
//   <root>\postgres\data\  the PostgreSQL cluster (service etna-postgres)
//   <root>\documents\      uploaded files (File → Documents)
//   <root>\backups\        full backups (full\), app versions (app\), in-app dumps
//   <root>\logs\           server and manager logs
//
// The record of the installation (root, ports, accounts) is in
// %ProgramData%\ETNA\install.json, so the manager finds it from anywhere.

import fs from 'node:fs';
import path from 'node:path';

export const PG_SERVICE = 'etna-postgres';
export const SERVICE_USER = 'etna-svc';
export const APP_PORT = 4028;
export const TASK_FOLDER = '\\ETNA\\';
export const SERVER_TASK = 'Server';
export const BACKUP_TASK = 'Backup';
export const DATABASE = 'etna';
export const OWNER = 'etna_owner';

export function paths(root, backupDir = null) {
  const backups = backupDir || path.join(root, 'backups');
  return {
    root,
    app: path.join(root, 'app'),
    current: path.join(root, 'app', 'current'),
    config: path.join(root, 'config'),
    envFile: path.join(root, 'config', 'etna.env'),
    pgpass: path.join(root, 'config', 'pgpass.conf'),
    publicKey: path.join(root, 'config', 'backup-key.pub.pem'),
    privateKey: path.join(root, 'config', 'backup-key.enc.pem'),
    pgConfCopy: path.join(root, 'config', 'postgres'),
    postgres: path.join(root, 'postgres'),
    pgData: path.join(root, 'postgres', 'data'),
    documents: path.join(root, 'documents'),
    backups,
    fullBackups: path.join(backups, 'full'),
    appBackups: path.join(backups, 'app'),
    logs: path.join(root, 'logs'),
    pidFile: path.join(root, 'logs', 'server.pid'),
  };
}

export function installRecordPath(env = process.env) {
  return path.join(env.ProgramData || 'C:\\ProgramData', 'ETNA', 'install.json');
}

export function readInstall(file = installRecordPath()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeInstall(record, file = installRecordPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** A folder name for an app version: etna-<version>-<build time>. */
export function versionFolder(pkg) {
  const safe = (s) => String(s).replace(/[^0-9A-Za-z.+-]/g, '');
  return `etna-${safe(pkg.version)}-${safe(pkg.builtAt).replace(/[:.]/g, '').slice(0, 15)}`;
}

const inside = (child, parent) => {
  const a = path.resolve(child).toLowerCase();
  const b = path.resolve(parent).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};

/**
 * A data folder must be apart from the app it is installed from: never a
 * source folder or a package, never inside one, never around one (its app
 * folder would land among the source files and break "next build").
 */
export function appFolderProblem(root, appDir) {
  const from = path.resolve(appDir);
  const candidates = [from];
  // A package's app folder (with etna-package.json): the package folder counts too.
  if (path.basename(from).toLowerCase() === 'app' && fs.existsSync(path.join(from, 'etna-package.json'))) {
    candidates.push(path.dirname(from));
  }
  if (candidates.some((dir) => inside(root, dir) || inside(dir, root))) return 'root_is_app';
  for (const marker of ['package.json', '.git', 'src', path.join('app', 'etna-package.json')]) {
    if (fs.existsSync(path.join(root, marker))) return 'root_is_app';
  }
  return null;
}

/** Plain checks of a folder chosen for ETNA_DATA_ROOT. Returns a problem key or null. */
export function rootProblem(root) {
  if (!path.isAbsolute(root) || !/^[A-Za-z]:\\/.test(root)) return 'root_not_absolute';
  if (/[%"^&|<>!]/.test(root)) return 'root_bad_chars';
  if (path.parse(root).root === root) return 'root_is_drive';
  const lower = root.toLowerCase();
  if (lower.includes('\\windows') || lower.includes('\\program files')) return 'root_system_folder';
  return null;
}
