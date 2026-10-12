import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let sa;
let owner;
let ws;
let datasetId;

async function as(who, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: who.user.id, email: who.user.email, role: 'authenticated', aal: 'aal2', sid: who.sid }),
    ]);
    return (await tx.query(sql, params)).rows;
  });
}

const asWorker = (sql, params = [], claimsOf = null) =>
  db.transaction(async (tx) => {
    if (claimsOf)
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: claimsOf.id, role: 'authenticated', aal: 'aal2' }),
      ]);
    await tx.exec('set local role etna_worker');
    return (await tx.query(sql, params)).rows;
  });

before(async () => {
  db = await createDb();
  const user = await createUser(db, 'exp-sa');
  await admin(db, `select etna_admin.grant_platform_admin($1, 'super_admin')`, [user.email]);
  const [{ id: sid }] = await admin(db,
    `insert into auth.sessions (user_id, token_hash, aal, expires_at, reauthenticated_at)
     values ($1, md5(random()::text), 'aal2', now() + interval '1 day', now()) returning id`, [user.id]);
  sa = { user, sid };
  owner = await createUser(db, 'exp-owner');
  const [{ r }] = await as(sa, `select etna_platform.admin_create_company('PT Ekspor', 'general', $1, '', $2, 'Test') as r`, [owner.email, randomBytes(32).toString('hex')]);
  ws = r.workspace_id;
  const internal = (await admin(db, `select owner_id from erp_workspaces where id = $1`, [ws]))[0].owner_id;
  await admin(db, `insert into erp_customers (user_id, workspace_id, name, email) values ($1, $2, 'PT Pelanggan', 'a@b.test')`, [internal, ws]);
  await run(db, owner, `select erp_set_terminal($1, true)`, [ws]);
  [{ id: datasetId }] = await run(db, owner, `select ps_create_dataset($1, 'Trips', '', '', '[{"label":"Code","type":"text"}]'::jsonb) as id`, [ws]);
  await asWorker(`select ps_admin.provision_dataset($1)`, [datasetId], owner);
  await run(db, owner, `select ps_rows_write($1, '[{"c_1":"A1"},{"c_1":"A2"}]'::jsonb, 'append', 'import', 'x')`, [datasetId]);
});

test('no export outside a termination; the Owner asks for one during the export period', async () => {
  await expectError(run(db, owner, `select erp_request_company_export($1)`, [ws]), /Only the Owner/);
  await as(sa, `select etna_platform.admin_terminate_workspace($1, 'Contract ended in October', 30)`, [ws]);
  const [{ id }] = await run(db, owner, `select erp_request_company_export($1) as id`, [ws]);
  await expectError(run(db, owner, `select erp_request_company_export($1)`, [ws]), /already being prepared/);
  const stranger = await createUser(db, 'exp-stranger');
  await expectError(run(db, stranger, `select erp_request_company_export($1)`, [ws]), /Only the Owner/);
  assert.deepEqual((await run(db, owner, `select status from erp_company_exports($1)`, [ws])).map((e) => e.status), ['preparing']);
  const [job] = await admin(db, `select kind, as_user from ps_jobs where payload ->> 'export_id' = $1`, [id]);
  assert.deepEqual(job, { kind: 'workspace.export', as_user: owner.id });

  // What the worker reads: ERP lists without secrets, datasets with their rows.
  const tables = (await asWorker(`select table_name from ps_worker.export_tables()`)).map((r) => r.table_name);
  assert.ok(tables.includes('erp_customers') && !tables.includes('erp_workspace_invitations'));
  const [{ rows }] = await asWorker(`select ps_worker.export_rows($1, 'erp_customers', 0, 100) as rows`, [ws]);
  assert.deepEqual(rows.map((c) => c.name), ['PT Pelanggan']);
  await expectError(asWorker(`select ps_worker.export_rows($1, 'pg_authid', 0, 1)`, [ws]), /Unknown table/);
  const [{ ds }] = await asWorker(`select ps_worker.export_datasets($1) as ds`, [ws]);
  assert.equal(ds[0].columns[0].label, 'Code');
  const [{ page }] = await asWorker(`select ps_admin.export_dataset_rows($1, 0, 10) as page`, [datasetId]);
  assert.deepEqual(page.map((p) => p.c_1), ['A1', 'A2']);
  assert.ok(!('_workspace_id' in page[0]));
  const [t] = await admin(db, `select relforcerowsecurity from pg_class where oid = ('ps_data.' || (select physical_table from ps_datasets where id = $1))::regclass`, [datasetId]);
  assert.equal(t.relforcerowsecurity, true, 'row-level security is forced again');
  await expectError(run(db, owner, `select ps_admin.export_dataset_rows($1, 0, 10)`, [datasetId]), /permission denied/);

  await asWorker(`select ps_worker.export_finished($1, 'ready', $2, 1234, null)`, [id, `company-export-${id}.json.gz`]);
  const [file] = await run(db, owner, `select * from erp_company_export_file($1)`, [id]);
  assert.equal(file.file_key, `company-export-${id}.json.gz`);
  assert.equal((await admin(db, `select count(*)::int n from etna_platform.data_access_log where object_kind = 'company_export'`))[0].n, 1);
  await expectError(run(db, stranger, `select * from erp_company_export_file($1)`, [id]), /not available/);
  // After the export period nothing more is handed out.
  await admin(db, `update etna_platform.workspace_terminations set export_until = now() - interval '1 minute' where workspace_id = $1`, [ws]);
  await expectError(run(db, owner, `select * from erp_company_export_file($1)`, [id]), /not available/);
  await expectError(asWorker(`select ps_admin.export_dataset_rows($1, 0, 10)`, [datasetId]), /export period/);
});

test('rollback removes the export', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000040_company_export.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select to_regclass('etna_platform.workspace_exports') is null as gone`);
  assert.equal(rows[0].gone, true);
  await d.close();
});
