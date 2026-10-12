import { readFileSync } from 'node:fs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, applyMigrations, createUser, run, admin, items } from './harness.mjs';

const LAST_PREVIOUS_MIGRATION = '20260925050000';

let db;
let alice;
let bob;
const ids = {};
let auditBefore;
let customerUpdatedAt;

before(async () => {
  db = await createDb({ through: LAST_PREVIOUS_MIGRATION });
  alice = await createUser(db, 'alice');
  bob = await createUser(db, 'bob');

  // ── Legacy data, written exactly the way the current app writes it ──
  [{ id: ids.customer }] = await run(db, alice, `insert into erp_customers (user_id, name) values ($1, 'Legacy customer') returning id`, [alice.id]);
  [{ id: ids.product }] = await run(db, alice, `insert into erp_products (user_id, name, current_stock) values ($1, 'Legacy widget', 10) returning id`, [alice.id]);

  const createSo = async (qty) =>
    (await run(db, alice, `select erp_create_sales_order($1, '', current_date, '', $2::jsonb) as id`, [ids.customer, items([ids.product, qty])]))[0].id;
  ids.draft = await createSo(3);
  ids.invoiced = await createSo(4);
  ids.delivered = await createSo(2);
  [{ id: ids.invoicedInvoice }] = await run(db, alice, `select erp_issue_invoice_from_sales_order($1) as id`, [ids.invoiced]);
  [{ id: ids.deliveredInvoice }] = await run(db, alice, `select erp_issue_invoice_from_sales_order($1) as id`, [ids.delivered]);
  await run(db, alice, `select erp_deliver_sales_order($1)`, [ids.delivered]);

  [{ id: ids.po }] = await run(db, alice, `select erp_create_purchase_order(null, 'Legacy supplier', current_date, '', $1::jsonb) as id`, [items([ids.product, 5, 3])]);
  await run(db, alice, `select erp_update_purchase_order_status($1, 'approved')`, [ids.po]);
  await run(db, alice, `select erp_update_purchase_order_status($1, 'received')`, [ids.po]);

  [{ id: ids.manualInvoice }] = await run(db, alice, `select erp_create_invoice(null, 'Walk-in', current_date, current_date + 10, 100) as id`);
  await run(db, alice, `insert into erp_payments (user_id, payment_type, party, amount, payment_date, method, note, invoice_id) values ($1, 'incoming', 'Walk-in', 40, current_date, 'Cash', '', $2)`, [alice.id, ids.manualInvoice]);

  [{ id: ids.bobCustomer }] = await run(db, bob, `insert into erp_customers (user_id, name) values ($1, 'Bob only') returning id`, [bob.id]);

  auditBefore = (await admin(db, `select count(*)::int as n from erp_audit_log`))[0].n;
  customerUpdatedAt = (await admin(db, `select updated_at from erp_customers where id = $1`, [ids.customer]))[0].updated_at;

  // ── Upgrade ──
  await applyMigrations(db, { after: LAST_PREVIOUS_MIGRATION });
});

test('the upgrade gives every existing user one private workspace and backfills ownership', async () => {
  const workspaces = await admin(db, `select owner_id, is_personal from erp_workspaces order by owner_id`);
  assert.equal(workspaces.length, 2);
  const members = await admin(db, `select workspace_id, user_id, role from erp_workspace_members`);
  assert.equal(members.length, 2, 'nobody was added to anybody else\'s workspace');
  assert.ok(members.every((m) => m.role === 'owner'));

  for (const table of ['erp_customers', 'erp_products', 'erp_sales_orders', 'erp_purchase_orders', 'erp_invoices', 'erp_payments', 'erp_transactions', 'erp_stock_movements', 'erp_audit_log']) {
    const [{ n }] = await admin(
      db,
      `select count(*)::int as n from ${table} t
       where t.workspace_id is distinct from (select id from erp_workspaces w where w.owner_id = t.user_id and w.is_personal)`
    );
    assert.equal(n, 0, `${table} rows point at their owner's workspace`);
  }

  assert.equal((await run(db, bob, `select count(*)::int as n from erp_customers where id = $1`, [ids.customer]))[0].n, 0);
  assert.equal((await run(db, alice, `select count(*)::int as n from erp_customers where id = $1`, [ids.bobCustomer]))[0].n, 0);
});

