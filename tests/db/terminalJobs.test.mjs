import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let ws;

// As the worker logs in (etna_worker), outside any user's rights.
const asWorker = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role etna_worker');
    return (await tx.query(sql, params)).rows;
  });

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'job-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  await run(db, owner, `select erp_set_terminal($1, true)`, [ws]);
});

const enqueue = (who, kind = 'import.analyze', key = null) =>
  run(db, who, `select ps_enqueue_job($1, $2, '{"x":1}'::jsonb, $3) as id`, [ws, kind, key]).then((r) => r[0].id);

test('members enqueue only jobs their permissions allow; keys make retries harmless', async () => {
  const id = await enqueue(owner);
  assert.equal(await enqueue(owner, 'import.analyze', 'k-1'), await enqueue(owner, 'import.analyze', 'k-1'));
  await expectError(enqueue(owner, 'maintenance.purge'), /Unknown job/);
  const stranger = await createUser(db, 'job-stranger');
  await expectError(run(db, stranger, `select ps_enqueue_job($1, 'import.analyze', '{}'::jsonb)`, [ws]), /not allowed/);
  const [j] = await run(db, owner, `select status, as_user, created_by from ps_jobs where id = $1`, [id]);
  assert.deepEqual([j.status, j.as_user, j.created_by], ['queued', owner.id, owner.id]);
  assert.equal((await run(db, stranger, `select count(*)::int n from ps_jobs`))[0].n, 0, 'other people see none');
  await expectError(run(db, owner, `update ps_jobs set status = 'succeeded' where id = $1`, [id]), /permission denied/);
});

test('the worker claims under a lease; expired leases come back; failures retry with backoff', async () => {
  await admin(db, `update ps_jobs set status = 'cancelled'`);
  const id = await enqueue(owner);
  const [claimed] = await asWorker(`select * from ps_worker.claim('w1', 1)`);
  assert.equal(claimed.id, id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.attempts, 1);
  assert.equal((await asWorker(`select * from ps_worker.claim('w2', 1)`)).length, 0, 'nothing else to take');
  assert.equal((await asWorker(`select ps_worker.heartbeat($1, 'w1', '{"rows":10}'::jsonb) as c`, [id]))[0].c, false);
  await expectError(asWorker(`select ps_worker.heartbeat($1, 'w2', null)`, [id]), /Lease lost/);
  // A lost worker: the lease runs out and another worker takes the job.
  await admin(db, `update ps_jobs set lease_until = now() - interval '1 second' where id = $1`, [id]);
  await admin(db, `update ps_jobs set run_after = now() where id = $1`, [id]).catch(() => {});
  await asWorker(`select * from ps_worker.claim('w2', 1)`);
  await admin(db, `update ps_jobs set run_after = now() - interval '1 minute' where id = $1 and status = 'queued'`, [id]);
  const [again] = await asWorker(`select * from ps_worker.claim('w2', 1)`);
  assert.equal(again.id, id);
  assert.equal(again.attempts, 2);
  const [{ s }] = await asWorker(`select ps_worker.finish($1, 'w2', 'failed', null, 'source_down', 'timeout', true) as s`, [id]);
  assert.equal(s, 'queued');
  const [later] = await admin(db, `select run_after > now() as later from ps_jobs where id = $1`, [id]);
  assert.equal(later.later, true);
  // Signed-in users cannot use the worker's functions.
  await expectError(run(db, owner, `select * from ps_worker.claim('me', 1)`), /permission denied/);
});

test('cancelling: queued jobs stop at once, running ones are asked to stop', async () => {
  await admin(db, `update ps_jobs set status = 'cancelled'`);
  const queued = await enqueue(owner);
  assert.equal((await run(db, owner, `select ps_cancel_job($1) as r`, [queued]))[0].r, 'cancelled');
  const running = await enqueue(owner);
  await asWorker(`select * from ps_worker.claim('w1', 1)`);
  assert.equal((await run(db, owner, `select ps_cancel_job($1) as r`, [running]))[0].r, 'cancelling');
  assert.equal((await asWorker(`select ps_worker.heartbeat($1, 'w1', null) as c`, [running]))[0].c, true);
});

