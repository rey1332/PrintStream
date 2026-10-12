import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

// Expected amounts are worked out by hand from PP 58/2023 (TER), UU HPP
// (Article 17), PP 35/2021 (overtime) and the BPJS rates in the migration.

let db;
let owner;
let ws;
const emp = {};

const employee = async (name, terms) => {
  const [{ id }] = await run(db, owner, `select erp_hr_employee_save($1, null, $2::jsonb) as id`, [
    ws,
    JSON.stringify({ name }),
  ]);
  await run(db, owner, `select erp_hr_employee_terms_save($1, $2::jsonb)`, [
    id,
    JSON.stringify(terms),
  ]);
  return id;
};
const payRun = (from, to, payDate, thr = false) =>
  run(db, owner, `select erp_hr_payroll_run_v2($1, $2, $3, $4, 'cash', $5) as id`, [
    ws,
    from,
    to,
    payDate,
    thr,
  ]).then((r) => r[0].id);
const line = async (runId, employeeId) =>
  (
    await admin(
      db,
      `select *, salary_month::text as salary_month from erp_payroll_lines where run_id = $1 and employee_id = $2`,
      [runId, employeeId]
    )
  )[0];
const n = (v) => (v === null || v === undefined ? v : Number(v));

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'id-owner');
  [{ workspace_id: ws }] = await run(
    db,
    owner,
    `select workspace_id from erp_my_workspaces() where is_personal`
  );
  await run(db, owner, `select erp_hr_payroll_settings_set($1, $2::jsonb)`, [
    ws,
    JSON.stringify({ payroll_rules: 'id', jkk_rate: 1.74 }),
  ]);
  emp.a = await employee('Andi', {
    pay_type: 'monthly',
    monthly_salary: 5000000,
    fixed_allowance: 1000000,
    join_date: '2025-01-01',
    ptkp_status: 'TK/0',
  });
  emp.c = await employee('Citra', {
    pay_type: 'monthly',
    monthly_salary: 4400000,
    join_date: '2026-10-15',
    bpjs_tk: false,
    bpjs_kes: false,
  });
  emp.f = await employee('Fajar', {
    pay_type: 'monthly',
    monthly_salary: 3000000,
    join_date: '2026-04-15',
    bpjs_tk: false,
    bpjs_kes: false,
  });
});

test('settings and pay terms are read back; only managers change them', async () => {
  const [{ s }] = await run(db, owner, `select erp_hr_payroll_settings_get($1) as s`, [ws]);
  assert.deepEqual(
    {
      rules: s.payroll_rules,
      jkk: Number(s.jkk_rate),
      jp: Number(s.jp_cap),
      kes: Number(s.kes_cap),
    },
    { rules: 'id', jkk: 1.74, jp: 11086300, kes: 12000000 }
  );
  const [a] = await run(
    db,
    owner,
    `select *, join_date::text as join_date from erp_hr_employee_terms($1) where employee_id = $2`,
    [ws, emp.a]
  );
  assert.deepEqual(
    [a.pay_type, n(a.monthly_salary), a.ptkp_status, a.join_date],
    ['monthly', 5000000, 'TK/0', '2025-01-01']
  );
  await expectError(
    run(db, owner, `select erp_hr_employee_terms_save($1, '{"ptkp_status":"X/9"}'::jsonb)`, [
      emp.a,
    ]),
    /Invalid pay terms/
  );
  const outsider = await createUser(db, 'id-outsider');
  await expectError(
    run(db, outsider, `select erp_hr_employee_terms_save($1, '{"monthly_salary":1}'::jsonb)`, [
      emp.a,
    ]),
    /not found/
  );
});

test('October: salary, BPJS with JKK 1.74%, PPh 21 at TER A on gross including taxable premiums, proration', async () => {
  const runId = await payRun('2026-10-01', '2026-10-31', '2026-10-31');
  const a = await line(runId, emp.a);
  // Wage 6,000,000. JHT 120,000/222,000; JP 60,000/120,000; JKK 104,400; JKM 18,000; Kesehatan 60,000/240,000.
  // Taxable 6,000,000 + 104,400 + 18,000 + 240,000 = 6,362,400 → TER A 1% → 63,624.
  assert.deepEqual(
    [
      n(a.regular),
      n(a.allowances),
      n(a.gross),
      n(a.tax_gross),
      n(a.ter_rate),
      n(a.pph21),
      n(a.bpjs_employee),
      n(a.bpjs_employer),
      n(a.net),
    ],
    [5000000, 1000000, 6000000, 6362400, 1, 63624, 240000, 704400, 5696376]
  );
  assert.equal(a.salary_month, '2026-10-01');
  // Citra joined Thursday 15 October: 12 of 22 working days → 4,400,000 × 12/22.
  assert.equal(n((await line(runId, emp.c)).regular), 2400000);

  const accounts = Object.fromEntries(
    (
      await admin(
        db,
        `
    select a.system_key, sum(l.credit - l.debit)::float as credit
      from erp_journal_lines l join erp_journal_entries e on e.id = l.entry_id join erp_gl_accounts a on a.id = l.account_id
     where e.source_id = $1 group by 1`,
        [runId]
      )
    ).map((r) => [r.system_key, r.credit])
  );
  assert.equal(accounts.pph21_payable, 63624);
  assert.equal(accounts.bpjs_payable, 944400);

  // The month's salary is paid once.
  await expectError(payRun('2026-10-01', '2026-10-31', '2026-10-31'), /no unpaid/);
});

