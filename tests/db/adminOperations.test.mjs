import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let sa;
let support;
let auditor;

async function openSession(user, { reauthenticated = false } = {}) {
  const [{ id }] = await admin(db,
    `insert into auth.sessions (user_id, token_hash, aal, expires_at, reauthenticated_at)
     values ($1, md5(random()::text), 'aal2', now() + interval '1 day', case when $2 then now() end) returning id`,
    [user.id, reauthenticated]);
  return id;
}

// As the app runs an admin request: role authenticated, claims with the session id.
async function as(who, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: who.user.id, email: who.user.email, role: 'authenticated', aal: 'aal2', sid: who.sid }),
    ]);
    return (await tx.query(sql, params)).rows;
  });
}

async function adminOf(name, role, fresh = true) {
  const user = await createUser(db, name);
  await admin(db, `select etna_admin.grant_platform_admin($1, $2)`, [user.email, role]);
  return { user, sid: await openSession(user, { reauthenticated: fresh }) };
}

const token = () => randomBytes(32).toString('hex');

before(async () => {
  db = await createDb();
  sa = await adminOf('ops-sa', 'super_admin');
  support = await adminOf('ops-support', 'support');
  auditor = await adminOf('ops-auditor', 'auditor');
});

test('a new client company: ERP with its industry, a new Owner account with an invitation link', async () => {
  const [{ r }] = await as(sa, `select etna_platform.admin_create_company('PT Batu Jaya', 'quarry', 'owner@batujaya.test', 'Budi', $1, 'New client') as r`, [token()]);
  assert.equal(r.new_user, true);
  assert.ok(r.expires_at, 'an invitation link was made');
  const [w] = await admin(db, `select name, industry, modules, created_by from erp_workspaces where id = $1`, [r.workspace_id]);
  assert.deepEqual([w.name, w.industry, w.modules, w.created_by], ['PT Batu Jaya', 'quarry', ['weighbridge', 'production', 'equipment'], r.user_id]);
  const members = await admin(db, `select user_id, role from erp_workspace_members where workspace_id = $1 and status = 'active'`, [r.workspace_id]);
  assert.deepEqual(members, [{ user_id: r.user_id, role: 'owner' }]);
  const [event] = await admin(db, `select event_type, workspace_id from etna_platform.security_events where event_type = 'COMPANY_CREATED'`);
  assert.equal(event.workspace_id, r.workspace_id);
  // The Owner sees it among their ERPs.
  const owner = { id: r.user_id, email: 'owner@batujaya.test' };
  const mine = await run(db, owner, `select name from erp_my_workspaces() order by name`);
  assert.ok(mine.some((x) => x.name === 'PT Batu Jaya'));
});

test('an existing account can own a new company within its ERP limit; never the admin themselves', async () => {
  const person = await createUser(db, 'ops-existing');
  const [{ r }] = await as(sa, `select etna_platform.admin_create_company('CV Dagang', 'trading', $1, '', null, 'Second company') as r`, [person.email]);
  assert.equal(r.new_user, false);
  await as(sa, `select etna_platform.admin_create_company('CV Tiga', 'general', $1, '', null, 'Third') as r`, [person.email]);
  await expectError(as(sa, `select etna_platform.admin_create_company('CV Empat', 'general', $1, '', null, 'Fourth')`, [person.email]), /maximum of 3 ERPs/);
  await expectError(as(sa, `select etna_platform.admin_create_company('Mine', 'general', $1, '', null, 'For me')`, [sa.user.email]), /yourself|own account|Not allowed|self/i);

  // A higher limit for this account lets it have more.
  await as(sa, `select etna_platform.admin_set_account_limit($1, 5, 'Group of companies')`, [person.id]);
  const [{ l }] = await as(auditor, `select etna_platform.admin_account_limit($1) as l`, [person.id]);
  assert.deepEqual([l.limit, l.default, l.custom, l.used], [5, 3, true, 3]);
  await as(sa, `select etna_platform.admin_create_company('CV Empat', 'general', $1, '', null, 'Fourth')`, [person.email]);
  const [{ q }] = await run(db, person, `select erp_my_workspace_quota() as q`);
  assert.deepEqual([q.used, q.limit, q.can_join], [4, 5, true]);
  await as(sa, `select etna_platform.admin_set_account_limit($1, null, 'Back to normal')`, [person.id]);
  const [{ q: back }] = await run(db, person, `select erp_my_workspace_quota() as q`);
  assert.deepEqual([back.limit, back.can_join], [3, false]);
});

