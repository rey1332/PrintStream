import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, admin, expectError } from './harness.mjs';

let db;

before(async () => {
  db = await createDb();
});

async function openSession(user, { reauthenticated = false } = {}) {
  const [{ id }] = await admin(
    db,
    `insert into auth.sessions (user_id, token_hash, aal, expires_at, reauthenticated_at)
     values ($1, md5(random()::text), 'aal2', now() + interval '1 day', case when $2 then now() end) returning id`,
    [user.id, reauthenticated]
  );
  return id;
}

// As the app runs a request: role authenticated, claims with the session id.
async function as(user, { aal = 'aal2', sid = null } = {}, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: user.id, email: user.email, role: 'authenticated', aal, sid }),
    ]);
    await tx.query(`select set_config('request.ip', '203.0.113.9', true), set_config('request.user_agent', 'test-agent', true)`);
    return (await tx.query(sql, params)).rows;
  });
}

async function asRole(role, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
}

const eventsFor = (userId) =>
  admin(db, `select * from etna_platform.security_events where target_user_id = $1 order by id`, [userId]);

async function superAdmin(name) {
  const user = await createUser(db, name);
  await admin(db, `select etna_admin.grant_platform_admin($1, 'super_admin')`, [user.email]);
  const sid = await openSession(user, { reauthenticated: true });
  return { user, sid };
}

test('the first super admin is granted from the command line, and that is recorded', async () => {
  const user = await createUser(db, 'first-admin');
  await admin(db, `select etna_admin.grant_platform_admin($1)`, [user.email]);
  assert.equal((await as(user, {}, `select etna_platform.my_admin_role() as role`))[0].role, 'super_admin');

  const [event] = await eventsFor(user.id);
  assert.equal(event.event_type, 'ADMIN_ROLE_GRANTED');
  assert.equal(event.actor_kind, 'cli');
  assert.match(event.actor_email, /^db:/);
  assert.equal(event.metadata.role, 'super_admin');

  // Granting the same role again changes nothing and records nothing.
  await admin(db, `select etna_admin.grant_platform_admin($1)`, [user.email]);
  assert.equal((await eventsFor(user.id)).length, 1);
  await expectError(admin(db, `select etna_admin.grant_platform_admin($1, 'owner')`, [user.email]), /super_admin, support or auditor/);
});

test('signing in is not being an admin: other users see no role and no admin data', async () => {
  const user = await createUser(db, 'plain-user');
  assert.equal((await as(user, {}, `select etna_platform.my_admin_role() as role`))[0].role, null);
  for (const sql of [
    `select * from etna_platform.admin_security_events()`,
    `select * from etna_platform.admin_list_admins()`,
    `select etna_platform.admin_set_role('x@example.test', 'support')`,
    `select etna_platform.admin_revoke_role('x@example.test')`,
  ]) {
    await expectError(as(user, {}, sql), /Not allowed/);
  }
  // Workspace owners are not platform admins either (every user owns a personal ERP).
  await expectError(as(user, {}, `select * from etna_platform.security_events`), /permission denied/);
  await expectError(as(user, {}, `select * from etna_platform.admins`), /permission denied/);
});

test('admins need a two-factor session; changes also need a fresh re-authentication', async () => {
  const { user, sid } = await superAdmin('sa-gate');
  const target = await createUser(db, 'sa-gate-target');

  await expectError(as(user, { aal: 'aal1', sid }, `select * from etna_platform.admin_list_admins()`), /Two-factor/);

  const stale = await openSession(user);
  await expectError(as(user, { sid: stale }, `select etna_platform.admin_set_role($1, 'support')`, [target.email]), /two-factor code first/);
  // Another account's re-authenticated session does not count.
  const other = await superAdmin('sa-gate-other');
  await expectError(as(user, { sid: other.sid }, `select etna_platform.admin_set_role($1, 'support')`, [target.email]), /two-factor code first/);
  // Nor does one older than ten minutes.
  await admin(db, `update auth.sessions set reauthenticated_at = now() - interval '11 minutes' where id = $1`, [stale]);
  await expectError(as(user, { sid: stale }, `select etna_platform.admin_set_role($1, 'support')`, [target.email]), /two-factor code first/);

  await as(user, { sid }, `select etna_platform.admin_set_role($1, 'support')`, [target.email]);
  assert.equal((await as(target, {}, `select etna_platform.my_admin_role() as role`))[0].role, 'support');
});

