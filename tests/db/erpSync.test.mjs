import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, runOnPath, admin, expectError, items } from './harness.mjs';

let db;
let owner;
let a; // the owner's personal ERP
let b; // an ERP they created
let ownerA;
let ownerB;
let nameA;

const ENTITY_ORDER = ['customers', 'suppliers', 'products', 'stock', 'sales_orders', 'purchase_orders', 'invoices', 'payments'];

async function sync(user, source, targets, direction, entities, since = null) {
  const [{ id }] = await run(db, user, `select erp_sync_start($1, $2::uuid[], $3, $4::text[], $5::date) as id`, [
    source, targets, direction, entities, since,
  ]);
  const steps = {};
  for (const target of targets) {
    steps[target] = {};
    for (const entity of ENTITY_ORDER.filter((e) => entities.includes(e))) {
      const [{ c }] = await run(db, user, `select erp_sync_step($1, $2, $3) as c`, [id, target, entity]);
      steps[target][entity] = c;
    }
  }
  const [{ f }] = await run(db, user, `select erp_sync_finish($1) as f`, [id]);
  return { id, steps, finish: f };
}

const customers = (ws) =>
  admin(db, `select name, email, phone, city from erp_customers where workspace_id = $1 order by name`, [ws]);
const product = async (ws, sku) =>
  (await admin(db, `select id, name, purchase_price::float8 as purchase, selling_price::float8 as selling, current_stock::float8 as current_stock
    from erp_products where workspace_id = $1 and sku = $2`, [ws, sku]))[0];

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'sync-owner');
  [{ workspace_id: a }] = (await run(db, owner, `select * from erp_my_workspaces()`)).filter((r) => r.is_personal);
  [{ id: b }] = await run(db, owner, `select erp_create_erp('Cabang') as id`);
  [{ owner_id: ownerA, name: nameA }] = await admin(db, `select owner_id, name from erp_workspaces where id = $1`, [a]);
  [{ owner_id: ownerB }] = await admin(db, `select owner_id from erp_workspaces where id = $1`, [b]);
});

test('customers: copied to the target, paired by e-mail, never duplicated', async () => {
  await run(db, owner, `insert into erp_customers (user_id, workspace_id, name, email) values ($1, $2, 'Budi', 'budi@shop.test')`, [ownerA, a]);
  await run(db, owner, `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'Sari')`, [ownerA, a]);
  // Already in the target under another name, same e-mail (any case): the same customer.
  await run(db, owner, `insert into erp_customers (user_id, workspace_id, name, email) values ($1, $2, 'Budi Santoso', 'budi@shop.test')`, [ownerB, b]);
  await run(db, owner, `insert into erp_customers (user_id, workspace_id, name, email) values ($1, $2, 'Andi', ' ANDI@shop.test')`, [ownerB, b]);
  await run(db, owner, `insert into erp_customers (user_id, workspace_id, name, email) values ($1, $2, 'Andi K', 'andi@shop.test')`, [ownerA, a]);

  const first = await sync(owner, a, [b], 'push', ['customers']);
  const c = first.steps[b].customers;
  assert.deepEqual([c.ok, c.skipped, c.failed], [2, 1, 0], JSON.stringify(c));
  assert.deepEqual((await customers(b)).map((r) => [r.name, r.email]), [
    ['Andi K', 'andi@shop.test'], ['Budi Santoso', 'budi@shop.test'], ['Sari', ''],
  ]);
  assert.equal(first.finish.status, 'success');

  const again = await sync(owner, a, [b], 'push', ['customers']);
  assert.deepEqual([again.steps[b].customers.ok, again.steps[b].customers.skipped], [0, 3]);
  assert.equal((await customers(b)).length, 3);
});

