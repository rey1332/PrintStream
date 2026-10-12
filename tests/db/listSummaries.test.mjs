import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, expectError } from './harness.mjs';

let db;
let owner;
let ws;
let outsider;

const summary = async (user, kind, workspace = ws) =>
  (await run(db, user, `select erp_list_summary($1, $2) as s`, [workspace, kind]))[0].s;
// Dates as days from today.
const invoice = async (date, due, amount) =>
  (await run(db, owner, `select erp_create_invoice_v5($1, null, 'Budi', current_date + $2::int, current_date + $3::int, $4, 0, null, null) as id`, [ws, date, due, amount]))[0].id;
const pay = async (type, amount, invoiceId = null) =>
  (await run(db, owner, `insert into erp_payments (user_id, workspace_id, payment_type, party, amount, payment_date, invoice_id)
    values ($1, $2, $3, 'Budi', $4, current_date, $5) returning id`, [owner.id, ws, type, amount, invoiceId]))[0].id;

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'summary-owner');
  outsider = await createUser(db, 'summary-outsider');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);

  await invoice(0, 10, 100);                         // open, current
  const late = await invoice(-50, -40, 50);        // overdue 40 days
  await pay('incoming', 20, late);                                                 // partly paid: 30 open
  const veryLate = await invoice(-90, -70, 10);    // overdue 70 days
  void veryLate;
  const paid = await invoice(0, 0, 25);
  await pay('incoming', 25, paid);                                                 // paid
  const voided = await invoice(0, 0, 999);
  await run(db, owner, `select erp_void_invoice($1, 'mistake')`, [voided]);
  await pay('outgoing', 15);
  const cancelled = await pay('outgoing', 5);
  await run(db, owner, `select erp_void_payment($1, 'typo')`, [cancelled]);

  await run(db, owner, `select erp_create_sales_order_v3($1, null, 'Budi', current_date, '', $2::jsonb, null, null)`,
    [ws, JSON.stringify([{ product_name: 'Service', qty: 2, price: 10 }])]);
  const [{ id: po }] = await run(db, owner, `select erp_create_purchase_order_v3($1, null, 'Parts', current_date, '', $2::jsonb, null, null) as id`,
    [ws, JSON.stringify([{ product_name: 'Bolt', qty: 1, price: 40 }])]);
  await run(db, owner, `select erp_create_purchase_order_v3($1, null, 'Parts', current_date, '', $2::jsonb, null, null)`,
    [ws, JSON.stringify([{ product_name: 'Nut', qty: 1, price: 7 }])]);
  await run(db, owner, `select erp_cancel_purchase_order($1, 'not needed')`, [po]);
});

test('invoices: open, partly paid, overdue, paid and aging, without void invoices', async () => {
  const s = await summary(owner, 'invoices');
  assert.equal(s.count, 5, 'every invoice, void included');
  assert.deepEqual(
    [s.open_count, Number(s.open_amount), s.partial_count, Number(s.partial_amount)],
    [3, 140, 1, 30]
  );
  assert.deepEqual([s.overdue_count, Number(s.overdue_amount)], [2, 40]);
  assert.deepEqual([s.paid_count, Number(s.paid_amount)], [1, 25]);
  assert.deepEqual(
    [s.aging_current, s.aging_1_30, s.aging_31_60, s.aging_61].map(Number),
    [100, 0, 30, 10]
  );
});

test('payments: money in and out, without voided payments', async () => {
  const s = await summary(owner, 'payments');
  assert.equal(s.count, 4);
  assert.deepEqual([Number(s.incoming), Number(s.outgoing)], [45, 15]);
  assert.deepEqual([s.incoming_count, s.outgoing_count], [2, 1]);
});

test('orders: count and total per status; cancelled orders are not in the live total', async () => {
  const so = await summary(owner, 'sales_orders');
  assert.equal(so.count, 1);
  assert.equal(Number(so.live_total), 20);
  assert.equal(so.by_status.draft.count, 1);
  const po = await summary(owner, 'purchase_orders');
  assert.equal(po.count, 2);
  assert.equal(Number(po.live_total), 7);
  assert.deepEqual([po.by_status.cancelled.count, Number(po.by_status.cancelled.total)], [1, 40]);
  assert.equal(po.by_status.pending.count, 1);
});

test('only what the caller may see', async () => {
  const s = await summary(outsider, 'invoices');
  assert.equal(s.count, 0);
  await expectError(summary(owner, 'secrets'), /Unknown list/);
});
