import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, expectError, items } from './harness.mjs';

let db;
let owner;
let outsider;
let ws;
let widget;
let bolt;

const product = async (name, stock, min, max, cost) =>
  (await run(db, owner,
    `insert into erp_products (user_id, workspace_id, name, sku, current_stock, min_stock, max_stock, purchase_price, selling_price)
     values ($1, $2, $3, upper($3), $4, $5, $6, $7::numeric, $7::numeric * 2) returning id`,
    [owner.id, ws, name, stock, min, max, cost]))[0].id;
const pay = async (type, amount, date) =>
  (await run(db, owner,
    `insert into erp_payments (user_id, workspace_id, payment_type, party, amount, payment_date)
     values ($1, $2, $3, 'Budi', $4, $5::date) returning id`,
    [owner.id, ws, type, amount, date]))[0].id;

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'stock-owner');
  outsider = await createUser(db, 'stock-outsider');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);

  widget = await product('Widget', 10, 5, 20, 4);  // 10 on hand, 6 reserved below → 4 available ≤ 5
  bolt = await product('Bolt', 100, 10, 200, 0.5); // plenty
  await product('Empty', 0, 0, 0, 0);              // nothing, minimum 0 → reorder (as before)
  await run(db, owner, `select erp_create_sales_order_v3($1, null, 'Walk-in', current_date, '', $2::jsonb, null, null)`,
    [ws, items([widget, 6])]);
  await run(db, owner, `select erp_adjust_stock($1, 'in', 5, 'count')`, [bolt]);

  await pay('incoming', 100, '2026-08-10');
  await pay('incoming', 50, '2026-09-01');
  await pay('outgoing', 30, '2026-09-15');
  const voided = await pay('outgoing', 999, '2026-09-20');
  await run(db, owner, `select erp_void_payment($1, 'typo')`, [voided]);
  await run(db, owner,
    `insert into erp_transactions (user_id, workspace_id, transaction_type, category, amount, description)
     values ($1, $2, 'expense', 'Other', 7, 'Coffee')`, [owner.id, ws]);
});

test('inventory stock: reserved, available, value at cost and reorder flag per product', async () => {
  const rows = await run(db, owner,
    `select name, current_stock::float8 as current_stock, reserved::float8 as reserved, available::float8 as available, stock_value::numeric as value, needs_reorder, suggested_qty::float8 as suggested_qty
     from erp_inventory_stock where workspace_id = $1 order by name`, [ws]);
  assert.deepEqual(
    rows.map((r) => [r.name, r.current_stock, r.reserved, r.available, Number(r.value), r.needs_reorder, r.suggested_qty]),
    [
      ['Bolt', 105, 0, 105, 52.5, false, 95],
      ['Empty', 0, 0, 0, 0, true, 0],
      ['Widget', 10, 6, 4, 40, true, 16],
    ]
  );
  // Row-level security of the products applies.
  assert.equal((await run(db, outsider, `select count(*)::int as n from erp_inventory_stock`))[0].n, 0);
});

test('inventory summary: products, value, reorder count and movements', async () => {
  const [{ s }] = await run(db, owner, `select erp_inventory_summary($1) as s`, [ws]);
  assert.deepEqual([s.products, Number(s.stock_value), s.reorder_count], [3, 92.5, 2]);
  assert.ok(s.movements >= 1, 'the stock count above is a movement');
  // Another account sees nothing of this ERP.
  const [{ s: other }] = await run(db, outsider, `select erp_inventory_summary($1) as s`, [ws]);
  assert.deepEqual([other.products, Number(other.stock_value), other.movements], [0, 0, 0]);
  await expectError(run(db, owner, `select erp_inventory_summary(null)`), /Choose an ERP/);
});

test('cash flow summary: base-currency money in and out per month, without voided payments', async () => {
  const [{ s }] = await run(db, owner, `select erp_cash_flow_summary($1) as s`, [ws]);
  // Transactions: one per payment, the voided one and its reversal, and the coffee.
  assert.deepEqual([Number(s.income), Number(s.expense), s.payments, s.transactions], [150, 30, 3, 6]);
  assert.deepEqual(
    s.monthly.map((m) => [m.month, Number(m.income), Number(m.expense)]),
    [['2026-08', 100, 0], ['2026-09', 50, 30]]
  );
  const [{ s: other }] = await run(db, outsider, `select erp_cash_flow_summary($1) as s`, [ws]);
  assert.deepEqual([Number(other.income), other.payments, other.monthly], [0, 0, []]);
});

test('rollback removes the view and both functions', async () => {
  const fresh = await createDb();
  await fresh.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000010_erp_inventory_cash_lists.sql', import.meta.url), 'utf8'));
  const { rows } = await fresh.query(
    `select (to_regclass('public.erp_inventory_stock') is null) as view_gone,
            (to_regprocedure('public.erp_inventory_summary(uuid)') is null) as inv_gone,
            (to_regprocedure('public.erp_cash_flow_summary(uuid)') is null) as cash_gone`
  );
  assert.deepEqual(rows[0], { view_gone: true, inv_gone: true, cash_gone: true });
});
