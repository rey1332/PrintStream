import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { migrate } from '../../scripts/db/migrator.mjs';
import {
  AuthError, changePassword, enrollFactor, listFactors, resolveSession, revokeAllSessions, signIn, signOut,
  unenrollFactor, verifyFactor, verifyPassword, requestAllowed, SESSION_IDLE_MS,
  PRIVILEGED_IDLE_MS, SHARED_IDLE_MS,
} from '../../src/server/auth/service.ts';
import { base32Decode, currentStep, hotp, verifyTotp, base32Encode } from '../../src/server/auth/totp.ts';
import { openSecret, sealSecret, parseKey } from '../../src/server/auth/secret-box.ts';
import { readHint, sessionTag, signHint } from '../../src/lib/auth/hint.ts';
import { createSlots } from '../../src/server/slots.ts';
import { executeSpec } from '../../src/server/db/execute.ts';
import { RestClient } from '../../src/lib/db/rest-client.ts';

let db;
let deps;
let counter = 0;
const mfaKey = randomBytes(32);

async function createUser(password = 'correct horse', { hash } = {}) {
  counter += 1;
  const email = `auth-user-${counter}@example.test`;
  const encrypted = hash ?? bcrypt.hashSync(password, 4);
  const { rows } = await db.query(
    `insert into auth.users (email, encrypted_password, raw_user_meta_data) values ($1, $2, '{"full_name":"Test"}') returning id`,
    [email, encrypted]
  );
  return { id: rows[0].id, email, password };
}

const login = (user, password = user.password, ip = '198.51.100.7') => signIn(deps, { email: user.email, password, ip, userAgent: 'test' });
const codeFor = (secret, offset = 0) => hotp(base32Decode(secret), currentStep() + offset);

before(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await migrate({ exec: (sql) => db.exec(sql), query: (sql, params) => db.query(sql, params) });
  const executor = { transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })) };
  deps = { executor, mfaKey, asRole: 'etna_auth' };
});

test('shared request limits: counted in the database per bucket and key, by the sign-in role', async () => {
  const allowed = [];
  for (let i = 0; i < 4; i += 1) allowed.push(await requestAllowed(deps, 'password_link', '203.0.113.5', 3, 900));
  assert.deepEqual(allowed, [true, true, true, false]);
  assert.equal(await requestAllowed(deps, 'password_link', '203.0.113.6', 3, 900), true, 'another address counts alone');
  assert.equal(await requestAllowed(deps, 'other_bucket', '203.0.113.5', 3, 900), true, 'another bucket counts alone');
  // Another app server (or this one after a restart) sees the same count.
  const elsewhere = { ...deps, slots: undefined };
  assert.equal(await requestAllowed(elsewhere, 'password_link', '203.0.113.5', 3, 900), false);
  const { rows } = await db.query(`select hits from auth.request_limits where bucket = 'password_link' and key = '203.0.113.5'`);
  assert.equal(rows[0].hits, 5);
  // Not readable by the app's request roles.
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query('set local role authenticated');
      await tx.query('select * from auth.request_limits');
    }),
    /permission denied/
  );
});

test('TOTP matches RFC 6238 test vectors and tolerates one step of drift', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  // RFC 6238 appendix B, SHA-1, T = 59s → 94287082 (8 digits); 6 digits = 287082.
  assert.equal(hotp(base32Decode(secret), 1), '287082');
  const now = 1111111109 * 1000;
  assert.equal(verifyTotp(secret, '081804', { nowMs: now }), Math.floor(1111111109 / 30));
  assert.equal(verifyTotp(secret, '081804', { nowMs: now, lastUsedStep: Math.floor(1111111109 / 30) }), null, 'no replay');
  assert.equal(verifyTotp(secret, 'abcdef', { nowMs: now }), null);
});

test('secrets are sealed with AES-GCM and tampering is detected', () => {
  const sealed = sealSecret('JBSWY3DPEHPK3PXP', mfaKey);
  assert.ok(!sealed.includes('JBSWY3DPEHPK3PXP'));
  assert.equal(openSecret(sealed, mfaKey), 'JBSWY3DPEHPK3PXP');
  // Flip one bit of the ciphertext (always a real change, whatever the random IV gave).
  const [version, iv, tag, body] = sealed.split('.');
  const flipped = Buffer.from(body, 'base64url');
  flipped[0] ^= 1;
  const tampered = [version, iv, tag, flipped.toString('base64url')].join('.');
  assert.notEqual(tampered, sealed);
  assert.throws(() => openSecret(tampered, mfaKey));
  assert.throws(() => openSecret(sealed, randomBytes(32)));
  assert.throws(() => parseKey('dG9vLXNob3J0'));
});

