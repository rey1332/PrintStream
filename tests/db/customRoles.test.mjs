import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let ws;

// A member who signed in without two-factor (aal1).
const aal1 = (user) => ({ ...user, aal: 'aal1' });

async function join(ws, role, customId = null, inviter = owner) {
  const user = await createUser(db, `cr-${role}`);
  const [{ access_code }] = await run(db, inviter, `select access_code from erp_create_workspace_invitation_v2($1, $2, 24, '', $3)`, [ws, role, customId]);
  const [{ r }] = await run(db, user, `select erp_redeem_workspace_invitation($1) as r`, [access_code]);
  assert.equal(r.ok, true, JSON.stringify(r));
  return user;
}

const saveRole = (who, name, permissions, requiresMfa = true, id = null) =>
  run(db, who, `select erp_save_custom_role($1, $2, $3, '', $4, $5) as id`, [ws, id, name, permissions, requiresMfa]);

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'cr-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
});

test('built-in roles keep their ERP permissions and gain the TERMINAL defaults', async () => {
  const [{ owner: o, admin: a, finance: f, sales: s }] = await admin(db, `select erp_role_permissions('owner') owner, erp_role_permissions('admin') admin,
    erp_role_permissions('finance') finance, erp_role_permissions('sales') sales`);
  assert.ok(o.includes('roles.manage') && o.includes('data.sensitive'));
  assert.ok(!a.includes('roles.manage') && !a.includes('data.sensitive') && a.includes('members') && a.includes('pipelines.publish'));
  assert.ok(f.includes('payments') && f.includes('datasets.import') && !f.includes('datasets.delete'));
  assert.deepEqual(s, ['customers', 'sales', 'invoicing']);
});

test('the Owner makes a custom role; members with it get exactly its permissions, everywhere', async () => {
  const [{ id: roleId }] = await saveRole(owner, 'Gudang plus', ['products', 'inventory', 'customers', 'datasets.view']);
  const keeper = await join(ws, 'custom', roleId);
  const [{ p }] = await run(db, keeper, `select erp_my_permissions($1) as p`, [ws]);
  assert.deepEqual([...p].sort(), ['customers', 'datasets.view', 'inventory', 'products']);
  // Row-level security and ERP checks use the same permissions.
  assert.equal((await run(db, keeper, `select erp_has_permission($1, 'inventory') as ok`, [ws]))[0].ok, true);
  assert.equal((await run(db, keeper, `select erp_has_permission($1, 'payments') as ok`, [ws]))[0].ok, false);
  assert.equal((await run(db, keeper, `select erp_can_read($1, 'customers') as ok`, [ws]))[0].ok, true);
  assert.equal((await run(db, keeper, `select erp_can_read($1, 'invoices') as ok`, [ws]))[0].ok, false);
  await admin(db, `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'PT Pelanggan')`, [owner.id, ws]);
  assert.equal((await run(db, keeper, `select count(*)::int n from erp_customers where workspace_id = $1`, [ws]))[0].n, 1);
  await admin(db, `insert into erp_suppliers (user_id, workspace_id, name) values ($1, $2, 'PT Pemasok')`, [owner.id, ws]);
  assert.equal((await run(db, keeper, `select count(*)::int n from erp_suppliers where workspace_id = $1`, [ws]))[0].n, 0);
  // The app sees the role and its permissions.
  const [access] = await run(db, keeper, `select role, custom_role_name, permissions from erp_my_workspace_access() where workspace_id = $1`, [ws]);
  assert.equal(access.role, 'custom');
  assert.equal(access.custom_role_name, 'Gudang plus');
  // Changing the role changes the member's access at once.
  await saveRole(owner, 'Gudang plus', ['products', 'inventory'], true, roleId);
  assert.equal((await run(db, keeper, `select erp_can_read($1, 'customers') as ok`, [ws]))[0].ok, false);
});

test('custom roles need two-factor unless they have no sensitive permission', async () => {
  const [{ id: plain }] = await saveRole(owner, 'Kasir', ['customers', 'sales'], false);
  const [{ id: strict }] = await saveRole(owner, 'Analis', ['read', 'datasets.query']);
  await expectError(saveRole(owner, 'Bendahara', ['payments'], false), /needs two-factor/);
  const cashier = await join(ws, 'custom', plain);
  const analyst = await join(ws, 'custom', strict);
  assert.equal((await run(db, aal1(cashier), `select erp_has_permission($1, 'customers') as ok`, [ws]))[0].ok, true);
  assert.equal((await run(db, aal1(analyst), `select erp_has_permission($1, 'read') as ok`, [ws]))[0].ok, false);
  assert.equal((await run(db, analyst, `select erp_has_permission($1, 'read') as ok`, [ws]))[0].ok, true);
});

