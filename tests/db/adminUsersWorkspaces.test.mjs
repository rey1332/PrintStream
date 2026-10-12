import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;

const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

async function openSession(user, { reauthenticated = true } = {}) {
  const [{ id }] = await admin(
    db,
    `insert into auth.sessions (user_id, token_hash, aal, expires_at, reauthenticated_at)
     values ($1, md5(random()::text), 'aal2', now() + interval '1 day', case when $2 then now() end) returning id`,
    [user.id, reauthenticated]
  );
  return id;
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

async function makeAdmin(name, role) {
  const user = await createUser(db, name);
  await admin(db, `select etna_admin.grant_platform_admin($1, $2)`, [user.email, role]);
  return { user, sid: await openSession(user) };
}

const eventsFor = async (userId) =>
  (await admin(db, `select event_type, actor_kind, workspace_id, metadata from etna_platform.security_events where target_user_id = $1 order by id`, [userId]));
const disabled = async (userId) =>
  (await admin(db, `select coalesce(banned_until > now(), false) as d from auth.users where id = $1`, [userId]))[0].d;
const liveSessions = async (userId) =>
  (await admin(db, `select count(*)::int as n from auth.sessions where user_id = $1 and revoked_at is null`, [userId]))[0].n;
const personalWorkspace = async (user) =>
  (await run(db, user, `select workspace_id from erp_my_workspaces() where is_personal`))[0].workspace_id;

let sa;
let support;
let auditor;

before(async () => {
  db = await createDb();
  sa = await makeAdmin('p2-super', 'super_admin');
  support = await makeAdmin('p2-support', 'support');
  auditor = await makeAdmin('p2-auditor', 'auditor');
});

test('accounts list: people only, searchable and filtered, for every admin role', async () => {
  const person = await createUser(db, 'listed-person');
  await admin(db, `insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), 'container@erp.internal', '{"etna_kind":"erp_container"}')`);

  const rows = await asAdmin(auditor, `select * from etna_platform.admin_list_users($1)`, ['listed-person']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, person.email);
  assert.equal(rows[0].workspaces, 1, 'the personal workspace');
  assert.equal(Number(rows[0].total), 1);
  assert.equal((await asAdmin(support, `select * from etna_platform.admin_list_users('container@erp')`)).length, 0);
  const admins = await asAdmin(sa, `select email, admin_role from etna_platform.admin_list_users(null, 'admins', 200)`);
  assert.ok(admins.some((r) => r.email === support.user.email && r.admin_role === 'support'));
  await expectError(asAdmin(sa, `select * from etna_platform.admin_list_users(null, 'everyone')`), /Unknown filter/);
  await expectError(run(db, person, `select * from etna_platform.admin_list_users()`), /Not allowed/);

  const [{ admin_user_detail: detail }] = await asAdmin(auditor, `select etna_platform.admin_user_detail($1)`, [person.id]);
  assert.equal(detail.user.email, person.email);
  assert.equal(detail.workspaces.length, 1);
  assert.equal(detail.workspaces[0].is_personal, true);
  const [{ id: containerId }] = await admin(db, `select id from auth.users where email = 'container@erp.internal'`);
  await expectError(asAdmin(auditor, `select etna_platform.admin_user_detail($1)`, [containerId]), /No such account/);
});

test('disable and enable: support may, with a reason and a fresh code; sessions and open links end', async () => {
  const person = await createUser(db, 'to-disable');
  await openSession(person);
  await asAdmin(support, `select etna_platform.admin_create_reset_link($1, $2)`, [person.id, tokenHash(newToken())]);

  await expectError(asAdmin(auditor, `select etna_platform.admin_disable_user($1, 'abuse')`, [person.id]), /Not allowed/);
  const stale = { user: support.user, sid: await openSession(support.user, { reauthenticated: false }) };
  await expectError(asAdmin(stale, `select etna_platform.admin_disable_user($1, 'abuse')`, [person.id]), /two-factor code first/);
  await expectError(asAdmin(support, `select etna_platform.admin_disable_user($1, '')`, [person.id]), /reason/);

  await asAdmin(support, `select etna_platform.admin_disable_user($1, 'Chargeback dispute')`, [person.id]);
  assert.equal(await disabled(person.id), true);
  assert.equal(await liveSessions(person.id), 0);
  assert.equal((await admin(db, `select count(*)::int as n from etna_platform.password_links where user_id = $1 and revoked_at is null`, [person.id]))[0].n, 0);

  await asAdmin(support, `select etna_platform.admin_enable_user($1)`, [person.id]);
  assert.equal(await disabled(person.id), false);
  const trail = await eventsFor(person.id);
  assert.deepEqual(trail.map((e) => e.event_type), ['ADMIN_PASSWORD_RESET_INITIATED', 'USER_DISABLED', 'USER_ENABLED']);
  assert.equal(trail[1].metadata.reason, 'Chargeback dispute');
});

test('admins cannot act on themselves, and only super admins act on other admins', async () => {
  await expectError(asAdmin(support, `select etna_platform.admin_disable_user($1, 'oops')`, [support.user.id]), /own account/);
  await expectError(asAdmin(sa, `select etna_platform.admin_reset_mfa($1, 'checked on a video call')`, [sa.user.id]), /own account/);
  await expectError(asAdmin(support, `select etna_platform.admin_disable_user($1, 'takeover')`, [auditor.user.id]), /super admin/);
  await expectError(asAdmin(support, `select etna_platform.admin_create_reset_link($1, $2)`, [sa.user.id, tokenHash(newToken())]), /super admin/);

  const victim = await makeAdmin('p2-other-auditor', 'auditor');
  await asAdmin(sa, `select etna_platform.admin_disable_user($1, 'left the company')`, [victim.user.id]);
  assert.equal(await disabled(victim.user.id), true);
  // Ending one's own sessions is allowed (for example after a lost laptop).
  assert.equal((await asAdmin(sa, `select etna_platform.admin_end_sessions($1, $2) as n`, [sa.user.id, await openSession(sa.user)]))[0].n, 1);
});

test('sessions: end one or all', async () => {
  const person = await createUser(db, 'sessions');
  const first = await openSession(person);
  await openSession(person);
  assert.equal((await asAdmin(support, `select etna_platform.admin_end_sessions($1, $2) as n`, [person.id, first]))[0].n, 1);
  assert.equal(await liveSessions(person.id), 1);
  assert.equal((await asAdmin(support, `select etna_platform.admin_end_sessions($1) as n`, [person.id]))[0].n, 1);
  assert.equal(await liveSessions(person.id), 0);
});

test('reset links: only the hash is stored, one open link at a time, used once, never after expiry', async () => {
  const person = await createUser(db, 'reset-me');
  await expectError(asAdmin(support, `select etna_platform.admin_create_reset_link($1, 'not-a-hash')`, [person.id]), /Invalid link/);

  const oldToken = newToken();
  await asAdmin(support, `select etna_platform.admin_create_reset_link($1, $2)`, [person.id, tokenHash(oldToken)]);
  const token = newToken();
  const [{ admin_create_reset_link: link }] = await asAdmin(support, `select etna_platform.admin_create_reset_link($1, $2)`, [person.id, tokenHash(token)]);
  assert.equal(link.purpose, 'reset');
  assert.ok(new Date(link.expires_at) - Date.now() > 23 * 3600_000);

  const stored = JSON.stringify(await admin(db, `select * from etna_platform.password_links where user_id = $1`, [person.id]));
  assert.equal(stored.includes(token), false);
  assert.equal((await asAuthServer(`select etna_platform.password_link_check($1) as l`, [tokenHash(oldToken)]))[0].l, null, 'the older link was cancelled');
  assert.equal((await asAuthServer(`select etna_platform.password_link_check($1) as l`, [tokenHash(token)]))[0].l.email, person.email);

  const [{ l: used }] = await asAuthServer(`select etna_platform.password_link_use($1) as l`, [tokenHash(token)]);
  assert.equal(used.user_id, person.id);
  assert.equal((await asAuthServer(`select etna_platform.password_link_use($1) as l`, [tokenHash(token)]))[0].l, null, 'only once');

  const late = newToken();
  await asAdmin(support, `select etna_platform.admin_create_reset_link($1, $2)`, [person.id, tokenHash(late)]);
  await admin(db, `update etna_platform.password_links set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where token_hash = $1`, [tokenHash(late)]);
  assert.equal((await asAuthServer(`select etna_platform.password_link_use($1) as l`, [tokenHash(late)]))[0].l, null, 'expired');

  // Only the sign-in server reads links; signed-in users cannot.
  await expectError(run(db, person, `select etna_platform.password_link_check($1)`, [tokenHash(token)]), /permission denied/);
  await expectError(run(db, person, `select * from etna_platform.password_links`), /permission denied/);
});

test('two-factor reset needs a written verification note', async () => {
  const person = await createUser(db, 'lost-phone');
  await admin(db, `insert into auth.mfa_factors (user_id, friendly_name, status) values ($1, 'phone', 'verified')`, [person.id]);
  await expectError(asAdmin(support, `select etna_platform.admin_reset_mfa($1, 'ok')`, [person.id]), /verified/);
  const [{ n }] = await asAdmin(support, `select etna_platform.admin_reset_mfa($1, 'Video call, matched ID card') as n`, [person.id]);
  assert.equal(n, 1);
  const [event] = (await eventsFor(person.id)).filter((e) => e.event_type === 'MFA_RESET');
  assert.equal(event.metadata.verification, 'Video call, matched ID card');
});

test('creating an account gives it no password, only an invite link', async () => {
  const token = newToken();
  const [{ admin_create_user: made }] = await asAdmin(support, `select etna_platform.admin_create_user('new.hire@example.test', 'New Hire', $1)`, [tokenHash(token)]);
  assert.equal(made.purpose, 'invite');
  const [account] = await admin(db, `select encrypted_password, raw_user_meta_data ->> 'full_name' as name from auth.users where id = $1`, [made.user_id]);
  assert.equal(account.encrypted_password, null);
  assert.equal(account.name, 'New Hire');
  assert.equal((await asAuthServer(`select etna_platform.password_link_check($1) as l`, [tokenHash(token)]))[0].l.purpose, 'invite');
  await expectError(asAdmin(support, `select etna_platform.admin_create_user('NEW.HIRE@example.test', '', $1)`, [tokenHash(newToken())]), /already exists/);
  await expectError(asAdmin(auditor, `select etna_platform.admin_create_user('x@example.test', '', $1)`, [tokenHash(newToken())]), /Not allowed/);
  assert.deepEqual((await eventsFor(made.user_id)).map((e) => e.event_type), ['USER_CREATED']);
});

test('a suspended workspace is closed to every member, in every table and function', async () => {
  const owner = await createUser(db, 'suspended-owner');
  const ws = await personalWorkspace(owner);
  await run(db, owner, `insert into erp_customers (user_id, name) values ($1, 'Cust')`, [owner.id]);
  await run(db, owner, `select erp_create_invoice_v5(null, null, 'Walk-in', current_date, current_date + 7, 50, 0, null, null)`);
  const bystander = await createUser(db, 'bystander');
  await run(db, bystander, `insert into erp_customers (user_id, name) values ($1, 'Other')`, [bystander.id]);

  const tables = (await admin(db, `select c.table_name from information_schema.columns c
     join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = 'public' and c.column_name = 'workspace_id' order by 1`)).map((r) => r.table_name);
  const visible = async () => {
    const counts = {};
    for (const table of tables) {
      try {
        counts[table] = (await run(db, owner, `select count(*)::int as n from public.${table} where workspace_id = $1`, [ws]))[0].n;
      } catch {
        counts[table] = 0; // no read grant at all
      }
    }
    return counts;
  };
  const before = await visible();
  assert.ok(before.erp_customers >= 1 && before.erp_invoices >= 1);

  await expectError(asAdmin(support, `select etna_platform.admin_suspend_workspace($1, 'Unpaid')`, [ws]), /Not allowed/);
  await asAdmin(sa, `select etna_platform.admin_suspend_workspace($1, 'Unpaid invoices')`, [ws]);
  await expectError(asAdmin(sa, `select etna_platform.admin_suspend_workspace($1, 'again')`, [ws]), /already suspended/);

  const after = await visible();
  // Members still see that they belong to it (their own membership row).
  const leaking = Object.entries(after)
    .filter(([table, n]) => n > 0 && table !== 'erp_workspace_members')
    .map(([t]) => t);
  assert.deepEqual(leaking, [], 'no workspace rows are readable while suspended');
  await expectError(run(db, owner, `select erp_create_invoice_v5(null, null, 'Walk-in', current_date, current_date + 7, 10, 0, null, null)`), /./);
  await expectError(run(db, owner, `update erp_customers set name = 'Changed' where workspace_id = $1`, [ws]).then(async () => {
    if ((await admin(db, `select count(*)::int as n from erp_customers where workspace_id = $1 and name = 'Changed'`, [ws]))[0].n === 0) throw new Error('not changed');
  }), /not changed/);
  // The ERP's own functions (SECURITY DEFINER, so not covered by row-level security).
  // Summaries run as the caller, so row-level security leaves them nothing to count.
  const [{ r: metrics }] = await run(db, owner, `select erp_dashboard_metrics($1) as r`, [ws]);
  assert.equal(metrics.invoicedRevenue, 0);
  const [{ r: invoices }] = await run(db, owner, `select erp_list_summary($1, 'invoices') as r`, [ws]);
  assert.equal(invoices.count, 0);
  const calls = [
    `select erp_documents_list($1)`,
    `select erp_hr_employees($1, true)`, `select erp_trial_balance($1, null, null)`,
    `select erp_journal_list($1, null, null, null, 50, 0)`,
    `select erp_ontology_search($1, null, null, null, null, null, null, null, null, 20, 0)`,
    `select erp_accounting_settings_get($1)`, `select erp_company_profile_get($1)`, `select erp_workspace_settings_get($1)`,
  ];
  const open = [];
  for (const sql of calls) {
    try {
      await run(db, owner, sql, [ws]);
      open.push(sql);
    } catch {
      // refused: as it should be
    }
  }
  assert.deepEqual(open, [], 'ERP functions refuse a suspended workspace');
  assert.deepEqual((await run(db, owner, `select erp_my_suspended_workspaces() as id`)).map((r) => r.id), [ws]);
  assert.equal(await disabled(owner.id), false, 'the account itself stays usable');
  // As the ERP asks for it, through the data API (WorkspaceContext).
  const { executeSpec } = await import('../../src/server/db/execute.ts');
  const executor = { transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })) };
  const viaApi = await executeSpec(executor, { userId: owner.id, email: owner.email, aal: 'aal1' }, {
    kind: 'rpc', fn: 'erp_my_suspended_workspaces', args: {}, filters: [], order: [],
  });
  assert.deepEqual(viaApi.data, [{ workspace_id: ws }]);
  assert.equal((await run(db, bystander, `select count(*)::int as n from erp_customers`))[0].n, 1, 'other workspaces are untouched');

  await asAdmin(sa, `select etna_platform.admin_reactivate_workspace($1)`, [ws]);
  assert.deepEqual(await visible(), before);
  assert.deepEqual(await run(db, owner, `select erp_my_suspended_workspaces() as id`), []);
  const trail = await admin(db, `select event_type from etna_platform.security_events where workspace_id = $1 order by id`, [ws]);
  assert.deepEqual(trail.map((e) => e.event_type), ['WORKSPACE_SUSPENDED', 'WORKSPACE_REACTIVATED']);
});