test('sign-in works with bcrypt hashes from Supabase ($2a$) and from here', async () => {
  const supabaseStyle = await createUser('from-supabase', {
    hash: (await db.query(`select extensions.crypt('from-supabase', extensions.gen_salt('bf', 6)) as h`)).rows[0].h,
  });
  assert.match((await db.query('select encrypted_password from auth.users where id = $1', [supabaseStyle.id])).rows[0].encrypted_password, /^\$2a\$/);
  const a = await login(supabaseStyle);
  assert.equal(a.ok, true);
  assert.equal(a.session.aal, 'aal1');
  assert.equal(a.session.nextLevel, 'aal1');
  assert.equal(a.session.user.user_metadata.full_name, 'Test');

  const local = await createUser();
  assert.equal((await login(local)).ok, true);
});

test('wrong password, unknown email and blocked accounts all look the same', async () => {
  const user = await createUser();
  assert.deepEqual(await login(user, 'wrong'), { ok: false, reason: 'invalid' });
  assert.deepEqual(await signIn(deps, { email: 'nobody@example.test', password: 'x', ip: null, userAgent: null }), { ok: false, reason: 'invalid' });
  await db.query(`update auth.users set banned_until = now() + interval '1 day' where id = $1`, [user.id]);
  assert.deepEqual(await login(user), { ok: false, reason: 'invalid' });
  // 'infinity' is not a valid JavaScript date; the check happens in SQL.
  const forever = await createUser();
  const { token } = await login(forever);
  await db.query(`update auth.users set banned_until = 'infinity' where id = $1`, [forever.id]);
  assert.deepEqual(await login(forever), { ok: false, reason: 'invalid' });
  assert.equal(await resolveSession(deps, token), null, 'existing sessions stop working too');
});

test('without a trusted IP, five failures lock the email for a while, even with the right password', async () => {
  const user = await createUser();
  for (let i = 0; i < 5; i += 1) await login(user, 'wrong', null);
  assert.deepEqual(await login(user, user.password, null), { ok: false, reason: 'rate_limited' });
  // Two minutes later the lock has passed.
  await db.query(
    `update auth.login_attempts set attempted_at = attempted_at - interval '121 seconds' where lower(email) = lower($1)`,
    [user.email]
  );
  assert.equal((await login(user, user.password, null)).ok, true);
});

test('with trusted IPs, five failures lock one network only; twenty lock every network', async () => {
  const user = await createUser();
  for (let i = 0; i < 5; i += 1) await login(user, 'wrong', '203.0.113.9');
  assert.deepEqual(await login(user, user.password, '203.0.113.9'), { ok: false, reason: 'rate_limited' });
  // Someone guessing elsewhere does not lock the owner out of their own network.
  assert.equal((await login(user, user.password, '198.51.100.1')).ok, true);

  for (let i = 0; i < 15; i += 1) await login(user, 'wrong', `192.0.2.${i}`);
  assert.deepEqual(await login(user, user.password, '198.51.100.1'), { ok: false, reason: 'rate_limited' });
});

const attemptsOf = async (email) =>
  (await db.query('select succeeded from auth.login_attempts where lower(email) = lower($1) order by id', [email])).rows.map((r) => r.succeeded);

test('the password is compared outside any transaction; a success replaces the attempt counted first', async () => {
  const user = await createUser();
  let open = 0;
  let comparedInsideTx = false;
  const realCompare = bcrypt.compare;
  bcrypt.compare = async (...args) => {
    if (open > 0) comparedInsideTx = true;
    return realCompare(...args);
  };
  const counting = {
    ...deps,
    executor: { transaction: async (fn) => { open += 1; try { return await deps.executor.transaction(fn); } finally { open -= 1; } } },
  };
  try {
    assert.equal((await signIn(counting, { email: user.email, password: user.password, ip: null, userAgent: null })).ok, true);
    assert.deepEqual(await signIn(counting, { email: user.email, password: 'wrong', ip: null, userAgent: null }), { ok: false, reason: 'invalid' });
  } finally {
    bcrypt.compare = realCompare;
  }
  assert.equal(comparedInsideTx, false, 'no connection is held while bcrypt runs');
  assert.deepEqual(await attemptsOf(user.email), [true, false], 'one success (the pending failure removed), then one failure');
});