test('last write wins per column, in the directions the sync allows', async () => {
  await run(db, owner, `update erp_customers set phone = '0811' where workspace_id = $1 and name = 'Budi'`, [a]);
  await run(db, owner, `update erp_customers set city = 'Bandung' where workspace_id = $1 and name = 'Budi Santoso'`, [b]);
  await sync(owner, a, [b], 'both', ['customers']);
  const [inA] = (await customers(a)).filter((r) => r.email === 'budi@shop.test');
  const [inB] = (await customers(b)).filter((r) => r.email === 'budi@shop.test');
  assert.deepEqual(inA, { name: 'Budi Santoso', email: 'budi@shop.test', phone: '0811', city: 'Bandung' });
  assert.deepEqual(inB, inA);

  // A push never overwrites a newer change in the target.
  await run(db, owner, `update erp_customers set name = 'Old name' where workspace_id = $1 and email = 'budi@shop.test'`, [a]);
  await run(db, owner, `update erp_customers set name = 'New name' where workspace_id = $1 and email = 'budi@shop.test'`, [b]);
  await sync(owner, a, [b], 'push', ['customers']);
  assert.equal((await customers(b)).find((r) => r.email === 'budi@shop.test').name, 'New name');
  assert.equal((await customers(a)).find((r) => r.email === 'budi@shop.test').name, 'Old name');
  // A pull brings it back.
  await sync(owner, a, [b], 'pull', ['customers']);
  assert.equal((await customers(a)).find((r) => r.email === 'budi@shop.test').name, 'New name');

  // Deletions are not synced.
  await admin(db, `delete from erp_customers where workspace_id = $1 and name = 'Sari'`, [a]);
  await sync(owner, a, [b], 'push', ['customers']);
  assert.ok((await customers(b)).some((r) => r.name === 'Sari'));
});

test('products: prices converted with the target ERP rate, or skipped without one', async () => {
  await run(db, owner, `select erp_accounting_settings_set($1, 'IDR', null, 0)`, [b]);
  await run(db, owner, `insert into erp_products (user_id, workspace_id, name, sku, purchase_price, selling_price, current_stock)
    values ($1, $2, 'Widget', 'W-1', 10, 20, 5)`, [ownerA, a]);

  const noRate = await sync(owner, a, [b], 'push', ['products']);
  assert.equal(noRate.steps[b].products.skipped, 1);
  assert.match(noRate.steps[b].products.messages[0].message, /exchange rate/);
  assert.equal(await product(b, 'W-1'), undefined);

  await run(db, owner, `select erp_add_exchange_rate($1, 'USD', 'IDR', 16000, current_date, 'test')`, [b]);
  const ok = await sync(owner, a, [b], 'push', ['products']);
  assert.equal(ok.steps[b].products.ok, 1);
  const copy = await product(b, 'W-1');
  assert.deepEqual([copy.purchase, copy.selling, copy.current_stock], [160000, 320000, 0], 'stock is its own kind');

  // A price changed in the target comes back in A's currency once A has a rate.
  await run(db, owner, `update erp_products set selling_price = 400000 where id = $1`, [copy.id]);
  const pulledNoRate = await sync(owner, a, [b], 'pull', ['products']);
  assert.match(JSON.stringify(pulledNoRate.steps[b].products.messages), /exchange rate/);
  assert.equal((await product(a, 'W-1')).selling, 20);
  await run(db, owner, `select erp_add_exchange_rate($1, 'USD', 'IDR', 16000, current_date, 'test')`, [a]);
  await sync(owner, a, [b], 'pull', ['products']);
  assert.equal((await product(a, 'W-1')).selling, 25);
});

test('stock: the most recent level wins, applied as a stock adjustment', async () => {
  const pushed = await sync(owner, a, [b], 'push', ['stock']);
  assert.equal(pushed.steps[b].stock.ok, 1);
  const copy = await product(b, 'W-1');
  assert.equal(copy.current_stock, 5);
  const [move] = await admin(db, `select movement_type::text as t, quantity::float8 as quantity, note from erp_stock_movements where product_id = $1`, [copy.id]);
  assert.deepEqual(move, { t: 'in', quantity: 5, note: `Stock synced from ${nameA}` });
  assert.equal((await admin(db, `select count(*)::int as n from erp_warehouse_stock where product_id = $1 and quantity = 5`, [copy.id]))[0].n, 1);

  await admin(db, `update erp_products set current_stock = 7 where id = $1`, [copy.id]);
  await sync(owner, a, [b], 'both', ['stock']);
  assert.equal((await product(a, 'W-1')).current_stock, 7);

  // Products that are only in one ERP are skipped with a reason.
  await run(db, owner, `insert into erp_products (user_id, workspace_id, name, sku) values ($1, $2, 'Gadget', 'G-1')`, [ownerA, a]);
  const skipped = await sync(owner, a, [b], 'push', ['stock']);
  assert.match(JSON.stringify(skipped.steps[b].stock.messages), /sync products first/);
});

