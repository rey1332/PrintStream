import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let sa;
let auditor;

async function openSession(user) {
  const [{ id }] = await admin(
    db,
    `insert into auth.sessions (user_id, token_hash, aal, expires_at, reauthenticated_at)
     values ($1, md5(random()::text), 'aal2', now() + interval '1 day', now()) returning id`,
    [user.id]
  );
  return id;
}

async function makeAdmin(name, role) {
  const user = await createUser(db, name);
  await admin(db, `select etna_admin.grant_platform_admin($1, $2)`, [user.email, role]);
  return { user, sid: await openSession(user) };
}

async function asAdmin(who, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: who.user.id, email: who.user.email, role: 'authenticated', aal: 'aal2', sid: who.sid }),
    ]);
    return (await tx.query(sql, params)).rows;
  });
}

async function asAuthServer(sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role etna_auth');
    return (await tx.query(sql, params)).rows;
  });
}

const checkRequest = (user) => run(db, user, `select erp_check_request()`);
const accept = (user, versionId, workspaceId = null, locale = 'id') =>
  asAuthServer(`select etna_platform.terms_accept($1, $2, $3, $4, null, '203.0.113.4', 'Browser/1.0') as at`, [user.id, versionId, locale, workspaceId]);
const save = (who, id, label, content) =>
  asAdmin(who, `select etna_platform.admin_terms_save($1, $2, $3::jsonb) as id`, [id, label, JSON.stringify(content)]).then((r) => r[0].id);
const publish = (who, id) => asAdmin(who, `select etna_platform.admin_terms_publish($1)`, [id]);

before(async () => {
  db = await createDb();
  sa = await makeAdmin('terms-super', 'super_admin');
  auditor = await makeAdmin('terms-auditor', 'auditor');
});

test('until a version is published nothing is required, and no text ships with ETNA', async () => {
  const user = await createUser(db, 'before-terms');
  await checkRequest(user);
  assert.equal((await asAuthServer(`select etna_platform.terms_current() as t`))[0].t, null);
  assert.equal((await asAuthServer(`select etna_platform.terms_status($1) as s`, [user.id]))[0].s.required, false);
  assert.equal((await admin(db, `select count(*)::int as n from etna_platform.terms_versions`))[0].n, 0);
});

test('drafts: super admins only, English required, unique names, placeholders cannot be published', async () => {
  await expectError(save(auditor, null, 'v0', { en: 'x' }), /Not allowed/);
  await expectError(save(sa, null, 'v0', { id: 'Hanya bahasa Indonesia' }), /English text is required/);
  await expectError(save(sa, null, '', { en: 'x' }), /version name/);

  const draft = await save(sa, null, '2026-10 v0.9', { en: '[PLACEHOLDER - NOT LEGAL TEXT]\nTerms go here.', fr: 'ignored' });
  const [{ admin_terms_get: got }] = await asAdmin(auditor, `select etna_platform.admin_terms_get($1)`, [draft]);
  assert.equal(got.status, 'draft');
  assert.deepEqual(Object.keys(got.content), ['en'], 'only en/id/zh are kept');
  await expectError(publish(sa, draft), /placeholder/);
  await expectError(save(sa, null, '2026-10 V0.9 ', { en: 'other' }), /duplicate|unique/i);

  await save(sa, draft, '2026-10 v0.9', { en: 'Edited draft' });
  await asAdmin(sa, `select etna_platform.admin_terms_delete($1)`, [draft]);
  assert.equal((await admin(db, `select count(*)::int as n from etna_platform.terms_versions where id = $1`, [draft]))[0].n, 0);
});

let v1;

test('publishing makes the version current and blocks every account until it accepts', async () => {
  v1 = await save(sa, null, '2026-10-01 v1.0', { en: 'ETNA terms, version 1.', id: 'Syarat ETNA, versi 1.' });
  const user = await createUser(db, 'must-accept');
  await publish(sa, v1);
  await expectError(publish(sa, v1), /already published/);

  const [{ t: current }] = await asAuthServer(`select etna_platform.terms_current() as t`);
  assert.equal(current.id, v1);
  assert.equal(current.content.id, 'Syarat ETNA, versi 1.');

  await expectError(checkRequest(user), /Terms & Conditions must be accepted/);
  // Through the data API path the app uses: refused with the hint the app reads.
  const { executeSpec } = await import('../../src/server/db/execute.ts');
  const executor = { transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })) };
  const blocked = await executeSpec(executor, { userId: user.id, email: user.email, aal: 'aal1' },
    { kind: 'select', table: 'erp_customers', select: '*', filters: [], order: [] });
  assert.equal(blocked.status, 403);
  assert.match(blocked.error.message, /Terms/);

  const workspace = (await run(db, user, `select workspace_id from erp_my_workspaces() where is_personal`))[0].workspace_id;
  const [{ at }] = await accept(user, v1, workspace);
  assert.ok(at);
  await checkRequest(user);

  const [row] = await admin(db, `select * from etna_platform.terms_acceptances where user_id = $1`, [user.id]);
  assert.equal(row.version_id, v1);
  assert.equal(row.locale, 'id');
  assert.equal(row.workspace_id, workspace);
  assert.equal(row.ip, '203.0.113.4');
  assert.equal(row.method, 'checkbox_and_button');

  // Accepting again changes nothing and is not recorded twice.
  assert.equal((await accept(user, v1))[0].at.toString(), at.toString());
  const events = await admin(db, `select event_type, metadata from etna_platform.security_events where target_user_id = $1 order by id`, [user.id]);
  assert.deepEqual(events.map((e) => e.event_type), ['TERMS_ACCEPTED']);
  assert.equal(events[0].metadata.version, '2026-10-01 v1.0');
});