test('parallel wrong passwords are each counted, so they cannot slip past the lockout', async () => {
  const user = await createUser();
  const results = await Promise.all(Array.from({ length: 8 }, () => login(user, 'wrong', null)));
  assert.ok(results.every((r) => r.ok === false));
  assert.ok((await attemptsOf(user.email)).filter((ok) => !ok).length >= 5);
  assert.deepEqual(await login(user, user.password, null), { ok: false, reason: 'rate_limited' });
});

test('a server busy checking passwords turns sign-ins away before touching the database', async () => {
  const user = await createUser();
  const full = { ...deps, slots: createSlots(0, 0) };
  assert.deepEqual(await signIn(full, { email: user.email, password: user.password, ip: null, userAgent: null }), { ok: false, reason: 'rate_limited' });
  assert.equal(await verifyPassword(full, (await login(user)).session, user.password, null), 'rate_limited');
  assert.deepEqual(await attemptsOf(user.email), [true], 'only the normal sign-in above was recorded');
});

test('a password changed between the check and the session does not open a session', async () => {
  const user = await createUser();
  const realCompare = bcrypt.compare;
  bcrypt.compare = async (...args) => {
    const ok = await realCompare(...args);
    await db.query('update auth.users set encrypted_password = $2 where id = $1', [user.id, bcrypt.hashSync('changed', 4)]);
    return ok;
  };
  try {
    assert.deepEqual(await login(user), { ok: false, reason: 'invalid' });
  } finally {
    bcrypt.compare = realCompare;
  }
  assert.equal((await db.query('select count(*)::int as n from auth.sessions where user_id = $1', [user.id])).rows[0].n, 0);
});

test('two-factor: five wrong codes lock further codes for a while, even the right one', async () => {
  const user = await createUser();
  const first = await login(user);
  const enrolled = await enrollFactor(deps, first.session, 'Phone');
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(verifyFactor(deps, first.session, enrolled.id, String(100000 + i)), /Invalid TOTP code/);
  }
  await assert.rejects(verifyFactor(deps, first.session, enrolled.id, codeFor(enrolled.secret)), (error) => {
    assert.equal(error.code, 'over_request_rate_limit');
    assert.equal(error.status, 429);
    return true;
  });
  // Unknown factor ids count too, so they cannot be used to keep guessing.
  const other = await createUser();
  const second = await login(other);
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(verifyFactor(deps, second.session, '00000000-0000-4000-8000-000000000000', '123456'), /Invalid TOTP code/);
  }
  const otherFactor = await enrollFactor(deps, second.session, 'Phone');
  await assert.rejects(verifyFactor(deps, second.session, otherFactor.id, codeFor(otherFactor.secret)), /Too many incorrect codes/);

  const attempts = await db.query('select count(*)::int as n from auth.mfa_attempts where user_id = $1 and not succeeded', [user.id]);
  assert.equal(attempts.rows[0].n, 5, 'refused checks are not counted again');
});

test('sessions: token lookup, idle expiry, sign-out and revoke-all', async () => {
  const user = await createUser();
  const { token } = await login(user);
  assert.equal((await resolveSession(deps, token)).userId, user.id);
  assert.equal(await resolveSession(deps, 'not-a-token'), null);
  assert.equal(await resolveSession({ ...deps, now: () => Date.now() + SESSION_IDLE_MS + 60_000 }, token), null, 'idle sessions expire');
  const stored = await db.query('select token_hash from auth.sessions where user_id = $1', [user.id]);
  assert.ok(stored.rows.every((r) => r.token_hash !== token), 'only the hash is stored');
  await signOut(deps, token);
  assert.equal(await resolveSession(deps, token), null);

  const second = await login(user);
  assert.equal(await revokeAllSessions(deps, user.id), 1);
  assert.equal(await resolveSession(deps, second.token), null);
});