test('nobody gives more than they hold; only the Owner manages roles and makes Admins', async () => {
  const [{ id: managers }] = await saveRole(owner, 'Team lead', ['members', 'customers', 'sales', 'invoicing']);
  const lead = await join(ws, 'custom', managers);
  // A lead can invite Sales (a subset of their permissions) but not Finance or Admin.
  await run(db, lead, `select * from erp_create_workspace_invitation($1, 'sales', 24, '')`, [ws]);
  await expectError(run(db, lead, `select * from erp_create_workspace_invitation($1, 'finance', 24, '')`, [ws]), /cannot grant/);
  await expectError(run(db, lead, `select * from erp_create_workspace_invitation($1, 'admin', 24, '')`, [ws]), /cannot grant/);
  // ...nor a custom role broader than theirs.
  const [{ id: broad }] = await saveRole(owner, 'Broad', ['customers', 'payments']);
  await expectError(run(db, lead, `select * from erp_create_workspace_invitation_v2($1, 'custom', 24, '', $2)`, [ws, broad]), /cannot grant/);
  // Admins invite but cannot make Admins or manage roles.
  const adminUser = await join(ws, 'admin');
  await expectError(run(db, adminUser, `select * from erp_create_workspace_invitation($1, 'admin', 24, '')`, [ws]), /cannot grant/);
  await expectError(saveRole(adminUser, 'Mine', ['customers']), /not allowed to manage roles/);
  await expectError(saveRole(lead, 'Mine', ['customers']), /not allowed to manage roles/);
  // A role manager without the Owner's rights cannot create broader roles.
  const [{ id: roleAdmins }] = await saveRole(owner, 'Role admin', ['roles.manage', 'members', 'customers']);
  const ra = await join(ws, 'custom', roleAdmins);
  await saveRole(ra, 'Narrow', ['customers']);
  await expectError(saveRole(ra, 'Wide', ['customers', 'payments']), /permissions you do not have/);
  await expectError(run(db, aal1(ra), `select erp_save_custom_role($1, null, 'x', '', array['customers'], true)`, [ws]), /Two-factor|not allowed/);
  // Changing someone's role needs both the old and the new role within reach.
  const seller = await join(ws, 'sales');
  await expectError(run(db, lead, `select erp_update_workspace_member_role($1, $2, 'finance')`, [ws, seller.id]), /cannot assign/);
  await expectError(run(db, lead, `select erp_update_workspace_member_role($1, $2, 'sales')`, [ws, adminUser.id]), /cannot assign/);
  await run(db, owner, `select erp_update_workspace_member_role_v2($1, $2, 'custom', 'promotion', $3)`, [ws, seller.id, managers]);
  const [m] = await admin(db, `select role, custom_role_id from erp_workspace_members where workspace_id = $1 and user_id = $2`, [ws, seller.id]);
  assert.deepEqual([m.role, m.custom_role_id], ['custom', managers]);
  // A code made by someone who lost the right to give the role no longer works.
  const [{ access_code }] = await run(db, lead, `select access_code from erp_create_workspace_invitation($1, 'sales', 24, '')`, [ws]);
  await saveRole(owner, 'Team lead', ['customers'], true, managers);
  const late = await createUser(db, 'cr-late');
  const [{ r }] = await run(db, late, `select erp_redeem_workspace_invitation($1) as r`, [access_code]);
  assert.equal(r.ok, false);
});

test('a role in use cannot be deleted; deleting keeps the history', async () => {
  const [{ id: temp }] = await saveRole(owner, 'Temp', ['customers']);
  const member = await join(ws, 'custom', temp);
  await run(db, owner, `select * from erp_create_workspace_invitation_v2($1, 'custom', 24, '', $2)`, [ws, temp]);
  await expectError(run(db, owner, `select erp_delete_custom_role($1, $2)`, [ws, temp]), /still have this role/);
  await run(db, owner, `select erp_remove_workspace_member($1, $2, 'left')`, [ws, member.id]);
  await run(db, owner, `select erp_delete_custom_role($1, $2)`, [ws, temp]);
  const [left] = await admin(db, `select role, status from erp_workspace_members where workspace_id = $1 and user_id = $2`, [ws, member.id]);
  assert.deepEqual([left.role, left.status], ['viewer', 'removed']);
  const open = await admin(db, `select count(*)::int n from erp_workspace_invitations where workspace_id = $1 and role = 'viewer' and revoked_at is not null`, [ws]);
  assert.ok(open[0].n >= 1);
  const actions = await admin(db, `select action from erp_workspace_audit_log where workspace_id = $1 and action like 'role.%' order by created_at`, [ws]);
  assert.ok(actions.some((a) => a.action === 'role.created') && actions.some((a) => a.action === 'role.deleted'));
  // Unknown permissions never get in.
  await expectError(saveRole(owner, 'Bogus', ['customers', 'drop.database']), /Unknown permission/);
});

test('other workspaces never see or use a workspace\'s roles', async () => {
  const stranger = await createUser(db, 'cr-stranger');
  const [{ workspace_id: theirs }] = await run(db, stranger, `select workspace_id from erp_my_workspaces() where is_personal`);
  const [{ id: mine }] = await saveRole(owner, 'Private role', ['customers']);
  assert.equal((await run(db, stranger, `select count(*)::int n from erp_custom_roles where id = $1`, [mine]))[0].n, 0);
  await expectError(run(db, stranger, `select * from erp_create_workspace_invitation_v2($1, 'custom', 24, '', $2)`, [theirs, mine]), /cannot grant/);
  await expectError(run(db, stranger, `select * from erp_list_custom_roles($1)`, [ws]), /not a member/);
});

test('rollback restores the five fixed roles', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000030_workspace_custom_roles.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select to_regclass('public.erp_custom_roles') is null as gone,
    erp_role_permissions('owner') = array['read','customers','suppliers','products','inventory','sales','invoicing','fulfillment','purchasing','receiving','payments','members','audit'] as owner_back,
    to_regprocedure('public.erp_create_workspace_invitation_v2(uuid,text,integer,text,uuid)') is null as v2_gone,
    position('erp_grantable_roles' in pg_get_functiondef('public.erp_create_workspace_invitation(uuid,text,integer,text)'::regprocedure)) > 0 as old_invite`);
  assert.deepEqual(rows[0], { gone: true, owner_back: true, v2_gone: true, old_invite: true });
  await d.close();
});
