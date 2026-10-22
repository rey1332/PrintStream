import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createDb, createUser, run, admin } from './harness.mjs';
import { handleMessage } from '../../src/server/mcp/protocol.ts';
import { toolsFor } from '../../src/server/mcp/tools.ts';

// The MCP pipeline builder and insights end to end (src/server/mcp/builder.ts):
// describe the steps, check a graph, test-run it on a dataset (writing
// nothing), save it as a draft, change the draft, profile and analyse data.

let db;
let owner;
let ws;
let ds;
let tokenId;

const executor = () => ({
  transaction: (fn) =>
    db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })),
});
const ctxFor = (canWrite = true) => ({
  executor: executor(),
  identity: { userId: owner.id, email: owner.email, aal: 'aal2' },
  workspaceId: ws,
  tokenId,
  canWrite,
  allow: async () => true,
});
let nextId = 1;
const call = async (name, args = {}, ctx = ctxFor()) =>
  (
    await handleMessage(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
      ctx,
      toolsFor(ctx)
    )
  ).result;
const value = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};

const asWorkerFor = (user, sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: user.id, role: 'authenticated', aal: 'aal2' }),
    ]);
    await tx.exec('set local role etna_worker');
    return (await tx.query(sql, params)).rows;
  });

const graph = (extra = []) => ({
  nodes: [
    { id: 'sales', type: 'src.psDataset', config: { datasetId: ds } },
    {
      id: 'per_site',
      type: 'tf.aggregate',
      label: 'Per site',
      config: { groupBy: 'site', aggregateColumn: 'amount', operation: 'sum' },
    },
    { id: 'table', type: 'out.table' },
    ...extra,
  ],
  edges: [
    { from: 'sales', to: 'per_site' },
    { from: 'per_site', to: 'table' },
  ],
});

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'builder-tools-owner');
  [{ id: ws }] = await run(db, owner, `select erp_create_terminal('Data tambang') as id`);
  [{ id: ds }] = await run(
    db,
    owner,
    `select ps_create_dataset($1, 'Sales', 'Ops', '', $2::jsonb) as id`,
    [
      ws,
      JSON.stringify([
        { label: 'month', type: 'date' },
        { label: 'amount', type: 'decimal' },
        { label: 'site', type: 'text' },
      ]),
    ]
  );
  await asWorkerFor(owner, `select ps_admin.provision_dataset($1)`, [ds]);
  const [{ physical_table }] = await admin(
    db,
    `select physical_table from ps_datasets where id = $1`,
    [ds]
  );
  const cols = await admin(
    db,
    `select label, physical_name as physical from ps_dataset_columns where dataset_id = $1`,
    [ds]
  );
  const c = Object.fromEntries(cols.map((x) => [x.label, x.physical]));
  // A year of months; one month far above the others.
  for (let m = 1; m <= 12; m += 1)
    await admin(
      db,
      `insert into ps_data.${physical_table} ("${c.month}", "${c.amount}", "${c.site}", _workspace_id) values ($1, $2, $3, $4)`,
      [
        `2026-${String(m).padStart(2, '0')}-15`,
        m === 9 ? 5000 : 100 + m,
        m % 2 ? 'Utara' : 'Selatan',
        ws,
      ]
    );
  await admin(db, `update ps_datasets set row_count = 12 where id = $1`, [ds]);
  const secret = `psmcp_${randomBytes(32).toString('base64url')}`;
  [{ id: tokenId }] = await run(
    db,
    owner,
    `select ps_mcp_token_create_v2($1, 'Claude', $2, $3, 30, true) as id`,
    [ws, createHash('sha256').update(secret).digest('hex'), secret.slice(0, 12)]
  );
});

test('the steps are described for the assistant; writing tools only for writers', async () => {
  const { node_types } = value(await call('list_node_types'));
  const filter = node_types.find((n) => n.type === 'tf.filter');
  assert.equal(filter.inputs, 1);
  assert.match(filter.notes, /operator/);
  assert.deepEqual(node_types.find((n) => n.type === 'tf.branch').output_ports, ['match', 'else']);
  assert.ok(node_types.some((n) => n.type === 'tf.dedupe'));
  const { entities } = value(await call('list_erp_fields', { entity: 'invoices' }));
  assert.ok(entities[0].fields.some((f) => f.key === 'total'));

  const names = (ctx) => toolsFor(ctx).map((t) => t.name);
  assert.ok(names(ctxFor(true)).includes('create_pipeline'));
  assert.ok(!names(ctxFor(false)).includes('create_pipeline'));
  assert.ok(!names(ctxFor(false)).includes('update_pipeline'));
  // Even when called by name, a read-only connection cannot write.
  const r = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'create_pipeline', arguments: { name: 'x', ...graph() } },
    },
    ctxFor(false),
    toolsFor(ctxFor(false))
  );
  assert.equal(r.error.code, -32602);
});

