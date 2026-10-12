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
let solar;
let excavator;

const log = (user, body) =>
  run(db, user, `select erp_equipment_log($1, $2::jsonb) as id`, [ws, JSON.stringify(body)]).then(
    (r) => r[0].id
  );
const machine = async () =>
  (await admin(db, `select * from erp_equipment where id = $1`, [excavator]))[0];
const overview = async (user) =>
  (
    await run(
      db,
      user,
      `select * from erp_equipment_overview($1, current_date - 30, current_date) where equipment_id = $2`,
      [ws, excavator]
    )
  )[0];

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'eq-owner');
  [{ id: ws }] = await run(db, owner, `select erp_create_erp_v2('Batu Jaya', 'quarry') as id`);
  const join = async (role) => {
    const user = await createUser(db, `eq-${role}`);
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
  [{ id: solar }] = await run(
    db,
    owner,
    `insert into erp_products (user_id, workspace_id, name, unit, purchase_price, current_stock) values ($1, $2, 'Solar', 'l', 6800, 5000) returning id`,
    [ownerId, ws]
  );
  [{ id: excavator }] = await run(db, operator, `select erp_equipment_save($1, $2::jsonb) as id`, [
    ws,
    JSON.stringify({
      code: 'EX-01',
      name: 'Komatsu PC200',
      kind: 'excavator',
      initial_hour_meter: 12000,
      service_interval_hours: 250,
    }),
  ]);
});

test('hour meter readings give hours worked; readings never go back', async () => {
  await log(operator, {
    equipment_id: excavator,
    kind: 'hours',
    hour_meter: 12008.5,
    operator: 'Andi',
  });
  const [{ hours_worked }] = await admin(
    db,
    `select hours_worked from erp_equipment_logs where equipment_id = $1 and kind = 'hours'`,
    [excavator]
  );
  assert.equal(Number(hours_worked), 8.5);
  assert.equal(Number((await machine()).hour_meter), 12008.5);
  await expectError(
    log(operator, { equipment_id: excavator, kind: 'hours', hour_meter: 12000 }),
    /lower than the last one/
  );
  await expectError(
    log(operator, { equipment_id: excavator, kind: 'hours', hour_meter: 15000 }),
    /More than 1,000 hours/
  );
  await expectError(
    log(operator, { equipment_id: excavator, kind: 'hours' }),
    /hour meter reading/
  );
});

test('fuel issued leaves stock and is posted as an expense at cost', async () => {
  const id = await log(operator, {
    equipment_id: excavator,
    kind: 'fuel',
    liters: 150,
    fuel_product_id: solar,
    hour_meter: 12016.5,
  });
  assert.equal(
    Number(
      (await admin(db, `select current_stock from erp_products where id = $1`, [solar]))[0]
        .current_stock
    ),
    4850
  );
  const [entry] = await admin(
    db,
    `
    select sum(l.debit) filter (where a.system_key = 'expenses') as exp, sum(l.credit) filter (where a.system_key = 'inventory') as inv
      from erp_journal_entries e join erp_journal_lines l on l.entry_id = e.id join erp_gl_accounts a on a.id = l.account_id
     where e.source_type = 'fuel_issue' and e.source_id = $1`,
    [id]
  );
  assert.deepEqual([Number(entry.exp), Number(entry.inv)], [1020000, 1020000]);
  assert.equal(Number((await machine()).hour_meter), 12016.5, 'reading on the fuel issue counts');
  const o = await overview(operator);
  assert.deepEqual(
    [Number(o.hours), Number(o.liters), Number(o.liters_per_hour)],
    [16.5, 150, 9.09]
  );
  await expectError(
    log(operator, { equipment_id: excavator, kind: 'fuel', liters: 99999, fuel_product_id: solar }),
    /Insufficient stock/
  );
});

test('fuel must be a product in liters', async () => {
  const [{ id: gravel }] = await run(
    db,
    owner,
    `insert into erp_products (user_id, workspace_id, name, unit) values ($1, $2, 'Gravel', 'm3') returning id`,
    [ownerId, ws]
  );
  await expectError(
    log(operator, { equipment_id: excavator, kind: 'fuel', liters: 10, fuel_product_id: gravel }),
    /counted in liters/
  );
});

test('services reset the countdown to the next service', async () => {
  assert.equal(Number((await overview(operator)).service_due_in), 12000 + 250 - 12016.5);
  await log(operator, {
    equipment_id: excavator,
    kind: 'service',
    description: '250-hour service, oil and filters',
    amount: 3500000,
  });
  const m = await machine();
  assert.equal(Number(m.last_service_hours), 12016.5);
  assert.equal(Number((await overview(operator)).service_due_in), 250);
  await expectError(
    log(operator, { equipment_id: excavator, kind: 'service' }),
    /Describe the service/
  );
});

test('reversing (Owner or Admin): meter, last service and fuel go back', async () => {
  const fuel = await log(operator, {
    equipment_id: excavator,
    kind: 'fuel',
    liters: 50,
    fuel_product_id: solar,
    hour_meter: 12020,
  });
  await expectError(
    run(db, operator, `select erp_equipment_log_reverse($1, 'typo')`, [fuel]),
    /Only the Owner or an Admin/
  );
  await run(db, owner, `select erp_equipment_log_reverse($1, 'Wrong machine')`, [fuel]);
  assert.equal(Number((await machine()).hour_meter), 12016.5);
  assert.equal(
    Number(
      (await admin(db, `select current_stock from erp_products where id = $1`, [solar]))[0]
        .current_stock
    ),
    4850
  );
  const [{ n }] = await admin(
    db,
    `select count(*)::int as n from erp_journal_entries where source_type = 'fuel_issue_reversal' and source_id = $1`,
    [fuel]
  );
  assert.equal(n, 1);
  const [svc] = await admin(
    db,
    `select id from erp_equipment_logs where kind = 'service' and equipment_id = $1`,
    [excavator]
  );
  await run(db, owner, `select erp_equipment_log_reverse($1, 'Not done yet')`, [svc.id]);
  assert.equal((await machine()).last_service_hours, null);
});

test('access: sales cannot record or read; module must be on; no direct writes', async () => {
  await expectError(
    log(sales, { equipment_id: excavator, kind: 'hours', hour_meter: 12030 }),
    /does not allow/
  );
  assert.deepEqual(await run(db, sales, `select id from erp_equipment`), []);
  await run(db, owner, `select erp_set_workspace_industry($1, 'quarry', array['weighbridge'])`, [
    ws,
  ]);
  await expectError(
    log(operator, { equipment_id: excavator, kind: 'hours', hour_meter: 12030 }),
    /module is switched off/
  );
  await run(db, owner, `select erp_set_workspace_industry($1, 'quarry')`, [ws]);
  await expectError(
    run(db, owner, `update erp_equipment set hour_meter = 1 where id = $1`, [excavator]),
    /permission denied/
  );
  await expectError(
    run(db, operator, `select erp_equipment_save($1, $2::jsonb)`, [
      ws,
      JSON.stringify({ code: 'ex-01', name: 'Dup' }),
    ]),
    /already has this code/
  );
});

test('a reset clears logs and meters; rollback removes equipment', async () => {
  await runOnPath(db, owner, '/account/reset', `select erp_reset_workspace($1, 'transactions')`, [
    ws,
  ]);
  assert.equal(Number((await machine()).hour_meter), 12000);
  const d = await createDb();
  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261012000026_erp_equipment.sql', import.meta.url),
      'utf8'
    )
  );
  const { rows } = await d.query(`select to_regclass('public.erp_equipment') is null as gone`);
  assert.equal(rows[0].gone, true);
  await d.close();
});
