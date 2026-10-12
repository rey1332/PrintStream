import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, run, admin } from './harness.mjs';
import { validateSummary } from '../../src/lib/analytics/summary.ts';
import { buildDrillSql, buildSummarySql, shapeDrillRows, shapeSummary, validGroupValues } from '../../src/server/analytics/summary-sql.ts';

let db;
let owner;
let viewer;
let outsider;
let ws;
let outsiderWs;
const ids = {};

const spec = (input) => {
  const v = validateSummary(input);
  assert.ok(v.ok, JSON.stringify(v.errors));
  return v.spec;
};
const summarize = async (user, s, workspace = ws) => {
  const { sql, params } = buildSummarySql(s, { column: 'workspace_id', value: workspace });
  return shapeSummary(s, await run(db, user, sql, params));
};
const drill = async (user, s, group, workspace = ws, offset = 0) => {
  const { sql, params } = buildDrillSql(s, { column: 'workspace_id', value: workspace }, group, offset);
  return shapeDrillRows(s.entity, await run(db, user, sql, params));
};
const invoice = async (user, customerId, name, date, net, currency = 'IDR', rate = 1) =>
  (await run(db, user, `select erp_create_invoice_v5(null, $1, $2, $3::date, $3::date + 30, $4, 0, $5, $6) as id`, [customerId, name, date, net, currency, rate]))[0].id;

async function join(member, role) {
  const [{ access_code }] = await run(db, owner, `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`, [ws, role]);
  const [{ r }] = await run(db, member, `select erp_redeem_workspace_invitation($1) as r`, [access_code]);
  assert.equal(r.ok, true);
}

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'sum-owner');
  viewer = await createUser(db, 'sum-viewer');
  outsider = await createUser(db, 'sum-outsider');
  await run(db, owner, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  await run(db, outsider, `select erp_accounting_settings_set(null, 'IDR', null, 0)`);
  [{ workspace_id: ws }] = await run(db, owner, `select workspace_id from erp_my_workspaces()`);
  [{ workspace_id: outsiderWs }] = await run(db, outsider, `select workspace_id from erp_my_workspaces()`);
  await join(viewer, 'finance');

  const customer = async (user, name, city) =>
    (await run(db, user, `insert into erp_customers (user_id, name, city) values ($1, $2, $3) returning id`, [user.id, name, city]))[0].id;
  ids.ana = await customer(owner, 'Ana', 'Jakarta');
  ids.budi = await customer(owner, 'Budi', 'Bandung');
  ids.inv1 = await invoice(owner, ids.ana, 'Ana', '2026-01-10', 100);
  ids.inv2 = await invoice(owner, ids.ana, 'Ana', '2026-01-20', 50);
  ids.inv3 = await invoice(owner, ids.budi, 'Budi', '2026-02-05', 80);
  ids.inv4 = await invoice(owner, ids.budi, 'Budi', '2026-02-06', 10, 'USD', 16000);
  ids.inv5 = await invoice(owner, ids.ana, 'Ana', '2026-02-07', 200);
  await run(db, owner, `select erp_void_invoice($1, 'Entered twice')`, [ids.inv5]);

  const other = await customer(outsider, 'Ana', 'Jakarta');
  await invoice(outsider, other, 'Ana', '2026-01-15', 999);
});

const byCustomerMonth = {
  entity: 'invoices',
  groupBy: [{ relation: 'customer', field: 'name' }, { field: 'invoice_date', bucket: 'month' }],
  measures: [{ op: 'sum', field: 'base_total' }, { op: 'count' }],
};

test('totals are computed in the database per group, without voided records or other workspaces', async () => {
  const s = spec(byCustomerMonth);
  const out = await summarize(owner, s);
  assert.deepEqual(out.columns.map((c) => c.name), ['customer.name', 'invoice_date_month', 'sum_base_total', 'record_count']);
  assert.deepEqual(out.rows, [
    { 'customer.name': 'Ana', invoice_date_month: '2026-01', sum_base_total: 150, record_count: 2 },
    { 'customer.name': 'Budi', invoice_date_month: '2026-02', sum_base_total: 160000 + 80, record_count: 2 },
  ]);
  assert.equal(out.recordCount, 4);
  assert.equal(out.truncated, false);

  const withVoided = await summarize(owner, spec({ ...byCustomerMonth, includeInactive: true }));
  assert.equal(withVoided.rows.length, 3, 'the voided February invoice appears only when asked for');

  assert.deepEqual((await summarize(viewer, s)).rows, out.rows);
  assert.deepEqual((await summarize(outsider, s)).rows, []);
  assert.equal((await summarize(outsider, s, outsiderWs)).rows[0].sum_base_total, 999);
});

