import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, applyMigrations, createUser, run, asUser, admin, expectError, items } from './harness.mjs';
import { currencySettings, fetchAndStore, lookupRate, confirmBaseCurrency, currencyPreview, addRate as serviceAddRate } from '../../src/server/currency/service.ts';

let db;

async function balances(user, workspaceId = null) {
  const rows = await run(db, user, `select system_key, balance::float as balance from erp_trial_balance($1, null, null)`, [workspaceId]);
  return Object.fromEntries(rows.filter((r) => r.system_key && Math.abs(r.balance) > 0.0001).map((r) => [r.system_key, r.balance]));
}

async function assertBalanced(user) {
  const [t] = await admin(db,
    `select coalesce(sum(l.debit),0)::numeric as d, coalesce(sum(l.credit),0)::numeric as c
     from erp_journal_entries e join erp_journal_lines l on l.entry_id = e.id where e.user_id = $1`, [user.id]);
  assert.equal(String(t.d), String(t.c), 'total debits equal total credits');
}

async function documentBalance(user, key, sourceIds) {
  const [{ b }] = await admin(db,
    `select coalesce(sum(l.debit - l.credit), 0)::float as b
     from erp_journal_lines l join erp_journal_entries e on e.id = l.entry_id join erp_gl_accounts a on a.id = l.account_id
     where e.user_id = $1 and a.system_key = $2 and e.source_id = any($3::uuid[])`, [user.id, key, sourceIds]);
  return Math.round(b * 100) / 100;
}

const addRate = (user, from, to, rate, date = 'current_date', ws = null) =>
  run(db, user, `select erp_add_exchange_rate($1, $2, $3, $4, ${date}, 'test') as id`, [ws, from, to, rate]);

const importRates = (user, rows, ws = null) => asUser(db, user, async (q) => {
  await q(`select set_config('request.path', '/currency/import', true)`);
  return (await q(`select erp_import_exchange_rates($1, 'Frankfurter (ECB)', now(), $2::jsonb) as n`, [ws, JSON.stringify(rows)]))[0].n;
});

