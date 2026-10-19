import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let ws;

const asWorker = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role etna_worker');
    return (await tx.query(sql, params)).rows;
  });

const SECRET = 'v1:aXY=:dGFn:Y2lwaGVy';
const COLUMNS = JSON.stringify([
  { label: 'id', type: 'text', key: true },
  { label: 'name', type: 'text' },
]);

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'conn-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
});

test('connections need TERMINAL, the manage permission and two-factor; secrets never reach users', async () => {
  const save = (who, secret = SECRET, name = 'Odoo pusat') =>
    run(db, who, `select ps_save_connection($1, null, 'odoo', $3, '{"url":"https://odoo.example.com","database":"prod"}'::jsonb, $2) as id`, [ws, secret, name]);
  await expectError(save(owner), /not added/);
  await run(db, owner, `select erp_set_terminal($1, true)`, [ws]);
  await expectError(save({ ...owner, aal: 'aal1' }), /two-factor/);
  const [{ id }] = await save(owner);
  const [c] = await run(db, owner, `select kind, has_secret, status from ps_connections where id = $1`, [id]);
  assert.deepEqual(c, { kind: 'odoo', has_secret: true, status: 'untested' });
  await expectError(run(db, owner, `select * from etna_platform.connection_secrets`), /permission denied/);
  await expectError(save(owner, 'plain password', 'Other'), /check/);
  // The worker gets the secret and the allowed internal networks.
  const [{ c: got }] = await asWorker(`select ps_worker.connection_get($1) as c`, [id]);
  assert.equal(got.secret, SECRET);
  assert.deepEqual(got.private_hosts, []);
  await asWorker(`select ps_worker.connection_update($1, 'ok', null, null, '{"version":"18.0"}'::jsonb)`, [id]);
  assert.equal((await run(db, owner, `select config ->> 'version' as v from ps_connections where id = $1`, [id]))[0].v, '18.0');
  // A member without integrations sees nothing.
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation_v2($1, 'sales', 24, '', null)`, [ws]);
  const sales = await createUser(db, 'conn-sales');
  await run(db, sales, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  assert.equal((await run(db, sales, `select count(*)::int n from ps_connections`))[0].n, 0);
});

test('a sync creates its dataset; schedules and three failures switch it off; the worker sees due syncs', async () => {
  const [{ id: conn }] = await run(db, owner, `select id from ps_connections where workspace_id = $1`, [ws]);
  const [{ id: sync }] = await run(db, owner, `select ps_create_sync($1, 'customers', 'Odoo customers', $2::jsonb) as id`, [conn, COLUMNS]);
  const [s] = await run(db, owner, `select s.object, d.name, d.folder from ps_syncs s join ps_datasets d on d.id = s.dataset_id where s.id = $1`, [sync]);
  assert.deepEqual(s, { object: 'customers', name: 'Odoo customers', folder: 'Odoo pusat' });
  await expectError(run(db, owner, `select ps_create_sync($1, 'customers', 'Again', $2::jsonb)`, [conn, COLUMNS]), /duplicate|unique/);
  await run(db, owner, `select ps_set_sync($1, true, 'daily', '{"at":"02:00"}'::jsonb, 'Asia/Jakarta', now() - interval '1 minute', 7)`, [sync]);
  assert.deepEqual((await asWorker(`select id from ps_worker.due_syncs(10)`)).map((r) => r.id), [sync]);
  await run(db, owner, `select ps_enqueue_job($1, 'connector.sync', $2::jsonb)`, [ws, JSON.stringify({ sync_id: sync })]);
  for (let i = 0; i < 3; i += 1) await asWorker(`select ps_worker.sync_finished($1, false, null, false, 0, 0, 'timeout')`, [sync]);
  const [after] = await run(db, owner, `select enabled, last_status, failure_streak from ps_syncs where id = $1`, [sync]);
  assert.deepEqual(after, { enabled: false, last_status: 'failed', failure_streak: 3 });
  await asWorker(`select ps_worker.sync_finished($1, true, '{"since":"2026-10-10 00:00:00"}'::jsonb, true, 12, 2, null)`, [sync]);
  const [ok] = await run(db, owner, `select cursor ->> 'since' as since, last_rows, last_removed, last_full_at is not null as full from ps_syncs where id = $1`, [sync]);
  assert.deepEqual(ok, { since: '2026-10-10 00:00:00', last_rows: 12, last_removed: 2, full: true });
  await run(db, owner, `select ps_delete_connection($1)`, [conn]);
  assert.equal((await run(db, owner, `select count(*)::int n from ps_syncs`))[0].n, 0);
});

test('rollback removes connectors', async () => {
  const d = await createDb();
  // The Query Tool's runs and MCP tools refer to connections: rolled back first.
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000058_terminal_query_tool.sql', import.meta.url), 'utf8'));
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000048_terminal_mcp.sql', import.meta.url), 'utf8'));
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000041_terminal_connectors.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select to_regclass('public.ps_connections') is null as gone, to_regclass('etna_platform.connection_secrets') is null as secrets_gone`);
  assert.deepEqual(rows[0], { gone: true, secrets_gone: true });
  await d.close();
});
