import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createDb,
  applyMigrations,
  createUser,
  run,
  admin,
  expectError,
  items,
} from './harness.mjs';

let db;
let owner;
let sales;
let inventory;
let finance;
let ws;
const ids = {};

async function join(member, role, database = db, workspace = ws, inviter = owner) {
  const [{ access_code }] = await run(
    database,
    inviter,
    `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`,
    [workspace, role]
  );
  const [{ r }] = await run(database, member, `select erp_redeem_workspace_invitation($1) as r`, [
    access_code,
  ]);
  assert.equal(r.ok, true);
}

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'scope-owner');
  sales = await createUser(db, 'scope-sales');
  inventory = await createUser(db, 'scope-inventory');
  finance = await createUser(db, 'scope-finance');
  await run(db, owner, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  await join(sales, 'sales');
  await join(inventory, 'inventory');
  await join(finance, 'finance');

  [{ id: ids.customer }] = await run(
    db,
    owner,
    `insert into erp_customers (user_id, name) values ($1, 'Toko Sinar') returning id`,
    [owner.id]
  );
  [{ id: ids.supplier }] = await run(
    db,
    owner,
    `insert into erp_suppliers (user_id, name) values ($1, 'Acme Baja') returning id`,
    [owner.id]
  );
  [{ id: ids.product }] = await run(
    db,
    owner,
    `insert into erp_products (user_id, name, current_stock, purchase_price, selling_price) values ($1, 'Bolt', 0, 4, 10) returning id`,
    [owner.id]
  );

  // Purchasing by Inventory: order, receipt.
  [{ id: ids.po }] = await run(
    db,
    inventory,
    `select erp_create_purchase_order_v3($1, $2, 'Acme Baja', current_date, '', $3::jsonb, null, null) as id`,
    [ws, ids.supplier, items([ids.product, 10, 4])]
  );
  await run(db, owner, `select erp_update_purchase_order_status($1, 'approved')`, [ids.po]);
  const [line] = await admin(
    db,
    `select id from erp_purchase_order_items where purchase_order_id = $1`,
    [ids.po]
  );
  await run(db, inventory, `select erp_record_purchase_receipt_v2($1, $2::jsonb, $3, '', null)`, [
    ids.po,
    JSON.stringify([{ item_id: line.id, qty: 10 }]),
    randomUUID(),
  ]);

  // Selling by Sales: order and invoice; Inventory delivers; Finance collects.
  [{ id: ids.so }] = await run(
    db,
    sales,
    `select erp_create_sales_order_v3($1, $2, 'Toko Sinar', current_date, '', $3::jsonb, null, null) as id`,
    [ws, ids.customer, items([ids.product, 3, 10])]
  );
  [{ id: ids.invoice }] = await run(
    db,
    sales,
    `select erp_issue_invoice_from_sales_order_v2($1, null, null) as id`,
    [ids.so]
  );
  await run(db, inventory, `select erp_deliver_sales_order($1)`, [ids.so]);
  await run(
    db,
    finance,
    `insert into erp_payments (user_id, workspace_id, payment_type, party, amount, invoice_id) values ($1, $2, 'incoming', 'Toko Sinar', 30, $3)`,
    [owner.id, ws, ids.invoice]
  );
  await run(
    db,
    owner,
    `insert into erp_transactions (user_id, transaction_type, category, amount, description) values ($1, 'expense', 'Rent', 500, 'Rent')`,
    [owner.id]
  );
});

const visible = async (user, sql) =>
  (await run(db, user, `select count(*)::int as n from (${sql}) x`, [ws]))[0].n > 0;

const AREAS = {
  customers: `select 1 from erp_customers where workspace_id = $1`,
  suppliers: `select 1 from erp_suppliers where workspace_id = $1`,
  products: `select 1 from erp_products where workspace_id = $1`,
  availability: `select 1 from erp_product_availability where workspace_id = $1 and reserved >= 0`,
  salesOrders: `select 1 from erp_sales_orders where workspace_id = $1`,
  salesOrderLines: `select 1 from erp_sales_order_items i join erp_sales_orders o on o.id = i.sales_order_id where o.workspace_id = $1`,
  deliveries: `select 1 from erp_fulfillment_events where workspace_id = $1 and kind = 'sales_delivery'`,
  invoices: `select 1 from erp_invoices where workspace_id = $1`,
  purchaseOrders: `select 1 from erp_purchase_orders where workspace_id = $1`,
  purchaseOrderLines: `select 1 from erp_purchase_order_items i join erp_purchase_orders o on o.id = i.purchase_order_id where o.workspace_id = $1`,
  receipts: `select 1 from erp_fulfillment_events where workspace_id = $1 and kind = 'purchase_receipt'`,
  stockMovements: `select 1 from erp_stock_movements where workspace_id = $1`,
  payments: `select 1 from erp_payments where workspace_id = $1`,
  cash: `select 1 from erp_transactions where workspace_id = $1`,
  journal: `select 1 from erp_journal_entries where workspace_id = $1`,
  accounts: `select 1 from erp_gl_accounts where workspace_id = $1`,
};

