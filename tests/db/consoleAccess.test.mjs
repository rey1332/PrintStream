import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, admin } from './harness.mjs';
import { executeSpec } from '../../src/server/db/execute.ts';
import { RestClient } from '../../src/lib/db/rest-client.ts';

// Table lists of the console's d_* commands (DevConsole TABLE_MAP).
const CONSOLE_TABLES = [
  'erp_transactions', 'erp_suppliers', 'erp_products', 'erp_customers', 'erp_payments',
  'erp_purchase_orders', 'erp_sales_orders', 'erp_invoices', 'erp_audit_logs',
];
const FINANCIAL = ['erp_transactions', 'erp_payments', 'erp_purchase_orders', 'erp_sales_orders', 'erp_invoices'];

let db;
let data;
let owner;
let viewer;
let outsider;
let workspace;
const ids = {};

before(async () => {
  db = await createDb();
  // Functions that fail the way internal errors do, with PostgreSQL DETAIL/HINT.
  await db.exec(`
    create function public.test_internal_failure() returns void language plpgsql as $$
    begin
      raise exception 'relation "secret_internal" failed' using errcode = 'XX000',
        detail = 'Failing row contains (ceo@secret.test, 4111111111111111)', hint = 'select * from secret_internal';
    end $$;
    create function public.test_app_failure() returns void language plpgsql as $$
    begin
      raise exception 'Stock cannot be negative' using detail = 'Failing row contains (ceo@secret.test)', hint = 'internal hint';
    end $$;
    -- New functions are not callable by default (20261011000000_erp_security_hardening.sql).
    grant execute on function public.test_internal_failure(), public.test_app_failure() to authenticated;
  `);
  const executor = { transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })) };
  data = (user) => new RestClient((spec) => executeSpec(executor, { userId: user.id, email: user.email, aal: user.aal ?? 'aal2' }, spec));

  owner = await createUser(db, 'console-owner');
  viewer = await createUser(db, 'console-finance');
  outsider = await createUser(db, 'console-outsider');
  [{ workspace_id: workspace }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  // A member who reads everything but may not change master data (Finance).
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'finance', 24, '')`, [workspace]);
  await run(db, viewer, `select erp_redeem_workspace_invitation($1)`, [access_code]);

  [{ id: ids.customer }] = await run(db, owner, `insert into erp_customers (user_id, name, email) values ($1, 'Secret Co', 'ceo@secret.test') returning id`, [owner.id]);
  [{ id: ids.supplier }] = await run(db, owner, `insert into erp_suppliers (user_id, name) values ($1, 'Parts Ltd') returning id`, [owner.id]);
  [{ id: ids.product }] = await run(db, owner, `insert into erp_products (user_id, name, current_stock) values ($1, 'Widget', 5) returning id`, [owner.id]);
  [{ id: ids.invoice }] = await run(db, owner, `select erp_create_invoice_v5(null, $1, 'Secret Co', current_date, current_date + 30, 100, 0, null, null) as id`, [ids.customer]);
  await run(db, owner,
    `insert into erp_transactions (user_id, transaction_type, category, amount, description) values ($1, 'expense', 'Rent', 500, 'Rent')`, [owner.id]);
});

const ownerRows = async () => {
  const rows = await admin(db, `
    select (select count(*) from erp_customers where user_id = $1)::int as customers,
           (select count(*) from erp_suppliers where user_id = $1)::int as suppliers,
           (select count(*) from erp_products where user_id = $1)::int as products,
           (select count(*) from erp_invoices where user_id = $1)::int as invoices,
           (select count(*) from erp_transactions where user_id = $1)::int as transactions,
           (select count(*) from erp_audit_log where user_id = $1)::int as audit`, [owner.id]);
  return rows[0];
};

test('console delete commands cannot touch another account or workspace, even with forged filters', async () => {
  const before = await ownerRows();
  for (const user of [outsider, viewer]) {
    for (const table of CONSOLE_TABLES) {
      // As the console sends it (own user_id) …
      const own = await data(user).from(table).delete({ count: 'exact' }).eq('user_id', user.id);
      // … and forged: the owner's user_id, the workspace, a single record id, no filter at all.
      const forged = [
        await data(user).from(table).delete({ count: 'exact' }).eq('user_id', owner.id),
        await data(user).from(table).delete({ count: 'exact' }).eq('workspace_id', workspace),
        await data(user).from(table).delete({ count: 'exact' }).eq('id', ids.customer),
        await data(user).from(table).delete({ count: 'exact' }),
      ];
      for (const result of [own, ...forged]) {
        assert.ok(result.error || result.count === 0, `${user.name} ${table}: ${JSON.stringify(result)}`);
      }
    }
  }
  assert.deepEqual(await ownerRows(), before, 'nothing of the owner changed');
});

test('outsiders cannot read or modify workspace records by guessing IDs', async () => {
  for (const [table, id] of [['erp_customers', ids.customer], ['erp_invoices', ids.invoice], ['erp_products', ids.product]]) {
    const read = await data(outsider).from(table).select('*').eq('id', id);
    assert.deepEqual(read.data, [], `${table} read`);
    const update = await data(outsider).from(table).update({ name: 'pwned' }).eq('id', id);
    assert.ok(update.error || update.count === null || update.count === 0, `${table} update`);
  }
  assert.equal((await data(outsider).from('erp_customers').select('*').eq('email', 'ceo@secret.test')).data.length, 0);
  assert.equal((await admin(db, `select name from erp_customers where id = $1`, [ids.customer]))[0].name, 'Secret Co');
  // Workspace members see workspace data according to their role (Finance reads everything).
  assert.equal((await data(viewer).from('erp_customers').select('id').eq('id', ids.customer)).data.length, 1);
});

test('financial records and the audit log cannot be deleted even by the owner; master data deletes are audited', async () => {
  for (const table of FINANCIAL) {
    const result = await data(owner).from(table).delete({ count: 'exact' }).eq('user_id', owner.id);
    assert.match(result.error?.message ?? '', /permission denied/, table);
  }
  const audit = await data(owner).from('erp_audit_log').delete({ count: 'exact' }).eq('user_id', owner.id);
  assert.match(audit.error?.message ?? '', /permission denied/);

  const before = await ownerRows();
  const removed = await data(owner).from('erp_suppliers').delete({ count: 'exact' }).eq('user_id', owner.id);
  assert.equal(removed.error, null);
  assert.equal(removed.count, 1);
  const after = await ownerRows();
  assert.equal(after.invoices, before.invoices);
  assert.equal(after.transactions, before.transactions);
  const [entry] = await admin(db,
    `select action, table_name, user_id from erp_audit_log where table_name = 'erp_suppliers' and action = 'DELETE' order by created_at desc limit 1`);
  assert.deepEqual(entry, { action: 'DELETE', table_name: 'erp_suppliers', user_id: owner.id });
});

test('data API errors never carry DETAIL/HINT, and unexpected errors are generic', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const internal = await data(outsider).rpc('test_internal_failure');
    assert.equal(internal.status, 500);
    assert.deepEqual(internal.error, { message: 'The request could not be completed', code: 'XX000', details: null, hint: null });

    const app = await data(outsider).rpc('test_app_failure');
    assert.equal(app.status, 400);
    assert.deepEqual(app.error, { message: 'Stock cannot be negative', code: 'P0001', details: null, hint: null });

    const constraint = await data(outsider).from('erp_customers').insert({ user_id: outsider.id, name: null });
    assert.equal(constraint.error.code, '23502');
    assert.equal(constraint.error.details, null);
    assert.equal(constraint.error.hint, null);
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, ['[db] XX000'], 'only the error code reaches the server log');
  assert.ok(!logged.join('').includes('secret'));
});

test('the two-factor rule still applies to console requests', async () => {
  await db.query(`insert into auth.mfa_factors (user_id, friendly_name, status) values ($1, 'phone', 'verified')`, [owner.id]);
  const blocked = await data({ ...owner, aal: 'aal1' }).from('erp_customers').delete({ count: 'exact' }).eq('user_id', owner.id);
  assert.match(blocked.error?.message ?? '', /Two-factor verification required/);
  assert.equal((await ownerRows()).customers, 1);
  await db.query(`delete from auth.mfa_factors where user_id = $1`, [owner.id]);
});
