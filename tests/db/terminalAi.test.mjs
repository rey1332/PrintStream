import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let adminUser;
let ws;
let ds;
let provider;

const SECRET = 'v1:aXY=:dGFn:Y2lwaGVy';
const asWorker = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role etna_worker');
    return (await tx.query(sql, params)).rows;
  });

async function join(role, name) {
  const user = await createUser(db, name);
  const [{ access_code }] = await run(
    db,
    owner,
    `select access_code from erp_create_workspace_invitation_v2($1, $2, 24, '', null)`,
    [ws, role]
  );
  await run(db, user, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  return user;
}

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'ai-owner');
  [{ workspace_id: ws }] = await run(
    db,
    owner,
    `select workspace_id from erp_my_workspaces() where is_personal`
  );
  await run(db, owner, `select erp_set_terminal($1, true)`, [ws]);
  adminUser = await join('admin', 'ai-admin');
  [{ id: ds }] = await run(
    db,
    owner,
    `select ps_create_dataset($1, 'Payroll', 'HR', '', $2::jsonb) as id`,
    [
      ws,
      JSON.stringify([
        { label: 'month', type: 'date' },
        { label: 'salary', type: 'decimal', sensitive: true },
        { label: 'site', type: 'text' },
      ]),
    ]
  );
});

test('providers: managers with two-factor add them; keys never reach members', async () => {
  const save = (who, secret = SECRET) =>
    run(
      db,
      who,
      `select ps_save_ai_provider($1, null, 'anthropic', 'Claude', '{"model":"claude-sonnet-5-5","price_in":3,"price_out":15}'::jsonb, true, true, $2) as id`,
      [ws, secret]
    );
  await expectError(save({ ...owner, aal: 'aal1' }), /two-factor/);
  [{ id: provider }] = await save(owner);
  const [p] = await run(
    db,
    owner,
    `select kind, has_secret, allow_personal_keys from ps_ai_providers where id = $1`,
    [provider]
  );
  assert.deepEqual(p, { kind: 'anthropic', has_secret: true, allow_personal_keys: true });
  await expectError(run(db, owner, `select * from etna_platform.ai_secrets`), /permission denied/);
  // A member's own key, used only for their runs.
  await run(db, adminUser, `select ps_set_ai_personal_key($1, $2)`, [provider, SECRET]);
  assert.equal(
    (await run(db, adminUser, `select ps_has_ai_personal_key($1) as k`, [provider]))[0].k,
    true
  );
  assert.equal(
    (await run(db, owner, `select ps_has_ai_personal_key($1) as k`, [provider]))[0].k,
    false
  );
  const [{ p: got }] = await asWorker(`select ps_worker.ai_provider_get($1, $2) as p`, [
    provider,
    adminUser.id,
  ]);
  assert.equal(got.secret, SECRET);
  assert.equal(got.personal_secret, SECRET);
  assert.deepEqual(got.budget, { limit: null, spent: 0 });
  // Switching personal keys off removes them.
  await run(
    db,
    owner,
    `select ps_save_ai_provider($1, $2, 'anthropic', 'Claude', null, false, true, null)`,
    [ws, provider]
  );
  assert.equal(
    (await asWorker(`select ps_worker.ai_provider_get($1, $2) as p`, [provider, adminUser.id]))[0].p
      .personal_secret,
    null
  );
  await expectError(
    run(db, adminUser, `select ps_set_ai_personal_key($1, $2)`, [provider, SECRET]),
    /personal keys/
  );
});

