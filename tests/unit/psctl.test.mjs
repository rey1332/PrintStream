import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
} from '../../scripts/server/lib/psctl-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('connection strings: database swaps, passwords stripped, the same server recognised', () => {
  const url = 'postgres://etna_app:s3cret@db.lan:5433/etna?sslmode=verify-full';
  assert.equal(databaseOf(url), 'etna');
  assert.equal(withDatabase(url, 'etna_restore_20261020_101500'), 'postgres://etna_app:s3cret@db.lan:5433/etna_restore_20261020_101500?sslmode=verify-full');
  assert.throws(() => withDatabase(url, 'x; drop database etna'), /Not a database name/);
  assert.throws(() => withDatabase(url, 'Etna'), /Not a database name/);
  assert.equal(withoutPassword(url), 'postgres://etna_app@db.lan:5433/etna?sslmode=verify-full');
  assert.ok(sameServer('postgres://a@localhost:5432/x', 'postgres://b@127.0.0.1/y'));
  assert.ok(!sameServer('postgres://a@localhost:5432/x', 'postgres://a@localhost:5433/x'));
  assert.ok(!sameServer('postgres://a@db1.lan/x', 'postgres://a@db2.lan/x'));
});

test('a database on another machine needs a checked certificate', () => {
  assert.equal(tlsProblem('postgres://etna_owner@localhost:5432/etna'), null);
  assert.equal(tlsProblem('postgres://etna_owner@[::1]:5432/etna'), null);
  assert.equal(tlsProblem('postgres://etna_owner@db.lan/etna?sslmode=verify-full'), null);
  assert.equal(tlsProblem('postgres://etna_owner@db.lan/etna?sslmode=verify-ca'), null);
  assert.match(tlsProblem('postgres://etna_owner@db.lan/etna'), /sslmode=verify-full/);
  assert.match(tlsProblem('postgres://etna_owner@10.0.0.5/etna?sslmode=require'), /verify-full/);
});

test('pgpass: one line per server and role, any database, special characters escaped', () => {
  const line = pgpassLine('postgres://etna_owner@db.lan:5433/etna', 'a:b\\c');
  assert.equal(line, 'db.lan:5433:*:etna_owner:a\\:b\\\\c');
  const first = upsertPgpassLine('', line);
  assert.equal(first, `${line}\n`);
  // The same server and role again: replaced, not added; another server stays.
  const other = pgpassLine('postgres://etna_owner@localhost/etna', 'x');
  const both = upsertPgpassLine(first, other);
  const again = upsertPgpassLine(both, pgpassLine('postgres://etna_owner@db.lan:5433/other', 'new'));
  assert.deepEqual(again.trim().split('\n'), [other, 'db.lan:5433:*:etna_owner:new']);
});

test('restore plan: replays the backup as far as its migrations, refuses a newer backup', () => {
  const available = ['bootstrap/0000.sql', 'migrations/001.sql', 'migrations/002.sql', 'migrations/003.sql'];
  assert.deepEqual(restorePlan(available, ['bootstrap/0000.sql', 'migrations/001.sql']), {
    ok: true,
    replay: ['bootstrap/0000.sql', 'migrations/001.sql'],
    after: ['migrations/002.sql', 'migrations/003.sql'],
  });
  assert.equal(restorePlan(available, available).after.length, 0);
  const newer = restorePlan(available, [...available, 'migrations/004.sql']);
  assert.equal(newer.ok, false);
  assert.match(newer.reason, /newer ETNA.*004/);
  assert.equal(restorePlan(available, null).ok, false);
  assert.equal(restorePlan(available, []).ok, false);
});

