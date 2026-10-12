import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listMigrations, plan } from '../../scripts/db/migrator.mjs';

const migrations = listMigrations().filter((m) => m.name.startsWith('migrations/'));
const file = (m) => m.name.slice('migrations/'.length);

test('migration names are a 14-digit timestamp and a lower-case name, all distinct', () => {
  const stamps = new Set();
  for (const m of migrations) {
    assert.match(file(m), /^\d{14}_[a-z0-9_]+\.sql$/, file(m));
    const stamp = file(m).slice(0, 14);
    assert.ok(!stamps.has(stamp), `two migrations share ${stamp}`);
    stamps.add(stamp);
  }
});

test('every migration since rollbacks were introduced has one', () => {
  for (const m of migrations.filter((x) => file(x) >= '20260927000000')) {
    assert.ok(fs.existsSync(new URL(`../../db/rollback/rollback_${file(m)}`, import.meta.url)), `rollback for ${file(m)}`);
  }
});

test('the runner refuses pending files that sort before an applied one', () => {
  const applied = [
    { name: 'bootstrap/0000_postgres_bootstrap.sql', checksum: 'a' },
    { name: 'migrations/20261005000000_b.sql', checksum: 'b' },
  ];
  const files = [
    { name: 'bootstrap/0000_postgres_bootstrap.sql', checksum: 'a' },
    { name: 'migrations/20261003000000_late_arrival.sql', checksum: 'x' },
    { name: 'migrations/20261005000000_b.sql', checksum: 'b' },
    { name: 'migrations/20261006000000_next.sql', checksum: 'c' },
  ];
  const result = plan(files, applied);
  assert.deepEqual(result.pending.map((m) => m.name), ['migrations/20261003000000_late_arrival.sql', 'migrations/20261006000000_next.sql']);
  assert.deepEqual(result.outOfOrder.map((m) => m.name), ['migrations/20261003000000_late_arrival.sql']);
  assert.equal(result.lastApplied, 'migrations/20261005000000_b.sql');

  // A fresh database has nothing applied: every file is in order.
  assert.deepEqual(plan(files, []).outOfOrder, []);
});
