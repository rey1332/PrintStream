import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let ws;
let conn;

const SECRET = 'v1:aXY=:dGFn:Y2lwaGVy';
const COLUMNS = JSON.stringify([
  { label: 'id', type: 'integer', key: true },
  { label: 'customer.name', type: 'text' },
]);
const endpoint = (extra = {}) =>
  JSON.stringify({
    mode: 'rest',
    method: 'GET',
    path: '/v1/customers',
    query: [],
    records: 'data',
    pagination: { style: 'none' },
    key: 'id',
    ...extra,
  });

const asWorker = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role etna_worker');
    return (await tx.query(sql, params)).rows;
  });

// A platform admin's request: role authenticated, a two-factor session.
async function asAdmin(who, sql, params = [], fresh = true) {
  const [{ id: sid }] = await admin(
    db,
    `insert into auth.sessions (user_id, token_hash, aal, expires_at, reauthenticated_at)
     values ($1, md5(random()::text), 'aal2', now() + interval '1 day', case when $2 then now() end) returning id`,
    [who.id, fresh]
  );
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who.id]);
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: who.id, email: who.email, role: 'authenticated', aal: 'aal2', sid }),
    ]);
    return (await tx.query(sql, params)).rows;
  });
}

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'rest-owner');
  [{ workspace_id: ws }] = await run(
    db,
    owner,
    `select workspace_id from erp_my_workspaces() where is_personal`
  );
  await run(db, owner, `select erp_set_terminal($1, true)`, [ws]);
  [{ id: conn }] = await run(
    db,
    owner,
    `select ps_save_connection($1, null, 'rest', 'Toko API', '{"base_url":"https://api.example.com","auth":"bearer"}'::jsonb, $2) as id`,
    [ws, SECRET]
  );
});

test('a REST API connection syncs endpoints, each into its own dataset', async () => {
  const create = (who, source, name) =>
    run(
      db,
      who,
      `select ps_create_source_sync($1, $2::jsonb, 'GET /v1/customers', $3, $4::jsonb) as id`,
      [conn, source, name, COLUMNS]
    );
  const [{ id: a }] = await create(owner, endpoint(), 'Customers');
  const [{ id: b }] = await create(
    owner,
    endpoint({ path: '/v1/customers', query: [['active', '1']] }),
    'Active customers'
  );
  assert.notEqual(a, b);
  const [row] = await run(
    db,
    owner,
    `select s.object, s.source ->> 'path' as path, d.folder from ps_syncs s join ps_datasets d on d.id = s.dataset_id where s.id = $1`,
    [a]
  );
  assert.deepEqual(row, { object: 'rest', path: '/v1/customers', folder: 'Toko API' });
  // Database modes are not REST sources, and an endpoint names its path and method.
  await expectError(
    create(owner, JSON.stringify({ mode: 'table', schema: 'public', table: 'x' }), 'X'),
    /Not a source of this connection/
  );
  await expectError(create(owner, endpoint({ path: 'v1' }), 'X2'), /names its method and path/);
  await expectError(
    create(owner, endpoint({ method: 'DELETE' }), 'X3'),
    /names its method and path/
  );
});

test('POST as query needs the manage permission and two-factor', async () => {
  const post = endpoint({ method: 'POST', path: '/v1/search', body: '{}' });
  await expectError(
    run(
      db,
      { ...owner, aal: 'aal1' },
      `select ps_create_source_sync($1, $2::jsonb, 'POST /v1/search', 'Search', $3::jsonb)`,
      [conn, post, COLUMNS]
    ),
    /two-factor/
  );
  // A GET is enough with a one-factor session (integrations.use).
  await run(
    db,
    { ...owner, aal: 'aal1' },
    `select ps_create_source_sync($1, $2::jsonb, 'GET', 'Plain', $3::jsonb)`,
    [conn, endpoint(), COLUMNS]
  );
  const [{ id }] = await run(
    db,
    owner,
    `select ps_create_source_sync($1, $2::jsonb, 'POST /v1/search', 'Search', $3::jsonb) as id`,
    [conn, post, COLUMNS]
  );
  const [audit] = (
    await db.query(
      `select details -> 'source' ->> 'method' as m from erp_workspace_audit_log where workspace_id = $1 and action = 'sync.added' and details ->> 'sync_id' = $2`,
      [ws, id]
    )
  ).rows;
  assert.equal(audit.m, 'POST');
});

