import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { listMigrations, migrate, plan } from '../../scripts/db/migrator.mjs';

let db;
let applied;
const adapter = (database) => ({
  exec: (sql) => database.exec(sql),
  query: (sql, params) => database.query(sql, params),
});

async function asUser(user, fn, { aal = 'aal1' } = {}) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role etna_app');
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: user.id, email: user.email, role: 'authenticated', aal }),
    ]);
    return fn((sql, params = []) => tx.query(sql, params).then((r) => r.rows));
  });
}

async function createUser(name) {
  const { rows } = await db.query(
    `insert into auth.users (email, encrypted_password, raw_user_meta_data)
     values ($1, extensions.crypt('not-a-real-password', extensions.gen_salt('bf', 4)), jsonb_build_object('full_name', $2::text))
     returning id, email`,
    [`${name}@example.test`, name]
  );
  return rows[0];
}

before(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  applied = await migrate(adapter(db));
});

test('bootstrap and every migration apply to plain PostgreSQL', () => {
  const all = listMigrations().map((m) => m.name);
  assert.deepEqual(applied, all);
  assert.equal(applied[0], 'bootstrap/0000_postgres_bootstrap.sql');
});

test('a second run applies nothing; a changed file is refused', async () => {
  assert.deepEqual(await migrate(adapter(db)), []);
  const edited = listMigrations().map((m, i) => (i === 3 ? { ...m, checksum: 'edited' } : m));
  await assert.rejects(migrate(adapter(db), { migrations: edited }), /changed on disk/);
});

test('no demo account with a known password is created', async () => {
  const { rows } = await db.query(`select count(*)::int as n from auth.users where email ilike 'demo@%'`);
  assert.equal(rows[0].n, 0);
});

test('a new user gets a profile and a personal workspace (existing triggers)', async () => {
  const user = await createUser('boot-owner');
  const profile = await db.query('select email from public.user_profiles where id = $1', [user.id]);
  assert.equal(profile.rows[0]?.email, user.email);
  const workspaces = await asUser(user, (q) => q('select workspace_id from erp_my_workspaces()'));
  assert.equal(workspaces.length, 1);
});

test('the app role is denied everything until it takes on a user (fail closed)', async () => {
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.exec('set local role etna_app');
      await tx.query('select count(*) from public.erp_customers');
    }),
    /permission denied/
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.exec('set local role etna_app');
      await tx.query('select count(*) from auth.users');
    }),
    /permission denied/
  );
});

test('row-level security keeps users apart under the new role setup', async () => {
  const alice = await createUser('boot-alice');
  const bob = await createUser('boot-bob');
  await asUser(alice, (q) => q(`insert into erp_customers (user_id, name) values ($1, 'Alice Co')`, [alice.id]));
  await asUser(bob, (q) => q(`insert into erp_customers (user_id, name) values ($1, 'Bob Co')`, [bob.id]));
  const seenByAlice = await asUser(alice, (q) => q('select name from erp_customers order by name'));
  assert.deepEqual(seenByAlice.map((r) => r.name), ['Alice Co']);
  // Writing into someone else's rows is refused too.
  await assert.rejects(
    asUser(alice, (q) => q(`insert into erp_customers (user_id, name) values ($1, 'Sneaky')`, [bob.id])),
    /row-level security|violates/
  );
  // Without claims, authenticated sees nothing.
  const anonymous = await db.transaction(async (tx) => {
    await tx.exec('set local role etna_app');
    await tx.exec('set local role authenticated');
    return (await tx.query('select count(*)::int as n from erp_customers')).rows[0].n;
  });
  assert.equal(anonymous, 0);
});

test('claims do not leak between transactions', async () => {
  const user = await createUser('boot-claims');
  await asUser(user, (q) => q('select 1'));
  const { rows } = await db.query(`select auth.uid() as uid, current_setting('request.jwt.claims', true) as claims`);
  assert.equal(rows[0].uid, null);
  assert.ok(!rows[0].claims, 'claims are reset after the transaction');
});

test('two-factor rules keep working on the new auth schema', async () => {
  const user = await createUser('boot-mfa');
  await db.query(`insert into auth.mfa_factors (user_id, friendly_name, status) values ($1, 'phone', 'verified')`, [user.id]);
  await assert.rejects(asUser(user, (q) => q('select erp_check_request()')), /Two-factor verification required/);
  await asUser(user, (q) => q('select erp_check_request()'), { aal: 'aal2' });
  const codes = await asUser(user, (q) => q('select code from erp_mfa_generate_recovery_codes()'), { aal: 'aal2' });
  assert.equal(codes.length, 10);
  const [{ result }] = await asUser(user, (q) => q('select erp_mfa_use_recovery_code($1) as result', [codes[0].code]));
  assert.equal(result, 'ok');
  const left = await db.query('select count(*)::int as n from auth.mfa_factors where user_id = $1', [user.id]);
  assert.equal(left.rows[0].n, 0);
});

test('the runner refuses a Supabase database', async () => {
  const other = new PGlite();
  await other.exec('create role supabase_auth_admin nologin');
  await assert.rejects(migrate(adapter(other)), /Supabase project/);
  const { rows } = await other.query(`select to_regclass('etna_meta.schema_migrations') as t`);
  assert.equal(rows[0].t, null, 'nothing was created');
});

test('plan() lists pending files and detects changed ones', () => {
  const files = [{ name: 'a', checksum: '1' }, { name: 'b', checksum: '2' }];
  assert.deepEqual(plan(files, [{ name: 'a', checksum: '1' }]).pending.map((m) => m.name), ['b']);
  assert.deepEqual(plan(files, [{ name: 'a', checksum: 'x' }]).changed.map((m) => m.name), ['a']);
});
