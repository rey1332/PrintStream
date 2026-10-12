import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, expectError } from './harness.mjs';

let db;
let owner;
let ws;

const summary = async (user, workspace = ws) =>
  (await run(db, user, `select erp_reports_summary($1) as s`, [workspace]))[0].s;

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'rep-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
});

test('totals, invoice statuses, months, expense categories and stock come from the database', async () => {
  const invoice = async (amount) =>
    (await run(db, owner, `select erp_create_invoice_v5($1, null, 'Budi', '2026-08-03', '2026-09-03', $2, 0, null, null) as id`, [ws, amount]))[0].id;
  const paidInv = await invoice(300);
  await invoice(200);
  const voided = await invoice(999);
  await run(db, owner, `select erp_void_invoice($1, 'Typo')`, [voided]);
  const pay = (type, amount, date, invoiceId = null) =>
    run(db, owner, `insert into erp_payments (user_id, workspace_id, payment_type, party, amount, payment_date, invoice_id)
      values ($1, $2, $3, 'Budi', $4, $5, $6) returning id`, [owner.id, ws, type, amount, date, invoiceId]);
  await pay('incoming', 300, '2026-08-10', paidInv);
  await pay('outgoing', 120, '2026-09-02');
  const [{ id: wrong }] = await pay('outgoing', 50, '2026-09-03');
  await run(db, owner, `select erp_void_payment($1, 'Entered twice')`, [wrong]);
  await run(db, owner, `insert into erp_transactions (user_id, workspace_id, transaction_type, category, amount, transaction_date, description)
    values ($1, $2, 'expense', 'fuel', 80, '2026-09-05', 'Solar'), ($1, $2, 'expense', 'repairs', 40, '2026-09-06', 'Pump')`, [owner.id, ws]);
  await run(db, owner, `insert into erp_products (user_id, workspace_id, name, unit, current_stock, purchase_price)
    values ($1, $2, 'Split 1/2', 'm3', 100.5, 180000), ($1, $2, 'Abu batu', 'm3', 10, 90000)`, [owner.id, ws]);

  const s = await summary(owner);
  assert.equal(s.revenue, 500, 'void invoices left out');
  assert.equal(s.incoming, 300);
  assert.equal(s.outgoing, 120, 'void payments left out');
  assert.deepEqual(s.invoice_status.void, { count: 1, total: 999 });
  assert.equal(s.invoice_status.paid.count, 1);
  assert.deepEqual(s.monthly_payments, [
    { month: '2026-08', income: 300, expense: 0 },
    { month: '2026-09', income: 0, expense: 120 },
  ]);
  const fuel = s.expense_categories.find((c) => c.category === 'fuel');
  assert.equal(fuel.amount, 80);
  assert.ok(s.monthly_transactions.some((m) => m.month === '2026-09' && m.expense >= 120));
  assert.deepEqual(s.products.map((p) => [p.name, p.stock, p.unit, p.value]), [
    ['Split 1/2', 100.5, 'm3', 18090000],
    ['Abu batu', 10, 'm3', 900000],
  ]);
  assert.equal(s.counts.products, 2);
});

test('row-level security decides what is counted', async () => {
  const outsider = await createUser(db, 'rep-outsider');
  const s = await summary(outsider);
  assert.equal(s.counts.invoices, 0);
  assert.equal(s.revenue, 0);
  assert.deepEqual(s.products, []);
  await expectError(run(db, owner, `select erp_reports_summary(null)`), /Choose an ERP/);
});