test('only super admins manage admins, never their own role, and every change is recorded', async () => {
  const { user: sa, sid } = await superAdmin('sa-manage');
  const helper = await createUser(db, 'support-person');
  const auditor = await createUser(db, 'auditor-person');

  await as(sa, { sid }, `select etna_platform.admin_set_role($1, 'support')`, [helper.email]);
  await as(sa, { sid }, `select etna_platform.admin_set_role($1, 'auditor')`, [auditor.email]);
  await as(sa, { sid }, `select etna_platform.admin_set_role($1, 'auditor')`, [helper.email]);

  const helperSid = await openSession(helper, { reauthenticated: true });
  await expectError(as(helper, { sid: helperSid }, `select etna_platform.admin_set_role($1, 'super_admin')`, [helper.email]), /Not allowed/);
  await expectError(as(helper, { sid: helperSid }, `select etna_platform.admin_revoke_role($1)`, [sa.email]), /Not allowed/);

  await expectError(as(sa, { sid }, `select etna_platform.admin_set_role($1, 'auditor')`, [sa.email]), /own admin role/);
  await expectError(as(sa, { sid }, `select etna_platform.admin_revoke_role($1)`, [sa.email]), /own admin role/);
  await expectError(as(sa, { sid }, `select etna_platform.admin_set_role($1, 'root')`, [helper.email]), /Unknown admin role/);
  await expectError(as(sa, { sid }, `select etna_platform.admin_set_role('nobody@example.test', 'support')`), /No account/);

  const listed = await as(sa, { sid }, `select email, role, granted_by_email from etna_platform.admin_list_admins()`);
  assert.equal(listed.find((r) => r.email === helper.email).role, 'auditor');
  assert.equal(listed.find((r) => r.email === helper.email).granted_by_email, sa.email);

  await as(sa, { sid }, `select etna_platform.admin_revoke_role($1)`, [helper.email]);
  await expectError(as(sa, { sid }, `select etna_platform.admin_revoke_role($1)`, [helper.email]), /not an admin/);
  assert.equal((await as(helper, {}, `select etna_platform.my_admin_role() as role`))[0].role, null);

  const trail = await eventsFor(helper.id);
  assert.deepEqual(trail.map((e) => e.event_type), ['ADMIN_ROLE_GRANTED', 'ADMIN_ROLE_CHANGED', 'ADMIN_ROLE_REVOKED']);
  for (const event of trail) {
    assert.equal(event.actor_kind, 'admin');
    assert.equal(event.actor_user_id, sa.id);
    assert.equal(event.actor_email, sa.email);
    assert.equal(event.session_id, sid);
    assert.equal(event.ip, '203.0.113.9');
    assert.equal(event.user_agent, 'test-agent');
  }
  assert.deepEqual(trail[1].metadata, { role: 'auditor', previous_role: 'support' });
});

test('every admin role reads the log, filtered and paged newest first', async () => {
  const { user: sa, sid } = await superAdmin('sa-reader');
  const auditor = await createUser(db, 'log-auditor');
  await as(sa, { sid }, `select etna_platform.admin_set_role($1, 'auditor')`, [auditor.email]);
  const victim = await createUser(db, 'log-victim');
  for (let i = 0; i < 3; i += 1) {
    await asRole('etna_auth', `select etna_platform.log_auth_event('LOGIN_FAILED', 'failure', $1, $2, null, '198.51.100.20', 'ua', '{"reason":"wrong_password"}')`, [victim.id, victim.email]);
  }

  const page = await as(auditor, {}, `select * from etna_platform.admin_security_events(null, 2, 'LOGIN_FAILED', $1)`, [victim.email.toUpperCase()]);
  assert.equal(page.length, 2);
  assert.ok(page[0].id > page[1].id);
  const rest = await as(auditor, {}, `select * from etna_platform.admin_security_events($1, 50, 'LOGIN_FAILED', $2)`, [page[1].id, victim.email]);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].metadata.reason, 'wrong_password');

  assert.equal((await as(auditor, {}, `select * from etna_platform.admin_security_events(null, 50, null, '198.51.100.20')`)).length, 3);
  assert.equal((await as(auditor, {}, `select * from etna_platform.admin_security_events(null, 50, null, '%')`)).length, 0, 'wildcards are literal');
  assert.equal((await as(auditor, {}, `select * from etna_platform.admin_security_events(null, 50, 'LOGIN_FAILED', $1, 'success')`, [victim.email])).length, 0);
  // Auditors read; they cannot change roles.
  const auditorSid = await openSession(auditor, { reauthenticated: true });
  await expectError(as(auditor, { sid: auditorSid }, `select etna_platform.admin_set_role($1, 'support')`, [victim.email]), /Not allowed/);
});

