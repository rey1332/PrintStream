import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, runOnPath, admin, expectError } from './harness.mjs';

let db;
let sa;
let sa2;
let support;
let auditor;

async function openSession(user) {
  const [{ id }] = await admin(
    db,
    `insert into auth.sessions (user_id, token_hash, aal, expires_at, reauthenticated_at)
     values ($1, md5(random()::text), 'aal2', now() + interval '1 day', now()) returning id`,
    [user.id]
  );
  return id;
}

async function makeAdmin(name, role) {
  const user = await createUser(db, name);
  await admin(db, `select etna_admin.grant_platform_admin($1, $2)`, [user.email, role]);
  return { user, sid: await openSession(user) };
}

async function asAdmin(who, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: who.user.id, email: who.user.email, role: 'authenticated', aal: 'aal2', sid: who.sid }),
    ]);
    return (await tx.query(sql, params)).rows;
  });
}

async function asAuthServer(sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role etna_auth');
    return (await tx.query(sql, params)).rows;
  });
}

const dashboard = (who, hours = 24, tz = 'Asia/Jakarta') =>
  asAdmin(who, `select etna_platform.admin_dashboard($1, $2) as d`, [hours, tz]).then((r) => r[0].d);
const grant = (who, ws, email, role, reason = 'Support ticket 42') =>
  asAdmin(who, `select etna_platform.admin_workspace_grant($1, $2, $3, $4) as r`, [ws, email, role, reason]).then((r) => r[0].r);
const removeAccess = (who, ws, userId, reason = 'Ticket closed') =>
  asAdmin(who, `select etna_platform.admin_workspace_remove($1, $2, $3)`, [ws, userId, reason]);
const personalOf = async (user) =>
  (await run(db, user, `select workspace_id from erp_my_workspaces() where is_personal`))[0].workspace_id;
const events = (type, extra = '') =>
  admin(db, `select * from etna_platform.security_events where event_type = $1 ${extra} order by id`, [type]);

before(async () => {
  db = await createDb();
  sa = await makeAdmin('dash-super', 'super_admin');
  sa2 = await makeAdmin('dash-super-two', 'super_admin');
  support = await makeAdmin('dash-support', 'support');
  auditor = await makeAdmin('dash-auditor', 'auditor');
});

test('dashboard: every admin role reads it, nobody else; only 24 h, 7 or 30 days', async () => {
  const outsider = await createUser(db, 'dash-outsider');
  await expectError(run(db, { ...outsider, aal: 'aal2' }, `select etna_platform.admin_dashboard(24, 'UTC')`), /Not allowed|permission denied/);
  await expectError(dashboard(auditor, 12), /24, 168 or 720/);
  for (const who of [sa, support, auditor]) assert.equal((await dashboard(who)).hours, 24);

  const d = await dashboard(auditor, 168, 'Not/AZone');
  assert.equal(d.time_zone, 'UTC', 'an unknown time zone falls back to UTC');
  assert.equal(d.unit, 'day');
  assert.ok(d.series.length >= 7 && d.series.length <= 8);
  assert.ok(d.accounts.total >= 5);
  assert.equal(d.accounts.admins, 4);
  assert.ok(Array.isArray(d.database.migrations));
  assert.ok(d.database.migrations.some((name) => name.endsWith('20261012000014_platform_admin_dashboard.sql')));
  assert.equal(d.terms, null, 'no Terms & Conditions published yet');
});

test('dashboard counts sign-ins, failures by account and IP, and new accounts per hour', async () => {
  const before = await dashboard(auditor);
  const person = await createUser(db, 'dash-person');
  const log = (type, outcome, ip) =>
    asAuthServer(`select etna_platform.log_auth_event($1, $2, $3, $4, null, $5, 'Browser/1.0')`, [type, outcome, person.id, person.email, ip]);
  await log('LOGIN_SUCCEEDED', 'success', '198.51.100.7');
  for (let i = 0; i < 3; i += 1) await log('LOGIN_FAILED', 'failure', '203.0.113.9');
  await log('MFA_CHALLENGE_FAILED', 'failure', '203.0.113.9');

  const after = await dashboard(auditor);
  assert.equal(after.sign_in.succeeded - before.sign_in.succeeded, 1);
  assert.equal(after.sign_in.failed - before.sign_in.failed, 3);
  assert.equal(after.sign_in.mfa_failed - before.sign_in.mfa_failed, 1);
  assert.equal(after.accounts.new - before.accounts.new, 1);
  const account = after.failing_accounts.find((a) => a.email === person.email.toLowerCase());
  assert.equal(account.failures, 4);
  const ip = after.failing_ips.find((a) => a.ip === '203.0.113.9');
  assert.equal(ip.failures, 4);
  assert.equal(ip.accounts, 1);

  const sum = (series, key) => series.reduce((n, p) => n + p[key], 0);
  assert.equal(sum(after.series, 'failed') - sum(before.series, 'failed'), 4);
  assert.equal(sum(after.series, 'new_accounts') - sum(before.series, 'new_accounts'), 1);
  assert.match(after.series.at(-1).t, /^\d{4}-\d{2}-\d{2}T\d{2}:00$/);
});

