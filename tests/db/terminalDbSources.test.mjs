import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, expectError } from './harness.mjs';

let db;
let owner;
let ws;
let conn;

// As the database owner (the audit log is not readable by users directly).
const sql = async (text, params) => (await db.query(text, params)).rows;
const SECRET = 'v1:aXY=:dGFn:Y2lwaGVy';
const COLUMNS = JSON.stringify([
  { label: 'id', type: 'integer', key: true },
  { label: 'name', type: 'text' },
  { label: 'updated_at', type: 'timestamp' },
]);
const table = (name) => JSON.stringify({ mode: 'table', schema: 'public', table: name, key: 'id', changed: 'updated_at' });

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'dbs-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  await run(db, owner, `select erp_set_terminal($1, true)`, [ws]);
  [{ id: conn }] = await run(
    db,
    owner,
    `select ps_save_connection($1, null, 'postgres', 'Gudang DB', '{"host":"db.example.com","database":"wms","username":"reader","ssl":"verify-full"}'::jsonb, $2) as id`,
    [ws, SECRET]
  );
});

test('a database connection has many syncs, each with its own dataset', async () => {
  const create = (who, source, label, name) =>
    run(db, who, `select ps_create_source_sync($1, $2::jsonb, $3, $4, $5::jsonb) as id`, [conn, source, label, name, COLUMNS]);
  const [{ id: a }] = await create(owner, table('orders'), 'public.orders', 'Orders');
  const [{ id: b }] = await create(owner, table('items'), 'public.items', 'Items');
  const rows = await run(
    db,
    owner,
    `select s.object, s.label, s.source ->> 'table' as t, d.folder from ps_syncs s join ps_datasets d on d.id = s.dataset_id where s.id in ($1, $2) order by s.label`,
    [a, b]
  );
  assert.deepEqual(rows, [
    { object: 'table', label: 'public.items', t: 'items', folder: 'Gudang DB' },
    { object: 'table', label: 'public.orders', t: 'orders', folder: 'Gudang DB' },
  ]);
  const [audit] = await sql(
    `select details -> 'source' ->> 'table' as t from erp_workspace_audit_log where workspace_id = $1 and action = 'sync.added' and details ->> 'sync_id' = $2`,
    [ws, a]
  );
  assert.equal(audit.t, 'orders');
  // Not for ERP connections, and a table sync names its table.
  const [{ id: odoo }] = await run(
    db,
    owner,
    `select ps_save_connection($1, null, 'odoo', 'Odoo', '{"url":"https://odoo.example.com"}'::jsonb, $2) as id`,
    [ws, SECRET]
  );
  await expectError(
    run(db, owner, `select ps_create_source_sync($1, $2::jsonb, 'x', 'X', $3::jsonb)`, [odoo, table('orders'), COLUMNS]),
    /Not a source of this connection/
  );
  await expectError(create(owner, JSON.stringify({ mode: 'table', schema: 'public' }), 'x', 'X2'), /names its schema and table/);
  await expectError(create(owner, JSON.stringify({ mode: 'drop' }), 'x', 'X3'), /Not a source of this connection/);
});

test('a query needs the manage permission and two-factor, and is kept in the audit log', async () => {
  const query = JSON.stringify({ mode: 'query', sql: 'select id, name, updated_at from public.orders where id > 10' });
  // Without a two-factor session, even the Owner may not.
  await expectError(
    run(db, { ...owner, aal: 'aal1' }, `select ps_create_source_sync($1, $2::jsonb, 'q', 'Big orders', $3::jsonb)`, [conn, query, COLUMNS]),
    /two-factor/
  );
  const [{ id }] = await run(db, owner, `select ps_create_source_sync($1, $2::jsonb, 'q', 'Big orders', $3::jsonb) as id`, [
    conn,
    query,
    COLUMNS,
  ]);
  const [audit] = await sql(
    `select details -> 'source' ->> 'sql' as sql from erp_workspace_audit_log where action = 'sync.added' and details ->> 'sync_id' = $1`,
    [id]
  );
  assert.match(audit.sql, /where id > 10/);
  await expectError(
    run(db, owner, `select ps_create_source_sync($1, $2::jsonb, 'q', 'Empty', $3::jsonb)`, [conn, JSON.stringify({ mode: 'query', sql: '' }), COLUMNS]),
    /empty or too long/
  );
});

test('users of connections can ask for a describe job; ERP lists stay one sync each', async () => {
  const [{ id }] = await run(db, owner, `select ps_enqueue_job($1, 'connector.describe', $2::jsonb) as id`, [
    ws,
    JSON.stringify({ connection_id: conn, source: null }),
  ]);
  assert.ok(id);
  // ERP lists stay one sync each.
  const [{ id: odoo }] = await run(db, owner, `select id from ps_connections where kind = 'odoo' and workspace_id = $1`, [ws]);
  await run(db, owner, `select ps_create_sync($1, 'customers', 'Odoo customers', $2::jsonb)`, [odoo, COLUMNS]);
  await expectError(run(db, owner, `select ps_create_sync($1, 'customers', 'Again', $2::jsonb)`, [odoo, COLUMNS]), /duplicate|unique/);
});

test('rollback removes database sources', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000042_terminal_db_sources.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(
    `select to_regprocedure('public.ps_create_source_sync(uuid,jsonb,text,text,jsonb)') is null as fn_gone,
            not exists (select 1 from information_schema.columns where table_name = 'ps_syncs' and column_name = 'source') as col_gone,
            public.ps_job_permission('connector.describe') is null as job_gone`
  );
  assert.deepEqual(rows[0], { fn_gone: true, col_gone: true, job_gone: true });
  await d.close();
});
