// Two-factor recovery codes (20261001000000_erp_mfa_recovery.sql).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser as createAnyUser, run, asUser, admin, expectError } from './harness.mjs';

// These tests are about the first step of signing in: sessions start without
// two-factor (aal1) unless a test says otherwise.
const createUser = async (d, name) => ({ ...(await createAnyUser(d, name)), aal: 'aal1' });

let db;

const enrollMfa = (user, name = 'phone') =>
  admin(db, `insert into auth.mfa_factors (user_id, friendly_name, status) values ($1, $2, 'verified')`, [user.id, name]);
const at = (user, aal) => ({ ...user, aal });
const generate = async (user) => (await run(db, at(user, 'aal2'), `select code from erp_mfa_generate_recovery_codes()`)).map((r) => r.code);
const useCode = async (user, code) => (await run(db, user, `select erp_mfa_use_recovery_code($1) as result`, [code]))[0].result;
const factorCount = async (user) => (await admin(db, `select count(*)::int as n from auth.mfa_factors where user_id = $1`, [user.id]))[0].n;

before(async () => {
  db = await createDb();
});

test('codes need two-factor on and a verified session', async () => {
  const user = await createUser(db, 'rc-gen');
  await expectError(generate(user), /Turn on two-factor authentication first/);
  await enrollMfa(user);
  await expectError(run(db, user, `select erp_mfa_generate_recovery_codes()`), /Two-factor verification required/);
  const codes = await generate(user);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
  // Only hashes are stored.
  const stored = await admin(db, `select code_hash from erp_mfa_recovery_codes where user_id = $1`, [user.id]);
  assert.equal(stored.length, 10);
  assert.ok(stored.every((r) => !codes.includes(r.code_hash) && /^[0-9a-f]{64}$/.test(r.code_hash)));
  const [status] = await run(db, at(user, 'aal2'), `select remaining from erp_mfa_recovery_status()`);
  assert.equal(status.remaining, 10);
});

test('the table is not readable through the API', async () => {
  const user = await createUser(db, 'rc-table');
  await expectError(run(db, user, `select * from erp_mfa_recovery_codes`), /permission denied/);
});

test('regenerating replaces the previous codes', async () => {
  const user = await createUser(db, 'rc-regen');
  await enrollMfa(user);
  const first = await generate(user);
  await generate(user);
  assert.equal(await useCode(user, first[0]), 'invalid');
  assert.equal(await factorCount(user), 1);
});

test('a valid code removes every device once, and is logged in each workspace', async () => {
  const user = await createUser(db, 'rc-use');
  const [{ workspace_id: workspace }] = await run(db, user, `select workspace_id from erp_my_workspaces()`);
  await enrollMfa(user, 'phone');
  await enrollMfa(user, 'tablet');
  const codes = await generate(user);

  // Password-only session: blocked everywhere except the recovery RPC.
  await expectError(run(db, user, `select erp_check_request()`), /Two-factor verification required/);
  await asUser(db, user, async (q) => {
    await q(`select set_config('request.path', '/rpc/erp_mfa_use_recovery_code', true)`);
    await q(`select erp_check_request()`);
  });

  assert.equal(await useCode(user, 'AAAAA-AAAAA'), 'invalid');
  assert.equal(await factorCount(user), 2);
  // Case, spaces and dashes do not matter.
  assert.equal(await useCode(user, ` ${codes[3].toLowerCase().replace('-', ' ')} `), 'ok');
  assert.equal(await factorCount(user), 0);
  await run(db, user, `select erp_check_request()`);

  // The used code and the rest are gone.
  assert.equal(await useCode(user, codes[3]), 'invalid');
  assert.equal(await useCode(user, codes[4]), 'invalid');
  const [status] = await run(db, user, `select remaining from erp_mfa_recovery_status()`);
  assert.equal(status.remaining, 0);

  const log = await admin(db, `select action, actor_id, details from erp_workspace_audit_log where workspace_id = $1 and action = 'member.mfa_recovered'`, [workspace]);
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_id, user.id);
  assert.equal(log[0].details.devices_removed, 2);
});

test('attempts are limited to five per window, even with a valid code', async () => {
  const user = await createUser(db, 'rc-limit');
  await enrollMfa(user);
  const codes = await generate(user);
  for (let i = 0; i < 5; i += 1) assert.equal(await useCode(user, `WRONG-${i}`), 'invalid');
  assert.equal(await useCode(user, codes[0]), 'locked');
  assert.equal(await factorCount(user), 1);
});

test('codes can be cleared when no device is left, or from a verified session', async () => {
  const user = await createUser(db, 'rc-clear');
  await enrollMfa(user);
  await generate(user);
  await expectError(run(db, user, `select erp_mfa_clear_recovery_codes()`), /Two-factor verification required/);
  await run(db, at(user, 'aal2'), `select erp_mfa_clear_recovery_codes()`);
  const [status] = await run(db, at(user, 'aal2'), `select remaining from erp_mfa_recovery_status()`);
  assert.equal(status.remaining, 0);

  await generate(user);
  await admin(db, `delete from auth.mfa_factors where user_id = $1`, [user.id]);
  await run(db, user, `select erp_mfa_clear_recovery_codes()`);
});