test('retargeting: the app URLs move to the new database; a backup brings its keys, not its connections', () => {
  const current = {
    DATABASE_URL: 'postgres://etna_app:p1@localhost:5432/etna',
    AUTH_DATABASE_URL: 'postgres://etna_auth:p2@localhost:5432/etna',
    WORKER_DATABASE_URL: 'postgres://etna_worker:p3@localhost:5432/etna',
    MFA_ENCRYPTION_KEY: 'here',
    ETNA_DATA_ROOT: '/var/lib/etna',
  };
  assert.deepEqual(retargetSettings(current, { database: 'etna_restore_1' }), {
    DATABASE_URL: 'postgres://etna_app:p1@localhost:5432/etna_restore_1',
    AUTH_DATABASE_URL: 'postgres://etna_auth:p2@localhost:5432/etna_restore_1',
    WORKER_DATABASE_URL: 'postgres://etna_worker:p3@localhost:5432/etna_restore_1',
  });
  const fromBackup = {
    DATABASE_URL: 'postgres://etna_app:old@oldhost/etna',
    MFA_ENCRYPTION_KEY: 'from-backup',
    SESSION_HINT_SECRET: 'hint',
    ETNA_PUBLIC_URL: 'https://erp.example.com',
    ETNA_DATA_ROOT: 'C:\\ETNA\\data',
  };
  const changes = retargetSettings(current, { database: 'etna_restore_1', fromBackup });
  assert.equal(changes.MFA_ENCRYPTION_KEY, 'from-backup');
  assert.equal(changes.SESSION_HINT_SECRET, 'hint');
  assert.equal(changes.ETNA_PUBLIC_URL, 'https://erp.example.com');
  assert.equal(changes.DATABASE_URL, 'postgres://etna_app:p1@localhost:5432/etna_restore_1');
  assert.ok(!('ETNA_DATA_ROOT' in changes), 'the folders stay this server’s');
  // Another server: new logins replace the URLs entirely.
  const urls = { DATABASE_URL: 'postgres://etna_app:n1@db.lan/etna?sslmode=verify-full', AUTH_DATABASE_URL: 'a', WORKER_DATABASE_URL: 'w' };
  assert.equal(retargetSettings(current, { database: 'etna', urls }).DATABASE_URL, urls.DATABASE_URL);
});

test('what a database holds, releases, and the folder inside a release file', () => {
  assert.equal(classifyDatabase({ etna: true, tables: 300 }), 'etna');
  assert.equal(classifyDatabase({ etna: false, tables: 0 }), 'empty');
  assert.equal(classifyDatabase({ etna: false, tables: 2 }), 'foreign');
  assert.equal(previousRelease(['/r/a', '/r/b', '/r/c'], '/r/c'), '/r/b');
  assert.equal(previousRelease(['/r/a', '/r/b'], '/r/a'), '/r/b');
  assert.equal(previousRelease(['/r/a'], '/r/a'), null);
  const dir = path.join(path.sep, 'tmp', 'u');
  const inside = path.join(dir, 'etna-1.2.0', 'deploy', 'linux', 'install.sh');
  assert.equal(releaseRoot(dir, [inside]), path.join(dir, 'etna-1.2.0'));
  assert.equal(releaseRoot(dir, [path.join(dir, 'deploy', 'linux', 'install.sh')]), dir);
  assert.equal(releaseRoot(dir, [inside, path.join(dir, 'other', 'x')]), null);
  assert.match(stamp(new Date(2026, 9, 20, 7, 5, 9)), /^20261020_070509$/);
});

