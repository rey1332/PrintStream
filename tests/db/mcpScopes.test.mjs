import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';
import { MCP_TOOLS } from '../../src/server/mcp/tools.ts';
import { MCP_TOOL_NAMES, MCP_WRITE_TOOLS } from '../../src/lib/terminal/mcpScope.ts';

// Which tools and data an MCP connection may use (20261012000060).

let db;
let owner;
let ws;
let other;
let dsA;
let dsB;

const hash = (v) => createHash('sha256').update(v).digest('hex');
const secret = (p) => `${p}${randomBytes(32).toString('base64url')}`;
const s256 = (v) => createHash('sha256').update(v).digest('base64url');
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const graph = (datasetId = null) =>
  JSON.stringify({
    nodes: [
      {
        id: 'a',
        type: 'workflowNode',
        position: { x: 0, y: 0 },
        data: datasetId
          ? { type: 'src.psDataset', label: 'Data', config: { datasetId } }
          : { type: 'tf.limit', label: 'Limit', config: { n: 5 } },
      },
    ],
    edges: [],
  });

const asAuth = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role etna_auth');
    return (await tx.query(sql, params)).rows;
  });

async function token(canWrite, scope) {
  const value = secret('psmcp_');
  const [{ id }] = await run(
    db,
    owner,
    `select ps_mcp_token_create_v3($1, 'Claude', $2, $3, 30, $4, $5::jsonb) as id`,
    [ws, hash(value), value.slice(0, 12), canWrite, scope === undefined ? null : JSON.stringify(scope)]
  );
  return { id, value };
}
const used = async (value) => (await asAuth(`select * from auth.mcp_token_use_v3($1)`, [hash(value)]))[0];
const create = (tokenId, g = graph()) =>
  run(db, owner, `select * from ps_mcp_pipeline_create($1, $2, 'Dari Claude', 'Draf', $3::jsonb)`, [tokenId, ws, g]).then(
    (r) => r[0]
  );

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'scope-owner');
  [{ id: ws }] = await run(db, owner, `select erp_create_terminal('Data tambang') as id`);
  [{ id: other }] = await run(db, owner, `select erp_create_terminal('Lain') as id`);
  const cols = JSON.stringify([{ label: 'tonnes', type: 'decimal' }]);
  [{ id: dsA }] = await run(db, owner, `select ps_create_dataset($1, 'Ritase', 'Ops', '', $2::jsonb) as id`, [ws, cols]);
  [{ id: dsB }] = await run(db, owner, `select ps_create_dataset($1, 'Gaji', 'HR', '', $2::jsonb) as id`, [ws, cols]);
});

test('the tool lists agree: server, access page and database', async () => {
  const server = MCP_TOOLS.map((t) => t.name).sort();
  assert.deepEqual([...MCP_TOOL_NAMES].sort(), server);
  assert.deepEqual(MCP_TOOLS.filter((t) => t.write).map((t) => t.name).sort(), [...MCP_WRITE_TOOLS].sort());
  const [{ tools }] = await admin(db, `select ps_mcp__tools() as tools`);
  assert.deepEqual([...tools].sort(), server);
});

test('a token keeps its scope, normalised; no scope means everything', async () => {
  const all = await token(false);
  assert.equal((await used(all.value)).scope, null);
  const some = await token(false, { tools: ['preview_dataset', 'list_datasets', 'list_datasets'], datasets: [dsA] });
  assert.deepEqual((await used(some.value)).scope, {
    tools: ['list_datasets', 'preview_dataset'],
    datasets: [dsA],
    pipelines: null,
  });
  const [listed] = (await run(db, owner, `select scope from ps_mcp_token_list_v3($1) where id = $2`, [ws, some.id]));
  assert.deepEqual(listed.scope.datasets, [dsA]);
});

test('scopes are checked: known tools, writing tools only when writing, data of this Terminal', async () => {
  await expectError(token(false, { tools: [] }), /at least one tool/);
  await expectError(token(false, { tools: ['drop_everything'] }), /Unknown tool/);
  await expectError(token(false, { tools: ['create_pipeline'] }), /may not build pipelines/);
  await expectError(token(false, { tools: 'all' }), /Invalid access scope/);
  await expectError(token(false, { datasets: ['not-a-uuid'] }), /Invalid access scope/);
  await expectError(token(false, { secrets: [] }), /Invalid access scope/);
  const [{ id: foreign }] = await run(db, owner, `select ps_create_dataset($1, 'X', '', '', '[{"label":"a","type":"text"}]'::jsonb) as id`, [other]);
  await expectError(token(false, { datasets: [foreign] }), /not in this Terminal/);
  await expectError(token(false, { pipelines: [dsA] }), /not in this Terminal/);
});

