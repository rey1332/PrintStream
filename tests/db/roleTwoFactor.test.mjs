import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin } from './harness.mjs';

let db;
const at = (user, aal) => ({ ...user, aal });
const blockedFor = async (user) =>
  (await run(db, user, `select workspace_id, by_role from erp_my_mfa_required_workspaces() order by workspace_id`));
const canRead = async (user, ws) =>
  (await run(db, user, `select erp_can_read($1, 'customers') as ok`, [ws]))[0].ok;

before(async () => {
  db = await createDb();
});

test('a personal ERP used alone does not ask for two-factor', async () => {
  const solo = at(await createUser(db, 'tf-solo'), 'aal1');
  const [{ workspace_id: ws }] = await run(db, solo, `select workspace_id from erp_my_workspaces() where is_personal`);
  assert.equal(await canRead(solo, ws), true);
  await run(db, solo, `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'Walk-in')`, [solo.id, ws]);
  assert.deepEqual(await blockedFor(solo), []);
});

test('once shared, Owner, Admin and Finance need a two-factor session; Sales and Inventory do not', async () => {
  const owner = await createUser(db, 'tf-owner');
  const [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  const join = async (role) => {
    const user = await createUser(db, `tf-${role}`);
    const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`, [ws, role]);
    await run(db, user, `select erp_redeem_workspace_invitation($1)`, [access_code]);
    return user;
  };
  const finance = await join('finance');
  const sales = await join('sales');
  const admin_ = await join('admin');

  for (const user of [owner, finance, admin_]) {
    assert.equal(await canRead(at(user, 'aal1'), ws), false, 'blocked without two-factor');
    assert.equal(await canRead(at(user, 'aal2'), ws), true, 'open with two-factor');
    assert.deepEqual(await blockedFor(at(user, 'aal1')), [{ workspace_id: ws, by_role: true }]);
    assert.deepEqual(await blockedFor(at(user, 'aal2')), []);
  }
  assert.equal(await canRead(at(sales, 'aal1'), ws), true, 'Sales works without two-factor');
  assert.deepEqual(await blockedFor(at(sales, 'aal1')), []);

  const rows = await run(db, at(owner, 'aal1'), `select name from erp_customers where workspace_id = $1`, [ws]);
  assert.deepEqual(rows, [], 'row-level security gives nothing');

  // An ERP that requires two-factor for everyone still does, Sales included.
  await admin(db, `update erp_workspaces set require_mfa = true where id = $1`, [ws]);
  assert.equal(await canRead(at(sales, 'aal1'), ws), false);
  assert.deepEqual(await blockedFor(at(sales, 'aal1')), [{ workspace_id: ws, by_role: false }]);
  await admin(db, `update erp_workspaces set require_mfa = false where id = $1`, [ws]);
});

test('a created ERP asks its Owner for two-factor even before anyone joins', async () => {
  const owner = await createUser(db, 'tf-creator');
  const [{ id: ws }] = await run(db, at(owner, 'aal2'), `select erp_create_erp('Quarry') as id`);
  assert.equal(await canRead(at(owner, 'aal1'), ws), false);
  assert.equal(await canRead(at(owner, 'aal2'), ws), true);
});

test('rollback: only the ERP-wide switch asks for two-factor again', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000022_erp_role_two_factor.sql', import.meta.url), 'utf8'));
  const [{ gone }] = (await d.query(`select to_regprocedure('public.erp_my_mfa_required_workspaces()') is null as gone`)).rows;
  assert.equal(gone, true);
  await d.close();
});
