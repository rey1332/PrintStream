import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, runOnPath, admin, expectError } from './harness.mjs';

const PATH = '/account/delete-erp';
let db;
let owner;
let finance;
let ws;
let branch;

const count = async (table, column = 'workspace_id') =>
  (await admin(db, `select count(*)::int as n from ${table} where ${column} = $1`, [ws]))[0].n;

before(async () => {
  db = await createDb();
  owner = { ...(await createUser(db, 'empty-owner')), aal: 'aal2' };
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  [{ id: branch }] = await run(db, owner, `select erp_create_erp('Branch') as id`);

  await run(db, owner, `insert into erp_customers (user_id, workspace_id, name, email) values ($1, $2, 'Budi', 'budi@x.test')`, [owner.id, ws]);
  await run(db, owner, `insert into erp_products (user_id, workspace_id, name, sku, current_stock) values ($1, $2, 'Widget', 'W', 3)`, [owner.id, ws]);
  await run(db, owner, `select erp_create_invoice_v5($1, null, 'Budi', current_date, current_date, 50, 0, null, null)`, [ws]);
  const [{ id: emp }] = await run(db, owner, `select erp_hr_employee_save($1, null, '{"name":"Sari","hourly_rate":1000}'::jsonb) as id`, [ws]);
  await run(db, owner, `select erp_hr_clock_in($1, $2, null)`, [ws, emp]);

  finance = await createUser(db, 'empty-finance');
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'finance', 24, '')`, [ws]);
  await run(db, finance, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  await run(db, owner, `select erp_create_workspace_invitation($1, 'sales', 24, '')`, [ws]);

  // Budi is synced into the branch.
  const [{ id: syncRun }] = await run(db, owner, `select erp_sync_start($1, array[$2]::uuid[], 'push', array['customers'], null) as id`, [ws, branch]);
  await run(db, owner, `select erp_sync_step($1, $2, 'customers')`, [syncRun, branch]);
  await run(db, owner, `select erp_sync_finish($1)`, [syncRun]);
});

test('only the Owner empties, only their own ERP, only from the server route', async () => {
  await expectError(run(db, owner, `select erp_empty_erp($1)`, [ws]), /emptied from ERPs & sync/);
  await expectError(runOnPath(db, finance, PATH, `select erp_empty_erp($1)`, [ws]), /Only the owner/);
  await expectError(runOnPath(db, owner, PATH, `select erp_empty_erp($1)`, [branch]), /a created ERP is deleted/);
  assert.equal(await count('erp_customers'), 1, 'nothing changed');
});

test('emptying removes everything but the ERP, its Owner and its trails', async () => {
  const [{ removed }] = await runOnPath(db, owner, PATH, `select erp_empty_erp($1) as removed`, [ws]);
  assert.equal(removed.customers, 1);
  assert.equal(removed.invoices, 1);
  assert.equal(removed.employees, 1);
  assert.equal(removed.members, 1);

  for (const table of ['erp_customers', 'erp_products', 'erp_invoices', 'erp_journal_entries', 'erp_employees',
    'erp_attendance', 'erp_stock_movements', 'erp_gl_accounts', 'erp_workspace_invitations']) {
    assert.equal(await count(table), 0, table);
  }
  assert.equal((await admin(db, `select count(*)::int as n from erp_sync_links where ws_a = $1 or ws_b = $1`, [ws]))[0].n, 0);

  // The ERP and its Owner stay; the finance member is out and has a free slot again.
  const mine = await run(db, owner, `select workspace_id, role from erp_my_workspaces() where workspace_id = $1`, [ws]);
  assert.deepEqual(mine, [{ workspace_id: ws, role: 'owner' }]);
  const theirs = await run(db, finance, `select workspace_id from erp_my_workspaces()`);
  assert.ok(!theirs.some((r) => r.workspace_id === ws));
  const [{ q }] = await run(db, finance, `select erp_my_workspace_quota() as q`);
  assert.equal(q.used, 1);

  // The copy in the branch stays; the trail says who emptied it.
  assert.equal((await admin(db, `select count(*)::int as n from erp_customers where workspace_id = $1 and name = 'Budi'`, [branch]))[0].n, 1);
  const [audit] = await admin(db, `select actor_id, details from erp_workspace_audit_log where workspace_id = $1 and action = 'erp.emptied'`, [ws]);
  assert.equal(audit.actor_id, owner.id);
  assert.equal(audit.details.removed.customers, 1);
});

test('an emptied ERP works like a new one', async () => {
  await run(db, owner, `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'New')`, [owner.id, ws]);
  await run(db, owner, `select erp_create_invoice_v5($1, null, 'New', current_date, current_date, 10, 0, null, null)`, [ws]);
  assert.equal(await count('erp_invoices'), 1);
  assert.ok((await count('erp_journal_entries')) > 0, 'the ledger is set up again');
});
