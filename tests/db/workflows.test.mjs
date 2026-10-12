import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, applyMigrations, createUser, run, admin, expectError } from './harness.mjs';

const PREVIOUS = '20260926030000';

let db;
let owner;
let viewer;
let outsider;
let workspace;
let legacy;

async function join(member, role) {
  const [{ access_code }] = await run(db, owner,
    `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`, [workspace, role]);
  const [{ r }] = await run(db, member, `select erp_redeem_workspace_invitation($1) as r`, [access_code]);
  assert.equal(r.ok, true);
}

const graph = (n) => JSON.stringify({ nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}` })), edges: [] });

async function newWorkflow(user, { ws = null, name = 'Flow' } = {}) {
  const [row] = await run(db, user,
    `insert into workflows (user_id, name, graph, workspace_id) values ($1, $2, $3::jsonb, $4) returning *`,
    [user.id, name, graph(1), ws]);
  return row;
}

before(async () => {
  // Previous schema and data written the way the previous app writes it.
  db = await createDb({ through: PREVIOUS });
  owner = await createUser(db, 'wf-owner');
  viewer = await createUser(db, 'wf-viewer');
  outsider = await createUser(db, 'wf-outsider');
  [legacy] = await run(db, owner,
    `insert into workflows (user_id, name, graph) values ($1, 'Legacy', $2::jsonb) returning *`, [owner.id, graph(2)]);
  await run(db, owner,
    `insert into workflow_runs (workflow_id, user_id, status, node_results, duration_ms, finished_at)
     values ($1, $2, 'success', '{"n0":{"ok":true}}', 12, now())`, [legacy.id, owner.id]);

  await applyMigrations(db, { after: PREVIOUS });
  [{ workspace_id: workspace }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  // A member who reads everything (Finance) but did not create the workflows.
  await join(viewer, 'finance');
});

test('existing workflows and runs survive the upgrade unchanged and stay private', async () => {
  const [wf] = await admin(db, `select * from workflows where id = $1`, [legacy.id]);
  assert.equal(wf.name, 'Legacy');
  assert.deepEqual(wf.graph, JSON.parse(graph(2)));
  assert.equal(new Date(wf.updated_at).getTime(), new Date(legacy.updated_at).getTime());
  assert.equal(wf.workspace_id, workspace, 'backfilled to the personal workspace');
  const [r] = await admin(db, `select status, run_kind, triggered_by, duration_ms from workflow_runs where workflow_id = $1`, [legacy.id]);
  assert.deepEqual(r, { status: 'success', run_kind: 'draft', triggered_by: 'manual', duration_ms: 12 });
  assert.equal((await run(db, outsider, `select id from workflows`)).length, 0);
});

test('the previous app version can still create, list, save and record runs', async () => {
  const [wf] = await run(db, owner,
    `insert into workflows (user_id, name, graph) values ($1, 'Old client', '{"nodes":[],"edges":[]}') returning *`, [owner.id]);
  assert.equal(wf.workspace_id, workspace, 'new rows without a workspace go to the personal workspace');
  await run(db, owner, `update workflows set graph = $2::jsonb, updated_at = now() where id = $1 and user_id = $3`, [wf.id, graph(3), owner.id]);
  const listed = await run(db, owner, `select id from workflows where user_id = $1`, [owner.id]);
  assert.ok(listed.some((row) => row.id === wf.id));
  await run(db, owner,
    `insert into workflow_runs (workflow_id, user_id, status, node_results, duration_ms, finished_at)
     values ($1, $2, 'failed', '{}', 5, now())`, [wf.id, owner.id]);
});

test('workspace members can read shared workflows; only the creator can change them', async () => {
  const wf = await newWorkflow(owner, { ws: workspace, name: 'Shared' });
  assert.equal((await run(db, viewer, `select id from workflows where id = $1`, [wf.id])).length, 1);
  assert.equal((await run(db, outsider, `select id from workflows where id = $1`, [wf.id])).length, 0);
  const updated = await run(db, viewer, `update workflows set name = 'Hijacked' where id = $1 returning id`, [wf.id]);
  assert.equal(updated.length, 0);
  const deleted = await run(db, viewer, `delete from workflows where id = $1 returning id`, [wf.id]);
  assert.equal(deleted.length, 0);
});

test('a workflow cannot be placed in a workspace the user does not belong to', async () => {
  await expectError(newWorkflow(outsider, { ws: workspace }), /workspace is not available/);
  const mine = await newWorkflow(outsider);
  await expectError(run(db, outsider, `update workflows set workspace_id = $2 where id = $1`, [mine.id, workspace]), /workspace is not available/);
});

test('versions are numbered snapshots, immutable and only created by the creator', async () => {
  const wf = await newWorkflow(owner, { ws: workspace, name: 'Versioned' });
  const [v1] = await run(db, owner, `select * from workflow_save_version($1, 'first', false)`, [wf.id]);
  await run(db, owner, `update workflows set graph = $2::jsonb, name = 'Versioned 2' where id = $1`, [wf.id, graph(4)]);
  const [v2] = await run(db, owner, `select * from workflow_save_version($1, 'second', true)`, [wf.id]);
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  assert.deepEqual(v1.graph, JSON.parse(graph(1)));
  assert.equal(v2.name, 'Versioned 2');
  const [{ published_version_id }] = await admin(db, `select published_version_id from workflows where id = $1`, [wf.id]);
  assert.equal(published_version_id, v2.id);

  // Members see versions; nobody can edit or add them directly.
  assert.equal((await run(db, viewer, `select id from workflow_versions where workflow_id = $1`, [wf.id])).length, 2);
  assert.equal((await run(db, outsider, `select id from workflow_versions where workflow_id = $1`, [wf.id])).length, 0);
  await expectError(run(db, owner, `update workflow_versions set graph = '{}' where id = $1`, [v1.id]), /permission denied/);
  await expectError(run(db, owner, `insert into workflow_versions (workflow_id, version, name, graph) values ($1, 9, 'x', '{}')`, [wf.id]), /permission denied/);
  await expectError(run(db, viewer, `select * from workflow_save_version($1, '', false)`, [wf.id]), /not found/);

  // Publishing an older version, but never another workflow's version.
  await run(db, owner, `select workflow_publish_version($1, $2)`, [wf.id, v1.id]);
  const other = await newWorkflow(owner);
  const [ov] = await run(db, owner, `select * from workflow_save_version($1, '', false)`, [other.id]);
  await expectError(run(db, owner, `select workflow_publish_version($1, $2)`, [wf.id, ov.id]), /does not belong/);
  await expectError(run(db, owner, `update workflows set published_version_id = $2 where id = $1`, [wf.id, ov.id]), /does not belong/);
});

test('runs are recorded by the lifecycle functions with server timestamps', async () => {
  const wf = await newWorkflow(owner, { ws: workspace, name: 'Runs' });
  const request = '9b2f4c1e-8d4a-4f7b-9e3c-1a2b3c4d5e6f';
  const [start] = await run(db, viewer, `select * from workflow_run_start($1, 'draft', null, $2, 'hash')`, [wf.id, request]);
  assert.equal(start.created, true);
  // Retrying the same request reuses the run instead of starting another.
  const [again] = await run(db, viewer, `select * from workflow_run_start($1, 'draft', null, $2, 'hash')`, [wf.id, request]);
  assert.deepEqual([again.run_id, again.created], [start.run_id, false]);

  // Someone else cannot finish it; the runner can, once.
  await expectError(run(db, owner, `select workflow_run_finish($1, 'success', '{}', '{}', 1, null, null)`, [start.run_id]), /not found/);
  const [{ workflow_run_finish: s1 }] = await run(db, viewer,
    `select workflow_run_finish($1, 'success', '{"n1":{"ok":true,"rows":3}}', '{"missingRequired":1}', 3, null, null)`, [start.run_id]);
  const [{ workflow_run_finish: s2 }] = await run(db, viewer,
    `select workflow_run_finish($1, 'failed', '{}', '{}', 0, 'x', 'late')`, [start.run_id]);
  assert.deepEqual([s1, s2], ['success', 'success']);
  const [row] = await admin(db, `select * from workflow_runs where id = $1`, [start.run_id]);
  assert.equal(row.status, 'success');
  assert.equal(row.user_id, viewer.id);
  assert.equal(row.workspace_id, workspace);
  assert.ok(row.finished_at && row.duration_ms >= 0);
  assert.deepEqual(row.quality, { missingRequired: 1 });

  // The creator sees members' run history; outsiders cannot start runs.
  assert.equal((await run(db, owner, `select id from workflow_runs where id = $1`, [start.run_id])).length, 1);
  await expectError(run(db, outsider, `select * from workflow_run_start($1, 'draft', null, null, null)`, [wf.id]), /not found/);
});

test('runs of a version record its number; a version must belong to the workflow', async () => {
  const wf = await newWorkflow(owner, { name: 'Version runs' });
  const [v] = await run(db, owner, `select * from workflow_save_version($1, '', true)`, [wf.id]);
  const [s] = await run(db, owner, `select * from workflow_run_start($1, 'published', $2, null, null)`, [wf.id, v.id]);
  assert.equal(s.run_version, 1);
  const other = await newWorkflow(owner);
  await expectError(run(db, owner, `select * from workflow_run_start($1, 'version', $2, null, null)`, [other.id, v.id]), /Version not found/);
  await expectError(run(db, owner, `select * from workflow_run_start($1, 'draft', $2, null, null)`, [wf.id, v.id]), /Invalid run version/);
  await run(db, owner, `select workflow_run_finish($1, 'success', '{}', '{}', 0, null, null)`, [s.run_id]);
});

test('cancellation, abandoned runs and the concurrent run limit', async () => {
  const wf = await newWorkflow(outsider, { name: 'Limits' });
  const started = [];
  for (let i = 0; i < 3; i++) {
    started.push((await run(db, outsider, `select * from workflow_run_start($1, 'draft', null, null, null)`, [wf.id]))[0].run_id);
  }
  await expectError(run(db, outsider, `select * from workflow_run_start($1, 'draft', null, null, null)`, [wf.id]), /Too many workflow runs/);

  const [{ workflow_run_cancel: status }] = await run(db, outsider, `select workflow_run_cancel($1)`, [started[0]]);
  assert.equal(status, 'running');
  const [{ workflow_run_cancel_requested: requested }] = await run(db, outsider, `select workflow_run_cancel_requested($1)`, [started[0]]);
  assert.equal(requested, true);
  await expectError(run(db, viewer, `select workflow_run_cancel($1)`, [started[1]]), /not found/);
  await run(db, outsider, `select workflow_run_finish($1, 'cancelled', '{}', '{}', null, 'cancelled', null)`, [started[0]]);

  // A run whose function was stopped is closed on the next start.
  await admin(db, `update workflow_runs set started_at = now() - interval '10 minutes' where id = $1`, [started[1]]);
  await run(db, outsider, `select * from workflow_run_start($1, 'draft', null, null, null)`, [wf.id]);
  const [abandoned] = await admin(db, `select status, error_code from workflow_runs where id = $1`, [started[1]]);
  assert.deepEqual(abandoned, { status: 'failed', error_code: 'abandoned' });
});

test('oversized run results are not stored', async () => {
  const wf = await newWorkflow(owner, { name: 'Big' });
  const [s] = await run(db, owner, `select * from workflow_run_start($1, 'draft', null, null, null)`, [wf.id]);
  const huge = JSON.stringify({ n: 'x'.repeat(300000) });
  await run(db, owner, `select workflow_run_finish($1, 'success', $2::jsonb, '{}', 0, null, null)`, [s.run_id, huge]);
  const [row] = await admin(db, `select node_results from workflow_runs where id = $1`, [s.run_id]);
  assert.deepEqual(row.node_results, {});
});

test('auto-refresh runs are labelled, spaced out and pruned; manual runs are untouched', async () => {
  const user = await createUser(db, 'wf-auto');
  const wf = await newWorkflow(user, { name: 'Auto' });
  const start = (trigger) =>
    run(db, user, `select * from workflow_run_start($1, 'draft', null, null, 'h', $2)`, [wf.id, trigger]);
  const finish = (id) => run(db, user, `select workflow_run_finish($1, 'success', '{}', '{}', 0, null, null)`, [id]);

  // Callers that do not pass a trigger still record a manual run.
  const [manual] = await run(db, user, `select * from workflow_run_start($1, 'draft', null, null, 'h')`, [wf.id]);
  await finish(manual.run_id);
  const [auto] = await start('auto_refresh');
  await finish(auto.run_id);
  const rows = await admin(db, `select id, triggered_by from workflow_runs where workflow_id = $1 order by started_at`, [wf.id]);
  assert.deepEqual(rows.map((r) => r.triggered_by), ['manual', 'auto_refresh']);

  // A second auto-refresh within 45 seconds is refused; manual runs are not limited by it.
  await expectError(start('auto_refresh'), /Auto-refresh too soon/);
  await finish((await start('manual'))[0].run_id);
  await expectError(start('schedule'), /started by the worker/);
  await expectError(start('nightly'), /Invalid run trigger/);

  // Only the newest 100 finished auto-refresh runs are kept.
  await admin(db,
    `insert into workflow_runs (workflow_id, user_id, status, triggered_by, started_at, finished_at)
     select $1, $2, 'success', 'auto_refresh', now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval
     from generate_series(2, 130) g`, [wf.id, user.id]);
  await admin(db, `update workflow_runs set started_at = now() - interval '1 minute' where id = $1`, [auto.run_id]);
  const [latest] = await start('auto_refresh');
  await finish(latest.run_id);
  const [{ n: autoCount }] = await admin(db,
    `select count(*)::int as n from workflow_runs where workflow_id = $1 and triggered_by = 'auto_refresh'`, [wf.id]);
  assert.equal(autoCount, 100);
  const [{ n: manualCount }] = await admin(db,
    `select count(*)::int as n from workflow_runs where workflow_id = $1 and triggered_by = 'manual'`, [wf.id]);
  assert.equal(manualCount, 2);

  // Outsiders cannot auto-refresh a workflow they cannot see.
  await expectError(run(db, outsider, `select * from workflow_run_start($1, 'draft', null, null, 'h', 'auto_refresh')`, [wf.id]), /not found/);
});