test('every workspace table carries the suspension policy (new tables too)', async () => {
  const missing = await admin(db, `select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> 'erp_workspace_members'
       and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
                        and p.policyname = 'erp_workspace_not_suspended' and p.permissive = 'RESTRICTIVE')
     order by 1`);
  assert.deepEqual(missing.map((r) => r.relname), [], 'a new table with workspace_id needs the erp_workspace_not_suspended policy');
  // The suspended list is worked out once per query, not once per row.
  const someone = await createUser(db, 'plan-check');
  const plan = (await run(db, someone, `explain select * from erp_customers`)).map((r) => r['QUERY PLAN']).join('\n');
  assert.match(plan, /workspace_id <> ALL \(\(InitPlan \d+\)/);
});

test('suspending can also disable the members; reactivating can enable them again', async () => {
  const owner = await createUser(db, 'team-owner');
  const ws = await personalWorkspace(owner);
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'finance', 24, '')`, [ws]);
  const colleague = await createUser(db, 'team-colleague');
  await run(db, colleague, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  await openSession(colleague);
  // A platform admin who is also a member is never disabled this way.
  const [{ access_code: code2 }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'finance', 24, '')`, [ws]);
  await run(db, auditor.user, `select erp_redeem_workspace_invitation($1)`, [code2]);

  const [{ n }] = await asAdmin(sa, `select etna_platform.admin_suspend_workspace($1, 'Fraud investigation', true) as n`, [ws]);
  assert.equal(n, 2);
  assert.equal(await disabled(owner.id), true);
  assert.equal(await disabled(colleague.id), true);
  assert.equal(await disabled(auditor.user.id), false);
  assert.equal(await liveSessions(colleague.id), 0);

  const [{ admin_workspace_detail: detail }] = await asAdmin(auditor, `select etna_platform.admin_workspace_detail($1)`, [ws]);
  assert.equal(detail.workspace.suspended, true);
  assert.equal(detail.suspensions[0].disabled_members, 2);
  assert.equal(detail.members.length, 3);

  const [{ n: back }] = await asAdmin(sa, `select etna_platform.admin_reactivate_workspace($1, true) as n`, [ws]);
  assert.equal(back, 2);
  assert.equal(await disabled(owner.id), false);
  assert.equal(await disabled(colleague.id), false);
});

