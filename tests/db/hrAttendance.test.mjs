import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let adminUser;
let finance;
let inventory;
let outsider;
let ws;

async function join(role) {
  const member = await createUser(db, `hr-${role}`);
  const [{ access_code }] = await run(
    db,
    owner,
    `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`,
    [ws, role]
  );
  await run(db, member, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  return member;
}

async function access(user) {
  const [{ a }] = await run(db, user, `select erp_hr_access($1) as a`, [ws]);
  return a;
}

async function addEmployee(user, data) {
  const [{ id }] = await run(db, user, `select erp_hr_employee_save($1, null, $2::jsonb) as id`, [
    ws,
    JSON.stringify(data),
  ]);
  return id;
}

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'hr-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  adminUser = await join('admin');
  finance = await join('finance');
  inventory = await join('inventory');
  outsider = await createUser(db, 'hr-outsider');
});

test('Owner and Admin manage and record; other roles start without HR access', async () => {
  assert.deepEqual(await access(owner), {
    can_manage: true,
    can_record: true,
    can_configure: true,
    attendance_roles: [],
  });
  assert.deepEqual(await access(adminUser), {
    can_manage: true,
    can_record: true,
    can_configure: false,
    attendance_roles: [],
  });
  for (const user of [finance, inventory]) {
    const a = await access(user);
    assert.equal(a.can_manage, false);
    assert.equal(a.can_record, false);
  }
  const stranger = await access(outsider);
  assert.equal(stranger.can_record, false);

  await expectError(
    run(db, finance, `select * from erp_hr_employees($1)`, [ws]),
    /not allowed to record attendance/
  );
  await expectError(run(db, outsider, `select * from erp_hr_today($1)`, [ws]), /not allowed/);
});

test('only the Owner chooses which roles record attendance', async () => {
  await expectError(
    run(db, adminUser, `select erp_hr_set_attendance_roles($1, array['inventory'])`, [ws]),
    /Only the owner/
  );
  await expectError(
    run(db, owner, `select erp_hr_set_attendance_roles($1, array['admin'])`, [ws]),
    /Choose from/
  );

  await run(db, owner, `select erp_hr_set_attendance_roles($1, array['inventory', 'inventory'])`, [
    ws,
  ]);
  assert.deepEqual((await access(inventory)).attendance_roles, ['inventory']);
  assert.equal((await access(inventory)).can_record, true);
  assert.equal((await access(inventory)).can_manage, false);
  assert.equal((await access(finance)).can_record, false);

  const audit = await admin(
    db,
    `select details from erp_workspace_audit_log where workspace_id = $1 and action = 'hr.attendance_roles_changed'`,
    [ws]
  );
  assert.deepEqual(audit.at(-1).details, { from: [], to: ['inventory'] });
});

test('employees: Owner/Admin add and edit; codes are unique; rates are hidden from recorders', async () => {
  const id = await addEmployee(adminUser, {
    employee_code: 'E-01',
    name: ' Budi ',
    position: 'Gudang',
    hourly_rate: 20000,
    overtime_rate: 30000,
    normal_hours: 8,
  });
  await expectError(
    addEmployee(owner, { employee_code: 'e-01', name: 'Other' }),
    /already has this code/
  );
  await expectError(addEmployee(owner, { name: '   ' }), /Enter the employee/);
  await expectError(addEmployee(owner, { name: 'X', hourly_rate: -1 }), /cannot be negative/);
  await expectError(addEmployee(owner, { name: 'X', normal_hours: 25 }), /between 0 and 24/);
  await expectError(addEmployee(inventory, { name: 'Sneaky' }), /Only the owner or an admin/);

  const [mine] = await run(
    db,
    owner,
    `select name, hourly_rate, overtime_rate from erp_hr_employees($1) where id = $2`,
    [ws, id]
  );
  assert.deepEqual(mine, { name: 'Budi', hourly_rate: '20000.00', overtime_rate: '30000.00' });
  const [theirs] = await run(
    db,
    inventory,
    `select name, hourly_rate, overtime_rate from erp_hr_employees($1) where id = $2`,
    [ws, id]
  );
  assert.deepEqual(theirs, { name: 'Budi', hourly_rate: null, overtime_rate: null });

  await run(db, owner, `select erp_hr_employee_save($1, $2, '{"hourly_rate": 25000}'::jsonb)`, [
    ws,
    id,
  ]);
  const [after] = await run(
    db,
    owner,
    `select name, hourly_rate, position from erp_hr_employees($1) where id = $2`,
    [ws, id]
  );
  assert.deepEqual(after, { name: 'Budi', hourly_rate: '25000.00', position: 'Gudang' });
  const audit = await admin(
    db,
    `select count(*)::int as n from erp_workspace_audit_log where workspace_id = $1 and action = 'hr.employee_rates_changed'`,
    [ws]
  );
  assert.equal(audit[0].n, 1);

  // No direct table access for anyone.
  await expectError(run(db, owner, `select * from erp_employees`), /permission denied/);
  await expectError(
    run(db, owner, `update erp_attendance set regular_pay = 0`),
    /permission denied/
  );
});

