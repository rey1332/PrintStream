import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, runOnPath, admin, expectError, items } from './harness.mjs';

let db;
before(async () => { db = await createDb(); });

const create = async (user, name) => (await run(db, user, `select erp_create_erp($1) as id`, [name]))[0].id;
const mine = (user) => run(db, user, `select * from erp_my_workspaces()`);
const invoiceIn = async (user, ws, amount) =>
  (await run(db, user, `select erp_create_invoice_v5($1, null, 'Budi', current_date, current_date + 7, $2, 0, null, null) as id`, [ws, amount]))[0].id;

test('creating an ERP: the creator is its Owner; it is not their personal ERP', async () => {
  const user = await createUser(db, 'creator');
  const ws = await create(user, '  PT Cabang Dua  ');
  const rows = await mine(user);
  const created = rows.find((r) => r.workspace_id === ws);
  assert.equal(created.name, 'PT Cabang Dua');
  assert.equal(created.role, 'owner');
  assert.equal(created.is_owner, true);
  assert.equal(created.is_personal, false);
  assert.equal(created.owner_email, user.email, 'shown as owned by the creator');
  assert.equal(created.is_owner && !created.is_personal, true, 'deletable: owned, not personal');
  const personal = rows.find((r) => r.is_personal);
  assert.equal(personal.is_owner && !personal.is_personal, false);
  assert.equal(rows.filter((r) => r.is_personal).length, 1);

  // The internal account behind it can never sign in and is hidden from administrators.
  const [container] = await admin(db, `select u.encrypted_password, u.banned_until = 'infinity' as blocked, u.email
    from auth.users u join erp_workspaces w on w.owner_id = u.id where w.id = $1`, [ws]);
  assert.equal(container.encrypted_password, null);
  assert.equal(container.blocked, true);
  assert.match(container.email, /@container\.etna\.invalid$/);
  const listed = await admin(db, `select email from etna_admin.users`);
  assert.ok(!listed.some((r) => r.email === container.email));
  assert.ok(listed.some((r) => r.email === user.email));

  // Members are the people, not the internal account.
  const members = await run(db, user, `select email, role from erp_list_workspace_members($1)`, [ws]);
  assert.deepEqual(members, [{ email: user.email, role: 'owner' }]);

  await expectError(run(db, user, `select erp_create_erp('   ')`), /Give the ERP a name/);
});

test('each created ERP keeps its own books, numbering and warehouse', async () => {
  const user = await createUser(db, 'books');
  const [{ workspace_id: personal }] = (await mine(user)).filter((r) => r.is_personal);
  const branch = await create(user, 'Branch');

  await invoiceIn(user, personal, 100);
  await invoiceIn(user, branch, 250);
  await invoiceIn(user, branch, 50);

  const journals = await admin(db, `select workspace_id, array_agg(entry_no order by entry_no) as nos
    from erp_journal_entries where workspace_id = any($1::uuid[]) group by 1`, [[personal, branch]]);
  const byWs = Object.fromEntries(journals.map((r) => [r.workspace_id, r.nos]));
  assert.deepEqual(byWs[personal], [1]);
  assert.deepEqual(byWs[branch], [1, 2], 'journal numbers start at 1 in each ERP');

  const [personalTb] = await run(db, user, `select sum(debit)::float as d from erp_trial_balance($1, null, null)`, [personal]);
  const [branchTb] = await run(db, user, `select sum(debit)::float as d from erp_trial_balance($1, null, null)`, [branch]);
  assert.equal(personalTb.d, 100);
  assert.equal(branchTb.d, 300);

  // Writing master data as the Owner, on behalf of the ERP (the app's writeOwner).
  const [{ owner_id }] = (await mine(user)).filter((r) => r.workspace_id === branch);
  await run(db, user, `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'Branch customer')`, [owner_id, branch]);
  const customers = await run(db, user, `select name from erp_customers where workspace_id = $1`, [branch]);
  assert.deepEqual(customers, [{ name: 'Branch customer' }]);

  const warehouses = await admin(db, `select count(*)::int as n from erp_warehouses where workspace_id = $1 and is_default`, [branch]);
  const [{ id: product }] = await run(db, user, `insert into erp_products (user_id, workspace_id, name, current_stock) values ($1, $2, 'Thing', 5) returning id`, [owner_id, branch]);
  assert.ok(product);
  const after = await admin(db, `select count(*)::int as n from erp_warehouses where workspace_id = $1 and is_default`, [branch]);
  assert.ok(after[0].n === 1 && warehouses[0].n <= 1, 'one default warehouse per ERP');
});

