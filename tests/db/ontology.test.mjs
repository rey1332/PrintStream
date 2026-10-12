import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, run, admin, expectError, items } from './harness.mjs';
import { validateSearch } from '../../src/lib/ontology/query.ts';
import { ONTOLOGY, ONTOLOGY_TYPES, recordReference } from '../../src/lib/ontology/registry.ts';
import { TYPE_SQL, RELATION_SQL, relatedRows, rowsByIds } from '../../src/server/ontology/sql.ts';
import { searchOntology, readOntologyRecord } from '../../src/server/ontology/service.ts';

let db;
let owner;
let finance;
let inventory;
let outsider;
let ws;
let outsiderWs;
const ids = {};

const executor = () => ({
  transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })),
});
const ctx = (user, workspacesEnabled = true) => ({
  executor: executor(),
  identity: { userId: user.id, email: user.email, aal: user.aal ?? 'aal2' },
  workspacesEnabled,
  path: '/ontology/test',
});
const request = (input) => {
  const v = validateSearch(input);
  assert.ok(v.ok, v.error);
  return v.request;
};
const search = (user, input, workspace = ws, enabled = true) => searchOntology(ctx(user, enabled), workspace, request(input));
const group = (res, type) => res.groups.find((g) => g.type === type);
const idsOf = (res, type) => (group(res, type)?.items ?? []).map((i) => i.id).sort();
const rejects = async (promise, code) => {
  await assert.rejects(promise, (e) => e.code === code, `expected ${code}`);
};

