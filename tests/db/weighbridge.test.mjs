import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, runOnPath, admin, expectError } from './harness.mjs';

let db;
let owner;
let operator;
let sales;
let ws;
let split;
let customer;
const year = new Date().getFullYear();

const weighIn = (user, ticket) =>
  run(db, user, `select erp_weigh_in($1, $2::jsonb) as id`, [ws, JSON.stringify(ticket)]).then(
    (r) => r[0].id
  );
const weighOut = (user, id, kg, price = null, override = null) =>
  run(db, user, `select erp_weigh_out($1, $2, $3, $4)`, [id, kg, price, override]);
const ticket = async (id) =>
  (await admin(db, `select * from erp_weigh_tickets where id = $1`, [id]))[0];
const stock = async () =>
  Number(
    (await admin(db, `select current_stock from erp_products where id = $1`, [split]))[0]
      .current_stock
  );

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'wb-owner');
  [{ id: ws }] = await run(db, owner, `select erp_create_erp_v2('Batu Jaya', 'quarry') as id`);
  const join = async (role) => {
    const user = await createUser(db, `wb-${role}`);
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
  const [{ owner_id }] = await admin(db, `select owner_id from erp_workspaces where id = $1`, [ws]);
  [{ id: split }] = await run(
    db,
    owner,
    `insert into erp_products (user_id, workspace_id, name, unit, density, current_stock, selling_price, purchase_price)
     values ($1, $2, 'Split 1/2', 'm3', 1.5, 100, 250000, 100000) returning id`,
    [owner_id, ws]
  );
  [{ id: customer }] = await run(
    db,
    owner,
    `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'PT Beton Kuat') returning id`,
    [owner_id, ws]
  );
});

test('weigh in empty, weigh out loaded: net weight becomes m³ through the density; stock and cost follow', async () => {
  const id = await weighIn(operator, {
    plate_no: 'B 1234 XYZ',
    driver_name: 'Budi',
    customer_id: customer,
    product_id: split,
    first_kg: 8000,
  });
  const open = await ticket(id);
  assert.equal(open.doc_no, `WB/${year}/0001`);
  assert.equal(open.status, 'open');
  assert.equal(Number(open.price), 250000, 'price from the product');

  await weighOut(operator, id, 23000);
  const done = await ticket(id);
  assert.equal(done.status, 'completed');
  assert.equal(Number(done.net_kg), 15000);
  assert.equal(Number(done.qty), 10, '15 t / 1.5 t per m³');
  assert.equal(Number(done.amount), 2500000);
  assert.equal(await stock(), 90);

  const [movement] = await admin(
    db,
    `select movement_type, quantity from erp_stock_movements where source_type = 'weigh_ticket' and source_id = $1`,
    [id]
  );
  assert.deepEqual(
    { type: movement.movement_type, qty: Number(movement.quantity) },
    { type: 'out', qty: 10 }
  );
  const [journal] = await admin(
    db,
    `select count(*)::int as n from erp_journal_entries where source_type = 'weigh_ticket' and source_id = $1`,
    [id]
  );
  assert.equal(journal.n, 1, 'cost of goods posted');

  // The truck was registered and remembers its empty weight.
  const [truck] = await admin(
    db,
    `select plate_no, tare_kg, driver_name from erp_vehicles where workspace_id = $1`,
    [ws]
  );
  assert.deepEqual(
    { plate: truck.plate_no, tare: Number(truck.tare_kg), driver: truck.driver_name },
    { plate: 'B 1234 XYZ', tare: 8000, driver: 'Budi' }
  );
});

test('a known truck is found by plate in any spelling and can use its stored tare; one open ticket per truck', async () => {
  const id = await weighIn(operator, {
    plate_no: 'b1234xyz',
    customer_id: customer,
    product_id: split,
    first_kg: 20000,
  });
  const t = await ticket(id);
  assert.equal(t.plate_no, 'B 1234 XYZ');
  assert.equal(t.driver_name, 'Budi', 'driver from the truck');
  assert.equal(Number(t.price), 250000, 'last price this customer paid');
  await expectError(
    weighIn(operator, {
      plate_no: 'B-1234-XYZ',
      customer_name: 'Walk-in',
      product_id: split,
      first_kg: 9000,
    }),
    /already has an open ticket/
  );
  await weighOut(operator, id, null);
  assert.equal(Number((await ticket(id)).qty), 8, '(20000 − 8000) kg / 1.5');
});