test('workspace access: super admins only, a reason, a fresh code, never themselves or the Owner', async () => {
  const owner = await createUser(db, 'ws-owner');
  const helper = await createUser(db, 'ws-helper');
  const ws = await personalOf(owner);

  await expectError(grant(support, ws, helper.email, 'finance'), /Not allowed/);
  await expectError(grant(auditor, ws, helper.email, 'finance'), /Not allowed/);
  await expectError(grant(sa, ws, helper.email, 'owner'), /Choose one of the roles/);
  await expectError(grant(sa, ws, helper.email, 'finance', ' '), /reason/);
  await expectError(grant(sa, ws, 'nobody@example.test', 'finance'), /No account/);
  await expectError(grant(sa, ws, sa.user.email, 'admin'), /your own/);
  await expectError(grant(sa, ws, owner.email, 'finance'), /Owner/);

  // Without a code from the last 10 minutes, nothing happens.
  await admin(db, `update auth.sessions set reauthenticated_at = now() - interval '11 minutes' where id = $1`, [sa.sid]);
  await expectError(grant(sa, ws, helper.email, 'finance'), /two-factor code/);
  await admin(db, `update auth.sessions set reauthenticated_at = now() where id = $1`, [sa.sid]);

  assert.equal(await grant(sa, ws, helper.email, 'finance'), 'added');
  assert.equal(await grant(sa, ws, helper.email, 'finance'), 'unchanged');
  const [member] = await admin(db, `select role, status, invited_by from erp_workspace_members where workspace_id = $1 and user_id = $2`, [ws, helper.id]);
  assert.deepEqual(member, { role: 'finance', status: 'active', invited_by: sa.user.id });
  assert.ok((await run(db, helper, `select workspace_id from erp_my_workspaces()`)).some((r) => r.workspace_id === ws));

  assert.equal(await grant(sa, ws, helper.email, 'sales'), 'changed');
  await removeAccess(sa, ws, helper.id);
  await expectError(removeAccess(sa, ws, helper.id), /Not a member/);
  await expectError(removeAccess(sa, ws, owner.id), /Owner|Not a member/);
  assert.equal(await grant(sa, ws, helper.email, 'inventory'), 'added', 'a removed member can be added again');
  await expectError(removeAccess(support, ws, helper.id), /Not allowed/);

  // The client sees each change in its own trail, made by the admin.
  const trail = await admin(db, `select action, actor_id, details from erp_workspace_audit_log
    where workspace_id = $1 and target_user_id = $2 order by created_at, id`, [ws, helper.id]);
  assert.deepEqual(trail.map((r) => r.action), ['member.added', 'member.role_changed', 'member.removed', 'member.added']);
  assert.ok(trail.every((r) => r.actor_id === sa.user.id && r.details.via === 'etna_admin' && r.details.reason));

  // And the security log has them, as admin actions.
  const logged = await admin(db, `select event_type, actor_kind, actor_user_id, target_email, metadata from etna_platform.security_events
    where workspace_id = $1 and target_user_id = $2 order by id`, [ws, helper.id]);
  assert.deepEqual(logged.map((e) => e.event_type),
    ['WORKSPACE_MEMBER_ADDED', 'WORKSPACE_ROLE_CHANGED', 'WORKSPACE_MEMBER_REMOVED', 'WORKSPACE_MEMBER_ADDED']);
  assert.ok(logged.every((e) => e.actor_kind === 'admin' && e.actor_user_id === sa.user.id && e.target_email === helper.email));
  assert.deepEqual([logged[1].metadata.from, logged[1].metadata.to], ['finance', 'sales']);
  assert.equal(logged[0].metadata.reason, 'Support ticket 42');

  // Another super admin may give the first one access.
  assert.equal(await grant(sa2, ws, sa.user.email, 'admin'), 'added');
  // Admins remove their own access themselves (it only takes privileges away).
  await removeAccess(sa, ws, sa.user.id);

  const d = await dashboard(auditor);
  assert.ok(d.access_changes.length > 0);
  assert.ok(d.access_changes.every((e) => /^(ADMIN_ROLE_|WORKSPACE_)/.test(e.event_type)));
  assert.ok(d.admin_actions.every((e) => e.actor_kind === 'admin' || e.actor_kind === 'cli'));
});

