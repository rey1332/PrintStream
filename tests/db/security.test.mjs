import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser as createAnyUser, run, asUser, admin, expectError } from './harness.mjs';

// These tests are about the first step of signing in: sessions start without
// two-factor (aal1) unless a test says otherwise.
const createUser = async (d, name) => ({ ...(await createAnyUser(d, name)), aal: 'aal1' });

let db;
let owner;
let member;
let workspace;

const enrollMfa = (user) =>
  admin(db, `insert into auth.mfa_factors (user_id, status) values ($1, 'verified')`, [user.id]);
const at = (user, aal) => ({ ...user, aal });

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'sec-owner');
  member = await createUser(db, 'sec-member');
  [{ workspace_id: workspace }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'sales', 24, '')`, [workspace]);
  await run(db, member, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  await run(db, owner, `insert into erp_customers (user_id, name) values ($1, 'Ana')`, [owner.id]);
});

test('users without two-factor are served as before', async () => {
  const [{ ok }] = await run(db, member, `select erp_mfa_satisfied() as ok`);
  assert.equal(ok, true);
  await run(db, member, `select erp_check_request()`);
});

test('after enrolling, every request needs a completed second factor', async () => {
  const user = await createUser(db, 'sec-mfa');
  await enrollMfa(user);
  await expectError(run(db, user, `select erp_check_request()`), /Two-factor verification required/);
  const [{ ok }] = await run(db, at(user, 'aal2'), `select erp_mfa_satisfied() as ok`);
  assert.equal(ok, true);
  await run(db, at(user, 'aal2'), `select erp_check_request()`);
  // An unverified (half-finished) enrollment does not lock the user out.
  const other = await createUser(db, 'sec-unverified');
  await admin(db, `insert into auth.mfa_factors (user_id, status) values ($1, 'unverified')`, [other.id]);
  await run(db, other, `select erp_check_request()`);
});

test('only the owner, from a two-factor session, can require two-factor', async () => {
  await expectError(run(db, member, `select erp_set_workspace_require_mfa($1, true)`, [workspace]), /Only the workspace owner/);
  await expectError(run(db, owner, `select erp_set_workspace_require_mfa($1, true)`, [workspace]), /two-factor authentication for your own account first/);
  await enrollMfa(owner);
  await run(db, at(owner, 'aal2'), `select erp_set_workspace_require_mfa($1, true)`, [workspace]);
  const [row] = await admin(db, `select require_mfa from erp_workspaces where id = $1`, [workspace]);
  assert.equal(row.require_mfa, true);
  const actions = await admin(db, `select action from erp_workspace_audit_log where workspace_id = $1 and action like 'workspace.mfa%'`, [workspace]);
  assert.deepEqual(actions.map((a) => a.action), ['workspace.mfa_required']);
});

test('in a workspace that requires two-factor, members without it lose data access', async () => {
  const read = (user) => asUser(db, user, (q) => q(`select name from erp_customers where workspace_id = $1`, [workspace]));
  assert.deepEqual(await read(member), []);
  const [sec] = await run(db, member, `select * from erp_workspace_security($1)`, [workspace]);
  assert.deepEqual(sec, { require_mfa: true, my_mfa_enrolled: false, session_aal: 'aal1', access_blocked: true });
  // Membership itself stays visible so the member can see why.
  assert.equal((await run(db, member, `select * from erp_my_workspaces()`)).length, 2);

  await enrollMfa(member);
  assert.deepEqual((await read(at(member, 'aal2'))).map((r) => r.name), ['Ana']);
  const [after] = await run(db, at(member, 'aal2'), `select access_blocked from erp_workspace_security($1)`, [workspace]);
  assert.equal(after.access_blocked, false);
});

test('owners and admins see which members have two-factor; others cannot', async () => {
  const rows = await run(db, at(owner, 'aal2'), `select user_id, mfa_enrolled from erp_list_workspace_member_security($1) order by mfa_enrolled`, [workspace]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.mfa_enrolled === true));
  await expectError(run(db, at(member, 'aal2'), `select * from erp_list_workspace_member_security($1)`, [workspace]), /not allowed/);
});

test('workspaces can be renamed by owners/admins, with an audit entry', async () => {
  await expectError(run(db, at(member, 'aal2'), `select erp_rename_workspace($1, 'Nope')`, [workspace]), /not allowed/);
  await expectError(run(db, at(owner, 'aal2'), `select erp_rename_workspace($1, '   ')`, [workspace]), /1 to 80 characters/);
  await run(db, at(owner, 'aal2'), `select erp_rename_workspace($1, '  PT Maju Jaya  ')`, [workspace]);
  const [w] = await admin(db, `select name from erp_workspaces where id = $1`, [workspace]);
  assert.equal(w.name, 'PT Maju Jaya');
  const [log] = await admin(db, `select details from erp_workspace_audit_log where workspace_id = $1 and action = 'workspace.renamed'`, [workspace]);
  assert.equal(log.details.to, 'PT Maju Jaya');
});

test('rate limits count per user and bucket and are not readable by clients', async () => {
  const user = await createUser(db, 'sec-rate');
  const hit = async () => (await run(db, user, `select api_rate_limit_hit('api', 3, 60) as ok`))[0].ok;
  assert.deepEqual([await hit(), await hit(), await hit(), await hit()], [true, true, true, false]);
  const [{ ok: other }] = await run(db, user, `select api_rate_limit_hit('export', 3, 60) as ok`);
  assert.equal(other, true, 'buckets are separate');
  const [{ ok: someoneElse }] = await run(db, member, `select api_rate_limit_hit('api', 3, 60) as ok`);
  assert.equal(someoneElse, true, 'users are separate');
  await expectError(run(db, user, `select * from api_rate_limits`), /permission denied/);
  await expectError(run(db, user, `select api_rate_limit_hit('api', 0, 60)`), /Invalid rate limit/);
});
