import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, asUser, admin, expectError } from './harness.mjs';
import { listMigrations, migrate } from '../../scripts/db/migrator.mjs';

let db;
let owner;
let ws;
let branch;

const invoice = async (user, workspace, date, amount = 10) =>
  (
    await run(
      db,
      user,
      `select erp_create_invoice_v5($1, null, 'Budi', $2::date, $2::date, $3, 0, null, null) as id`,
      [workspace, date, amount]
    )
  )[0].id;
const docNo = async (table, id) =>
  (await admin(db, `select doc_no from ${table} where id = $1`, [id]))[0].doc_no;
const pay = async (type, date, invoiceId = null) =>
  (
    await run(
      db,
      owner,
      `insert into erp_payments (user_id, workspace_id, payment_type, party, amount, payment_date, invoice_id)
    values ($1, $2, $3, 'Budi', 1, $4::date, $5) returning id`,
      [owner.id, ws, type, date, invoiceId]
    )
  )[0].id;

const existing = {};

before(async () => {
  // A database from before numbering, with documents in it.
  db = await createDb({ through: '20261012000005' });
  owner = await createUser(db, 'numbers-owner');
  [{ workspace_id: ws }] = await run(
    db,
    owner,
    `select workspace_id from erp_my_workspaces() where is_personal`
  );
  [{ id: branch }] = await run(db, owner, `select erp_create_erp('Branch') as id`);
  existing.jan5 = await invoice(owner, ws, '2026-01-05');
  existing.dec30 = await invoice(owner, ws, '2025-12-30');
  existing.jan2 = await invoice(owner, ws, '2026-01-02');
  existing.received = await pay('incoming', '2026-02-01', existing.jan2);
  existing.paid = await pay('outgoing', '2026-02-01');
  [{ id: existing.so }] = await run(
    db,
    owner,
    `select erp_create_sales_order_v3($1, null, 'Budi', '2026-03-01', '', $2::jsonb, null, null) as id`,
    [ws, JSON.stringify([{ product_name: 'Service', qty: 1, price: 5 }])]
  );
  [{ id: existing.po }] = await run(
    db,
    owner,
    `select erp_create_purchase_order_v3($1, null, 'Parts', '2026-03-01', '', $2::jsonb, null, null) as id`,
    [ws, JSON.stringify([{ product_name: 'Bolt', qty: 1, price: 5 }])]
  );

  await migrate(
    { exec: (sql) => db.exec(sql), query: (sql, params) => db.query(sql, params) },
    { migrations: listMigrations() }
  );
});

test('existing documents are numbered in date order, per year and type', async () => {
  assert.equal(await docNo('erp_invoices', existing.dec30), 'INV/2025/0001');
  assert.equal(await docNo('erp_invoices', existing.jan2), 'INV/2026/0001');
  assert.equal(await docNo('erp_invoices', existing.jan5), 'INV/2026/0002');
  assert.equal(await docNo('erp_payments', existing.received), 'RCV/2026/0001');
  assert.equal(await docNo('erp_payments', existing.paid), 'PAY/2026/0001');
  assert.equal(await docNo('erp_sales_orders', existing.so), 'SO/2026/0001');
  assert.equal(await docNo('erp_purchase_orders', existing.po), 'PO/2026/0001');
  const audit = await admin(
    db,
    `select count(*)::int as n from erp_audit_log where record_id = $1 and action = 'UPDATE'`,
    [existing.jan5]
  );
  assert.equal(audit[0].n, 0, 'numbering existing documents is not an edit');
});

test('new documents continue the sequence; each ERP counts on its own', async () => {
  assert.equal(
    await docNo('erp_invoices', await invoice(owner, ws, '2026-04-01')),
    'INV/2026/0003'
  );
  assert.equal(
    await docNo('erp_invoices', await invoice(owner, ws, '2025-06-01')),
    'INV/2025/0002'
  );
  assert.equal(
    await docNo('erp_invoices', await invoice(owner, branch, '2026-04-01')),
    'INV/2026/0001'
  );
  assert.equal(await docNo('erp_payments', await pay('outgoing', '2026-04-02')), 'PAY/2026/0002');
});

test('a document that is rolled back gives its number back', async () => {
  await expectError(
    asUser(db, owner, async (q) => {
      await q(
        `select erp_create_invoice_v5($1, null, 'Budi', '2026-05-01', '2026-05-01', 10, 0, null, null)`,
        [ws]
      );
      await q(`select 1 / 0`);
    }),
    /division by zero/
  );
  assert.equal(
    await docNo('erp_invoices', await invoice(owner, ws, '2026-05-01')),
    'INV/2026/0004'
  );
});

test('numbers never change and are unique in their ERP', async () => {
  await expectError(
    admin(db, `update erp_invoices set doc_no = 'INV/2026/9999' where id = $1`, [existing.jan5]),
    /cannot be changed/
  );
  await expectError(
    run(db, owner, `update erp_invoices set doc_no = 'X' where id = $1`, [existing.jan5]),
    /permission denied|can only be changed|cannot be changed/
  );
  await expectError(
    admin(
      db,
      `insert into erp_invoices (user_id, workspace_id, customer_name, doc_no) values ($1, $2, 'Dup', 'INV/2026/0001')`,
      [owner.id, ws]
    ),
    /duplicate key/
  );
});

test('search finds documents by number', async () => {
  const search = async (type, pattern) =>
    (
      await run(
        db,
        owner,
        `select erp_ontology_search($1, $2, array[$3], null, null, null, null, null, null, 10, 0) as r`,
        [ws, type, pattern]
      )
    )[0].r;
  assert.match(
    JSON.stringify(await search('invoice', '%inv/2026/0002%')),
    new RegExp(existing.jan5)
  );
  assert.match(
    JSON.stringify(await search('payment', '%pay/2026/0001%')),
    new RegExp(existing.paid)
  );
  assert.match(
    JSON.stringify(await search('salesOrder', '%so/2026/0001%')),
    new RegExp(existing.so)
  );
  assert.match(
    JSON.stringify(await search('purchaseOrder', '%po/2026/0001%')),
    new RegExp(existing.po)
  );
  assert.doesNotMatch(
    JSON.stringify(await search('invoice', '%inv/2026/0002%')),
    new RegExp(existing.jan2)
  );
});

test('rollback removes document numbers', async () => {
  // The schema before weigh tickets and production runs, which use erp_doc__assign.
  const d = await createDb({ through: '20261012000022' });
  // Rollbacks run newest first: delivery and receipt numbers use the same function.
  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261012000021_erp_delivery_notes.sql', import.meta.url),
      'utf8'
    )
  );
  await d.exec(
    readFileSync(
      new URL(
        '../../db/rollback/rollback_20261012000006_erp_document_numbers.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  const cols = await d.query(
    `select count(*)::int as n from information_schema.columns where column_name = 'doc_no' and table_schema = 'public'`
  );
  assert.equal(cols.rows[0].n, 0);
  const def = await d.query(
    `select pg_get_functiondef(p.oid) as d from pg_proc p where proname = 'erp_ontology_search'`
  );
  assert.ok(!def.rows[0].d.includes('doc_no'), 'search works without the column');
  await d.close();
});
