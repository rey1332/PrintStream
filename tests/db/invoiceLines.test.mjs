import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let ws;

const create = (user, lines, taxRate = 0) =>
  run(db, user, `select erp_create_invoice_v6($1, null, 'PT Beton', current_date, current_date + 30, $2::jsonb, $3, null, null) as id`,
    [ws, JSON.stringify(lines), taxRate]).then((r) => r[0].id);
const linesOf = (user, invoiceId) =>
  run(db, user, `select position, product_id, description, qty::float8 as qty, unit, price::float8 as price, subtotal::float8 as subtotal
    from erp_invoice_lines where invoice_id = $1 order by position`, [invoiceId]);

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'lines-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
});

test('a manual invoice is created from its lines; the subtotal is their sum in cents', async () => {
  const [{ id: split }] = await run(db, owner, `insert into erp_products (user_id, workspace_id, name, unit) values ($1, $2, 'Split 2/3', 'm3') returning id`, [owner.id, ws]);
  const id = await create(owner, [
    { product_id: split, qty: 12.345, price: 250000.5 },
    { description: 'Hauling to site', qty: 3, unit: 'rit', price: 450000 },
  ], 11);
  const lines = await linesOf(owner, id);
  assert.deepEqual(lines.map((l) => [l.position, l.description, l.qty, l.unit, l.subtotal]), [
    [1, 'Split 2/3', 12.345, 'm3', 3086256.17],
    [2, 'Hauling to site', 3, 'rit', 1350000],
  ]);
  const [inv] = await admin(db, `select total::float8 as total, tax_amount::float8 as tax from erp_invoices where id = $1`, [id]);
  assert.equal(inv.tax, Math.round(4436256.17 * 0.11 * 100) / 100);
  assert.equal(inv.total, Math.round((4436256.17 + inv.tax) * 100) / 100);
});

test('lines are checked, and cannot be changed afterwards', async () => {
  await expectError(create(owner, []), /between 1 and 200 lines/);
  await expectError(create(owner, [{ description: '', qty: 1, price: 1 }]), /needs a description/);
  await expectError(create(owner, [{ description: 'x', qty: 0, price: 1 }]), /quantity must be positive/);
  await expectError(create(owner, [{ product_id: '00000000-0000-0000-0000-000000000000', qty: 1, price: 1 }]), /Product not found/);
  const id = await create(owner, [{ description: 'Gravel', qty: 1, price: 10 }]);
  await expectError(run(db, owner, `update erp_invoice_lines set price = 0 where invoice_id = $1`, [id]), /permission denied/);
  await expectError(run(db, owner, `delete from erp_invoice_lines where invoice_id = $1`, [id]), /permission denied/);
  await expectError(run(db, owner, `insert into erp_invoice_lines (invoice_id, workspace_id, position, description, qty, price) values ($1, $2, 9, 'x', 1, 1)`, [id, ws]), /permission denied/);
  const outsider = await createUser(db, 'lines-outsider');
  assert.deepEqual(await linesOf(outsider, id), [], 'other accounts see nothing');
});

test('an invoice issued from a sales order gets the order lines', async () => {
  const [{ id: product }] = await run(db, owner, `insert into erp_products (user_id, workspace_id, name, unit, current_stock) values ($1, $2, 'Abu batu', 'm3', 100) returning id`, [owner.id, ws]);
  const [{ id: so }] = await run(db, owner, `select erp_create_sales_order_v3($1, null, 'CV Jalan', current_date, '', $2::jsonb, null, null) as id`,
    [ws, JSON.stringify([{ product_id: product, qty: 7.5, price: 90000 }])]);
  const [{ id }] = await run(db, owner, `select erp_issue_invoice_from_sales_order_v2($1, null, null) as id`, [so]);
  const lines = await linesOf(owner, id);
  assert.deepEqual(lines.map((l) => [l.description, l.qty, l.unit, l.price, l.product_id]), [['Abu batu', 7.5, 'm3', 90000, product]]);
});

test('rollback drops the lines', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000018_erp_invoice_lines.sql', import.meta.url), 'utf8'));
  const [row] = (await d.query(`select to_regclass('public.erp_invoice_lines') is null as gone,
    to_regprocedure('public.erp_create_invoice_v6(uuid, uuid, text, date, date, jsonb, numeric, text, numeric)') is null as fn_gone`)).rows;
  assert.deepEqual(row, { gone: true, fn_gone: true });
  await d.close();
});
