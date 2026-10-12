import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, admin } from './harness.mjs';
import { RestClient } from '../../src/lib/db/rest-client.ts';
import { validateSpec } from '../../src/lib/db/spec.ts';
import { containsPattern } from '../../src/lib/db/pattern.ts';
import { executeSpec } from '../../src/server/db/execute.ts';

let db;
let executor;
let alice;
let bob;
let po;
let invoice;

const clientFor = (user, aal = 'aal1') =>
  new RestClient((spec) => executeSpec(executor, user ? { userId: user.id, email: user.email, aal } : null, spec));

before(async () => {
  db = await createDb();
  executor = { transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })) };
  alice = await createUser(db, 'rest-alice');
  bob = await createUser(db, 'rest-bob');
  await run(db, alice, `insert into erp_customers (user_id, name, balance) values ($1, 'Acme', 12.5), ($1, 'Beta', 0), ($1, 'Gamma%', 3)`, [alice.id]);
  await run(db, bob, `insert into erp_customers (user_id, name) values ($1, 'Bob Co')`, [bob.id]);
  [{ id: po }] = await run(db, alice, `select erp_create_purchase_order_v3(null, null, 'Supplier', current_date, '', $1::jsonb, null, null) as id`, ['[{"product_name":"Bolts","qty":2,"price":7.5}]']);
  [{ id: invoice }] = await run(db, alice, `select erp_create_invoice_v5(null, null, 'Acme', '2026-09-01', '2026-09-30', 100, 0, null, null) as id`);
  await run(db, alice, `insert into erp_payments (user_id, payment_type, party, amount, invoice_id) values ($1, 'incoming', 'Acme', 40, $2)`, [alice.id, invoice]);
});

test('select with scope, order and range returns PostgREST-shaped JSON', async () => {
  const { data, error } = await clientFor(alice).from('erp_customers').select('*').eq('user_id', alice.id).order('name').range(0, 1);
  assert.equal(error, null);
  assert.deepEqual(data.map((r) => r.name), ['Acme', 'Beta']);
  assert.equal(data[0].balance, 12.5, 'numeric arrives as a JSON number');
  assert.match(data[0].created_at, /^\d{4}-\d{2}-\d{2}T/, 'timestamps are ISO strings');
});

test('row-level security still decides what each user sees and writes', async () => {
  const seen = await clientFor(bob).from('erp_customers').select('name');
  assert.deepEqual(seen.data.map((r) => r.name), ['Bob Co']);
  const denied = await clientFor(bob).from('erp_customers').insert({ user_id: alice.id, name: 'Sneaky' });
  assert.ok(denied.error);
  assert.equal(denied.error.code, '42501');
  const anon = await clientFor(null).from('erp_customers').select('*');
  assert.ok(anon.error || anon.data.length === 0, 'anonymous requests see nothing');
});

test('embedded resources: one-to-many arrays and hinted many-to-one objects', async () => {
  const pos = await clientFor(alice).from('erp_purchase_orders')
    .select('*, items:erp_purchase_order_items(*), approval:erp_approval_requests(status)')
    .eq('id', po);
  assert.equal(pos.error, null);
  assert.equal(pos.data[0].items.length, 1);
  assert.equal(pos.data[0].items[0].price, 7.5);
  assert.deepEqual(pos.data[0].approval, []);

  const inv = await clientFor(alice).from('erp_invoices').select('*, payments:erp_payments(*)').eq('id', invoice).single();
  assert.equal(inv.error, null);
  assert.equal(inv.data.invoice_date, '2026-09-01', 'dates stay YYYY-MM-DD');
  assert.deepEqual(inv.data.payments.map((p) => p.amount), [40]);

  // Analytics style: alias:table!fk_column!inner(cols) plus a filter on the embed.
  const lines = await clientFor(alice).from('erp_purchase_order_items')
    .select('id,qty,scope:erp_purchase_orders!purchase_order_id!inner(user_id,workspace_id)')
    .eq('scope.user_id', alice.id);
  assert.equal(lines.error, null);
  assert.equal(lines.data.length, 1);
  assert.equal(lines.data[0].scope.user_id, alice.id);
  const none = await clientFor(alice).from('erp_purchase_order_items')
    .select('id,scope:erp_purchase_orders!purchase_order_id!inner(user_id)')
    .eq('scope.user_id', bob.id);
  assert.deepEqual(none.data, [], '!inner removes parents whose embed does not match');
});

