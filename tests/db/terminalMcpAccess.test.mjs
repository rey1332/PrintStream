import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let viewer;
let sales;
let ws;

const asWorker = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role etna_worker');
    return (await tx.query(sql, params)).rows;
  });
// As the auth server logs in (etna_auth): it may only look tokens up.
const asAuth = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role etna_auth');
    return (await tx.query(sql, params)).rows;
  });

const newToken = () => {
  const token = `psmcp_${randomBytes(24).toString('base64url')}`;
  return {
    token,
    hash: createHash('sha256').update(token).digest('hex'),
    prefix: token.slice(0, 12),
  };
};
const createToken = async (user, name = 'Claude', days = 90) => {
  const t = newToken();
  const [{ id }] = await run(db, user, `select ps_mcp_token_create($1, $2, $3, $4, $5) as id`, [
    ws,
    name,
    t.hash,
    t.prefix,
    days,
  ]);
  return { ...t, id };
};
const use = (hash) => asAuth(`select * from auth.mcp_token_use($1)`, [hash]);

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'mcp-owner');
  [{ id: ws }] = await run(db, owner, `select erp_create_terminal('Data team') as id`);
  const join = async (name, role) => {
    const user = await createUser(db, name);
    const [{ access_code }] = await run(
      db,
      owner,
      `select access_code from erp_create_workspace_invitation_v2($1, $2, 24, '', null)`,
      [ws, role]
    );
    await run(db, user, `select erp_redeem_workspace_invitation($1)`, [access_code]);
    return user;
  };
  // "viewer": a member who may read pipelines but not manage members.
  viewer = await join('mcp-member', 'finance');
  sales = await join('mcp-sales', 'sales');
});

test('a cancelled job says who cancelled it, and failed or cancelled jobs can be run again once', async () => {
  const [{ id }] = await run(
    db,
    owner,
    `select ps_enqueue_job($1, 'connector.test', '{"connection_id":"x"}'::jsonb) as id`,
    [ws]
  );
  await run(db, owner, `select ps_cancel_job($1)`, [id]);
  const [c] = await admin(db, `select status, cancelled_by, error_key from ps_jobs where id = $1`, [
    id,
  ]);
  assert.deepEqual(c, {
    status: 'cancelled',
    cancelled_by: owner.id,
    error_key: 'cancelled_by_user',
  });

  const [{ id: retry }] = await run(db, owner, `select ps_retry_job($1) as id`, [id]);
  const [r] = await admin(
    db,
    `select status, kind, payload, retry_of, created_by from ps_jobs where id = $1`,
    [retry]
  );
  assert.deepEqual(r, {
    status: 'queued',
    kind: 'connector.test',
    payload: { connection_id: 'x' },
    retry_of: id,
    created_by: owner.id,
  });
  // Asking again while that retry waits returns the same one.
  assert.equal((await run(db, owner, `select ps_retry_job($1) as id`, [id]))[0].id, retry);
  // A queued job is not retried, nor a kind that is not simply repeatable.
  await expectError(run(db, owner, `select ps_retry_job($1)`, [retry]), /cannot be run again/);
  const [{ id: commit }] = await run(
    db,
    owner,
    `select ps_enqueue_job($1, 'import.commit', '{}'::jsonb) as id`,
    [ws]
  );
  await run(db, owner, `select ps_cancel_job($1)`, [commit]);
  await expectError(run(db, owner, `select ps_retry_job($1)`, [commit]), /cannot be run again/);
  // Someone who may not start such a job may not retry it either.
  await expectError(run(db, sales, `select ps_retry_job($1)`, [id]), /not allowed|not found/i);
});

test("the worker's last report is visible, nothing more", async () => {
  assert.equal((await run(db, viewer, `select ps_worker_last_seen() as s`))[0].s, null);
  await asWorker(`select ps_worker.heartbeat_worker('w1', '1.0', 0)`);
  const [{ s }] = await run(db, viewer, `select ps_worker_last_seen() as s`);
  assert.ok(s instanceof Date && Date.now() - s.getTime() < 60_000);
});