test('only sales roles change prices; an operator cannot', async () => {
  await expectError(
    weighIn(operator, {
      plate_no: 'L 1 AB',
      customer_name: 'Walk-in',
      product_id: split,
      first_kg: 7000,
      price: 1,
    }),
    /changing prices/
  );
  const id = await weighIn(operator, {
    plate_no: 'L 1 AB',
    customer_name: 'Walk-in',
    product_id: split,
    first_kg: 7000,
  });
  await expectError(weighOut(operator, id, 10000, 1), /changing prices/);
  await expectError(weighOut(sales, id, 10000), /does not allow/);
  await weighOut(owner, id, 10000, 240000);
  assert.equal(Number((await ticket(id)).price), 240000);
});

test('credit limit: blocks a truck, the Owner can let it through with a reason', async () => {
  await admin(db, `update erp_customers set credit_limit = 5000000 where id = $1`, [customer]);
  // Owed so far: 2,500,000 + 2,000,000 = 4,500,000. This load (3 m³ = 750,000) would exceed it.
  const id = await weighIn(operator, {
    plate_no: 'B 9 QQ',
    customer_id: customer,
    product_id: split,
    first_kg: 6000,
  });
  await expectError(
    weighOut(operator, id, 10500),
    /Credit limit of 5000000 reached for PT Beton Kuat/
  );
  await expectError(
    weighOut(operator, id, 10500, null, 'Paid cash'),
    /Credit limit/,
    'an operator cannot override'
  );
  await weighOut(owner, id, 10500, null, 'Director approved by phone');
  assert.equal((await ticket(id)).credit_override, 'Director approved by phone');
  // Now above the limit: the next truck is stopped at the first weighing.
  await expectError(
    weighIn(operator, {
      plate_no: 'B 10 QQ',
      customer_id: customer,
      product_id: split,
      first_kg: 6000,
    }),
    /Credit limit/
  );
  const [row] = await run(
    db,
    operator,
    `select credit_limit, exposure from erp_weigh_customers($1) where id = $2`,
    [ws, customer]
  );
  assert.deepEqual(
    { limit: Number(row.credit_limit), exposure: Number(row.exposure) },
    { limit: 5000000, exposure: 5250000 }
  );
  await admin(db, `update erp_customers set credit_limit = null where id = $1`, [customer]);
});

test('invoicing tickets: one invoice with a line per product and price; voiding frees the tickets', async () => {
  await expectError(
    run(
      db,
      operator,
      `select erp_weigh_tickets_invoice($1, $2, current_date, current_date, 11, null)`,
      [ws, customer]
    ),
    /does not allow/
  );
  const [{ id: invoice }] = await run(
    db,
    owner,
    `select erp_weigh_tickets_invoice($1, $2, current_date - 1, current_date, 11, null) as id`,
    [ws, customer]
  );
  const lines = await admin(
    db,
    `select description, qty, unit, price from erp_invoice_lines where invoice_id = $1 order by position`,
    [invoice]
  );
  assert.deepEqual(
    lines.map((l) => [l.description, Number(l.qty), l.unit, Number(l.price)]),
    [['Split 1/2', 21, 'm3', 250000]]
  );
  const [inv] = await admin(
    db,
    `select total - tax_amount as subtotal, total from erp_invoices where id = $1`,
    [invoice]
  );
  assert.equal(Number(inv.subtotal), 5250000);
  assert.equal(Number(inv.total), 5827500, '11% PPN');
  const [{ n }] = await admin(
    db,
    `select count(*)::int as n from erp_weigh_tickets where invoice_id = $1`,
    [invoice]
  );
  assert.equal(n, 3);
  await expectError(
    run(
      db,
      owner,
      `select erp_weigh_tickets_invoice($1, $2, current_date, current_date, 11, null)`,
      [ws, customer]
    ),
    /No tickets to invoice/
  );

  await run(db, owner, `select erp_void_invoice($1, 'Wrong period')`, [invoice]);
  const [{ free }] = await admin(
    db,
    `select count(*)::int as free from erp_weigh_tickets where customer_id = $1 and status = 'completed' and invoice_id is null`,
    [customer]
  );
  assert.equal(free, 3);
});

