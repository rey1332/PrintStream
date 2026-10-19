import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';
import { runSqlJob, mentions } from '../../src/server/terminal/sqlJobs.ts';
import { sqlHistory, sqlResult, sqlRun, sqlTargets } from '../../src/server/terminal/sqlService.ts';

// The Query Tool (20261012000058): read-only SQL over the Terminal's datasets
// in a sandbox (PGlite in a thread), results kept for the member only.

let db;
let owner;
let finance;
let sales;
let ws;
let ds;

const executor = () => ({
  transaction: (fn) =>
    db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })),
});
const ctxOf = (user, aal = 'aal2') => ({
  executor: executor(),
  identity: { userId: user.id, email: user.email, aal },
});
const asWorker = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role etna_worker');
    return (await tx.query(sql, params)).rows;
  });
const asWorkerFor = (user, sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: user.id, role: 'authenticated', aal: 'aal2' }),
    ]);
    await tx.exec('set local role etna_worker');
    return (await tx.query(sql, params)).rows;
  });

/** Starts a run as the member and runs its job as the worker would. */
async function query(user, sql, mode = 'run') {
  const { runId, jobId } = await sqlRun(ctxOf(user), { workspaceId: ws, sql, mode });
  const env = {
    db: (q, p = []) => asWorker(q, p),
    executor: executor(),
    identity: { userId: user.id, email: user.email, aal: 'aal2' },
    beat: async () => false,
  };
  await runSqlJob(env, { id: jobId, payload: { run_id: runId } });
  return sqlResult(ctxOf(user), { id: runId });
}

async function join(role, name) {
  const user = await createUser(db, name);
  const [{ access_code }] = await run(
    db,
    owner,
    `select access_code from erp_create_workspace_invitation_v2($1, $2, 24, '', null)`,
    [ws, role]
  );
  await run(db, user, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  return user;
}

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'qt-owner');
  [{ id: ws }] = await run(db, owner, `select erp_create_terminal('Data tambang') as id`);
  finance = await join('finance', 'qt-finance');
  sales = await join('sales', 'qt-sales');
  [{ id: ds }] = await run(
    db,
    owner,
    `select ps_create_dataset($1, 'Ritase', 'Ops', '', $2::jsonb) as id`,
    [
      ws,
      JSON.stringify([
        { label: 'site', type: 'text' },
        { label: 'tonnes', type: 'decimal' },
        { label: 'driver_nik', type: 'text', sensitive: true },
        { label: 'note', type: 'text' },
      ]),
    ]
  );
  await asWorkerFor(owner, `select ps_admin.provision_dataset($1)`, [ds]);
  const [{ physical_table }] = await admin(
    db,
    `select physical_table from ps_datasets where id = $1`,
    [ds]
  );
  const cols = Object.fromEntries(
    (
      await admin(db, `select label, physical_name from ps_dataset_columns where dataset_id = $1`, [
        ds,
      ])
    ).map((c) => [c.label, c.physical_name])
  );
  const rows = [
    ['Utara', 12.5, '3201010101010001', 'pagi'],
    ['Utara', 7.25, '3201010101010002', ''],
    ['Selatan', 20, '3201010101010003', null],
  ];
  for (const [site, tonnes, nik, note] of rows)
    await admin(
      db,
      `insert into ps_data.${physical_table} ("${cols.site}", "${cols.tonnes}", "${cols.driver_nik}", "${cols.note}", _workspace_id) values ($1, $2, $3, $4, $5)`,
      [site, tonnes, nik, note, ws]
    );
  await admin(db, `update ps_datasets set row_count = 3 where id = $1`, [ds]);
});

test('names in the SQL pick the datasets to load', () => {
  assert.equal(mentions('select * from "Ritase"', 'Ritase'), true);
  assert.equal(mentions('select * from ritase r', 'Ritase'), true);
  assert.equal(mentions('select * from ritase_old', 'Ritase'), false);
  assert.equal(mentions('select 1', 'Ritase'), false);
  assert.equal(mentions('select * from "Sales 2026"', 'Sales 2026'), true);
});

test('a query over a dataset: real rows, column types, NULL apart from empty text', async () => {
  const r = await query(
    owner,
    `select site, sum(tonnes) as total, count(*)::int as n from "Ritase" group by site order by site`
  );
  assert.equal(r.status, 'succeeded');
  assert.deepEqual(
    r.columns.map((c) => [c.name, c.type]),
    [
      ['site', 'text'],
      ['total', 'numeric'],
      ['n', 'integer'],
    ]
  );
  assert.deepEqual(
    r.rows.map((x) => [x[0], Number(x[1]), x[2]]),
    [
      ['Selatan', 20, 1],
      ['Utara', 19.75, 2],
    ]
  );
  const notes = await query(owner, `select note from "Ritase" order by tonnes`);
  assert.deepEqual(
    notes.rows.map((x) => x[0]),
    ['', 'pagi', null]
  );
  assert.ok(notes.messages.some((m) => m.key === 'loaded' && m.vars.name === 'Ritase'));
  // Dates and times as PostgreSQL writes them.
  const when = await query(owner, `select date '2026-07-01' as d, time '08:30' as t, interval '2 days' as i`);
  assert.deepEqual(when.rows[0], ['2026-07-01', '08:30:00', '2 days']);
  assert.equal(typeof notes.durationMs, 'number');
});

