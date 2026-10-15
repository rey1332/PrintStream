import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let finance;
let sales;
let buyer;
let ws;
let ownerId;
let customerId;
let supplierId;

const NPWP_SELLER = '0012345678901000';
const NITKU_SELLER = '0012345678901000000000';
const NPWP_BUYER = '0098765432109000';
const NITKU_BUYER = '0098765432109000000000';

/** The ledger lines of one entry, by system key (or account code): { key: debit - credit }. */
async function entry(sourceKey) {
  const rows = await admin(
    db,
    `select coalesce(a.system_key, a.code) as k, sum(l.debit - l.credit)::numeric as net
       from erp_journal_entries e join erp_journal_lines l on l.entry_id = e.id join erp_gl_accounts a on a.id = l.account_id
      where e.source_key = $1 group by 1`,
    [sourceKey]
  );
  return Object.fromEntries(rows.map((r) => [r.k, Number(r.net)]));
}

const invoice = async (user, { subtotal = 1_000_000, rate = 11 } = {}) =>
  (
    await run(
      db,
      user,
      `select erp_create_invoice_v6($1, $2, 'PT Pembeli', current_date, current_date + 30, $3::jsonb, $4, null, null) as id`,
      [ws, customerId, JSON.stringify([{ description: 'Batu split 1/2', qty: 10, unit: 'm3', price: subtotal / 10 }]), rate]
    )
  )[0].id;

