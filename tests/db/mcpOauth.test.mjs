import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let member;
let ws;

const asAuth = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role etna_auth');
    return (await tx.query(sql, params)).rows;
  });
const hash = (v) => createHash('sha256').update(v).digest('hex');
const secret = (p) => `${p}${randomBytes(32).toString('base64url')}`;
const s256 = (v) => createHash('sha256').update(v).digest('base64url');
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function register(secretHash = null) {
  const id = secret('mcpc_');
  await asAuth(`select auth.oauth_register($1, 'Claude', $2, $3)`, [id, [REDIRECT], secretHash]);
  return id;
}
async function approve(user, clientId, verifier) {
  const code = secret('psmco_');
  await run(db, user, `select ps_oauth_approve($1, $2, $3, $4, $5)`, [
    clientId,
    REDIRECT,
    s256(verifier),
    ws,
    hash(code),
  ]);
  return code;
}
const exchange = (clientId, code, verifier, { redirect = REDIRECT, secretHash = null } = {}) => {
  const access = secret('psmcp_');
  const refresh = secret('psmcr_');
  return asAuth(`select auth.oauth_exchange_code($1, $2, $3, $4, $5, $6, $7, $8) as e`, [
    hash(code),
    clientId,
    secretHash,
    redirect,
    s256(verifier),
    hash(access),
    access.slice(0, 12),
    hash(refresh),
  ]).then((r) => ({ error: r[0].e, access, refresh }));
};
const refreshWith = (clientId, refresh) => {
  const access = secret('psmcp_');
  const next = secret('psmcr_');
  return asAuth(`select auth.oauth_refresh($1, $2, null, $3, $4, $5) as e`, [
    hash(refresh),
    clientId,
    hash(access),
    access.slice(0, 12),
    hash(next),
  ]).then((r) => ({ error: r[0].e, access, refresh: next }));
};
const use = (token) => asAuth(`select * from auth.mcp_token_use($1)`, [hash(token)]);

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'oauth-owner');
  [{ id: ws }] = await run(db, owner, `select erp_create_terminal('Data tambang') as id`);
  member = await createUser(db, 'oauth-member');
  const [{ access_code }] = await run(
    db,
    owner,
    `select access_code from erp_create_workspace_invitation_v2($1, 'finance', 24, '', null)`,
    [ws]
  );
  await run(db, member, `select erp_redeem_workspace_invitation($1)`, [access_code]);
});

test('sign in, approve, exchange the code (PKCE), call with the access token, refresh', async () => {
  const client = await register();
  const [info] = await run(db, member, `select * from ps_oauth_client_get($1, $2)`, [
    client,
    REDIRECT,
  ]);
  assert.deepEqual(info, { client_id: client, name: 'Claude', redirect_ok: true });
  assert.equal(
    (
      await run(db, member, `select * from ps_oauth_client_get($1, 'https://evil.example/cb')`, [
        client,
      ])
    )[0].redirect_ok,
    false
  );

  const verifier = randomBytes(32).toString('base64url');
  const code = await approve(member, client, verifier);
  const first = await exchange(client, code, verifier);
  assert.equal(first.error, null);
  const [who] = await use(first.access);
  assert.deepEqual([who.user_id, who.workspace_id, who.aal], [member.id, ws, 'aal2']);

  // The connection is listed (and not among the personal tokens).
  const [app] = await run(db, member, `select * from ps_oauth_grant_list($1)`, [ws]);
  assert.equal(app.client_name, 'Claude');
  assert.equal(app.redirect_host, 'claude.ai');
  assert.equal((await run(db, member, `select * from ps_mcp_token_list($1)`, [ws])).length, 0);

  // Refresh: a new pair; the access token keeps working, the old refresh token must not be reused.
  const second = await refreshWith(client, first.refresh);
  assert.equal(second.error, null);
  assert.equal((await use(second.access)).length, 1);
  const replay = await refreshWith(client, first.refresh);
  assert.equal(replay.error, 'invalid_grant');
  // Reuse of a rotated refresh token ends the whole connection.
  assert.equal((await use(second.access)).length, 0);
  assert.equal((await refreshWith(client, second.refresh)).error, 'invalid_grant');
  const [ended] = await admin(
    db,
    `select revoke_reason from ps_oauth_grants where client_id = $1`,
    [client]
  );
  assert.equal(ended.revoke_reason, 'reused');
});