test('data sharing is denied until a policy manager allows it', async () => {
  assert.equal((await run(db, owner, `select count(*)::int as n from ps_ai_policies`))[0].n, 0);
  await expectError(
    run(db, { ...adminUser, aal: 'aal1' }, `select ps_set_ai_policy($1, $2, true, '{salary}', 0)`, [
      provider,
      ds,
    ]),
    /two-factor/
  );
  await run(db, adminUser, `select ps_set_ai_policy($1, $2, true, '{salary}', 5)`, [provider, ds]);
  const [pol] = await run(
    db,
    owner,
    `select allowed, sensitive_columns, sample_rows from ps_ai_policies where dataset_id = $1`,
    [ds]
  );
  assert.deepEqual(pol, { allowed: true, sensitive_columns: ['salary'], sample_rows: 5 });
  await expectError(
    run(db, adminUser, `select ps_set_ai_policy($1, $2, true, '{}', 500)`, [provider, ds]),
    /check/
  );
});

test('budget by policy managers; how people analyses are handled, by the Owner only', async () => {
  await expectError(
    run(db, adminUser, `select ps_set_ai_settings($1, 50, 'USD', 'automate')`, [ws]),
    /Only the Owner/
  );
  await run(db, adminUser, `select ps_set_ai_settings($1, 50, 'USD', null)`, [ws]);
  await asWorker(
    `select ps_worker.ai_usage_record($1, $2, null, false, 1000, 100, 1.25, '{}'::jsonb)`,
    [provider, owner.id]
  );
  await asWorker(
    `select ps_worker.ai_usage_record($1, $2, null, true, 1000, 100, 9, '{}'::jsonb)`,
    [provider, adminUser.id]
  );
  const [{ b }] = await run(db, owner, `select ps_ai_budget($1) as b`, [ws]);
  assert.equal(Number(b.limit), 50);
  assert.equal(Number(b.spent), 1.25, 'personal keys are not counted');
  assert.equal(b.people_decisions, 'review');
  // Usage: each member sees their own, policy managers everything.
  const member = await join('sales', 'ai-viewer');
  assert.equal((await run(db, member, `select count(*)::int as n from ps_ai_usage`))[0].n, 0);
  assert.equal((await run(db, adminUser, `select count(*)::int as n from ps_ai_usage`))[0].n, 2);
});

test('decisions: recorded with evidence; about people means a review; someone else reviews', async () => {
  const [{ id }] = await run(
    db,
    owner,
    `select ps_start_decision($1, 'forecast', 'Payroll: sum salary / month', '{"kind":"forecast"}'::jsonb) as id`,
    [ds]
  );
  await run(
    db,
    owner,
    `select ps_finish_decision($1, true, null, 'holt v1', '[{"id":"E1"}]'::jsonb, '{"series":[]}'::jsonb, 0.8, '{"label":"AI inference","summary":"x"}'::jsonb, 'Claude', 'claude-sonnet-5-5', true)`,
    [id]
  );
  const [d] = await run(
    db,
    owner,
    `select status, review_status, about_people, narrative ->> 'label' as label from ps_decisions where id = $1`,
    [id]
  );
  assert.deepEqual(d, {
    status: 'done',
    review_status: 'requested',
    about_people: true,
    label: 'AI inference',
  });
  // Finished once only, by the person who started it.
  await expectError(
    run(
      db,
      owner,
      `select ps_finish_decision($1, true, null, null, null, null, null, null, null, null, false)`,
      [id]
    ),
    /not found/
  );
  await expectError(
    run(db, owner, `select ps_review_decision($1, 'ok')`, [id]),
    /other than the person/
  );
  await run(db, adminUser, `select ps_review_decision($1, 'Checked against payroll')`, [id]);
  const [r] = await run(
    db,
    owner,
    `select review_status, review_note from ps_decisions where id = $1`,
    [id]
  );
  assert.deepEqual(r, { review_status: 'reviewed', review_note: 'Checked against payroll' });
  // The screens name who made and who reviewed it, though profiles are private.
  const { getInsight, listInsights } = await import('../../src/server/terminal/aiService.ts');
  const ctx = {
    executor: { transaction: (fn) => db.transaction((tx) => fn({ query: (t, p) => tx.query(t, p) })) },
    identity: { userId: owner.id, email: owner.email, aal: 'aal2' },
  };
  const [names] = await run(
    db,
    adminUser,
    `select (select coalesce(nullif(full_name, ''), email) from erp_list_workspace_members($1) where user_id = $2) as owner,
            (select coalesce(nullif(full_name, ''), email) from erp_list_workspace_members($1) where user_id = $3) as reviewer`,
    [ws, owner.id, adminUser.id]
  );
  const one = await getInsight(ctx, { id });
  assert.equal(one.created_by_name, names.owner);
  assert.equal(one.reviewed_by_name, names.reviewer);
  assert.ok(names.reviewer && names.reviewer !== names.owner);
  const listed = (await listInsights(ctx, { workspaceId: ws })).find((x) => x.id === id);
  assert.equal(listed.reviewed_by_name, names.reviewer);
  // Anyone who sees it can ask again.
  await run(db, owner, `select ps_request_review($1, 'New month')`, [id]);
  // Members without the dataset see nothing.
  const stranger = await createUser(db, 'ai-stranger');
  assert.equal((await run(db, stranger, `select count(*)::int as n from ps_decisions`))[0].n, 0);
});