test('orders are copied once as drafts; invoices and payments wait in the inbox', async () => {
  const [{ id: budi }] = await admin(db, `select id from erp_customers where workspace_id = $1 and email = 'budi@shop.test'`, [a]);
  const widget = (await product(a, 'W-1')).id;
  await run(db, owner, `select erp_create_sales_order_v3($1, $2, 'Budi', current_date, 'rush', $3::jsonb, null, null)`, [a, budi, items([widget, 2, 20])]);
  const [{ id: inv }] = await run(db, owner,
    `select erp_create_invoice_v5($1, $2, 'Budi', current_date, current_date + 7, 100, 0, null, null) as id`, [a, budi]);
  await run(db, owner, `insert into erp_payments (user_id, workspace_id, payment_type, party, amount, payment_date, invoice_id)
    values ($1, $2, 'incoming', 'Budi', 40, current_date, $3)`, [ownerA, a, inv]);

  const kinds = ['sales_orders', 'invoices', 'payments'];
  const first = await sync(owner, a, [b], 'push', kinds, null);
  assert.deepEqual(kinds.map((k) => first.steps[b][k].ok), [1, 1, 1], JSON.stringify(first.steps));

  const [so] = await admin(db, `select so.status::text as status, so.currency, so.notes, i.qty::float8 as qty, i.product_id, so.customer_id
    from erp_sales_orders so join erp_sales_order_items i on i.sales_order_id = so.id where so.workspace_id = $1`, [b]);
  assert.equal(so.status, 'draft');
  assert.equal(so.currency, 'USD', 'the order keeps its currency; B values it with its own rate');
  assert.equal(so.notes, `rush\nSynced from ${nameA}`);
  assert.equal(so.product_id, (await product(b, 'W-1')).id);
  assert.equal(so.customer_id, (await admin(db, `select id from erp_customers where workspace_id = $1 and email = 'budi@shop.test'`, [b]))[0].id);
  assert.equal((await admin(db, `select count(*)::int as n from erp_invoices where workspace_id = $1`, [b]))[0].n, 0, 'no journal before posting');

  const again = await sync(owner, a, [b], 'both', kinds, null);
  assert.deepEqual(kinds.map((k) => again.steps[b][k].ok), [0, 0, 0], 'copied once, never copied back');
  assert.equal((await admin(db, `select count(*)::int as n from erp_sales_orders where workspace_id = $1`, [a]))[0].n, 1);

  const inbox = await run(db, owner, `select id, kind, status, source_name from erp_sync_inbox_list($1)`, [b]);
  assert.equal(inbox.length, 2);
  const invItem = inbox.find((r) => r.kind === 'invoice');
  const payItem = inbox.find((r) => r.kind === 'payment');
  assert.equal(invItem.source_name, nameA);
  await expectError(run(db, owner, `select erp_sync_inbox_post($1, null)`, [payItem.id]), /Post the invoice of this payment first/);

  const [{ id: postedInv }] = await run(db, owner, `select erp_sync_inbox_post($1, null) as id`, [invItem.id]);
  const [binv] = await admin(db, `select total::float8 as total, currency, fx_rate::float8 as rate from erp_invoices where id = $1`, [postedInv]);
  assert.deepEqual(binv, { total: 100, currency: 'USD', rate: 16000 });
  const [{ id: postedPay }] = await run(db, owner, `select erp_sync_inbox_post($1, null) as id`, [payItem.id]);
  const [bpay] = await admin(db, `select invoice_id, amount::float8 as amount from erp_payments where id = $1`, [postedPay]);
  assert.deepEqual(bpay, { invoice_id: postedInv, amount: 40 });
  await expectError(run(db, owner, `select erp_sync_inbox_post($1, null)`, [invItem.id]), /already handled/);

  // Posted documents are not copied back the other way either.
  const back = await sync(owner, b, [a], 'push', ['invoices', 'payments'], null);
  assert.deepEqual([back.steps[a].invoices.ok, back.steps[a].payments.ok], [0, 0]);
});

