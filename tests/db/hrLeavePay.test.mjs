import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let recorder;
let ws;
let sari;
let tono;
let monday; // last week's Monday (YYYY-MM-DD)
let leaveId;
let runId;

const iso = async (sql) => (await admin(db, `select (${sql})::text as d`))[0].d;
const preview = async () => (await run(db, owner, `select erp_hr_payroll_preview($1, $2::date, current_date) as p`, [ws, monday]))[0].p;
const payrollRun = async () =>
  (await run(db, owner, `select erp_hr_payroll_run($1, $2::date, current_date, current_date, 'cash') as id`, [ws, monday]))[0].id;
const balances = async () => Object.fromEntries((await admin(db, `
  select a.system_key, sum(l.debit - l.credit)::float as balance
  from erp_journal_lines l join erp_journal_entries e on e.id = l.entry_id join erp_gl_accounts a on a.id = l.account_id
  where e.workspace_id = $1 and e.source_type in ('payroll', 'payroll_reversal') group by 1`, [ws])).map((r) => [r.system_key, r.balance]));

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'leave-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  recorder = await createUser(db, 'leave-recorder');
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'inventory', 24, '')`, [ws]);
  await run(db, recorder, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  await run(db, owner, `select erp_hr_set_attendance_roles($1, array['inventory'])`, [ws]);
  await run(db, owner, `select erp_hr_set_work_days($1, array[1,2,3,4,5])`, [ws]);
  monday = await iso(`date_trunc('week', current_date)::date - 7`);

  [{ id: sari }] = await run(db, owner, `select erp_hr_employee_save($1, null, '{"name":"Sari","hourly_rate":10000,"overtime_rate":15000,"normal_hours":8}'::jsonb) as id`, [ws]);
  [{ id: tono }] = await run(db, owner, `select erp_hr_employee_save($1, null, '{"name":"Tono","hourly_rate":5000,"normal_hours":8}'::jsonb) as id`, [ws]);
  // Both were employed before last week.
  await admin(db, `update erp_employees set created_at = now() - interval '60 days' where workspace_id = $1`, [ws]);

  const [{ id: att }] = await run(db, owner, `select erp_hr_clock_in($1, $2, null) as id`, [ws, sari]);
  await run(db, owner, `select erp_hr_attendance_correct($1, now() - interval '10 hours 30 minutes', now() - interval '30 minutes', 'set times')`, [att]);
});

test('holidays: paid or not, managed by the Owner and Admins, read by recorders', async () => {
  await run(db, owner, `select erp_hr_holiday_save($1, $2::date + 2, 'Hari raya', true)`, [ws, monday]);
  await expectError(run(db, recorder, `select erp_hr_holiday_save($1, $2::date + 3, 'Nope', false)`, [ws, monday]), /Only the owner or an admin/);
  const year = Number(monday.slice(0, 4));
  const list = await run(db, recorder, `select name, paid, paid_out from erp_hr_holidays($1, $2)`, [ws, year]);
  assert.deepEqual(list, [{ name: 'Hari raya', paid: true, paid_out: false }]);
  const [{ d }] = await run(db, recorder, `select erp_hr_work_days_get($1) as d`, [ws]);
  assert.deepEqual(d, [1, 2, 3, 4, 5]);
});

test('leave: recorded by recorders, approved by managers; working days only; no overlap; quota', async () => {
  [{ id: leaveId }] = await run(db, recorder, `select erp_hr_leave_request($1, $2, 'annual', $3::date, $3::date + 6, 'family') as id`, [ws, sari, monday]);
  const [req] = await run(db, owner, `select days, status from erp_hr_leaves($1, $2::date, $2::date + 6)`, [ws, monday]);
  assert.deepEqual(req, { days: 4, status: 'pending' }, 'Mon–Fri without the Wednesday holiday');
  await expectError(run(db, recorder, `select erp_hr_leave_decide($1, 'approved', '')`, [leaveId]), /Only the owner or an admin/);
  await expectError(run(db, recorder, `select erp_hr_leave_request($1, $2, 'sick', $3::date + 1, $3::date + 1, '')`, [ws, sari, monday]), /already has leave/);
  await expectError(run(db, owner, `select erp_hr_leave_request($1, $2, 'sick', $3::date + 5, $3::date + 6, '')`, [ws, tono, monday]), /no working days/);

  await run(db, owner, `select erp_hr_set_leave_quota($1, 5)`, [sari]);
  await run(db, owner, `select erp_hr_leave_decide($1, 'approved', 'ok')`, [leaveId]);
  await expectError(run(db, owner, `select erp_hr_leave_decide($1, 'approved', '')`, [leaveId]), /already decided/);
  const [bal] = await run(db, recorder, `select quota, used, remaining from erp_hr_leave_balances($1, $2) where employee_id = $3`,
    [ws, Number(monday.slice(0, 4)), sari]);
  assert.deepEqual(bal, { quota: 5, used: 4, remaining: 1 });

  // Two more annual days would pass the quota of 5.
  const [{ id: more }] = await run(db, owner, `select erp_hr_leave_request($1, $2, 'annual', $3::date + 7, $3::date + 8, '') as id`, [ws, sari, monday]);
  await expectError(run(db, owner, `select erp_hr_leave_decide($1, 'approved', '')`, [more]), /Not enough annual leave/);
  await run(db, owner, `select erp_hr_leave_decide($1, 'rejected', 'busy')`, [more]);
});

test('allowances and deductions are fixed or a percentage, set by managers only', async () => {
  const add = (user, data) => run(db, user, `select erp_hr_pay_item_save($1, $2, null, $3::jsonb)`, [ws, sari, JSON.stringify(data)]);
  await add(owner, { kind: 'allowance', name: 'Transport', method: 'fixed', amount: 50000 });
  await add(owner, { kind: 'allowance', name: 'Makan', method: 'percent', amount: 10 });
  await add(owner, { kind: 'deduction', name: 'BPJS Kesehatan', method: 'percent', amount: 1 });
  await add(owner, { kind: 'deduction', name: 'PPh 21', method: 'percent', amount: 5 });
  await add(owner, { kind: 'employer', name: 'BPJS Kesehatan (perusahaan)', method: 'percent', amount: 4 });
  await expectError(add(recorder, { kind: 'allowance', name: 'x', method: 'fixed', amount: 1 }), /Only the owner or an admin/);
  await expectError(add(owner, { kind: 'deduction', name: 'x', method: 'percent', amount: 120 }), /between 0 and 100/);
  const items = await run(db, owner, `select kind, name from erp_hr_pay_items($1, $2)`, [ws, sari]);
  assert.deepEqual(items.map((i) => i.kind), ['allowance', 'allowance', 'deduction', 'deduction', 'employer']);
});

test('a run pays attendance, leave, holidays, allowances and deductions in one balanced entry', async () => {
  const p = await preview();
  const s = p.lines.find((l) => l.name === 'Sari');
  // Base 80 000 + 30 000 + 4 × 80 000 + 80 000 = 510 000; allowances 50 000 + 51 000.
  assert.deepEqual(
    [s.regular, s.overtime, s.leave_days, s.leave_pay, s.holiday_days, s.holiday_pay, s.allowances, s.gross].map(Number),
    [80000, 30000, 4, 320000, 1, 80000, 101000, 611000]
  );
  // Deductions 1 % + 5 % of gross; employer 4 % of gross.
  assert.deepEqual([s.deductions, s.employer, s.net].map(Number), [36660, 24440, 574340]);
  const t = p.lines.find((l) => l.name === 'Tono');
  assert.deepEqual([t.holiday_pay, t.net].map(Number), [40000, 40000]);
  assert.deepEqual([p.gross, p.net, p.deductions, p.employer].map(Number), [651000, 614340, 36660, 24440]);

  runId = await payrollRun();
  assert.deepEqual(await balances(), {
    wages: 80000 + 320000 + 80000 + 40000,
    overtime: 30000,
    allowances: 101000,
    employer_contributions: 24440,
    deductions_payable: -(36660 + 24440),
    cash: -614340,
  });
  const slips = await run(db, owner, `select employee_name, net::float as net, jsonb_array_length(items) as items from erp_hr_payslips($1)`, [runId]);
  assert.deepEqual(slips, [{ employee_name: 'Sari', net: 574340, items: 5 }, { employee_name: 'Tono', net: 40000, items: 0 }]);
  await expectError(run(db, recorder, `select * from erp_hr_payslips($1)`, [runId]), /Only the owner or an admin/);
  const [listed] = await run(db, owner, `select net_total::float as net, employees, leave_total::float as leave from erp_hr_payroll_runs_v2($1)`, [ws]);
  assert.deepEqual(listed, { net: 614340, employees: 2, leave: 320000 });

  // Nothing is paid twice.
  await expectError(payrollRun(), /no unpaid, finished attendance/);
  await expectError(run(db, owner, `select erp_hr_leave_cancel($1, 'changed plans')`, [leaveId]), /already paid/);
  await expectError(run(db, owner, `select erp_hr_holiday_save($1, $2::date + 2, 'Hari raya', false)`, [ws, monday]), /already paid/);
  await expectError(run(db, owner, `select erp_hr_employee_delete($1)`, [tono]), /Deactivate them instead/);
});

test('reversing a run frees attendance, leave and holiday pay to be paid again', async () => {
  await run(db, owner, `select erp_hr_payroll_reverse($1, 'wrong rates')`, [runId]);
  assert.deepEqual(Object.values(await balances()).filter((v) => v !== 0), []);
  const again = await preview();
  assert.equal(Number(again.net), 614340);
  await run(db, owner, `select erp_hr_leave_cancel($1, 'changed plans')`, [leaveId]);
  const after = await preview();
  assert.equal(after.lines.find((l) => l.name === 'Sari').leave_days, 0);
});

test('a holiday added on a leave day is not a leave day', async () => {
  const [{ id }] = await run(db, owner, `select erp_hr_leave_request($1, $2, 'sick', $3::date + 7, $3::date + 8, '') as id`, [ws, sari, monday]);
  await run(db, owner, `select erp_hr_leave_decide($1, 'approved', '')`, [id]);
  await run(db, owner, `select erp_hr_holiday_save($1, $2::date + 8, 'Cuti bersama', false)`, [ws, monday]);
  const [r] = await admin(db, `select days from erp_leave_requests where id = $1`, [id]);
  assert.equal(r.days, 1);
});

test('deductions larger than the pay are refused', async () => {
  await run(db, owner, `select erp_hr_pay_item_save($1, $2, null, '{"kind":"deduction","name":"Loan","method":"fixed","amount":9999999}'::jsonb)`, [ws, tono]);
  assert.equal((await preview()).negative, true);
  await expectError(payrollRun(), /Deductions are larger than the pay/);
});

test('rollback restores payroll as before', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000009_erp_hr_leave_pay.sql', import.meta.url), 'utf8'));
  assert.equal((await d.query(`select to_regclass('public.erp_leave_requests') as t`)).rows[0].t, null);
  const def = await d.query(`select pg_get_functiondef('public.erp_hr_payroll_run(uuid,date,date,date,text)'::regprocedure) as d`);
  assert.ok(!def.rows[0].d.includes('erp_payroll_lines'));
  const rev = await d.query(`select pg_get_functiondef('public.erp_hr_payroll_reverse(uuid,text)'::regprocedure) as d`);
  assert.ok(!rev.rows[0].d.includes('erp_leave_days'));
  await d.close();
});
