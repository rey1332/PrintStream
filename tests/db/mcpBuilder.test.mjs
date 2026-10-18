import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

// MCP connections that may build pipelines (20261012000057): drafts only,
// as the member, only when the connection was allowed to write.

let db;
let owner;
let member;
let ws;

const hash = (v) => createHash('sha256').update(v).digest('hex');
const secret = (p) => `${p}${randomBytes(32).toString('base64url')}`;
const s256 = (v) => createHash('sha256').update(v).digest('base64url');
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const GRAPH = JSON.stringify({
  nodes: [
    {
      id: 'a',
      type: 'workflowNode',
      position: { x: 0, y: 0 },
      data: { type: 'tf.limit', label: 'Limit', config: { n: 5 } },
    },
  ],
  edges: [],
});

const asAuth = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role etna_auth');
    return (await tx.query(sql, params)).rows;
  });

async function token(user, canWrite, name = 'Claude') {
  const value = secret('psmcp_');
  const [{ id }] = await run(
    db,
    user,
    `select ps_mcp_token_create_v2($1, $2, $3, $4, 30, $5) as id`,
    [ws, name, hash(value), value.slice(0, 12), canWrite]
  );
  return { id, value };
}
const create = (user, tokenId, name = 'Dari Claude', graph = GRAPH) =>
  run(db, user, `select * from ps_mcp_pipeline_create($1, $2, $3, 'Draf', $4::jsonb)`, [
    tokenId,
    ws,
    name,
    graph,
  ]).then((r) => r[0]);
const update = (user, tokenId, id, expected, graph = GRAPH, name = null) =>
  run(db, user, `select ps_mcp_pipeline_update($1, $2, $3, $4::jsonb, $5) as at`, [
    tokenId,
    id,
    expected,
    graph,
    name,
  ]).then((r) => r[0].at);

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'builder-owner');
  [{ id: ws }] = await run(db, owner, `select erp_create_terminal('Data tambang') as id`);
  member = await createUser(db, 'builder-member');
  const [{ access_code }] = await run(
    db,
    owner,
    `select access_code from erp_create_workspace_invitation_v2($1, 'finance', 24, '', null)`,
    [ws]
  );
  await run(db, member, `select erp_redeem_workspace_invitation($1)`, [access_code]);
});

test('a token allowed to write creates a draft pipeline, marked as built through MCP', async () => {
  const t = await token(member, true, 'Claude Desktop');
  const [listed] = await run(db, member, `select * from ps_mcp_token_list_v2($1)`, [ws]);
  assert.equal(listed.can_write, true);
  const [use] = await asAuth(`select * from auth.mcp_token_use_v2($1)`, [hash(t.value)]);
  assert.equal(use.can_write, true);
  assert.equal(use.client_name, 'Claude Desktop');

  const made = await create(member, t.id);
  const [w] = await admin(
    db,
    `select user_id, workspace_id, name, description, mcp_client, mcp_token_id, published_version_id, mcp_edited_at is not null as marked
       from workflows where id = $1`,
    [made.id]
  );
  assert.deepEqual(w, {
    user_id: member.id,
    workspace_id: ws,
    name: 'Dari Claude',
    description: 'Draf',
    mcp_client: 'Claude Desktop',
    mcp_token_id: t.id,
    published_version_id: null,
    marked: true,
  });
});

test('a read-only token, another member’s token, a revoked token: no writes', async () => {
  const readOnly = await token(member, false);
  await expectError(create(member, readOnly.id), /may not write/);
  const [use] = await asAuth(`select * from auth.mcp_token_use_v2($1)`, [hash(readOnly.value)]);
  assert.equal(use.can_write, false);

  const ownerToken = await token(owner, true);
  await expectError(create(member, ownerToken.id), /may not write/);

  const revoked = await token(member, true);
  await run(db, member, `select ps_mcp_token_revoke($1)`, [revoked.id]);
  await expectError(create(member, revoked.id), /may not write/);
});

test('the draft changes only from the version read, only the member’s own, never published', async () => {
  const t = await token(member, true);
  const made = await create(member, t.id, 'Penjualan');
  const expected = made.updated_at;
  const changed = JSON.stringify({ nodes: [], edges: [] });
  const saved = await update(member, t.id, made.id, expected, changed, 'Penjualan v2');
  assert.ok(new Date(saved) > new Date(expected) || saved !== expected);
  // The same version again: someone (or it) saved since.
  await expectError(update(member, t.id, made.id, expected, changed), /changed since/);
  const [w] = await admin(
    db,
    `select name, graph, published_version_id from workflows where id = $1`,
    [made.id]
  );
  assert.deepEqual(
    [w.name, w.graph, w.published_version_id],
    ['Penjualan v2', { nodes: [], edges: [] }, null]
  );

  // The owner's own pipeline: the member's assistant may read it, not change it.
  const ownerToken = await token(owner, true);
  const theirs = await create(owner, ownerToken.id, 'Milik owner');
  await expectError(update(member, t.id, theirs.id, theirs.updated_at), /Only pipelines you made/);
});

test('graphs that are not graphs, or too large, are refused', async () => {
  const t = await token(member, true);
  await expectError(create(member, t.id, 'x', '{"nodes": {}}'), /Invalid pipeline graph/);
  const many = JSON.stringify({
    nodes: Array.from({ length: 101 }, (_, i) => ({ id: `n${i}` })),
    edges: [],
  });
  await expectError(create(member, t.id, 'x', many), /Invalid pipeline graph/);
  await expectError(create(member, t.id, '  '), /Name the pipeline/);
});

test('signing in with OAuth: writing is allowed only when the member said so on the consent page', async () => {
  const clientId = secret('mcpc_');
  await asAuth(`select auth.oauth_register($1, 'Claude', $2, null)`, [clientId, [REDIRECT]]);
  const connect = async (canWrite) => {
    const verifier = randomBytes(32).toString('base64url');
    const code = secret('psmco_');
    await run(db, member, `select ps_oauth_approve_v2($1, $2, $3, $4, $5, $6)`, [
      clientId,
      REDIRECT,
      s256(verifier),
      ws,
      hash(code),
      canWrite,
    ]);
    const access = secret('psmcp_');
    const [{ e }] = await asAuth(
      `select auth.oauth_exchange_code($1, $2, null, $3, $4, $5, $6, $7) as e`,
      [
        hash(code),
        clientId,
        REDIRECT,
        s256(verifier),
        hash(access),
        access.slice(0, 12),
        hash(secret('psmcr_')),
      ]
    );
    assert.equal(e, null);
    return (await asAuth(`select * from auth.mcp_token_use_v2($1)`, [hash(access)]))[0];
  };
  const reader = await connect(false);
  const writer = await connect(true);
  assert.equal(reader.can_write, false);
  assert.equal(writer.can_write, true);
  await expectError(create(member, reader.token_id), /may not write/);
  assert.ok((await create(member, writer.token_id, 'Lewat OAuth')).id);
  const apps = await run(
    db,
    member,
    `select can_write from ps_oauth_grant_list_v2($1) order by created_at`,
    [ws]
  );
  assert.deepEqual(
    apps.map((a) => a.can_write),
    [false, true]
  );

  // Revoking the connection ends its writes too.
  const [grant] = await admin(db, `select grant_id from ps_mcp_tokens where id = $1`, [
    writer.token_id,
  ]);
  await run(db, member, `select ps_oauth_grant_revoke($1)`, [grant.grant_id]);
  await expectError(create(member, writer.token_id), /may not write/);
});
