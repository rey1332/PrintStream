import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, run, admin, expectError, items } from './harness.mjs';

let db;
before(async () => { db = await createDb(); });

async function balances(user) {
  const rows = await run(db, user, `select system_key, balance::float as balance from erp_trial_balance(null, null, null)`);
  return Object.fromEntries(rows.filter((r) => r.system_key && r.balance !== 0).map((r) => [r.system_key, r.balance]));
}
const product = async (user, stock = 0, price = 10) =>
  (await run(db, user, `insert into erp_products (user_id, name, current_stock, purchase_price, selling_price) values ($1, 'Widget', $2, $3, 20) returning id`, [user.id, stock, price]))[0].id;
const avg = async (id) => Number((await admin(db, `select avg_cost from erp_products where id = $1`, [id]))[0].avg_cost);

async function receive(user, productId, qty, price) {
  const [{ id: po }] = await run(db, user, `select erp_create_purchase_order_v3(null, null, 'Supplier', current_date, '', $1::jsonb, null, null) as id`, [items([productId, qty, price])]);
  await run(db, user, `select erp_update_purchase_order_status($1, 'approved')`, [po]);
  const [line] = await admin(db, `select id from erp_purchase_order_items where purchase_order_id = $1`, [po]);
  const [{ id: event }] = await run(db, user, `select erp_record_purchase_receipt_v2($1, $2::jsonb, $3, '', null) as id`, [po, JSON.stringify([{ item_id: line.id, qty }]), randomUUID()]);
  return { po, event };
}

async function deliver(user, productId, qty) {
  const [{ id: so }] = await run(db, user, `select erp_create_sales_order_v3(null, null, 'Walk-in', current_date, '', $1::jsonb, null, null) as id`, [items([productId, qty, 30])]);
  await run(db, user, `select erp_issue_invoice_from_sales_order_v2($1, null, null)`, [so]);
  const [line] = await admin(db, `select id from erp_sales_order_items where sales_order_id = $1`, [so]);
  const [{ id: event }] = await run(db, user, `select erp_record_sales_delivery($1, $2::jsonb, $3) as id`, [so, JSON.stringify([{ item_id: line.id, qty }]), randomUUID()]);
  return event;
}

test('receipts move the average cost and deliveries are costed at the average', async () => {
  const user = await createUser(db, 'cost-avg');
  const p = await product(user, 0, 10);
  assert.equal(await avg(p), 10, 'starts at the purchase price');
  await receive(user, p, 10, 10);
  await receive(user, p, 10, 16);
  assert.equal(await avg(p), 13, '(10×10 + 10×16) / 20');

  const delivery = await deliver(user, p, 5);
  const [line] = await admin(db, `select unit_cost::float as c from erp_fulfillment_event_lines where event_id = $1`, [delivery]);
  assert.equal(line.c, 13, 'the line records the cost used');
  const b = await balances(user);
  assert.equal(b.cogs, 65);
  assert.equal(b.inventory, 260 - 65);
});

test('a receipt reversal takes its cost back out of the average', async () => {
  const user = await createUser(db, 'cost-reverse');
  const p = await product(user, 0, 10);
  await receive(user, p, 10, 10);
  const { event } = await receive(user, p, 10, 20);
  assert.equal(await avg(p), 15);
  await run(db, user, `select erp_reverse_fulfillment_event($1, 'Wrong goods', $2)`, [event, randomUUID()]);
  assert.equal(await avg(p), 10);
  assert.deepEqual(await balances(user), { inventory: 100, ap: 100 });
});

