import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { dataDirs, restoredSettings, sameServerLogins } from '../../scripts/db/pc-move-core.mjs';
import { retargetSettings } from '../../scripts/server/lib/psctl-core.mjs';

// Moving ETNA between PCs (scripts/db/pc-move.mjs): what a .etnabak carries
// from one PC and what stays the new PC's.

test('a PC keeps its documents in storage/ unless the settings say otherwise', () => {
  const app = path.resolve('C:/PrintStream');
  assert.deepEqual(dataDirs({}, app), {
    documents: path.join(app, 'storage', 'documents'),
    companies: path.join(app, 'storage', 'companies'),
  });
  assert.deepEqual(dataDirs({ ETNA_DATA_ROOT: 'D:/ETNA' }, app), {
    documents: path.resolve('D:/ETNA/documents'),
    companies: path.resolve('D:/ETNA/companies'),
  });
  assert.equal(dataDirs({ ETNA_DOCUMENTS_DIR: 'E:/docs' }, app).documents, path.resolve('E:/docs'));
});

test('a restore takes the backup’s keys and settings, this PC’s connections and folders', () => {
  const fromBackup = {
    DATABASE_URL: 'postgres://etna_app:old@localhost:5432/etna',
    MIGRATION_DATABASE_URL: 'postgres://etna_owner@localhost:5432/etna',
    MFA_ENCRYPTION_KEY: 'backup-mfa',
    SESSION_HINT_SECRET: 'backup-hint',
    ETNA_PUBLIC_URL: 'https://printstream.etna.asia',
    TRUST_PROXY: 'cloudflare',
    ETNA_OFFSITE_DIR: 'E:\\old-pc-backups',
    ETNA_OFFSITE_KEY: 'C:\\PrintStream\\storage\\backup-keys\\offsite-key.pub.pem',
    ETNA_BACKUP_DATABASE_URL: 'postgres://etna_owner@localhost:5432/etna',
    ETNA_DATA_ROOT: 'D:\\old',
  };
  const urls = {
    DATABASE_URL: 'postgres://etna_app:n1@localhost:5432/etna_restore',
    AUTH_DATABASE_URL: 'postgres://etna_auth:n2@localhost:5432/etna_restore',
    WORKER_DATABASE_URL: 'postgres://etna_worker:n3@localhost:5432/etna_restore',
  };
  const out = restoredSettings({
    fromBackup,
    current: { ETNA_OFFSITE_DIR: 'F:\\this-pc', MFA_ENCRYPTION_KEY: 'this-pc-mfa' },
    urls,
    ownerUrl: 'postgres://etna_owner@localhost:5432/etna_restore',
    freshKeys: { MFA_ENCRYPTION_KEY: 'fresh', SESSION_HINT_SECRET: 'fresh' },
  });
  // The backup's two-factor key: everyone signs in with their authenticator as before.
  assert.equal(out.MFA_ENCRYPTION_KEY, 'backup-mfa');
  assert.equal(out.SESSION_HINT_SECRET, 'backup-hint');
  assert.equal(out.ETNA_PUBLIC_URL, 'https://printstream.etna.asia');
  assert.equal(out.TRUST_PROXY, 'cloudflare');
  // This PC's: new logins, its owner, its backup folder; the old PC's folders not carried.
  assert.equal(out.DATABASE_URL, urls.DATABASE_URL);
  assert.equal(out.WORKER_DATABASE_URL, urls.WORKER_DATABASE_URL);
  assert.equal(out.MIGRATION_DATABASE_URL, 'postgres://etna_owner@localhost:5432/etna_restore');
  assert.equal(out.ETNA_OFFSITE_DIR, 'F:\\this-pc');
  assert.ok(!('ETNA_OFFSITE_KEY' in out));
  assert.ok(!('ETNA_BACKUP_DATABASE_URL' in out));
  assert.ok(!('ETNA_DATA_ROOT' in out));
});

test('a backup without its settings gets new keys', () => {
  const out = restoredSettings({
    fromBackup: null,
    urls: { DATABASE_URL: 'a', AUTH_DATABASE_URL: 'b', WORKER_DATABASE_URL: 'c' },
    ownerUrl: 'postgres://etna_owner@localhost:5432/etna',
    freshKeys: { MFA_ENCRYPTION_KEY: 'fresh-mfa', SESSION_HINT_SECRET: 'fresh-hint' },
  });
  assert.equal(out.MFA_ENCRYPTION_KEY, 'fresh-mfa');
  assert.equal(out.SESSION_HINT_SECRET, 'fresh-hint');
  assert.equal(out.DATABASE_URL, 'a');
});

test('a PC’s backup restored on a server: the PC’s backup folders do not reach etna.env', () => {
  const current = { DATABASE_URL: 'postgres://etna_app:p1@localhost:5432/etna' };
  const changes = retargetSettings(current, {
    database: 'etna_restore_1',
    fromBackup: {
      MFA_ENCRYPTION_KEY: 'k',
      ETNA_OFFSITE_DIR: 'E:\\backups',
      ETNA_OFFSITE_KEY: 'C:\\key.pem',
      ETNA_BACKUP_DATABASE_URL: 'postgres://etna_owner@localhost/etna',
    },
  });
  assert.equal(changes.MFA_ENCRYPTION_KEY, 'k');
  for (const key of ['ETNA_OFFSITE_DIR', 'ETNA_OFFSITE_KEY', 'ETNA_BACKUP_DATABASE_URL']) assert.ok(!(key in changes), key);
});

test('a restore on a PostgreSQL server this PC already uses keeps its logins (shared by every database there)', () => {
  const current = {
    DATABASE_URL: 'postgres://etna_app:p1@localhost:5432/etna',
    AUTH_DATABASE_URL: 'postgres://etna_auth:p2@localhost:5432/etna',
    WORKER_DATABASE_URL: 'postgres://etna_worker:p3@localhost:5432/etna',
  };
  assert.deepEqual(sameServerLogins(current, 'postgres://etna_owner@localhost:5432/etna_restore'), {
    DATABASE_URL: 'postgres://etna_app:p1@localhost:5432/etna_restore',
    AUTH_DATABASE_URL: 'postgres://etna_auth:p2@localhost:5432/etna_restore',
    WORKER_DATABASE_URL: 'postgres://etna_worker:p3@localhost:5432/etna_restore',
  });
  // A new PC (no logins yet) or another server: new passwords.
  assert.equal(sameServerLogins({}, 'postgres://etna_owner@localhost:5432/etna'), null);
  assert.equal(sameServerLogins(current, 'postgres://etna_owner@localhost:5433/etna'), null);
});