test('the owner changes a token scope later; nobody else can', async () => {
  const t = await token(true);
  await run(db, owner, `select ps_mcp_token_set_scope($1, $2::jsonb)`, [t.id, JSON.stringify({ tools: ['create_pipeline', 'list_pipelines'] })]);
  assert.deepEqual((await used(t.value)).scope.tools, ['create_pipeline', 'list_pipelines']);
  await run(db, owner, `select ps_mcp_token_set_scope($1, null)`, [t.id]);
  assert.equal((await used(t.value)).scope, null);
  const stranger = await createUser(db, 'scope-stranger');
  await expectError(run(db, stranger, `select ps_mcp_token_set_scope($1, null)`, [t.id]), /not found/);
});

test('writes check the tool, the pipeline and every dataset; created pipelines join the list', async () => {
  const noCreate = await token(true, { tools: ['update_pipeline'] });
  await expectError(create(noCreate.id), /may not use create_pipeline/);

  const limited = await token(true, { tools: ['create_pipeline', 'update_pipeline'], datasets: [dsA], pipelines: [] });
  await expectError(create(limited.id, graph(dsB)), /may not use dataset/);
  const made = await create(limited.id, graph(dsA));
  assert.deepEqual((await used(limited.value)).scope.pipelines, [made.id]);
  const at = (await run(db, owner, `select ps_mcp_pipeline_update($1, $2, $3, $4::jsonb) as at`, [limited.id, made.id, made.updated_at, graph(dsA)]))[0].at;
  assert.ok(at);

  // A pipeline outside the list is "not found" to this connection.
  const all = await token(true);
  const elsewhere = await create(all.id);
  await expectError(
    run(db, owner, `select ps_mcp_pipeline_update($1, $2, $3, $4::jsonb)`, [limited.id, elsewhere.id, elsewhere.updated_at, graph()]),
    /Pipeline not found/
  );
});

test('a connected app carries its scope from consent to every access token, and follows changes', async () => {
  const app = `mcpc_${randomBytes(16).toString('hex')}`;
  await asAuth(`select auth.oauth_register($1, 'Claude', $2, null)`, [app, [REDIRECT]]);
  const verifier = secret('');
  const code = secret('psoc_');
  await run(db, owner, `select ps_oauth_approve_v3($6, $1, $2, $3, $4, false, $5::jsonb)`, [
    REDIRECT, s256(verifier), ws, hash(code), JSON.stringify({ tools: ['list_datasets'], datasets: [dsA] }), app,
  ]);
  const access = secret('psmcp_');
  const [{ r }] = await asAuth(`select auth.oauth_exchange_code($1, $7, null, $2, $3, $4, $5, $6) as r`, [
    hash(code), REDIRECT, s256(verifier), hash(access), access.slice(0, 12), hash(secret('psrt_')), app,
  ]);
  assert.equal(r, null);
  assert.deepEqual((await used(access)).scope.tools, ['list_datasets']);
  const [{ id: grant, scope }] = await run(db, owner, `select id, scope from ps_oauth_grant_list_v3($1)`, [ws]);
  assert.deepEqual(scope.datasets, [dsA]);
  await run(db, owner, `select ps_oauth_grant_set_scope($1, $2::jsonb)`, [grant, JSON.stringify({ tools: ['preview_dataset'] })]);
  assert.deepEqual((await used(access)).scope.tools, ['preview_dataset']);
  await expectError(run(db, owner, `select ps_oauth_grant_set_scope($1, $2::jsonb)`, [grant, JSON.stringify({ tools: ['update_pipeline'] })]), /may not build/);
});

test('the scope functions are not callable by members', async () => {
  await expectError(run(db, owner, `select ps_mcp__scope_clean($1, null, true)`, [ws]), /permission denied/);
  await expectError(run(db, owner, `select ps_mcp__check_scope(null, 'x', null)`), /permission denied/);
});

test('rollback removes scopes', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000060_mcp_scopes.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(
    `select to_regprocedure('auth.mcp_token_use_v3(text)') is null as gone,
            not exists (select 1 from information_schema.columns where table_name = 'ps_mcp_tokens' and column_name = 'mcp_scope') as no_column,
            to_regprocedure('public.ps_mcp_pipeline_create(uuid,uuid,text,text,jsonb)') is not null as create_kept`
  );
  assert.deepEqual(rows[0], { gone: true, no_column: true, create_kept: true });
  await d.close();
});
