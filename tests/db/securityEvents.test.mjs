import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { migrate } from '../../scripts/db/migrator.mjs';
import {
  changePassword, enrollFactor, reauthenticate, resolveSession, signIn, signOut, unenrollFactor, verifyFactor, verifyPassword,
} from '../../src/server/auth/service.ts';
import { base32Decode, currentStep, hotp } from '../../src/server/auth/totp.ts';
import { beginAsUser, getCatalog } from '../../src/server/db/execute.ts';
import { identityOf } from '../../src/server/auth/request.ts';

let db;
let deps;
let appExecutor;
let counter = 0;

async function createUser(password = 'correct horse') {
  counter += 1;
  const email = `events-${counter}@example.test`;
  const { rows } = await db.query(
    `insert into auth.users (email, encrypted_password) values ($1, $2) returning id`,
    [email, bcrypt.hashSync(password, 4)]
  );
  return { id: rows[0].id, email, password };
}

const UA = 'Mozilla/5.0 (test)';
const login = (user, password = user.password, ip = '198.51.100.7') => signIn(deps, { email: user.email, password, ip, userAgent: UA });
const codeFor = (secret, offset = 0) => hotp(base32Decode(secret), currentStep() + offset);
const meta = { ip: '198.51.100.7', userAgent: UA };

const events = async (email) =>
  (await db.query(`select * from etna_platform.security_events where lower(actor_email) = lower($1) or lower(target_email) = lower($1) order by id`, [email])).rows;
const types = async (email) => (await events(email)).map((e) => e.event_type);

before(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await migrate({ exec: (sql) => db.exec(sql), query: (sql, params) => db.query(sql, params) });
  const executor = { transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })) };
  deps = { executor, mfaKey: randomBytes(32), asRole: 'etna_auth' };
  // As the app's data connection: everything runs as `authenticated` after beginAsUser.
  appExecutor = executor;
});

async function twoFactorSession(user) {
  const first = await login(user);
  const factor = await enrollFactor(deps, first.session, 'Phone');
  const { token } = await verifyFactor(deps, first.session, factor.id, codeFor(factor.secret), meta);
  return { session: await resolveSession(deps, token), factor };
}

test('sign-ins: success with its session, failures with a reason, lockouts', async () => {
  const user = await createUser();
  const ok = await login(user);
  assert.equal(ok.ok, true);
  await login(user, 'wrong password');
  await signIn(deps, { email: 'nobody-here@example.test', password: 'x', ip: '203.0.113.5', userAgent: UA });

  const [success, failed] = await events(user.email);
  assert.equal(success.event_type, 'LOGIN_SUCCEEDED');
  assert.equal(success.outcome, 'success');
  assert.equal(success.actor_user_id, user.id);
  assert.equal(success.session_id, ok.session.sessionId);
  assert.equal(success.ip, '198.51.100.7');
  assert.equal(success.user_agent, UA);
  assert.equal(failed.event_type, 'LOGIN_FAILED');
  assert.equal(failed.outcome, 'failure');
  assert.deepEqual(failed.metadata, { reason: 'wrong_password' });

  const [unknown] = await events('nobody-here@example.test');
  assert.equal(unknown.actor_user_id, null);
  assert.deepEqual(unknown.metadata, { reason: 'unknown_account' });

  // A password typed into the e-mail field is not kept.
  await signIn(deps, { email: 'MySecret!Pass', password: 'x', ip: '203.0.113.6', userAgent: UA });
  const [mistyped] = (await db.query(`select * from etna_platform.security_events where ip = '203.0.113.6'`)).rows;
  assert.equal(mistyped.event_type, 'LOGIN_FAILED');
  assert.equal(mistyped.target_email, null);
  assert.equal(mistyped.actor_email, null);

  const locked = await createUser();
  await db.query(`update auth.users set banned_until = 'infinity' where id = $1`, [locked.id]);
  await login(locked);
  assert.deepEqual((await events(locked.email))[0].metadata, { reason: 'disabled' });

  const guessed = await createUser();
  for (let i = 0; i < 5; i += 1) await login(guessed, `guess ${i}`, null);
  assert.deepEqual(await login(guessed, guessed.password, null), { ok: false, reason: 'rate_limited' });
  assert.equal((await types(guessed.email)).at(-1), 'LOGIN_RATE_LIMITED');
});

