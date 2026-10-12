import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, runOnPath, admin, expectError } from './harness.mjs';

let db;
let owner;
let operator;
let sales;
let ws;
let ownerId;
let boulders;
let split;
let dust;
let stockpileA;
const year = new Date().getFullYear();

const record = (user, body) =>
  run(db, user, `select erp_production_record($1, $2::jsonb) as id`, [
    ws,
    JSON.stringify(body),
  ]).then((r) => r[0].id);
const stockOf = async (id) =>
  Number(
    (await admin(db, `select current_stock from erp_products where id = $1`, [id]))[0].current_stock
  );
const inWarehouse = async (wh, product) =>
  Number(
    (
      await admin(
        db,
        `select coalesce(sum(quantity), 0) as q from erp_warehouse_stock where warehouse_id = $1 and product_id = $2`,
        [wh, product]
      )
    )[0].q
  );
const inventoryBalance = async () => {
  const [row] = await admin(
    db,
    `
    select coalesce(sum(l.debit - l.credit), 0) as bal
      from erp_journal_lines l join erp_journal_entries e on e.id = l.entry_id
      join erp_gl_accounts a on a.id = l.account_id
     where e.user_id = $1 and a.system_key = 'inventory'`,
    [ownerId]
  );
  return Number(row.bal);
};

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'pr-owner');
  [{ id: ws }] = await run(db, owner, `select erp_create_erp_v2('Batu Jaya', 'quarry') as id`);
  const join = async (role) => {
    const user = await createUser(db, `pr-${role}`);
    const [{ access_code }] = await run(
      db,
      owner,
      `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`,
      [ws, role]
    );
    await run(db, user, `select erp_redeem_workspace_invitation($1)`, [access_code]);
    return user;
  };
  operator = await join('inventory');
  sales = await join('sales');
  [{ owner_id: ownerId }] = await admin(db, `select owner_id from erp_workspaces where id = $1`, [
    ws,
  ]);
  const product = async (name, unit, cost, stock = 0) =>
    (
      await run(
        db,
        owner,
        `insert into erp_products (user_id, workspace_id, name, unit, purchase_price, current_stock) values ($1, $2, $3, $4, $5, $6) returning id`,
        [ownerId, ws, name, unit, cost, stock]
      )
    )[0].id;
  boulders = await product('Batu belah', 'ton', 20000, 500);
  split = await product('Split 1/2', 'm3', 90000);
  dust = await product('Abu batu', 'm3', 30000);
  [{ id: stockpileA }] = await run(
    db,
    owner,
    `select erp_create_warehouse($1, 'SP-A', 'Stockpile A') as id`,
    [ws]
  );
});

test('a run adds outputs to their stockpile, takes the input, numbers itself and posts the value difference', async () => {
  const before = await inventoryBalance();
  const id = await record(operator, {
    shift: 'Day',
    plant: 'Crusher 1',
    hours: 8,
    downtime_hours: 1.5,
    input: { product_id: boulders, qty: 150 },
    outputs: [
      { product_id: split, qty: 60, warehouse_id: stockpileA },
      { product_id: dust, qty: 25 },
    ],
  });
  const [run_] = await admin(
    db,
    `select doc_no, input_qty, hours, status from erp_production_runs where id = $1`,
    [id]
  );
  assert.equal(run_.doc_no, `PRD/${year}/0001`);
  assert.equal(Number(run_.input_qty), 150);
  assert.equal(await stockOf(boulders), 350);
  assert.equal(await stockOf(split), 60);
  assert.equal(await stockOf(dust), 25);
  assert.equal(await inWarehouse(stockpileA, split), 60, 'split went to its stockpile');
  // Outputs 60 × 90,000 + 25 × 30,000 = 6,150,000; input 150 × 20,000 = 3,000,000.
  assert.equal((await inventoryBalance()) - before, 3150000);
  const movements = await admin(
    db,
    `select count(*)::int as n from erp_stock_movements where source_type in ('production', 'production_input')
    and (source_id = $1 or source_id in (select id from erp_production_outputs where run_id = $1))`,
    [id]
  );
  assert.equal(movements[0].n, 3);
});

