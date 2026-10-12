// Full backups: one .tar.gz per backup in <backups>\full, made with the
// tar.exe that ships with Windows (10 1803+ / Server 2019+). Contents:
//
//   manifest.json        what, when, app version, applied migrations
//   database.dump        pg_dump of the ETNA database (custom format)
//   secrets.sealed       etna.env, sealed with the backup public key (sealed.mjs)
//   backup-key.enc.pem   the private key, encrypted with the admin's passphrase
//   postgres-config\     postgresql.conf and pg_hba.conf of the cluster
//   documents\  logs\    from ETNA_DATA_ROOT
//   app\<version>\       the app that made the backup
//
// Nothing in it is readable without the passphrase except the data itself:
// keep backups where only administrators can read them.

import fs from 'node:fs';
import path from 'node:path';
import { mustRun, run } from './sys.mjs';

export const FORMAT = 'etna-full-backup-1';
// Windows' own tar (bsdtar), never another tar earlier on PATH (Git's GNU tar).
export const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const NAME = /^etna-full-(\d{8})-(\d{6})(?:-([a-z-]+))?\.tar\.gz$/;

const pad = (n) => String(n).padStart(2, '0');
export function fullBackupName(date = new Date(), label = '') {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `etna-full-${stamp}${label ? `-${label}` : ''}.tar.gz`;
}

export function listFullBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => NAME.test(name))
    .map((name) => {
      const [, d, t, label] = name.match(NAME);
      const createdAt = new Date(
        Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)),
        Number(t.slice(0, 2)), Number(t.slice(2, 4)), Number(t.slice(4, 6))
      );
      return { name, file: path.join(dir, name), size: fs.statSync(path.join(dir, name)).size, createdAt, label: label || 'manual' };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** Backups to delete: daily ones beyond `keep`, any other kind beyond 10 of that kind. */
export function backupsToPrune(backups, keep) {
  const seen = new Map();
  const out = [];
  for (const b of backups) {
    const n = (seen.get(b.label) ?? 0) + 1;
    seen.set(b.label, n);
    if (n > (b.label === 'auto' ? keep : 10)) out.push(b.name);
  }
  return out;
}

/**
 * Writes the archive. `parts` lists what goes in: staged files (made by the
 * caller in `staging`) and folders relative to the data root.
 */
export async function writeArchive({ file, staging, stagedNames, root, rootFolders }) {
  const partial = `${file}.partial`;
  const args = ['-czf', partial, '-C', staging, ...stagedNames];
  const present = rootFolders.filter((f) => fs.existsSync(path.join(root, f)));
  if (present.length) args.push('-C', root, ...present);
  const r = await run(TAR, args);
  if (r.code !== 0) {
    fs.rmSync(partial, { force: true });
    throw new Error(`tar failed: ${r.stderr.trim().split(/\r?\n/).slice(-2).join(' ')}`);
  }
  fs.renameSync(partial, file);
}

export async function readManifest(file) {
  const r = await run(TAR, ['-xzOf', file, 'manifest.json']);
  if (r.code !== 0) throw new Error('This file is not an ETNA full backup (no manifest).');
  const manifest = JSON.parse(r.stdout);
  if (manifest.format !== FORMAT) throw new Error(`Unknown backup format: ${manifest.format}`);
  return manifest;
}

export async function readMember(file, member) {
  const r = await run(TAR, ['-xzOf', file, member]);
  if (r.code !== 0) throw new Error(`${member} is missing from the backup`);
  return r.stdout;
}

export async function extractArchive(file, dest, members = []) {
  fs.mkdirSync(dest, { recursive: true });
  await mustRun(TAR, ['-xzf', file, '-C', dest, ...members]);
}

/**
 * Whether this app can restore a backup: it must know every migration the
 * backup's database has (a newer backup needs the newer app first).
 */
export function migrationGap(backupMigrations, appMigrations) {
  const known = new Set(appMigrations);
  return backupMigrations.filter((m) => !known.has(m));
}
