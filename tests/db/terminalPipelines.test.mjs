import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let ws;

const asWorker = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role etna_worker');
    return (await tx.query(sql, params)).rows;
  });

async function join(role, customId = null) {
  const user = await createUser(db, `pl-${role}`);
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation_v2($1, $2, 24, '', $3)`, [ws, role, customId]);
  await run(db, user, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  return user;
}

async function publishedPipeline(name) {
  const [{ id }] = await run(db, owner, `insert into workflows (user_id, workspace_id, name) values ($1, $2, $3) returning id`, [owner.id, ws, name]);
  const [{ v }] = await admin(db, `insert into workflow_versions (workflow_id, version, name, graph, created_by) values ($1, 1, $2, '{"nodes":[],"edges":[]}', $3) returning id as v`, [id, name, owner.id]);
  await admin(db, `update workflows set published_version_id = $1 where id = $2`, [v, id]);
  return { id, version: v };
}

const start = (who, p, trigger) =>
  run(db, who, `select * from workflow_run_start($1, 'published', $2, null, 'h', $3)`, [p.id, p.version, trigger]);

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'pl-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  await run(db, owner, `select erp_set_terminal($1, true)`, [ws]);
});

test('background runs need the worker to hold a running job for that pipeline', async () => {
  const p = await publishedPipeline('Nightly');
  await expectError(start(owner, p, 'schedule'), /started by the worker/);
  const [{ id: job }] = await run(db, owner, `select ps_enqueue_job($1, 'pipeline.run', $2::jsonb) as id`, [ws, JSON.stringify({ pipeline_id: p.id })]);
  await asWorker(`select * from ps_worker.claim('w1', 5)`);
  const [r] = await start(owner, p, 'schedule');
  assert.equal(r.created, true);
  const [row] = await admin(db, `select triggered_by, job_id from workflow_runs where id = $1`, [r.run_id]);
  assert.deepEqual(row, { triggered_by: 'schedule', job_id: job });
  // Background runs are not counted against the editor's three-at-once limit, nor abandoned after 5 minutes.
  await admin(db, `update workflow_runs set started_at = now() - interval '20 minutes' where id = $1`, [r.run_id]);
  for (let i = 0; i < 3; i += 1) await start(owner, p, 'manual');
  assert.equal((await admin(db, `select status from workflow_runs where id = $1`, [r.run_id]))[0].status, 'running');
  await expectError(start(owner, p, 'manual'), /Too many/);
  // A lost job: the worker closes its run.
  await asWorker(`select ps_worker.close_pipeline_run($1, 'worker_lost')`, [job]);
  assert.deepEqual((await admin(db, `select status, error_code from workflow_runs where id = $1`, [r.run_id]))[0], { status: 'failed', error_code: 'worker_lost' });
});

test('restricted pipelines need a place on the list; disabled ones are skipped by schedules', async () => {
  const p = await publishedPipeline('Secret');
  const adminUser = await join('admin');
  assert.equal((await run(db, adminUser, `select count(*)::int n from workflows where id = $1`, [p.id]))[0].n, 1);
  await run(db, owner, `select ps_set_item_access('pipeline', $1, 'restricted', '[]'::jsonb)`, [p.id]);
  assert.equal((await admin(db, `select access from workflows where id = $1`, [p.id]))[0].access, 'restricted');
  assert.equal((await run(db, adminUser, `select count(*)::int n from workflows where id = $1`, [p.id]))[0].n, 0);
  await run(db, owner, `select ps_set_item_access('pipeline', $1, 'restricted', $2::jsonb)`, [p.id, JSON.stringify([{ kind: 'role', grantee: 'admin', permissions: ['pipelines.view'] }])]);
  assert.equal((await run(db, adminUser, `select count(*)::int n from workflows where id = $1`, [p.id]))[0].n, 1);
  await run(db, owner, `select ps_save_schedule($1, 'daily', '{"at":"02:00"}'::jsonb, 'Asia/Jakarta', now() - interval '1 minute')`, [p.id]);
  assert.ok((await asWorker(`select pipeline_id from ps_worker.due_schedules(10)`)).some((r) => r.pipeline_id === p.id));
  await run(db, owner, `select ps_set_pipeline_enabled($1, false)`, [p.id]);
  assert.ok(!(await asWorker(`select pipeline_id from ps_worker.due_schedules(10)`)).some((r) => r.pipeline_id === p.id));
  const sales = await join('sales');
  await expectError(run(db, sales, `select ps_set_pipeline_enabled($1, true)`, [p.id]), /not found/);
});

test('rollback restores the workflow rules', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000039_terminal_module.sql', import.meta.url), 'utf8'));
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000038_terminal_pipelines.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select count(*)::int n from information_schema.columns where table_name = 'workflows' and column_name in ('access', 'enabled')`);
  assert.equal(rows[0].n, 0);
  const [{ def }] = (await d.query(`select pg_get_functiondef('public.workflow_run_start(uuid,text,uuid,uuid,text,text)'::regprocedure) def`)).rows;
  assert.ok(!def.includes('v_job'));
  await d.close();
});
