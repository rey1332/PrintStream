import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, expectError } from './harness.mjs';

let db;
let owner;

const quota = async (who) => (await run(db, who, `select erp_my_workspace_quota() as q`))[0].q;

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'space-owner');
});

test('a TERMINAL is created on its own, always on, and uses no ERP slot', async () => {
  const before = await quota(owner);
  const [{ id }] = await run(db, owner, `select erp_create_terminal('Data tambang') as id`);
  const [w] = await (await db.query(`select kind, terminal_enabled, name from erp_workspaces where id = $1`, [id])).rows;
  assert.deepEqual(w, { kind: 'terminal', terminal_enabled: true, name: 'Data tambang' });
  assert.deepEqual(await quota(owner), before);
  const spaces = await run(db, owner, `select name, kind, role, terminal_on from ps_my_spaces() where workspace_id = $1`, [id]);
  assert.deepEqual(spaces, [{ name: 'Data tambang', kind: 'terminal', role: 'owner', terminal_on: true }]);
  await expectError(run(db, owner, `select erp_set_terminal($1, false)`, [id]), /cannot be switched off/);
  // TERMINAL works there as anywhere: a dataset.
  const [{ ds }] = await run(db, owner, `select ps_create_dataset($1, 'Ritase', '', '', '[{"label":"id","type":"text","key":true}]'::jsonb) as ds`, [id]);
  assert.ok(ds);
});

test('an account at its ERP limit still creates and joins TERMINALs; TERMINALs have their own limit', async () => {
  const full = await createUser(db, 'space-full');
  const { limit } = await quota(full);
  for (let i = (await quota(full)).used; i < limit; i += 1) await run(db, full, `select erp_create_erp($1)`, [`ERP ${i}`]);
  assert.equal((await quota(full)).can_join, false);
  const [{ id: mine }] = await run(db, full, `select erp_create_terminal('Mine') as id`);
  assert.ok(mine);
  // Invited to someone else's TERMINAL: joins although the ERP slots are full.
  const [{ id: shared }] = await run(db, owner, `select erp_create_terminal('Shared') as id`);
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation_v2($1, 'admin', 24, '', null)`, [shared]);
  const [{ r }] = await run(db, full, `select erp_redeem_workspace_invitation($1) as r`, [access_code]);
  assert.equal(r.ok, true);
  // ...but not to another ERP.
  const [{ workspace_id: ownersErp }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  const [{ access_code: erpCode }] = await run(db, owner, `select access_code from erp_create_workspace_invitation_v2($1, 'sales', 24, '', null)`, [ownersErp]);
  const [{ r: refused }] = await run(db, full, `select erp_redeem_workspace_invitation($1) as r`, [erpCode]);
  assert.equal(refused.error, 'workspace_limit');
  // At most ten TERMINALs.
  for (let n = 2; n < 10; n += 1) await run(db, full, `select erp_create_terminal($1)`, [`T${n}`]);
  await expectError(run(db, full, `select erp_create_terminal('Eleventh')`), /maximum of 10 TERMINALs/);
});

test('rollback keeps TERMINALs as workspaces and restores the functions', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000043_terminal_spaces.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(
    `select to_regprocedure('public.erp_create_terminal(text)') is null as fn_gone,
            not exists (select 1 from information_schema.columns where table_name = 'erp_workspaces' and column_name = 'kind') as col_gone,
            position('terminal' in pg_get_functiondef('public.erp_redeem_workspace_invitation(text)'::regprocedure)) = 0 as redeem_restored,
            position('terminal' in pg_get_functiondef('public.erp_enforce_workspace_limit()'::regprocedure)) = 0 as trigger_restored`
  );
  assert.deepEqual(rows[0], { fn_gone: true, col_gone: true, redeem_restored: true, trigger_restored: true });
  await d.close();
});