test('cancelling: open tickets by the operator, completed ones by Owner/Admin with stock and cost reversed', async () => {
  const open = await weighIn(operator, {
    plate_no: 'D 5 CC',
    customer_name: 'Walk-in',
    product_id: split,
    first_kg: 5000,
  });
  await expectError(run(db, operator, `select erp_weigh_cancel($1, '')`, [open]), /Give a reason/);
  await run(db, operator, `select erp_weigh_cancel($1, 'Driver left')`, [open]);
  assert.equal((await ticket(open)).status, 'cancelled');

  const id = await weighIn(operator, {
    plate_no: 'D 5 CC',
    customer_name: 'Walk-in',
    product_id: split,
    first_kg: 5000,
  });
  await weighOut(operator, id, 8000);
  const before = await stock();
  await expectError(
    run(db, operator, `select erp_weigh_cancel($1, 'Mistake')`, [id]),
    /Only the Owner or an Admin/
  );
  await run(db, owner, `select erp_weigh_cancel($1, 'Wrong product loaded')`, [id]);
  assert.equal(await stock(), before + 2);
  const [{ n }] = await admin(
    db,
    `select count(*)::int as n from erp_journal_entries where source_type = 'weigh_ticket_cancel' and source_id = $1`,
    [id]
  );
  assert.equal(n, 1);
});

test('weights, units and stock are checked', async () => {
  const [{ owner_id }] = await admin(db, `select owner_id from erp_workspaces where id = $1`, [ws]);
  const [{ id: bags }] = await run(
    db,
    owner,
    `insert into erp_products (user_id, workspace_id, name, unit, current_stock) values ($1, $2, 'Cement', 'pcs', 10) returning id`,
    [owner_id, ws]
  );
  const [{ id: sand }] = await run(
    db,
    owner,
    `insert into erp_products (user_id, workspace_id, name, unit, current_stock) values ($1, $2, 'Sand', 'm3', 10) returning id`,
    [owner_id, ws]
  );
  await expectError(
    weighIn(operator, { plate_no: 'E 1 A', customer_name: 'X', product_id: bags, first_kg: 5000 }),
    /cannot be weighed/
  );
  await expectError(
    weighIn(operator, { plate_no: 'E 1 A', customer_name: 'X', product_id: sand, first_kg: 5000 }),
    /Set the density of Sand/
  );
  await expectError(
    weighIn(operator, { plate_no: 'E 1 A', customer_name: 'X', product_id: split, first_kg: 0 }),
    /Enter the weight/
  );
  await expectError(
    weighIn(operator, { plate_no: 'E 1 A', product_id: split, first_kg: 5000 }),
    /Choose a customer/
  );
  const id = await weighIn(operator, {
    plate_no: 'E 1 A',
    customer_name: 'X',
    product_id: split,
    first_kg: 5000,
  });
  await expectError(weighOut(operator, id, 5000), /same/);
  await expectError(weighOut(operator, id, 200000), /Insufficient stock/);
});

test('the module must be on; other ERPs cannot see tickets', async () => {
  const outsider = await createUser(db, 'wb-outsider');
  assert.deepEqual(await run(db, outsider, `select id from erp_weigh_tickets`), []);
  assert.ok(
    (await run(db, sales, `select id from erp_weigh_tickets`)).length > 0,
    'sales reads tickets'
  );
  await run(db, owner, `select erp_set_workspace_industry($1, 'quarry', array['production'])`, [
    ws,
  ]);
  await expectError(
    weighIn(operator, { plate_no: 'F 1 A', customer_name: 'X', product_id: split, first_kg: 5000 }),
    /module is switched off/
  );
  await run(db, owner, `select erp_set_workspace_industry($1, 'quarry')`, [ws]);
  await expectError(
    run(
      db,
      owner,
      `insert into erp_weigh_tickets (user_id, plate_no, customer_name, product_name, unit, first_kg) values ($1, 'X 1', 'X', 'X', 'kg', 1)`,
      [owner.id]
    ),
    /permission denied/
  );
});

test('summary per product, and a reset removes tickets', async () => {
  const rows = await run(
    db,
    sales,
    `select product_name, tickets, qty from erp_weighbridge_summary($1, current_date, current_date)`,
    [ws]
  );
  assert.equal(rows[0].product_name, 'Split 1/2');
  assert.ok(rows[0].tickets >= 4);
  await runOnPath(db, owner, '/account/reset', `select erp_reset_workspace($1, 'transactions')`, [
    ws,
  ]);
  assert.equal(
    (
      await admin(db, `select count(*)::int as n from erp_weigh_tickets where workspace_id = $1`, [
        ws,
      ])
    )[0].n,
    0
  );
  assert.ok(
    (
      await admin(db, `select count(*)::int as n from erp_vehicles where workspace_id = $1`, [ws])
    )[0].n > 0,
    'trucks stay'
  );
});

test('rollback removes the weighbridge', async () => {
  const d = await createDb();
  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261012000024_erp_weighbridge.sql', import.meta.url),
      'utf8'
    )
  );
  const { rows } = await d.query(`select to_regclass('public.erp_weigh_tickets') is null as gone`);
  assert.equal(rows[0].gone, true);
  await d.close();
});
