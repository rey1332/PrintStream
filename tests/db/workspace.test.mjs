import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, admin, expectError, items } from './harness.mjs';

let db;
let owner;
let workspace;

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'ws-owner');
  [{ workspace_id: workspace }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
});

async function invite(user, role, { hours = 24, ws = workspace, label = '' } = {}) {
  const [row] = await run(
    db, user,
    `select invitation_id, access_code, expires_at from erp_create_workspace_invitation($1, $2, $3, $4)`,
    [ws, role, hours, label]
  );
  return row;
}

async function redeem(user, code) {
  const [row] = await run(db, user, `select erp_redeem_workspace_invitation($1) as r`, [code]);
  return row.r;
}

async function join(role) {
  const member = await createUser(db, `member-${role}`);
  const { access_code } = await invite(owner, role);
  const result = await redeem(member, access_code);
  assert.equal(result.ok, true);
  return member;
}

test('every user starts with a private personal workspace they own', async () => {
  const rows = await run(db, owner, `select role, is_owner, is_personal from erp_my_workspaces()`);
  assert.deepEqual(rows, [{ role: 'owner', is_owner: true, is_personal: true }]);
});

test('codes are random, well-formed, shown once, and stored only as a hash', async () => {
  const a = await invite(owner, 'finance', { label: 'Accountant' });
  const b = await invite(owner, 'finance');
  assert.match(a.access_code, /^ETNA-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
  assert.notEqual(a.access_code, b.access_code);

  const stored = await admin(db, `select to_jsonb(i) as row from erp_workspace_invitations i where id = $1`, [a.invitation_id]);
  const serialized = JSON.stringify(stored);
  const bare = a.access_code.replace(/^ETNA-/, '').replaceAll('-', '');
  assert.ok(!serialized.includes(bare), 'plaintext code is not stored');
  assert.match(stored[0].row.code_hash, /^[0-9a-f]{64}$/);

  // Clients cannot read the invitation table (or its hashes) directly.
  await expectError(run(db, owner, `select code_hash from erp_workspace_invitations`), /permission denied/);
  const listed = await run(db, owner, `select * from erp_list_workspace_invitations($1)`, [workspace]);
  assert.ok(listed.every((row) => !('code_hash' in row)));
  assert.equal(listed.find((row) => row.id === a.invitation_id).status, 'pending');

  // Nothing in the audit trail contains the code either.
  const audit = await admin(db, `select details::text as d from erp_workspace_audit_log where invitation_id = $1`, [a.invitation_id]);
  assert.ok(audit.length > 0 && audit.every((row) => !row.d.includes(bare)));
});

test('redeeming joins the right workspace with the invited role; codes are single-use', async () => {
  const member = await createUser(db, 'joiner');
  const intruder = await createUser(db, 'late');
  const { access_code, invitation_id } = await invite(owner, 'sales');

  const loose = access_code.toLowerCase().replaceAll('-', ' ');
  const result = await redeem(member, loose);
  assert.deepEqual(result, { ok: true, role: 'sales', workspace_id: workspace, already_member: false });

  const rows = await run(db, member, `select workspace_id, role from erp_my_workspaces() where not is_owner`);
  assert.deepEqual(rows, [{ workspace_id: workspace, role: 'sales' }]);

  assert.deepEqual(await redeem(intruder, access_code), { ok: false, error: 'invalid' });
  const [status] = await run(db, owner, `select status from erp_list_workspace_invitations($1) where id = $2`, [workspace, invitation_id]);
  assert.equal(status.status, 'redeemed');

  const actions = await admin(db, `select action from erp_workspace_audit_log where invitation_id = $1 order by created_at, action`, [invitation_id]);
  assert.deepEqual(actions.map((a) => a.action).sort(), ['invitation.created', 'invitation.redeemed', 'member.added']);
});

test('expired and revoked codes fail with the same generic error', async () => {
  const user = await createUser(db, 'too-late');
  const expired = await invite(owner, 'finance');
  await admin(db, `update erp_workspace_invitations set created_at = now() - interval '2 days', expires_at = now() - interval '1 second' where id = $1`, [expired.invitation_id]);
  assert.deepEqual(await redeem(user, expired.access_code), { ok: false, error: 'invalid' });

  const revoked = await invite(owner, 'finance');
  await run(db, owner, `select erp_revoke_workspace_invitation($1, 'Sent to wrong person')`, [revoked.invitation_id]);
  assert.deepEqual(await redeem(user, revoked.access_code), { ok: false, error: 'invalid' });
  assert.deepEqual(await redeem(user, 'ETNA-00000-00000-00000-00000'), { ok: false, error: 'invalid' });

  const listed = await run(db, owner, `select id, status from erp_list_workspace_invitations($1)`, [workspace]);
  assert.equal(listed.find((r) => r.id === expired.invitation_id).status, 'expired');
  assert.equal(listed.find((r) => r.id === revoked.invitation_id).status, 'revoked');
  // A revoke reason is optional; revoking twice is harmless.
  const unused = await invite(owner, 'finance');
  await run(db, owner, `select erp_revoke_workspace_invitation($1, '')`, [unused.invitation_id]);
  await run(db, owner, `select erp_revoke_workspace_invitation($1, '')`, [unused.invitation_id]);
});

test('repeated wrong codes are rate limited, even with a valid code afterwards', async () => {
  const guesser = await createUser(db, 'guesser');
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await redeem(guesser, `ETNA-AAAAA-AAAAA-AAAAA-AAAA${i}`)).error, 'invalid');
  }
  const { access_code } = await invite(owner, 'finance');
  assert.deepEqual(await redeem(guesser, access_code), { ok: false, error: 'rate_limited' });
  assert.equal((await run(db, guesser, `select count(*)::int as n from erp_my_workspaces() where not is_owner`))[0].n, 0);
});