test('errors come back from PostgreSQL with code and position; nothing can be written', async () => {
  const bad = await query(owner, `select nope from "Ritase"`);
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error.code, '42703');
  // Counted in the query as written ("select nope…": n is the 8th character).
  assert.equal(bad.error.position, 8);
  assert.match(bad.error.message, /nope/);
  const write = await query(owner, `delete from "Ritase"`);
  assert.equal(write.status, 'failed');
  assert.equal(write.error.code, '25006');
  // PrintStream's own tables are not there to be read: only the datasets were copied in.
  const own = await query(owner, `select * from erp_workspaces`);
  assert.equal(own.status, 'failed');
  assert.equal(own.error.code, '42P01');
  const claims = await query(
    owner,
    `select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true)`
  );
  // Harmless in the sandbox: there is nothing behind it.
  assert.equal(claims.status, 'succeeded');
});

test('explain and explain analyze give the plan', async () => {
  const plan = await query(owner, `select * from "Ritase" where tonnes > 10`, 'explain');
  assert.equal(plan.status, 'succeeded');
  assert.equal(plan.columns[0].name, 'QUERY PLAN');
  assert.match(plan.rows.map((x) => x[0]).join('\n'), /Seq Scan on "?Ritase"?/);
  // Costs as on an ordinary server (PGlite turns sequential scans off by default).
  assert.doesNotMatch(plan.rows[0][0], /cost=10000000000/);
  const analyzed = await query(owner, `select * from "Ritase"`, 'analyze');
  assert.match(analyzed.rows.map((x) => x[0]).join('\n'), /actual time/);
});

test('large results: the first 2,000 rows and it says so', async () => {
  const r = await query(owner, `select g from generate_series(1, 5000) g`);
  assert.equal(r.status, 'succeeded');
  assert.equal(r.rows.length, 2000);
  assert.equal(r.truncated, 'rows');
});

test('the member sees what the app shows them: sensitive columns masked', async () => {
  const mine = await query(owner, `select driver_nik from "Ritase" order by driver_nik`);
  assert.equal(mine.rows[0][0], '3201010101010001');
  const theirs = await query(finance, `select driver_nik from "Ritase" order by driver_nik`);
  assert.equal(theirs.status, 'succeeded');
  assert.ok(theirs.rows.every((x) => x[0] !== '3201010101010001' && /•/.test(x[0])));
});

test('who may run what; runs and history are the member’s own', async () => {
  // Sales has no datasets.query.
  await expectError(sqlRun(ctxOf(sales), { workspaceId: ws, sql: 'select 1' }), /forbidden/);
  await expectError(sqlRun(ctxOf(owner), { workspaceId: ws, sql: '   ' }), /sql_empty/);
  // A connection: integrations.manage with two-factor.
  const [{ id: conn }] = await admin(
    db,
    `insert into ps_connections (workspace_id, kind, name, config, created_by) values ($1, 'postgres', 'Gudang', '{"host":"db.example.com","database":"wh"}', $2) returning id`,
    [ws, owner.id]
  );
  await expectError(
    sqlRun(ctxOf(owner, 'aal1'), { workspaceId: ws, connectionId: conn, sql: 'select 1' }),
    /mfaRequired/
  );
  await expectError(
    sqlRun(ctxOf(finance), { workspaceId: ws, connectionId: conn, sql: 'select 1' }),
    /forbidden/
  );
  const started = await sqlRun(ctxOf(owner), {
    workspaceId: ws,
    connectionId: conn,
    sql: 'select 1',
  });
  const [job] = await admin(db, `select kind, as_user from ps_jobs where id = $1`, [started.jobId]);
  assert.deepEqual(job, { kind: 'sql.connection', as_user: owner.id });

  const [mine] = await sqlHistory(ctxOf(owner), { workspaceId: ws });
  assert.equal(mine.sql, 'select 1');
  assert.equal(mine.targetName, 'Gudang');
  assert.ok(
    (await sqlHistory(ctxOf(finance), { workspaceId: ws })).every(
      (h) => h.sql !== 'select 1' || h.targetName !== 'Gudang'
    )
  );
  await expectError(sqlResult(ctxOf(finance), { id: started.runId }), /notFound/);

  const targets = await sqlTargets(ctxOf(finance), { workspaceId: ws });
  assert.equal(targets.canQueryDatasets, true);
  assert.equal(targets.canQueryConnections, false);
  assert.deepEqual(
    targets.datasets.map((d) => d.name),
    ['Ritase']
  );
  assert.deepEqual(
    targets.connections.map((c) => c.name),
    ['Gudang']
  );
});

test('rollback removes the Query Tool', async () => {
  const d = await createDb();
  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261012000058_terminal_query_tool.sql', import.meta.url),
      'utf8'
    )
  );
  const [{ t }] = await admin(d, `select to_regclass('public.ps_sql_runs') as t`);
  assert.equal(t, null);
  const [{ p }] = await admin(d, `select public.ps_job_permission('sql.datasets') as p`);
  assert.equal(p, null);
});
