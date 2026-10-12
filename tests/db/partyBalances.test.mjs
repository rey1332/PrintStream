import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, expectError } from './harness.mjs';

let db;
let owner;
let ws;

const balances = async (user, kind, ids, workspace = ws) =>
  Object.fromEntries(
    (await run(db, user, `select party_id, outstanding::float8 as outstanding, overdue::float8 as overdue, open_documents
      from erp_party_balances($1, $2, $3::uuid[])`, [workspace, kind, ids]))
      .map((r) => [r.party_id, { outstanding: r.outstanding, overdue: r.overdue, open: r.open_documents }]),
  );
const party = async (table, name) =>
  (await run(db, owner, `insert into ${table} (user_id, workspace_id, name, balance) values ($1, $2, $3, 999999) returning id`, [owner.id, ws, name]))[0].id;
const invoice = async (customer, due, amount) =>
  (await run(db, owner, `select erp_create_invoice_v5($1, $2, 'x', current_date - 60, current_date + $3::int, $4, 0, null, null) as id`, [ws, customer, due, amount]))[0].id;
const pay = async (fields, amount) =>
  run(db, owner, `insert into erp_payments (user_id, workspace_id, payment_type, party, amount, payment_date, invoice_id, purchase_order_id)
    values ($1, $2, $3, 'x', $4, current_date, $5, $6) returning id`, [owner.id, ws, fields.type, amount, fields.invoice ?? null, fields.po ?? null]);

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'bal-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
});

test('customer balance = open invoices − payments, with the overdue part; the typed-in column is ignored', async () => {
  const budi = await party('erp_customers', 'PT Budi');
  const sari = await party('erp_customers', 'CV Sari');
  const nobody = await party('erp_customers', 'Never billed');
  await invoice(budi, 10, 1000);                          // current
  const late = await invoice(budi, -5, 400);             // overdue
  await pay({ type: 'incoming', invoice: late }, 150);    // 250 still open, overdue
  const paid = await invoice(sari, -1, 300);
  await pay({ type: 'incoming', invoice: paid }, 300);    // fully paid
  const voided = await invoice(sari, 5, 700);
  await run(db, owner, `select erp_void_invoice($1, 'Wrong customer')`, [voided]);

  const b = await balances(owner, 'customers', [budi, sari, nobody]);
  assert.deepEqual(b, { [budi]: { outstanding: 1250, overdue: 250, open: 2 } });
});

test('supplier balance = approved or received purchase orders not yet paid', async () => {
  const quarry = await party('erp_suppliers', 'Solar supplier');
  const order = async (status, qty) => {
    const [{ id }] = await run(db, owner, `select erp_create_purchase_order_v3($1, $2, 'Solar supplier', current_date, '', $3::jsonb, null, null) as id`,
      [ws, quarry, JSON.stringify([{ product_name: 'Solar', qty, price: 10, unit: 'l' }])]);
    if (status !== 'pending') await run(db, owner, `select erp_update_purchase_order_status($1, $2)`, [id, status]);
    return id;
  };
  await order('pending', 100);                    // not owed yet
  const approved = await order('approved', 50);   // 500
  await pay({ type: 'outgoing', po: approved }, 200);
  await order('approved', 30);                    // 300
  const b = await balances(owner, 'suppliers', [quarry]);
  assert.deepEqual(b, { [quarry]: { outstanding: 600, overdue: 0, open: 2 } });
});

test('only what the caller may read counts, and the input is checked', async () => {
  const outsider = await createUser(db, 'bal-outsider');
  const budi = await party('erp_customers', 'Hidden');
  await invoice(budi, 10, 50);
  assert.deepEqual(await balances(outsider, 'customers', [budi]), {}, 'row-level security hides other ERPs');
  await expectError(run(db, owner, `select * from erp_party_balances($1, 'employees', '{}')`, [ws]), /Unknown kind/);
  await expectError(run(db, owner, `select * from erp_party_balances(null, 'customers', '{}')`), /Choose an ERP/);
});