test('only a super admin with a fresh code creates companies, changes modules and limits', async () => {
  const stale = await adminOf('ops-stale', 'super_admin', false);
  await expectError(as(stale, `select etna_platform.admin_create_company('X', 'general', 'x@x.test', '', $1, 'reason')`, [token()]), /two-factor code/);
  await expectError(as(support, `select etna_platform.admin_create_company('X', 'general', 'x@x.test', '', $1, 'reason')`, [token()]), /Not allowed/);
  await expectError(as(sa, `select etna_platform.admin_create_company('X', 'casino', 'x@x.test', '', $1, 'reason')`, [token()]), /Unknown industry/);
  await expectError(as(sa, `select etna_platform.admin_create_company('X', 'general', 'x@x.test', '', $1, '')`, [token()]), /Give a reason/);
  const plain = await createUser(db, 'ops-plain');
  await expectError(run(db, plain, `select etna_platform.admin_create_company('X', 'general', 'x@x.test', '', 'h', 'r')`), /Not allowed|permission denied/);
});

test('usage and modules of an ERP', async () => {
  const [{ r }] = await as(sa, `select etna_platform.admin_create_company('PT Usage', 'general', 'usage@x.test', '', $1, 'Test') as r`, [token()]);
  const ws = r.workspace_id;
  const [{ u }] = await as(auditor, `select etna_platform.admin_workspace_usage($1) as u`, [ws]);
  assert.equal(u.industry, 'general');
  assert.equal(u.counts.customers, 0);
  assert.equal(u.members, 1);
  await expectError(as(support, `select etna_platform.admin_set_workspace_modules($1, 'quarry', null, 'Client asked')`, [ws]), /Not allowed/);
  await as(sa, `select etna_platform.admin_set_workspace_modules($1, 'quarry', array['weighbridge'], 'Client asked')`, [ws]);
  const [w] = await admin(db, `select industry, modules from erp_workspaces where id = $1`, [ws]);
  assert.deepEqual([w.industry, w.modules], ['quarry', ['weighbridge']]);
});

test('announcements reach everyone or one ERP, between their times, until cancelled', async () => {
  const member = await createUser(db, 'ops-member');
  const [{ workspace_id: ws }] = await run(db, member, `select workspace_id from erp_my_workspaces() where is_personal`);
  const other = await createUser(db, 'ops-other');
  const [{ id: all }] = await as(support, `select etna_platform.admin_save_announcement('{"message":"Maintenance tonight 22:00","level":"maintenance"}'::jsonb) as id`);
  await as(support, `select etna_platform.admin_save_announcement($1::jsonb)`, [JSON.stringify({ message: 'Your ERP only', workspace_id: ws })]);
  await as(support, `select etna_platform.admin_save_announcement('{"message":"Later","starts_at":"2999-01-01T00:00:00Z"}'::jsonb)`);
  assert.deepEqual((await run(db, member, `select message from erp_my_announcements()`)).map((x) => x.message), ['Maintenance tonight 22:00', 'Your ERP only']);
  assert.deepEqual((await run(db, other, `select message from erp_my_announcements()`)).map((x) => x.message), ['Maintenance tonight 22:00']);
  await expectError(as(auditor, `select etna_platform.admin_save_announcement('{"message":"x"}'::jsonb)`), /Not allowed/);
  await expectError(as(support, `select etna_platform.admin_save_announcement('{"message":""}'::jsonb)`), /Invalid announcement/);
  await as(support, `select etna_platform.admin_cancel_announcement($1)`, [all]);
  assert.deepEqual((await run(db, other, `select message from erp_my_announcements()`)), []);
  const listed = await as(auditor, `select state from etna_platform.admin_announcements() order by created_at`);
  assert.deepEqual(listed.map((x) => x.state), ['cancelled', 'active', 'scheduled']);
});

test('server operations are authorised by role and logged', async () => {
  await expectError(as(support, `select etna_platform.admin_authorize('BACKUP_STARTED', '{}'::jsonb)`), /Not allowed/);
  assert.equal((await as(sa, `select etna_platform.admin_authorize('BACKUP_STARTED', '{}'::jsonb) as r`))[0].r, 'super_admin');
  assert.equal((await as(auditor, `select etna_platform.admin_authorize('ADMIN_EXPORT', '{"kind":"users","rows":3}'::jsonb) as r`))[0].r, 'auditor');
  await expectError(as(sa, `select etna_platform.admin_authorize('DROP_EVERYTHING', '{}'::jsonb)`), /Unknown operation/);
  const events = await admin(db, `select event_type, metadata from etna_platform.security_events where event_type in ('BACKUP_STARTED', 'ADMIN_EXPORT') order by id`);
  assert.deepEqual(events.map((e) => e.event_type), ['BACKUP_STARTED', 'ADMIN_EXPORT']);
  assert.equal(events[1].metadata.kind, 'users');
});

test('rollback removes the operations and per-account limits', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000028_platform_admin_operations.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select to_regclass('etna_platform.announcements') is null as gone,
    position('erp__workspace_limit_for' in pg_get_functiondef('public.erp_create_erp(text)'::regprocedure)) = 0 as restored`);
  assert.deepEqual(rows[0], { gone: true, restored: true });
  await d.close();
});
