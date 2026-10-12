import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let sa;
let sa2;
let officer;
let support;
let auditor;

async function openSession(user, { reauthenticated = true } = {}) {
  const [{ id }] = await admin(db,
    `insert into auth.sessions (user_id, token_hash, aal, expires_at, reauthenticated_at)
     values ($1, md5(random()::text), 'aal2', now() + interval '1 day', case when $2 then now() end) returning id`,
    [user.id, reauthenticated]);
  return id;
}

// As the app runs a request: role authenticated, claims with the session id.
async function as(who, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who.user.id]);
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
const company = async (name, ownerEmail) =>
  (await as(sa, `select etna_platform.admin_create_company($1, 'general', $2, '', $3, 'Test') as r`, [name, ownerEmail, token()]))[0].r;

before(async () => {
  db = await createDb();
  sa = await adminOf('gov-sa', 'super_admin');
  sa2 = await adminOf('gov-sa2', 'super_admin');
  officer = await adminOf('gov-officer', 'security_officer');
  support = await adminOf('gov-support', 'support');
  auditor = await adminOf('gov-auditor', 'auditor');
});

test('the security officer reads like an auditor, sets holds and bounds, and acts on no account', async () => {
  const rows = await as(officer, `select * from etna_platform.admin_list_users(null, 'all', 10)`);
  assert.ok(rows.length > 0);
  const person = await createUser(db, 'gov-person');
  await expectError(as(officer, `select etna_platform.admin_disable_user($1, 'reason')`, [person.id]), /Not allowed/);
  await as(officer, `select etna_platform.admin_set_retention_policy('data_access', 90, 730, 400)`);
  await expectError(as(auditor, `select etna_platform.admin_set_retention_policy('data_access', 90, 730, 400)`), /Not allowed/);
  await expectError(as(officer, `select etna_platform.admin_set_retention_policy('data_access', 5, 730, 400)`), /check constraint|violates/);
  await expectError(as(sa, `select etna_platform.admin_set_legal_hold(gen_random_uuid(), 'Court request 2026/1', null)`), /Not allowed/);
  // Role management knows the new role.
  const other = await createUser(db, 'gov-new-officer');
  await as(sa, `select etna_platform.admin_set_role($1, 'security_officer')`, [other.email]);
  assert.equal((await admin(db, `select role from etna_platform.admins where user_id = $1`, [other.id]))[0].role, 'security_officer');
});