test('checking a graph: problems in words, the columns of each step', async () => {
  const ok = value(await call('validate_pipeline', graph()));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.columns.sales.out, ['month (date)', 'amount (number)', 'site (text)']);

  const bad = value(
    await call('validate_pipeline', {
      nodes: [
        { id: 'sales', type: 'src.psDataset', config: { datasetId: ds } },
        { id: 'f', type: 'tf.filter', config: { column: 'nope', operator: '>', value: '1' } },
      ],
      edges: [{ from: 'sales', to: 'f' }],
    })
  );
  assert.equal(bad.ok, false);
  const problem = bad.checks.find((c) => c.node_id === 'f');
  assert.match(problem.message, /nope/);
  assert.doesNotMatch(problem.message, /^wf\./);

  const unusable = await call('validate_pipeline', {
    nodes: [{ id: 'x', type: 'tf.magic' }],
    edges: [{ from: 'x', to: 'y' }],
  });
  assert.equal(unusable.isError, true);
  assert.match(unusable.content[0].text, /unknown type "tf\.magic"/);
  assert.match(unusable.content[0].text, /both ends/);

  // Another Terminal's dataset (or none) is a problem.
  const missing = value(
    await call('validate_pipeline', {
      nodes: [{ id: 's', type: 'src.psDataset', config: { datasetId: randomUuid() } }],
    })
  );
  assert.match(missing.checks[0].message, /not a ready dataset of this Terminal/);
});

test('test runs read the dataset as the member and write nothing', async () => {
  const run1 = value(
    await call(
      'test_pipeline',
      graph([{ id: 'store', type: 'out.psDataset', config: { datasetId: ds, mode: 'append' } }])
    )
  );
  // (the write step has no input: the run does not start)
  assert.equal(run1.status, 'not_run');

  const g = graph();
  g.nodes.push({ id: 'store', type: 'out.psDataset', config: { datasetId: ds, mode: 'append' } });
  g.edges.push({ from: 'per_site', to: 'store' });
  const out = value(await call('test_pipeline', g));
  assert.equal(out.status, 'success');
  assert.equal(out.steps.find((s) => s.node_id === 'sales').rows, 12);
  assert.equal(out.steps.find((s) => s.node_id === 'per_site').rows, 2);
  assert.match(out.steps.find((s) => s.node_id === 'store').warnings[0], /2/);
  assert.equal(out.samples.find((s) => s.node_id === 'table').rows.length, 2);
  const [{ n }] = await admin(db, `select row_count as n from ps_datasets where id = $1`, [ds]);
  assert.equal(Number(n), 12);
});