test('sign-out, password checks and password changes are recorded without the passwords', async () => {
  const user = await createUser('first password!');
  const a = await login(user);
  const b = await login(user);
  assert.equal(await verifyPassword(deps, a.session, 'not it', meta.ip, meta.userAgent), false);
  assert.deepEqual(await changePassword(deps, a.session, { currentPassword: 'nope', newPassword: 'second password!', ...meta }), { ok: false, reason: 'invalid' });
  const changed = await changePassword(deps, a.session, { currentPassword: 'first password!', newPassword: 'second password!', ...meta });
  assert.equal(changed.ok, true);
  await signOut(deps, changed.token, meta);
  await signOut(deps, b.token, meta); // already ended by the password change: nothing to record

  assert.deepEqual(await types(user.email), [
    'LOGIN_SUCCEEDED', 'LOGIN_SUCCEEDED', 'PASSWORD_CHECK_FAILED', 'PASSWORD_CHANGE_FAILED', 'PASSWORD_CHANGED', 'LOGOUT',
  ]);
  const all = await events(user.email);
  assert.deepEqual(all[4].metadata, { other_sessions_ended: 1 });
  assert.equal(all[5].session_id, a.session.sessionId);
  const text = JSON.stringify(all);
  for (const secret of ['first password!', 'second password!', 'not it', changed.token]) assert.equal(text.includes(secret), false);
});

test('two-factor: a new device, failed codes and removal are recorded', async () => {
  const user = await createUser();
  const { session, factor } = await twoFactorSession(user);
  const spare = await enrollFactor(deps, session, 'Tablet');
  await assert.rejects(verifyFactor(deps, session, spare.id, '000000', meta), /Invalid TOTP code/);
  await unenrollFactor(deps, session, spare.id, meta); // never verified: not recorded
  await unenrollFactor(deps, session, factor.id, meta);

  assert.deepEqual(await types(user.email), ['LOGIN_SUCCEEDED', 'MFA_FACTOR_ADDED', 'MFA_CHALLENGE_FAILED', 'MFA_FACTOR_REMOVED']);
  const text = JSON.stringify(await events(user.email));
  assert.equal(text.includes(factor.secret), false);
});

test('re-authentication needs a two-factor session and a verified device', async () => {
  const user = await createUser();
  const plain = await login(user);
  await assert.rejects(reauthenticate(deps, plain.session, '00000000-0000-4000-8000-000000000000', '123456', meta), /AAL2 required/);

  const { session, factor } = await twoFactorSession(user);
  assert.equal(session.reauthenticatedAt, null);
  await assert.rejects(reauthenticate(deps, session, factor.id, '000000', meta), /Invalid TOTP code/);
  const pending = await enrollFactor(deps, session, 'Unfinished');
  await assert.rejects(reauthenticate(deps, session, pending.id, codeFor(pending.secret), meta), /Invalid TOTP code/, 'an unverified device does not count');

  await reauthenticate(deps, session, factor.id, codeFor(factor.secret, 1), meta);
  const [{ reauthenticated_at }] = (await db.query(`select reauthenticated_at from auth.sessions where id = $1`, [session.sessionId])).rows;
  assert.ok(reauthenticated_at);
  assert.deepEqual((await types(user.email)).slice(-3), ['ADMIN_REAUTH_FAILED', 'ADMIN_REAUTH_FAILED', 'ADMIN_REAUTHENTICATED']);
});

test('end to end: a super admin re-authenticates and grants a role through the app identity', async () => {
  const sa = await createUser();
  const helper = await createUser();
  await db.query(`select etna_admin.grant_platform_admin($1)`, [sa.email]);
  const { session, factor } = await twoFactorSession(sa);
  const catalog = await getCatalog(appExecutor);

  const grant = () =>
    appExecutor.transaction(async (tx) => {
      await beginAsUser(tx, identityOf(session), '/admin/admins', 'POST', catalog);
      return (await tx.query(`select etna_platform.admin_set_role($1, 'support') as role`, [helper.email])).rows[0].role;
    });
  await assert.rejects(grant(), /two-factor code first/);
  await reauthenticate(deps, session, factor.id, codeFor(factor.secret, 1), meta);
  assert.equal(await grant(), 'support');

  const [event] = (await events(helper.email)).filter((e) => e.event_type === 'ADMIN_ROLE_GRANTED');
  assert.equal(event.actor_user_id, sa.id);
  assert.equal(event.session_id, session.sessionId);
});