test('invitations cannot grant more than the inviter may grant', async () => {
  const admin1 = await join('admin');
  const sales = await join('sales');
  await expectError(invite(admin1, 'admin'), /cannot grant this role/);
  await expectError(invite(admin1, 'owner'), /cannot grant this role/);
  const ok = await invite(admin1, 'finance');
  assert.ok(ok.access_code);
  await expectError(invite(sales, 'finance'), /not allowed to manage members/);
  await expectError(invite(owner, 'finance', { hours: 24 * 30 }), /between 1 hour and 7 days/);
  // The Viewer role is retired: nobody can be invited as or changed to it.
  await expectError(invite(owner, 'viewer'), /cannot grant this role/);
  await expectError(run(db, owner, `select erp_update_workspace_member_role($1, $2, 'viewer', '')`, [workspace, sales.id]), /cannot assign this role/);

  // A code created by an admin stops working if that admin is demoted.
  const pending = await invite(admin1, 'inventory');
  await run(db, owner, `select erp_update_workspace_member_role($1, $2, 'finance', 'Role change')`, [workspace, admin1.id]);
  const newcomer = await createUser(db, 'newcomer');
  assert.deepEqual(await redeem(newcomer, pending.access_code), { ok: false, error: 'invalid' });
});

test('outsiders cannot see workspace data; members see it according to their role', async () => {
  const [{ id: product }] = await run(db, owner, `insert into erp_products (user_id, name, current_stock) values ($1, 'Shared widget', 20) returning id`, [owner.id]);
  const [{ id: customer }] = await run(db, owner, `insert into erp_customers (user_id, name) values ($1, 'Shared customer') returning id`, [owner.id]);
  const outsider = await createUser(db, 'outsider');
  // Finance reads everything but may not change master data or orders.
  const viewer = await join('finance');

  assert.equal((await run(db, outsider, `select count(*)::int as n from erp_products where workspace_id = $1`, [workspace]))[0].n, 0);
  assert.equal((await run(db, outsider, `select count(*)::int as n from erp_products where id = $1`, [product]))[0].n, 0);
  await expectError(run(db, outsider, `select * from erp_list_workspace_members($1)`, [workspace]), /not a member/);

  assert.equal((await run(db, viewer, `select count(*)::int as n from erp_products where id = $1`, [product]))[0].n, 1);
  await expectError(run(db, viewer, `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'Nope')`, [owner.id, workspace]), /row-level security/);
  const updated = await run(db, viewer, `update erp_customers set name = 'Hacked' where id = $1 returning id`, [customer]);
  assert.equal(updated.length, 0);
  await expectError(
    run(db, viewer, `select erp_create_sales_order_v3($1, $2, null, current_date, '', $3::jsonb, null, null)`, [workspace, customer, items([product, 1])]),
    /role does not allow/
  );
  // A member cannot plant rows in the workspace under their own user id.
  await expectError(run(db, viewer, `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'Planted')`, [viewer.id, workspace]), /does not match its owner/);
});