test('a dataset says what it holds (ontology)', async () => {
  await run(
    db,
    owner,
    `select ps_set_dataset_entity($1, 'employee', 'Payroll lines', 'site', false, '[]'::jsonb)`,
    [ds]
  );
  const [e] = await run(
    db,
    owner,
    `select entity_type, key_column from ps_dataset_entities where dataset_id = $1`,
    [ds]
  );
  assert.deepEqual(e, { entity_type: 'employee', key_column: 'site' });
  await expectError(
    run(
      db,
      owner,
      `select ps_set_dataset_entity($1, 'employee', null, 'nope', false, '[]'::jsonb)`,
      [ds]
    ),
    /key column/
  );
  await expectError(
    run(
      db,
      owner,
      `select ps_set_dataset_entity($1, 'employee', null, null, false, '[{"column":"site","target_dataset":"00000000-0000-0000-0000-000000000000"}]'::jsonb)`,
      [ds]
    ),
    /does not exist/
  );
  await expectError(
    run(
      db,
      owner,
      `select ps_set_dataset_entity($1, 'bad type!', null, null, false, '[]'::jsonb)`,
      [ds]
    ),
    /check/
  );
  await run(db, owner, `select ps_set_dataset_entity($1, null, null, null, false, null)`, [ds]);
  assert.equal(
    (await run(db, owner, `select count(*)::int as n from ps_dataset_entities`))[0].n,
    0
  );
});

test('AI jobs need their permissions', async () => {
  const viewer = await join('sales', 'ai-viewer2');
  await expectError(
    run(db, viewer, `select ps_enqueue_job($1, 'ai.test', '{}'::jsonb)`, [ws]),
    /permission|not allowed|denied/i
  );
  const [{ id }] = await run(
    db,
    owner,
    `select ps_enqueue_job($1, 'ai.analyze', '{}'::jsonb) as id`,
    [ws]
  );
  assert.ok(id);
});

test('local AI endpoints are set by super admins, loopback only', async () => {
  const sa = await createUser(db, 'ai-sa');
  await admin(db, `select etna_admin.grant_platform_admin($1, 'super_admin')`, [sa.email]);
  const [{ id: sid }] = await admin(
    db,
    `insert into auth.sessions (user_id, token_hash, aal, expires_at, reauthenticated_at) values ($1, md5(random()::text), 'aal2', now() + interval '1 day', now()) returning id`,
    [sa.id]
  );
  const asSa = (sql, params) =>
    db.transaction(async (tx) => {
      await tx.exec('set local role authenticated');
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sa.id]);
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: sa.id, email: sa.email, role: 'authenticated', aal: 'aal2', sid }),
      ]);
      return (await tx.query(sql, params)).rows;
    });
  await expectError(
    asSa(`select etna_platform.admin_set_ai_local_endpoints($1)`, [['10.0.0.5:11434']]),
    /local addresses/
  );
  await asSa(`select etna_platform.admin_set_ai_local_endpoints($1)`, [['localhost:11434']]);
  const [{ p }] = await asWorker(`select ps_worker.ai_provider_get($1, null) as p`, [provider]);
  assert.deepEqual(p.local_endpoints, ['localhost:11434']);
  await expectError(
    run(db, owner, `select etna_platform.admin_set_ai_local_endpoints($1)`, [['localhost:1']]),
    /Not allowed|permission/
  );
});

