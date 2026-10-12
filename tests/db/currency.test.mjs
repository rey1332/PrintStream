// Foreign-currency invoices and payments (20260930010000_erp_multi_currency.sql).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let user;
before(async () => {
  db = await createDb();
  user = await createUser(db, 'fx');
  await run(db, user, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
});

async function balances() {
  const rows = await run(db, user, `select system_key, balance::float as balance from erp_trial_balance(null, null, null)`);
  return Object.fromEntries(rows.filter((r) => r.system_key && r.balance !== 0).map((r) => [r.system_key, r.balance]));
}
const invoiceUsd = async (net, rate, tax = 0) =>
  (await run(db, user, `select erp_create_invoice_v5(null, null, 'Acme', current_date, current_date + 30, $1, $2, 'USD', $3) as id`, [net, tax, rate]))[0].id;
const pay = (invoiceId, amount, rate = null) =>
  run(db, user, `insert into erp_payments (user_id, payment_type, party, amount, invoice_id, fx_rate) values ($1, 'incoming', 'Acme', $2, $3, coalesce($4::numeric, 1)) returning id`, [user.id, amount, invoiceId, rate]);

test('a USD invoice is booked at its rate and settled at the payment rate', async () => {
  const inv = await invoiceUsd(100, 16000);
  const [row] = await admin(db, `select currency, fx_rate::float as rate, total::float as total, base_total::float as base from erp_invoices where id = $1`, [inv]);
  assert.deepEqual(row, { currency: 'USD', rate: 16000, total: 100, base: 1600000 });
  assert.deepEqual(await balances(), { ar: 1600000, revenue: 1600000 });

  // Paid in full at a better rate: the difference is an exchange gain.
  const [{ id: p }] = await pay(inv, 100, 16200);
  const [pr] = await admin(db, `select currency, base_amount::float as base from erp_payments where id = $1`, [p]);
  assert.deepEqual(pr, { currency: 'USD', base: 1620000 });
  assert.equal((await admin(db, `select payment_state from erp_invoices where id = $1`, [inv]))[0].payment_state, 'paid');
  assert.deepEqual(await balances(), { cash: 1620000, revenue: 1600000, fx: 20000 });

  // The cash book records the base amount.
  const [cb] = await admin(db, `select amount::float as amount from erp_transactions where source_payment_id = $1`, [p]);
  assert.equal(cb.amount, 1620000);
  await run(db, user, `select erp_void_payment($1, 'Bounced transfer')`, [p]);
  assert.deepEqual(await balances(), { ar: 1600000, revenue: 1600000 });
  const reversal = await admin(db, `select amount::float as amount from erp_transactions where source_payment_id = $1 and is_reversal`, [p]);
  assert.deepEqual(reversal, [{ amount: 1620000 }]);
});

test('payments default to the invoice rate and must use the invoice currency', async () => {
  const inv = await invoiceUsd(50, 15500, 10);
  const [row] = await admin(db, `select total::float as total, tax_amount::float as tax, base_total::float as base from erp_invoices where id = $1`, [inv]);
  assert.deepEqual(row, { total: 55, tax: 5, base: 852500 });
  const [{ id: p }] = await pay(inv, 20);
  assert.equal((await admin(db, `select fx_rate::float as r from erp_payments where id = $1`, [p]))[0].r, 15500);
  await expectError(
    run(db, user, `insert into erp_payments (user_id, payment_type, party, amount, invoice_id, currency, fx_rate) values ($1, 'incoming', 'Acme', 1, $2, 'EUR', 17000)`, [user.id, inv]),
    /must be in the invoice currency/
  );
  await expectError(pay(inv, 36), /exceeds the invoice balance/);
});

test('base-currency documents are unchanged and invalid currencies are refused', async () => {
  const [{ id: inv }] = await run(db, user, `select erp_create_invoice_v5(null, null, 'Local', current_date, current_date, 10, 0, 'IDR', 1) as id`);
  const [row] = await admin(db, `select currency, fx_rate::float as rate from erp_invoices where id = $1`, [inv]);
  assert.deepEqual(row, { currency: null, rate: 1 }, 'the base currency is stored as NULL');
  await expectError(run(db, user, `select erp_create_invoice_v5(null, null, 'X', current_date, current_date, 10, 0, 'US$', 1)`), /3-letter ISO code|Unknown currency/);
  await expectError(run(db, user, `select erp_create_invoice_v5(null, null, 'X', current_date, current_date, 10, 0, 'EUR', 0)`), /exchange rate/);
});
