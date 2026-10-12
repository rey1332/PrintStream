import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
const ids = {};

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'ledger-owner');
  [{ id: ids.invoice }] = await run(db, owner, `select erp_create_invoice_v5(null, null, 'Ana', current_date, current_date + 30, 100, 0, null, null) as id`);
  [{ id: ids.payment }] = await run(db, owner,
    `insert into erp_payments (user_id, payment_type, party, amount, invoice_id) values ($1, 'incoming', 'Ana', 40, $2) returning id`,
    [owner.id, ids.invoice]);
  [{ id: ids.txn }] = await run(db, owner,
    `insert into erp_transactions (user_id, transaction_type, category, amount, description) values ($1, 'expense', 'Rent', 500, 'Rent') returning id`,
    [owner.id]);
  [{ id: ids.po }] = await run(db, owner,
    `select erp_create_purchase_order_v3(null, null, 'Supplier', current_date, '', '[{"product_name":"Bolts","qty":10,"price":5}]'::jsonb, null, null) as id`);
});

// Either the table grant or the guard trigger refuses the change.
const DENIED = /only be changed through ERP actions|permission denied/;

test('owners cannot delete financial records through the API', async () => {
  for (const [table, id] of [['erp_invoices', ids.invoice], ['erp_payments', ids.payment], ['erp_transactions', ids.txn], ['erp_purchase_orders', ids.po]]) {
    await expectError(run(db, owner, `delete from ${table} where id = $1`, [id]), /permission denied/);
  }
  await expectError(run(db, owner, `delete from erp_purchase_order_items where purchase_order_id = $1`, [ids.po]), /permission denied/);
  const [{ n }] = await admin(db, `select count(*)::int as n from erp_payments where id = $1`, [ids.payment]);
  assert.equal(n, 1);
});

test('owners cannot edit amounts, dates or links of financial records directly', async () => {
  await expectError(run(db, owner, `update erp_invoices set total = 1 where id = $1`, [ids.invoice]), DENIED);
  await expectError(run(db, owner, `update erp_payments set amount = 1 where id = $1`, [ids.payment]), DENIED);
  await expectError(run(db, owner, `update erp_transactions set amount = 1 where id = $1`, [ids.txn]), DENIED);
  await expectError(run(db, owner, `update erp_purchase_orders set total = 1 where id = $1`, [ids.po]), DENIED);
  await expectError(run(db, owner, `update erp_purchase_order_items set price = 1 where purchase_order_id = $1`, [ids.po]), DENIED);
  const [inv] = await admin(db, `select total::float as total, amount_paid::float as paid from erp_invoices where id = $1`, [ids.invoice]);
  assert.deepEqual(inv, { total: 100, paid: 40 });
});

test('ERP actions still work: void, reverse and change order status', async () => {
  await run(db, owner, `select erp_void_payment($1, 'Entered twice')`, [ids.payment]);
  const [inv] = await admin(db, `select amount_paid::float as paid, payment_state from erp_invoices where id = $1`, [ids.invoice]);
  assert.deepEqual(inv, { paid: 0, payment_state: 'unpaid' });
  await run(db, owner, `select erp_update_purchase_order_status($1, 'approved')`, [ids.po]);
  const [po] = await admin(db, `select status::text from erp_purchase_orders where id = $1`, [ids.po]);
  assert.equal(po.status, 'approved');
});

test('master data stays editable and deletable', async () => {
  const [{ id }] = await run(db, owner, `insert into erp_customers (user_id, name) values ($1, 'Temp') returning id`, [owner.id]);
  await run(db, owner, `update erp_customers set city = 'Bandung' where id = $1`, [id]);
  await run(db, owner, `delete from erp_customers where id = $1`, [id]);
});