test('schedules need a published pipeline and the schedule permission; chains never loop', async () => {
  const mk = async (name) => (await run(db, owner, `insert into workflows (user_id, workspace_id, name) values ($1, $2, $3) returning id`, [owner.id, ws, name]))[0].id;
  const a = await mk('A');
  const b = await mk('B');
  const c = await mk('C');
  await expectError(run(db, owner, `select ps_save_schedule($1, 'daily', '{"at":"02:00"}'::jsonb, 'Asia/Jakarta', now())`, [a]), /Publish the pipeline/);
  const [{ v }] = await admin(db, `insert into workflow_versions (workflow_id, version, name, graph, created_by) values ($1, 1, 'A', '{"nodes":[],"edges":[]}', $2) returning id as v`, [a, owner.id]);
  await admin(db, `update workflows set published_version_id = $1 where id = $2`, [v, a]);
  await run(db, owner, `select ps_save_schedule($1, 'daily', '{"at":"02:00"}'::jsonb, 'Asia/Jakarta', now() - interval '1 minute')`, [a]);
  const due = await asWorker(`select pipeline_id, run_as from ps_worker.due_schedules(10)`);
  assert.deepEqual(due, [{ pipeline_id: a, run_as: owner.id }]);
  await run(db, owner, `select ps_save_trigger($1, $2)`, [a, b]);
  await run(db, owner, `select ps_save_trigger($1, $2)`, [b, c]);
  await expectError(run(db, owner, `select ps_save_trigger($1, $2)`, [c, a]), /loop/);
  assert.deepEqual((await asWorker(`select downstream_id from ps_worker.downstream($1)`, [a])).map((r) => r.downstream_id), [b]);
  // Three failed scheduled runs switch the schedule off.
  for (let i = 0; i < 3; i += 1) await asWorker(`select ps_worker.schedule_result($1, false)`, [a]);
  const [s] = await admin(db, `select enabled, disabled_reason from ps_schedules where pipeline_id = $1`, [a]);
  assert.deepEqual([s.enabled, s.disabled_reason], [false, 'three_failures']);
});

test('the worker may run maintenance and system jobs, nothing more', async () => {
  const [{ id }] = await asWorker(`select ps_worker.enqueue(null, 'maintenance.purge', '{}'::jsonb, null, 'aal1', 'system', 'purge-2026-10-09') as id`);
  assert.ok(id);
  await asWorker(`select etna_platform.purge_by_retention()`);
  await asWorker(`select etna_platform.ensure_data_access_partitions(2)`);
  await expectError(asWorker(`select * from erp_customers`), /permission denied/);
  await expectError(asWorker(`select etna_platform.admin_list_users()`), /permission denied/);
});

test('rollback removes the queue', async () => {
  const d = await createDb();
  // Later migrations depend on this one: they are rolled back first.
  for (const name of ['20261012000049_terminal_ai', '20261012000048_terminal_mcp', '20261012000042_terminal_db_sources', '20261012000041_terminal_connectors', '20261012000040_company_export', '20261012000039_terminal_module', '20261012000038_terminal_pipelines', '20261012000037_terminal_imports', '20261012000036_terminal_datasets', '20261012000035_terminal_jobs']) {
    await d.exec(readFileSync(new URL(`../../db/rollback/rollback_${name}.sql`, import.meta.url), 'utf8'));
  }
  const { rows } = await d.query(`select to_regclass('public.ps_jobs') is null as gone, to_regnamespace('ps_worker') is null as schema_gone`);
  assert.deepEqual(rows[0], { gone: true, schema_gone: true });
  await d.close();
});
