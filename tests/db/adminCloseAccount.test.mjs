import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let sa;
let sa2;
let support;
let auditor;

async function openSession(user, { reauthenticated = true } = {}) {
  const [{ id }] = await admin(db,
    `insert into auth.sessions (user_id, token_hash, aal, expires_at, reauthenticated_at)
     values ($1, md5(random()::text), 'aal2', now() + interval '1 day', case when $2 then now() end) returning id`,
    [user.id, reauthenticated]);
  return id;
}

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
const close = (who, user, reason = 'Left the company', confirm = user.email) =>
  as(who, `select etna_platform.admin_close_account($1, $2, $3) as r`, [user.id, reason, confirm]);
const company = async (name, ownerEmail) =>
  (await as(sa, `select etna_platform.admin_create_company($1, 'general', $2, '', $3, 'Test') as r`, [name, ownerEmail, token()]))[0].r;
const grant = (ws, email, role = 'finance') =>
  as(sa, `select etna_platform.admin_workspace_grant($1, $2, $3, 'Joins the team')`, [ws, email, role]);
const membersOf = async (ws) =>
  admin(db, `select user_id, role from erp_workspace_members where workspace_id = $1 and status = 'active' order by role`, [ws]);

before(async () => {
  db = await createDb();
  sa = await adminOf('close-sa', 'super_admin');
  sa2 = await adminOf('close-sa2', 'super_admin');
  support = await adminOf('close-support', 'support');
  auditor = await adminOf('close-auditor', 'auditor');
});

test('only a super admin with a fresh code closes an account, with a reason and the e-mail typed again', async () => {
  const person = await createUser(db, 'close-guard');
  const stale = await adminOf('close-stale', 'super_admin', false);
  await expectError(close(support, person), /Not allowed/);
  await expectError(close(auditor, person), /Not allowed/);
  await expectError(close(stale, person), /two-factor code/);
  await expectError(run(db, person, `select etna_platform.admin_close_account($1, 'x x x', $2)`, [person.id, person.email]), /Not allowed|permission denied/);
  await expectError(close(sa, person, ''), /Give a reason/);
  await expectError(close(sa, person, 'Left', 'someone-else@example.test'), /e-mail address to confirm/);
  await expectError(close(sa, sa.user), /own account/);
  await expectError(close(sa, sa2.user), /Revoke the admin role first/);
  assert.equal((await admin(db, `select count(*)::int as n from etna_platform.closed_accounts`))[0].n, 0);
});

