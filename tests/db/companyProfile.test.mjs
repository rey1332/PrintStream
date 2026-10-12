import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, runOnPath, admin, expectError } from './harness.mjs';

let db;
let owner;
let finance;
let ws;
let branch;
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PROFILE = {
  legal_name: ' PT Maju Jaya ', address: 'Jl. Merdeka 1', city: 'Bandung', phone: '022-123',
  email: 'Halo@Maju.test', website: 'maju.test', tax_id: '01.234.567.8-901.000',
  bank_details: 'BCA 123', footer_note: 'Terima kasih', logo: LOGO,
};
const get = async (user, workspace) => (await run(db, user, `select erp_company_profile_get($1) as p`, [workspace]))[0].p;
const set = (user, workspace, profile) => run(db, user, `select erp_company_profile_set($1, $2::jsonb)`, [workspace, JSON.stringify(profile)]);

before(async () => {
  db = await createDb();
  owner = { ...(await createUser(db, 'profile-owner')), aal: 'aal2' };
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  [{ id: branch }] = await run(db, owner, `select erp_create_erp('Cabang') as id`);
  finance = await createUser(db, 'profile-finance');
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'finance', 24, '')`, [ws]);
  await run(db, finance, `select erp_redeem_workspace_invitation($1)`, [access_code]);
});

test('Owner and Admins set the profile; every member reads it', async () => {
  const empty = await get(owner, ws);
  assert.equal(empty.legal_name, '');
  assert.equal(empty.can_edit, true);
  await set(owner, ws, PROFILE);
  const seen = await get(finance, ws);
  assert.equal(seen.legal_name, 'PT Maju Jaya');
  assert.equal(seen.email, 'halo@maju.test');
  assert.equal(seen.logo, LOGO);
  assert.equal(seen.can_edit, false);
  await expectError(set(finance, ws, PROFILE), /Only an owner or admin/);
  const outsider = await createUser(db, 'profile-outsider');
  await expectError(set(outsider, ws, PROFILE), /Only an owner or admin/);
  await expectError(get(outsider, ws), /Workspace not found/);
  assert.equal((await get(owner, branch)).legal_name, '', 'each ERP has its own');
  const audit = await admin(db, `select count(*)::int as n from erp_workspace_audit_log where workspace_id = $1 and action = 'company.profile_changed'`, [ws]);
  assert.equal(audit[0].n, 1);
});

test('the profile is checked', async () => {
  await expectError(set(owner, ws, { ...PROFILE, email: 'nope' }), /Not an e-mail address/);
  await expectError(set(owner, ws, { ...PROFILE, logo: 'data:image/svg+xml;base64,PHN2Zz4=' }), /PNG, JPEG or WebP/);
  await expectError(set(owner, ws, { ...PROFILE, logo: `data:image/png;base64,${'A'.repeat(410000)}` }), /at most 300 KB/);
  await set(owner, ws, { ...PROFILE, logo: null });
  assert.equal((await get(owner, ws)).logo, null);
});

test('emptying the ERP clears its profile', async () => {
  await set(owner, ws, PROFILE);
  await runOnPath(db, owner, '/account/delete-erp', `select erp_empty_erp($1)`, [ws]);
  assert.equal((await get(owner, ws)).legal_name, '');
});

test('rollback removes company profiles and keeps emptying an ERP working', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000007_erp_company_profile.sql', import.meta.url), 'utf8'));
  assert.equal((await d.query(`select to_regclass('public.erp_company_profiles') as t`)).rows[0].t, null);
  const def = await d.query(`select pg_get_functiondef('public.erp_empty_erp(uuid)'::regprocedure) as d`);
  assert.ok(!def.rows[0].d.includes('erp_company_profiles'));
  await d.close();
});
