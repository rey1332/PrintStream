import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let sa;
let support;
let owner;
let ws;
const MB = 1024 * 1024;

async function openSession(user) {
  const [{ id }] = await admin(db,
    `insert into auth.sessions (user_id, token_hash, aal, expires_at, reauthenticated_at)
     values ($1, md5(random()::text), 'aal2', now() + interval '1 day', now()) returning id`, [user.id]);
  return id;
}
async function as(who, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: who.user.id, email: who.user.email, role: 'authenticated', aal: 'aal2', sid: who.sid }),
    ]);
    return (await tx.query(sql, params)).rows;
  });
}
async function adminOf(name, role) {
  const user = await createUser(db, name);
  await admin(db, `select etna_admin.grant_platform_admin($1, $2)`, [user.email, role]);
  return { user, sid: await openSession(user) };
}

before(async () => {
  db = await createDb();
  sa = await adminOf('sq-sa', 'super_admin');
  support = await adminOf('sq-support', 'support');
  const created = await createUser(db, 'sq-owner');
  const [{ r }] = await as(sa, `select etna_platform.admin_create_company('PT Kuota', 'general', $1, '', $2, 'Test') as r`, [created.email, randomBytes(32).toString('hex')]);
  owner = { id: r.user_id, email: created.email };
  // The company's Owner is the account the company was created for.
  owner = created;
  ws = r.workspace_id;
});

const reserve = (who, bytes, kind = 'file') =>
  run(db, who, `select erp_reserve_storage($1, $2, 'import', $3) as id`, [ws, bytes, kind]).then((r) => r[0].id);

test('without a quota everything fits; the upload limit always applies', async () => {
  const id = await reserve(owner, 10 * MB);
  assert.ok(id);
  await expectError(reserve(owner, 300 * MB), /larger than the upload limit/);
  await expectError(reserve(owner, 60 * MB, 'xlsx'), /larger than the upload limit/);
  await run(db, owner, `select erp_release_storage($1, $2)`, [id, 10 * MB]);
  const [{ u }] = await run(db, owner, `select erp_storage_usage($1) as u`, [ws]);
  assert.equal(u.used_files, 10 * MB);
  assert.equal(u.quota_bytes, null);
});

test('only a super admin sets a quota; reservations stop at it and warnings are written', async () => {
  await expectError(as(support, `select etna_platform.admin_set_workspace_quota($1, $2, false, null, 'Plan Basic')`, [ws, 100 * MB]), /Not allowed/);
  await as(sa, `select etna_platform.admin_set_workspace_quota($1, $2, false, null, 'Plan Basic')`, [ws, 100 * MB]);
  const a = await reserve(owner, 60 * MB);
  await expectError(reserve(owner, 40 * MB), /quota is full/);
  await run(db, owner, `select erp_release_storage($1, $2)`, [a, 75 * MB]);
  const warnings = await admin(db, `select metadata ->> 'level' level from etna_platform.security_events where event_type = 'STORAGE_WARNING' and workspace_id = $1 order by id`, [ws]);
  assert.deepEqual(warnings.map((w) => w.level), ['80']);
  // ERP work is never blocked by the quota: an invoice still goes in.
  await run(db, owner, `insert into erp_customers (user_id, workspace_id, name) values ((select owner_id from erp_workspaces where id = $1), $1, 'Masih bisa')`, [ws]);
  // Raising the quota (or making it unlimited) lets growth continue.
  await as(sa, `select etna_platform.admin_set_workspace_quota($1, null, true, null, 'Upgrade')`, [ws]);
  assert.ok(await reserve(owner, 40 * MB));
});

test('measurements replace the counters; the ERP estimate is per company', async () => {
  const [{ workspace_id: personal }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  await admin(db, `insert into erp_customers (user_id, workspace_id, name) select $1, $2, 'C' || g from generate_series(1, 50) g`, [owner.id, personal]);
  await admin(db, `analyze erp_customers`);
  const est = await admin(db, `select workspace_id, bytes from etna_platform.measure_erp_estimate()`);
  const mine = est.find((e) => e.workspace_id === personal);
  assert.ok(mine && Number(mine.bytes) > 0);
  await admin(db, `select etna_platform.record_storage_measure($1, null, 5, $2)`, [ws, 123]);
  const [{ u }] = await run(db, owner, `select erp_storage_usage($1) as u`, [ws]);
  assert.equal(u.used_files, 5);
  assert.equal(u.used_erp_estimate, 123);
});

test('the Owner may ask for more room once a day; outsiders see nothing', async () => {
  await run(db, owner, `select erp_request_storage($1, 'Kami butuh 50 GB lagi')`, [ws]);
  await expectError(run(db, owner, `select erp_request_storage($1, 'Lagi')`, [ws]), /already waiting/);
  const [{ s }] = await as(support, `select etna_platform.admin_workspace_storage($1) as s`, [ws]);
  assert.equal(s.requests.length, 1);
  const stranger = await createUser(db, 'sq-stranger');
  await expectError(run(db, stranger, `select erp_storage_usage($1)`, [ws]), /not allowed/);
  await expectError(run(db, stranger, `select erp_reserve_storage($1, 1, 'import', 'file')`, [ws]), /not a member/);
  // The folder is set only by the schema owner (the server manager).
  await expectError(run(db, owner, `select etna_admin.set_workspace_storage_dir($1, 'D:\\x')`, [ws]), /permission denied/);
  await admin(db, `select etna_admin.set_workspace_storage_dir($1, 'E:\\ETNAStorage\\PT Kuota')`, [ws]);
  assert.equal((await run(db, owner, `select erp_workspace_storage_dir($1) d`, [ws]))[0].d, 'E:\\ETNAStorage\\PT Kuota');
});

test('rollback removes quotas', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000034_storage_quotas.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select to_regclass('etna_platform.workspace_storage') is null as gone`);
  assert.equal(rows[0].gone, true);
  await d.close();
});