test('changes made in the ERP itself are copied to the security log as the member’s own', async () => {
  const owner = await createUser(db, 'self-owner');
  const joiner = await createUser(db, 'self-joiner');
  const ws = await personalOf(owner);
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'sales', 24, '')`, [ws]);
  await run(db, joiner, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  await run(db, owner, `select erp_update_workspace_member_role($1, $2, 'finance', 'promoted')`, [ws, joiner.id]);
  await run(db, joiner, `select erp_remove_workspace_member($1, $2, 'moving on')`, [ws, joiner.id]);

  const logged = await admin(db, `select event_type, actor_kind, actor_user_id, metadata from etna_platform.security_events
    where workspace_id = $1 and target_user_id = $2 order by id`, [ws, joiner.id]);
  assert.deepEqual(logged.map((e) => [e.event_type, e.actor_kind]), [
    ['WORKSPACE_MEMBER_ADDED', 'user'],
    ['WORKSPACE_ROLE_CHANGED', 'user'],
    ['WORKSPACE_MEMBER_LEFT', 'user'],
  ]);
  assert.equal(logged[1].actor_user_id, owner.id);
  assert.equal(logged[1].metadata.reason, 'promoted');
  assert.equal(logged[0].metadata.workspace_name, (await admin(db, `select name from erp_workspaces where id = $1`, [ws]))[0].name);
  // Nothing from the invitation itself (codes, hashes) is copied.
  assert.ok(logged.every((e) => !JSON.stringify(e.metadata).includes(access_code)));
});

test('deleting a created ERP keeps its audit trail, and the deletion is in the security log', async () => {
  const owner = await createUser(db, 'keep-owner');
  const ws = (await run(db, owner, `select erp_create_erp('Kept history') as id`))[0].id;
  const [{ owner_id: container }] = await admin(db, `select owner_id from erp_workspaces where id = $1`, [ws]);
  await run(db, owner, `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'Budi')`, [container, ws]);
  const countRows = async () => ({
    records: (await admin(db, `select count(*)::int as n from erp_audit_log where workspace_id = $1`, [ws]))[0].n,
    trail: (await admin(db, `select count(*)::int as n from erp_workspace_audit_log where workspace_id = $1`, [ws]))[0].n,
  });
  const before = await countRows();
  assert.ok(before.records >= 1 && before.trail >= 1);

  await runOnPath(db, { ...owner, aal: 'aal2' }, '/account/delete-erp', `select erp_delete_erp($1)`, [ws]);
  assert.equal((await admin(db, `select count(*)::int as n from erp_workspaces where id = $1`, [ws]))[0].n, 0);
  assert.equal((await admin(db, `select count(*)::int as n from auth.users where id = $1`, [container]))[0].n, 0);
  const after = await countRows();
  assert.ok(after.records > before.records, 'the deletion of each record is recorded too');
  assert.equal(after.trail, before.trail);
  const [customer] = await admin(db, `select before_data from erp_audit_log where workspace_id = $1 and table_name = 'erp_customers' and action = 'DELETE'`, [ws]);
  assert.equal(customer.before_data.name, 'Budi');

  const [deleted] = await events('ERP_DELETED', `and workspace_id = '${ws}'`);
  assert.equal(deleted.actor_user_id, owner.id);
  assert.equal(deleted.metadata.workspace_name, 'Kept history');
});

test('a reset is in the security log with what it removed', async () => {
  const owner = await createUser(db, 'reset-owner');
  const ws = await personalOf(owner);
  await run(db, owner, `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'Sari')`, [owner.id, ws]);
  await runOnPath(db, { ...owner, aal: 'aal2' }, '/account/reset', `select erp_reset_workspace($1, 'all')`, [ws]);
  const [reset] = await events('ERP_RESET', `and workspace_id = '${ws}'`);
  assert.equal(reset.actor_kind, 'user');
  assert.equal(reset.metadata.scope, 'all');
  assert.equal(reset.metadata.removed.customers, 1);
  assert.ok((await admin(db, `select count(*)::int as n from erp_audit_log where workspace_id = $1`, [ws]))[0].n > 0, 'trail kept');
});

test('rollback removes the dashboard and workspace access, and keeps the history', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000014_platform_admin_dashboard.sql', import.meta.url), 'utf8'));
  const [row] = (await d.query(`select to_regprocedure('etna_platform.admin_dashboard(integer, text)') is null as gone,
    (select count(*)::int from pg_constraint where conrelid = 'public.erp_workspace_audit_log'::regclass and contype = 'f') as fks`)).rows;
  assert.equal(row.gone, true);
  assert.equal(row.fks, 4);
  await d.close();
});

test('platform admins can be given access to more ERPs than the limit; clients cannot', async () => {
  const helper = await makeAdmin('limit-helper', 'support');
  const client = await createUser(db, 'limit-client');
  const clientsWs = [];
  for (let i = 0; i < 4; i += 1) {
    const company = await createUser(db, `limit-company-${i}`);
    clientsWs.push(await personalOf(company));
  }
  for (const ws of clientsWs) assert.equal(await grant(sa, ws, helper.user.email, 'finance'), 'added');
  // The client has its personal ERP plus two more: the limit of three is reached.
  for (const ws of clientsWs.slice(0, 2)) assert.equal(await grant(sa, ws, client.email, 'sales'), 'added');
  await expectError(grant(sa, clientsWs[2], client.email, 'sales'), /maximum of 3 ERPs/);
});