test('tunnels: a host:port allowed for one company only, by super admins with two-factor', async () => {
  const sa = await createUser(db, 'rest-sa');
  await admin(db, `select etna_admin.grant_platform_admin($1, 'super_admin')`, [sa.email]);
  const support = await createUser(db, 'rest-support');
  await admin(db, `select etna_admin.grant_platform_admin($1, 'support')`, [support.email]);

  const add = (who, host, fresh = true) =>
    asAdmin(
      who,
      `select etna_platform.admin_add_network_allow($1, $2, 'SAP via Cloudflare Tunnel') as id`,
      [ws, host],
      fresh
    );
  await expectError(add(support, '10.20.0.5:50000'), /Not allowed/);
  await expectError(add(sa, '10.20.0.5'), /host and port/);
  await expectError(add(sa, '127.0.0.1:8080'), /never allowed/);
  await expectError(add(sa, 'localhost:8080'), /never allowed/);
  await expectError(add(sa, '10.20.0.5:70000'), /host and port/);
  const [{ id }] = await add(sa, '10.20.0.5:50000');
  await expectError(add(sa, '10.20.0.5:50000'), /duplicate|unique/);

  // The company's connections get it next to the platform-wide list; others do not.
  const [{ c }] = await asWorker(`select ps_worker.connection_get($1) as c`, [conn]);
  assert.deepEqual(c.private_hosts, ['10.20.0.5:50000']);
  const other = await createUser(db, 'rest-other');
  const [{ workspace_id: ws2 }] = await run(
    db,
    other,
    `select workspace_id from erp_my_workspaces() where is_personal`
  );
  await run(db, other, `select erp_set_terminal($1, true)`, [ws2]);
  const [{ id: conn2 }] = await run(
    db,
    other,
    `select ps_save_connection($1, null, 'rest', 'Other', '{"base_url":"https://x.example.com","auth":"none"}'::jsonb, null) as id`,
    [ws2]
  );
  assert.deepEqual(
    (await asWorker(`select ps_worker.connection_get($1) as c`, [conn2]))[0].c.private_hosts,
    []
  );

  const [{ l }] = await asAdmin(support, `select etna_platform.admin_network_allowlist() as l`);
  assert.equal(l.length, 1);
  assert.equal(l[0].host, '10.20.0.5:50000');
  // Members of the company cannot see or change the list.
  await expectError(
    run(db, owner, `select * from etna_platform.network_allowlist`),
    /permission denied/
  );
  await expectError(
    run(db, owner, `select etna_platform.admin_remove_network_allow($1)`, [id]),
    /Not allowed|permission/
  );
  await asAdmin(sa, `select etna_platform.admin_remove_network_allow($1)`, [id]);
  const [{ n }] = await admin(
    db,
    `select count(*)::int as n from etna_platform.security_events where event_type like 'NETWORK_ALLOW_%'`
  );
  assert.equal(n, 2);
});

test('rollback removes REST connections and tunnel entries', async () => {
  const d = await createDb();
  await d.exec(
    readFileSync(
      new URL(
        '../../db/rollback/rollback_20261012000046_terminal_rest_tunnels.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  const { rows } = await d.query(
    `select to_regclass('etna_platform.network_allowlist') is null as table_gone,
            to_regprocedure('etna_platform.admin_add_network_allow(uuid,text,text)') is null as fn_gone,
            pg_get_constraintdef(oid) as kinds
       from pg_constraint where conname = 'ps_connections_kind_check'`
  );
  assert.equal(rows[0].table_gone, true);
  assert.equal(rows[0].fn_gone, true);
  assert.doesNotMatch(rows[0].kinds, /rest/);
  await d.close();
});