async function join(member, role) {
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`, [ws, role]);
  const [{ r }] = await run(db, member, `select erp_redeem_workspace_invitation($1) as r`, [access_code]);
  assert.equal(r.ok, true);
}

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'onto-owner');
  finance = await createUser(db, 'onto-finance');
  inventory = await createUser(db, 'onto-inventory');
  outsider = await createUser(db, 'onto-outsider');
  for (const u of [owner, outsider]) await run(db, u, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  [{ workspace_id: outsiderWs }] = await run(db, outsider, `select workspace_id from erp_my_workspaces()`);
  await join(finance, 'finance');
  await join(inventory, 'inventory');

  const supplier = async (user, name, city) =>
    (await run(db, user, `insert into erp_suppliers (user_id, name, city, email) values ($1, $2, $3, $4) returning id`,
      [user.id, name, city, `${name.split(' ')[0].toLowerCase()}@example.test`]))[0].id;
  const product = async (user, name, sku) =>
    (await run(db, user, `insert into erp_products (user_id, name, sku, current_stock, purchase_price, selling_price) values ($1, $2, $3, 0, 4, 10) returning id`,
      [user.id, name, sku]))[0].id;

  ids.acme = await supplier(owner, 'Acme Baja', 'Surabaya');
  ids.other = await supplier(owner, 'Borneo Kayu', 'Balikpapan');
  ids.bolt = await product(owner, 'Hex Bolt M8', 'BLT-M8');

  // Purchase order → approval → receipt → payment, through the business functions.
  [{ id: ids.po }] = await run(db, owner,
    `select erp_create_purchase_order_v3($1, $2, 'Acme Baja', '2026-03-02', 'Urgent restock', $3::jsonb, null, null) as id`,
    [ws, ids.acme, items([ids.bolt, 10, 4])]);
  await run(db, owner, `select erp_update_purchase_order_status($1, 'approved')`, [ids.po]);
  const [line] = await admin(db, `select id from erp_purchase_order_items where purchase_order_id = $1`, [ids.po]);
  [{ id: ids.receipt }] = await run(db, owner, `select erp_record_purchase_receipt_v2($1, $2::jsonb, $3, '', null) as id`,
    [ids.po, JSON.stringify([{ item_id: line.id, qty: 10 }]), randomUUID()]);
  [{ id: ids.payment }] = await run(db, owner,
    `insert into erp_payments (user_id, payment_type, party, amount, purchase_order_id) values ($1, 'outgoing', 'Acme Baja', 40, $2) returning id`,
    [owner.id, ids.po]);
  [{ id: ids.po2 }] = await run(db, owner,
    `select erp_create_purchase_order_v3($1, $2, 'Borneo Kayu', '2026-01-15', '', $3::jsonb, null, null) as id`, [ws, ids.other, items([ids.bolt, 2, 5])]);

  // Sales side: customer → sales order → invoice → payment.
  [{ id: ids.customer }] = await run(db, owner,
    `insert into erp_customers (user_id, name, city) values ($1, 'Toko Sinar', 'Jakarta') returning id`, [owner.id]);
  [{ id: ids.so }] = await run(db, owner, `select erp_create_sales_order_v3($1, $2, 'Toko Sinar', '2026-03-05', '', $3::jsonb, null, null) as id`,
    [ws, ids.customer, items([ids.bolt, 3, 10])]);
  await run(db, owner, `select erp_issue_invoice_from_sales_order_v2($1, null, null)`, [ids.so]);
  [{ id: ids.invoice }] = await admin(db, `select id from erp_invoices where sales_order_id = $1`, [ids.so]);

  // The same names in another workspace must never show up.
  const foreign = await supplier(outsider, 'Acme Baja', 'Surabaya');
  const foreignProduct = await product(outsider, 'Hex Bolt M8', 'BLT-M8');
  [{ id: ids.foreignPo }] = await run(db, outsider,
    `select erp_create_purchase_order_v3($1, $2, 'Acme Baja', '2026-03-02', 'Urgent restock', $3::jsonb, null, null) as id`,
    [outsiderWs, foreign, items([foreignProduct, 1, 1])]);
});

test('registry and SQL describe the same objects, properties and relationships', () => {
  for (const type of ONTOLOGY_TYPES) {
    const def = ONTOLOGY[type];
    assert.deepEqual(Object.keys(TYPE_SQL[type].properties).sort(), def.properties.map((p) => p.key).sort(), type);
    assert.deepEqual(Object.keys(RELATION_SQL[type]).sort(), def.relations.map((r) => r.key).sort(), type);
    assert.ok(def.properties.some((p) => p.key === def.title), `${type} title`);
    for (const k of [...def.summary, def.date, def.amount, def.status?.property].filter(Boolean)) {
      assert.ok(def.properties.some((p) => p.key === k), `${type}.${k}`);
    }
  }
});

test('every object and relationship query runs against the real schema', async () => {
  // Each type's search and each relationship, as a member, with no matches required.
  for (const type of ONTOLOGY_TYPES) {
    const res = await search(owner, { q: 'zz-nothing', types: [type] });
    assert.equal(group(res, type).total, 0, type);
  }
  const probe = randomUUID();
  for (const type of ONTOLOGY_TYPES) {
    await rejects(readOntologyRecord(ctx(owner), ws, type, probe), 'notFound');
    const byId = rowsByIds(type, [probe], { column: 'workspace_id', workspaceId: ws });
    assert.deepEqual(await run(db, owner, byId.sql, byId.params), []);
    for (const rel of ONTOLOGY[type].relations) {
      for (const scope of [{ column: 'workspace_id', workspaceId: ws }, { column: 'user_id', workspaceId: null }]) {
        const q = relatedRows(type, rel.key, rel.target, probe, scope, 10, 100);
        assert.deepEqual(await run(db, owner, q.rows.sql, q.rows.params), [], `${type}.${rel.key}`);
        assert.deepEqual(await run(db, owner, q.count.sql, q.count.params), [{ n: 0 }], `${type}.${rel.key}`);
      }
    }
  }
});

test('a supplier name finds the supplier, its purchase orders and receipts, only in this workspace', async () => {
  const res = await search(owner, { q: 'acme', types: ['supplier', 'purchaseOrder', 'goodsReceipt', 'payment'] });
  assert.deepEqual(idsOf(res, 'supplier'), [ids.acme]);
  assert.deepEqual(idsOf(res, 'purchaseOrder'), [ids.po]);
  assert.deepEqual(idsOf(res, 'goodsReceipt'), [ids.receipt], 'receipts match their order\'s supplier');
  assert.deepEqual(idsOf(res, 'payment'), [ids.payment]);
  const po = group(res, 'purchaseOrder').items[0];
  assert.equal(po.props.supplierName, 'Acme Baja');
  assert.equal(po.props.status, 'received');
  assert.equal(po.props.unitsReceived, 10);
  assert.equal(po.props.orderDate, '2026-03-02');
  assert.ok(!JSON.stringify(res).includes(ids.foreignPo), 'nothing from the other workspace');
  // Several words must all match.
  assert.deepEqual(idsOf(await search(owner, { q: 'acme restock', types: ['purchaseOrder'] }), 'purchaseOrder'), [ids.po]);
  assert.deepEqual(idsOf(await search(owner, { q: 'acme kayu', types: ['purchaseOrder'] }), 'purchaseOrder'), []);
  // LIKE wildcards are literal.
  assert.equal(group(await search(owner, { q: '%%', types: ['supplier'] }), 'supplier').total, 0);
});

test('a document reference finds the document and the records that point to it', async () => {
  const ref = recordReference('purchaseOrder', ids.po);
  assert.match(ref, /^PO-[0-9A-F]{8}$/);
  const res = await search(owner, { q: ref, types: ['purchaseOrder', 'goodsReceipt', 'payment', 'supplier'] });
  assert.deepEqual(idsOf(res, 'purchaseOrder'), [ids.po]);
  assert.deepEqual(idsOf(res, 'goodsReceipt'), [ids.receipt]);
  assert.deepEqual(idsOf(res, 'payment'), [ids.payment]);
  assert.deepEqual(idsOf(res, 'supplier'), []);
  // Lower case and without the prefix work too.
  assert.deepEqual(idsOf(await search(owner, { q: ids.po.slice(0, 8), types: ['purchaseOrder'] }), 'purchaseOrder'), [ids.po]);
  // Another workspace's reference finds nothing.
  assert.equal(group(await search(owner, { q: recordReference('purchaseOrder', ids.foreignPo), types: ['purchaseOrder'] }), 'purchaseOrder').total, 0);
});

test('a purchase order shows its supplier, products, receipts and payments', async () => {
  const rec = await readOntologyRecord(ctx(owner), ws, 'purchaseOrder', ids.po);
  const rel = (k) => rec.relations.find((r) => r.key === k);
  assert.deepEqual(rel('supplier').items.map((i) => i.id), [ids.acme]);
  assert.deepEqual(rel('products').items.map((i) => i.id), [ids.bolt]);
  assert.deepEqual(rel('goodsReceipts').items.map((i) => i.id), [ids.receipt]);
  assert.equal(rel('goodsReceipts').items[0].props.units, 10);
  assert.deepEqual(rel('payments').items.map((i) => i.id), [ids.payment]);
  assert.deepEqual(rec.hiddenRelations, []);

  const receipt = await readOntologyRecord(ctx(owner), ws, 'goodsReceipt', ids.receipt);
  const r = (k) => receipt.relations.find((x) => x.key === k);
  assert.deepEqual(r('purchaseOrder').items.map((i) => i.id), [ids.po]);
  assert.equal(r('journalEntries').total, 1, 'the receipt posted one journal entry');
  assert.equal(receipt.item.props.supplierName, 'Acme Baja');

  const supplier = await readOntologyRecord(ctx(owner), ws, 'supplier', ids.acme);
  assert.deepEqual(supplier.relations[0].items.map((i) => i.id), [ids.po]);

  const product = await readOntologyRecord(ctx(owner), ws, 'product', ids.bolt);
  const p = (k) => product.relations.find((x) => x.key === k);
  assert.deepEqual(p('purchaseOrders').items.map((i) => i.id).sort(), [ids.po, ids.po2].sort());
  assert.equal(p('purchaseOrders').total, 2);
  assert.deepEqual(p('salesOrders').items.map((i) => i.id), [ids.so]);
});

test('invoices lead to their sales order, customer and journal entries, and back', async () => {
  const inv = await readOntologyRecord(ctx(finance), ws, 'invoice', ids.invoice);
  const rel = (k) => inv.relations.find((r) => r.key === k);
  assert.deepEqual(rel('salesOrder').items.map((i) => i.id), [ids.so]);
  assert.deepEqual(rel('customer').items.map((i) => i.id), [ids.customer]);
  assert.equal(rel('journalEntries').total, 1);
  const entryId = rel('journalEntries').items[0].id;
  const entryNo = rel('journalEntries').items[0].props.entryNo;

  const entry = await readOntologyRecord(ctx(finance), ws, 'journalEntry', entryId);
  assert.deepEqual(entry.relations.find((r) => r.key === 'sourceInvoice').items.map((i) => i.id), [ids.invoice]);
  assert.equal(entry.relations.find((r) => r.key === 'sourcePayment').total, 0);
  assert.ok(entry.relations.find((r) => r.key === 'accounts').total >= 2);
  // Entry numbers and the source document's reference find the entry.
  assert.ok(idsOf(await search(finance, { q: `JE-${entryNo}`, types: ['journalEntry'] }), 'journalEntry').includes(entryId));
  assert.ok(idsOf(await search(finance, { q: recordReference('invoice', ids.invoice), types: ['journalEntry'] }), 'journalEntry').includes(entryId));
  // A sales order reference finds its invoice.
  assert.deepEqual(idsOf(await search(finance, { q: recordReference('salesOrder', ids.so), types: ['invoice'] }), 'invoice'), [ids.invoice]);
});

test('status and date filters, counts and pages match the database', async () => {
  const pending = await search(owner, { q: '', types: ['purchaseOrder'], statuses: ['pending'] });
  assert.deepEqual(idsOf(pending, 'purchaseOrder'), [ids.po2]);
  const march = await search(owner, { q: '', types: ['purchaseOrder'], dateFrom: '2026-03-01', dateTo: '2026-03-31' });
  assert.deepEqual(idsOf(march, 'purchaseOrder'), [ids.po]);

  // 25 more orders: first page of 20, then the rest; totals equal SQL.
  for (let i = 0; i < 25; i++) {
    await run(db, owner, `select erp_create_purchase_order_v3($1, $2, 'Acme Baja', '2026-04-01'::date + $3::int, '', $4::jsonb, null, null)`,
      [ws, ids.acme, i, items([ids.bolt, 1, 1])]);
  }
  const [{ n }] = await admin(db, `select count(*)::int n from erp_purchase_orders where workspace_id = $1 and supplier_name ilike '%acme%'`, [ws]);
  const page1 = await search(owner, { q: 'acme', types: ['purchaseOrder'] });
  const page2 = await search(owner, { q: 'acme', types: ['purchaseOrder'], offset: 20 });
  assert.equal(page1.groups[0].total, n);
  assert.equal(page1.groups[0].items.length, 20);
  assert.equal(page1.groups[0].hasMore, true);
  assert.equal(page2.groups[0].items.length, n - 20);
  assert.equal(page2.groups[0].hasMore, false);
  assert.equal(new Set([...idsOf(page1, 'purchaseOrder'), ...idsOf(page2, 'purchaseOrder')]).size, n, 'no overlap between pages');
  // Newest first.
  const dates = page1.groups[0].items.map((i) => i.props.orderDate);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('new, changed and cancelled records are found immediately (no copy to keep in sync)', async () => {
  const [{ id }] = await run(db, owner,
    `select erp_create_purchase_order_v3($1, $2, 'Cahaya Tekstil', current_date, '', $3::jsonb, null, null) as id`, [ws, null, items([ids.bolt, 1, 1])]);
  assert.deepEqual(idsOf(await search(owner, { q: 'cahaya', types: ['purchaseOrder'] }), 'purchaseOrder'), [id]);
  await run(db, owner, `select erp_cancel_purchase_order($1, 'Ordered by mistake')`, [id]);
  const cancelled = await search(owner, { q: 'cahaya', types: ['purchaseOrder'], statuses: ['cancelled'] });
  assert.deepEqual(idsOf(cancelled, 'purchaseOrder'), [id]);
  assert.deepEqual(idsOf(await search(owner, { q: 'by mistake', types: ['purchaseOrder'] }), 'purchaseOrder'), [id], 'cancel reason is searchable');
  await run(db, owner, `update erp_suppliers set name = 'Acme Baja Nusantara' where id = $1`, [ids.acme]);
  assert.deepEqual(idsOf(await search(owner, { q: 'nusantara', types: ['supplier'] }), 'supplier'), [ids.acme]);
});

test('members see the workspace; outsiders and removed members see nothing', async () => {
  // Finance reads everything; Inventory reads suppliers and purchasing: both find these records.
  for (const member of [finance, inventory]) {
    const res = await search(member, { q: 'acme', types: ['supplier', 'purchaseOrder'] });
    assert.deepEqual(idsOf(res, 'supplier'), [ids.acme]);
    assert.deepEqual(res.excludedTypes, []);
  }
  await rejects(search(outsider, { q: 'acme', types: ['supplier'] }), 'notMember');
  await rejects(readOntologyRecord(ctx(outsider), ws, 'purchaseOrder', ids.po), 'notMember');
  // Their own workspace has only their records.
  const own = await search(outsider, { q: 'acme', types: ['purchaseOrder'] }, outsiderWs);
  assert.deepEqual(idsOf(own, 'purchaseOrder'), [ids.foreignPo]);
  // A record id from another workspace is "not found", never shown.
  await rejects(readOntologyRecord(ctx(outsider), outsiderWs, 'purchaseOrder', ids.po), 'notFound');
  // Calling the database function directly for another workspace is refused.
  await expectError(run(db, outsider,
    `select erp_ontology_search($1, 'supplier', array['%a%'], null, null, null, null, null, null, 5, 0)`, [ws]), /Not allowed/);
  await expectError(run(db, outsider,
    `select erp_ontology_search($1, 'erp_suppliers; drop table x', null, null, null, null, null, null, null, 5, 0)`, [outsiderWs]), /Unknown object type/);

  const removed = await createUser(db, 'onto-removed');
  await join(removed, 'finance');
  assert.equal(group(await search(removed, { q: 'acme', types: ['supplier'] }), 'supplier').total, 1);
  await run(db, owner, `select erp_remove_workspace_member($1, $2, 'Left the company')`, [ws, removed.id]);
  await rejects(search(removed, { q: 'acme', types: ['supplier'] }), 'notMember');
});

test('the workspace two-factor rule applies to search', async () => {
  const [{ workspace_id: mfaWs }] = await admin(db,
    `insert into erp_workspaces (owner_id, name, is_personal, require_mfa) values ($1, 'Strict', false, true) returning id as workspace_id`, [owner.id]);
  await admin(db, `insert into erp_workspace_members (workspace_id, user_id, role, status) values ($1, $2, 'finance', 'active')`, [mfaWs, finance.id]);
  await rejects(search({ ...finance, aal: 'aal1' }, { q: 'acme', types: ['supplier'] }, mfaWs), 'forbidden');
});

test('with workspaces off, people search only their own records', async () => {
  const res = await search(outsider, { q: 'acme', types: ['purchaseOrder'] }, null, false);
  assert.deepEqual(idsOf(res, 'purchaseOrder'), [ids.foreignPo]);
});

test('searches and record views are logged without search text; only auditors see others\' entries', async () => {
  const before = (await admin(db, `select count(*)::int n from erp_access_log where actor_id = $1`, [inventory.id]))[0].n;
  await search(inventory, { q: 'secret-term acme', types: ['supplier', 'purchaseOrder'] });
  await readOntologyRecord(ctx(inventory), ws, 'purchaseOrder', ids.po);
  const rows = await admin(db, `select * from erp_access_log where actor_id = $1 order by created_at`, [inventory.id]);
  assert.equal(rows.length, before + 2);
  const [s, v] = rows.slice(-2);
  assert.deepEqual([s.action, s.object_types, s.workspace_id], ['search', ['supplier', 'purchaseOrder'], ws]);
  assert.deepEqual([v.action, v.object_types, v.object_id], ['view', ['purchaseOrder'], ids.po]);
  assert.ok(!JSON.stringify(rows).includes('secret-term'), 'search text is never stored');

  const visibleTo = async (user) => (await run(db, user, `select actor_id from erp_access_log where workspace_id = $1`, [ws])).map((r) => r.actor_id);
  assert.ok((await visibleTo(owner)).includes(inventory.id), 'owner (audit permission) sees members\' entries');
  assert.deepEqual([...new Set(await visibleTo(finance))], [finance.id], 'others see only their own');
  await expectError(run(db, inventory, `insert into erp_access_log (actor_id, action) values ($1, 'search')`, [owner.id]), /permission denied/);
  await expectError(run(db, owner, `delete from erp_access_log`), /permission denied/);
});

test('invalid requests are refused before reaching the database', () => {
  assert.equal(validateSearch({ q: 'a', types: ['supplier'] }).error, 'queryTooShort');
  assert.equal(validateSearch({ q: 'ja', types: ['supplier', 'customer'] }).error, 'queryTooShort', 'several types need 3 characters');
  assert.ok(validateSearch({ q: 'ja', types: ['supplier'] }).ok);
  assert.equal(validateSearch({ q: 'acme', types: ['erp_suppliers'] }).error, 'invalidTypes');
  assert.equal(validateSearch({ q: 'acme', types: ['supplier', 'purchaseOrder'], statuses: ['pending'] }).error, 'invalidStatus');
  assert.equal(validateSearch({ q: 'acme', types: ['purchaseOrder'], statuses: ['shipped'] }).error, 'invalidStatus');
  assert.equal(validateSearch({ q: 'acme', types: ['purchaseOrder'], dateFrom: '2026-13-01' }).error, 'invalidDate');
  assert.equal(validateSearch({ q: 'acme', types: ['supplier', 'purchaseOrder'], offset: 20 }).error, 'invalidOffset');
  assert.equal(validateSearch({ q: 'x'.repeat(101), types: ['supplier'] }).error, 'queryTooLong');
  assert.ok(validateSearch({ q: '', types: ['purchaseOrder'], statuses: ['pending'] }).ok, 'filters alone may browse one type');
});

test('receipts match a very common supplier word too (more than 2,000 matching orders)', async () => {
  // Bulk orders for the same supplier, written directly (no receipts, no ledger).
  await admin(db, `set session_replication_role = replica`);
  await admin(db,
    `insert into erp_purchase_orders (user_id, workspace_id, supplier_id, supplier_name, order_date, status, total)
     select $1, $2, $3, 'Acme Baja Nusantara', date '2025-01-01' + (g % 300), 'pending', 1 from generate_series(1, 2100) g`,
    [owner.id, ws, ids.acme]);
  await admin(db, `set session_replication_role = origin`);
  const res = await search(owner, { q: 'acme', types: ['goodsReceipt'] });
  assert.deepEqual(idsOf(res, 'goodsReceipt'), [ids.receipt]);
  assert.equal(group(res, 'goodsReceipt').total, 1);
  assert.ok(group(await search(owner, { q: 'acme', types: ['purchaseOrder'] }), 'purchaseOrder').total > 100, 'counts stop above the cap');
});

test('order lines: the rewritten own-records policy admits exactly the owner\'s lines', async () => {
  const lines = await run(db, owner, `select id from erp_purchase_order_items where purchase_order_id = $1`, [ids.po]);
  assert.equal(lines.length, 1);
  assert.equal((await run(db, outsider, `select id from erp_purchase_order_items where purchase_order_id = $1`, [ids.po])).length, 0);
  assert.equal((await run(db, outsider, `select id from erp_sales_order_items where sales_order_id = $1`, [ids.so])).length, 0);
  // Members read through the member policy, unchanged.
  assert.equal((await run(db, finance, `select id from erp_purchase_order_items where purchase_order_id = $1`, [ids.po])).length, 1);
  // Nobody can attach lines to someone else's order (checked on write).
  await expectError(run(db, outsider,
    `insert into erp_purchase_order_items (purchase_order_id, product_name, qty, price) values ($1, 'x', 1, 1)`, [ids.po]),
    /permission denied|row-level security/);
});
