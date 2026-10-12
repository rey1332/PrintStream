import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, expectError } from './harness.mjs';

let db;
let ana;
let budi;
let erp;

before(async () => {
  db = await createDb();
  ana = await createUser(db, 'widget-ana');
  budi = await createUser(db, 'widget-budi');
  [{ workspace_id: erp }] = await run(db, ana, `select workspace_id from erp_my_workspaces() where is_personal`);
});

const add = (who, ws, title = 'Revenue', kind = 'kpi', config = '{"metric":"totalRevenue"}') =>
  run(db, who, `insert into home_widgets (user_id, workspace_id, kind, title, config) values ($1, $2, $3, $4, $5::jsonb) returning id`, [who.id, ws, kind, title, config]);

test('a person adds widgets for their own ERPs and sees only their own', async () => {
  const [{ id }] = await add(ana, erp);
  assert.ok(id);
  assert.equal((await run(db, ana, `select count(*)::int n from home_widgets`))[0].n, 1);
  assert.equal((await run(db, budi, `select count(*)::int n from home_widgets`))[0].n, 0);
  // Not someone else's ERP, not for someone else, not a TERMINAL on its own.
  await expectError(add(budi, erp), /ERP you belong to/);
  await expectError(run(db, budi, `insert into home_widgets (user_id, workspace_id, kind, title) values ($1, $2, 'kpi', 'x')`, [ana.id, erp]), /row-level security|belong to the person/);
  const [{ id: term }] = await run(db, ana, `select erp_create_terminal('Data') as id`);
  await expectError(add(ana, term), /ERP you belong to/);
  // Others cannot change or remove it.
  await run(db, budi, `delete from home_widgets where id = $1`, [id]);
  assert.equal((await run(db, ana, `select count(*)::int n from home_widgets`))[0].n, 1);
  await expectError(add(ana, erp, '   '), /check/);
});

test('at most 24 widgets a person', async () => {
  const have = (await run(db, ana, `select count(*)::int n from home_widgets`))[0].n;
  for (let i = have; i < 24; i += 1) await add(ana, erp, `W${i}`);
  await expectError(add(ana, erp, 'One more'), /At most 24/);
});

test('rollback removes the widgets', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000045_home_widgets.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select to_regclass('public.home_widgets') is null as gone`);
  assert.equal(rows[0].gone, true);
  await d.close();
});
