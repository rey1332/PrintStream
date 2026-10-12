import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let ws;

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'tm-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
});

test('TERMINAL is added per ERP by its Owner or an Admin; off, it takes no new work', async () => {
  const [mine] = await run(db, owner, `select enabled, can_manage from erp_my_terminals() where workspace_id = $1`, [ws]);
  assert.deepEqual(mine, { enabled: false, can_manage: true });
  await expectError(run(db, owner, `select ps_enqueue_job($1, 'import.analyze', '{}'::jsonb)`, [ws]), /not added/);
  await expectError(run(db, owner, `select ps_create_dataset($1, 'X', '', '', '[]'::jsonb)`, [ws]), /not added/);

  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation_v2($1, 'sales', 24, '', null)`, [ws]);
  const sales = await createUser(db, 'tm-sales');
  await run(db, sales, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  await expectError(run(db, sales, `select erp_set_terminal($1, true)`, [ws]), /Only the Owner or an Admin/);
  assert.equal((await run(db, sales, `select can_manage from erp_my_terminals() where workspace_id = $1`, [ws]))[0].can_manage, false);

  await run(db, owner, `select erp_set_terminal($1, true)`, [ws]);
  await run(db, owner, `select ps_create_dataset($1, 'Trips', '', '', '[]'::jsonb)`, [ws]);
  await run(db, owner, `select erp_set_terminal($1, false)`, [ws]);
  assert.equal((await run(db, owner, `select count(*)::int n from ps_datasets where workspace_id = $1`, [ws]))[0].n, 1, 'nothing is deleted');
  const audit = await admin(db, `select action from erp_workspace_audit_log where workspace_id = $1 and action like 'terminal.%' order by created_at`, [ws]);
  assert.deepEqual(audit.map((a) => a.action), ['terminal.added', 'terminal.removed']);
});

test('rollback removes the switch', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000039_terminal_module.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select pg_get_functiondef('public.ps_enqueue_job(uuid,text,jsonb,text,timestamptz)'::regprocedure) def`);
  assert.ok(!rows[0].def.includes('ps__terminal_on'));
  const cols = await d.query(`select count(*)::int n from information_schema.columns where table_name = 'erp_workspaces' and column_name = 'terminal_enabled'`);
  assert.equal(cols.rows[0].n, 0);
  await d.close();
});