test('MCP tokens: created by members, stored as a hash, looked up only by the auth server', async () => {
  const mine = await createToken(viewer, 'Claude Desktop');
  const [stored] = await admin(db, `select token_hash, aal from ps_mcp_tokens where id = $1`, [
    mine.id,
  ]);
  assert.equal(stored.token_hash, mine.hash);
  assert.notEqual(stored.token_hash, mine.token);
  assert.equal(stored.aal, 'aal2');

  // Nobody reads the table directly; the list never shows the hash.
  await expectError(run(db, viewer, `select * from ps_mcp_tokens`), /permission denied/);
  const [row] = await run(db, viewer, `select * from ps_mcp_token_list($1)`, [ws]);
  assert.equal(row.name, 'Claude Desktop');
  assert.equal(row.token_prefix, mine.prefix);
  assert.equal('token_hash' in row, false);
  // The owner (members) sees everyone's; the viewer only their own.
  await createToken(owner, 'Owner laptop');
  assert.equal((await run(db, owner, `select * from ps_mcp_token_list($1)`, [ws])).length, 2);
  assert.equal((await run(db, viewer, `select * from ps_mcp_token_list($1)`, [ws])).length, 1);

  // Only the auth server role may look a token up; it counts the use.
  await expectError(
    run(db, viewer, `select * from auth.mcp_token_use($1)`, [mine.hash]),
    /permission denied/
  );
  const [hit] = await use(mine.hash);
  assert.deepEqual([hit.user_id, hit.workspace_id, hit.aal], [viewer.id, ws, 'aal2']);
  assert.equal((await use(newToken().hash)).length, 0);
  assert.equal(
    (await admin(db, `select use_count from ps_mcp_tokens where id = $1`, [mine.id]))[0].use_count,
    1
  );

  // Bounds.
  await expectError(createToken(viewer, '  '), /Name the token/);
  await expectError(createToken(viewer, 'x', 400), /1 to 365 days/);
  const stranger = await createUser(db, 'mcp-stranger');
  await expectError(
    run(db, stranger, `select ps_mcp_token_create($1, 'x', $2, 'psmcp_abcd', 30)`, [
      ws,
      newToken().hash,
    ]),
    /not allowed/
  );
});

test('MCP tokens stop working when revoked, expired, or when the member leaves', async () => {
  const a = await createToken(viewer, 'revoke me');
  await run(db, viewer, `select ps_mcp_token_revoke($1)`, [a.id]);
  assert.equal((await use(a.hash)).length, 0);

  const b = await createToken(viewer, 'expire me');
  await admin(
    db,
    `update ps_mcp_tokens set created_at = now() - interval '2 days', expires_at = now() - interval '1 second' where id = $1`,
    [b.id]
  );
  assert.equal((await use(b.hash)).length, 0);

  // The owner revokes anyone's token (members); a viewer cannot revoke the owner's.
  const c = await createToken(viewer, 'owner revokes');
  await run(db, owner, `select ps_mcp_token_revoke($1)`, [c.id]);
  assert.equal((await use(c.hash)).length, 0);
  const o = await createToken(owner, 'not yours');
  await expectError(run(db, viewer, `select ps_mcp_token_revoke($1)`, [o.id]), /not found/);

  const d = await createToken(viewer, 'leave');
  assert.equal((await use(d.hash)).length, 1);
  await admin(
    db,
    `update erp_workspace_members set status = 'removed' where workspace_id = $1 and user_id = $2`,
    [ws, viewer.id]
  );
  assert.equal((await use(d.hash)).length, 0);
  await admin(
    db,
    `update erp_workspace_members set status = 'active' where workspace_id = $1 and user_id = $2`,
    [ws, viewer.id]
  );
});

test('rollback removes tokens, retries and the worker report', async () => {
  const d = await createDb();
  await d.exec(
    readFileSync(
      new URL(
        '../../db/rollback/rollback_20261012000055_terminal_jobs_health_mcp.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  const [{ t }] = await admin(d, `select to_regclass('public.ps_mcp_tokens') as t`);
  assert.equal(t, null);
  const [{ n }] = await admin(
    d,
    `select count(*)::int as n from information_schema.columns where table_name = 'ps_jobs' and column_name in ('retry_of', 'cancelled_by')`
  );
  assert.equal(n, 0);
  const u = await createUser(d, 'mcp-rb');
  const [{ workspace_id: w }] = await run(
    d,
    u,
    `select workspace_id from erp_my_workspaces() where is_personal`
  );
  await run(d, u, `select erp_set_terminal($1, true)`, [w]);
  const [{ id }] = await run(
    d,
    u,
    `select ps_enqueue_job($1, 'import.analyze', '{}'::jsonb) as id`,
    [w]
  );
  assert.equal((await run(d, u, `select ps_cancel_job($1) as s`, [id]))[0].s, 'cancelled');
});