test('filters: in, is, not, ilike with * wildcards, ranges', async () => {
  const c = clientFor(alice).from('erp_customers');
  assert.deepEqual((await c.select('name').in('name', ['Acme', 'Gamma%']).order('name')).data.map((r) => r.name), ['Acme', 'Gamma%']);
  assert.deepEqual((await c.select('name').in('name', [])).data, []);
  // email defaults to '' (not NULL) for these rows.
  assert.equal((await c.select('name').is('email', null)).data.length, 0);
  assert.equal((await c.select('name').not('email', 'is', null)).data.length, 3);
  assert.deepEqual((await c.select('name').ilike('name', '*ET*')).data.map((r) => r.name), ['Beta']);
  // An escaped percent matches literally (analytics likePattern).
  assert.deepEqual((await c.select('name').ilike('name', '*a\\%*')).data.map((r) => r.name), ['Gamma%']);
  assert.deepEqual((await c.select('name').gte('balance', 3).lt('balance', 13).order('balance')).data.map((r) => r.name), ['Gamma%', 'Acme']);
});

test('anyOf: one search over several columns, with count and range, inside RLS', async () => {
  const search = (user, q) =>
    clientFor(user).from('erp_customers').select('name', { count: 'exact' })
      .anyOf([{ column: 'name', op: 'ilike', value: `%${q}%` }, { column: 'email', op: 'ilike', value: `%${q}%` }])
      .order('name');
  const found = await search(alice, 'a');
  assert.equal(found.error, null);
  assert.deepEqual(found.data.map((r) => r.name), ['Acme', 'Beta', 'Gamma%']);
  assert.equal(found.count, 3);
  const page = await search(alice, 'a').range(1, 1);
  assert.deepEqual([page.data.map((r) => r.name), page.count], [['Beta'], 3]);
  const others = await search(bob, 'a');
  assert.deepEqual(others.data.map((r) => r.name), [], 'still only their own rows');
  const together = await clientFor(alice).from('erp_customers').select('name')
    .anyOf([{ column: 'name', op: 'eq', value: 'Acme' }, { column: 'name', op: 'eq', value: 'Beta' }]).gt('balance', 1);
  assert.deepEqual(together.data.map((r) => r.name), ['Acme'], 'combined with the other filters (AND)');

  // Wildcards typed by people match themselves (containsPattern).
  const literal = await clientFor(alice).from('erp_customers').select('name')
    .anyOf([{ column: 'name', op: 'ilike', value: containsPattern('%') }]);
  assert.deepEqual(literal.data.map((r) => r.name), ['Gamma%']);
  const star = await clientFor(alice).from('erp_customers').select('name')
    .anyOf([{ column: 'name', op: 'ilike', value: containsPattern('*') }]);
  assert.deepEqual(star.data, []);

  const bad = (value) => validateSpec({ kind: 'select', table: 'erp_customers', select: '*', filters: [{ column: '', op: 'or', value }], order: [] });
  assert.equal(bad([{ column: 'name', op: 'or', value: [] }]).ok, false, 'no nested or()');
  assert.equal(bad([{ column: 'items.name', op: 'eq', value: 'x' }]).ok, false, 'own columns only');
  assert.equal(bad([{ column: 'name; drop table x', op: 'eq', value: 'x' }]).ok, false);
  assert.equal(bad([]).ok, false);
  assert.equal(bad(Array.from({ length: 11 }, () => ({ column: 'name', op: 'eq', value: 'x' }))).ok, false);
  const unknown = await clientFor(alice).from('erp_customers').select('name').anyOf([{ column: 'secret', op: 'eq', value: 1 }]);
  assert.ok(unknown.error, 'unknown columns are rejected');
});

test('single() and maybeSingle() behave like supabase-js', async () => {
  const c = clientFor(alice).from('erp_customers');
  const one = await c.select('name').eq('name', 'Acme').single();
  assert.deepEqual(one.data, { name: 'Acme' });
  const many = await c.select('name').single();
  assert.equal(many.error.code, 'PGRST116');
  const missing = await c.select('name').eq('name', 'Nope').maybeSingle();
  assert.equal(missing.error, null);
  assert.equal(missing.data, null);
  const settings = await clientFor(alice).from('erp_settings').select('*').eq('user_id', alice.id).maybeSingle();
  assert.equal(settings.error, null);
});