test('closing shuts the account, removes it from every ERP and replaces its details; its records stay', async () => {
  const person = await createUser(db, 'close-person');
  const original = person.email;
  const [{ workspace_id: own }] = await run(db, person, `select workspace_id from erp_my_workspaces() where is_personal`);
  await admin(db, `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'PT Pelanggan')`, [person.id, own]);
  const owner = await createUser(db, 'close-owner');
  const r = await company('PT Kerja', owner.email);
  await grant(r.workspace_id, original);
  await openSession(person);
  await admin(db, `insert into auth.mfa_factors (user_id, friendly_name, status) values ($1, 'phone', 'verified')`, [person.id]);
  await admin(db, `insert into erp_workspace_invitations (workspace_id, code_hash, role, created_by, expires_at)
                   values ($1, md5(random()::text), 'sales', $2, now() + interval '1 day')`, [own, person.id]);
  await as(sa, `select etna_platform.admin_set_account_limit($1, 5, 'Group of companies')`, [person.id]);

  const [{ r: result }] = await close(sa, person);
  assert.deepEqual([result.erps_left, result.sessions_ended], [2, 1]);

  const [u] = await admin(db, `select email, encrypted_password, banned_until = 'infinity' as blocked, raw_user_meta_data ->> 'full_name' as name
                               from auth.users where id = $1`, [person.id]);
  assert.match(u.email, /^closed-.*@closed\.etna\.invalid$/);
  assert.deepEqual([u.encrypted_password, u.blocked, u.name], [null, true, 'Closed account']);
  const [p] = await admin(db, `select email, full_name from user_profiles where id = $1`, [person.id]);
  assert.deepEqual([p.email, p.full_name], [u.email, 'Closed account']);
  assert.equal((await admin(db, `select name from erp_workspaces where id = $1`, [own]))[0].name, 'Closed account');
  assert.equal((await admin(db, `select count(*)::int as n from erp_workspace_members where user_id = $1 and status = 'active'`, [person.id]))[0].n, 0);
  assert.equal((await admin(db, `select count(*)::int as n from auth.sessions where user_id = $1 and revoked_at is null`, [person.id]))[0].n, 0);
  assert.equal((await admin(db, `select count(*)::int as n from auth.mfa_factors where user_id = $1`, [person.id]))[0].n, 0);
  assert.equal((await admin(db, `select count(*)::int as n from etna_platform.account_limits where user_id = $1`, [person.id]))[0].n, 0);
  assert.equal((await admin(db, `select count(*)::int as n from erp_workspace_invitations where created_by = $1 and revoked_at is null`, [person.id]))[0].n, 0);

  // Business records stay, and so does the ERP's trail.
  assert.equal((await admin(db, `select count(*)::int as n from erp_customers where user_id = $1`, [person.id]))[0].n, 1);
  const trail = await admin(db, `select details ->> 'reason' as reason from erp_workspace_audit_log
                                 where workspace_id = $1 and action = 'member.removed' and target_user_id = $2`, [r.workspace_id, person.id]);
  assert.match(trail[0].reason, /^Account closed: Left the company/);

  // The security log keeps the original address.
  const [event] = await admin(db, `select target_email, metadata from etna_platform.security_events
                                   where event_type = 'ACCOUNT_CLOSED' and target_user_id = $1`, [person.id]);
  assert.equal(event.target_email, original);
  assert.equal(event.metadata.reason, 'Left the company');

  // Nothing more is done to it, and its address is free again.
  await expectError(as(sa, `select etna_platform.admin_enable_user($1)`, [person.id]), /closed/);
  await expectError(as(support, `select etna_platform.admin_create_reset_link($1, $2)`, [person.id, token()]), /closed/);
  await expectError(close(sa, person, 'Again', u.email), /closed/);
  await admin(db, `insert into auth.users (email) values ($1)`, [original]);

  const [{ c }] = await as(auditor, `select etna_platform.admin_user_closure($1) as c`, [person.id]);
  assert.equal(c.reason, 'Left the company');
  assert.equal(c.closed_by_email, sa.user.email);
  assert.equal((await as(auditor, `select etna_platform.admin_user_closure($1) as c`, [owner.id]))[0].c, null);
});

test('the Owner of an ERP others use is not closed until the ownership moves', async () => {
  const owner = await createUser(db, 'close-ws-owner');
  const colleague = await createUser(db, 'close-colleague');
  const r = await company('PT Pindah', owner.email);
  const ws = r.workspace_id;
  await grant(ws, colleague.email, 'finance');
  await expectError(close(sa, owner), /Owner of ERPs that other people use: PT Pindah/);
  assert.equal((await as(auditor, `select etna_platform.admin_workspace_detail($1) as d`, [ws]))[0].d.workspace.transferable, true);

  // Transfer: super admin, fresh code, reason, an active member, never yourself.
  const transfer = (who, userId, reason = 'Owner leaves') =>
    as(who, `select etna_platform.admin_transfer_ownership($1, $2, $3)`, [ws, userId, reason]);
  await expectError(transfer(support, colleague.id), /Not allowed/);
  await expectError(transfer(sa, colleague.id, ''), /Give a reason/);
  const outsider = await createUser(db, 'close-outsider');
  await expectError(transfer(sa, outsider.id), /member of this ERP first/);
  await grant(ws, sa2.user.email, 'admin');
  await expectError(transfer(sa2, sa2.user.id), /own account/);
  await expectError(transfer(sa, owner.id), /Already the Owner/);

  await transfer(sa, colleague.id);
  const roles = Object.fromEntries((await membersOf(ws)).map((m) => [m.user_id, m.role]));
  assert.deepEqual(roles, { [owner.id]: 'admin', [sa2.user.id]: 'admin', [colleague.id]: 'owner' });
  assert.equal((await admin(db, `select created_by from erp_workspaces where id = $1`, [ws]))[0].created_by, colleague.id);
  const mine = await run(db, colleague, `select role, is_owner, owner_email from erp_my_workspaces() where workspace_id = $1`, [ws]);
  assert.deepEqual(mine, [{ role: 'owner', is_owner: true, owner_email: colleague.email }]);
  const [event] = await admin(db, `select target_user_id, metadata from etna_platform.security_events
                                   where event_type = 'WORKSPACE_OWNER_CHANGED' and workspace_id = $1`, [ws]);
  assert.equal(event.target_user_id, colleague.id);
  assert.equal(event.metadata.previous_owner_email, owner.email);

  // Now the former Owner can be closed.
  await close(sa, owner);
  assert.deepEqual((await membersOf(ws)).map((m) => m.role).sort(), ['admin', 'owner']);
});