test('each role reads only its areas (row-level security)', async () => {
  const expected = {
    sales: [
      'customers',
      'products',
      'availability',
      'salesOrders',
      'salesOrderLines',
      'deliveries',
      'invoices',
    ],
    inventory: [
      'suppliers',
      'products',
      'availability',
      'salesOrders',
      'salesOrderLines',
      'deliveries',
      'purchaseOrders',
      'purchaseOrderLines',
      'receipts',
      'stockMovements',
    ],
    finance: Object.keys(AREAS),
    owner: Object.keys(AREAS),
  };
  const users = { sales, inventory, finance, owner };
  for (const [role, areas] of Object.entries(expected)) {
    for (const [area, sql] of Object.entries(AREAS)) {
      assert.equal(await visible(users[role], sql), areas.includes(area), `${role} reads ${area}`);
    }
  }
  // Invoices keep showing what was paid without exposing the payments.
  const [row] = await run(
    db,
    sales,
    `select amount_paid::float as paid from erp_invoices where id = $1`,
    [ids.invoice]
  );
  assert.equal(row.paid, 30);
});

test('restricted roles keep every action of their job, and nothing else', async () => {
  // Sales: settings, tax rates, exchange rates and currency settings its forms need.
  for (const sql of [
    `select * from erp_accounting_settings_get($1)`,
    `select * from erp_currency_settings_get($1)`,
    `select * from erp_exchange_rate_lookup($1, 'USD', 'IDR', current_date)`,
  ]) {
    await run(db, sales, sql, [ws]);
    await run(db, inventory, sql, [ws]);
  }
  const [{ id: order }] = await run(
    db,
    sales,
    `select erp_create_sales_order_v3($1, $2, 'Toko Sinar', current_date, '', $3::jsonb, null, null) as id`,
    [ws, ids.customer, items([ids.product, 1, 10])]
  );
  await expectError(
    run(db, sales, `select erp_deliver_sales_order($1)`, [order]),
    /role does not allow/
  );
  await expectError(
    run(
      db,
      sales,
      `select erp_create_purchase_order_v3($1, $2, 'Acme', current_date, '', $3::jsonb, null, null)`,
      [ws, ids.supplier, items([ids.product, 1])]
    ),
    /role does not allow/
  );
  await expectError(
    run(db, sales, `select * from erp_trial_balance($1, null, null)`, [ws]),
    /not allowed/
  );

  await run(db, inventory, `select erp_adjust_stock($1, 'in', 2, 'Count')`, [ids.product]);
  await expectError(
    run(db, inventory, `select erp_issue_invoice_from_sales_order_v2($1, null, null)`, [order]),
    /role does not allow/
  );
  await expectError(
    run(
      db,
      inventory,
      `insert into erp_customers (user_id, workspace_id, name) values ($1, $2, 'Nope')`,
      [owner.id, ws]
    ),
    /row-level security/
  );

  // Non-members still get "not found", never a hint that the record exists.
  const outsider = await createUser(db, 'scope-outsider');
  await expectError(run(db, outsider, `select erp_deliver_sales_order($1)`, [order]), /not found/);
});

test('ERP → Search is limited to the areas a role reads', async () => {
  const search = (user, type) =>
    run(
      db,
      user,
      `select erp_ontology_search($1, $2, array['%a%'], null, null, null, null, null, null, 10, 0) as r`,
      [ws, type]
    );
  for (const type of ['customer', 'salesOrder', 'delivery', 'invoice', 'product'])
    await search(sales, type);
  for (const type of [
    'supplier',
    'purchaseOrder',
    'goodsReceipt',
    'payment',
    'journalEntry',
    'stockMovement',
    'cashTransaction',
  ]) {
    await expectError(search(sales, type), /Not allowed/);
  }
  for (const type of [
    'supplier',
    'purchaseOrder',
    'goodsReceipt',
    'product',
    'stockMovement',
    'salesOrder',
    'delivery',
  ])
    await search(inventory, type);
  for (const type of ['customer', 'invoice', 'payment', 'glAccount'])
    await expectError(search(inventory, type), /Not allowed/);
  await run(db, sales, `select erp_log_access($1, 'search', array['customer'], null, 1)`, [ws]);
});