test('doctor: flags readable secrets, missing keys, an unprotected remote database, old backups', () => {
  const good = {
    envFile: { owner: 'root:etna', mode: 0o100640 },
    ctlFile: { owner: 'root:root', mode: 0o100600 },
    ownerPgpass: { owner: 'root:root', mode: 0o100600 },
    settings: {
      MFA_ENCRYPTION_KEY: 'k',
      SESSION_HINT_SECRET: 's',
      DATABASE_URL: 'postgres://etna_app:x@localhost/etna',
      AUTH_DATABASE_URL: 'postgres://etna_auth:x@localhost/etna',
      WORKER_DATABASE_URL: 'postgres://etna_worker:x@localhost/etna',
    },
    ownerUrl: 'postgres://etna_owner@localhost/etna',
    services: { etna: 'active', 'etna-worker': 'active' },
    health: true,
    database: { ok: true, text: 'database etna' },
    pendingMigrations: 0,
    backup: { configured: true, newestAgeHours: 3, copyDir: '/mnt/nas' },
    disks: [{ path: '/', freeRatio: 0.5 }],
  };
  assert.deepEqual(doctorFindings(good).filter((f) => f.level !== 'ok'), []);

  const bad = doctorFindings({
    ...good,
    envFile: { owner: 'root:root', mode: 0o100644 },
    ownerPgpass: { owner: 'root:root', mode: 0o100640 },
    settings: { ...good.settings, MFA_ENCRYPTION_KEY: '', DATABASE_URL: 'postgres://etna_app:x@db.lan/etna' },
    ownerUrl: 'postgres://etna_owner@localhost/etna_restore_1',
    services: { etna: 'failed', 'etna-worker': 'active' },
    backup: { configured: true, newestAgeHours: 50, copyDir: '' },
    disks: [{ path: '/', freeRatio: 0.05 }],
  });
  const text = bad.filter((f) => f.level === 'fail').map((f) => f.text).join('\n');
  assert.match(text, /etna\.env is root:root 644/);
  assert.match(text, /owner\.pgpass is root:root 640/);
  assert.match(text, /MFA_ENCRYPTION_KEY is not set/);
  assert.match(text, /DATABASE_URL: db\.lan is another machine/);
  assert.match(text, /psctl\.env points at database etna_restore_1 but the app at etna/);
  assert.match(text, /etna: failed/);
  assert.match(text, /50 hours old/);
  assert.match(text, /only 5% free/);
  assert.ok(bad.some((f) => f.level === 'warn' && /second place/.test(f.text)));
  assert.ok(doctorFindings({ ...good, backup: { configured: false } }).some((f) => /psctl backup-setup/.test(f.text)));
});

test('psctl: help without root, every other command needs root', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const help = spawnSync(process.execPath, ['scripts/server/psctl.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /psctl restore <file>/);
  const status = spawnSync(process.execPath, ['scripts/server/psctl.mjs', 'status'], { cwd: root, encoding: 'utf8' });
  assert.equal(status.status, 2);
  assert.match(status.stderr, /as root/);
});

test('psctl: the paths match the installer and the systemd units', () => {
  const install = fs.readFileSync(path.join(root, 'deploy', 'linux', 'install.sh'), 'utf8');
  for (const [key, value] of Object.entries({ PREFIX: PATHS.prefix, CONFIG_DIR: PATHS.config, DATA_ROOT: PATHS.dataRoot }))
    assert.match(install, new RegExp(`^${key}=${value}$`, 'm'));
  assert.match(install, /^CTL_FILE=\$CONFIG_DIR\/psctl\.env$/m);
  assert.match(install, /^OWNER_PGPASS=\$CONFIG_DIR\/owner\.pgpass$/m);
  assert.match(fs.readFileSync(path.join(root, 'deploy', 'linux', 'psctl'), 'utf8'), /\/opt\/etna\/current\/scripts\/server\/psctl\.mjs "\$@"/);
  assert.match(fs.readFileSync(path.join(root, 'deploy', 'linux', 'etna-backup.service'), 'utf8'), /^ExecStart=\/usr\/local\/bin\/psctl backup$/m);
  // The owner's password never reaches the app's services.
  for (const unit of ['etna.service', 'etna-worker.service'])
    assert.ok(!fs.readFileSync(path.join(root, 'deploy', 'linux', unit), 'utf8').includes('owner.pgpass'), unit);
});

test('env files on Linux stay LF when updated (systemd, grep and sed read them)', async () => {
  const { updateEnv } = await import('../../scripts/server/lib/envfile.mjs');
  assert.equal(updateEnv('A=1\nB=2\n', { B: '3', C: '4' }), 'A=1\nB=3\nC=4\n');
});

test('owner connection for the tools: the environment first, then what .env.local saved', async () => {
  const { ownerUrl } = await import('../../scripts/db/owner.mjs');
  const saved = { ETNA_BACKUP_DATABASE_URL: 'postgres://etna_owner@localhost:3000/etna' };
  assert.equal(ownerUrl(['ADMIN_DATABASE_URL'], saved), saved.ETNA_BACKUP_DATABASE_URL);
  assert.equal(ownerUrl([], { ...saved, MIGRATION_DATABASE_URL: 'postgres://m@h/etna' }), 'postgres://m@h/etna');
  assert.equal(ownerUrl(['ADMIN_DATABASE_URL'], { ...saved, ADMIN_DATABASE_URL: 'postgres://a@h/etna' }), 'postgres://a@h/etna');
  assert.equal(ownerUrl([], {}), '');
});