test('document-currency amounts are never added across currencies', async () => {
  const mixed = await summarize(owner, spec({
    entity: 'invoices', groupBy: [{ field: 'invoice_date', bucket: 'month' }], measures: [{ op: 'sum', field: 'total' }],
  }));
  const feb = mixed.rows.find((r) => r.invoice_date_month === '2026-02');
  assert.equal(feb.sum_total, null, 'IDR 80 + USD 10 is not a number anyone should see');
  assert.equal(mixed.rows.find((r) => r.invoice_date_month === '2026-01').sum_total, 150);
  assert.equal(mixed.mixedCurrencyRows, 1);

  const split = await summarize(owner, spec({
    entity: 'invoices', groupBy: [{ field: 'currency' }], measures: [{ op: 'sum', field: 'total' }],
  }));
  assert.deepEqual(split.rows.map((r) => [r.currency, r.sum_total]), [['USD', 10], [null, 230]]);
});

test('drill-down lists exactly the records a row counted', async () => {
  const s = spec(byCustomerMonth);
  const group = { 'customer.name': 'Budi', invoice_date_month: '2026-02' };
  assert.ok(validGroupValues(s, group));
  assert.equal(validGroupValues(s, { 'customer.name': 'Budi' }), false, 'every group column is required');
  assert.equal(validGroupValues(s, { ...group, extra: 1 }), false);

  const rows = await drill(owner, s, group);
  assert.deepEqual(rows.map((r) => r.id).sort(), [ids.inv3, ids.inv4].sort());
  assert.equal(rows.reduce((sum, r) => sum + r.base_total, 0), 160080, 'the records add up to the summary row');
  assert.ok(rows.every((r) => !('user_id' in r) && !('workspace_id' in r)), 'no scope columns');
  assert.equal(typeof rows[0].total, 'number');

  const ana = await drill(owner, s, { 'customer.name': 'Ana', invoice_date_month: '2026-02' });
  assert.deepEqual(ana, [], 'the voided invoice is not behind any row');
  assert.deepEqual(await drill(outsider, s, group), [], 'no records from another workspace');
});

test('ledger lines summarize into balanced account totals', async () => {
  const s = spec({
    entity: 'journalLines',
    groupBy: [{ relation: 'account', field: 'code' }],
    measures: [{ op: 'sum', field: 'debit' }, { op: 'sum', field: 'credit' }],
  });
  const out = await summarize(owner, s);
  assert.ok(out.rows.length >= 2);
  const debit = out.rows.reduce((n, r) => n + (r.sum_debit ?? 0), 0);
  const credit = out.rows.reduce((n, r) => n + (r.sum_credit ?? 0), 0);
  assert.equal(Math.round(debit * 100), Math.round(credit * 100), 'double entry: debits equal credits');
  const tb = await run(db, owner, `select code, debit::float as debit, credit::float as credit from erp_trial_balance(null, null, null)`);
  for (const row of out.rows) {
    const t = tb.find((x) => x.code === row['account.code']);
    assert.ok(t, `account ${row['account.code']} is in the trial balance`);
  }
  assert.deepEqual((await summarize(outsider, s)).rows, [], 'ledger lines follow their entry\'s workspace');
});

test('definitions are validated: no internal columns, no repeated sums, no injection', async () => {
  const errors = (input) => { const v = validateSummary(input); return v.ok ? [] : v.errors.map((e) => e.code); };
  assert.deepEqual(errors({ entity: 'invoices', groupBy: [{ field: 'workspace_id' }], measures: [] }), ['unknownField']);
  assert.deepEqual(errors({ entity: 'invoices', groupBy: [], measures: [{ op: 'sum', relation: 'customer', field: 'balance' }] }), ['repeatedMeasure']);
  assert.deepEqual(errors({ entity: 'invoices', groupBy: [{ field: 'customer_name', bucket: 'month' }], measures: [] }), ['invalidBucket']);
  assert.deepEqual(errors({ entity: 'invoices', groupBy: [{ relation: 'owner', field: 'email' }], measures: [] }), ['unknownRelation']);
  assert.deepEqual(errors({ entity: 'invoices', groupBy: [], measures: [{ op: 'drop table', field: 'total' }] }), ['invalidMeasure']);
  assert.deepEqual(errors({ entity: 'erp_invoices', groupBy: [], measures: [] }), ['unknownEntity']);
  assert.deepEqual(errors({ entity: 'invoices', groupBy: [], measures: [{ op: 'sum', field: 'total' }, { op: 'sum', field: 'total' }] }), ['duplicateColumn']);

  const hostile = spec({
    entity: 'invoices', groupBy: [{ field: 'customer_name' }], measures: [{ op: 'count' }],
    filters: [{ field: 'customer_name', op: 'contains', value: "'); drop table erp_invoices; --" }, { field: 'status', op: 'in', value: ['unpaid', 'paid'] }],
  });
  assert.deepEqual((await summarize(owner, hostile)).rows, []);
  const pct = spec({ entity: 'invoices', groupBy: [], measures: [{ op: 'count' }], filters: [{ field: 'customer_name', op: 'contains', value: '%' }] });
  assert.equal((await summarize(owner, pct)).rows[0].record_count, 0, '% matches only a literal percent sign');
  assert.equal((await admin(db, `select count(*)::int as n from erp_invoices`))[0].n, 6);
});