test('November with THR: months of service / 12, once a year; THR is taxed through TER', async () => {
  const runId = await payRun('2026-11-01', '2026-11-30', '2026-11-30', true);
  const a = await line(runId, emp.a);
  assert.deepEqual(
    [n(a.thr), n(a.gross), n(a.tax_gross), n(a.ter_rate), n(a.pph21)],
    [6000000, 12000000, 12362400, 4, 494496]
  );
  assert.equal(n((await line(runId, emp.c)).thr), 366667, '1 month: 4,400,000 / 12');
  assert.equal(n((await line(runId, emp.f)).thr), 1750000, '7 months: 3,000,000 × 7/12');
  const [{ t }] = await admin(
    db,
    `select thr_total::float as t from erp_payroll_runs where id = $1`,
    [runId]
  );
  assert.equal(t, 6000000 + 366667 + 1750000);
});

test('December: the year is recalculated with Article 17 and the over-withheld PPh 21 is refunded', async () => {
  const runId = await payRun('2026-12-01', '2026-12-31', '2026-12-31', true);
  const a = await line(runId, emp.a);
  // Year 25,087,200 − job expenses 1,254,360 − JHT/JP 540,000 = 23,292,840 < PTKP 54,000,000 → tax 0;
  // withheld 63,624 + 494,496 = 558,120 is given back.
  assert.deepEqual([n(a.thr), n(a.pph21), n(a.net)], [0, -558120, 6318120]);
  const [{ debit }] = await admin(
    db,
    `
    select sum(l.debit - l.credit)::float as debit
      from erp_journal_lines l join erp_journal_entries e on e.id = l.entry_id join erp_gl_accounts a on a.id = l.account_id
     where e.source_id = $1 and a.system_key = 'pph21_payable'`,
    [runId]
  );
  assert.equal(debit, 558120);
});

test('daily workers: working days at the daily rate, statutory overtime, daily PPh 21', async () => {
  const other = await createUser(db, 'id-daily');
  const [{ workspace_id: ws2 }] = await run(
    db,
    other,
    `select workspace_id from erp_my_workspaces() where is_personal`
  );
  await run(db, other, `select erp_hr_payroll_settings_set($1, '{"payroll_rules":"id"}'::jsonb)`, [
    ws2,
  ]);
  const make = async (name, rate) => {
    const [{ id }] = await run(
      db,
      other,
      `select erp_hr_employee_save($1, null, $2::jsonb) as id`,
      [ws2, JSON.stringify({ name, normal_hours: 8 })]
    );
    await run(db, other, `select erp_hr_employee_terms_save($1, $2::jsonb)`, [
      id,
      JSON.stringify({ pay_type: 'daily', daily_rate: rate, bpjs_tk: false, bpjs_kes: false }),
    ]);
    return id;
  };
  const dedi = await make('Dedi', 200000);
  const eko = await make('Eko', 600000);
  const shift = async (employee, date, from, to) => {
    const [{ id }] = await admin(
      db,
      `
      insert into erp_attendance (workspace_id, employee_id, work_date, clock_in, clock_out, hourly_rate, overtime_rate, normal_hours, worked_minutes)
      values ($1, $2, $3::date, ($3::text || ' ' || $4::text)::timestamptz, ($3::text || ' ' || $5::text)::timestamptz, 0, 0, 8, 0) returning id`,
      [ws2, employee, date, from, to]
    );
    await admin(db, `select erp_hr__settle($1)`, [id]);
  };
  await shift(dedi, '2026-11-02', '08:00', '18:00'); // Monday: 8 h + 2 h overtime
  await shift(dedi, '2026-11-07', '08:00', '17:00'); // Saturday (rest day, 5-day week): 9 h
  await shift(eko, '2026-11-03', '08:00', '16:00');
  const [{ id: runId }] = await run(
    db,
    other,
    `select erp_hr_payroll_run_v2($1, '2026-11-01', '2026-11-07', '2026-11-07', 'cash', false) as id`,
    [ws2]
  );
  const d = (
    await admin(db, `select * from erp_payroll_lines where run_id = $1 and employee_id = $2`, [
      runId,
      dedi,
    ])
  )[0];
  // Hourly wage 200,000 × 21 / 173; units 1.5 + 2 (weekday) + 2×8 + 3×1 (rest day) = 22.5.
  assert.deepEqual([n(d.regular), n(d.overtime), n(d.pph21)], [200000, 546242.77, 0]);
  const e = (
    await admin(db, `select * from erp_payroll_lines where run_id = $1 and employee_id = $2`, [
      runId,
      eko,
    ])
  )[0];
  assert.deepEqual([n(e.gross), n(e.ter_rate), n(e.pph21)], [600000, 0.5, 3000]);
});

test('tax helpers: categories, PTKP, Article 17', async () => {
  const [r] = await admin(
    db,
    `select erp_hr__ter_category('K/1') as cat, erp_hr__ptkp('K/3') as ptkp,
    erp_hr__pasal17(300000000) as tax, erp_hr__ter_rate('K/3', 6600000) as c0, erp_hr__ter_rate('TK/0', 1500000000) as top`
  );
  assert.deepEqual(
    [r.cat, n(r.ptkp), n(r.tax), n(r.c0), n(r.top)],
    ['B', 72000000, 3000000 + 28500000 + 12500000, 0, 34]
  );
});

test('rollback restores the earlier payroll', async () => {
  const d = await createDb();
  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261012000027_erp_hr_indonesia.sql', import.meta.url),
      'utf8'
    )
  );
  const { rows } = await d.query(`select to_regclass('public.erp_hr_ter_rates') is null as gone,
    to_regprocedure('public.erp_hr_payroll_run(uuid,date,date,date,text)') is not null as kept`);
  assert.deepEqual(rows[0], { gone: true, kept: true });
  await d.close();
});
