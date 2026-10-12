import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let ws;

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'dal-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
});

const log = (who, workspace, kind = 'erp_entity', id = 'erp_customers', op = 'query', rows = 3, fields = []) =>
  run(db, who, `select erp_log_data_access($1, $2, $3, $4, $5, $6)`, [workspace, kind, id, op, rows, fields]);

test('members write entries for their workspace; others cannot write or read them', async () => {
  await log(owner, ws);
  await log(owner, ws, 'dataset', 'ds-1', 'export', 10, ['salary']);
  const stranger = await createUser(db, 'dal-stranger');
  await expectError(log(stranger, ws), /Not allowed/);
  await expectError(log(owner, ws, 'erp_entity', 'x', 'drop'), /check constraint|violates/);
  const rows = await run(db, owner, `select actor_kind, object_kind, operation, rows, fields_unmasked from erp_data_access_log($1)`, [ws]);
  assert.deepEqual(rows.map((r) => [r.object_kind, r.operation, r.rows]), [['dataset', 'export', 10], ['erp_entity', 'query', 3]]);
  assert.deepEqual(rows[0].fields_unmasked, ['salary']);
  assert.equal(rows[0].actor_kind, 'user');
  await expectError(run(db, stranger, `select * from erp_data_access_log($1)`, [ws]), /not allowed/);
  // Nobody reads the table directly.
  await expectError(run(db, owner, `select * from etna_platform.data_access_log`), /permission denied/);
});

test('the log is append-only, for the schema owner too', async () => {
  await expectError(admin(db, `update etna_platform.data_access_log set rows = 0`), /append-only/);
  await expectError(admin(db, `delete from etna_platform.data_access_log`), /append-only/);
});

test('monthly partitions exist and rows land in them; the purge keeps holds', async () => {
  const parts = await admin(db, `select count(*)::int n from pg_inherits where inhparent = 'etna_platform.data_access_log'::regclass`);
  assert.ok(parts[0].n >= 4, 'default + this month + two ahead');
  const [{ part }] = await admin(db, `select tableoid::regclass::text part from etna_platform.data_access_log order by id desc limit 1`);
  assert.match(part, /data_access_log_\d{6}/);
  // An old entry (written into the default partition) goes with the purge.
  await admin(db, `insert into etna_platform.data_access_log (occurred_at, workspace_id, actor_kind, object_kind, operation)
                   values (now() - interval '3 years', $1, 'user', 'erp_entity', 'query')`, [ws]);
  const [{ r }] = await admin(db, `select etna_platform.purge_by_retention() r`);
  assert.ok(r.data_access >= 1);
  assert.equal((await admin(db, `select count(*)::int n from etna_platform.data_access_log where occurred_at < now() - interval '2 years'`))[0].n, 0);
  assert.equal((await admin(db, `select etna_platform.ensure_data_access_partitions(3) n`))[0].n, 1);
});

test('ontology searches are logged here too', async () => {
  await run(db, owner, `select erp_log_access($1, 'search', array['customer'], null, 4)`, [ws]);
  const rows = await run(db, owner, `select object_kind, object_id, operation, rows from erp_data_access_log($1, null, 1)`, [ws]);
  assert.deepEqual(rows, [{ object_kind: 'ontology', object_id: 'customer', operation: 'search', rows: 4 }]);
});

test('rollback removes the data-access log', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000033_data_access_log.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select to_regclass('etna_platform.data_access_log') is null as gone,
    position('_data_access_insert' in pg_get_functiondef('public.erp_log_access(uuid,text,text[],uuid,integer)'::regprocedure)) = 0 as search_back`);
  assert.deepEqual(rows[0], { gone: true, search_back: true });
  await d.close();
});