test('the log is append-only, for the app roles and for the schema owner', async () => {
  const user = await createUser(db, 'append-only');
  await admin(db, `select etna_admin.lock_user($1)`, [user.email]);
  const [event] = await eventsFor(user.id);

  for (const role of ['authenticated', 'anon', 'etna_auth', 'etna_app']) {
    await expectError(asRole(role, `select * from etna_platform.security_events`), /permission denied/);
    await expectError(asRole(role, `delete from etna_platform.security_events`), /permission denied/);
  }
  await expectError(asRole('authenticated', `select etna_platform._log('X_EVENT', 'success', 'user', null, null, null, '{}')`), /permission denied/);

  await expectError(admin(db, `update etna_platform.security_events set outcome = 'failure' where id = $1`, [event.id]), /append-only/);
  await expectError(admin(db, `delete from etna_platform.security_events where id = $1`, [event.id]), /append-only/);
  await expectError(admin(db, `truncate etna_platform.security_events`), /append-only/);
  assert.equal((await eventsFor(user.id)).length, 1);
});

test('the sign-in server can only add sign-in events', async () => {
  const user = await createUser(db, 'auth-events');
  await asRole('etna_auth', `select etna_platform.log_auth_event('LOGIN_SUCCEEDED', 'success', $1, $2, null, '192.0.2.1', 'Firefox', '{}')`, [user.id, user.email]);
  await expectError(asRole('etna_auth', `select etna_platform.log_auth_event('ADMIN_ROLE_GRANTED', 'success', $1, $2, null, null, null, '{}')`, [user.id, user.email]), /Unknown sign-in event/);
  await expectError(asRole('etna_auth', `select etna_platform.my_admin_role()`), /permission denied/);
  await expectError(asRole('authenticated', `select etna_platform.log_auth_event('LOGIN_SUCCEEDED', 'success', null, null, null, null, null, '{}')`), /permission denied/);

  const [event] = await eventsFor(user.id);
  assert.equal(event.actor_kind, 'user');
  assert.equal(event.actor_user_id, user.id);
  assert.equal(event.ip, '192.0.2.1');
  assert.equal(event.user_agent, 'Firefox');
});

test('the command-line account functions record what they do', async () => {
  const created = (await admin(db, `select * from etna_admin.create_user('cli-made@example.test', 'Cli Made')`))[0];
  assert.ok(created.temporary_password);
  const [{ id }] = await admin(db, `select id from auth.users where email = 'cli-made@example.test'`);
  await admin(db, `select * from etna_admin.set_password('cli-made@example.test')`);
  await admin(db, `select etna_admin.revoke_sessions('cli-made@example.test')`);
  await admin(db, `select etna_admin.reset_mfa('cli-made@example.test')`);
  await admin(db, `select etna_admin.lock_user('cli-made@example.test')`);
  await admin(db, `select etna_admin.unlock_user('cli-made@example.test')`);
  await admin(db, `select etna_admin.log_event('SESSIONS_REVOKED', 'cli-made@example.test', '{"sessions_ended":0}')`);
  await expectError(admin(db, `select etna_admin.log_event('LOGIN_SUCCEEDED', 'cli-made@example.test')`), /Unknown account event/);

  const trail = await eventsFor(id);
  assert.deepEqual(trail.map((e) => e.event_type), [
    'USER_CREATED', 'ADMIN_PASSWORD_SET', 'SESSIONS_REVOKED', 'MFA_RESET', 'USER_DISABLED', 'USER_ENABLED', 'SESSIONS_REVOKED',
  ]);
  assert.ok(trail.every((e) => e.actor_kind === 'cli' && e.target_email === 'cli-made@example.test'));
  assert.equal(JSON.stringify(trail).includes(created.temporary_password), false, 'no password in the log');

  // The app roles still cannot use them.
  await expectError(asRole('authenticated', `select etna_admin.unlock_user('cli-made@example.test')`), /permission denied/);
});