test('only an owner or admin of every ERP syncs; excluded ERPs cannot be chosen', async () => {
  const finance = await createUser(db, 'sync-finance');
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'finance', 24, '')`, [b]);
  await run(db, finance, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  const [{ workspace_id: financeOwn }] = await run(db, finance, `select workspace_id from erp_my_workspaces() where is_personal`);

  await expectError(sync(finance, financeOwn, [b], 'push', ['customers']), /owner or admin of every ERP/);
  await expectError(sync(owner, a, [financeOwn], 'push', ['customers']), /owner or admin of every ERP/);
  await expectError(sync(owner, a, [a], 'push', ['customers']), /at least one other ERP/);
  await expectError(sync(owner, a, [b], 'sideways', ['customers']), /push, pull or both/);
  await expectError(sync(owner, a, [b], 'push', ['customers', 'secrets']), /Choose what to sync/);
  await expectError(run(db, finance, `select erp_sync_set_enabled($1, false)`, [b]), /owner or admin/);

  await run(db, owner, `select erp_sync_set_enabled($1, false)`, [b]);
  await expectError(sync(owner, a, [b], 'push', ['customers']), /is not included in sync/);
  await run(db, owner, `select erp_sync_set_enabled($1, true)`, [b]);

  const [{ id: run1 }] = await run(db, owner, `select erp_sync_start($1, array[$2]::uuid[], 'push', array['customers'], null) as id`, [a, b]);
  await expectError(run(db, finance, `select erp_sync_step($1, $2, 'customers')`, [run1, b]), /Sync not found/);
  await expectError(run(db, owner, `select erp_sync_step($1, $2, 'products')`, [run1, b]), /Not part of this sync/);
  await run(db, owner, `select erp_sync_finish($1)`, [run1]);

  // Finance members see and post the inbox; nobody reads the sync tables directly.
  await run(db, finance, `select * from erp_sync_inbox_list($1)`, [b]);
  await expectError(run(db, owner, `select * from erp_sync_links`), /permission denied/);
  await expectError(run(db, owner, `select * from erp_sync_inbox`), /permission denied/);

  const audit = await admin(db, `select action from erp_workspace_audit_log where workspace_id = $1 and action like 'sync.%'`, [b]);
  for (const action of ['sync.run', 'sync.disabled', 'sync.enabled', 'sync.inbox_posted']) {
    assert.ok(audit.some((r) => r.action === action), action);
  }
});

test('the overview shows ERPs, the last sync per pair and recent runs', async () => {
  const [{ o }] = await run(db, owner, `select erp_sync_overview() as o`);
  assert.deepEqual(o.erps.map((e) => e.id).sort(), [a, b].sort());
  const erpB = o.erps.find((e) => e.id === b);
  assert.deepEqual([erpB.sync_enabled, erpB.can_sync, erpB.base_currency], [true, true, 'IDR']);
  const pushAB = o.pairs.find((p) => p.source === a && p.target === b && p.entity === 'customers');
  assert.equal(pushAB.last_status, 'success');
  assert.ok(o.pairs.some((p) => p.source === b && p.target === a && p.entity === 'customers'), 'pull and both record the other direction');
  assert.ok(o.runs.length > 0);
  assert.equal(o.runs[0].started_by, owner.email);
});

test('deleting an ERP frees its slot and leaves the data copied elsewhere', async () => {
  const [{ id: d }] = await run(db, owner, `select erp_create_erp('Temporary') as id`);
  const [{ owner_id: ownerD }] = await admin(db, `select owner_id from erp_workspaces where id = $1`, [d]);
  await run(db, owner, `insert into erp_customers (user_id, workspace_id, name, email) values ($1, $2, 'Only in D', 'd@shop.test')`, [ownerD, d]);
  await sync(owner, a, [d], 'both', ['customers']);
  assert.ok((await customers(a)).some((r) => r.name === 'Only in D'));
  const [{ q: before }] = await run(db, owner, `select erp_my_workspace_quota() as q`);

  await runOnPath(db, { ...owner, aal: 'aal2' }, '/account/delete-erp', `select erp_delete_erp($1)`, [d]);
  assert.ok((await customers(a)).some((r) => r.name === 'Only in D'), 'the copy in A stays');
  const left = await admin(db, `select
      (select count(*) from erp_sync_links where ws_a = $1 or ws_b = $1)::int as links,
      (select count(*) from erp_sync_state where source_ws = $1 or target_ws = $1)::int as state`, [d]);
  assert.deepEqual(left[0], { links: 0, state: 0 });
  const [{ q: after }] = await run(db, owner, `select erp_my_workspace_quota() as q`);
  assert.equal(after.used, before.used - 1);
});

test('rollback removes sync', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000003_erp_sync.sql', import.meta.url), 'utf8'));
  const left = await d.query(`select count(*)::int as n from pg_proc where proname like 'erp_sync%' and proname <> 'erp_sync_invoice_after_payment'`);
  assert.equal(left.rows[0].n, 0);
  assert.equal((await d.query(`select to_regclass('public.erp_sync_links') as t`)).rows[0].t, null);
  const col = await d.query(`select count(*)::int as n from information_schema.columns where table_name = 'erp_workspaces' and column_name = 'sync_enabled'`);
  assert.equal(col.rows[0].n, 0);
  await d.close();
});