test('clock in / out: one record a day, active employees only, pay from the rates at clock-in', async () => {
  const id = await addEmployee(owner, {
    name: 'Sari',
    hourly_rate: 20000,
    overtime_rate: 30000,
    normal_hours: 8,
  });

  const [{ att }] = await run(
    db,
    inventory,
    `select erp_hr_clock_in($1, $2, 'Asia/Jakarta', 'pagi') as att`,
    [ws, id]
  );
  await expectError(
    run(db, inventory, `select erp_hr_clock_in($1, $2, 'Asia/Jakarta')`, [ws, id]),
    /already clocked in/
  );

  // A rate change after clock-in does not change this day's pay.
  await run(db, owner, `select erp_hr_employee_save($1, $2, '{"hourly_rate": 99999}'::jsonb)`, [
    ws,
    id,
  ]);

  await run(db, inventory, `select erp_hr_clock_out($1, $2)`, [ws, id]);
  await expectError(
    run(db, inventory, `select erp_hr_clock_out($1, $2)`, [ws, id]),
    /not clocked in/
  );
  await expectError(
    run(db, inventory, `select erp_hr_clock_in($1, $2, 'Asia/Jakarta')`, [ws, id]),
    /already has attendance for today/
  );

  // 08:00 → 18:30 with 8 normal hours: 480 regular + 150 overtime minutes.
  await expectError(
    run(
      db,
      inventory,
      `select erp_hr_attendance_correct($1, now() - interval '11 hours', now() - interval '30 minutes', 'jam salah')`,
      [att]
    ),
    /Only the owner or an admin/
  );
  await expectError(
    run(
      db,
      owner,
      `select erp_hr_attendance_correct($1, now() - interval '2 hours', now() - interval '1 hour', 'x')`,
      [att]
    ),
    /reason/
  );
  await run(
    db,
    owner,
    `select erp_hr_attendance_correct($1, now() - interval '11 hours', now() - interval '30 minutes', 'lupa absen pulang')`,
    [att]
  );

  const [row] = await run(
    db,
    owner,
    `select * from erp_hr_attendance($1, current_date - 1, current_date + 1, $2)`,
    [ws, id]
  );
  assert.equal(row.worked_minutes, 630);
  assert.equal(row.regular_minutes, 480);
  assert.equal(row.overtime_minutes, 150);
  assert.equal(row.hourly_rate, '20000.00');
  assert.equal(row.regular_pay, '160000.00');
  assert.equal(row.overtime_pay, '75000.00');
  assert.equal(row.corrected, true);
  assert.equal(row.note, 'pagi');

  // Recorders see the hours, not the money.
  const [seen] = await run(
    db,
    inventory,
    `select worked_minutes, overtime_minutes, regular_pay, overtime_pay, hourly_rate from erp_hr_attendance($1, current_date - 1, current_date + 1, $2)`,
    [ws, id]
  );
  assert.deepEqual(seen, {
    worked_minutes: 630,
    overtime_minutes: 150,
    regular_pay: null,
    overtime_pay: null,
    hourly_rate: null,
  });

  const board = await run(
    db,
    inventory,
    `select name, clock_out is not null as out from erp_hr_today($1, 'Asia/Jakarta') where employee_id = $2`,
    [ws, id]
  );
  assert.deepEqual(board, [{ name: 'Sari', out: true }]);

  await expectError(
    run(db, owner, `select * from erp_hr_attendance($1, current_date - 400, current_date, null)`, [
      ws,
    ]),
    /at most one year/
  );
});