async function workspaceWith(owner, member, role) {
  const [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  if (member) {
    const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`, [ws, role]);
    await run(db, member, `select erp_redeem_workspace_invitation($1)`, [access_code]);
  }
  return ws;
}

before(async () => {
  db = await createDb();
});

test('rates: who may enter them, append-only history, deterministic lookup', async () => {
  const owner = await createUser(db, 'fx-owner');
  const finance = await createUser(db, 'fx-finance');
  const sales = await createUser(db, 'fx-sales');
  const outsider = await createUser(db, 'fx-outsider');
  const ws = await workspaceWith(owner, finance, 'finance');
  await workspaceWith(owner, sales, 'sales');

  // Finance (payments permission) may add rates; sales may not; outsiders cannot even look.
  const [{ id: first }] = await addRate(finance, 'EUR', 'IDR', 17000, "current_date - 3", ws);
  await expectError(addRate(sales, 'EUR', 'IDR', 1, 'current_date', ws), /not allowed/);
  await expectError(run(db, outsider, `select * from erp_exchange_rate_lookup($1, 'EUR', 'IDR', current_date)`, [ws]), /not allowed/);
  await expectError(addRate(owner, 'EUR', 'EUR', 1), /two different ISO currencies/);
  await expectError(addRate(owner, 'EUR', 'XXQ', 1), /two different ISO currencies/);
  await expectError(addRate(owner, 'EUR', 'IDR', 0), /greater than zero/);
  await expectError(addRate(owner, 'EUR', 'IDR', 1, 'current_date + 1'), /cannot be in the future/);

  // Nobody edits a rate, not even through the table.
  await expectError(run(db, owner, `update erp_exchange_rates set rate = 1 where id = $1`, [first]), /permission denied|cannot be changed/);
  await expectError(admin(db, `update erp_exchange_rates set rate = 1 where id = $1`, [first]), /cannot be changed/);

  const look = async (date) => (await run(db, sales, `select rate::text, rate_date::text, source, method, stale from erp_exchange_rate_lookup($1, 'EUR', 'IDR', ${date})`, [ws]))[0];
  assert.deepEqual(await look('current_date'), { rate: '17000.000000000000', rate_date: await dateText('current_date - 3'), source: 'manual', method: 'direct', stale: false });
  // A correction for the same date is a new row, and it wins.
  await addRate(finance, 'EUR', 'IDR', 17010.5, "current_date - 3", ws);
  assert.equal((await look('current_date')).rate, '17010.500000000000');
  // Before any rate: nothing. Long after: flagged stale.
  assert.equal(await look('current_date - 4'), undefined);
  assert.equal((await look('current_date + 20')).stale, true);
  // The inverse pair is used when it is the more recent one (1 / rate, 12 decimals).
  await addRate(finance, 'IDR', 'EUR', 0.00005, 'current_date', ws);
  assert.deepEqual(await look('current_date'), { rate: '20000.000000000000', rate_date: await dateText('current_date'), source: 'manual', method: 'inverse', stale: false });
  // Same data, same answer.
  assert.deepEqual(await look('current_date'), await look('current_date'));

  // Provider rates are recorded only by the server route; the same published rate once.
  await expectError(run(db, owner, `select erp_import_exchange_rates(null, 'x', now(), '[]'::jsonb)`), /by the ETNA server only/);
  assert.equal(await importRates(sales, [{ from: 'USD', to: 'IDR', rate: 16250.5, date: await dateText('current_date - 1') }], ws), 1);
  assert.equal(await importRates(sales, [{ from: 'USD', to: 'IDR', rate: 16250.5, date: await dateText('current_date - 1') }], ws), 0);
  await expectError(importRates(sales, [{ from: 'USD', to: 'IDR', rate: -1, date: await dateText('current_date') }], ws), /Invalid rate row/);
  const [imported] = await run(db, owner, `select source, provider, retrieved_at is not null as has_time from erp_exchange_rates where from_currency = 'USD'`);
  assert.deepEqual(imported, { source: 'frankfurter', provider: 'Frankfurter (ECB)', has_time: true });

  // Every addition is in the currency audit log.
  const audit = await run(db, owner, `select action from erp_currency_audit where user_id = $1 order by created_at`, [owner.id]);
  assert.deepEqual(audit.map((a) => a.action), ['rate_added', 'rate_added', 'rate_added', 'rates_imported']);
  // Outsiders see none of it.
  assert.equal((await run(db, outsider, `select id from erp_exchange_rates`)).length, 0);
  assert.equal((await run(db, outsider, `select id from erp_currency_audit`)).length, 0);
});

async function dateText(expr) {
  return (await admin(db, `select (${expr})::text as d`))[0].d;
}

test('base currency: owner only, previewed, confirmed once, then locked; amounts never rewritten', async () => {
  const owner = await createUser(db, 'base-owner');
  const adminUser = await createUser(db, 'base-admin');
  const ws = await workspaceWith(owner, adminUser, 'admin');

  // Empty books: the owner may pick any 2-decimal currency; admins may not.
  await expectError(run(db, adminUser, `select erp_accounting_settings_set($1, 'EUR', null, 0)`, [ws]), /Only the workspace owner/);
  await expectError(run(db, owner, `select erp_accounting_settings_set(null, 'KWD', null, 0)`), /cannot be the base currency/);
  await run(db, owner, `select erp_accounting_settings_set(null, 'EUR', null, 0)`);
  await run(db, owner, `select erp_accounting_settings_set(null, 'USD', null, 0)`);
  // Only through the functions.
  await expectError(admin(db, `update erp_accounting_settings set base_currency = 'IDR' where user_id = $1`, [owner.id]), /Settings → Currencies/);

  // Records appear; the base currency can no longer silently change.
  await run(db, owner, `select erp_create_invoice_v5(null, null, 'Toko', current_date, current_date, 1000, 0, null, 1)`);
  await run(db, owner, `select erp_create_invoice_v5(null, null, 'Toko', current_date, current_date, 250.5, 0, null, 1)`);
  await expectError(run(db, owner, `select erp_accounting_settings_set(null, 'IDR', null, 0)`), /confirm their currency/);

  const preview = (await run(db, owner, `select erp_currency_preview(null) as p`))[0].p;
  const invoices = preview.tables.find((t) => t.table === 'invoices');
  assert.equal(preview.baseCurrency, 'USD');
  assert.equal(invoices.baseRows, 2);
  assert.equal(Number(invoices.baseSum), 1250.5);
  assert.equal(preview.foreignDocuments, 0);
  // The settings were last saved (with USD) before the invoices, so these are certain.
  assert.equal(preview.status, 'unambiguous');
  await expectError(run(db, adminUser, `select erp_confirm_base_currency($1, 'USD', $2)`, [ws, preview.baseRows]), /Only the workspace owner/);

  // The owner says: those amounts were really rupiah. The count they reviewed must still hold.
  await expectError(run(db, owner, `select erp_confirm_base_currency(null, 'IDR', 1)`), /changed since the preview/);
  const before = await admin(db, `select id, total::text, base_total::text from erp_invoices where user_id = $1 order by id`, [owner.id]);
  const confirmed = (await run(db, owner, `select erp_confirm_base_currency(null, 'IDR', $1) as p`, [preview.baseRows]))[0].p;
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.baseCurrency, 'IDR');
  assert.deepEqual(await admin(db, `select id, total::text, base_total::text from erp_invoices where user_id = $1 order by id`, [owner.id]), before, 'no amount rewritten');
  assert.deepEqual(await balances(owner), { ar: 1250.5, revenue: 1250.5 }, 'ledger unchanged');

  // Locked from now on.
  await expectError(run(db, owner, `select erp_accounting_settings_set(null, 'USD', null, 0)`), /locked as IDR/);
  await expectError(run(db, owner, `select erp_confirm_base_currency(null, 'USD', 2)`), /already confirmed as IDR/);
  const [s] = await run(db, owner, `select base_currency, locked, can_change_base from erp_currency_settings_get(null)`);
  assert.deepEqual(s, { base_currency: 'IDR', locked: true, can_change_base: true });
  const log = await run(db, owner, `select action, details->>'previous' as prev, details->>'currency' as cur from erp_currency_audit where user_id = $1 and action like 'base%' order by created_at`, [owner.id]);
  assert.deepEqual(log, [
    { action: 'base_changed', prev: 'USD', cur: 'EUR' },
    { action: 'base_changed', prev: 'EUR', cur: 'USD' },
    { action: 'base_confirmed', prev: 'USD', cur: 'IDR' },
  ]);
});

test('a default base currency is never assumed, and foreign documents block a re-declaration', async () => {
  const owner = await createUser(db, 'base-default');
  // Nobody ever chose a currency (the USD default); a EUR invoice exists with a rate to it.
  await run(db, owner, `select erp_create_invoice_v5(null, null, 'Old', current_date, current_date, 10, 0, null, 1)`);
  await run(db, owner, `select erp_create_invoice_v5(null, null, 'Old', current_date, current_date, 10, 0, 'EUR', 1.08)`);
  const preview = (await run(db, owner, `select erp_currency_preview(null) as p`))[0].p;
  assert.equal(preview.baseCurrencyIsDefault, true);
  assert.equal(preview.status, 'needsDecision');
  assert.equal(preview.uncertainRows > 0, true);
  await expectError(run(db, owner, `select erp_confirm_base_currency(null, 'IDR', $1)`, [preview.baseRows]), /foreign-currency documents have exchange rates to USD/);
  // Confirming the current base is always possible.
  assert.equal((await run(db, owner, `select erp_confirm_base_currency(null, 'USD', $1) as p`, [preview.baseRows]))[0].p.status, 'confirmed');
});

test('invoices record the rate they used: stored rate for the date, entered rate, or a clear error', async () => {
  const owner = await createUser(db, 'inv-rates');
  await run(db, owner, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  await expectError(run(db, owner, `select erp_create_invoice_v5(null, null, 'A', current_date, current_date, 100, 0, 'EUR', null)`),
    /No exchange rate from EUR to IDR on or before/);
  const [{ id: rateId }] = await addRate(owner, 'EUR', 'IDR', 17123.45, 'current_date - 2');
  const [{ id: inv }] = await run(db, owner, `select erp_create_invoice_v5(null, null, 'A', current_date, current_date, 100, 0, 'EUR', null) as id`);
  const [row] = await admin(db, `select currency, fx_rate::text, fx_rate_source, fx_rate_id, fx_rate_date::text, base_total::text from erp_invoices where id = $1`, [inv]);
  assert.deepEqual(row, {
    currency: 'EUR', fx_rate: '17123.450000000000', fx_rate_source: 'rate_table', fx_rate_id: rateId,
    fx_rate_date: await dateText('current_date - 2'), base_total: '1712345.00',
  });
  const [{ id: manual }] = await run(db, owner, `select erp_create_invoice_v5(null, null, 'A', current_date, current_date, 100, 0, 'eur', 17000) as id`);
  assert.deepEqual((await admin(db, `select fx_rate_source, fx_rate_id, fx_rate_date::text from erp_invoices where id = $1`, [manual]))[0],
    { fx_rate_source: 'manual', fx_rate_id: null, fx_rate_date: await dateText('current_date') });
  // A rate older than a week is not used automatically.
  await expectError(run(db, owner, `select erp_create_invoice_v5(null, null, 'A', current_date + 10, current_date + 10, 1, 0, 'EUR', null)`), /more than 7 days/);
  // The base currency written as a code is stored as base (no rate).
  const [{ id: local }] = await run(db, owner, `select erp_create_invoice_v5(null, null, 'A', current_date, current_date, 5, 0, 'IDR', null) as id`);
  assert.deepEqual((await admin(db, `select currency, fx_rate::float as r, fx_rate_source from erp_invoices where id = $1`, [local]))[0], { currency: null, r: 1, fx_rate_source: null });
  await expectError(run(db, owner, `select erp_create_invoice_v5(null, null, 'A', current_date, current_date, 5, 0, 'ABC', 2)`), /Unknown currency ABC/);
});

test('foreign purchase order: stock and payable at receipt rates, payment differences to 4200, fully cleared', async () => {
  const owner = await createUser(db, 'po-fx');
  await run(db, owner, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  const [{ id: product }] = await run(db, owner,
    `insert into erp_products (user_id, name, current_stock, purchase_price, selling_price) values ($1, 'Bearing', 0, 0, 0) returning id`, [owner.id]);
  await addRate(owner, 'EUR', 'IDR', 17000, 'current_date');
  const [{ id: po }] = await run(db, owner, `select erp_create_purchase_order_v3(null, null, 'Hamburg GmbH', current_date, '', $1::jsonb, 'EUR', null) as id`,
    [items([product, 10, 20])]);
  const [order] = await admin(db, `select currency, total::float as total, fx_rate::float as rate, fx_rate_source, base_total::float as base from erp_purchase_orders where id = $1`, [po]);
  assert.deepEqual(order, { currency: 'EUR', total: 200, rate: 17000, fx_rate_source: 'rate_table', base: 3400000 });
  await run(db, owner, `select erp_update_purchase_order_status($1, 'approved')`, [po]);
  const [line] = await admin(db, `select id from erp_purchase_order_items where purchase_order_id = $1`, [po]);

  // Two partial receipts at different rates (entered): 6 @ 17,000 and 4 @ 17,500.
  const receive = (qty, rate) => run(db, owner, `select erp_record_purchase_receipt_v2($1, $2::jsonb, $3, '', $4) as id`,
    [po, JSON.stringify([{ item_id: line.id, qty }]), randomUUID(), rate]);
  const [{ id: r1 }] = await receive(6, 17000);
  const [{ id: r2 }] = await receive(4, 17500);
  const costs = await admin(db, `select l.unit_cost::float as c from erp_fulfillment_event_lines l where l.event_id = any($1::uuid[]) order by l.unit_cost`, [[r1, r2]]);
  assert.deepEqual(costs.map((c) => c.c), [340000, 350000], 'unit cost = EUR price × receipt rate');
  assert.equal((await admin(db, `select avg_cost::float as a from erp_products where id = $1`, [product]))[0].a, 344000, 'moving average in IDR');
  // Payable booked: 6×20×17000 + 4×20×17500 = 2,040,000 + 1,400,000.
  assert.deepEqual(await balances(owner), { inventory: 3440000, ap: 3440000 });

  // Pay 200 EUR at 17,300: payable released at the carrying rate (17,200), loss 20,000.
  const [{ id: pay }] = await run(db, owner,
    `insert into erp_payments (user_id, payment_type, party, amount, purchase_order_id, fx_rate, fx_rate_source) values ($1, 'outgoing', 'Hamburg GmbH', 200, $2, 17300, 'manual') returning id`,
    [owner.id, po]);
  const [p] = await admin(db, `select currency, fx_rate::float as rate, base_amount::float as base from erp_payments where id = $1`, [pay]);
  assert.deepEqual(p, { currency: 'EUR', rate: 17300, base: 3460000 });
  assert.deepEqual(await balances(owner), { inventory: 3440000, cash: -3460000, fx: -20000 });
  assert.equal(await documentBalance(owner, 'ap', [r1, r2, pay, po]), 0, 'payable fully cleared');
  // The cash book shows the rupiah amount paid.
  assert.equal((await admin(db, `select amount::float as a from erp_transactions where source_payment_id = $1`, [pay]))[0].a, 3460000);
  await assertBalanced(owner);

  // Voiding the payment reopens the payable at its booked value; nothing is left in exchange differences.
  await run(db, owner, `select erp_void_payment($1, 'Wrong account')`, [pay]);
  assert.deepEqual(await balances(owner), { inventory: 3440000, ap: 3440000 });
  await assertBalanced(owner);
});

test('prepaid foreign purchase order: settled once goods and payment are both in', async () => {
  const owner = await createUser(db, 'po-prepay');
  await run(db, owner, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  await addRate(owner, 'USD', 'IDR', 16000, 'current_date');
  const [{ id: po }] = await run(db, owner, `select erp_create_purchase_order_v3(null, null, 'Supplier', current_date, '', $1::jsonb, 'USD', null) as id`,
    ['[{"product_name":"Consulting","qty":1,"price":100}]']);
  await run(db, owner, `select erp_update_purchase_order_status($1, 'approved')`, [po]);
  // Paid first at 16,000 (no rate given: today's stored rate).
  const [{ id: pay }] = await run(db, owner,
    `insert into erp_payments (user_id, payment_type, party, amount, purchase_order_id) values ($1, 'outgoing', 'Supplier', 100, $2) returning id`, [owner.id, po]);
  assert.deepEqual((await admin(db, `select fx_rate::float as r, fx_rate_source from erp_payments where id = $1`, [pay]))[0], { r: 16000, fx_rate_source: 'rate_table' });
  // Received later at 16,400: the expense is booked at 16,400 and the payable difference is cleared.
  const [line] = await admin(db, `select id from erp_purchase_order_items where purchase_order_id = $1`, [po]);
  const [{ id: rc }] = await run(db, owner, `select erp_record_purchase_receipt_v2($1, $2::jsonb, $3, '', 16400) as id`, [po, JSON.stringify([{ item_id: line.id, qty: 1 }]), randomUUID()]);
  assert.deepEqual(await balances(owner), { expenses: 1640000, cash: -1600000, fx: 40000 });
  assert.equal(await documentBalance(owner, 'ap', [pay, rc, po]), 0);
  await assertBalanced(owner);
});

test('foreign sales order: invoice at the invoice-date rate, receivable settled with differences cleared', async () => {
  const owner = await createUser(db, 'so-fx');
  await run(db, owner, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  await addRate(owner, 'SGD', 'IDR', 12000, 'current_date - 1');
  const [{ id: so }] = await run(db, owner, `select erp_create_sales_order_v3(null, null, 'Lion Pte', current_date, '', $1::jsonb, 'SGD', null) as id`,
    ['[{"product_name":"Service","qty":3,"price":33.33}]']);
  const [{ id: inv }] = await run(db, owner, `select erp_issue_invoice_from_sales_order_v2($1, null, null) as id`, [so]);
  const [row] = await admin(db, `select currency, total::float as t, fx_rate::float as r, fx_rate_source, base_total::float as b from erp_invoices where id = $1`, [inv]);
  assert.deepEqual(row, { currency: 'SGD', t: 99.99, r: 12000, fx_rate_source: 'rate_table', b: 1199880 });

  // Three payments at a rate with a fraction: each releases the receivable at 12,000 (rounded).
  await addRate(owner, 'SGD', 'IDR', 12001.337, 'current_date');
  const ids = [];
  for (const amount of [33.33, 33.33, 33.33]) {
    const [{ id }] = await run(db, owner,
      `insert into erp_payments (user_id, payment_type, party, amount, invoice_id) values ($1, 'incoming', 'Lion Pte', $2, $3) returning id`, [owner.id, amount, inv]);
    ids.push(id);
  }
  assert.equal((await admin(db, `select payment_state from erp_invoices where id = $1`, [inv]))[0].payment_state, 'paid');
  assert.equal(await documentBalance(owner, 'ar', [inv, ...ids]), 0, 'receivable exactly zero, rounding included');
  const bal = await balances(owner);
  assert.equal(bal.ar, undefined);
  assert.equal(bal.revenue, 1199880);
  // cash = Σ round(33.33 × 12001.337, 2) = 3 × 400004.56
  assert.equal(bal.cash, 1200013.68);
  assert.equal(Math.round(bal.fx * 100) / 100, 133.68);
  await assertBalanced(owner);
});

test('a payment must use its document currency; old clients get the right rate', async () => {
  const owner = await createUser(db, 'pay-rules');
  await run(db, owner, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  await addRate(owner, 'USD', 'IDR', 16000, 'current_date - 20');
  const [{ id: po }] = await run(db, owner, `select erp_create_purchase_order_v3(null, null, 'S', current_date, '', $1::jsonb, 'USD', 15900) as id`,
    ['[{"product_name":"X","qty":1,"price":10}]']);
  await run(db, owner, `select erp_update_purchase_order_status($1, 'approved')`, [po]);
  await expectError(run(db, owner,
    `insert into erp_payments (user_id, payment_type, party, amount, purchase_order_id, currency) values ($1, 'outgoing', 'S', 1, $2, 'EUR')`, [owner.id, po]),
    /must be in the purchase order currency \(USD\)/);
  // No rate given and the stored one is too old: the order's own rate, labelled as such.
  const [{ id }] = await run(db, owner,
    `insert into erp_payments (user_id, payment_type, party, amount, purchase_order_id) values ($1, 'outgoing', 'S', 1, $2) returning id`, [owner.id, po]);
  assert.deepEqual((await admin(db, `select currency, fx_rate::float as r, fx_rate_source from erp_payments where id = $1`, [id]))[0],
    { currency: 'USD', r: 15900, fx_rate_source: 'document' });
  // Asking for the table rate when it is stale is an error, not a silent fallback.
  await expectError(run(db, owner,
    `insert into erp_payments (user_id, payment_type, party, amount, purchase_order_id, fx_rate_source) values ($1, 'outgoing', 'S', 1, $2, 'rate_table')`, [owner.id, po]),
    /more than 7 days/);
});

test('rates and currency settings stay inside their workspace', async () => {
  const a = await createUser(db, 'iso-a');
  const b = await createUser(db, 'iso-b');
  const wsA = await workspaceWith(a);
  await run(db, a, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  await addRate(a, 'EUR', 'IDR', 17000);
  // B's books do not see A's rate, and B cannot use A's workspace.
  await run(db, b, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  await expectError(run(db, b, `select erp_create_invoice_v5(null, null, 'X', current_date, current_date, 1, 0, 'EUR', null)`), /No exchange rate/);
  await expectError(run(db, b, `select * from erp_exchange_rate_lookup($1, 'EUR', 'IDR', current_date)`, [wsA]), /not allowed/);
  await expectError(run(db, b, `select erp_currency_preview($1)`, [wsA]), /not allowed/);
  await expectError(run(db, b, `select erp_add_exchange_rate($1, 'EUR', 'IDR', 1, current_date, '')`, [wsA]), /not allowed/);
  assert.equal((await run(db, b, `select * from erp_exchange_rates`)).length, 0);
});

test('upgrade: existing foreign invoices, payments and ledger keep every amount', async () => {
  const PREVIOUS = '20261005000000';
  const old = await createDb({ through: PREVIOUS });
  const user = await createUser(old, 'upgrade-fx');
  await run(old, user, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  // The schema before exchange-rate history: v4 was the current version then.
  const [{ id: inv }] = await run(old, user, `select erp_create_invoice_v4(null, null, 'Acme', current_date, current_date + 30, 123.45, 11, 'USD', 16123.45678912) as id`);
  await run(old, user, `insert into erp_payments (user_id, payment_type, party, amount, invoice_id, fx_rate) values ($1, 'incoming', 'Acme', 50, $2, 16200.5)`, [user.id, inv]);
  const snapshot = async (d) => ({
    invoices: await admin(d, `select id, total::text, fx_rate::numeric::text as rate, base_total::text from erp_invoices order by id`),
    payments: await admin(d, `select id, amount::text, fx_rate::numeric::text as rate, base_amount::text from erp_payments order by id`),
    ledger: await admin(d, `select l.debit::text, l.credit::text from erp_journal_lines l order by l.id`),
  });
  const before = await snapshot(old);
  await applyMigrations(old, { after: PREVIOUS });
  const after = await snapshot(old);
  // Rates now show 12 decimals; the values are the same numbers.
  const norm = (s) => ({ ...s, invoices: s.invoices.map((r) => ({ ...r, rate: Number(r.rate) })), payments: s.payments.map((r) => ({ ...r, rate: Number(r.rate) })) });
  assert.deepEqual(norm(after), norm(before));
  // Existing documents have no recorded rate source (shown as "entered before rates were tracked").
  assert.deepEqual((await admin(old, `select fx_rate_source from erp_invoices`)).map((r) => r.fx_rate_source), [null]);
});

test('service: a missing rate is fetched from the provider, stored with its source, then reused', async () => {
  const owner = await createUser(db, 'svc-owner');
  const viewer = await createUser(db, 'svc-sales');
  const outsider = await createUser(db, 'svc-outsider');
  const ws = await workspaceWith(owner, viewer, 'sales');
  await run(db, owner, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  const ctx = (user) => ({
    executor: { transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })) },
    identity: { userId: user.id, email: user.email, aal: 'aal2' },
    workspacesEnabled: true,
  });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify([{ date: await dateText('current_date - 1'), base: 'EUR', quote: 'IDR', rate: 17345.67 }]), { status: 200 });
  };
  try {
    const settings = await currencySettings(ctx(owner), ws);
    assert.equal(settings.baseCurrency, 'IDR');
    assert.equal(settings.canManageRates, true);
    assert.ok(settings.currencies.some((c) => c.code === 'JPY' && c.minorUnits === 0));

    const date = await dateText('current_date');
    const first = await lookupRate(ctx(owner), ws, { from: 'EUR', to: 'IDR', date, fetch: true });
    assert.deepEqual({ rate: first.rate, source: first.source, provider: first.provider, fetched: first.fetched },
      { rate: '17345.670000000000', source: 'frankfurter', provider: 'Frankfurter (blend)', fetched: true });
    assert.equal(first.rateDate, await dateText('current_date - 1'));
    const second = await lookupRate(ctx(owner), ws, { from: 'EUR', to: 'IDR', date, fetch: true });
    assert.equal(second.fetched, false);
    assert.equal(calls.length, 1, 'fetched once');

    const viewed = await lookupRate(ctx(viewer), ws, { from: 'EUR', to: 'IDR', date });
    assert.equal(viewed.rate, '17345.670000000000');
    await assert.rejects(serviceAddRate(ctx(viewer), ws, { from: 'USD', to: 'IDR', rate: '16000', date }), (e) => e.code === 'forbidden');
    await assert.rejects(lookupRate(ctx(outsider), ws, { from: 'EUR', to: 'IDR', date }), (e) => e.code === 'forbidden');
    await assert.rejects(fetchAndStore(ctx(outsider), ws, { base: 'EUR', quotes: ['IDR'], date }), (e) => e.code === 'forbidden');

    // Provider down: nothing stored, the reason is returned.
    globalThis.fetch = async () => { throw new Error('offline'); };
    const down = await lookupRate(ctx(owner), ws, { from: 'USD', to: 'IDR', date, fetch: true });
    assert.deepEqual([down.rate, down.fetchError], [null, 'unavailable']);
    await assert.rejects(lookupRate(ctx(owner), ws, { from: 'USD', to: 'IDR', date: '2999-01-01' }), (e) => e.code === 'invalid');

    // Business rules come back as readable messages.
    const preview = await currencyPreview(ctx(owner), ws);
    await assert.rejects(confirmBaseCurrency(ctx(owner), ws, 'IDR', preview.baseRows + 5), (e) => e.code === 'fx_preview_changed' && /review the preview again/.test(e.userMessage));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('rollback: refused while foreign orders exist; otherwise restores the previous functions and keeps amounts', async () => {
  const rollback = readFileSync(new URL('../../db/rollback/rollback_20261006000000_erp_currency_rates.sql', import.meta.url), 'utf8');
  const d = await createDb();
  const user = await createUser(d, 'rollback-fx');
  await run(d, user, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  await run(d, user, `select erp_add_exchange_rate(null, 'USD', 'IDR', 16000, current_date, '')`);
  const [{ id: inv }] = await run(d, user, `select erp_create_invoice_v5(null, null, 'Acme', current_date, current_date + 30, 100, 0, 'USD', null) as id`);
  await run(d, user, `insert into erp_payments (user_id, payment_type, party, amount, invoice_id, fx_rate_source) values ($1, 'incoming', 'Acme', 40, $2, 'rate_table')`, [user.id, inv]);
  const [{ id: po }] = await run(d, user, `select erp_create_purchase_order_v3(null, null, 'Vendor', current_date, '', $1::jsonb, 'USD', null) as id`,
    ['[{"product_name":"Consulting","qty":1,"price":100}]']);

  await assert.rejects(d.exec(rollback), /foreign-currency purchase or sales orders exist/);
  await d.exec('ROLLBACK');
  await admin(d, `delete from erp_purchase_orders where id = $1`, [po]);

  const snapshot = async () => ({
    invoices: await admin(d, `select id, currency, total::text, fx_rate::text, base_total::text from erp_invoices order by id`),
    payments: await admin(d, `select id, currency, amount::text, fx_rate::text, base_amount::text from erp_payments order by id`),
    ledger: await admin(d, `select l.debit::text, l.credit::text from erp_journal_lines l order by l.id`),
  });
  const before = await snapshot();
  // Rollbacks run newest first: the old function versions are callable again before this one.
  await d.exec(readFileSync(new URL('../../db/rollback/rollback_20261012000019_erp_retire_old_function_versions.sql', import.meta.url), 'utf8'));
  await d.exec(rollback);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await admin(d, `select to_regclass('public.erp_exchange_rates') as t`))[0].t, null);

  // The previous functions work again: a foreign invoice with an entered rate, and its payment.
  const [{ id: again }] = await run(d, user, `select erp_create_invoice_v4(null, null, 'Acme', current_date, current_date, 10, 0, 'USD', 16100) as id`);
  await run(d, user, `insert into erp_payments (user_id, payment_type, party, amount, invoice_id) values ($1, 'incoming', 'Acme', 10, $2)`, [user.id, again]);
  assert.equal((await admin(d, `select status from erp_invoices where id = $1`, [again]))[0].status, 'paid');
  const [t] = await admin(d, `select sum(l.debit)::text as dr, sum(l.credit)::text as cr from erp_journal_lines l`);
  assert.equal(t.dr, t.cr);
});
