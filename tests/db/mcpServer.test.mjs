import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, admin } from './harness.mjs';
import { handleMessage } from '../../src/server/mcp/protocol.ts';
import { MCP_TOOLS, toolsFor } from '../../src/server/mcp/tools.ts';
import { overview } from '../../src/server/terminal/service.ts';

let db;
let owner;
let ws;
let other;
let pipeline;
let foreign;
let runId;

const executor = () => ({
  transaction: (fn) =>
    db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })),
});
const ctxFor = (user, workspaceId) => ({
  executor: executor(),
  identity: { userId: user.id, email: user.email, aal: 'aal2' },
  workspaceId,
});
let nextId = 1;
const call = async (ctx, name, args = {}) => {
  const r = await handleMessage(
    { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
    ctx,
    MCP_TOOLS
  );
  return r.result;
};
const value = (result) => JSON.parse(result.content[0].text);

const GRAPH = {
  nodes: [
    {
      id: 'src',
      type: 'workflow',
      position: { x: 0, y: 0 },
      data: {
        type: 'dataset_source',
        label: 'Penjualan',
        config: { datasetId: 'x' },
        preview: { rows: [{ secret: 1 }] },
        status: 'success',
      },
    },
    {
      id: 'agg',
      type: 'workflow',
      position: { x: 200, y: 0 },
      data: { type: 'aggregate', label: 'Per bulan', config: { groupBy: ['month'] } },
    },
  ],
  edges: [{ id: 'e1', source: 'src', target: 'agg' }],
};

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'mcp-srv-owner');
  [{ id: ws }] = await run(db, owner, `select erp_create_terminal('Data tambang') as id`);
  [{ id: other }] = await run(db, owner, `select erp_create_terminal('Lain') as id`);
  const insert = (w, name) =>
    run(
      db,
      owner,
      `insert into workflows (user_id, workspace_id, name, description, graph) values ($1, $2, $3, 'Laporan bulanan', $4::jsonb) returning id`,
      [owner.id, w, name, JSON.stringify(GRAPH)]
    ).then((r) => r[0].id);
  pipeline = await insert(ws, 'Penjualan bulanan');
  foreign = await insert(other, 'Rahasia');
  [{ id: runId }] = await admin(
    db,
    `insert into workflow_runs (workflow_id, user_id, workspace_id, status, node_results, duration_ms, finished_at, triggered_by, error_code)
     values ($1, $2, $3, 'failed', $4::jsonb, 1200, now(), 'schedule', 'source_down') returning id`,
    [
      pipeline,
      owner.id,
      ws,
      JSON.stringify({
        src: { ok: true, ms: 800, rows: 120, cols: 5 },
        agg: { ok: false, ms: 400, error: { key: 'missing_column' } },
      }),
    ]
  );
});

test('initialize, ping and the list of read-only tools', async () => {
  const ctx = ctxFor(owner, ws);
  const init = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    },
    ctx,
    MCP_TOOLS
  );
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  // An unknown version gets the newest one.
  const old = await handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    ctx,
    MCP_TOOLS
  );
  assert.equal(old.result.protocolVersion, '2025-06-18');
  assert.equal(
    await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx, MCP_TOOLS),
    null
  );
  assert.deepEqual(
    (await handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }, ctx, MCP_TOOLS)).result,
    {}
  );
  // A connection that may only read is not offered the tools that write.
  const list = await handleMessage(
    { jsonrpc: '2.0', id: 4, method: 'tools/list' },
    ctx,
    toolsFor(ctx)
  );
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    [
      'list_pipelines',
      'get_pipeline',
      'list_pipeline_runs',
      'get_pipeline_run',
      'list_datasets',
      'preview_dataset',
      'list_node_types',
      'list_erp_fields',
      'validate_pipeline',
      'test_pipeline',
      'profile_dataset',
      'analyze_dataset',
      'get_terminal_health',
    ]
  );
  assert.ok(
    list.result.tools.every(
      (t) => t.annotations.readOnlyHint === true && t.inputSchema.type === 'object'
    )
  );
  assert.equal(
    (await handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, ctx, MCP_TOOLS)).error
      .code,
    -32601
  );
  assert.equal(
    (
      await handleMessage(
        { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'drop_everything' } },
        ctx,
        MCP_TOOLS
      )
    ).error.code,
    -32602
  );
  assert.equal((await handleMessage([1, 2], ctx, MCP_TOOLS)).error.code, -32600);
});

