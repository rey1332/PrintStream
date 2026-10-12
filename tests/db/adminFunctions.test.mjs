import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDb } from './harness.mjs';
import { signIn, resolveSession } from '../../src/server/auth/service.ts';

let db;
let deps;

const login = (email, password) => signIn(deps, { email, password, ip: null, userAgent: null });
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

before(async () => {
  db = await createDb();
  deps = { executor: { transaction: (fn) => db.transaction((tx) => fn({ query: (t, p) => tx.query(t, p) })) }, mfaKey: randomBytes(32) };
});

test('create_user makes a working account with a one-time temporary password', async () => {
  const created = await one(`select * from etna_admin.create_user('Ana@Example.test', 'Ana Admin')`);
  assert.equal(created.email, 'Ana@Example.test');
  assert.match(created.temporary_password, /^[A-Za-z0-9_-]{16}$/);
  const stored = await one(`select encrypted_password, raw_user_meta_data->>'full_name' as name from auth.users where lower(email) = 'ana@example.test'`);
  assert.match(stored.encrypted_password, /^\$2a\$12\$/, 'bcrypt, cost 12');
  assert.equal(stored.name, 'Ana Admin');

  const signedIn = await login('ana@example.test', created.temporary_password);
  assert.equal(signedIn.ok, true, 'the app accepts the SQL-made hash');
  const profile = await one(`select count(*)::int as n from public.user_profiles where email = 'Ana@Example.test'`);
  assert.equal(profile.n, 1, 'profile created by the existing trigger');
});

test('a chosen password is not echoed back', async () => {
  const created = await one(`select * from etna_admin.create_user('budi@example.test', null, 'a-chosen-password-1')`);
  assert.equal(created.temporary_password, null);
  assert.equal((await login('budi@example.test', 'a-chosen-password-1')).ok, true);
});

test('bad input is refused: duplicate (any case), invalid e-mail, short password', async () => {
  await assert.rejects(db.query(`select * from etna_admin.create_user('ANA@example.test')`), /already exists/);
  await assert.rejects(db.query(`select * from etna_admin.create_user('not-an-email')`), /valid e-mail/);
  await assert.rejects(db.query(`select * from etna_admin.create_user('short@example.test', null, 'short')`), /at least 10/);
  await assert.rejects(db.query(`select etna_admin.revoke_sessions('nobody@example.test')`), /No account/);
});

test('set_password ends existing sessions; the old password stops working', async () => {
  const { temporary_password: first } = await one(`select * from etna_admin.create_user('cici@example.test')`);
  const session = await login('cici@example.test', first);
  const { temporary_password: second } = await one(`select * from etna_admin.set_password('cici@example.test')`);
  assert.notEqual(second, first);
  assert.equal(await resolveSession(deps, session.token), null);
  assert.deepEqual(await login('cici@example.test', first), { ok: false, reason: 'invalid' });
  assert.equal((await login('cici@example.test', second)).ok, true);
});

test('lock, unlock, revoke sessions and reset two-factor', async () => {
  const { temporary_password: pw } = await one(`select * from etna_admin.create_user('dedi@example.test')`);
  const { id } = await one(`select id from auth.users where email = 'dedi@example.test'`);
  const session = await login('dedi@example.test', pw);

  await db.query(`select etna_admin.lock_user('dedi@example.test')`);
  assert.equal(await resolveSession(deps, session.token), null);
  assert.deepEqual(await login('dedi@example.test', pw), { ok: false, reason: 'invalid' });
  await db.query(`select etna_admin.unlock_user('dedi@example.test')`);
  const again = await login('dedi@example.test', pw);
  assert.equal(again.ok, true);

  assert.equal((await one(`select etna_admin.revoke_sessions('dedi@example.test') as n`)).n, 1);
  assert.equal(await resolveSession(deps, again.token), null);

  await db.query(`insert into auth.mfa_factors (user_id, friendly_name, status) values ($1, 'Phone', 'verified')`, [id]);
  await db.query(`insert into public.erp_mfa_recovery_codes (user_id, code_hash) values ($1, 'x')`, [id]);
  assert.equal((await one(`select etna_admin.reset_mfa('dedi@example.test') as n`)).n, 1);
  assert.equal((await one(`select count(*)::int as n from public.erp_mfa_recovery_codes where user_id = $1`, [id])).n, 0);
});

test('the overview lists accounts without secrets', async () => {
  const rows = (await db.query(`select * from etna_admin.users where email = 'budi@example.test'`)).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['active_sessions', 'created_at', 'devices_2fa', 'email', 'full_name', 'last_sign_in_at', 'locked']);
});

test('the app roles cannot use the admin functions', async () => {
  for (const role of ['etna_app', 'etna_auth', 'authenticated', 'anon']) {
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.exec(`set local role ${role}`);
        await tx.query(`select * from etna_admin.create_user('evil-${role}@example.test')`);
      }),
      /permission denied/,
      role
    );
  }
});