test('a personal ERP cannot be transferred; its other members have to go first', async () => {
  const person = await createUser(db, 'close-personal');
  const [{ workspace_id: own }] = await run(db, person, `select workspace_id from erp_my_workspaces() where is_personal`);
  const guest = await createUser(db, 'close-guest');
  await grant(own, guest.email, 'sales');
  await expectError(as(sa, `select etna_platform.admin_transfer_ownership($1, $2, 'Owner leaves')`, [own, guest.id]), /personal ERP cannot be transferred/);
  assert.equal((await as(auditor, `select etna_platform.admin_workspace_detail($1) as d`, [own]))[0].d.workspace.transferable, false);
  await expectError(close(sa, person), /Owner of ERPs that other people use/);
  await as(sa, `select etna_platform.admin_workspace_remove($1, $2, 'Owner leaves')`, [own, guest.id]);
  await close(sa, person);
});

test('the account list shows closed accounts apart, every ERP with its role, and sorts', async () => {
  const owner = await createUser(db, 'list-owner');
  const r = await company('PT Daftar', owner.email);
  const [row] = await as(auditor, `select * from etna_platform.admin_list_users($1)`, [owner.email]);
  assert.equal(row.workspaces, row.memberships.length);
  assert.equal(row.memberships[0].role, 'owner');
  assert.equal(row.memberships.find((m) => m.name === 'PT Daftar').workspace_id, r.workspace_id);
  assert.deepEqual([row.closed, row.disabled], [false, false]);

  const closed = await as(auditor, `select email, closed, disabled from etna_platform.admin_list_users(null, 'closed', 200)`);
  assert.ok(closed.length >= 1);
  assert.ok(closed.every((x) => x.closed && !x.disabled));
  const disabledRows = await as(auditor, `select closed from etna_platform.admin_list_users(null, 'disabled', 200)`);
  assert.ok(disabledRows.every((x) => !x.closed));

  const byEmail = await as(auditor, `select email from etna_platform.admin_list_users(null, 'all', 200, 0, 'email_asc')`);
  const emails = byEmail.map((x) => x.email.toLowerCase());
  assert.deepEqual(emails, [...emails].sort());
  const oldest = await as(auditor, `select created_at from etna_platform.admin_list_users(null, 'all', 200, 0, 'created_asc')`);
  assert.ok(oldest[0].created_at <= oldest.at(-1).created_at);
  await expectError(as(auditor, `select * from etna_platform.admin_list_users(null, 'all', 10, 0, 'random')`), /Unknown sort order/);
});

test('rollback removes closing and transfer and restores the account list', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000029_platform_admin_close_account.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select to_regclass('etna_platform.closed_accounts') is null as gone,
    to_regprocedure('etna_platform.admin_close_account(uuid,text,text)') is null as no_close,
    to_regprocedure('etna_platform.admin_list_users(text,text,integer,integer)') is not null as list_back,
    position('_is_closed' in pg_get_functiondef('etna_platform._target(uuid,text,boolean)'::regprocedure)) = 0 as target_back,
    position('transferable' in pg_get_functiondef('etna_platform.admin_workspace_detail(uuid)'::regprocedure)) = 0 as detail_back`);
  assert.deepEqual(rows[0], { gone: true, no_close: true, list_back: true, target_back: true, detail_back: true });
  await d.close();
});
