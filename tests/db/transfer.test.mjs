import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createDb, run, admin } from './harness.mjs';
import {
  authSummary, decryptBuffer, encryptBuffer, importData, listTables, orphanCheck, readAuth, readTable, tableChecksums,
} from '../../scripts/db/transfer-core.mjs';
import { signIn, verifyFactor, resolveSession } from '../../src/server/auth/service.ts';
import { sealSecret } from '../../src/server/auth/secret-box.ts';
import { base32Decode, base32Encode, currentStep, hotp } from '../../src/server/auth/totp.ts';
import { executeSpec } from '../../src/server/db/execute.ts';
import { RestClient } from '../../src/lib/db/rest-client.ts';

const client = (db) => ({ query: (sql, params) => db.query(sql, params) });
const executor = (db) => ({ transaction: (fn) => db.transaction((tx) => fn({ query: (t, p) => tx.query(t, p) })) });
const mfaKey = randomBytes(32);

let source;
let target;
let report;
let owner;
let locked;
const ownerSecret = base32Encode(randomBytes(20));

async function supabaseUser(db, email, password) {
  const id = (await db.query('select gen_random_uuid() as id')).rows[0].id;
  await db.query(
    `insert into auth.users (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at) values ($1, $2, $3, '{"full_name":"Migrated"}', now(), now())`,
    [id, email, bcrypt.hashSync(password, 4).replace(/^\$2b\$/, '$2a$')]
  );
  return { id, email, name: email, password };
}

before(async () => {
  // Source: Supabase stubs + the real migrations, with Supabase's plain `secret` column.
  source = await createDb({ target: 'supabase' });
  await source.exec(`alter table auth.mfa_factors add column secret text; alter table auth.users add column updated_at timestamptz, add column last_sign_in_at timestamptz, add column banned_until timestamptz`).catch(async () => {
    await source.exec('alter table auth.mfa_factors add column if not exists secret text');
  });
  owner = await supabaseUser(source, 'owner@migrated.test', 'owner-password-1');
  locked = await supabaseUser(source, 'encrypted-2fa@migrated.test', 'second-password-2');
  await admin(source, `insert into auth.mfa_factors (user_id, friendly_name, status, secret) values ($1, 'Phone', 'verified', $2)`, [owner.id, ownerSecret]);
  // A device whose secret Supabase stored encrypted (cannot be carried over).
  await admin(source, `insert into auth.mfa_factors (user_id, friendly_name, status, secret) values ($1, 'Phone', 'verified', '{"key_id":"x","data":"y"}')`, [locked.id]);

  // Business activity through the ERP functions (triggers post journals, stock, audit).
  const as = { ...owner, aal: 'aal2' };
  await run(source, as, `insert into erp_customers (user_id, name, balance) values ($1, 'Acme', 12.5)`, [owner.id]);
  const [{ id: product }] = await run(source, as, `insert into erp_products (user_id, name, sku, purchase_price, selling_price, current_stock) values ($1, 'Bolt', 'B-1', 2.5, 4, 0) returning id`, [owner.id]);
  const [{ id: po }] = await run(source, as, `select erp_create_purchase_order_v3(null, null, 'Supplier', current_date, '', $1::jsonb, null, null) as id`, [JSON.stringify([{ product_id: product, product_name: 'Bolt', qty: 10, price: 2.5 }])]);
  await run(source, as, `select erp_update_purchase_order_status($1, 'approved')`, [po]);
  const [{ id: item }] = await admin(source, 'select id from erp_purchase_order_items where purchase_order_id = $1', [po]);
  await run(source, as, `select erp_record_purchase_receipt_v2($1, $2::jsonb, gen_random_uuid(), '', null)`, [po, JSON.stringify([{ item_id: item, qty: 10 }])]);
  const [{ id: invoice }] = await run(source, as, `select erp_create_invoice_v5(null, null, 'Acme', '2026-09-01', '2026-09-30', 100, 0, null, null) as id`);
  await run(source, as, `insert into erp_payments (user_id, payment_type, party, amount, invoice_id) values ($1, 'incoming', 'Acme', 40.25, $2)`, [owner.id, invoice]);

  // Export (as the CLI does: tables in pk order, auth, checksums), through encryption.
  const tables = await listTables(client(source));
  const exported = new Map();
  for (const table of tables) {
    const rows = [];
    await readTable(client(source), table, (batch) => { rows.push(...batch); }, 3);
    const passphrase = 'correct horse battery staple';
    const text = decryptBuffer(encryptBuffer(Buffer.from(rows.join('\n')), passphrase), passphrase).toString();
    exported.set(table.name, text ? text.split('\n') : []);
  }
  const auth = await readAuth(client(source));

  target = await createDb({ target: 'postgres' });
  report = await importData(client(target), { auth, tables: exported }, { sealSecret: (plain) => sealSecret(plain, mfaKey) });
});