test('a code works once, only with its verifier, client and redirect address, for 10 minutes', async () => {
  const client = await register();
  const other = await register();
  const verifier = randomBytes(32).toString('base64url');

  let code = await approve(member, client, verifier);
  assert.equal(
    (await exchange(client, code, randomBytes(32).toString('base64url'))).error,
    'invalid_grant'
  );
  assert.equal((await exchange(other, code, verifier)).error, 'invalid_grant');
  assert.equal(
    (await exchange(client, code, verifier, { redirect: 'https://claude.ai/other' })).error,
    'invalid_grant'
  );

  code = await approve(member, client, verifier);
  const ok = await exchange(client, code, verifier);
  assert.equal(ok.error, null);
  // The same code again: refused, and the connection it made ends.
  assert.equal((await exchange(client, code, verifier)).error, 'invalid_grant');
  assert.equal((await use(ok.access)).length, 0);

  code = await approve(member, client, verifier);
  await admin(
    db,
    `update ps_oauth_codes set expires_at = now() - interval '1 second' where code_hash = $1`,
    [hash(code)]
  );
  assert.equal((await exchange(client, code, verifier)).error, 'invalid_grant');
});

test('confidential clients need their secret; approving needs pipelines.view in the Terminal', async () => {
  const s = secret('mcps_');
  const client = await register(hash(s));
  const verifier = randomBytes(32).toString('base64url');
  const code = await approve(member, client, verifier);
  assert.equal((await exchange(client, code, verifier)).error, 'invalid_client');
  assert.equal((await exchange(client, code, verifier, { secretHash: hash(s) })).error, null);

  const stranger = await createUser(db, 'oauth-stranger');
  await expectError(approve(stranger, client, verifier), /not allowed/);
  await expectError(
    run(db, member, `select ps_oauth_approve($1, 'https://evil.example/cb', $2, $3, $4)`, [
      client,
      s256(verifier),
      ws,
      hash('x'.repeat(10)),
    ]),
    /Unknown client or redirect/
  );
  // Only the auth server role registers clients and exchanges codes.
  await expectError(
    run(db, member, `select auth.oauth_register('mcpc_${'a'.repeat(30)}', 'x', $1, null)`, [
      [REDIRECT],
    ]),
    /permission denied/
  );
});

test('revoking, or leaving the Terminal, ends the connection', async () => {
  const client = await register();
  const verifier = randomBytes(32).toString('base64url');
  const a = await exchange(client, await approve(member, client, verifier), verifier);
  const [{ id: grant }] = await run(
    db,
    member,
    `select id from ps_oauth_grant_list($1) where revoked_at is null`,
    [ws]
  );
  await run(db, owner, `select ps_oauth_grant_revoke($1)`, [grant]);
  assert.equal((await use(a.access)).length, 0);
  assert.equal((await refreshWith(client, a.refresh)).error, 'invalid_grant');

  const b = await exchange(client, await approve(member, client, verifier), verifier);
  await admin(
    db,
    `update erp_workspace_members set status = 'removed' where workspace_id = $1 and user_id = $2`,
    [ws, member.id]
  );
  assert.equal((await use(b.access)).length, 0);
  assert.equal((await refreshWith(client, b.refresh)).error, 'invalid_grant');
  await admin(
    db,
    `update erp_workspace_members set status = 'active' where workspace_id = $1 and user_id = $2`,
    [ws, member.id]
  );
});

test('rollback removes connected apps and keeps personal tokens', async () => {
  const d = await createDb();
  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261012000056_mcp_oauth.sql', import.meta.url),
      'utf8'
    )
  );
  const [{ t }] = await admin(d, `select to_regclass('public.ps_oauth_grants') as t`);
  assert.equal(t, null);
  const [{ f }] = await admin(
    d,
    `select to_regprocedure('auth.mcp_token_use(text)') is not null as f`
  );
  assert.equal(f, true);
});
