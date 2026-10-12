import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, runOnPath, admin, expectError } from './harness.mjs';

let db;
let owner;

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'finance-owner');
});

async function newInvoice(total, dueOffsetDays = 30) {
  const [row] = await run(
    db, owner,
    `select erp_create_invoice_v5(null, null, 'Acme', current_date, current_date + $1::int, $2, 0, null, null) as id`,
    [dueOffsetDays, total]
  );
  return row.id;
}

async function pay(invoiceId, amount) {
  const [row] = await run(
    db, owner,
    `insert into erp_payments (user_id, payment_type, party, amount, invoice_id)
     values ($1, 'incoming', 'Acme', $2, $3) returning id`,
    [owner.id, amount, invoiceId]
  );
  return row.id;
}

async function invoiceState(invoiceId) {
  const [row] = await admin(db, `select status, payment_state, amount_paid::float as paid, total::float as total from erp_invoices where id = $1`, [invoiceId]);
  return row;
}

test('partial payments are explicit and the balance follows create, update, and delete', async () => {
  const invoice = await newInvoice(100);
  const first = await pay(invoice, 40);
  assert.deepEqual(await invoiceState(invoice), { status: 'unpaid', payment_state: 'partially_paid', paid: 40, total: 100 });

  await expectError(run(db, owner, `update erp_payments set amount = 70 where id = $1`, [first]), /only be changed through ERP actions/);
  await expectError(run(db, owner, `delete from erp_payments where id = $1`, [first]), /permission denied/);
  assert.equal((await invoiceState(invoice)).paid, 40);

  await admin(db, `update erp_payments set amount = 70 where id = $1`, [first]);
  assert.equal((await invoiceState(invoice)).paid, 70);

  const second = await pay(invoice, 30);
  assert.deepEqual(await invoiceState(invoice), { status: 'paid', payment_state: 'paid', paid: 100, total: 100 });

  await admin(db, `delete from erp_payments where id = $1`, [second]);
  assert.deepEqual(await invoiceState(invoice), { status: 'unpaid', payment_state: 'partially_paid', paid: 70, total: 100 });
});

test('overdue partial payments keep the legacy overdue status for older clients', async () => {
  const invoice = await newInvoice(50, -5);
  await pay(invoice, 10);
  assert.deepEqual(await invoiceState(invoice), { status: 'overdue', payment_state: 'partially_paid', paid: 10, total: 50 });
});