const bill = (user, body) =>
  run(db, user, `select erp_supplier_bill_create($1, $2::jsonb) as id`, [ws, JSON.stringify(body)]).then((r) => r[0].id);

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'tax-owner');
  [{ id: ws }] = await run(db, owner, `select erp_create_erp_v2('PT Batu Jaya', 'quarry') as id`);
  const join = async (role) => {
    const user = await createUser(db, `tax-${role}`);
    const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`, [ws, role]);
    await run(db, user, `select erp_redeem_workspace_invitation($1)`, [access_code]);
    return user;
  };
  finance = await join('finance');
  sales = await join('sales');
  buyer = await join('inventory');
  [{ owner_id: ownerId }] = await admin(db, `select owner_id from erp_workspaces where id = $1`, [ws]);
  await run(db, owner, `select erp_company_profile_set($1, $2::jsonb)`, [
    ws,
    JSON.stringify({ legal_name: 'PT Batu Jaya', tax_id: NPWP_SELLER, nitku: NITKU_SELLER }),
  ]);
  [{ id: customerId }] = await run(
    db,
    sales,
    `insert into erp_customers (user_id, workspace_id, name, tax_id_type, tax_id, nitku, is_pkp, tax_name, tax_address)
     values ($1, $2, 'Pembeli', 'npwp', $3, $4, true, 'PT Pembeli Makmur', 'Jl. Raya 1, Bogor') returning id`,
    [ownerId, ws, NPWP_BUYER, NITKU_BUYER]
  );
  [{ id: supplierId }] = await run(
    db,
    buyer,
    `insert into erp_suppliers (user_id, workspace_id, name, tax_id_type, tax_id, nitku, is_pkp)
     values ($1, $2, 'CV Sewa Alat', 'npwp', '0011122233344000', '0011122233344000000000', true) returning id`,
    [ownerId, ws]
  );
});

test('tax data: NPWP / NIK 16 digits, NITKU 22 digits, kept with the record', async () => {
  const bad = (fields) =>
    expectError(
      run(db, sales, `insert into erp_customers (user_id, workspace_id, name, tax_id_type, tax_id, nitku) values ($1, $2, 'x', $3, $4, $5)`, [
        ownerId, ws, ...fields,
      ]),
      /erp_customers_tax_check/
    );
  await bad(['npwp', '12345', '']);
  await bad(['nik', '12345678901234567', '']);
  await bad(['npwp', NPWP_BUYER, '123']);
  await bad([null, NPWP_BUYER, '']);
  const [{ id }] = await run(db, sales, `insert into erp_customers (user_id, workspace_id, name, tax_id_type, tax_id) values ($1, $2, 'Perorangan', 'nik', '3201012345670001') returning id`, [ownerId, ws]);
  assert.ok(id);
  await expectError(run(db, owner, `select erp_company_profile_set($1, '{"nitku":"123"}'::jsonb)`, [ws]), /NITKU has 22 digits/);
  const profile = (await run(db, owner, `select erp_company_profile_get($1) as p`, [ws]))[0].p;
  assert.equal(profile.nitku, NITKU_SELLER);
});

test('e-Faktur: taxed invoices list with what is missing, export, then the approved number', async () => {
  const inv = await invoice(sales);
  const untaxed = await invoice(sales, { rate: 0 });
  const list = await run(db, finance, `select * from erp_tax_faktur_list($1, current_date - 1, current_date)`, [ws]);
  const row = list.find((r) => r.invoice_id === inv);
  assert.ok(row, 'the taxed invoice is listed');
  assert.ok(!list.some((r) => r.invoice_id === untaxed), 'untaxed invoices are not');
  assert.equal(row.trx_code, '04', '11% is DPP nilai lain 11/12 at 12%');
  assert.deepEqual(row.missing, []);
  assert.equal(Number(row.tax_amount), 110000);

  const [{ data }] = await run(db, sales, `select erp_tax_faktur_export($1, $2::uuid[]) as data`, [ws, [inv]]);
  assert.equal(data.seller.npwp, NPWP_SELLER);
  assert.equal(data.invoices[0].buyer.tax_id, NPWP_BUYER);
  assert.equal(data.invoices[0].buyer.name, 'PT Pembeli Makmur', 'the tax name, not the short name');
  assert.equal(data.invoices[0].lines.length, 1);
  assert.equal(data.invoices[0].lines[0].item_code, '000000');
  assert.equal((await admin(db, `select faktur_status from erp_invoices where id = $1`, [inv]))[0].faktur_status, 'exported');
  await expectError(run(db, sales, `select erp_tax_faktur_export($1, $2::uuid[])`, [ws, [untaxed]]), /Only taxed/);
  await expectError(run(db, buyer, `select erp_tax_faktur_export($1, $2::uuid[])`, [ws, [inv]]), /role does not allow/);

  await expectError(run(db, sales, `select erp_tax_faktur_set($1, null, '123', null)`, [inv]), /17 digits/);
  await run(db, sales, `select erp_tax_faktur_set($1, null, '04002500000000123', current_date)`, [inv]);
  const stored = (await admin(db, `select faktur_status, faktur_number from erp_invoices where id = $1`, [inv]))[0];
  assert.deepEqual(stored, { faktur_status: 'approved', faktur_number: '04002500000000123' });
  const other = await invoice(sales);
  await expectError(run(db, sales, `select erp_tax_faktur_set($1, null, '04002500000000123', null)`, [other]), /already has this faktur number/);
  await expectError(run(db, sales, `select erp_tax_faktur_set($1, '01', '04002500000000123', null)`, [inv]), /cannot change/);
});

test('supplier bills: PPh 23 withheld, PPN masukan with the faktur, paid against Accounts payable', async () => {
  await expectError(bill(buyer, { supplier_id: supplierId, bill_date: new Date().toISOString().slice(0, 10), description: 'Sewa excavator', subtotal: 10_000_000, ppn_amount: 1_100_000 }), /needs the supplier's faktur number/);
  await expectError(bill(buyer, { supplier_id: supplierId, bill_date: new Date().toISOString().slice(0, 10), description: 'Sewa excavator', subtotal: 10_000_000, pph23_rate: 2 }), /tax object code/);
  await expectError(bill(sales, { supplier_id: supplierId, bill_date: new Date().toISOString().slice(0, 10), description: 'x', subtotal: 1 }), /role does not allow/);

  const id = await bill(buyer, {
    supplier_id: supplierId,
    bill_no: 'SA/10/001',
    bill_date: new Date().toISOString().slice(0, 10),
    description: 'Sewa excavator Oktober',
    subtotal: 10_000_000,
    ppn_amount: 1_100_000,
    faktur_number: '040025-00000000456',
    pph23_rate: 2,
    pph23_object_code: '24-104-01',
  });
  const b = (await admin(db, `select * from erp_supplier_bills where id = $1`, [id]))[0];
  assert.equal(Number(b.pph23_amount), 200_000);
  assert.equal(Number(b.total_payable), 10_900_000);
  assert.equal(b.faktur_number, '04002500000000456', 'stored as digits');
  assert.equal(b.supplier_name, 'CV Sewa Alat');
  assert.deepEqual(await entry(`supplier_bill:${id}`), { expenses: 10_000_000, tax_in: 1_100_000, ap: -10_900_000, pph23_payable: -200_000 });

  await expectError(run(db, buyer, `select erp_supplier_bill_pay($1, 1000, current_date, 'transfer')`, [id]), /role does not allow/);
  await expectError(run(db, finance, `select erp_supplier_bill_pay($1, 20000000, current_date, 'transfer')`, [id]), /at most what is still owed/);
  const [{ pay }] = await run(db, finance, `select erp_supplier_bill_pay($1, 10900000, current_date, 'transfer') as pay`, [id]);
  assert.deepEqual(await entry(`payment:${pay}`), { ap: 10_900_000, cash: -10_900_000 });
  assert.equal((await admin(db, `select status from erp_supplier_bills where id = $1`, [id]))[0].status, 'paid');
  await expectError(run(db, owner, `select erp_supplier_bill_void($1, 'wrong bill')`, [id]), /Void its payments first/);

  await run(db, buyer, `select erp_supplier_bill_bupot($1, 'BP-2610-0001', current_date)`, [id]);
  assert.equal((await admin(db, `select bupot_number from erp_supplier_bills where id = $1`, [id]))[0].bupot_number, 'BP-2610-0001');

  // An unpaid bill without a bukti potong: the Owner voids it, its entry is reversed.
  const second = await bill(buyer, { supplier_name: 'Bengkel Maju', bill_date: new Date().toISOString().slice(0, 10), description: 'Servis', subtotal: 500_000 });
  await expectError(run(db, buyer, `select erp_supplier_bill_void($1, 'duplicate')`, [second]), /Only the Owner or an Admin/);
  await run(db, owner, `select erp_supplier_bill_void($1, 'duplicate')`, [second]);
  assert.deepEqual(await entry(`supplier_bill_void:${second}`), { expenses: -500_000, ap: 500_000 });
});

test('PPh 23 withheld by a customer settles the invoice on Prepaid PPh 23', async () => {
  const inv = await invoice(sales, { subtotal: 5_000_000, rate: 11 });
  await expectError(run(db, sales, `select erp_invoice_pph23_withheld($1, 100000, current_date, '')`, [inv]), /bukti potong number/);
  await expectError(run(db, sales, `select erp_invoice_pph23_withheld($1, 99000000, current_date, 'BP-1')`, [inv]), /at most what is still open/);
  const [{ id }] = await run(db, sales, `select erp_invoice_pph23_withheld($1, 100000, current_date, 'BP-CUST-77') as id`, [inv]);
  assert.deepEqual(await entry(`payment:${id}`), { pph23_prepaid: 100_000, ar: -100_000 });
  const after = (await admin(db, `select amount_paid, total from erp_invoices where id = $1`, [inv]))[0];
  assert.equal(Number(after.amount_paid), 100_000, 'counts toward the invoice like a payment');
});

test('monthly summary: PPN out and in, PPh 23 both ways, open fakturs and bukti potong', async () => {
  const [row] = await run(db, finance, `select * from erp_tax_summary($1, date_trunc('month', current_date)::date, current_date)`, [ws]);
  // PPN keluaran is what the month's invoices charged; masukan the one bill's 1,100,000.
  const [{ charged }] = await admin(db, `select sum(tax_amount)::numeric as charged from erp_invoices where workspace_id = $1 and status::text <> 'void'`, [ws]);
  assert.equal(Number(row.ppn_out), Number(charged));
  assert.equal(Number(charged), 2 * 110_000 + 550_000);
  assert.equal(Number(row.ppn_in), 1_100_000);
  assert.equal(Number(row.ppn_net), Number(charged) - 1_100_000);
  assert.equal(Number(row.pph23_withheld), 200_000);
  assert.equal(Number(row.pph23_prepaid), 100_000);
  assert.equal(row.bills_with_pph23, 1);
  assert.equal(row.bills_without_bupot, 0);
  assert.equal(row.invoices_taxed, 3);
  assert.equal(row.invoices_without_faktur, 2, 'one of the three has its approved number');
  await expectError(run(db, buyer, `select * from erp_tax_summary($1, current_date, current_date)`, [ws]), /role does not allow/);
});

test('reset: bills go with the documents', async () => {
  const before = (await admin(db, `select count(*)::int as n from erp_supplier_bills where workspace_id = $1`, [ws]))[0].n;
  assert.ok(before > 0);
  await admin(db, `select erp__reset_modules($1, 'transactions')`, [ws]);
  assert.equal((await admin(db, `select count(*)::int as n from erp_supplier_bills where workspace_id = $1`, [ws]))[0].n, 0);
});

test('rollback removes bills and tax fields; payments keep posting', async () => {
  const { readFileSync } = await import('node:fs');
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000053_erp_indonesian_tax.sql', import.meta.url), 'utf8'));
  const gone = await d.query(`select to_regclass('public.erp_supplier_bills') as t,
    (select count(*)::int from information_schema.columns where table_name = 'erp_customers' and column_name = 'tax_id') as c,
    (select count(*)::int from information_schema.columns where table_name = 'erp_invoices' and column_name = 'faktur_number') as f`);
  assert.deepEqual(gone.rows[0], { t: null, c: 0, f: 0 });
  const def = await d.query(`select pg_get_functiondef('public.erp_gl__payment_lines(erp_payments, numeric)'::regprocedure) as d`);
  assert.ok(!def.rows[0].d.includes('supplier_bill_id'));
  await d.close();
});
