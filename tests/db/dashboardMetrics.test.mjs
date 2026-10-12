import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, run, admin, items } from './harness.mjs';
import { computeFinancialMetrics } from '../../src/app/erp/lib/erpRules.ts';

let db;
before(async () => { db = await createDb(); });

const product = async (user, stock, price) =>
  (await run(db, user, `insert into erp_products (user_id, name, current_stock, purchase_price, selling_price) values ($1, 'Widget', $2, $3, 20) returning id`, [user.id, stock, price]))[0].id;

async function order(user, productId, qty, price) {
  const [{ id: po }] = await run(db, user, `select erp_create_purchase_order_v3(null, null, 'Supplier', current_date, '', $1::jsonb, null, null) as id`, [items([productId, qty, price])]);
  await run(db, user, `select erp_update_purchase_order_status($1, 'approved')`, [po]);
  return po;
}

async function receive(user, po, qty) {
  const [line] = await admin(db, `select id from erp_purchase_order_items where purchase_order_id = $1`, [po]);
  await run(db, user, `select erp_record_purchase_receipt_v2($1, $2::jsonb, $3, '', null)`, [po, JSON.stringify([{ item_id: line.id, qty }]), randomUUID()]);
}

const pay = (user, fields) => {
  const keys = Object.keys(fields);
  return run(db, user,
    `insert into erp_payments (user_id, party, ${keys.join(', ')}) values ($1, 'Party', ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning id`,
    [user.id, ...Object.values(fields)]);
};

async function inBrowser(user) {
  const rows = (table) => admin(db, `select * from ${table} where user_id = $1`, [user.id]);
  const [invoices, payments, products, orders] = await Promise.all([
    rows('erp_invoices'), rows('erp_payments'), rows('erp_products'), rows('erp_purchase_orders'),
  ]);
  for (const po of orders) {
    po.items = await admin(db, `select * from erp_purchase_order_items where purchase_order_id = $1`, [po.id]);
  }
  return computeFinancialMetrics({ invoices, payments, products, purchaseOrders: orders });
}

async function inDatabase(user, workspaceId = null) {
  const [{ m }] = await run(db, user, `select erp_dashboard_metrics($1) as m`, [workspaceId]);
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Number(v)]));
}

test('the database figures equal the browser computation on mixed data', async () => {
  const user = await createUser(db, 'metrics');
  await run(db, user, `select erp_set_purchase_tax_rate(null, 11)`);

  // Invoices: local, foreign currency, partly paid, void.
  const [{ id: local }] = await run(db, user, `select erp_create_invoice_v5(null, null, 'Budi', current_date, current_date + 14, 1000, 0, null, null) as id`);
  const [{ id: usd }] = await run(db, user, `select erp_create_invoice_v5(null, null, 'Acme', current_date, current_date, 100, 0, 'USD', 16000) as id`);
  const [{ id: gone }] = await run(db, user, `select erp_create_invoice_v5(null, null, 'Gone', current_date, current_date, 77, 0, null, null) as id`);
  await run(db, user, `select erp_void_invoice($1, 'Entered twice')`, [gone]);
  await pay(user, { payment_type: 'incoming', amount: 400, invoice_id: local });
  await pay(user, { payment_type: 'incoming', amount: 40, invoice_id: usd, currency: 'USD', fx_rate: 16500 });
  const [{ id: voided }] = await pay(user, { payment_type: 'incoming', amount: 100, invoice_id: local });
  await run(db, user, `select erp_void_payment($1, 'Bounced cheque')`, [voided]);
  await pay(user, { payment_type: 'incoming', amount: 12.345 });
  await pay(user, { payment_type: 'outgoing', amount: 50 });

  // Purchases: fully received and partly paid; half received and prepaid; approved, nothing received.
  const p1 = await product(user, 0, 10);
  const full = await order(user, p1, 10, 10);
  await receive(user, full, 10);
  await pay(user, { payment_type: 'outgoing', amount: 60, purchase_order_id: full });
  const p2 = await product(user, 3, 7.5);
  const half = await order(user, p2, 10, 20);
  await receive(user, half, 5);
  await pay(user, { payment_type: 'outgoing', amount: 150, purchase_order_id: half });
  await order(user, p2, 4, 25);
  await product(user, 2, 0);

  const browser = await inBrowser(user);
  const database = await inDatabase(user);
  assert.deepEqual(database, browser);
  assert.ok(browser.accountsReceivable > 0 && browser.accountsPayable > 0 && browser.committedPurchases > 0);
  assert.ok(browser.supplierPrepayments > 0 && browser.inventoryValue > 0);
});

test('an empty ERP gives zeros', async () => {
  const user = await createUser(db, 'metrics-empty');
  const metrics = await inDatabase(user);
  assert.ok(Object.values(metrics).every((v) => v === 0));
  assert.deepEqual(metrics, await inBrowser(user));
});

test('scope and access: the workspace when given, and only rows the caller may read', async () => {
  const owner = await createUser(db, 'metrics-owner');
  await run(db, owner, `select erp_create_invoice_v5(null, null, 'Budi', current_date, current_date, 500, 0, null, null)`);
  const [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);

  const stranger = await createUser(db, 'metrics-stranger');
  const seen = await inDatabase(stranger, ws);
  assert.equal(seen.invoicedRevenue, 0, 'row-level security hides other workspaces');

  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'finance', 24, '')`, [ws]);
  const finance = await createUser(db, 'metrics-finance');
  await run(db, finance, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  assert.equal((await inDatabase(finance, ws)).invoicedRevenue, 500);
  assert.equal((await inDatabase(owner, ws)).invoicedRevenue, 500);
});