test('overpayment is rejected, including through an update', async () => {
  const invoice = await newInvoice(100);
  const payment = await pay(invoice, 60);
  await expectError(pay(invoice, 41), /exceeds the invoice balance \(remaining 40/);
  await expectError(run(db, owner, `update erp_payments set amount = 101 where id = $1`, [payment]), /only be changed through ERP actions/);
  await expectError(admin(db, `update erp_payments set amount = 101 where id = $1`, [payment]), /exceeds the invoice balance/);
  await expectError(pay(invoice, 0), /greater than zero/);
  assert.equal((await invoiceState(invoice)).paid, 60);
});

test('voiding a payment keeps history, writes a reversal, and reopens the balance', async () => {
  const invoice = await newInvoice(80);
  const payment = await pay(invoice, 80);
  await expectError(run(db, owner, `select erp_void_payment($1, '')`, [payment]), /reason/);

  const [{ id: reversal }] = await run(db, owner, `select erp_void_payment($1, 'Bounced transfer') as id`, [payment]);
  const [{ id: again }] = await run(db, owner, `select erp_void_payment($1, 'Bounced transfer') as id`, [payment]);
  assert.equal(again, reversal, 'voiding twice returns the same reversal');

  assert.deepEqual(await invoiceState(invoice), { status: 'unpaid', payment_state: 'unpaid', paid: 0, total: 80 });
  const [p] = await admin(db, `select voided_at is not null as voided, void_reason from erp_payments where id = $1`, [payment]);
  assert.deepEqual(p, { voided: true, void_reason: 'Bounced transfer' });

  const ledger = await admin(
    db,
    `select transaction_type, amount::float as amount, is_reversal from erp_transactions where source_payment_id = $1 order by is_reversal`,
    [payment]
  );
  assert.deepEqual(ledger, [
    { transaction_type: 'income', amount: 80, is_reversal: false },
    { transaction_type: 'expense', amount: 80, is_reversal: true },
  ]);

  await expectError(run(db, owner, `update erp_payments set amount = 10 where id = $1`, [payment]), /only be changed through ERP actions/);
  await expectError(admin(db, `update erp_payments set amount = 10 where id = $1`, [payment]), /Voided payments cannot be changed/);
  await expectError(admin(db, `update erp_payments set void_reason = 'Rewritten history' where id = $1`, [payment]), /Voided payments cannot be changed/);
  await expectError(admin(db, `update erp_payments set voided_at = null where id = $1`, [payment]), /Voided payments cannot be changed/);
  // The invoice can be paid again after the void.
  await pay(invoice, 80);
  assert.equal((await invoiceState(invoice)).payment_state, 'paid');
});

test('a payment cannot be voided by a direct table update that skips the reversal', async () => {
  const invoice = await newInvoice(20);
  const payment = await pay(invoice, 20);
  await expectError(
    run(db, owner, `update erp_payments set voided_at = now(), void_reason = 'Sneaky edit' where id = $1`, [payment]),
    /only be changed through ERP actions/
  );
  await expectError(
    admin(db, `update erp_payments set voided_at = now(), void_reason = 'Sneaky edit' where id = $1`, [payment]),
    /Use the void action/
  );
  assert.equal((await invoiceState(invoice)).payment_state, 'paid');
  const [{ n }] = await admin(db, `select count(*)::int as n from erp_transactions where source_payment_id = $1`, [payment]);
  assert.equal(n, 1, 'no reversal booked, nothing changed');
});

test('invoices are voided with a reason, only without live payments, and stay void', async () => {
  const invoice = await newInvoice(30);
  const payment = await pay(invoice, 10);
  await expectError(run(db, owner, `select erp_void_invoice($1, 'Duplicate invoice')`, [invoice]), /Void the payments/);
  await run(db, owner, `select erp_void_payment($1, 'Duplicate invoice')`, [payment]);
  await expectError(run(db, owner, `select erp_void_invoice($1, 'x')`, [invoice]), /reason/);
  await run(db, owner, `select erp_void_invoice($1, 'Duplicate invoice')`, [invoice]);
  assert.deepEqual(await invoiceState(invoice), { status: 'void', payment_state: 'void', paid: 0, total: 30 });
  await expectError(pay(invoice, 5), /void invoice/);
  await expectError(admin(db, `update erp_invoices set status = 'unpaid' where id = $1`, [invoice]), /cannot be reopened/);
});

test('purchase order payments follow the same rules and cancelled POs cannot be paid', async () => {
  const [{ id: po }] = await run(
    db, owner,
    `select erp_create_purchase_order_v3(null, null, 'Supplier', current_date, '', '[{"product_name":"Bolts","qty":10,"price":5}]'::jsonb, null, null) as id`
  );
  const payPo = (amount) =>
    run(db, owner, `insert into erp_payments (user_id, payment_type, party, amount, purchase_order_id) values ($1, 'outgoing', 'Supplier', $2, $3) returning id`, [owner.id, amount, po]);
  await expectError(payPo(10), /Only approved or received purchase orders can be paid/);
  await run(db, owner, `select erp_update_purchase_order_status($1, 'approved')`, [po]);
  const [{ id: payment }] = await payPo(20);
  await expectError(payPo(31), /exceeds the purchase order balance/);
  await expectError(run(db, owner, `select erp_cancel_purchase_order($1, 'Supplier out of stock')`, [po]), /Void the payments/);
  await run(db, owner, `select erp_void_payment($1, 'Refunded by supplier')`, [payment]);
  await run(db, owner, `select erp_cancel_purchase_order($1, 'Supplier out of stock')`, [po]);
  assert.equal((await admin(db, `select status from erp_purchase_orders where id = $1`, [po]))[0].status, 'cancelled');
  await expectError(payPo(5), /Only approved or received/);
  await expectError(run(db, owner, `select erp_update_purchase_order_status($1, 'received')`, [po]), /Invalid purchase order transition/);
});

test('resetting transactions clears the new tables for the owner only', async () => {
  const other = await createUser(db, 'bystander');
  const [{ id: otherInvoice }] = await run(db, other, `select erp_create_invoice_v5(null, null, 'Z', current_date, current_date, 10, 0, null, null) as id`);
  await runOnPath(db, owner, '/account/reset', `select erp_reset_workspace(null, 'transactions')`);
  assert.equal((await admin(db, `select count(*)::int as n from erp_invoices where user_id = $1`, [owner.id]))[0].n, 0);
  assert.equal((await admin(db, `select count(*)::int as n from erp_invoices where id = $1`, [otherInvoice]))[0].n, 1);
});