test('two-factor: enroll, verify (session → aal2, new token), replay refused', async () => {
  const user = await createUser();
  const first = await login(user);
  const enrolled = await enrollFactor(deps, first.session, 'Phone');
  assert.match(enrolled.qr_code, /^data:image\/png;base64,/);
  assert.match(enrolled.uri, /^otpauth:\/\/totp\//);
  const stored = (await db.query('select secret_enc, status from auth.mfa_factors where id = $1', [enrolled.id])).rows[0];
  assert.equal(stored.status, 'unverified');
  assert.ok(!stored.secret_enc.includes(enrolled.secret), 'secret is encrypted at rest');

  await assert.rejects(verifyFactor(deps, first.session, enrolled.id, '000000'), AuthError);
  const code = codeFor(enrolled.secret);
  const { token } = await verifyFactor(deps, first.session, enrolled.id, code);
  assert.equal(await resolveSession(deps, first.token), null, 'the pre-2FA token no longer works');
  const upgraded = await resolveSession(deps, token);
  assert.equal(upgraded.aal, 'aal2');
  assert.equal(upgraded.nextLevel, 'aal2');
  await assert.rejects(verifyFactor(deps, upgraded, enrolled.id, code), AuthError, 'the same code cannot be used twice');

  // A new sign-in starts at aal1 and must complete the second step.
  const again = await login(user);
  assert.equal(again.session.aal, 'aal1');
  assert.equal(again.session.nextLevel, 'aal2');
});

test('changing devices needs aal2 once a device exists; several devices allowed', async () => {
  const user = await createUser();
  const s1 = await login(user);
  const phone = await enrollFactor(deps, s1.session, 'Phone');
  const { token } = await verifyFactor(deps, s1.session, phone.id, codeFor(phone.secret));
  const verified = await resolveSession(deps, token);
  const tablet = await enrollFactor(deps, verified, 'Tablet');
  // Each verification rotates the session token.
  const { token: latest } = await verifyFactor(deps, verified, tablet.id, codeFor(tablet.secret));
  assert.equal(await resolveSession(deps, token), null);
  assert.equal((await listFactors(deps, verified)).filter((f) => f.status === 'verified').length, 2);
  await assert.rejects(enrollFactor(deps, verified, 'Tablet'), /friendly name/);

  const aal1 = (await login(user)).session;
  await assert.rejects(enrollFactor(deps, aal1, 'Laptop'), /AAL2 required/);
  await assert.rejects(unenrollFactor(deps, aal1, phone.id), /AAL2 required/);
  const verifiedAgain = await resolveSession(deps, latest);
  await unenrollFactor(deps, verifiedAgain, phone.id);
  assert.equal((await listFactors(deps, verifiedAgain)).length, 1);
});

test('re-checking the password (before destructive actions)', async () => {
  const user = await createUser();
  const { session } = await login(user);
  assert.equal(await verifyPassword(deps, session, user.password, null), true);
  assert.equal(await verifyPassword(deps, session, 'nope', null), false);
});

test('recovery code from a password-only session clears devices; the session then needs no second step', async () => {
  const user = await createUser();
  const s1 = await login(user);
  const phone = await enrollFactor(deps, s1.session, 'Phone');
  const { token } = await verifyFactor(deps, s1.session, phone.id, codeFor(phone.secret));
  const verified = await resolveSession(deps, token);
  const identity = (s) => ({ userId: s.userId, email: s.email, aal: s.aal });
  const dataAs = (s) => new RestClient((spec) => executeSpec(deps.executor, identity(s), spec));
  const { data: codes } = await dataAs(verified).rpc('erp_mfa_generate_recovery_codes');
  assert.equal(codes.length, 10);

  const lost = (await login(user)).session; // password only
  assert.match((await dataAs(lost).from('erp_customers').select('id')).error.message, /Two-factor verification required/);
  const used = await dataAs(lost).rpc('erp_mfa_use_recovery_code', { p_code: codes[0].code });
  assert.equal(used.data, 'ok');
  const after = await resolveSession(deps, (await login(user)).token);
  assert.equal(after.nextLevel, 'aal1');
});

test('signed session hints: valid, expired, tampered, wrong secret, other session', async () => {
  const secret = 'hint-secret';
  const exp = Math.floor(Date.now() / 1000) + 60;
  const sid = await sessionTag('token-a');
  const value = await signHint({ aal: 'aal1', next: 'aal2', exp, sid }, secret);
  assert.deepEqual(await readHint(value, secret), { aal: 'aal1', next: 'aal2', exp, sid });
  assert.equal(await readHint(value, 'other'), null);
  assert.equal(await readHint(value.replace(/^./, (c) => (c === 'e' ? 'f' : 'e')), secret), null);
  const expired = await signHint({ aal: 'aal2', next: 'aal2', exp: 1, sid }, secret);
  assert.equal(await readHint(expired, secret), null);
  assert.equal(await readHint(undefined, secret), null);
  // Bound to its session cookie: another token (or a made-up cookie) does not match.
  assert.ok(await readHint(value, secret, undefined, { sessionToken: 'token-a' }));
  assert.equal(await readHint(value, secret, undefined, { sessionToken: 'token-b' }), null);
  // API routes: signature and session only, expiry is the route's to check.
  assert.ok(await readHint(expired, secret, undefined, { sessionToken: 'token-a', ignoreExpiry: true }));
  assert.equal(await readHint(expired, secret, undefined, { sessionToken: 'token-b', ignoreExpiry: true }), null);
  // Hints from before they named their session are refused.
  assert.equal(await readHint(await signHint({ aal: 'aal1', next: 'aal1', exp }, secret), secret), null);
});

// ─── Idle limits by role and shared computers (20261012000052) ─────────────

const at = (ms) => ({ ...deps, now: () => Date.now() + ms });
const HOUR = 60 * 60 * 1000;

test('idle limits: 12 hours, 8 for company owners / admin / finance, 15 minutes on a shared computer', async () => {
  // Owning only the personal workspace (every account does) is not privileged.
  const staff = await createUser();
  const staffLogin = await login(staff);
  assert.equal(staffLogin.session.idleMs, SESSION_IDLE_MS);
  assert.ok(await resolveSession(at(9 * HOUR), staffLogin.token), 'standard: still signed in after 9 hours');
  assert.equal(await resolveSession(at(SESSION_IDLE_MS + 60_000), staffLogin.token), null);

  // A company ERP: its owner and its finance member get 8 hours.
  const owner = await createUser();
  const finance = await createUser();
  const { rows: [ws] } = await db.query(
    `insert into public.erp_workspaces (owner_id, name, is_personal) values ($1, 'PT Batu', false) returning id`,
    [owner.id]
  );
  await db.query(
    `insert into public.erp_workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'finance')
     on conflict do nothing`,
    [ws.id, owner.id, finance.id]
  );
  for (const user of [owner, finance]) {
    const { token, session } = await login(user);
    assert.equal(session.idleMs, PRIVILEGED_IDLE_MS, user.email);
    assert.ok(await resolveSession(at(7 * HOUR), token), 'still signed in after 7 hours');
    assert.equal(await resolveSession(at(PRIVILEGED_IDLE_MS + 60_000), token), null, 'signed out after 8 hours');
  }
  // A removed member is standard again.
  await db.query(`update public.erp_workspace_members set status = 'removed' where user_id = $1`, [finance.id]);
  assert.equal((await login(finance)).session.idleMs, SESSION_IDLE_MS);

  // "This is a shared computer": 15 minutes, whatever the role.
  const shared = await signIn(deps, { email: owner.email, password: owner.password, ip: '198.51.100.7', userAgent: 'kiosk', shared: true });
  assert.equal(shared.session.shared, true);
  assert.equal(shared.session.idleMs, SHARED_IDLE_MS);
  assert.ok(await resolveSession(at(10 * 60_000), shared.token), 'still signed in after 10 minutes');
  assert.equal(await resolveSession(at(SHARED_IDLE_MS + 60_000), shared.token), null, 'signed out after 15 minutes');
  assert.equal((await login(owner)).session.shared, false, 'other sessions are not shared');
});

// ─── Password change ────────────────────────────────────────────────────────

const change = (session, currentPassword, newPassword, ip = '198.51.100.9') => changePassword(deps, session, { currentPassword, newPassword, ip });

test('changing the password: only the hash changes, other devices are signed out, this one continues', async () => {
  const user = await createUser('old password 123');
  const here = await login(user);
  const elsewhere = await login(user);
  const identity = `select email, raw_user_meta_data, email_confirmed_at, created_at, banned_until from auth.users where id = $1`;
  const workspaces = `select workspace_id, role, status from public.erp_workspace_members where user_id = $1 order by workspace_id`;
  const before = { user: (await db.query(identity, [user.id])).rows, members: (await db.query(workspaces, [user.id])).rows };
  assert.equal(before.members.length, 1, 'personal workspace exists');

  const result = await change(here.session, 'old password 123', 'brand new passphrase');
  assert.equal(result.ok, true);
  assert.notEqual(result.token, here.token);

  assert.equal(await resolveSession(deps, here.token), null, 'the old cookie token is retired');
  assert.equal((await resolveSession(deps, result.token)).sessionId, here.session.sessionId, 'same session, new token');
  assert.equal(await resolveSession(deps, elsewhere.token), null, 'other devices are signed out');

  assert.deepEqual(await login(user, 'old password 123', '198.51.100.20'), { ok: false, reason: 'invalid' });
  assert.equal((await login(user, 'brand new passphrase')).ok, true);

  const stored = (await db.query('select encrypted_password from auth.users where id = $1', [user.id])).rows[0].encrypted_password;
  assert.match(stored, /^\$2[ab]\$12\$/, 'bcrypt, cost 12');
  assert.ok(!stored.includes('brand new passphrase'));
  assert.deepEqual((await db.query(identity, [user.id])).rows, before.user, 'email and profile unchanged');
  assert.deepEqual((await db.query(workspaces, [user.id])).rows, before.members, 'workspace membership and role unchanged');
});

test('changing the password: wrong current password, same password and weak passwords are refused', async () => {
  const user = await createUser('current pass 42');
  const { session } = await login(user);
  assert.deepEqual(await change(session, 'not it', 'another passphrase'), { ok: false, reason: 'invalid' });
  assert.deepEqual(await change(session, 'current pass 42', 'current pass 42'), { ok: false, reason: 'same_password' });
  for (const weak of ['short', '123456789', 'x'.repeat(73), 'é'.repeat(37)]) {
    await assert.rejects(change(session, 'current pass 42', weak), (e) => e instanceof AuthError && e.code === 'weak_password' && e.status === 422);
  }
  assert.equal((await login(user)).ok, true, 'password unchanged after refusals');
});

test('changing the password counts towards the lockout and needs the second step once 2FA is on', async () => {
  const user = await createUser('lock me out 1');
  const { session } = await login(user);
  for (let i = 0; i < 5; i += 1) await change(session, `wrong ${i}`, 'whatever passphrase');
  assert.deepEqual(await change(session, 'lock me out 1', 'whatever passphrase'), { ok: false, reason: 'rate_limited' });

  const guarded = await createUser('two factor pw');
  const s1 = await login(guarded);
  const phone = await enrollFactor(deps, s1.session, 'Phone');
  const { token } = await verifyFactor(deps, s1.session, phone.id, codeFor(phone.secret));
  const passwordOnly = (await login(guarded)).session;
  await assert.rejects(change(passwordOnly, 'two factor pw', 'new two factor pw'), (e) => e instanceof AuthError && e.code === 'insufficient_aal');
  assert.equal((await change(await resolveSession(deps, token), 'two factor pw', 'new two factor pw')).ok, true);
});

// ─── No self sign-up ────────────────────────────────────────────────────────

test('no self sign-up: neither the sign-in role nor the app roles can create an account', async () => {
  const before = (await db.query('select count(*)::int as n from auth.users')).rows[0].n;
  for (const role of ['etna_auth', 'etna_app', 'anon', 'authenticated']) {
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.exec(`set local role ${role}`);
        await tx.query(`insert into auth.users (email, encrypted_password) values ('walk-in@example.test', 'x')`);
      }),
      /permission denied/,
      `${role} cannot insert into auth.users`
    );
  }
  // The sign-in role still does its job: sign in, and update its own columns.
  const user = await createUser();
  assert.equal((await login(user)).ok, true);

  // Signed-in users cannot reach auth.users or the admin helpers through the data API.
  const identity = { userId: user.id, email: user.email, aal: 'aal1' };
  const data = new RestClient((spec) => executeSpec(deps.executor, identity, spec));
  assert.ok((await data.from('users').insert({ email: 'walk-in@example.test' })).error);
  assert.ok((await data.rpc('create_user', { p_email: 'walk-in@example.test' })).error);
  assert.equal((await db.query('select count(*)::int as n from auth.users')).rows[0].n, before + 1, 'only the admin-created account was added');
});

test('workspace access codes still onboard an existing account (they never create one)', async () => {
  const owner = await createUser();
  const invitee = await createUser();
  const dataAs = (u) => new RestClient((spec) => executeSpec(deps.executor, { userId: u.id, email: u.email, aal: 'aal1' }, spec));
  const { data: mine } = await dataAs(owner).rpc('erp_my_workspaces');
  const workspaceId = mine[0].workspace_id;
  const { data: invite, error } = await dataAs(owner).rpc('erp_create_workspace_invitation', {
    p_workspace_id: workspaceId, p_role: 'finance', p_expires_in_hours: 24, p_label: '',
  });
  assert.equal(error, null);
  const code = (Array.isArray(invite) ? invite[0] : invite).access_code;
  const { data: redeemed } = await dataAs(invitee).rpc('erp_redeem_workspace_invitation', { p_code: code });
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.role, 'finance');
  assert.equal(redeemed.workspace_id, workspaceId);
});
