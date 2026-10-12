import { readFileSync } from 'node:fs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb, applyMigrations, createUser, run, runOnPath, admin, expectError, items } from './harness.mjs';

const BEFORE_LEDGER = '20260928010000';

let db;
let legacyOwner;

async function balances(user, workspaceId = null) {
  const rows = await run(db, user, `select system_key, balance::float as balance from erp_trial_balance($1, null, null)`, [workspaceId]);
  return Object.fromEntries(rows.filter((r) => r.system_key && r.balance !== 0).map((r) => [r.system_key, r.balance]));
}

async function assertBalanced(user) {
  const [t] = await admin(db,
    `select coalesce(sum(l.debit),0)::float as d, coalesce(sum(l.credit),0)::float as c, count(distinct e.id)::int as n
     from erp_journal_entries e join erp_journal_lines l on l.entry_id = e.id where e.user_id = $1`, [user.id]);
  assert.equal(t.d, t.c, 'total debits equal total credits');
  const unbalanced = await admin(db,
    `select e.id from erp_journal_entries e join erp_journal_lines l on l.entry_id = e.id
     where e.user_id = $1 group by e.id having sum(l.debit) <> sum(l.credit) or count(*) < 2`, [user.id]);
  assert.deepEqual(unbalanced, []);
  return t.n;
}

// Before the ledger existed, invoices were made with the first version.
const legacyInvoice = async (user, total) =>
  (await run(db, user, `select erp_create_invoice(null, 'Ana', current_date, current_date + 30, $1) as id`, [total]))[0].id;
const invoice = async (user, total, date = 'current_date') =>
  (await run(db, user, `select erp_create_invoice_v5(null, null, 'Ana', ${date}, ${date} + 30, $1, 0, null, null) as id`, [total]))[0].id;
const incoming = async (user, amount, invoiceId = null) =>
  (await run(db, user, `insert into erp_payments (user_id, payment_type, party, amount, invoice_id) values ($1, 'incoming', 'Ana', $2, $3) returning id`, [user.id, amount, invoiceId]))[0].id;

before(async () => {
  // Data written before the ledger existed, to check the backfill.
  db = await createDb({ through: BEFORE_LEDGER });
  legacyOwner = await createUser(db, 'gl-legacy');
  const inv = await legacyInvoice(legacyOwner, 200);
  await incoming(legacyOwner, 150, inv);
  await run(db, legacyOwner, `insert into erp_transactions (user_id, transaction_type, category, amount, description) values ($1, 'expense', 'Rent', 50, 'Rent')`, [legacyOwner.id]);
  await run(db, legacyOwner, `insert into erp_products (user_id, name, current_stock, purchase_price, selling_price) values ($1, 'Old stock', 10, 3, 5)`, [legacyOwner.id]);
  await applyMigrations(db, { after: BEFORE_LEDGER });
});

test('existing documents are posted once by the backfill, balanced', async () => {
  assert.deepEqual(await balances(legacyOwner), {
    cash: 100,          // 150 received − 50 rent
    ar: 50,             // 200 invoiced − 150 received
    inventory: 30,      // 10 × 3 opening stock
    opening: 30,
    revenue: 200,
    expenses: 50,
  });
  const entries = await assertBalanced(legacyOwner);
  assert.equal(entries, 4);
  // Re-running the backfill posts nothing twice.
  // Older migrations define views with whole-number columns: take the
  // decimal-quantity change back first; the re-run applies it again.
  await db.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000015_erp_decimal_quantities_units.sql', import.meta.url), 'utf8'));
  await applyMigrations(db, { after: '20260928999999' });
  assert.equal(await assertBalanced(legacyOwner), 4);
});

test('invoices, payments and their voids post and reverse', async () => {
  const user = await createUser(db, 'gl-sales');
  const inv = await invoice(user, 100);
  const pay = await incoming(user, 40, inv);
  assert.deepEqual(await balances(user), { ar: 60, cash: 40, revenue: 100 });

  await run(db, user, `select erp_void_payment($1, 'Bounced transfer')`, [pay]);
  assert.deepEqual(await balances(user), { ar: 100, revenue: 100 });
  await run(db, user, `select erp_void_invoice($1, 'Issued twice')`, [inv]);
  assert.deepEqual(await balances(user), {});
  // The cash-book mirror of the payment is not posted a second time.
  const sources = await admin(db, `select source_type from erp_journal_entries where user_id = $1 order by entry_no`, [user.id]);
  assert.deepEqual(sources.map((s) => s.source_type), ['invoice', 'payment', 'payment_void', 'invoice_void']);
  await assertBalanced(user);
});