test("pipelines, their steps and their runs, only of the token's Terminal", async () => {
  const ctx = ctxFor(owner, ws);
  const { pipelines } = value(await call(ctx, 'list_pipelines'));
  assert.deepEqual(
    pipelines.map((p) => p.name),
    ['Penjualan bulanan']
  );
  assert.equal(pipelines[0].last_run.status, 'failed');

  const p = value(await call(ctx, 'get_pipeline', { pipeline_id: pipeline }));
  assert.deepEqual(
    p.nodes.map((n) => [n.id, n.type, n.label]),
    [
      ['src', 'dataset_source', 'Penjualan'],
      ['agg', 'aggregate', 'Per bulan'],
    ]
  );
  assert.deepEqual(p.edges, [{ from: 'src', to: 'agg' }]);
  // What only the editor keeps (cached preview rows) is not sent.
  assert.equal(JSON.stringify(p).includes('secret'), false);
  assert.equal(
    (await call(ctx, 'get_pipeline', { pipeline_id: pipeline, version: 'published' })).isError,
    true
  );

  const runs = value(await call(ctx, 'list_pipeline_runs', { pipeline_id: pipeline }));
  assert.equal(runs.runs[0].error_code, 'source_down');
  const detail = value(await call(ctx, 'get_pipeline_run', { run_id: runId }));
  assert.deepEqual(
    detail.steps.map((s) => [s.label, s.ok, s.rows, s.error?.key ?? null]),
    [
      ['Penjualan', true, 120, null],
      ['Per bulan', false, null, 'missing_column'],
    ]
  );

  // Another Terminal's pipeline, even of the same person, is not reachable with this token.
  const r = await call(ctx, 'get_pipeline', { pipeline_id: foreign });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not found/);
  assert.equal((await call(ctx, 'get_pipeline', { pipeline_id: 'nope' })).isError, true);
  assert.deepEqual(value(await call(ctx, 'list_datasets')).datasets, []);
});

test('someone who is not a member sees nothing, whatever the token says', async () => {
  const stranger = await createUser(db, 'mcp-srv-stranger');
  const ctx = ctxFor(stranger, ws);
  assert.deepEqual(value(await call(ctx, 'list_pipelines')).pipelines, []);
  assert.equal((await call(ctx, 'get_pipeline', { pipeline_id: pipeline })).isError, true);
});

test('the overview says what needs attention: the failed pipeline, waiting jobs without a worker', async () => {
  await admin(
    db,
    `insert into ps_jobs (workspace_id, kind, payload, status, created_by, as_user, run_after, created_at)
     values ($1, 'pipeline.run', $2::jsonb, 'queued', $3, $3, now() - interval '10 minutes', now() - interval '10 minutes')`,
    [ws, JSON.stringify({ pipeline_id: pipeline }), owner.id]
  );
  const o = await overview(
    { executor: executor(), identity: { userId: owner.id, email: owner.email, aal: 'aal2' } },
    ws
  );
  assert.equal(o.health.workerOnline, false);
  assert.equal(o.health.waitingJobs, 1);
  assert.deepEqual(
    o.health.failingPipelines.map((p) => [p.name, p.errorCode]),
    [['Penjualan bulanan', 'source_down']]
  );
  assert.deepEqual(o.health.staleDatasets, []);
  assert.equal(o.jobs[0].mine, true);
});