test('a staff session gives a super admin the Owner\'s rights for a limited time, visibly', async () => {
  const owner = await createUser(db, 'gov-ws-owner');
  const r = await company('PT Dukungan', owner.email);
  const ws = r.workspace_id;
  await admin(db, `insert into erp_customers (user_id, workspace_id, name) values ((select owner_id from erp_workspaces where id = $1), $1, 'PT Pelanggan')`, [ws]);
  // Before: nothing.
  assert.equal((await as(sa, `select erp_workspace_role($1) as r`, [ws]))[0].r, null);
  assert.equal((await as(sa, `select count(*)::int n from erp_customers where workspace_id = $1`, [ws]))[0].n, 0);
  await expectError(as(support, `select etna_platform.admin_start_staff_access($1, 'Customer cannot post invoices', 'T-100', 2)`, [ws]), /Not allowed/);
  await expectError(as(sa, `select etna_platform.admin_start_staff_access($1, 'short', 'T-100', 2)`, [ws]), /reason/);
  await expectError(as(sa, `select etna_platform.admin_start_staff_access($1, 'Customer cannot post invoices', '', 2)`, [ws]), /ticket/);
  await expectError(as(sa, `select etna_platform.admin_start_staff_access($1, 'Customer cannot post invoices', 'T-100', 9)`, [ws]), /1 to 8 hours/);
  const stale = await adminOf('gov-stale', 'super_admin', false);
  await expectError(as(stale, `select etna_platform.admin_start_staff_access($1, 'Customer cannot post invoices', 'T-100', 2)`, [ws]), /two-factor code/);

  const [{ s }] = await as(sa, `select etna_platform.admin_start_staff_access($1, 'Customer cannot post invoices', 'T-100', 2) as s`, [ws]);
  assert.equal(s.owner_email, owner.email);
  assert.equal((await as(sa, `select erp_workspace_role($1) as r`, [ws]))[0].r, 'owner');
  assert.equal((await as(sa, `select count(*)::int n from erp_customers where workspace_id = $1`, [ws]))[0].n, 1);
  const listed = await as(sa, `select role, is_owner from erp_my_workspaces() where workspace_id = $1`, [ws]);
  assert.deepEqual(listed, [{ role: 'owner', is_owner: true }]);
  const [access] = await as(sa, `select staff_session_until, permissions from erp_my_workspace_access() where workspace_id = $1`, [ws]);
  assert.ok(access.staff_session_until);
  assert.ok(access.permissions.includes('roles.manage'));
  // Owner-level actions work, e.g. inviting an Admin.
  await as(sa, `select * from erp_create_workspace_invitation($1, 'admin', 24, '')`, [ws]);
  // The customer sees it, and so does the security log.
  const trail = await admin(db, `select action, details ->> 'via' as via from erp_workspace_audit_log where workspace_id = $1 and action like 'staff.%'`, [ws]);
  assert.deepEqual(trail, [{ action: 'staff.access_started', via: 'etna_admin' }]);
  assert.equal((await admin(db, `select count(*)::int n from etna_platform.security_events where event_type = 'STAFF_ACCESS_STARTED' and workspace_id = $1`, [ws]))[0].n, 1);
  // Another admin does not get in through someone else's session.
  assert.equal((await as(sa2, `select erp_workspace_role($1) as r`, [ws]))[0].r, null);

  // It ends early on request, and by itself when time is up.
  await as(sa, `select etna_platform.admin_end_staff_access($1)`, [s.session_id]);
  assert.equal((await as(sa, `select erp_workspace_role($1) as r`, [ws]))[0].r, null);
  const [{ s: s2 }] = await as(sa, `select etna_platform.admin_start_staff_access($1, 'Second look at invoices', 'T-101', 1) as s`, [ws]);
  await admin(db, `update etna_platform.staff_access_sessions set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 minute' where id = $1`, [s2.session_id]);
  assert.equal((await as(sa, `select erp_workspace_role($1) as r`, [ws]))[0].r, null);
  // A staff session ends if the admin loses the super admin role.
  const [{ s: s3 }] = await as(sa2, `select etna_platform.admin_start_staff_access($1, 'Third look at invoices', 'T-102', 1) as s`, [ws]);
  assert.ok(s3.session_id);
  await admin(db, `update etna_platform.admins set role = 'support' where user_id = $1`, [sa2.user.id]);
  assert.equal((await as(sa2, `select erp_workspace_role($1) as r`, [ws]))[0].r, null);
  await admin(db, `update etna_platform.admins set role = 'super_admin' where user_id = $1`, [sa2.user.id]);
  const sessions = await as(auditor, `select live from etna_platform.admin_staff_access_sessions($1)`, [ws]);
  assert.equal(sessions.length, 3);
});