test('insert, upsert, update and delete with and without returned rows', async () => {
  const c = () => clientFor(alice).from('erp_suppliers');
  const created = await c().insert({ user_id: alice.id, name: 'Sup A', balance: 0 }).select().single();
  assert.equal(created.error, null);
  assert.equal(created.data.name, 'Sup A');
  const quiet = await c().insert([{ user_id: alice.id, name: 'Sup B' }, { user_id: alice.id, name: 'Sup C' }]);
  assert.equal(quiet.error, null);
  assert.equal(quiet.data, null, 'no body without .select()');

  const updated = await c().update({ name: 'Sup A2' }).eq('id', created.data.id).eq('user_id', alice.id).select().single();
  assert.equal(updated.data.name, 'Sup A2');

  const upserted = await clientFor(alice).from('erp_settings')
    .upsert({ user_id: alice.id, cash_low_threshold: 1234, expense_spike_ratio: 80, inventory_low_threshold: 50 }, { onConflict: 'user_id' });
  assert.equal(upserted.error, null);
  const [row] = await admin(db, 'select cash_low_threshold from erp_settings where user_id = $1', [alice.id]);
  assert.equal(Number(row.cash_low_threshold), 1234);

  const removed = await c().delete({ count: 'exact' }).eq('user_id', alice.id).in('name', ['Sup B', 'Sup C']);
  assert.equal(removed.error, null);
  assert.equal(removed.count, 2);
});

test('rpc: scalar, table-returning, jsonb arguments, void, missing functions', async () => {
  const c = clientFor(alice);
  const created = await c.rpc('erp_create_purchase_order_v3', {
    p_workspace_id: null, p_supplier_id: null, p_supplier_name: 'Rpc Supplier', p_order_date: null, p_notes: '',
    p_items: [{ product_id: null, product_name: 'Bolts', qty: 3, price: 2 }], p_currency: null, p_fx_rate: null,
  });
  const retired = await c.rpc('erp_create_purchase_order', {
    p_supplier_id: null, p_supplier_name: 'Rpc Supplier', p_order_date: null, p_notes: '',
    p_items: [{ product_id: null, product_name: 'Bolts', qty: 3, price: 2 }],
  });
  assert.equal(retired.error?.code, '42501', 'superseded versions are not callable');
  assert.equal(created.error, null);
  assert.match(created.data, /^[0-9a-f-]{36}$/, 'scalar result is the bare value');

  const workspaces = await c.rpc('erp_my_workspaces');
  assert.equal(workspaces.error, null);
  assert.ok(Array.isArray(workspaces.data) && workspaces.data.length >= 1);

  const rule = await c.rpc('erp_update_purchase_order_status', { p_purchase_order_id: created.data, p_status: 'nonsense' });
  assert.ok(rule.error, 'business-rule errors come back as errors');

  const missing = await c.rpc('erp_does_not_exist', {});
  assert.equal(missing.error.code, 'PGRST202');
});

test('count and head, and the 1000-row cap', async () => {
  const user = await createUser(db, 'rest-many');
  await run(db, user, `insert into erp_customers (user_id, name) select $1, 'C' || g from generate_series(1, 1005) g`, [user.id]);
  const c = () => clientFor(user).from('erp_customers');
  const counted = await c().select('*', { count: 'exact', head: true });
  assert.equal(counted.count, 1005);
  assert.equal(counted.data, null);
  const capped = await c().select('id');
  assert.equal(capped.data.length, 1000, 'max rows per request, as on Supabase');
  const page2 = await c().select('id').order('id').range(1000, 1999);
  assert.equal(page2.data.length, 5);
});

test('the two-factor rule applies to every request, except the recovery RPC', async () => {
  const user = await createUser(db, 'rest-mfa');
  await admin(db, `insert into auth.mfa_factors (user_id, status) values ($1, 'verified')`, [user.id]);
  const blocked = await clientFor(user, 'aal1').from('erp_customers').select('*');
  assert.match(blocked.error.message, /Two-factor verification required/);
  const allowed = await clientFor(user, 'aal2').from('erp_customers').select('*');
  assert.equal(allowed.error, null);
  const recovery = await clientFor(user, 'aal1').rpc('erp_mfa_use_recovery_code', { p_code: 'AAAAA-AAAAA' });
  assert.equal(recovery.error, null);
  assert.equal(recovery.data, 'invalid');
});