test('retention: forever by default; a set period purges old events and records the purge', async () => {
  assert.equal((await admin(db, `select etna_admin.purge_security_events() as n`))[0].n, 0);
  await expectError(admin(db, `select etna_admin.set_security_log_retention(7)`), /check constraint/);

  const d = await createDb();
  const user = (await d.query(`insert into auth.users (email) values ('old@example.test') returning id`)).rows[0];
  await d.query(`select etna_admin.lock_user('old@example.test')`);
  // Backdate one event (as if written long ago) with the guard lifted for this test.
  await d.exec(`alter table etna_platform.security_events disable trigger security_events_append_only`);
  await d.query(`update etna_platform.security_events set occurred_at = now() - interval '400 days' where target_user_id = $1`, [user.id]);
  await d.exec(`alter table etna_platform.security_events enable trigger security_events_append_only`);
  await d.query(`select etna_admin.unlock_user('old@example.test')`);

  await d.query(`select etna_admin.set_security_log_retention(365)`);
  assert.equal((await d.query(`select etna_admin.purge_security_events() as n`)).rows[0].n, 1);
  const types = (await d.query(`select event_type from etna_platform.security_events order by id`)).rows.map((r) => r.event_type);
  assert.deepEqual(types, ['USER_ENABLED', 'SECURITY_LOG_RETENTION_CHANGED', 'SECURITY_LOG_PURGED']);
  await d.close();
});

test('only the listed etna_platform functions are callable, and only by the right roles', async () => {
  const callable = async (role) =>
    (await admin(db, `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'etna_platform' and has_function_privilege($1, p.oid, 'execute') order by 1`, [role])).map((r) => r.name);
  assert.deepEqual((await callable('authenticated')).sort(), [
    'admin_account_limit', 'admin_announcements', 'admin_authorize', 'admin_cancel_announcement', 'admin_close_account', 'admin_create_company',
    'admin_create_reset_link', 'admin_create_user', 'admin_dashboard', 'admin_disable_user', 'admin_enable_user',
    'admin_end_sessions', 'admin_list_admins', 'admin_list_users', 'admin_list_workspaces', 'admin_reactivate_workspace',
    'admin_reset_mfa', 'admin_revoke_role', 'admin_save_announcement', 'admin_security_events', 'admin_set_account_limit',
    'admin_set_role', 'admin_set_workspace_modules', 'admin_suspend_workspace',
    'admin_terms_delete', 'admin_terms_get', 'admin_terms_list', 'admin_terms_pending', 'admin_terms_publish',
    'admin_terms_save', 'admin_transfer_ownership', 'admin_user_closure', 'admin_user_detail', 'admin_user_terms', 'admin_workspace_detail', 'admin_workspace_grant',
    'admin_workspace_remove', 'admin_workspace_usage', 'my_admin_role',
    'admin_cancel_termination', 'admin_confirm_termination', 'admin_data_access_log', 'admin_end_staff_access',
    'admin_legal_holds', 'admin_release_legal_hold', 'admin_retention_policies', 'admin_set_legal_hold',
    'admin_set_retention_policy', 'admin_staff_access_sessions', 'admin_start_staff_access', 'admin_terminate_workspace',
    'admin_workspace_termination', 'admin_workspace_storage', 'admin_set_workspace_quota', 'admin_storage_defaults',
    'admin_set_storage_defaults', 'admin_set_connector_private_hosts', 'admin_connector_private_hosts',
    'admin_network_allowlist', 'admin_add_network_allow', 'admin_remove_network_allow',
    'admin_set_ai_local_endpoints', 'admin_ai_local_endpoints',
  ].sort());
  assert.deepEqual(await callable('etna_auth'), [
    'log_auth_event', 'password_link_check', 'password_link_use', 'password_links_revoke',
    'terms_accept', 'terms_current', 'terms_status',
  ]);
  assert.deepEqual(await callable('anon'), []);
  assert.deepEqual(await callable('etna_app'), [], 'etna_app acts only through anon/authenticated');
  const etnaAdmin = await admin(db, `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'etna_admin' and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('etna_auth', p.oid, 'execute'))`);
  assert.equal(etnaAdmin[0].n, 0);
});

test('rollback removes the admin roles and the log and restores the account functions', async () => {
  // Rollbacks run newest first: this one on the schema as of its migration.
  const d = await createDb({ through: '20261012000011' });
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000011_platform_admin_security_log.sql', import.meta.url), 'utf8'));
  const [state] = (await d.query(`select to_regnamespace('etna_platform') is null as gone,
      exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'sessions' and column_name = 'reauthenticated_at') as column_left`)).rows;
  assert.equal(state.gone, true);
  assert.equal(state.column_left, false);
  const [made] = (await d.query(`select * from etna_admin.create_user('after-rollback@example.test')`)).rows;
  assert.ok(made.temporary_password);
  await d.query(`select etna_admin.lock_user('after-rollback@example.test')`);
  await d.close();
});