test('a published version and the acceptances can never be changed or deleted', async () => {
  await expectError(admin(db, `update etna_platform.terms_versions set content = '{"en":"changed"}' where id = $1`, [v1]), /cannot be changed/);
  await expectError(admin(db, `delete from etna_platform.terms_versions where id = $1`, [v1]), /cannot be changed/);
  await expectError(asAdmin(sa, `select etna_platform.admin_terms_delete($1)`, [v1]), /cannot be changed/);
  await expectError(admin(db, `update etna_platform.terms_acceptances set locale = 'en'`), /permanent/);
  await expectError(admin(db, `delete from etna_platform.terms_acceptances`), /permanent/);
  await expectError(admin(db, `truncate etna_platform.terms_acceptances`), /permanent/);
  for (const role of ['authenticated', 'etna_auth', 'anon']) {
    await expectError(db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      await tx.query(`select * from etna_platform.terms_acceptances`);
    }), /permission denied/);
  }
});

test('only the current version can be accepted; the workspace is kept only for a member', async () => {
  const user = await createUser(db, 'stale-accept');
  const draft = await save(sa, null, 'next draft', { en: 'Not yet' });
  await expectError(accept(user, draft), /not the current version/);
  const stranger = await createUser(db, 'other-ws-owner');
  const theirs = (await run(db, stranger, `select workspace_id from erp_my_workspaces() where is_personal`))[0].workspace_id;
  await accept(user, v1, theirs);
  const [row] = await admin(db, `select workspace_id from etna_platform.terms_acceptances where user_id = $1`, [user.id]);
  assert.equal(row.workspace_id, null);
  await asAdmin(sa, `select etna_platform.admin_terms_delete($1)`, [draft]);
});

test('a new version asks everyone again; admins see who has not accepted and each account history', async () => {
  const user = await createUser(db, 'reaccept');
  await accept(user, v1);
  await checkRequest(user);

  const v2 = await save(sa, null, '2027-01-01 v2.0', { en: 'ETNA terms, version 2.' });
  await publish(sa, v2);
  await expectError(checkRequest(user), /must be accepted/);
  assert.equal((await asAuthServer(`select etna_platform.terms_status($1) as s`, [user.id]))[0].s.required, true);

  const pending = await asAdmin(auditor, `select * from etna_platform.admin_terms_pending(200, 0)`);
  const mine = pending.find((p) => p.user_id === user.id);
  assert.equal(mine.last_accepted, '2026-10-01 v1.0');
  assert.ok(Number(pending[0].total) >= 1);

  await accept(user, v2, null, 'en');
  assert.equal((await asAdmin(auditor, `select * from etna_platform.admin_terms_pending(200, 0)`)).some((p) => p.user_id === user.id), false);
  const history = await asAdmin(auditor, `select label, locale from etna_platform.admin_user_terms($1)`, [user.id]);
  assert.deepEqual(history.map((h) => h.label), ['2027-01-01 v2.0', '2026-10-01 v1.0']);

  const list = await asAdmin(auditor, `select label, status, acceptances from etna_platform.admin_terms_list()`);
  assert.equal(list.find((v) => v.label === '2027-01-01 v2.0').status, 'current');
  assert.equal(list.find((v) => v.label === '2026-10-01 v1.0').status, 'previous');

  const trail = await admin(db, `select event_type from etna_platform.security_events where event_type like 'TERMS_%' and actor_kind = 'admin' order by id`);
  assert.ok(trail.some((e) => e.event_type === 'TERMS_PUBLISHED'));
  assert.ok(trail.some((e) => e.event_type === 'TERMS_DRAFT_SAVED'));
  assert.ok(trail.some((e) => e.event_type === 'TERMS_DRAFT_DELETED'));
});

test('admins must accept too, before the admin functions answer', async () => {
  const fresh = await makeAdmin('terms-new-admin', 'auditor');
  await expectError(db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: fresh.user.id, email: fresh.user.email, role: 'authenticated', aal: 'aal2', sid: fresh.sid }),
    ]);
    await tx.query(`select erp_check_request()`);
  }), /must be accepted/);
});

test('rollback removes the requirement and the records', async () => {
  const d = await createDb();
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000013_platform_terms.sql', import.meta.url), 'utf8'));
  const [state] = (await d.query(`select to_regclass('etna_platform.terms_versions') is null as gone,
      to_regprocedure('etna_platform.terms_accept(uuid,uuid,text,uuid,uuid,text,text)') is null as fn_gone`)).rows;
  assert.deepEqual(state, { gone: true, fn_gone: true });
  const [{ id }] = (await d.query(`insert into auth.users (email) values ('after@example.test') returning id`)).rows;
  await d.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: id, role: 'authenticated' })]);
    await tx.query(`select erp_check_request()`);
  });
  await d.close();
});