test('cash income/expense and unlinked payments post to other income and expenses', async () => {
  const user = await createUser(db, 'gl-cash');
  await run(db, user, `insert into erp_transactions (user_id, transaction_type, category, amount, description) values ($1, 'income', 'Interest', 12, 'Bank interest')`, [user.id]);
  await run(db, user, `insert into erp_transactions (user_id, transaction_type, category, amount, description) values ($1, 'expense', 'Rent', 30, 'Rent')`, [user.id]);
  await incoming(user, 5);
  await run(db, user, `insert into erp_payments (user_id, payment_type, party, amount) values ($1, 'outgoing', 'Utility', 7)`, [user.id]);
  assert.deepEqual(await balances(user), { cash: -20, other_income: 17, expenses: 37 });
  await assertBalanced(user);
});

test('receipts, deliveries (at cost), stock adjustments and reversals post to inventory', async () => {
  const user = await createUser(db, 'gl-stock');
  const [{ id: product }] = await run(db, user,
    `insert into erp_products (user_id, name, current_stock, purchase_price, selling_price) values ($1, 'Widget', 0, 4, 10) returning id`, [user.id]);
  const [{ id: po }] = await run(db, user, `select erp_create_purchase_order_v3(null, null, 'Supplier', current_date, '', $1::jsonb, null, null) as id`, [items([product, 10, 4])]);
  await run(db, user, `select erp_update_purchase_order_status($1, 'approved')`, [po]);
  const [poLine] = await admin(db, `select id from erp_purchase_order_items where purchase_order_id = $1`, [po]);
  const [{ id: receipt }] = await run(db, user, `select erp_record_purchase_receipt_v2($1, $2::jsonb, $3, '', null) as id`, [po, JSON.stringify([{ item_id: poLine.id, qty: 10 }]), randomUUID()]);
  assert.deepEqual(await balances(user), { inventory: 40, ap: 40 });

  const [{ id: so }] = await run(db, user, `select erp_create_sales_order_v3(null, null, 'Walk-in', current_date, '', $1::jsonb, null, null) as id`, [items([product, 3, 10])]);
  await run(db, user, `select erp_issue_invoice_from_sales_order_v2($1, null, null)`, [so]);
  const [soLine] = await admin(db, `select id from erp_sales_order_items where sales_order_id = $1`, [so]);
  const [{ id: delivery }] = await run(db, user, `select erp_record_sales_delivery($1, $2::jsonb, $3) as id`, [so, JSON.stringify([{ item_id: soLine.id, qty: 3 }]), randomUUID()]);
  assert.deepEqual(await balances(user), { inventory: 28, ap: 40, ar: 30, revenue: 30, cogs: 12 });

  // Reversals mirror the original entry even after the purchase price changes.
  await run(db, user, `update erp_products set purchase_price = 9 where id = $1`, [product]);
  await run(db, user, `select erp_reverse_fulfillment_event($1, 'Shipped to wrong address', $2)`, [delivery, randomUUID()]);
  assert.deepEqual(await balances(user), { inventory: 40, ap: 40, ar: 30, revenue: 30 });

  await run(db, user, `select erp_reverse_fulfillment_event($1, 'Wrong supplier', $2)`, [receipt, randomUUID()]);
  assert.deepEqual(await balances(user), { ar: 30, revenue: 30 });

  await run(db, user, `select erp_adjust_stock($1, 'in', 2, 'Found in stock count')`, [product]);
  await run(db, user, `select erp_adjust_stock($1, 'out', 1, 'Damaged')`, [product]);
  const after = await balances(user);
  // Adjustments are valued at the moving-average cost (4), not the edited price (9).
  assert.equal(after.inventory, 4, '(2 − 1) × average cost 4');
  assert.equal(after.inventory_adjust, -4);
  await assertBalanced(user);
});

test('entries must balance, even when written directly at database level', async () => {
  const user = await createUser(db, 'gl-balance');
  await invoice(user, 10);
  const [e] = await admin(db, `select id from erp_journal_entries where user_id = $1`, [user.id]);
  await expectError(
    db.transaction(async (tx) => {
      const [line] = (await tx.query(`select id from erp_journal_lines where entry_id = $1 and debit > 0`, [e.id])).rows;
      await tx.query(`update erp_journal_lines set debit = 11 where id = $1`, [line.id]);
    }),
    /not balanced/
  );
});

