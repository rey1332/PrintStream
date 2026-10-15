import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backupName,
  findTool,
  listBackups,
  parseUrl,
  resolveBackup,
  restoreList,
  toPrune,
  upsertPgpass,
} from '../../scripts/db/backup-core.mjs';
import {
  backupAdmins,
  backupNeedsTwoFactor,
  isBackupAdmin,
  runBackupJob,
} from '../../src/server/backup.ts';

test('pgpass: one line per connection, special characters escaped, others kept', () => {
  const target = {
    host: 'localhost',
    port: '3000',
    database: 'etna',
    user: 'etna_owner',
    password: 'p:a\\ss',
  };
  const first = upsertPgpass('other:5432:db:u:x\n', target);
  assert.equal(first.trim().split(/\r?\n/).length, 2);
  assert.match(first, /^localhost:3000:etna:etna_owner:p\\:a\\\\ss$/m);
  const again = upsertPgpass(first, { ...target, password: 'new' });
  assert.equal(again.trim().split(/\r?\n/).length, 2, 'replaced, not added');
  assert.match(again, /etna_owner:new$/m);
  assert.match(again, /^other:5432:db:u:x$/m);
});

test('connection URLs: the password in them is ignored', () => {
  assert.deepEqual(parseUrl('postgres://etna_owner:secret@localhost:3000/etna'), {
    host: 'localhost',
    port: '3000',
    database: 'etna',
    user: 'etna_owner',
  });
});

test('backups are listed newest first; only the newest 7 are kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etna-backup-'));
  try {
    for (let day = 1; day <= 9; day += 1) {
      fs.writeFileSync(
        path.join(dir, backupName(new Date(2026, 9, day, 3, 0, 0), day === 9 ? 'auto' : '')),
        'x'
      );
    }
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a backup');
    const list = listBackups(dir);
    assert.equal(list.length, 9);
    assert.equal(list[0].name, 'etna-20261009-030000-auto.dump');
    assert.equal(list[0].label, 'auto');
    assert.equal(list[1].label, 'manual');
    assert.deepEqual(toPrune(list), ['etna-20261002-030000.dump', 'etna-20261001-030000.dump']);
    // Only file names from the folder; never a path.
    assert.equal(resolveBackup(dir, '../etna-20261001-030000.dump'), null);
    assert.equal(resolveBackup(dir, 'notes.txt'), null);
    assert.equal(
      resolveBackup(dir, 'etna-20261001-030000.dump'),
      path.join(dir, 'etna-20261001-030000.dump')
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a restore leaves the server’s extensions and the schemas alone', () => {
  const toc = [
    ';',
    '; Archive created at 2026-10-02',
    '7; 2615 16408 SCHEMA - extensions etna_owner',
    '7417; 0 0 ACL - SCHEMA extensions etna_owner',
    '8; 2615 16410 SCHEMA - ps_data etna_ddl',
    '9; 0 0 COMMENT - SCHEMA ps_data etna_ddl',
    '5; 3079 16384 EXTENSION - pgcrypto',
    '4321; 0 0 COMMENT - EXTENSION pgcrypto',
    '230; 1259 16500 TABLE public erp_invoices etna_owner',
    '6000; 0 16500 TABLE DATA public erp_invoices etna_owner',
  ].join('\n');
  const kept = restoreList(toc);
  assert.doesNotMatch(kept, /EXTENSION/);
  assert.doesNotMatch(kept, /SCHEMA - extensions/);
  // Nor the schemas, some of which belong to another role (the target has them).
  assert.doesNotMatch(kept, /SCHEMA - ps_data|COMMENT - SCHEMA/);
  assert.match(kept, /ACL - SCHEMA extensions/);
  assert.match(kept, /TABLE public erp_invoices/);
  assert.match(kept, /TABLE DATA public erp_invoices/);
});

test('only the listed administrators use backups, and only after two-factor', () => {
  const env = { ETNA_ADMIN_EMAILS: ' Boss@Shop.test, it@shop.test ,' };
  assert.deepEqual(backupAdmins(env), ['boss@shop.test', 'it@shop.test']);
  // Without an authenticator a password alone is not enough for the whole database.
  assert.equal(
    isBackupAdmin({ email: 'boss@shop.test', aal: 'aal1', nextLevel: 'aal1' }, env),
    false
  );
  assert.equal(
    backupNeedsTwoFactor({ email: 'boss@shop.test', aal: 'aal1', nextLevel: 'aal1' }, env),
    true
  );
  assert.equal(
    backupNeedsTwoFactor({ email: 'boss@shop.test', aal: 'aal2', nextLevel: 'aal2' }, env),
    false
  );
  assert.equal(
    backupNeedsTwoFactor({ email: 'someone@shop.test', aal: 'aal1', nextLevel: 'aal1' }, env),
    false
  );
  assert.equal(
    isBackupAdmin({ email: 'BOSS@shop.test', aal: 'aal2', nextLevel: 'aal2' }, env),
    true
  );
  assert.equal(
    isBackupAdmin({ email: 'boss@shop.test', aal: 'aal1', nextLevel: 'aal2' }, env),
    false
  );
  assert.equal(
    isBackupAdmin({ email: 'someone@shop.test', aal: 'aal1', nextLevel: 'aal1' }, env),
    false
  );
  assert.equal(
    isBackupAdmin({ email: 'boss@shop.test', aal: 'aal2', nextLevel: 'aal2' }, {}),
    false
  );
});

test('one backup or restore at a time: a second request while one runs is turned away', async () => {
  const first = runBackupJob(['list']);
  assert.deepEqual(await runBackupJob(['list']), { ok: false, error: 'busy' });
  assert.equal((await first).ok, true);
  assert.equal((await runBackupJob(['list'])).ok, true, 'free again once the first finished');
});

test('account management uses the same administrators and the same two-factor rule', async () => {
  const { isUserAdmin, userAdminNeedsTwoFactor } = await import('../../src/server/userAdmin.ts');
  const env = { ETNA_ADMIN_EMAILS: 'boss@shop.test' };
  assert.equal(isUserAdmin({ email: 'Boss@Shop.test', aal: 'aal2', nextLevel: 'aal2' }, env), true);
  assert.equal(
    isUserAdmin({ email: 'boss@shop.test', aal: 'aal1', nextLevel: 'aal2' }, env),
    false
  );
  assert.equal(
    isUserAdmin({ email: 'staff@shop.test', aal: 'aal2', nextLevel: 'aal2' }, env),
    false
  );
  assert.equal(
    userAdminNeedsTwoFactor({ email: 'boss@shop.test', aal: 'aal1', nextLevel: 'aal2' }, env),
    true
  );
  assert.equal(
    userAdminNeedsTwoFactor({ email: 'staff@shop.test', aal: 'aal1', nextLevel: 'aal1' }, env),
    false
  );
});

test(
  'on Linux the newest versioned PostgreSQL tools are found first',
  { skip: process.platform === 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etna-pg-'));
    try {
      for (const v of ['16', '18', '9']) {
        fs.mkdirSync(path.join(root, v, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(root, v, 'bin', 'pg_restore'), '');
      }
      fs.mkdirSync(path.join(root, 'extra'));
      assert.equal(
        findTool('pg_restore', { debianRoot: root }),
        path.join(root, '18', 'bin', 'pg_restore')
      );
      // Not in a versioned directory: the PATH is searched as before.
      assert.equal(findTool('etna-no-such-tool', { debianRoot: root }), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
