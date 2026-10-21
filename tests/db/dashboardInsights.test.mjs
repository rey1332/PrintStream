import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run } from './harness.mjs';

let db;
before(async () => {
  db = await createDb();
});

const insights = async (user, workspaceId = null) =>
  (await run(db, user, `select erp_dashboard_insights($1) as r`, [workspaceId]))[0].r;
const days = (n) => `current_date + ${Number(n)}`;

async function invoice(user, { customer = null, name, date = 0, due = 0, total, currency = null, rate = null }) {
  const [{ id }] = await run(
    db,
    user,
    `select erp_create_invoice_v5(null, $1, $2, ${days(date)}, ${days(due)}, $3, 0, $4, $5) as id`,
    [customer, name, total, currency, rate]
  );
  return id;
}

test('receivables, aging, credit, revenue, top lists and months come from the invoices and payments', async () => {
  const user = await createUser(db, 'insights');
  const [{ id: limited }] = await run(db, user, `insert into erp_customers (user_id, name, credit_limit) values ($1, 'PT Limit', 1000) returning id`, [user.id]);
  const [{ id: product }] = await run(db, user, `insert into erp_products (user_id, name, unit) values ($1, 'Split 1/2', 'm3') returning id`, [user.id]);

  // 35 days late, partly paid: 800 open in 31-60.
  const [{ id: late }] = await run(
    db,
    user,
    `select erp_create_invoice_v6(null, $1, 'PT Limit', current_date - 40, current_date - 35, $2::jsonb, 0, null, null) as id`,
    [limited, JSON.stringify([{ product_id: product, qty: 2, price: 500 }])]
  );
  await run(db, user, `insert into erp_payments (user_id, party, payment_type, amount, invoice_id) values ($1, 'PT Limit', 'incoming', 200, $2)`, [user.id, late]);
  // Not due yet: 600 current. PT Limit now owes 1400 against a limit of 1000.
  await invoice(user, { customer: limited, name: 'PT Limit', due: 30, total: 600 });
  // A walk-in customer in EUR (a foreign currency), 95 days late: 100 x 15000 over 90 days.
  await invoice(user, { name: 'Walk-in', date: -100, due: -95, total: 100, currency: 'EUR', rate: 15000 });
  // Void: never counted.
  const gone = await invoice(user, { name: 'Gone', total: 999 });
  await run(db, user, `select erp_void_invoice($1, 'Entered twice')`, [gone]);
  // A voided payment does not reduce the balance; an outgoing one is cash out only.
  const [{ id: bounced }] = await run(db, user, `insert into erp_payments (user_id, party, payment_type, amount, invoice_id) values ($1, 'PT Limit', 'incoming', 300, $2) returning id`, [user.id, late]);
  await run(db, user, `select erp_void_payment($1, 'Bounced cheque')`, [bounced]);
  await run(db, user, `insert into erp_payments (user_id, party, payment_type, amount) values ($1, 'Supplier', 'outgoing', 50)`, [user.id]);

  const r = await insights(user);
  assert.deepEqual(
    Object.fromEntries(Object.entries(r.receivables).map(([k, v]) => [k, Number(v)])),
    { balanceDue: 1500000 + 800 + 600, pastDue: 1500000 + 800, openInvoices: 3, invoicesPastDue: 2, customersPastDue: 2 }
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(r.aging).map(([k, v]) => [k, Number(v)])),
    { current: 600, days30: 0, days60: 800, days90: 0, over90: 1500000 }
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(r.credit).map(([k, v]) => [k, Number(v)])),
    { overLimit: 400, customersOver: 1, customersWithLimit: 1 }
  );
  assert.equal(Number(r.revenue.total), 1000 + 600 + 1500000);
  assert.equal(Number(r.revenue.invoices), 3);
  assert.deepEqual(r.topProducts.map((p) => [p.name, Number(p.revenue), Number(p.qty)]), [['Split 1/2', 1000, 2]]);
  assert.deepEqual(r.topCustomers.map((c) => [c.name, Number(c.revenue)]), [['Walk-in', 1500000], ['PT Limit', 1600]]);

  assert.equal(r.months.length, 12);
  assert.match(r.months.at(-1).month, /^\d{4}-\d{2}$/);
  const sum = (key) => r.months.reduce((n, m) => n + Number(m[key]), 0);
  assert.equal(sum('revenue'), 1501600);
  assert.equal(sum('cashIn'), 200);
  assert.equal(sum('cashOut'), 50);
});

test('another user sees none of it; an empty ERP gives zeros and empty lists', async () => {
  const other = await createUser(db, 'insights-other');
  const r = await insights(other);
  assert.equal(Number(r.receivables.balanceDue), 0);
  assert.equal(Number(r.credit.customersWithLimit), 0);
  assert.deepEqual(r.topProducts, []);
  assert.deepEqual(r.topCustomers, []);
  assert.equal(r.months.length, 12);
  assert.ok(r.months.every((m) => Number(m.revenue) === 0 && Number(m.cashIn) === 0));
});

test('rollback removes the function', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000059_erp_dashboard_insights.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select to_regprocedure('public.erp_dashboard_insights(uuid)') is null as gone`);
  assert.equal(rows[0].gone, true);
  await d.close();
});
