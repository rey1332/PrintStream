import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';
import { MAX_ERPS_PER_ACCOUNT } from '../../src/lib/workspaces/limits.ts';

let db;

before(async () => {
  db = await createDb();
});

async function ownWorkspace(user) {
  const [{ workspace_id }] = await run(db, user, `select workspace_id from erp_my_workspaces() where is_owner`);
  return workspace_id;
}

async function invite(owner, role = 'sales') {
  const ws = await ownWorkspace(owner);
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`, [ws, role]);
  return { ws, code: access_code };
}

async function redeem(user, code) {
  const [{ r }] = await run(db, user, `select erp_redeem_workspace_invitation($1) as r`, [code]);
  return r;
}

async function quota(user) {
  const [{ q }] = await run(db, user, `select erp_my_workspace_quota() as q`);
  return q;
}

test('the app and the database agree on the limit', async () => {
  const [{ limit }] = await admin(db, `select erp_workspace_limit() as limit`);
  assert.equal(limit, MAX_ERPS_PER_ACCOUNT);
  assert.equal(limit, 3);
});

test('the personal ERP counts; two more can be joined, the fourth is refused', async () => {
  const member = await createUser(db, 'limit-member');
  assert.deepEqual(await quota(member), { used: 1, limit: 3, can_join: true });

  for (const name of ['limit-a', 'limit-b']) {
    const owner = await createUser(db, name);
    const { code } = await invite(owner);
    assert.equal((await redeem(member, code)).ok, true);
  }
  assert.deepEqual(await quota(member), { used: 3, limit: 3, can_join: false });

  const fourth = await createUser(db, 'limit-c');
  const { code, ws } = await invite(fourth);
  assert.deepEqual(await redeem(member, code), { ok: false, error: 'workspace_limit', limit: 3 });

  // Refused before the code is checked: not a failed guess, and the code stays usable.
  const attempts = await admin(db, `select count(*)::int as n from erp_invitation_attempts where user_id = $1 and not succeeded`, [member.id]);
  assert.equal(attempts[0].n, 0);
  const [status] = await run(db, fourth, `select status from erp_list_workspace_invitations($1) where status = 'pending'`, [ws]);
  assert.equal(status.status, 'pending');

  const rows = await run(db, member, `select count(*)::int as n from erp_my_workspaces()`);
  assert.equal(rows[0].n, 3);
});

test('leaving an ERP frees a place', async () => {
  const member = await createUser(db, 'limit-leaver');
  const owners = [];
  for (const name of ['leave-a', 'leave-b']) {
    const owner = await createUser(db, name);
    const { code, ws } = await invite(owner);
    await redeem(member, code);
    owners.push({ owner, ws });
  }
  const { owner, ws } = owners[0];
  await run(db, owner, `select erp_remove_workspace_member($1, $2, 'test')`, [ws, member.id]);
  assert.deepEqual(await quota(member), { used: 2, limit: 3, can_join: true });

  const other = await createUser(db, 'leave-c');
  const { code } = await invite(other);
  assert.equal((await redeem(member, code)).ok, true);
});

test('the membership trigger enforces the limit on any other path', async () => {
  const member = await createUser(db, 'limit-direct');
  const workspaces = [];
  for (const name of ['direct-a', 'direct-b', 'direct-c']) {
    const owner = await createUser(db, name);
    workspaces.push(await ownWorkspace(owner));
  }
  await admin(db, `insert into erp_workspace_members (workspace_id, user_id, role) values ($1, $2, 'sales')`, [workspaces[0], member.id]);
  await admin(db, `insert into erp_workspace_members (workspace_id, user_id, role) values ($1, $2, 'sales')`, [workspaces[1], member.id]);
  await expectError(
    admin(db, `insert into erp_workspace_members (workspace_id, user_id, role) values ($1, $2, 'sales')`, [workspaces[2], member.id]),
    /maximum of 3 ERPs/
  );

  // Re-activating a removed membership counts as joining.
  await admin(db, `update erp_workspace_members set status = 'removed' where workspace_id = $1 and user_id = $2`, [workspaces[1], member.id]);
  await admin(db, `insert into erp_workspace_members (workspace_id, user_id, role) values ($1, $2, 'sales')`, [workspaces[2], member.id]);
  await expectError(
    admin(db, `update erp_workspace_members set status = 'active' where workspace_id = $1 and user_id = $2`, [workspaces[1], member.id]),
    /maximum of 3 ERPs/
  );

  // Changes to an active membership (a new role) are not new joins.
  await admin(db, `update erp_workspace_members set role = 'finance' where workspace_id = $1 and user_id = $2`, [workspaces[2], member.id]);
});

test('rollback restores redemption without the limit', async () => {
  const d = await createDb();
  const rollback = readFileSync(new URL('../../db/rollback/rollback_20261008000000_erp_workspace_limit_documents.sql', import.meta.url), 'utf8');
  await d.exec(rollback);
  const left = await d.query(
    `select count(*)::int as n from pg_proc where proname in ('erp_workspace_limit', 'erp_my_workspace_quota', 'erp_documents_list', 'erp_enforce_workspace_limit')`
  );
  assert.equal(left.rows[0].n, 0);
  assert.equal((await d.query(`select to_regclass('public.erp_documents') as t`)).rows[0].t, null);
  const fn = await d.query(`select prosrc from pg_proc where proname = 'erp_redeem_workspace_invitation'`);
  assert.ok(!fn.rows[0].prosrc.includes('workspace_limit'));
  await d.close();
});