test('purchase tax: default rate on new orders, gross total, input tax on receipt', async () => {
  const user = await createUser(db, 'cost-tax');
  await run(db, user, `select erp_set_purchase_tax_rate(null, 11)`);
  const [s] = await run(db, user, `select purchase_tax_rate::float as rate from erp_accounting_settings_get(null)`);
  assert.equal(s.rate, 11);
  const p = await product(user, 0, 10);
  const { po } = await receive(user, p, 10, 10);
  const [order] = await admin(db, `select total::float as total, tax_amount::float as tax, tax_rate::float as rate from erp_purchase_orders where id = $1`, [po]);
  assert.deepEqual(order, { total: 111, tax: 11, rate: 11 });
  assert.deepEqual(await balances(user), { inventory: 100, tax_in: 11, ap: 111 });
  // The supplier can be paid the gross amount, not more.
  await run(db, user, `insert into erp_payments (user_id, payment_type, party, amount, purchase_order_id) values ($1, 'outgoing', 'Supplier', 111, $2)`, [user.id, po]);
  await expectError(run(db, user, `insert into erp_payments (user_id, payment_type, party, amount, purchase_order_id) values ($1, 'outgoing', 'Supplier', 1, $2)`, [user.id, po]), /exceeds the purchase order balance/);
  await expectError(run(db, user, `select erp_set_purchase_tax_rate(null, 150)`), /between 0 and 100/);
});

test('stock lives in the default warehouse and follows every change', async () => {
  const user = await createUser(db, 'wh-default');
  const p = await product(user, 7, 5);
  const stockByWh = async () => admin(db,
    `select w.code, s.quantity::float8 as quantity from erp_warehouse_stock s join erp_warehouses w on w.id = s.warehouse_id where s.product_id = $1 order by w.code`, [p]);
  assert.deepEqual(await stockByWh(), [{ code: 'MAIN', quantity: 7 }]);
  await run(db, user, `select erp_adjust_stock($1, 'out', 2, 'Damaged')`, [p]);
  await receive(user, p, 5, 5);
  assert.deepEqual(await stockByWh(), [{ code: 'MAIN', quantity: 10 }]);
});

test('transfers move stock between warehouses; issues take from the default first', async () => {
  const user = await createUser(db, 'wh-transfer');
  const p = await product(user, 10, 5);
  const [{ id: store }] = await run(db, user, `select erp_create_warehouse(null, 'STORE', 'Shop floor') as id`);
  await expectError(run(db, user, `select erp_create_warehouse(null, 'STORE', 'Dup')`), /already exists/);
  const [main] = await admin(db, `select id from erp_warehouses where user_id = $1 and is_default`, [user.id]);

  await run(db, user, `select erp_transfer_stock($1, $2, $3, 8, 'Restock shop')`, [p, main.id, store]);
  await expectError(run(db, user, `select erp_transfer_stock($1, $2, $3, 3, '')`, [p, main.id, store]), /Only 2 units/);
  await expectError(run(db, user, `select erp_transfer_stock($1, $2, $2, 1, '')`, [p, main.id]), /two different warehouses/);

  // Selling 5 takes 2 from MAIN, then 3 from STORE; the total always matches.
  await deliver(user, p, 5);
  const rows = await admin(db, `select w.code, s.quantity::float8 as quantity from erp_warehouse_stock s join erp_warehouses w on w.id = s.warehouse_id where s.product_id = $1 order by w.code`, [p]);
  assert.deepEqual(rows, [{ code: 'MAIN', quantity: 0 }, { code: 'STORE', quantity: 5 }]);
  const [{ total }] = await admin(db, `select current_stock::float8 as total from erp_products where id = $1`, [p]);
  assert.equal(total, 5);
  const [t] = await admin(db, `select quantity::float8 as quantity, note from erp_stock_transfers where product_id = $1`, [p]);
  assert.deepEqual(t, { quantity: 8, note: 'Restock shop' });
});

test('warehouses are visible to workspace members and cannot be edited directly', async () => {
  const owner = await createUser(db, 'wh-owner');
  const outsider = await createUser(db, 'wh-outsider');
  await product(owner, 3, 5);
  assert.equal((await run(db, owner, `select code from erp_warehouses`)).length, 1);
  assert.equal((await run(db, outsider, `select code from erp_warehouses where user_id = $1`, [owner.id])).length, 0);
  await expectError(run(db, owner, `update erp_warehouse_stock set quantity = 99`), /permission denied/);
  await expectError(run(db, owner, `insert into erp_warehouses (user_id, code, name) values ($1, 'X', 'X')`, [owner.id]), /permission denied/);
});
