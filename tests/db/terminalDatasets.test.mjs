import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let ws;

// The worker runs a job with the rights of the user who asked for it.
const asWorkerFor = (user, sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: user.id, role: 'authenticated', aal: user.aal ?? 'aal2' }),
    ]);
    await tx.exec('set local role etna_worker');
    return (await tx.query(sql, params)).rows;
  });

async function join(role, customId = null) {
  const user = await createUser(db, `ds-${role}`);
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation_v2($1, $2, 24, '', $3)`, [ws, role, customId]);
  await run(db, user, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  return user;
}

const COLUMNS = JSON.stringify([
  { label: 'Code', type: 'text', key: true },
  { label: 'Tonnes', type: 'decimal', unit: 't' },
  { label: 'Driver NIK', type: 'text', sensitive: true },
]);

async function makeDataset(name = 'Weighbridge', columns = COLUMNS, access = 'workspace') {
  const [{ id }] = await run(db, owner, `select ps_create_dataset($1, $2, 'Ops', '', $3::jsonb, $4) as id`, [ws, name, columns, access]);
  await asWorkerFor(owner, `select ps_admin.provision_dataset($1)`, [id]);
  const [d] = await admin(db, `select * from ps_datasets where id = $1`, [id]);
  return d;
}

const view = (d) => `ps_data.dsv_${d.physical_table.slice(3)}`;

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'ds-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  await run(db, owner, `select erp_set_terminal($1, true)`, [ws]);
});

test('creating a dataset queues its table; the worker builds it with forced row-level security', async () => {
  const [{ id }] = await run(db, owner, `select ps_create_dataset($1, 'Trips', '', '', $2::jsonb) as id`, [ws, COLUMNS]);
  const [job] = await admin(db, `select kind, as_user from ps_jobs where payload ->> 'dataset_id' = $1`, [id]);
  assert.deepEqual([job.kind, job.as_user], ['dataset.provision', owner.id]);
  // Only the worker provisions, and never signed-in users.
  await expectError(run(db, owner, `select ps_admin.provision_dataset($1)`, [id]), /permission denied/);
  await asWorkerFor(owner, `select ps_admin.provision_dataset($1)`, [id]);
  const [d] = await admin(db, `select status, physical_table from ps_datasets where id = $1`, [id]);
  assert.equal(d.status, 'ready');
  const [t] = await admin(db, `select relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) as owner from pg_class where oid = ('ps_data.' || $1)::regclass`, [d.physical_table]);
  assert.deepEqual(t, { relrowsecurity: true, relforcerowsecurity: true, owner: 'etna_ddl' });
  const cols = (await admin(db, `select column_name from information_schema.columns where table_schema = 'ps_data' and table_name = $1 order by ordinal_position`, [d.physical_table])).map((r) => r.column_name);
  assert.deepEqual(cols.filter((c) => c.startsWith('c_')), ['c_1', 'c_2', 'c_3']);
  // Users read the view, never the table.
  await expectError(run(db, owner, `select * from ps_data.${d.physical_table}`), /permission denied/);
  await expectError(run(db, owner, `select ps_create_dataset($1, 'Trips', '', '', '[]'::jsonb)`, [ws]), /duplicate|unique/);
  await expectError(run(db, owner, `select ps_create_dataset($1, 'Bad', '', '', '[{"label":"x","type":"money"}]'::jsonb)`, [ws]), /Unknown column type/);
});

test('rows are written by mode; sensitive columns are masked without data.sensitive', async () => {
  const d = await makeDataset();
  const rows = JSON.stringify([{ c_1: 'A1', c_2: 12.5, c_3: '3201010101010001' }, { c_1: 'A2', c_2: 8, c_3: '3201010101010002' }]);
  assert.equal((await run(db, owner, `select ps_rows_write($1, $2::jsonb, 'append', 'import', 'imp-1') as n`, [d.id, rows]))[0].n, 2);
  // Upsert by the key column.
  await run(db, owner, `select ps_rows_write($1, '[{"c_1":"A1","c_2":20}]'::jsonb, 'upsert', 'import', 'imp-2')`, [d.id]);
  const mine = await run(db, owner, `select c_1, c_2::float as c_2, c_3 from ${view(d)} order by c_1`);
  assert.deepEqual(mine.map((r) => [r.c_1, r.c_2]), [['A1', 20], ['A2', 8]]);
  assert.equal(mine[1].c_3, '3201010101010002', 'the Owner sees sensitive values');
  const [ownerAal1] = await run(db, { ...owner, aal: 'aal1' }, `select c_3 from ${view(d)} order by c_1 desc limit 1`);
  assert.equal(ownerAal1.c_3, '••••••••0002', 'without two-factor even the Owner sees it masked');
  assert.equal((await admin(db, `select row_count::int n from ps_datasets where id = $1`, [d.id]))[0].n, 2, 'an upsert of an existing key adds no row');
  const [{ sized }] = await asWorkerFor(owner, `select ps_worker.refresh_dataset_sizes() as sized`);
  assert.ok(sized >= 1);
  const adminUser = await join('admin');
  const theirs = await run(db, adminUser, `select c_1, c_3 from ${view(d)} order by c_1`);
  assert.equal(theirs.length, 2);
  assert.equal(theirs[1].c_3, '••••••••0002', 'an Admin without data.sensitive sees it masked');
  await expectError(run(db, owner, `select ps_rows_write($1, '[]'::jsonb, 'upsert', 'import', 'x')`, [(await makeDataset('No key', '[{"label":"v","type":"integer"}]')).id]), /key columns/);
  // Replace: the new load in, the older rows marked removed.
  await run(db, owner, `select ps_rows_write($1, '[{"c_1":"B1","c_2":1}]'::jsonb, 'replace', 'import', 'imp-3')`, [d.id]);
  await run(db, owner, `select ps_rows_finish_replace($1, 'imp-3')`, [d.id]);
  assert.deepEqual((await run(db, owner, `select c_1 from ${view(d)}`)).map((r) => r.c_1), ['B1']);
  // Grid edits and removal.
  const [{ _id }] = await run(db, owner, `select _id from ${view(d)}`);
  await run(db, owner, `select ps_row_update($1, $2, '{"c_2": 99}'::jsonb)`, [d.id, _id]);
  assert.equal((await run(db, owner, `select c_2::int n from ${view(d)}`))[0].n, 99);
  await run(db, owner, `select ps_rows_delete($1, $2)`, [d.id, [_id]]);
  assert.equal((await run(db, owner, `select count(*)::int n from ${view(d)}`))[0].n, 0);
  // The worker purges removed rows after seven days.
  await admin(db, `update ps_data.${d.physical_table} set _deleted_at = now() - interval '8 days' where _deleted_at is not null`);
  const [{ n }] = await asWorkerFor(owner, `select ps_admin.purge_removed_rows() as n`);
  assert.ok(Number(n) >= 3);
});

test('restricted datasets need a place on the list; viewers cannot write; strangers see nothing', async () => {
  const d = await makeDataset('Payroll extract', COLUMNS, 'restricted');
  await run(db, owner, `select ps_rows_write($1, '[{"c_1":"P1"}]'::jsonb, 'append', 'import', 'p')`, [d.id]);
  const [{ id: readerRole }] = await run(db, owner, `select erp_save_custom_role($1, null, 'Reader', '', $2, true) as id`, [ws, ['datasets.view', 'datasets.query']]);
  const viewer = await join('custom', readerRole);
  const adminUser = await join('admin');
  const stranger = await createUser(db, 'ds-stranger');
  assert.equal((await run(db, adminUser, `select count(*)::int n from ${view(d)}`))[0].n, 0, 'not on the list');
  assert.equal((await run(db, adminUser, `select count(*)::int n from ps_datasets where id = $1`, [d.id]))[0].n, 0);
  await run(db, owner, `select ps_set_item_access('dataset', $1, 'restricted', $2::jsonb)`, [d.id, JSON.stringify([{ kind: 'member', grantee: adminUser.id, permissions: ['datasets.view', 'datasets.query'] }])]);
  assert.equal((await run(db, adminUser, `select count(*)::int n from ${view(d)}`))[0].n, 1);
  await expectError(run(db, adminUser, `select ps_rows_write($1, '[{"c_1":"X"}]'::jsonb, 'append', 'import', 'x')`, [d.id]), /not allowed/);
  // Nobody hands out more than they hold.
  await expectError(run(db, adminUser, `select ps_set_item_access('dataset', $1, 'restricted', $2::jsonb)`, [d.id, '[]']), /not allowed/);
  const open = await makeDataset('Open');
  await expectError(run(db, viewer, `select ps_rows_write($1, '[{"c_1":"V"}]'::jsonb, 'append', 'import', 'v')`, [open.id]), /not allowed/);
  await expectError(run(db, adminUser, `select ps_set_item_access('dataset', $1, 'restricted', $2::jsonb)`, [open.id, JSON.stringify([{ kind: 'role', grantee: 'sales', permissions: ['data.sensitive'] }])]), /permissions you do not have/);
  assert.equal((await run(db, stranger, `select count(*)::int n from ps_datasets`))[0].n, 0);
  assert.equal((await run(db, stranger, `select count(*)::int n from ${view(open)}`))[0].n, 0);
});

test('schema changes go through the worker; hidden columns leave the view; deletion waits 30 days', async () => {
  const d = await makeDataset('Changing');
  await run(db, owner, `select ps_alter_dataset($1, '{"add":[{"label":"Shift","type":"text"}],"columns":[{"physical_name":"c_2","hidden":true}]}'::jsonb)`, [d.id]);
  assert.equal((await admin(db, `select status from ps_datasets where id = $1`, [d.id]))[0].status, 'altering');
  await expectError(run(db, owner, `select ps_alter_dataset($1, '{"name":"Again"}'::jsonb)`, [d.id]), /being prepared/);
  await asWorkerFor(owner, `select ps_admin.alter_dataset($1)`, [d.id]);
  const cols = (await run(db, owner, `select * from ${view(d)} limit 0`).then(() => admin(db, `select column_name from information_schema.columns where table_schema = 'ps_data' and table_name = $1`, ['dsv_' + d.physical_table.slice(3)]))).map((r) => r.column_name);
  assert.ok(cols.includes('c_4') && !cols.includes('c_2'));
  const [{ v }] = await admin(db, `select max(version) v from ps_dataset_versions where dataset_id = $1`, [d.id]);
  assert.equal(v, 2);
  await run(db, owner, `select ps_delete_dataset($1)`, [d.id]);
  assert.equal((await run(db, owner, `select count(*)::int n from ps_datasets where id = $1`, [d.id]))[0].n, 0);
  assert.equal((await asWorkerFor(owner, `select ps_admin.purge_dataset($1) as done`, [d.id]))[0].done, false, 'not before 30 days');
  await admin(db, `update ps_datasets set deleted_at = now() - interval '31 days' where id = $1`, [d.id]);
  assert.equal((await asWorkerFor(owner, `select ps_admin.purge_dataset($1) as done`, [d.id]))[0].done, true);
  assert.equal((await admin(db, `select to_regclass('ps_data.' || $1) is null as gone`, [d.physical_table]))[0].gone, true);
  const sizes = await asWorkerFor(owner, `select * from ps_admin.measure_datasets()`);
  assert.ok(sizes.some((r) => r.workspace_id === ws && Number(r.bytes) > 0));
});

test('rollback removes datasets, their tables and the schemas', async () => {
  const d = await createDb();
  // Later migrations depend on this one: they are rolled back first.
  for (const name of ['20261012000058_terminal_query_tool', '20261012000049_terminal_ai', '20261012000048_terminal_mcp', '20261012000042_terminal_db_sources', '20261012000041_terminal_connectors', '20261012000040_company_export', '20261012000039_terminal_module', '20261012000038_terminal_pipelines', '20261012000037_terminal_imports', '20261012000036_terminal_datasets']) {
    await d.exec(readFileSync(new URL(`../../db/rollback/rollback_${name}.sql`, import.meta.url), 'utf8'));
  }
  const { rows } = await d.query(`select to_regclass('public.ps_datasets') is null as gone, to_regnamespace('ps_data') is null as data_gone, to_regnamespace('ps_admin') is null as admin_gone`);
  assert.deepEqual(rows[0], { gone: true, data_gone: true, admin_gone: true });
  await d.close();
});