test('the Viewer role is retired on upgrade: pending codes revoked, viewers removed with an audit entry', async () => {
  const PREVIOUS = '20261006000000';
  const old = await createDb({ through: PREVIOUS });
  const boss = await createUser(old, 'retire-owner');
  const viewer = await createUser(old, 'retire-viewer');
  const late = await createUser(old, 'retire-late');
  const [{ workspace_id: workspace }] = await run(
    old,
    boss,
    `select workspace_id from erp_my_workspaces()`
  );
  await join(viewer, 'viewer', old, workspace, boss);
  const [{ access_code: pending }] = await run(
    old,
    boss,
    `select access_code from erp_create_workspace_invitation($1, 'viewer', 24, '')`,
    [workspace]
  );
  const [{ id: product }] = await run(
    old,
    boss,
    `insert into erp_products (user_id, name) values ($1, 'Kept') returning id`,
    [boss.id]
  );

  await applyMigrations(old, { after: PREVIOUS });

  const [member] = await admin(
    old,
    `select role, status, removal_reason from erp_workspace_members where workspace_id = $1 and user_id = $2`,
    [workspace, viewer.id]
  );
  assert.deepEqual(member, {
    role: 'viewer',
    status: 'removed',
    removal_reason: 'Viewer role retired',
  });
  assert.equal(
    (
      await run(old, viewer, `select count(*)::int as n from erp_products where id = $1`, [product])
    )[0].n,
    0
  );
  assert.equal(
    (
      await run(
        old,
        viewer,
        `select count(*)::int as n from erp_my_workspaces() where workspace_id = $1`,
        [workspace]
      )
    )[0].n,
    0
  );
  const [{ r }] = await run(old, late, `select erp_redeem_workspace_invitation($1) as r`, [
    pending,
  ]);
  assert.deepEqual(r, { ok: false, error: 'invalid' });

  const trail = await run(
    old,
    boss,
    `select action, details->>'reason' as reason from erp_list_workspace_audit($1, 50)`,
    [workspace]
  );
  assert.ok(trail.some((a) => a.action === 'member.removed' && a.reason === 'Viewer role retired'));
  assert.ok(
    trail.some((a) => a.action === 'invitation.revoked' && a.reason === 'Viewer role retired')
  );

  // Nobody can hold the role again; the removed viewer can rejoin with a real role.
  await expectError(
    admin(old, `update erp_workspace_members set status = 'active' where user_id = $1`, [
      viewer.id,
    ]),
    /role_check/
  );
  await join(viewer, 'sales', old, workspace, boss);
  assert.equal(
    (
      await run(old, viewer, `select role from erp_my_workspaces() where workspace_id = $1`, [
        workspace,
      ])
    )[0].role,
    'sales'
  );
  // Accounts and data are untouched.
  assert.equal(
    (await admin(old, `select count(*)::int as n from auth.users where id = $1`, [viewer.id]))[0].n,
    1
  );
  assert.equal(
    (await admin(old, `select name from erp_products where id = $1`, [product]))[0].name,
    'Kept'
  );
});

test('rollback restores workspace-wide reading and the Viewer role', async () => {
  // The schema before the industry modules, whose policies use erp_can_read.
  const d = await createDb({ through: '20261012000022' });
  const boss = await createUser(d, 'rb-owner');
  const seller = await createUser(d, 'rb-sales');
  const [{ workspace_id: workspace }] = await run(
    d,
    boss,
    `select workspace_id from erp_my_workspaces()`
  );
  await join(seller, 'sales', d, workspace, boss);
  await run(d, boss, `insert into erp_suppliers (user_id, name) values ($1, 'Acme') returning id`, [
    boss.id,
  ]);
  const count = async () =>
    (
      await run(d, seller, `select count(*)::int as n from erp_suppliers where workspace_id = $1`, [
        workspace,
      ])
    )[0].n;
  assert.equal(await count(), 0);

  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261007000000_erp_role_scopes.sql', import.meta.url),
      'utf8'
    )
  );
  assert.equal(await count(), 1);
  await run(
    d,
    boss,
    `select access_code from erp_create_workspace_invitation($1, 'viewer', 24, '')`,
    [workspace]
  );
  await run(d, seller, `select * from erp_currency_settings_get($1)`, [workspace]);
  await run(
    d,
    seller,
    `select erp_ontology_search($1, 'supplier', array['%a%'], null, null, null, null, null, null, 5, 0)`,
    [workspace]
  );
});
