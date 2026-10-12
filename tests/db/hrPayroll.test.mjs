import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let ws;
let inventory;

async function join(role) {
  const member = await createUser(db, `pay-${role}`);
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`, [ws, role]);
  await run(db, member, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  return member;
}

async function day(employee, startHoursAgo, endHoursAgo) {
  const [{ id }] = await run(db, owner, `select erp_hr_clock_in($1, $2, null) as id`, [ws, employee]);
  await run(db, owner, `select erp_hr_attendance_correct($1, now() - $2::numeric * interval '1 hour', now() - $3::numeric * interval '1 hour', 'set times')`,
    [id, startHoursAgo, endHoursAgo]);
  return id;
}

const balances = async () => Object.fromEntries((await admin(db, `
  select a.system_key, sum(l.debit - l.credit)::float as balance
  from erp_journal_lines l join erp_journal_entries e on e.id = l.entry_id join erp_gl_accounts a on a.id = l.account_id
  where e.workspace_id = $1 and a.system_key in ('wages', 'overtime', 'cash', 'wages_payable')
  group by 1`, [ws])).map((r) => [r.system_key, r.balance]));

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'pay-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  inventory = await join('inventory');
  await run(db, owner, `select erp_hr_set_attendance_roles($1, array['inventory'])`, [ws]);
});

test('a run posts regular and overtime pay against cash, once', async () => {
  const [{ id: budi }] = await run(db, owner, `select erp_hr_employee_save($1, null, '{"name":"Budi","hourly_rate":20000,"overtime_rate":30000,"normal_hours":8}'::jsonb) as id`, [ws]);
  await day(budi, 11, 0.5); // 10.5 h: 8 regular + 2.5 overtime
  const today = (await admin(db, `select current_date::text as d`))[0].d;

  const [{ p }] = await run(db, owner, `select erp_hr_payroll_preview($1, current_date - 1, current_date) as p`, [ws]);
  assert.deepEqual({ records: p.records, regular: Number(p.regular), overtime: Number(p.overtime), employees: p.employees },
    { records: 1, regular: 160000, overtime: 75000, employees: 1 });

  await expectError(run(db, inventory, `select erp_hr_payroll_run($1, current_date - 1, current_date, current_date, 'cash')`, [ws]), /Only the owner or an admin/);
  const [{ id: runId }] = await run(db, owner, `select erp_hr_payroll_run($1, current_date - 1, current_date, current_date, 'cash') as id`, [ws]);
  assert.deepEqual(await balances(), { wages: 160000, overtime: 75000, cash: -235000 });

  const [listed] = await run(db, owner, `select status, records, total::float as total, entry_no, credit_to from erp_hr_payroll_runs_v2($1)`, [ws]);
  assert.equal(listed.status, 'posted');
  assert.equal(listed.total, 235000);
  assert.ok(listed.entry_no > 0);
  const [entry] = await admin(db, `select source_type, entry_date::text as d from erp_journal_entries where source_id = $1`, [runId]);
  assert.deepEqual(entry, { source_type: 'payroll', d: today });

  // Paid once only; paid records are not corrected.
  await expectError(run(db, owner, `select erp_hr_payroll_run($1, current_date - 1, current_date, current_date, 'cash')`, [ws]), /no unpaid, finished attendance/);
  const [{ id: att }] = await admin(db, `select id from erp_attendance where payroll_run_id = $1`, [runId]);
  await expectError(run(db, owner, `select erp_hr_attendance_correct($1, now() - interval '3 hours', now() - interval '1 hour', 'late fix')`, [att]), /already paid/);

  // Reversing posts the opposite entry and frees the records.
  await expectError(run(db, owner, `select erp_hr_payroll_reverse($1, 'x')`, [runId]), /reason/);
  await run(db, owner, `select erp_hr_payroll_reverse($1, 'Wrong period')`, [runId]);
  assert.deepEqual(await balances(), { wages: 0, overtime: 0, cash: 0 });
  await expectError(run(db, owner, `select erp_hr_payroll_reverse($1, 'Again please')`, [runId]), /already reversed/);
  assert.equal((await admin(db, `select count(*)::int as n from erp_attendance where payroll_run_id is not null`))[0].n, 0);

  // Paid later instead: wages payable.
  await run(db, owner, `select erp_hr_payroll_run($1, current_date - 1, current_date, current_date, 'payable')`, [ws]);
  const after = await balances();
  assert.equal(after.wages_payable, -235000);
  assert.equal(after.cash, 0);

  const audit = await admin(db, `select action from erp_workspace_audit_log where workspace_id = $1 and action like 'hr.payroll%' order by created_at`, [ws]);
  assert.deepEqual(audit.map((a) => a.action), ['hr.payroll_posted', 'hr.payroll_reversed', 'hr.payroll_posted']);
});

test('open days and zero-rate days are not paid; closed periods are refused', async () => {
  const [{ id: zero }] = await run(db, owner, `select erp_hr_employee_save($1, null, '{"name":"Volunteer"}'::jsonb) as id`, [ws]);
  await day(zero, 5, 1);
  await expectError(run(db, owner, `select erp_hr_payroll_run($1, current_date - 1, current_date, current_date, 'cash')`, [ws]), /has no pay|no unpaid/);

  const [{ id: open }] = await run(db, owner, `select erp_hr_employee_save($1, null, '{"name":"Still here","hourly_rate":10000}'::jsonb) as id`, [ws]);
  await run(db, owner, `select erp_hr_clock_in($1, $2, null)`, [ws, open]);
  const [{ p }] = await run(db, owner, `select erp_hr_payroll_preview($1, current_date - 1, current_date) as p`, [ws]);
  assert.equal(p.still_in, 1);

  const [{ id: late }] = await run(db, owner, `select erp_hr_employee_save($1, null, '{"name":"Late","hourly_rate":10000}'::jsonb) as id`, [ws]);
  await day(late, 4, 2);
  const [{ base_currency: base }] = await run(db, owner, `select base_currency from erp_accounting_settings_get($1)`, [ws]);
  await run(db, owner, `select erp_accounting_settings_set($1, $2, current_date, 0)`, [ws, base]);
  await expectError(run(db, owner, `select erp_hr_payroll_run($1, current_date - 1, current_date, current_date, 'cash')`, [ws]), /books are closed/);
});

test('rollback is refused while payroll entries exist', async () => {
  const sql = readFileSync(new URL('../../db/rollback/rollback_20261012000002_erp_hr_payroll.sql', import.meta.url), 'utf8');
  await expectError(db.exec(sql), /Payroll journal entries exist/);
  const fresh = await createDb();
  // Later migrations first (leave and payslips build on payroll).
  await fresh.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000009_erp_hr_leave_pay.sql', import.meta.url), 'utf8'));
  await fresh.exec(sql);
  assert.equal((await fresh.query(`select to_regclass('public.erp_payroll_runs') as t`)).rows[0].t, null);
  await fresh.close();
});