test('drafts: created, read back, changed from the revision read, never published', async () => {
  const made = value(
    await call('create_pipeline', { name: 'Sales per site', description: 'Monthly', ...graph() })
  );
  assert.equal(made.ok, true);
  assert.match(made.next, /publishes/);
  const [w] = await admin(
    db,
    `select graph, published_version_id, mcp_client from workflows where id = $1`,
    [made.id]
  );
  assert.equal(w.published_version_id, null);
  assert.equal(w.mcp_client, 'Claude');
  const src = w.graph.nodes.find((n) => n.id === 'sales');
  // The dataset's columns, as the editor stores them; laid out left to right.
  assert.deepEqual(
    src.data.config.columns.map((c) => c.name),
    ['month', 'amount', 'site']
  );
  const x = (id) => w.graph.nodes.find((n) => n.id === id).position.x;
  assert.ok(x('sales') < x('per_site') && x('per_site') < x('table'));

  const p = value(await call('get_pipeline', { pipeline_id: made.id }));
  assert.equal(p.draft_revision, made.draft_revision);
  assert.equal(p.can_change, true);
  assert.equal(p.last_changed_through_mcp.by, 'Claude');
  assert.equal(p.nodes[0].config.columns, undefined);

  const renamed = value(
    await call('update_pipeline', {
      pipeline_id: made.id,
      draft_revision: p.draft_revision,
      name: 'Sales per site (v2)',
    })
  );
  assert.notEqual(renamed.draft_revision, p.draft_revision);
  const stale = await call('update_pipeline', {
    pipeline_id: made.id,
    draft_revision: p.draft_revision,
    ...graph(),
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /changed since it was read/);

  // A moved step keeps its place when the graph is changed.
  await admin(
    db,
    `update workflows set graph = jsonb_set(graph, '{nodes,0,position}', '{"x": 999, "y": 7}') where id = $1`,
    [made.id]
  );
  const now = value(await call('get_pipeline', { pipeline_id: made.id }));
  value(
    await call('update_pipeline', {
      pipeline_id: made.id,
      draft_revision: now.draft_revision,
      ...graph(),
    })
  );
  const [after] = await admin(db, `select graph, name from workflows where id = $1`, [made.id]);
  assert.deepEqual(after.graph.nodes[0].position, { x: 999, y: 7 });
  assert.equal(after.name, 'Sales per site (v2)');
});

test('insights: a profile of every column, anomalies and a forecast per month', async () => {
  const profile = value(await call('profile_dataset', { dataset_id: ds }));
  const amount = profile.columns.find((c) => c.column === 'amount');
  assert.equal(amount.rows, 12);
  assert.ok(amount.mean > 100);
  assert.deepEqual(
    profile.columns.find((c) => c.column === 'site').top.map((t) => t.n),
    [6, 6]
  );

  const anomalies = value(
    await call('analyze_dataset', {
      dataset_id: ds,
      kind: 'anomalies',
      date_column: 'month',
      value_column: 'amount',
      period: 'month',
    })
  );
  assert.ok(anomalies.anomalies.some((a) => a.p === '2026-09-01'));
  const forecast = value(
    await call('analyze_dataset', {
      dataset_id: ds,
      kind: 'forecast',
      date_column: 'month',
      value_column: 'amount',
      horizon: 3,
    })
  );
  assert.equal(forecast.forecast.length, 3);
  assert.equal(forecast.forecast[0].p, '2027-01-01');
  const wrong = await call('analyze_dataset', {
    dataset_id: ds,
    kind: 'forecast',
    date_column: 'site',
  });
  assert.match(wrong.content[0].text, /date or timestamp/);

  // Both in the data-access log.
  const [{ n }] = await admin(
    db,
    `select count(*)::int as n from etna_platform.data_access_log where object_id = $1::text and detail->>'via' = 'mcp'`,
    [ds]
  );
  assert.equal(n, 3);
  const health = value(await call('get_terminal_health'));
  assert.equal(health.workerOnline, false);
});

function randomUuid() {
  const h = randomBytes(16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}

test('a scoped connection: only its tools are offered and callable, other data does not exist for it', async () => {
  const [{ id: other }] = await run(
    db,
    owner,
    `select ps_create_dataset($1, 'Gaji', 'HR', '', '[{"label":"amount","type":"decimal"}]'::jsonb) as id`,
    [ws]
  );
  const [{ id: pipeline }] = await run(
    db,
    owner,
    `insert into workflows (user_id, workspace_id, name, graph) values ($1, $2, 'Lain', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
    [owner.id, ws]
  );
  const scoped = {
    ...ctxFor(true),
    scope: { tools: ['list_datasets', 'preview_dataset', 'list_pipelines', 'validate_pipeline'], datasets: [ds], pipelines: [] },
  };
  assert.deepEqual(
    toolsFor(scoped).map((t) => t.name).sort(),
    ['list_datasets', 'list_pipelines', 'preview_dataset', 'validate_pipeline']
  );
  // A tool outside the scope is unknown, even called by name.
  const r = await handleMessage(
    { jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'get_pipeline', arguments: { pipeline_id: pipeline } } },
    scoped,
    toolsFor(scoped)
  );
  assert.ok(r.error || r.result?.isError);

  assert.deepEqual(value(await call('list_datasets', {}, scoped)).datasets.map((d) => d.id), [ds]);
  assert.deepEqual(value(await call('list_pipelines', {}, scoped)).pipelines, []);
  const outside = await call('preview_dataset', { dataset_id: other }, scoped);
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /not found/);
  // A graph naming a dataset outside the scope is refused before anything reads it.
  const refused = await call(
    'validate_pipeline',
    { nodes: [{ id: 'x', type: 'src.psDataset', config: { datasetId: other } }, { id: 't', type: 'out.table' }], edges: [{ from: 'x', to: 't' }] },
    scoped
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /may not use dataset/);
  assert.equal(value(await call('validate_pipeline', graph(), scoped)).ok, true);
});