test('role permissions are enforced by the database for each module', async () => {
  const [{ id: product }] = await run(db, owner, `insert into erp_products (user_id, name, current_stock) values ($1, 'Role widget', 50) returning id`, [owner.id]);
  const [{ id: customer }] = await run(db, owner, `insert into erp_customers (user_id, name) values ($1, 'Role customer') returning id`, [owner.id]);
  const sales = await join('sales');
  const finance = await join('finance');
  const inventory = await join('inventory');

  // Sales: customers + sales orders + invoicing, stamped with the owner's user id.
  const [{ id: salesCustomer }] = await run(db, sales, `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'By sales') returning id`, [owner.id, workspace]);
  assert.ok(salesCustomer);
  const [{ id: order }] = await run(db, sales, `select erp_create_sales_order_v3($1, $2, null, current_date, '', $3::jsonb, null, null) as id`, [workspace, customer, items([product, 5])]);
  const [so] = await admin(db, `select user_id, workspace_id, created_by from erp_sales_orders where id = $1`, [order]);
  assert.deepEqual(so, { user_id: owner.id, workspace_id: workspace, created_by: sales.id });
  const [{ id: invoice }] = await run(db, sales, `select erp_issue_invoice_from_sales_order_v2($1, null, null) as id`, [order]);
  await expectError(run(db, sales, `select erp_deliver_sales_order($1)`, [order]), /role does not allow/);
  await expectError(run(db, sales, `select erp_adjust_stock($1, 'in', 1, '')`, [product]), /role does not allow/);
  await expectError(run(db, sales, `insert into erp_payments (user_id, workspace_id, payment_type, party, amount, invoice_id) values ($1, $2, 'incoming', 'x', 1, $3)`, [owner.id, workspace, invoice]), /row-level security/);

  // Finance: payments and voids, not orders or stock.
  const [{ id: payment }] = await run(db, finance, `insert into erp_payments (user_id, workspace_id, payment_type, party, amount, invoice_id) values ($1, $2, 'incoming', 'Role customer', 10, $3) returning id`, [owner.id, workspace, invoice]);
  await run(db, finance, `select erp_void_payment($1, 'Entered by mistake')`, [payment]);
  await expectError(run(db, finance, `select erp_create_sales_order_v3($1, $2, null, current_date, '', $3::jsonb, null, null)`, [workspace, customer, items([product, 1])]), /role does not allow/);
  await expectError(run(db, finance, `insert into erp_products (user_id, workspace_id, name) values ($1, $2, 'x')`, [owner.id, workspace]), /row-level security/);

  // Inventory: stock, delivery, purchasing; no finance.
  await run(db, inventory, `select erp_adjust_stock($1, 'in', 5, 'Count')`, [product]);
  await run(db, inventory, `select erp_deliver_sales_order($1)`, [order]);
  const [{ id: po }] = await run(db, inventory, `select erp_create_purchase_order_v3($1, null, 'Vendor', current_date, '', $2::jsonb, null, null) as id`, [workspace, items([product, 2])]);
  assert.ok(po);
  await expectError(run(db, inventory, `select erp_void_invoice($1, 'Not allowed here')`, [invoice]), /role does not allow/);

  // Audit attribution names the acting member, not the owner.
  const [audit] = await admin(db, `select actor_id, changed_by from erp_audit_log where table_name = 'erp_payments' and record_id = $1 and action = 'INSERT'`, [payment]);
  assert.equal(audit.actor_id, finance.id);
  assert.equal(audit.changed_by, finance.email);
});

test('member management: role changes, removal, and leaving are audited and revoke access', async () => {
  const member = await join('inventory');
  const other = await join('sales');
  const [{ id: product }] = await run(db, owner, `insert into erp_products (user_id, name) values ($1, 'Visible') returning id`, [owner.id]);

  await expectError(run(db, other, `select erp_remove_workspace_member($1, $2, 'no')`, [workspace, member.id]), /not allowed to manage/);
  await expectError(run(db, owner, `select erp_remove_workspace_member($1, $2, 'no')`, [workspace, owner.id]), /owner cannot be removed/);

  await run(db, owner, `select erp_update_workspace_member_role($1, $2, 'finance', 'Moved teams')`, [workspace, member.id]);
  assert.equal((await run(db, member, `select role from erp_my_workspaces() where workspace_id = $1`, [workspace]))[0].role, 'finance');

  await run(db, owner, `select erp_remove_workspace_member($1, $2, 'Contract ended')`, [workspace, member.id]);
  assert.equal((await run(db, member, `select count(*)::int as n from erp_products where id = $1`, [product]))[0].n, 0);
  assert.equal((await run(db, member, `select count(*)::int as n from erp_my_workspaces() where workspace_id = $1`, [workspace]))[0].n, 0);

  await run(db, other, `select erp_remove_workspace_member($1, $2, 'Leaving')`, [workspace, other.id]);
  const trail = await run(db, owner, `select action from erp_list_workspace_audit($1, 200)`, [workspace]);
  const actions = new Set(trail.map((row) => row.action));
  for (const action of ['member.role_changed', 'member.removed', 'member.left', 'invitation.created', 'invitation.redeemed']) {
    assert.ok(actions.has(action), `audit contains ${action}`);
  }
  await expectError(run(db, other, `select * from erp_list_workspace_audit($1)`, [workspace]), /not allowed/);
});