test('inactive employees cannot clock in; employees with attendance are deactivated, not deleted', async () => {
  const id = await addEmployee(owner, { name: 'Tono' });
  await run(db, owner, `select erp_hr_employee_save($1, $2, '{"is_active": false}'::jsonb)`, [
    ws,
    id,
  ]);
  await expectError(run(db, owner, `select erp_hr_clock_in($1, $2, null)`, [ws, id]), /inactive/);
  const listed = await run(db, owner, `select id from erp_hr_employees($1) where id = $2`, [
    ws,
    id,
  ]);
  assert.equal(listed.length, 0, 'inactive employees are hidden by default');
  const all = await run(db, owner, `select id from erp_hr_employees($1, true) where id = $2`, [
    ws,
    id,
  ]);
  assert.equal(all.length, 1);

  await run(db, owner, `select erp_hr_employee_delete($1)`, [id]);
  assert.equal(
    (await admin(db, `select count(*)::int as n from erp_employees where id = $1`, [id]))[0].n,
    0
  );

  const worked = await addEmployee(owner, { name: 'Wati' });
  await run(db, owner, `select erp_hr_clock_in($1, $2, null)`, [ws, worked]);
  await expectError(
    run(db, owner, `select erp_hr_employee_delete($1)`, [worked]),
    /Deactivate them instead/
  );
  await expectError(
    run(db, inventory, `select erp_hr_employee_delete($1)`, [worked]),
    /Only the owner or an admin/
  );
  await expectError(run(db, outsider, `select erp_hr_employee_delete($1)`, [worked]), /not found/);
});

test('each ERP keeps its own employees', async () => {
  const other = await createUser(db, 'hr-other-owner');
  const [{ workspace_id: otherWs }] = await run(
    db,
    other,
    `select workspace_id from erp_my_workspaces()`
  );
  const [{ id }] = await run(
    db,
    other,
    `select erp_hr_employee_save($1, null, '{"name":"Elsewhere"}'::jsonb) as id`,
    [otherWs]
  );
  const mine = await run(db, owner, `select id from erp_hr_employees($1, true)`, [ws]);
  assert.ok(!mine.some((r) => r.id === id));
  await expectError(run(db, owner, `select erp_hr_clock_in($1, $2, null)`, [ws, id]), /not found/);
  await expectError(
    run(db, owner, `select erp_hr_employee_save($1, $2, '{"name":"Hijack"}'::jsonb)`, [ws, id]),
    /not found/
  );
});

test('a workspace that requires two-factor needs a verified session for HR', async () => {
  await admin(db, `update erp_workspaces set require_mfa = true where id = $1`, [ws]);
  try {
    assert.equal((await access({ ...owner, aal: 'aal1' })).can_manage, false);
    await expectError(
      run(db, { ...owner, aal: 'aal1' }, `select * from erp_hr_employees($1)`, [ws]),
      /not allowed/
    );
    assert.equal((await access({ ...owner, aal: 'aal2' })).can_manage, true);
  } finally {
    await admin(db, `update erp_workspaces set require_mfa = false where id = $1`, [ws]);
  }
});

test('rollback removes HR', async () => {
  // The schema before the Indonesian payroll rules (20261012000027 is rolled back first).
  const d = await createDb({ through: '20261012000022' });
  // Later migrations first (payroll builds on HR).
  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261012000009_erp_hr_leave_pay.sql', import.meta.url),
      'utf8'
    )
  );
  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261012000002_erp_hr_payroll.sql', import.meta.url),
      'utf8'
    )
  );
  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261009000000_erp_hr_attendance.sql', import.meta.url),
      'utf8'
    )
  );
  const left = await d.query(`select count(*)::int as n from pg_proc where proname like 'erp_hr%'`);
  assert.equal(left.rows[0].n, 0);
  assert.equal((await d.query(`select to_regclass('public.erp_attendance') as t`)).rows[0].t, null);
  await d.close();
});