test('checks: module, role, quantities, duplicates, stock, future dates', async () => {
  await expectError(record(sales, { outputs: [{ product_id: split, qty: 1 }] }), /does not allow/);
  await expectError(record(operator, { outputs: [] }), /at least one product/);
  await expectError(
    record(operator, { outputs: [{ product_id: split, qty: 0 }] }),
    /greater than zero/
  );
  await expectError(
    record(operator, {
      outputs: [
        { product_id: split, qty: 1 },
        { product_id: split, qty: 2 },
      ],
    }),
    /only once/
  );
  await expectError(
    record(operator, {
      input: { product_id: boulders, qty: 1 },
      outputs: [{ product_id: boulders, qty: 1 }],
    }),
    /both made and used/
  );
  await expectError(
    record(operator, {
      input: { product_id: boulders, qty: 10000 },
      outputs: [{ product_id: split, qty: 1 }],
    }),
    /Insufficient stock/
  );
  await expectError(
    record(operator, { run_date: '2999-01-01', outputs: [{ product_id: split, qty: 1 }] }),
    /future/
  );
  await expectError(
    record(operator, { hours: 20, downtime_hours: 6, outputs: [{ product_id: split, qty: 1 }] }),
    /between 0 and 24/
  );
  await expectError(
    record(operator, {
      input: { product_id: boulders, qty: 10, warehouse_id: stockpileA },
      outputs: [{ product_id: split, qty: 1 }],
    }),
    /in that stockpile/
  );
  await run(db, owner, `select erp_set_workspace_industry($1, 'quarry', array['weighbridge'])`, [
    ws,
  ]);
  await expectError(
    record(operator, { outputs: [{ product_id: split, qty: 1 }] }),
    /module is switched off/
  );
  await run(db, owner, `select erp_set_workspace_industry($1, 'quarry')`, [ws]);
  await expectError(
    run(db, owner, `insert into erp_production_runs (user_id) values ($1)`, [ownerId]),
    /permission denied/
  );
});

test('reversing: Owner or Admin with a reason; stock, stockpiles and books go back', async () => {
  const before = {
    inv: await inventoryBalance(),
    split: await stockOf(split),
    boulders: await stockOf(boulders),
  };
  const id = await record(operator, {
    input: { product_id: boulders, qty: 50 },
    outputs: [{ product_id: split, qty: 20, warehouse_id: stockpileA }],
  });
  await expectError(
    run(db, operator, `select erp_production_reverse($1, 'Typo')`, [id]),
    /Only the Owner or an Admin/
  );
  await expectError(run(db, owner, `select erp_production_reverse($1, '')`, [id]), /Give a reason/);
  await run(db, owner, `select erp_production_reverse($1, 'Entered twice')`, [id]);
  assert.equal(await stockOf(split), before.split);
  assert.equal(await stockOf(boulders), before.boulders);
  assert.equal(await inWarehouse(stockpileA, split), 60);
  assert.equal(await inventoryBalance(), before.inv);
  assert.equal(
    (await admin(db, `select status from erp_production_runs where id = $1`, [id]))[0].status,
    'reversed'
  );
});

test('the summary totals posted runs per product and per day; sales cannot read production', async () => {
  const [{ s }] = await run(
    db,
    operator,
    `select erp_production_summary($1, current_date, current_date) as s`,
    [ws]
  );
  assert.equal(s.runs, 1);
  assert.equal(Number(s.hours), 8);
  assert.deepEqual(
    s.outputs.map((o) => [o.product_name, Number(o.qty)]),
    [
      ['Abu batu', 25],
      ['Split 1/2', 60],
    ]
  );
  assert.deepEqual(
    s.inputs.map((o) => [o.product_name, Number(o.qty)]),
    [['Batu belah', 150]]
  );
  assert.equal(s.days.length, 1);
  assert.deepEqual(await run(db, sales, `select id from erp_production_runs`), []);
});

test('a reset removes production runs', async () => {
  await runOnPath(db, owner, '/account/reset', `select erp_reset_workspace($1, 'transactions')`, [
    ws,
  ]);
  assert.equal(
    (
      await admin(
        db,
        `select count(*)::int as n from erp_production_runs where workspace_id = $1`,
        [ws]
      )
    )[0].n,
    0
  );
});

test('rollback removes production', async () => {
  const d = await createDb();
  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261012000025_erp_production.sql', import.meta.url),
      'utf8'
    )
  );
  const { rows } = await d.query(
    `select to_regclass('public.erp_production_runs') is null as gone`
  );
  assert.equal(rows[0].gone, true);
  await d.close();
});