test('the lock date closes the books; only the owner can reopen', async () => {
  const owner = await createUser(db, 'gl-lock');
  const [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  const admin1 = await createUser(db, 'gl-lock-admin');
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, 'admin', 24, '')`, [ws]);
  await run(db, admin1, `select erp_redeem_workspace_invitation($1)`, [access_code]);

  // Only the owner chooses the base currency; admins may close periods.
  await expectError(run(db, admin1, `select erp_accounting_settings_set($1, 'IDR', null, 0)`, [ws]), /Only the workspace owner/);
  await run(db, owner, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  await run(db, admin1, `select erp_accounting_settings_set($1, 'IDR', current_date - 5, 0)`, [ws]);
  const [s] = await run(db, owner, `select base_currency, lock_date::text = (current_date - 5)::text as locked from erp_accounting_settings_get(null)`);
  assert.deepEqual(s, { base_currency: 'IDR', locked: true });

  await expectError(invoice(owner, 10, 'current_date - 10'), /books are closed through/);
  await invoice(owner, 10, 'current_date - 4');
  await expectError(run(db, admin1, `select erp_accounting_settings_set($1, 'IDR', current_date - 20, 0)`, [ws]), /Only the owner can reopen/);
  await expectError(run(db, owner, `select erp_accounting_settings_set(null, 'IDR', current_date + 1, 0)`), /cannot be in the future/);
  await expectError(run(db, owner, `select erp_accounting_settings_set(null, 'rupiah', null, 0)`), /3-letter ISO code/);
  await run(db, owner, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  await invoice(owner, 10, 'current_date - 10');
});

test('manual journals are validated, balanced and reversible once', async () => {
  const user = await createUser(db, 'gl-manual');
  await run(db, user, `select * from erp_accounting_settings_get(null)`);
  const acc = Object.fromEntries((await admin(db, `select system_key, id from erp_gl_accounts where user_id = $1`, [user.id])).map((a) => [a.system_key, a.id]));
  const post = (lines, memo = 'Accrued rent') => run(db, user, `select erp_post_journal(null, current_date, $1, $2::jsonb) as id`, [memo, JSON.stringify(lines)]);

  await expectError(post([{ account_id: acc.expenses, debit: 10 }]), /2 to 50 lines/);
  await expectError(post([{ account_id: acc.expenses, debit: 10 }, { account_id: acc.ap, credit: 9 }]), /not balanced/);
  await expectError(post([{ account_id: acc.expenses, debit: 10, credit: 10 }, { account_id: acc.ap, credit: 10 }]), /either a debit or a credit/);
  await expectError(post([{ account_id: acc.expenses, debit: 10 }, { account_id: randomUUID(), credit: 10 }]), /not available/);
  await expectError(post([{ account_id: acc.expenses, debit: 10 }, { account_id: acc.ap, credit: 10 }], 'x'), /at least 3 characters/);

  const [{ id }] = await post([{ account_id: acc.expenses, debit: 10 }, { account_id: acc.ap, credit: 10 }]);
  assert.deepEqual(await balances(user), { expenses: 10, ap: 10 });
  await run(db, user, `select erp_reverse_journal($1, 'Posted to the wrong month')`, [id]);
  assert.deepEqual(await balances(user), {});
  await expectError(run(db, user, `select erp_reverse_journal($1, 'Again')`, [id]), /already been reversed/);

  await invoice(user, 5);
  const [auto] = await admin(db, `select id from erp_journal_entries where user_id = $1 and source_type = 'invoice'`, [user.id]);
  await expectError(run(db, user, `select erp_reverse_journal($1, 'Not allowed')`, [auto.id]), /reversed by voiding/);

  const [{ id: custom }] = await run(db, user, `select erp_create_gl_account(null, '6200', 'Travel', 'expense') as id`);
  await expectError(run(db, user, `select erp_create_gl_account(null, '6200', 'Dup', 'expense')`), /already exists/);
  await run(db, user, `select erp_set_gl_account_active($1, false)`, [custom]);
  await expectError(run(db, user, `select erp_set_gl_account_active($1, false)`, [acc.cash]), /cannot be deactivated/);
  await assertBalanced(user);
});

test('workspace members read the books by role; the ledger cannot be edited directly', async () => {
  const owner = await createUser(db, 'gl-ws-owner');
  const reader = await createUser(db, 'gl-ws-finance');
  const sales = await createUser(db, 'gl-ws-sales');
  const outsider = await createUser(db, 'gl-ws-outsider');
  const [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  for (const [user, role] of [[reader, 'finance'], [sales, 'sales']]) {
    const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`, [ws, role]);
    await run(db, user, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  }
  await invoice(owner, 70);

  assert.deepEqual(await balances(reader, ws), { ar: 70, revenue: 70 });
  const journal = await run(db, reader, `select entry_no, total_count::int as total, jsonb_array_length(lines) as n from erp_journal_list($1, null, null, null, 10, 0)`, [ws]);
  assert.deepEqual(journal, [{ entry_no: 1, total: 1, n: 2 }]);
  // Roles without 'read' (Sales, Inventory) do not see the books; nor do outsiders.
  for (const user of [outsider, sales]) {
    await expectError(run(db, user, `select * from erp_trial_balance($1, null, null)`, [ws]), /not allowed/);
    assert.deepEqual(await run(db, user, `select id from erp_journal_entries where workspace_id = $1`, [ws]), []);
  }

  const [acc] = await admin(db, `select id from erp_gl_accounts where user_id = $1 and system_key = 'cash'`, [owner.id]);
  await expectError(run(db, sales, `select erp_post_journal($1, current_date, 'Sales entry', $2::jsonb)`,
    [ws, JSON.stringify([{ account_id: acc.id, debit: 1 }, { account_id: acc.id, credit: 1 }])]), /not allowed/);
  await expectError(run(db, owner, `insert into erp_journal_entries (user_id, entry_no, entry_date, source_type) values ($1, 99, current_date, 'manual')`, [owner.id]), /permission denied/);
  await expectError(run(db, owner, `delete from erp_journal_entries where user_id = $1`, [owner.id]), /permission denied/);
  await expectError(run(db, owner, `update erp_journal_lines set debit = 0`), /permission denied/);
});

