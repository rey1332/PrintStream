import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';
import { convertQty, UNIT_CODES } from '../../src/lib/units.ts';

let db;
before(async () => { db = await createDb(); });

const num = (v) => (v === null ? null : Number(v));
const stock = async (id) => num((await admin(db, `select current_stock from erp_products where id = $1`, [id]))[0].current_stock);

async function balances(user) {
  const rows = await run(db, user, `select system_key, balance::float as balance from erp_trial_balance(null, null, null)`);
  return Object.fromEntries(rows.filter((r) => r.system_key && r.balance !== 0).map((r) => [r.system_key, r.balance]));
}

test('quantities keep three decimals through stock, orders, reservations and deliveries', async () => {
  const user = await createUser(db, 'dec-split');
  const [{ id: p }] = await run(db, user, `insert into erp_products (user_id, name, unit, density, current_stock, purchase_price, selling_price)
    values ($1, 'Split 2/3', 'm3', 1.45, 0, 100000, 250000) returning id`, [user.id]);
  await run(db, user, `select erp_adjust_stock($1, 'in', 12.3754, 'Stockpile survey')`, [p]);
  assert.equal(await stock(p), 12.375, 'rounded to three decimals');

  const [{ id: so }] = await run(db, user, `select erp_create_sales_order_v3(null, null, 'PT Beton', current_date, '', $1::jsonb, null, null) as id`,
    [JSON.stringify([{ product_id: p, qty: 2.5, price: 250000.55 }])]);
  const [line] = await admin(db, `select id, qty::float8 as qty, unit, subtotal::float8 as subtotal from erp_sales_order_items where sales_order_id = $1`, [so]);
  assert.deepEqual({ qty: line.qty, unit: line.unit, subtotal: line.subtotal }, { qty: 2.5, unit: 'm3', subtotal: 625001.38 });
  assert.equal(Number((await admin(db, `select total from erp_sales_orders where id = $1`, [so]))[0].total), 625001.38);
  const [avail] = await admin(db, `select on_hand::float8 as on_hand, reserved::float8 as reserved, available::float8 as available, unit from erp_product_availability where product_id = $1`, [p]);
  assert.deepEqual(avail, { on_hand: 12.375, reserved: 2.5, available: 9.875, unit: 'm3' });

  await expectError(run(db, user, `select erp_create_sales_order_v3(null, null, 'Too much', current_date, '', $1::jsonb, null, null)`,
    [JSON.stringify([{ product_id: p, qty: 9.876, price: 1 }])]), /available 9\.875, requested 9\.876/);

  await run(db, user, `select erp_issue_invoice_from_sales_order_v2($1, null, null)`, [so]);
  await run(db, user, `select erp_record_sales_delivery($1, $2::jsonb, $3)`, [so, JSON.stringify([{ item_id: line.id, qty: 1.25 }]), randomUUID()]);
  assert.equal(await stock(p), 11.125);
  const [after] = await admin(db, `select qty_delivered::float8 as d from erp_sales_order_items where id = $1`, [line.id]);
  assert.equal(after.d, 1.25);
  const [movement] = await admin(db, `select quantity::float8 as q from erp_stock_movements where product_id = $1 and movement_type = 'out'`, [p]);
  assert.equal(movement.q, 1.25);
  await expectError(run(db, user, `select erp_record_sales_delivery($1, $2::jsonb, $3)`,
    [so, JSON.stringify([{ item_id: line.id, qty: 1.251 }]), randomUUID()]), /remaining 1\.25 units/);

  // The books stay balanced in cents: 1.25 m³ at 100,000 cost.
  const b = await balances(user);
  assert.equal(b.cogs, 125000);
  const [{ off }] = await run(db, user, `select count(*)::int as off from erp_journal_entries e
    where (select sum(debit) - sum(credit) from erp_journal_lines l where l.entry_id = e.id) <> 0`);
  assert.equal(off, 0);
});