test("the Owner of a created ERP sets its base currency; an admin cannot", async () => {
  const owner = await createUser(db, 'fx-owner');
  const ws = await create(owner, 'Export branch');
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'admin', 24, '')`, [ws]);
  const helper = await createUser(db, 'fx-admin');
  await run(db, helper, `select erp_redeem_workspace_invitation($1)`, [access_code]);

  const flags = async (user) => (await run(db, user, `select can_change_base from erp_currency_settings_get($1)`, [ws]))[0].can_change_base;
  assert.equal(await flags(owner), true);
  assert.equal(await flags(helper), false);

  const [{ p }] = await run(db, owner, `select erp_currency_preview($1) as p`, [ws]);
  await run(db, owner, `select erp_confirm_base_currency($1, 'USD', $2::bigint)`, [ws, p.base_rows ?? 0]);
  const [{ base_currency }] = await run(db, owner, `select base_currency from erp_currency_settings_get($1)`, [ws]);
  assert.equal(base_currency, 'USD');
  await expectError(run(db, helper, `select erp_confirm_base_currency($1, 'EUR', 0)`, [ws]), /Only the workspace owner/);
});

test('the limit counts created and joined ERPs together', async () => {
  const user = await createUser(db, 'limit-create');
  await create(user, 'Second');
  await create(user, 'Third');
  await expectError(create(user, 'Fourth'), /maximum of 3 ERPs/);

  const other = await createUser(db, 'limit-inviter');
  const [{ workspace_id: theirs }] = await mine(other);
  const [{ access_code }] = await run(db, other, `select access_code from erp_create_workspace_invitation($1, 'sales', 24, '')`, [theirs]);
  const [{ r }] = await run(db, user, `select erp_redeem_workspace_invitation($1) as r`, [access_code]);
  assert.equal(r.error, 'workspace_limit');
  const [{ q }] = await run(db, user, `select erp_my_workspace_quota() as q`);
  assert.deepEqual(q, { used: 3, limit: 3, can_join: false });
});

test('teams: others join a created ERP by invitation; its Owner cannot be removed', async () => {
  const owner = await createUser(db, 'team-owner');
  const ws = await create(owner, 'Team ERP');
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'admin', 24, '')`, [ws]);
  const helper = await createUser(db, 'team-admin');
  assert.equal((await run(db, helper, `select erp_redeem_workspace_invitation($1) as r`, [access_code]))[0].r.ok, true);
  const seen = (await mine(helper)).find((r) => r.workspace_id === ws);
  assert.equal(seen.role, 'admin');
  assert.equal(seen.is_owner, false);
  assert.equal(seen.is_owner && !seen.is_personal, false);
  assert.equal(seen.owner_email, owner.email);
  await expectError(run(db, helper, `select erp_remove_workspace_member($1, $2, 'bye')`, [ws, owner.id]), /owner cannot be removed/);

  // The Owner role decides about two-factor in its ERP.
  await expectError(run(db, { ...owner, aal: 'aal1' }, `select erp_set_workspace_require_mfa($1, true)`, [ws]), /two-factor authentication for your own account/);
  await expectError(run(db, helper, `select erp_set_workspace_require_mfa($1, false)`, [ws]), /Only the workspace owner/);
  await run(db, { ...owner, aal: 'aal2' }, `select erp_set_workspace_require_mfa($1, true)`, [ws]);
  await run(db, { ...owner, aal: 'aal2' }, `select erp_set_workspace_require_mfa($1, false)`, [ws]);
});

