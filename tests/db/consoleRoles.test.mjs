import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, admin } from './harness.mjs';
import { executeSpec } from '../../src/server/db/execute.ts';
import { RestClient } from '../../src/lib/db/rest-client.ts';
import { consoleAllowed, resolveConsoleAccess } from '../../src/server/console/access.ts';
import { isServerCommand, runConsoleCommand } from '../../src/server/console/commands.ts';

let db;
let as;
const users = {};
let company;

before(async () => {
  db = await createDb();
  const executor = { transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })) };
  as = (user) => new RestClient((spec) => executeSpec(executor, { userId: user.id, email: user.email, aal: user.aal ?? 'aal1' }, spec));
  for (const name of ['owner', 'solo', 'finance', 'admin', 'sales', 'inventory', 'outsider']) users[name] = await createUser(db, `console-${name}`);
  [{ workspace_id: company }] = await run(db, users.owner, `select workspace_id from erp_my_workspaces()`);
  for (const role of ['finance', 'admin', 'sales', 'inventory']) {
    const [{ access_code }] = await run(db, users.owner, `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`, [company, role]);
    await run(db, users[role], `select erp_redeem_workspace_invitation($1)`, [access_code]);
  }
  await run(db, users.owner, `insert into erp_customers (user_id, name) values ($1, 'Owner customer')`, [users.owner.id]);
});

const access = (name, workspaceId) => resolveConsoleAccess(as(users[name]), workspaceId);

test('the rule: Finance, or Owner with at least one other active member', () => {
  assert.equal(consoleAllowed('finance', 0), true);
  assert.equal(consoleAllowed('owner', 2), true);
  assert.equal(consoleAllowed('owner', 1), false);
  for (const role of ['admin', 'sales', 'inventory', 'viewer', null, undefined, 'OWNER', ' owner']) {
    assert.equal(consoleAllowed(role, 99), false, String(role));
  }
});

test('Owner of the shared workspace and Finance members get the console there', async () => {
  assert.deepEqual(await access('owner', company), { allowed: true, role: 'owner', workspaceId: company });
  assert.deepEqual(await access('owner', undefined), { allowed: true, role: 'owner', workspaceId: company }, 'defaults to own workspace');
  assert.deepEqual(await access('finance', company), { allowed: true, role: 'finance', workspaceId: company });
});

test('other roles, solo owners and outsiders are refused, whatever workspace id they send', async () => {
  for (const name of ['admin', 'sales', 'inventory']) {
    assert.deepEqual(await access(name, company), { allowed: false }, `${name} in the shared workspace`);
    assert.deepEqual(await access(name, undefined), { allowed: false }, `${name} in their own solo workspace`);
  }
  assert.deepEqual(await access('solo', undefined), { allowed: false }, 'owner of a solo personal workspace');
  assert.deepEqual(await access('finance', undefined), { allowed: false }, 'finance member outside the shared workspace');
  assert.deepEqual(await access('outsider', company), { allowed: false }, 'non-member sending the company id');
  assert.deepEqual(await access('outsider', '00000000-0000-4000-8000-000000000000'), { allowed: false });
  assert.deepEqual(await access('outsider', "' or 1=1 --"), { allowed: false });
});

test('access follows membership changes at once (no client-side caching of the decision)', async () => {
  const temp = await createUser(db, 'console-temp');
  const [{ access_code }] = await run(db, users.owner, `select access_code from erp_create_workspace_invitation($1, 'finance', 24, '')`, [company]);
  await run(db, temp, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  assert.equal((await resolveConsoleAccess(as(temp), company)).allowed, true);
  await admin(db, `update erp_workspace_members set status = 'removed' where workspace_id = $1 and user_id = $2`, [company, temp.id]);
  assert.equal((await resolveConsoleAccess(as(temp), company)).allowed, false);
});

test('two-factor: a password-only session of a 2FA account gets no console', async () => {
  await db.query(`insert into auth.mfa_factors (user_id, friendly_name, status) values ($1, 'phone', 'verified')`, [users.finance.id]);
  assert.deepEqual(await access('finance', company), { allowed: false });
  assert.equal((await resolveConsoleAccess(as({ ...users.finance, aal: 'aal2' }), company)).allowed, true);
  await db.query(`delete from auth.mfa_factors where user_id = $1`, [users.finance.id]);
});

test('commands: allowlist only; ver and whoami reveal no paths, env or emails', async () => {
  for (const bad of ['eval', 'sql', 'shell', 'env', 'VER', '', null, {}, 'constructor', '__proto__']) assert.equal(isServerCommand(bad), false, String(bad));
  const ownerAccess = await access('owner', company);
  const ctx = { db: as(users.owner), userId: users.owner.id, displayName: 'Rayhan', access: ownerAccess, version: '0.1.0' };
  assert.deepEqual(await runConsoleCommand('ver', undefined, ctx), { ok: true, lines: ['ETNA 0.1.0'] });
  const who = await runConsoleCommand('whoami', undefined, ctx);
  assert.deepEqual(who, { ok: true, lines: ['Rayhan · Owner'] });
  assert.ok(!JSON.stringify(who).includes('@'));
});

test('data commands run as the user under RLS: nothing outside their own rows, financial records refused', async () => {
  const financeAccess = await access('finance', company);
  const ctx = (name, a) => ({ db: as(users[name]), userId: users[name].id, displayName: name, access: a, version: '0' });
  assert.deepEqual(await runConsoleCommand('delete', 'd_cust', ctx('finance', financeAccess)), { ok: true, lines: ['[OK] Deleted 0 rows.'] });
  assert.equal((await admin(db, `select count(*)::int as n from erp_customers where user_id = $1`, [users.owner.id]))[0].n, 1, "owner's rows untouched");

  const ownerAccess = await access('owner', company);
  const refused = await runConsoleCommand('delete', 'd_ts', ctx('owner', ownerAccess));
  assert.equal(refused.ok, false);
  assert.match(refused.error, /^Not allowed: transactions can only be changed through ERP actions/);
  assert.equal((await runConsoleCommand('delete', 'd_aud', ctx('owner', ownerAccess))).ok, false, 'audit log cannot be deleted');
  assert.deepEqual(await runConsoleCommand('delete', 'toString', ctx('owner', ownerAccess)), { ok: false, error: 'Unknown data command.' });
  assert.deepEqual(await runConsoleCommand('delete', 'd_cust', ctx('owner', ownerAccess)), { ok: true, lines: ['[OK] Deleted 1 rows.'] });
});