test('workspace list: search, filters, and the creator of ERPs that belong to a container account', async () => {
  const owner = await createUser(db, 'listed-workspace-owner');
  await run(db, owner, `select erp_rename_workspace($1, 'Acme Trading')`, [await personalWorkspace(owner)]);
  const rows = await asAdmin(auditor, `select * from etna_platform.admin_list_workspaces('acme trading')`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_email, owner.email);
  assert.equal(rows[0].members, 1);
  assert.equal(rows[0].suspended, false);
  assert.equal((await asAdmin(auditor, `select * from etna_platform.admin_list_workspaces('acme trading', 'shared')`)).length, 0);
  await expectError(run(db, owner, `select * from etna_platform.admin_list_workspaces()`), /Not allowed/);
});

test('rollback lifts suspensions and restores the phase 1 functions', async () => {
  // Rollbacks run newest first: this one on the schema as of its migration.
  const d = await createDb({ through: '20261012000012' });
  const [{ id }] = (await d.query(`insert into auth.users (email) values ('rb@example.test') returning id`)).rows;
  const [{ ws }] = (await d.query(`select id as ws from erp_workspaces where owner_id = $1`, [id])).rows;
  await d.query(`insert into etna_platform.workspace_suspensions (workspace_id, reason) values ($1, 'test')`, [ws]);
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000012_platform_admin_users_workspaces.sql', import.meta.url), 'utf8'));
  const [state] = (await d.query(`select to_regclass('etna_platform.workspace_suspensions') is null as gone,
      to_regprocedure('etna_platform.admin_security_events(bigint,integer,text,text,text,timestamptz,timestamptz)') is not null as old_log,
      to_regprocedure('public.erp_my_suspended_workspaces()') is null as fn_gone`)).rows;
  assert.deepEqual(state, { gone: true, old_log: true, fn_gone: true });
  const role = await d.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: id, role: 'authenticated' })]);
    return (await tx.query(`select erp_workspace_role($1) as r`, [ws])).rows[0].r;
  });
  assert.equal(role, 'owner');
  await d.close();
});