test('deleting: only a created ERP, only its Owner, only from the server route; everything in it goes', async () => {
  const owner = await createUser(db, 'delete-owner');
  const [{ workspace_id: personal }] = (await mine(owner)).filter((r) => r.is_personal);
  const ws = await create(owner, 'Short-lived');
  const [{ owner_id: container }] = (await mine(owner)).filter((r) => r.workspace_id === ws);

  // Some of everything: invoice and payment (ledger), stock, a purchase order, HR.
  const inv = await invoiceIn(owner, ws, 120);
  await run(db, owner, `insert into erp_payments (user_id, workspace_id, payment_type, party, amount, invoice_id) values ($1, $2, 'incoming', 'Budi', 20, $3)`, [container, ws, inv]);
  const [{ id: product }] = await run(db, owner, `insert into erp_products (user_id, workspace_id, name, current_stock) values ($1, $2, 'Thing', 0) returning id`, [container, ws]);
  const [{ id: po }] = await run(db, owner, `select erp_create_purchase_order_v3($1, null, 'Supplier', current_date, '', $2::jsonb, null, null) as id`, [ws, items([product, 2, 5])]);
  await run(db, owner, `select erp_update_purchase_order_status($1, 'approved')`, [po]);
  const [{ id: emp }] = await run(db, owner, `select erp_hr_employee_save($1, null, '{"name":"Sari"}'::jsonb) as id`, [ws]);
  await run(db, owner, `select erp_hr_clock_in($1, $2, null)`, [ws, emp]);

  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'admin', 24, '')`, [ws]);
  const helper = await createUser(db, 'delete-admin');
  await run(db, helper, `select erp_redeem_workspace_invitation($1)`, [access_code]);

  await expectError(run(db, owner, `select erp_delete_erp($1)`, [ws]), /deleted from Settings/);
  await expectError(runOnPath(db, helper, '/account/delete-erp', `select erp_delete_erp($1)`, [ws]), /Only the owner/);
  await expectError(runOnPath(db, owner, '/account/delete-erp', `select erp_delete_erp($1)`, [personal]), /cannot be deleted/);

  const [{ name }] = await runOnPath(db, owner, '/account/delete-erp', `select erp_delete_erp($1) as name`, [ws]);
  assert.equal(name, 'Short-lived');
  for (const table of ['erp_workspaces', 'erp_invoices', 'erp_payments', 'erp_journal_entries', 'erp_products', 'erp_purchase_orders', 'erp_employees', 'erp_attendance', 'erp_workspace_members']) {
    const column = table === 'erp_workspaces' ? 'id' : 'workspace_id';
    const [{ n }] = await admin(db, `select count(*)::int as n from ${table} where ${column} = $1`, [ws]);
    assert.equal(n, 0, `${table} cleared`);
  }
  assert.equal((await admin(db, `select count(*)::int as n from auth.users where id = $1`, [container]))[0].n, 0);
  assert.ok(!(await mine(helper)).some((r) => r.workspace_id === ws), 'members lose it too');
  const [{ q }] = await run(db, owner, `select erp_my_workspace_quota() as q`);
  assert.equal(q.used, 1, 'the place is free again');
  const trail = await admin(db, `select details from erp_workspace_audit_log where workspace_id = $1 and action = 'erp.deleted'`, [personal]);
  assert.deepEqual(trail.map((r) => r.details.name), ['Short-lived']);
});

test('rollback removes creating and deleting ERPs', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000001_erp_create_own_erps.sql', import.meta.url), 'utf8'));
  const [{ gone, col }] = (await d.query(`select to_regprocedure('public.erp_create_erp(text)') is null as gone,
    exists (select 1 from information_schema.columns where table_name = 'erp_workspaces' and column_name = 'created_by') as col`)).rows;
  assert.equal(gone, true);
  assert.equal(col, false);
  await d.close();
});
