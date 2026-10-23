import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let ws;
const hash = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const invite = (who, email, role = 'sales', custom = null) =>
  run(db, who, `select erp_invite_by_email($1, $2, $3, $4, 72, $5) as r`, [ws, email, role, custom, hash()]).then((rows) => rows[0].r);

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'ei-owner');
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces() where is_personal`);
});

test('a new address is refused: accounts are created by ETNA, not by workspaces', async () => {
  await expectError(invite(owner, 'New.Person@Example.test'), /No PrintStream account/);
  assert.equal((await admin(db, `select count(*)::int n from auth.users where email = 'new.person@example.test'`))[0].n, 0);
  // Once ETNA has created the account, the workspace can invite it.
  const person = await createUser(db, 'ei-new-person');
  const r = await invite(owner, person.email);
  assert.equal(r.new_account, false);
  const [inv] = await admin(db, `select email, created_account, role from erp_workspace_invitations where id = $1`, [r.invitation_id]);
  assert.deepEqual([inv.email, inv.created_account, inv.role], [person.email, false, 'sales']);
  const [{ j }] = await run(db, person, `select erp_redeem_workspace_invitation($1) as j`, [r.access_code]);
  assert.equal(j.ok, true);
});

test('an existing account gets only the code; members, closed and internal accounts are refused', async () => {
  const existing = await createUser(db, 'ei-existing');
  const r = await invite(owner, existing.email, 'finance');
  assert.equal(r.new_account, false);
  assert.equal((await admin(db, `select count(*)::int n from etna_platform.password_links where user_id = $1`, [existing.id]))[0].n, 0);
  await expectError(invite(owner, owner.email), /Already a member/);
  const closed = await createUser(db, 'ei-closed');
  await admin(db, `insert into etna_platform.closed_accounts (user_id, reason) values ($1, 'gone')`, [closed.id]);
  await expectError(invite(owner, closed.email), /cannot be invited/);
  await expectError(invite(owner, 'not-an-address'), /valid e-mail/);
});

test('the inviter needs the members permission and cannot give more than they hold', async () => {
  const seller = await createUser(db, 'ei-seller');
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'sales', 24, '')`, [ws]);
  await run(db, seller, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  await expectError(invite(seller, 'x1@example.test'), /not allowed to manage members/);
  const adminUser = await createUser(db, 'ei-admin');
  const [{ access_code: c2 }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'admin', 24, '')`, [ws]);
  await run(db, adminUser, `select erp_redeem_workspace_invitation($1)`, [c2]);
  const target = await createUser(db, 'ei-target');
  await expectError(invite(adminUser, target.email, 'admin'), /cannot grant/);
  // Someone who may not invite does not learn whether an address has an account.
  await expectError(invite(seller, target.email), /not allowed to manage members/);
  await expectError(invite(seller, 'nobody@example.test'), /not allowed to manage members/);
});

test('rollback removes e-mail invitations', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000031_workspace_email_invites.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(`select to_regprocedure('public.erp_invite_by_email(uuid,text,text,uuid,integer,text)') is null as gone`);
  assert.equal(rows[0].gone, true);
  await d.close();
});

test('rollback of 20261012000062 brings back account creation by e-mail', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000062_invite_existing_accounts.sql', import.meta.url), 'utf8'));
  const { rows } = await d.query(
    `select prosrc like '%INSERT INTO auth.users%' as creates from pg_proc where oid = 'public.erp_invite_by_email(uuid,text,text,uuid,integer,text)'::regprocedure`
  );
  assert.equal(rows[0].creates, true);
  await d.close();
});