test('the backfill does not rewrite timestamps or flood the audit log', async () => {
  const [{ n }] = await admin(db, `select count(*)::int as n from erp_audit_log`);
  assert.equal(n, auditBefore);
  const [{ updated_at }] = await admin(db, `select updated_at from erp_customers where id = $1`, [ids.customer]);
  assert.equal(updated_at.getTime(), customerUpdatedAt.getTime());
});

test('completed orders are marked fully moved and open orders are reserved', async () => {
  const [so] = await admin(db, `select qty::float8 as qty, qty_delivered::float8 as qty_delivered from erp_sales_order_items where sales_order_id = $1`, [ids.delivered]);
  assert.equal(so.qty_delivered, so.qty);
  const [po] = await admin(db, `select qty::float8 as qty, qty_received::float8 as qty_received from erp_purchase_order_items where purchase_order_id = $1`, [ids.po]);
  assert.equal(po.qty_received, po.qty);

  // 10 on hand + 5 received − 2 delivered = 13; open orders reserve 3 + 4.
  const [availability] = await admin(db, `select on_hand::float8 as on_hand, reserved::float8 as reserved, available::float8 as available from erp_product_availability where product_id = $1`, [ids.product]);
  assert.deepEqual(availability, { on_hand: 13, reserved: 7, available: 6 });
});

test('existing partial payments are reflected in the new invoice columns', async () => {
  const [manual] = await admin(db, `select status, payment_state, amount_paid::float as paid from erp_invoices where id = $1`, [ids.manualInvoice]);
  assert.deepEqual(manual, { status: 'unpaid', payment_state: 'partially_paid', paid: 40 });
});

test('calls made by older app versions keep working without duplicates', async () => {
  // Direct customer insert without workspace_id (old client) is placed in the owner's workspace.
  const [{ workspace_id }] = await run(db, alice, `insert into erp_customers (user_id, name) values ($1, 'After upgrade') returning workspace_id`, [alice.id]);
  assert.ok(workspace_id);

  // Old "deliver" button on the invoiced order moves exactly its quantity once.
  await run(db, alice, `select erp_deliver_sales_order($1)`, [ids.invoiced]);
  const [{ current_stock }] = await admin(db, `select current_stock::float8 as current_stock from erp_products where id = $1`, [ids.product]);
  assert.equal(current_stock, 9);
  const [{ n }] = await admin(db, `select count(*)::int as n from erp_stock_movements where note = $1`, [`Auto: Sales Order delivered - SO#${ids.invoiced}`]);
  assert.equal(n, 1);

  // The first sales-order RPC is retired (20261012000019); the current one
  // enforces availability: 9 on hand, 3 reserved.
  await assert.rejects(
    run(db, alice, `select erp_create_sales_order(null, 'X', current_date, '', $1::jsonb)`, [items([ids.product, 1])]),
    /permission denied/
  );
  await assert.rejects(
    run(db, alice, `select erp_create_sales_order_v3(null, null, 'X', current_date, '', $1::jsonb, null, null)`, [items([ids.product, 7])]),
    /available 6, requested 7/
  );
  await run(db, alice, `select erp_create_sales_order_v3(null, null, 'X', current_date, '', $1::jsonb, null, null)`, [items([ids.product, 6])]);

  // Old payment flow on the partially paid invoice still works up to the balance.
  await run(db, alice, `insert into erp_payments (user_id, payment_type, party, amount, invoice_id) values ($1, 'incoming', 'Walk-in', 60, $2)`, [alice.id, ids.manualInvoice]);
  const [paid] = await admin(db, `select status, payment_state from erp_invoices where id = $1`, [ids.manualInvoice]);
  assert.deepEqual(paid, { status: 'paid', payment_state: 'paid' });

  // Old "unpaid invoices" query (status in unpaid/overdue) still finds open invoices.
  const open = await run(db, alice, `select id from erp_invoices where user_id = $1 and status in ('unpaid', 'overdue')`, [alice.id]);
  assert.deepEqual(open.map((r) => r.id).sort(), [ids.invoicedInvoice, ids.deliveredInvoice].sort());
});

test('applying the new migrations a second time is harmless', async () => {
  // Older migrations define views with whole-number columns: take the
  // decimal-quantity change back first; the re-run applies it again.
  await db.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000015_erp_decimal_quantities_units.sql', import.meta.url), 'utf8'));
  await applyMigrations(db, { after: LAST_PREVIOUS_MIGRATION });
  const [{ n }] = await admin(db, `select count(*)::int as n from erp_workspaces`);
  assert.equal(n, 2);
  const [{ r }] = await admin(db, `select count(*)::int as r from erp_stock_reservations`);
  assert.ok(r > 0);
});