test('retention: ETNA sets bounds, the Owner chooses within them, holds stop purges', async () => {
  const owner = await createUser(db, 'gov-ret-owner');
  const [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  const before = await run(db, owner, `select log_type, effective_days from erp_workspace_retention($1) order by log_type`, [ws]);
  assert.deepEqual(before.find((r) => r.log_type === 'run_history').effective_days, 180);
  await run(db, owner, `select erp_set_workspace_retention($1, 'run_history', 60)`, [ws]);
  await expectError(run(db, owner, `select erp_set_workspace_retention($1, 'run_history', 10)`, [ws]), /Choose between/);
  await expectError(run(db, owner, `select erp_set_workspace_retention($1, 'run_history', 9999)`, [ws]), /Choose between/);
  await expectError(run(db, { ...owner, aal: 'aal1' }, `select erp_set_workspace_retention($1, 'run_history', 60)`, [ws]), /Two-factor|not allowed/);
  const stranger = await createUser(db, 'gov-ret-stranger');
  await expectError(run(db, stranger, `select erp_set_workspace_retention($1, 'run_history', 60)`, [ws]), /not allowed/);
  assert.equal((await admin(db, `select etna_platform.effective_retention_days($1, 'run_history') d`, [ws]))[0].d, 60);

  // Old audit entries go; on legal hold they stay.
  await admin(db, `insert into erp_workspace_audit_log (workspace_id, actor_id, action, created_at) values ($1, $2, 'settings.changed', now() - interval '3 years')`, [ws, owner.id]);
  await admin(db, `insert into etna_platform.workspace_retention (workspace_id, log_type, days) values ($1, 'workspace_audit', 365)`, [ws]);
  const [{ id: hold }] = await as(officer, `select etna_platform.admin_set_legal_hold($1, 'Dispute with supplier 2026', null) as id`, [ws]);
  await admin(db, `select etna_platform.purge_by_retention()`);
  assert.equal((await admin(db, `select count(*)::int n from erp_workspace_audit_log where workspace_id = $1 and created_at < now() - interval '2 years'`, [ws]))[0].n, 1);
  await as(officer, `select etna_platform.admin_release_legal_hold($1, 'Dispute settled')`, [hold]);
  const [{ r }] = await admin(db, `select etna_platform.purge_by_retention() r`);
  assert.ok(r.workspace_audit >= 1);
  assert.equal((await admin(db, `select count(*)::int n from erp_workspace_audit_log where workspace_id = $1 and created_at < now() - interval '2 years'`, [ws]))[0].n, 0);
  assert.equal((await admin(db, `select count(*)::int n from etna_platform.security_events where event_type in ('LEGAL_HOLD_SET', 'LEGAL_HOLD_RELEASED', 'RETENTION_PURGED', 'WORKSPACE_RETENTION_CHANGED')`))[0].n >= 4, true);
});

test('termination: export period, a second person confirms, the records go and the trails stay', async () => {
  const person = await createUser(db, 'gov-personal');
  const [{ workspace_id: personalWs }] = await run(db, person, `select workspace_id from erp_my_workspaces() where is_personal`);
  await expectError(as(sa, `select etna_platform.admin_terminate_workspace($1, 'Contract ended in October', 30)`, [personalWs]), /company ERP/);

  const owner = await createUser(db, 'gov-term-owner');
  const r = await company('PT Selesai', owner.email);
  const ws = r.workspace_id;
  const internal = (await admin(db, `select owner_id from erp_workspaces where id = $1`, [ws]))[0].owner_id;
  await admin(db, `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'PT Pelanggan')`, [internal, ws]);
  await admin(db, `insert into erp_products (user_id, workspace_id, name, sku, unit_price, cost_price) values ($1, $2, 'Batu split', 'BS-1', 100, 60)`, [internal, ws]).catch(() => {});
  const [{ t }] = await as(sa, `select etna_platform.admin_terminate_workspace($1, 'Contract ended in October', 30) as t`, [ws]);
  assert.equal(t.owner_email, owner.email);
  assert.equal((await run(db, owner, `select erp_my_termination($1) as t`, [ws]))[0].t.state, 'export_available');
  // Suspended: nobody reads it any more through the app.
  assert.equal((await run(db, owner, `select count(*)::int n from erp_customers where workspace_id = $1`, [ws]))[0].n, 0);
  await expectError(as(officer, `select etna_platform.admin_confirm_termination($1, 'PT Selesai')`, [ws]), /export period runs/);
  await admin(db, `update etna_platform.workspace_terminations set export_until = now() - interval '1 minute' where workspace_id = $1`, [ws]);
  await expectError(as(sa, `select etna_platform.admin_confirm_termination($1, 'PT Selesai')`, [ws]), /Not allowed/);
  await expectError(as(officer, `select etna_platform.admin_confirm_termination($1, 'Wrong name')`, [ws]), /name to confirm/);
  await expectError(admin(db, `select etna_platform.run_workspace_deletion($1)`, [ws]), /not been confirmed/);
  await as(officer, `select etna_platform.admin_confirm_termination($1, 'PT Selesai')`, [ws]);
  const [{ summary }] = await admin(db, `select etna_platform.run_workspace_deletion($1) as summary`, [ws]);
  assert.equal(summary.erp_customers, 1);
  assert.equal((await admin(db, `select count(*)::int n from erp_customers where workspace_id = $1`, [ws]))[0].n, 0);
  assert.equal((await admin(db, `select count(*)::int n from erp_workspace_members where workspace_id = $1 and status = 'active'`, [ws]))[0].n, 0);
  assert.ok((await admin(db, `select count(*)::int n from erp_workspace_audit_log where workspace_id = $1`, [ws]))[0].n > 0, 'the trail stays');
  const [{ d }] = await as(auditor, `select etna_platform.admin_workspace_termination($1) as d`, [ws]);
  assert.equal(d.state, 'deleted');
  assert.equal((await admin(db, `select count(*)::int n from etna_platform.security_events where event_type = 'WORKSPACE_DATA_DELETED' and workspace_id = $1`, [ws]))[0].n, 1);
});

test('rollback removes governance and restores the three admin roles', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000032_platform_governance.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select to_regclass('etna_platform.staff_access_sessions') is null as gone,
    position('staff' in pg_get_functiondef('public.erp_workspace_role(uuid)'::regprocedure)) = 0 as role_back,
    pg_get_constraintdef((select oid from pg_constraint where conname = 'admins_role_check')) not like '%security_officer%' as roles_back`);
  assert.deepEqual(rows[0], { gone: true, role_back: true, roles_back: true });
  await d.close();
});
