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

const newImport = async (who = owner, kind = 'csv') => {
  const [{ id }] = await admin(db, `select gen_random_uuid() as id`);
  await run(db, who, `select ps_create_import($1, $2, 'trips.csv', $3, 1200)`, [ws, id, kind]);
  return id;
};

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'imp-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  await run(db, owner, `select erp_set_terminal($1, true)`, [ws]);
});

test('an upload becomes an import with an analysis job; only importers may start one', async () => {
  const id = await newImport();
  const [i] = await run(db, owner, `select status, storage_key, job_id from ps_imports where id = $1`, [id]);
  assert.equal(i.status, 'analyzing');
  assert.equal(i.storage_key, `${id}.csv`);
  const [job] = await admin(db, `select kind, payload ->> 'import_id' as import_id from ps_jobs where id = $1`, [i.job_id]);
  assert.deepEqual(job, { kind: 'import.analyze', import_id: id });
  const stranger = await createUser(db, 'imp-stranger');
  const [{ id: other }] = await admin(db, `select gen_random_uuid() as id`);
  await expectError(run(db, stranger, `select ps_create_import($1, $2, 'x.csv', 'csv', 10)`, [ws, other]), /not allowed/);
  await expectError(run(db, owner, `select ps_create_import($1, $2, 'x.exe', 'exe', 10)`, [ws, other]), /check/);
  assert.equal((await run(db, stranger, `select count(*)::int n from ps_imports`))[0].n, 0);
});

test('analysis, mapping to a new dataset, commit with rejects, finishing', async () => {
  const id = await newImport();
  await expectError(run(db, owner, `select ps_commit_import($1, '{"target":"new_dataset","columns":[]}'::jsonb)`, [id]), /not ready/);
  const analysis = { delimiter: ',', header: true, columns: [{ name: 'Code', type: 'text' }, { name: 'Tonnes', type: 'decimal' }] };
  await asWorker(`select ps_worker.import_analyzed($1, $2::jsonb, 3)`, [id, JSON.stringify(analysis)]);
  const mapping = { target: 'new_dataset', name: 'Trips', mode: 'append', columns: [
    { source: 'Code', label: 'Code', type: 'text', key: true }, { source: 'Tonnes', label: 'Tonnes', type: 'decimal' }, { source: 'Note', skip: true }] };
  const [{ job }] = await run(db, owner, `select ps_commit_import($1, $2::jsonb) as job`, [id, JSON.stringify(mapping)]);
  const [i] = await run(db, owner, `select status, target_dataset_id, mapping from ps_imports where id = $1`, [id]);
  assert.equal(i.status, 'committing');
  assert.ok(i.target_dataset_id);
  const cols = await admin(db, `select label, type, is_key from ps_dataset_columns where dataset_id = $1 order by position`, [i.target_dataset_id]);
  assert.deepEqual(cols.map((c) => [c.label, c.type, c.is_key]), [['Code', 'text', true], ['Tonnes', 'decimal', false]]);
  assert.equal((await admin(db, `select kind from ps_jobs where id = $1`, [job]))[0].kind, 'import.commit');
  await asWorker(`select ps_worker.import_progress($1, 2, 1, $2::jsonb)`, [id, JSON.stringify([{ row: 3, reason: 'bad_number', column: 'Tonnes', raw: { Code: 'X', Tonnes: 'abc' } }])]);
  await asWorker(`select ps_worker.import_finished($1, 'committed', null)`, [id]);
  const [done] = await run(db, owner, `select status, rows_ok, rows_rejected from ps_imports where id = $1`, [id]);
  assert.deepEqual(done, { status: 'committed', rows_ok: 2, rows_rejected: 1 });
  const rejects = await run(db, owner, `select row_number, reason, column_name from ps_import_rejects where import_id = $1`, [id]);
  assert.deepEqual(rejects, [{ row_number: 3, reason: 'bad_number', column_name: 'Tonnes' }]);
  const [audit] = await admin(db, `select details from erp_workspace_audit_log where action = 'import.committed' and details ->> 'import_id' = $1`, [id]);
  assert.equal(audit.details.rows_ok, 2);
});

test('ERP targets need the ERP permission and are never replaced', async () => {
  const id = await newImport();
  await asWorker(`select ps_worker.import_analyzed($1, '{}'::jsonb, 1)`, [id]);
  await expectError(run(db, owner, `select ps_commit_import($1, '{"target":"erp","erp_entity":"customers","mode":"replace","columns":[]}'::jsonb)`, [id]), /never replaced/);
  await expectError(run(db, owner, `select ps_commit_import($1, '{"target":"erp","erp_entity":"payments","columns":[]}'::jsonb)`, [id]), /Unknown ERP list/);
  await run(db, owner, `select ps_commit_import($1, '{"target":"erp","erp_entity":"customers","mode":"append","columns":[]}'::jsonb)`, [id]);
  assert.equal((await run(db, owner, `select target_erp_entity from ps_imports where id = $1`, [id]))[0].target_erp_entity, 'customers');
});

test('cancelling stops the job; old files are listed for removal', async () => {
  const id = await newImport();
  await run(db, owner, `select ps_cancel_import($1)`, [id]);
  const [i] = await admin(db, `select i.status, j.status as job from ps_imports i join ps_jobs j on j.id = i.job_id where i.id = $1`, [id]);
  assert.deepEqual(i, { status: 'cancelled', job: 'cancelled' });
  await admin(db, `update ps_imports set updated_at = now() - interval '2 days' where id = $1`, [id]);
  const files = await asWorker(`select import_id, storage_key from ps_worker.import_files_to_remove(10)`);
  assert.ok(files.some((f) => f.import_id === id));
  await asWorker(`select ps_worker.import_file_removed($1)`, [id]);
  assert.ok(!(await asWorker(`select import_id from ps_worker.import_files_to_remove(10)`)).some((f) => f.import_id === id));
  await expectError(run(db, owner, `select ps_worker.import_finished($1, 'committed', null)`, [id]), /permission denied/);
});

test('rollback removes imports', async () => {
  const d = await createDb();
  // Later migrations depend on this one: they are rolled back first.
  for (const name of ['20261012000058_terminal_query_tool', '20261012000049_terminal_ai', '20261012000048_terminal_mcp', '20261012000042_terminal_db_sources', '20261012000041_terminal_connectors', '20261012000040_company_export', '20261012000039_terminal_module', '20261012000038_terminal_pipelines', '20261012000037_terminal_imports']) {
    await d.exec(readFileSync(new URL(`../../db/rollback/rollback_${name}.sql`, import.meta.url), 'utf8'));
  }
  const { rows } = await d.query(`select to_regclass('public.ps_imports') is null as gone`);
  assert.equal(rows[0].gone, true);
  await d.close();
});