test('receipts and transfers take decimals; a free-text order line keeps its own unit', async () => {
  const user = await createUser(db, 'dec-fuel');
  const [{ id: solar }] = await run(db, user, `insert into erp_products (user_id, name, unit, current_stock, purchase_price, selling_price)
    values ($1, 'Solar', 'l', 0, 6800, 0) returning id`, [user.id]);
  const [{ id: po }] = await run(db, user, `select erp_create_purchase_order_v3(null, null, 'Pertamina', current_date, '', $1::jsonb, null, null) as id`,
    [JSON.stringify([{ product_id: solar, qty: 5000.5, price: 6800 }, { product_name: 'Hauling', qty: 3, price: 450000, unit: 'rit' }])]);
  const lines = await admin(db, `select id, product_name, unit, qty::float8 as qty from erp_purchase_order_items where purchase_order_id = $1 order by product_name`, [po]);
  assert.deepEqual(lines.map((l) => [l.product_name, l.unit, l.qty]), [['Hauling', 'rit', 3], ['Solar', 'l', 5000.5]]);
  await run(db, user, `select erp_update_purchase_order_status($1, 'approved')`, [po]);
  const fuelLine = lines.find((l) => l.product_name === 'Solar');
  await run(db, user, `select erp_record_purchase_receipt_v2($1, $2::jsonb, $3, '', null)`, [po, JSON.stringify([{ item_id: fuelLine.id, qty: 4000.25 }]), randomUUID()]);
  assert.equal(await stock(solar), 4000.25);

  const [{ id: tank }] = await run(db, user, `select erp_create_warehouse(null, 'TANK2', 'Site tank') as id`);
  const [main] = await admin(db, `select id from erp_warehouses where user_id = $1 and is_default`, [user.id]);
  await run(db, user, `select erp_transfer_stock($1, $2, $3, 1250.125, 'To site')`, [solar, main.id, tank]);
  await expectError(run(db, user, `select erp_transfer_stock($1, $2, $3, 3000, '')`, [solar, main.id, tank]), /Only 2750\.125 units/);
  await expectError(run(db, user, `select erp_adjust_stock($1, 'out', 4000.251, '')`, [solar]), /Insufficient stock/);

  await expectError(run(db, user, `insert into erp_products (user_id, name, unit) values ($1, 'Bad', 'gallon')`, [user.id]), /unit_check/);
  await expectError(run(db, user, `insert into erp_products (user_id, name, unit, density) values ($1, 'Bad', 'ton', 0)`, [user.id]), /density_check/);
});

test('unit conversion: the database and the app agree', async () => {
  const cases = [
    [3, 'ton', 'm3', 1.5], [2, 'm3', 'ton', 1.5], [1500, 'kg', 'ton', null], [2.5, 'm3', 'l', null],
    [10, 'l', 'kg', 0.84], [1, 'ton', 'm3', null], [4, 'rit', 'm3', 1.5], [7, 'pcs', 'pcs', null],
    [1, 'hour', 'day', null], [12.345, 'ton', 'kg', null],
  ];
  for (const [qty, from, to, density] of cases) {
    const [{ v }] = await admin(db, `select erp_unit_convert($1, $2, $3, $4)::float8 as v`, [qty, from, to, density]);
    const app = convertQty(qty, from, to, density);
    if (app === null) assert.equal(v, null, `${qty} ${from} → ${to}`);
    else assert.ok(Math.abs(v - app) < 1e-9, `${qty} ${from} → ${to}: db ${v}, app ${app}`);
  }
  assert.equal(convertQty(3, 'ton', 'm3', 1.5), 2);
  for (const unit of UNIT_CODES) {
    assert.equal((await admin(db, `select erp_unit_valid($1) as ok`, [unit]))[0].ok, true, unit);
  }
  assert.equal((await admin(db, `select erp_unit_valid('gallon') as ok`))[0].ok, false);
});

test('rollback rounds quantities back to whole numbers and drops units', async () => {
  const d = await createDb();
  const owner = (await d.query(`select gen_random_uuid() as id`)).rows[0].id;
  await d.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'roll@example.test', '{}')`, [owner]);
  await d.query(`insert into erp_products (user_id, name, unit, current_stock) values ($1, 'Abu batu', 'm3', 7.6)`, [owner]);
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000015_erp_decimal_quantities_units.sql', import.meta.url), 'utf8'));
  const [row] = (await d.query(`select current_stock from erp_products where name = 'Abu batu'`)).rows;
  assert.equal(row.current_stock, 8);
  const [{ n }] = (await d.query(`select count(*)::int as n from information_schema.columns where table_name = 'erp_products' and column_name in ('unit', 'density')`)).rows;
  assert.equal(n, 0);
  assert.equal((await d.query(`select to_regprocedure('public.erp_adjust_stock(uuid, stock_movement_type, integer, text)') is not null as ok`)).rows[0].ok, true);
  await d.close();
});