test('password links: set a new password once and end every session', async () => {
  const { linkTokenHash, newLinkToken, checkPasswordLink, completePasswordLink } = await import('../../src/server/auth/service.ts');
  const user = await createUser('old password!!');
  const before = await login(user, 'old password!!');
  const token = newLinkToken();
  await db.query(`insert into etna_platform.password_links (user_id, purpose, token_hash, expires_at) values ($1, 'reset', $2, now() + interval '1 day')`, [user.id, linkTokenHash(token)]);

  assert.deepEqual(await checkPasswordLink(deps, token), { email: user.email, purpose: 'reset' });
  assert.equal(await checkPasswordLink(deps, 'short'), null);
  await assert.rejects(completePasswordLink(deps, { token, newPassword: 'short' }, meta), /at least/);

  assert.deepEqual(await completePasswordLink(deps, { token, newPassword: 'brand new password' }, meta), { ok: true, email: user.email });
  assert.equal(await resolveSession(deps, before.token), null, 'existing sessions ended');
  assert.equal((await login(user, 'old password!!')).ok, false);
  assert.equal((await login(user, 'brand new password')).ok, true);
  assert.deepEqual(await completePasswordLink(deps, { token, newPassword: 'another password!' }, meta), { ok: false, reason: 'invalid' }, 'only once');

  const all = await events(user.email);
  const done = all.find((e) => e.event_type === 'PASSWORD_RESET_COMPLETED');
  assert.deepEqual(done.metadata, { purpose: 'reset', sessions_ended: 1 });
  assert.equal(JSON.stringify(all).includes(token), false, 'the token is never logged');
  const failed = (await db.query(`select * from etna_platform.security_events where event_type = 'PASSWORD_RESET_FAILED' order by id desc limit 1`)).rows[0];
  assert.equal(failed.ip, meta.ip);
});

test('changing your own password cancels reset links made earlier', async () => {
  const { linkTokenHash, newLinkToken, checkPasswordLink } = await import('../../src/server/auth/service.ts');
  const user = await createUser('first password!');
  const token = newLinkToken();
  await db.query(`insert into etna_platform.password_links (user_id, purpose, token_hash, expires_at) values ($1, 'reset', $2, now() + interval '1 day')`, [user.id, linkTokenHash(token)]);
  const { session } = await login(user, 'first password!');
  assert.equal((await changePassword(deps, session, { currentPassword: 'first password!', newPassword: 'second password!', ...meta })).ok, true);
  assert.equal(await checkPasswordLink(deps, token), null);
});

// Last in this file: once a version is published every later request needs it.
test('terms: status, acceptance after two-factor, a newer version, declining', async () => {
  const { acceptTerms, currentTerms, declineTerms, termsStatus } = await import('../../src/server/auth/service.ts');
  const plain = await createUser();
  const { session: plainSession } = await login(plain);
  assert.equal(await currentTerms(deps), null);
  assert.equal((await termsStatus(deps, plainSession)).required, false);

  const [{ id: v1 }] = (await db.query(`insert into etna_platform.terms_versions (label, content, published_at) values ('t1', '{"en":"Terms one"}', now()) returning id`)).rows;
  assert.equal((await currentTerms(deps)).label, 't1');
  assert.deepEqual(await termsStatus(deps, plainSession), { required: true, versionId: v1, acceptedAt: null });

  // An account with two-factor accepts only after its code.
  const secured = await createUser();
  const first = await login(secured);
  const factor = await enrollFactor(deps, first.session, 'Phone');
  const { token } = await verifyFactor(deps, first.session, factor.id, codeFor(factor.secret), meta);
  const aal1 = (await login(secured)).session;
  await assert.rejects(acceptTerms(deps, aal1, { versionId: v1, locale: 'en', workspaceId: null }, meta), /AAL2 required/);
  const verified = await resolveSession(deps, token);
  const at = await acceptTerms(deps, verified, { versionId: v1, locale: 'zh', workspaceId: null }, meta);
  assert.ok(at);
  assert.equal((await termsStatus(deps, verified)).required, false);

  await db.query(`insert into etna_platform.terms_versions (label, content, published_at) values ('t2', '{"en":"Terms two"}', now() + interval '1 second')`);
  await assert.rejects(acceptTerms(deps, verified, { versionId: v1, locale: 'en', workspaceId: null }, meta), (e) => e.code === 'terms_changed');
  assert.equal((await termsStatus(deps, verified)).required, true);

  await declineTerms(deps, plainSession, v1, meta);
  const declined = (await events(plain.email)).find((e) => e.event_type === 'TERMS_DECLINED');
  assert.equal(declined.metadata.version_id, v1);
  const accepted = (await events(secured.email)).find((e) => e.event_type === 'TERMS_ACCEPTED');
  assert.equal(accepted.metadata.locale, 'zh');
  assert.equal(accepted.ip, meta.ip);
});