test('rollback removes the AI tables and functions', async () => {
  const d = await createDb();
  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261012000049_terminal_ai.sql', import.meta.url),
      'utf8'
    )
  );
  const { rows } = await d.query(
    `select to_regclass('public.ps_decisions') is null as gone, to_regclass('etna_platform.ai_secrets') is null as secrets_gone,
            public.ps_job_permission('ai.analyze') is null as job_gone`
  );
  assert.deepEqual(rows[0], { gone: true, secrets_gone: true, job_gone: true });
  await d.close();
});

test('an insight runs end to end: statistics as the person, no narrative without a policy', async () => {
  process.env.MFA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
  const { runAnalysis } = await import('../../src/server/terminal/aiJobs.ts');
  const [{ id: sales }] = await run(
    db,
    owner,
    `select ps_create_dataset($1, 'Sales', 'Ops', '', $2::jsonb) as id`,
    [
      ws,
      JSON.stringify([
        { label: 'day', type: 'date' },
        { label: 'tonnes', type: 'decimal' },
      ]),
    ]
  );
  await db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: owner.id, role: 'authenticated', aal: 'aal2' }),
    ]);
    await tx.exec('set local role etna_worker');
    await tx.query(`select ps_admin.provision_dataset($1)`, [sales]);
  });
  const rows = Array.from({ length: 12 }, (_, i) => ({
    c_1: `2026-${String(i + 1).padStart(2, '0')}-15`,
    c_2: 100 + 10 * i,
  }));
  await run(db, owner, `select ps_rows_write($1, $2::jsonb, 'append', 'import', 'imp-ai')`, [
    sales,
    JSON.stringify(rows),
  ]);
  const input = {
    kind: 'forecast',
    date_column: 'day',
    value_column: 'tonnes',
    measure: 'sum',
    period: 'month',
    horizon: 3,
    provider_id: provider,
    personal: false,
    language: 'en',
  };
  const [{ id }] = await run(
    db,
    owner,
    `select ps_start_decision($1, 'forecast', 'Sales', $2::jsonb) as id`,
    [sales, JSON.stringify(input)]
  );
  const executor = {
    transaction: (fn) =>
      db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })),
  };
  const env = {
    db: (sql, params = []) => asWorker(sql, params),
    executor,
    identity: { userId: owner.id, email: owner.email, aal: 'aal2' },
    beat: async () => false,
    manual: true,
  };
  await runAnalysis(env, { decision_id: id, input });
  const [d] = await run(
    db,
    owner,
    `select status, method, output, narrative, about_people from ps_decisions where id = $1`,
    [id]
  );
  assert.equal(d.status, 'done');
  assert.match(d.method, /holt/);
  assert.equal(d.output.series.length, 12);
  assert.equal(d.output.forecast.length, 3);
  assert.ok(Math.abs(d.output.forecast[0].value - 220) < 5);
  // Sales was never shared with the provider: no call, and the reason is kept.
  assert.deepEqual(d.narrative, { label: 'AI inference', error: 'aiNotAllowed' });
  assert.equal(d.about_people, false);
  const [{ n }] = await admin(
    db,
    `select count(*)::int as n from etna_platform.data_access_log where object_kind = 'dataset' and object_id = $1`,
    [sales]
  );
  assert.ok(n >= 1, 'the read is in the data-access log');
});