test('resetting an account also clears its ledger', async () => {
  const user = await createUser(db, 'gl-reset');
  await invoice(user, 10);
  await runOnPath(db, user, '/account/reset', `select erp_reset_workspace(null, 'transactions')`);
  assert.equal((await admin(db, `select count(*)::int as n from erp_journal_entries where user_id = $1`, [user.id]))[0].n, 0);
  assert.ok((await admin(db, `select count(*)::int as n from erp_gl_accounts where user_id = $1`, [user.id]))[0].n > 0, 'chart kept');
  await runOnPath(db, user, '/account/reset', `select erp_reset_workspace(null, 'all')`);
  assert.equal((await admin(db, `select count(*)::int as n from erp_gl_accounts where user_id = $1`, [user.id]))[0].n, 0);
});

// ─── Sales tax (20260929010000_erp_sales_tax.sql) ────────────────────────────

test('invoices with tax post revenue and output tax separately', async () => {
  const user = await createUser(db, 'tax-invoice');
  const [{ id }] = await run(db, user, `select erp_create_invoice_v5(null, null, 'Budi', current_date, current_date + 14, 1000, 11, null, null) as id`);
  const [inv] = await admin(db, `select total::float as total, tax_amount::float as tax, tax_rate::float as rate from erp_invoices where id = $1`, [id]);
  assert.deepEqual(inv, { total: 1110, tax: 110, rate: 11 });
  assert.deepEqual(await balances(user), { ar: 1110, revenue: 1000, tax_out: 110 });
  await incoming(user, 1110, id);
  assert.equal((await admin(db, `select payment_state from erp_invoices where id = $1`, [id]))[0].payment_state, 'paid');
  await expectError(run(db, user, `select erp_create_invoice_v5(null, null, 'Budi', current_date, current_date, 10, 101, null, null)`), /between 0 and 100/);
  await assertBalanced(user);
});

test('invoices issued from sales orders use the default tax rate once set', async () => {
  const user = await createUser(db, 'tax-so');
  const order = async () => (await run(db, user, `select erp_create_sales_order_v3(null, null, 'Walk-in', current_date, '', '[{"product_name":"Service","qty":2,"price":50}]'::jsonb, null, null) as id`))[0].id;
  const first = await order();
  const [{ id: plain }] = await run(db, user, `select erp_issue_invoice_from_sales_order_v2($1, null, null) as id`, [first]);
  assert.equal((await admin(db, `select total::float as t from erp_invoices where id = $1`, [plain]))[0].t, 100, 'no tax by default');

  // The base currency stays as it is (records exist); only the tax rate changes.
  await run(db, user, `select erp_accounting_settings_set(null, 'USD', null, 12)`);
  const [s] = await run(db, user, `select sales_tax_rate::float as rate from erp_accounting_settings_get(null)`);
  assert.equal(s.rate, 12);
  const second = await order();
  const [{ id: taxed }] = await run(db, user, `select erp_issue_invoice_from_sales_order_v2($1, null, null) as id`, [second]);
  const [inv] = await admin(db, `select total::float as total, tax_amount::float as tax from erp_invoices where id = $1`, [taxed]);
  assert.deepEqual(inv, { total: 112, tax: 12 });
  assert.deepEqual(await balances(user), { ar: 212, revenue: 200, tax_out: 12 });
  await expectError(run(db, user, `select erp_accounting_settings_set(null, 'USD', null, -1)`), /between 0 and 100/);
});