test('unknown tables, columns and relationships are rejected before running', async () => {
  const c = clientFor(alice);
  assert.equal((await c.from('pg_authid').select('*')).error.code, '42P01');
  assert.equal((await c.from('erp_customers').select('password')).error.code, '42703');
  assert.equal((await c.from('erp_customers').select('*').eq('nope', 1)).error.code, '42703');
  assert.equal((await c.from('erp_customers').select('*, x:erp_workflow_runs(*)')).error.code, '42P01');
  assert.equal((await c.from('erp_customers').select('*, erp_products(*)')).error.code, 'PGRST200');
});

test('untrusted specs are validated (identifiers, shapes, sizes)', () => {
  const ok = (spec) => validateSpec(spec).ok;
  assert.equal(ok({ kind: 'select', table: 'erp_customers', select: '*', filters: [], order: [] }), true);
  assert.equal(ok({ kind: 'select', table: 'erp_customers; drop table x', select: '*' }), false);
  assert.equal(ok({ kind: 'select', table: 'erp_customers', select: '*, a:b(c' }), false);
  assert.equal(ok({ kind: 'select', table: 'erp_customers', select: '*', filters: [{ column: 'name) or (1=1', op: 'eq', value: 1 }] }), false);
  assert.equal(ok({ kind: 'select', table: 'erp_customers', select: '*', filters: [{ column: 'name', op: 'raw', value: 1 }] }), false);
  assert.equal(ok({ kind: 'rpc', fn: 'x"; select 1; --', args: {} }), false);
  assert.equal(ok({ kind: 'insert', table: 'erp_customers', values: [{ 'bad key': 1 }] }), false);
  assert.equal(ok({ kind: 'select', table: 'erp_customers', select: '*', range: { from: 5, to: 1 } }), false);
});

test('values are parameters, never SQL', async () => {
  const c = clientFor(alice).from('erp_customers');
  const sneaky = "x'; delete from erp_customers; --";
  const result = await c.select('name').eq('name', sneaky);
  assert.equal(result.error, null);
  assert.deepEqual(result.data, []);
  const [{ n }] = await admin(db, 'select count(*)::int as n from erp_customers where user_id = $1', [alice.id]);
  assert.equal(n, 3);
});

test('printed order lines load with their unit and the product code', async () => {
  const [{ id: product }] = await run(db, alice, `insert into erp_products (user_id, name, sku, unit, current_stock) values ($1, 'Split 1/2', 'SPL-12', 'm3', 0) returning id`, [alice.id]);
  const [{ id: order }] = await run(db, alice, `select erp_create_purchase_order_v3(null, null, 'Quarry', current_date, '', $1::jsonb, null, null) as id`,
    [JSON.stringify([{ product_id: product, qty: 12.5, price: 180000 }, { product_name: 'Hauling', qty: 2, price: 1, unit: 'rit' }])]);
  // Same as PRINT_PO_LINE_SELECT in src/app/erp/print/PrintSheet.tsx.
  const PRINT_PO_LINE_SELECT = 'product_name, qty, price, unit, subtotal, product:erp_products(sku)';
  const lines = await clientFor(alice).from('erp_purchase_order_items').select(PRINT_PO_LINE_SELECT).eq('purchase_order_id', order).order('product_name');
  assert.equal(lines.error, null);
  assert.deepEqual(lines.data.map((l) => [l.product_name, l.qty, l.unit, l.subtotal, l.product?.sku ?? null]), [
    ['Hauling', 2, 'rit', 2, null],
    ['Split 1/2', 12.5, 'm3', 2250000, 'SPL-12'],
  ]);
});

test('every data request of a workspace member is in the data-access log; session lookups are not', async () => {
  const [{ workspace_id: ws }] = await run(db, alice, `select workspace_id from erp_my_workspaces() where is_personal`);
  const before = (await admin(db, `select count(*)::int n from etna_platform.data_access_log where actor_id = $1`, [alice.id]))[0].n;
  const read = await clientFor(alice).from('erp_customers').select('name').eq('workspace_id', ws);
  assert.equal(read.error, null);
  await clientFor(alice).rpc('erp_my_workspaces');
  const rows = await admin(db, `select workspace_id, object_kind, object_id, operation, rows from etna_platform.data_access_log
                                 where actor_id = $1 order by id`, [alice.id]);
  const added = rows.slice(before);
  assert.deepEqual(added, [{ workspace_id: ws, object_kind: 'erp_entity', object_id: 'erp_customers', operation: 'query', rows: read.data.length }]);
});