test('every table arrives unchanged (row counts and checksums), with no orphaned references', async () => {
  const tables = await listTables(client(source));
  const shared = new Map(tables.map((t) => [t.name, t.columns.map((c) => c.name)]));
  const a = await tableChecksums(client(source), tables, shared);
  const b = await tableChecksums(client(target), tables, shared);
  for (const t of tables) assert.deepEqual(b[t.name], a[t.name], `table ${t.name}`);
  assert.ok(a.erp_journal_lines.rows > 0 && a.erp_stock_movements.rows > 0, 'the source had real activity');
  assert.deepEqual(await orphanCheck(client(target)), []);
  assert.equal((await authSummary(client(target))).users_checksum, (await authSummary(client(source))).users_checksum);
});

test('triggers did not run again: journals and stock are not doubled', async () => {
  const count = async (db, sql) => (await db.query(sql)).rows[0].n;
  assert.equal(await count(target, 'select count(*)::int as n from erp_journal_entries'), await count(source, 'select count(*)::int as n from erp_journal_entries'));
  const [{ current_stock }] = (await target.query(`select current_stock::float8 as current_stock from erp_products where sku = 'B-1'`)).rows;
  assert.equal(current_stock, 10);
  const [{ d, c }] = (await target.query('select sum(debit)::numeric as d, sum(credit)::numeric as c from erp_journal_lines')).rows;
  assert.equal(String(d), String(c), 'ledger still balances');
});

test('people sign in with their old passwords and old authenticator', async () => {
  const deps = { executor: executor(target), mfaKey };
  const result = await signIn(deps, { email: owner.email, password: owner.password, ip: null, userAgent: null });
  assert.equal(result.ok, true);
  assert.equal(result.session.nextLevel, 'aal2', 'the device came along');
  const [{ id: factorId }] = (await target.query('select id from auth.mfa_factors where user_id = $1', [owner.id])).rows;
  const code = hotp(base32Decode(ownerSecret), currentStep());
  const { token } = await verifyFactor(deps, result.session, factorId, code);
  const session = await resolveSession(deps, token);
  assert.equal(session.aal, 'aal2');
  const data = new RestClient((spec) => executeSpec(executor(target), { userId: session.userId, email: session.email, aal: 'aal2' }, spec));
  const { data: customers } = await data.from('erp_customers').select('name, balance');
  assert.deepEqual(customers, [{ name: 'Acme', balance: 12.5 }]);
  const { data: payments } = await data.from('erp_payments').select('amount');
  assert.deepEqual(payments.map((p) => p.amount), [40.25], 'numeric precision kept');
});

test('an account whose device cannot be carried over is locked, not left without two-factor', async () => {
  assert.equal(report.unportableDevices, 1);
  assert.equal(report.lockedUsers, 1);
  const deps = { executor: executor(target), mfaKey };
  const attempt = await signIn(deps, { email: locked.email, password: locked.password, ip: null, userAgent: null });
  assert.deepEqual(attempt, { ok: false, reason: 'invalid' });
});

test('import refuses a target that already has data, and leaves it unchanged', async () => {
  const before = (await target.query('select count(*)::int as n from auth.users')).rows[0].n;
  await assert.rejects(importData(client(target), { auth: { users: [], factors: [] }, tables: new Map() }), /already has users/);
  assert.equal((await target.query('select count(*)::int as n from auth.users')).rows[0].n, before);
});

test('encrypted export files need the passphrase and detect tampering', () => {
  const file = encryptBuffer(Buffer.from('{"secret":1}'), 'a long enough passphrase');
  assert.throws(() => decryptBuffer(file, 'another long passphrase'));
  const tampered = Buffer.from(file);
  tampered[40] ^= 1;
  assert.throws(() => decryptBuffer(tampered, 'a long enough passphrase'));
  assert.throws(() => encryptBuffer(Buffer.from('x'), 'short'));
});
