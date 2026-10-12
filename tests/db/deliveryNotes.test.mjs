import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let ws;
const year = new Date().getFullYear();

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'sj-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
});

test('each delivery gets the next SJ number and each receipt the next GR number; numbers never change', async () => {
  const [{ id: product }] = await run(db, owner, `insert into erp_products (user_id, workspace_id, name, unit, current_stock) values ($1, $2, 'Split 1/2', 'm3', 0) returning id`, [owner.id, ws]);
  const [{ id: po }] = await run(db, owner, `select erp_create_purchase_order_v3($1, null, 'Crusher', current_date, '', $2::jsonb, null, null) as id`,
    [ws, JSON.stringify([{ product_id: product, qty: 100, price: 1 }])]);
  await run(db, owner, `select erp_update_purchase_order_status($1, 'approved')`, [po]);
  const [poLine] = await admin(db, `select id from erp_purchase_order_items where purchase_order_id = $1`, [po]);
  const [{ id: receipt }] = await run(db, owner, `select erp_record_purchase_receipt_v2($1, $2::jsonb, $3, '', null) as id`,
    [po, JSON.stringify([{ item_id: poLine.id, qty: 100 }]), randomUUID()]);

  const [{ id: so }] = await run(db, owner, `select erp_create_sales_order_v3($1, null, 'PT Beton', current_date, '', $2::jsonb, null, null) as id`,
    [ws, JSON.stringify([{ product_id: product, qty: 30, price: 2 }])]);
  await run(db, owner, `select erp_issue_invoice_from_sales_order_v2($1, null, null)`, [so]);
  const [soLine] = await admin(db, `select id from erp_sales_order_items where sales_order_id = $1`, [so]);
  const deliver = async (qty) =>
    (await run(db, owner, `select erp_record_sales_delivery($1, $2::jsonb, $3) as id`, [so, JSON.stringify([{ item_id: soLine.id, qty }]), randomUUID()]))[0].id;
  const first = await deliver(12.5);
  const second = await deliver(7.25);
  await run(db, owner, `select erp_reverse_fulfillment_event($1, 'Wrong truck', $2)`, [second, randomUUID()]);

  const numbers = await admin(db, `select doc_no, is_reversal from erp_fulfillment_events where workspace_id = $1 and kind = 'sales_delivery' order by created_at, id`, [ws]);
  assert.deepEqual(numbers.map((r) => r.doc_no), [`SJ/${year}/0001`, `SJ/${year}/0002`, `SJ/${year}/0003`]);
  assert.equal((await admin(db, `select doc_no from erp_fulfillment_events where id = $1`, [receipt]))[0].doc_no, `GR/${year}/0001`);

  await expectError(admin(db, `update erp_fulfillment_events set doc_no = 'SJ/1999/0001' where id = $1`, [first]), /cannot be changed/);
  const [{ doc_no }] = await run(db, owner, `select doc_no from erp_fulfillment_events where id = $1`, [first]);
  assert.equal(doc_no, `SJ/${year}/0001`, 'members read the number');
});

test('rollback removes the numbers', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000021_erp_delivery_notes.sql', import.meta.url), 'utf8'));
  const [{ n }] = (await d.query(`select count(*)::int as n from information_schema.columns where table_name = 'erp_fulfillment_events' and column_name = 'doc_no'`)).rows;
  assert.equal(n, 0);
  await d.close();
});
