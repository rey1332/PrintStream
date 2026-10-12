import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let adminUser;
let finance;
let personal;
let branch;

const get = async (user, ws) => (await run(db, user, `select erp_workspace_settings_get($1) as s`, [ws]))[0].s;
const set = (user, ws, settings) =>
  run(db, user, `select erp_workspace_settings_set($1, $2::jsonb)`, [ws, JSON.stringify(settings)]);
const SETTINGS = {
  cash_low_threshold: 1000,
  expense_spike_ratio: 90,
  inventory_low_threshold: 500,
  admin_email: 'Owner@Shop.test',
  approver_emails: ['boss@shop.test', ' BOSS@shop.test', ''],
  po_approval_threshold: 100,
};
const order = (user, ws, price) =>
  run(db, user, `select erp_create_purchase_order_v3($1, null, 'Parts Ltd', current_date, '', $2::jsonb, null, null) as id`, [
    ws, JSON.stringify([{ product_name: 'Bolt', qty: 1, price }]),
  ]);

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'settings-owner');
  [{ workspace_id: personal }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
  [{ id: branch }] = await run(db, owner, `select erp_create_erp('Branch') as id`);
  const join = async (role) => {
    const user = await createUser(db, `settings-${role}`);
    const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`, [branch, role]);
    await run(db, user, `select erp_redeem_workspace_invitation($1)`, [access_code]);
    return user;
  };
  adminUser = await join('admin');
  finance = await join('finance');
});

test('a created ERP starts with defaults and its own approval set-up', async () => {
  const s = await get(owner, branch);
  assert.equal(s.can_edit, true);
  assert.equal(Number(s.cash_low_threshold), 5000);
  assert.deepEqual(s.approval, { admin_email: '', approver_emails: [], po_approval_threshold: 0 }, 'no internal address shown');
});

test('approval set up in a created ERP applies to its purchase orders', async () => {
  await set(owner, branch, SETTINGS);
  const s = await get(owner, branch);
  assert.deepEqual(s.approval, { admin_email: 'owner@shop.test', approver_emails: ['boss@shop.test'], po_approval_threshold: 100 });

  const [{ id: small }] = await order(owner, branch, 50);
  const [{ id: big }] = await order(owner, branch, 250);
  const requests = await admin(db, `select purchase_order_id, approver_emails, admin_email from erp_approval_requests where purchase_order_id = any($1::uuid[])`, [[small, big]]);
  assert.deepEqual(requests, [{ purchase_order_id: big, approver_emails: ['boss@shop.test'], admin_email: 'owner@shop.test' }]);

  // The person's own ERP is not affected.
  const own = await get(owner, personal);
  assert.equal(Number(own.approval.po_approval_threshold), 0);
  const [{ id: ownOrder }] = await order(owner, personal, 250);
  assert.equal((await admin(db, `select count(*)::int as n from erp_approval_requests where purchase_order_id = $1`, [ownOrder]))[0].n, 0);
});

test('admins change the settings; other members only read the alert thresholds', async () => {
  await set(adminUser, branch, { ...SETTINGS, cash_low_threshold: 2500 });
  const seen = await get(finance, branch);
  assert.equal(Number(seen.cash_low_threshold), 2500);
  assert.equal(seen.can_edit, false);
  assert.equal(seen.approval, null, 'approval set-up is for the Owner and Admins');
  await expectError(set(finance, branch, SETTINGS), /Only an owner or admin/);
  const outsider = await createUser(db, 'settings-outsider');
  await expectError(get(outsider, branch), /Workspace not found/);

  const audit = await admin(db, `select count(*)::int as n from erp_workspace_audit_log where workspace_id = $1 and action = 'settings.changed'`, [branch]);
  assert.equal(audit[0].n, 2);
});

test('settings are checked', async () => {
  await expectError(set(owner, branch, { ...SETTINGS, cash_low_threshold: -1 }), /zero or more/);
  await expectError(set(owner, branch, { ...SETTINGS, approver_emails: ['not-an-email'] }), /Not an e-mail address/);
  await expectError(set(owner, branch, { ...SETTINGS, approver_emails: [] }), /at least one approver/);
  await expectError(set(owner, branch, { ...SETTINGS, po_approval_threshold: -5 }), /cannot be negative/);
});

test('two ERPs of the same person keep separate settings, also through a reset', async () => {
  // Each ERP has its own owner account (a created ERP an internal one), so
  // settings stored per owner are per ERP.
  await set(owner, personal, { ...SETTINGS, cash_low_threshold: 111, po_approval_threshold: 0, approver_emails: [] });
  await set(owner, branch, { ...SETTINGS, cash_low_threshold: 222 });
  assert.equal((await get(owner, personal)).cash_low_threshold, 111);
  assert.equal((await get(owner, branch)).cash_low_threshold, 222);
  await run(db, { ...owner, aal: 'aal2' }, `select set_config('request.path', '/account/reset', true), erp_reset_workspace($1, 'all')`, [branch]);
  assert.equal((await get(owner, personal)).cash_low_threshold, 111, 'resetting the branch leaves the personal ERP alone');
});
