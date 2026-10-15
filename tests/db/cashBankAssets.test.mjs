import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, run, admin, expectError } from './harness.mjs';

let db;
let owner;
let finance;
let sales;
let ws;
let ownerId;
let bca;
let petty;

/** The ledger lines of one entry, by system key (or account code): { key: debit - credit }. */
async function entry(sourceKey) {
  const rows = await admin(
    db,
    `select coalesce(a.system_key, a.code) as k, sum(l.debit - l.credit)::numeric as net
       from erp_journal_entries e join erp_journal_lines l on l.entry_id = e.id join erp_gl_accounts a on a.id = l.account_id
      where e.source_key = $1 group by 1`,
    [sourceKey]
  );
  return Object.fromEntries(rows.map((r) => [r.k, Number(r.net)]));
}

const accounts = async (user = finance) =>
  run(db, user, `select * from erp_cash_account_list($1)`, [ws]);
const balanceOf = async (id) => Number((await accounts()).find((a) => a.id === id).balance);
const code = async (id) =>
  (
    await admin(
      db,
      `select a.code from erp_cash_accounts c join erp_gl_accounts a on a.id = c.gl_account_id where c.id = $1`,
      [id]
    )
  )[0].code;
const pay = async (user, fields) => {
  const cols = ['user_id', 'workspace_id', ...Object.keys(fields)];
  const values = [ownerId, ws, ...Object.values(fields)];
  const [{ id }] = await run(
    db,
    user,
    `insert into erp_payments (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    values
  );
  return id;
};
const monthsAgo = async (n) =>
  (
    await admin(
      db,
      `select to_char(date_trunc('month', current_date) - make_interval(months => $1), 'YYYY-MM-DD') as d`,
      [n]
    )
  )[0].d;
const daysAgo = async (n) =>
  (await admin(db, `select to_char(current_date - $1::int, 'YYYY-MM-DD') as d`, [n]))[0].d;
const unbalanced = async () =>
  (
    await admin(
      db,
      `select count(*)::int as n from (select e.id from erp_journal_entries e join erp_journal_lines l on l.entry_id = e.id
         group by e.id having sum(l.debit) <> sum(l.credit)) x`
    )
  )[0].n;

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'fin-owner');
  [{ id: ws }] = await run(db, owner, `select erp_create_erp_v2('PT Batu Jaya', 'quarry') as id`);
  const join = async (role) => {
    const user = await createUser(db, `fin-${role}`);
    const [{ access_code }] = await run(
      db,
      owner,
      `select access_code from erp_create_workspace_invitation($1, $2, 24, '')`,
      [ws, role]
    );
    await run(db, user, `select erp_redeem_workspace_invitation($1)`, [access_code]);
    return user;
  };
  finance = await join('finance');
  sales = await join('sales');
  [{ owner_id: ownerId }] = await admin(db, `select owner_id from erp_workspaces where id = $1`, [
    ws,
  ]);
});

test('the ledger cash account is the first one; finance adds bank accounts with their own ledger account', async () => {
  const [first] = await accounts();
  assert.equal(first.is_default, true);
  assert.equal(first.gl_code, '1000');
  petty = first.id;

  [{ id: bca }] = await run(db, finance, `select erp_cash_account_create($1, $2::jsonb) as id`, [
    ws,
    JSON.stringify({
      name: 'BCA Operasional',
      kind: 'bank',
      bank_name: 'BCA',
      account_no: '1234567890',
    }),
  ]);
  assert.equal(await code(bca), '1001');
  await expectError(
    run(db, finance, `select erp_cash_account_create($1, $2::jsonb)`, [
      ws,
      JSON.stringify({ name: 'bca operasional', kind: 'bank' }),
    ]),
    /exists/
  );
  await expectError(
    run(db, sales, `select erp_cash_account_create($1, $2::jsonb)`, [
      ws,
      JSON.stringify({ name: 'Kas kecil', kind: 'cash' }),
    ]),
    /does not allow/
  );
  // Sales cannot see balances either.
  await expectError(accounts(sales), /does not allow/);
  assert.equal((await run(db, sales, `select count(*)::int as n from erp_cash_accounts`))[0].n, 0);
  assert.equal((await accounts()).length, 2);
});

test('payments and cash-book rows post to the account they name, and keep it', async () => {
  const incoming = await pay(finance, {
    payment_type: 'incoming',
    party: 'PT Pembeli',
    amount: 5_000_000,
    cash_account_id: bca,
  });
  assert.deepEqual(await entry(`payment:${incoming}`), {
    1001: 5_000_000,
    other_income: -5_000_000,
  });
  const plain = await pay(finance, { payment_type: 'outgoing', party: 'Warung', amount: 50_000 });
  assert.deepEqual(await entry(`payment:${plain}`), { cash: -50_000, expenses: 50_000 });

  // The cash book is written under its owner's own id (as admin here); the trigger posts it.
  const [{ id: tx }] = await admin(
    db,
    `insert into erp_transactions (user_id, workspace_id, transaction_type, category, amount, description, cash_account_id)
     values ($1, $2, 'expense', 'Bank', 6500, 'Biaya admin', $3) returning id`,
    [ownerId, ws, bca]
  );
  assert.deepEqual(await entry(`transaction:${tx}`), { 1001: -6500, expenses: 6500 });

  // Even where a row may be updated (here as admin), the account stays.
  await expectError(
    admin(db, `update erp_payments set cash_account_id = $1 where id = $2`, [petty, incoming]),
    /cannot be changed/
  );

  // Voiding reverses on the same account.
  await run(db, finance, `select erp_void_payment($1, 'entered twice')`, [incoming]);
  assert.deepEqual(await entry(`payment_void:${incoming}`), {
    1001: -5_000_000,
    other_income: 5_000_000,
  });
  assert.equal(await balanceOf(bca), -6500);

  // Another business's account is refused.
  const stranger = await createUser(db, 'fin-stranger');
  const [{ id: otherWs }] = await run(
    db,
    stranger,
    `select erp_create_erp_v2('CV Lain', 'quarry') as id`
  );
  const [{ id: foreign }] = await run(
    db,
    stranger,
    `select erp_cash_account_create($1, '{"name":"Mandiri","kind":"bank"}'::jsonb) as id`,
    [otherWs]
  );
  await expectError(
    pay(finance, { payment_type: 'incoming', party: 'X', amount: 1, cash_account_id: foreign }),
    /active cash or bank account/
  );
});

test('transfers move money between accounts and can be voided once', async () => {
  await pay(finance, {
    payment_type: 'incoming',
    party: 'PT Pembeli',
    amount: 10_000_000,
    cash_account_id: bca,
  });
  const before = { bca: await balanceOf(bca), petty: await balanceOf(petty) };
  const [{ id: e }] = await run(
    db,
    finance,
    `select erp_cash_transfer($1, $2, $3, 2000000, current_date, 'Isi kas kecil') as id`,
    [ws, bca, petty]
  );
  assert.equal(await balanceOf(bca), before.bca - 2_000_000);
  assert.equal(await balanceOf(petty), before.petty + 2_000_000);
  await expectError(
    run(db, finance, `select erp_cash_transfer($1, $2, $2, 1, current_date)`, [ws, bca]),
    /two different/
  );
  await expectError(
    run(db, sales, `select erp_cash_transfer($1, $2, $3, 1, current_date)`, [ws, bca, petty]),
    /does not allow/
  );

  const [listed] = await run(
    db,
    finance,
    `select * from erp_cash_transfer_list($1, current_date - 1, current_date)`,
    [ws]
  );
  assert.equal(listed.from_account, 'BCA Operasional');
  assert.equal(Number(listed.amount), 2_000_000);
  assert.equal(listed.voided, false);

  await run(db, finance, `select erp_cash_transfer_void($1, $2)`, [ws, e]);
  assert.equal(await balanceOf(bca), before.bca);
  await expectError(
    run(db, finance, `select erp_cash_transfer_void($1, $2)`, [ws, e]),
    /already void/
  );
});

test('a supplier bill is paid from the chosen account', async () => {
  const [{ id: billId }] = await run(
    db,
    owner,
    `select erp_supplier_bill_create($1, $2::jsonb) as id`,
    [
      ws,
      JSON.stringify({
        supplier_name: 'CV Sewa Alat',
        bill_date: await daysAgo(1),
        description: 'Sewa excavator',
        subtotal: 1_000_000,
      }),
    ]
  );
  const [{ id: p }] = await run(
    db,
    finance,
    `select erp_supplier_bill_pay($1, 1000000, current_date, 'transfer', $2) as id`,
    [billId, bca]
  );
  assert.deepEqual(await entry(`payment:${p}`), { 1001: -1_000_000, ap: 1_000_000 });
});

test('bank statements import once, match the ledger, post bank charges, and reconcile', async () => {
  // A fresh account, so the statement is the whole story.
  const [{ id: bri }] = await run(
    db,
    finance,
    `select erp_cash_account_create($1, '{"name":"BRI Giro","kind":"bank","bank_name":"BRI"}'::jsonb) as id`,
    [ws]
  );
  const d5 = await daysAgo(5);
  const d4 = await daysAgo(4);
  const d2 = await daysAgo(2);
  const received = await pay(finance, {
    payment_type: 'incoming',
    party: 'PT Pembeli',
    amount: 7_500_000,
    cash_account_id: bri,
    payment_date: d4,
  });
  const paid = await pay(finance, {
    payment_type: 'outgoing',
    party: 'PT Solar',
    amount: 2_000_000,
    cash_account_id: bri,
    payment_date: d2,
  });

  const statement = {
    file_name: 'mutasi-bri.csv',
    format: 'bri',
    opening_balance: 0,
    lines: [
      { date: d4, description: 'TRF DARI PT PEMBELI', amount: 7_500_000, balance: 7_500_000 },
      { date: d2, description: 'TRF KE PT SOLAR', amount: -2_000_000, balance: 5_500_000 },
      { date: d2, description: 'BIAYA ADM', amount: -15_000, balance: 5_485_000 },
      { date: d2, description: 'BIAYA ADM', amount: -15_000, balance: 5_470_000 },
      { date: d5, description: 'BUNGA', amount: 0 },
    ],
  };
  const imp = (s) =>
    run(db, finance, `select erp_bank_statement_import($1, $2, $3::jsonb) as r`, [
      ws,
      bri,
      JSON.stringify(s),
    ]).then((r) => r[0].r);
  const first = await imp(statement);
  assert.equal(first.imported, 4);
  assert.equal(first.duplicates, 0);
  // The same file again: nothing new, no empty statement left behind.
  const again = await imp(statement);
  assert.equal(again.imported, 0);
  assert.equal(again.statement_id, null);
  assert.equal(
    (
      await admin(
        db,
        `select count(*)::int as n from erp_bank_statements where cash_account_id = $1`,
        [bri]
      )
    )[0].n,
    1
  );
  await expectError(
    imp({ lines: [{ date: '2999-01-01', description: 'x', amount: 1 }] }),
    /future/
  );
  await expectError(
    imp({ lines: [{ date: 'kemarin', description: 'x', amount: 1 }] }),
    /invalid date or amount/
  );
  await expectError(
    run(db, sales, `select erp_bank_statement_import($1, $2, $3::jsonb)`, [
      ws,
      bri,
      JSON.stringify(statement),
    ]),
    /does not allow/
  );

  const matched = (await run(db, finance, `select erp_bank_auto_match($1, $2) as n`, [ws, bri]))[0]
    .n;
  assert.equal(matched, 2);
  const lines = await run(
    db,
    finance,
    `select * from erp_bank_statement_lines where cash_account_id = $1 order by line_no`,
    [bri]
  );
  assert.deepEqual(
    lines.map((l) => l.status),
    ['matched', 'matched', 'open', 'open']
  );
  const matchedTo = await admin(
    db,
    `select e.source_key from erp_journal_lines l join erp_journal_entries e on e.id = l.entry_id where l.id = $1`,
    [lines[0].journal_line_id]
  );
  assert.equal(matchedTo[0].source_key, `payment:${received}`);
  assert.ok(paid);

  let rec = (
    await run(db, finance, `select erp_bank_reconciliation($1, $2, current_date) as r`, [ws, bri])
  )[0].r;
  assert.equal(Number(rec.ledger_balance), 5_500_000);
  assert.equal(Number(rec.bank_balance), 5_470_000);
  assert.equal(rec.open_lines, 2);
  assert.equal(Number(rec.difference), 0);

  // Bank charges: posted against an expense account and matched at once.
  const [{ id: charges }] = await admin(db, `select erp_fin__account($1, 'bank_charges') as id`, [
    ownerId,
  ]);
  const [{ id: fee }] = await run(db, finance, `select erp_bank_line_post($1, $2, '') as id`, [
    lines[2].id,
    charges,
  ]);
  assert.ok(fee);
  assert.deepEqual(await entry(`bank_line:${lines[2].id}`), {
    [await code(bri)]: -15_000,
    bank_charges: 15_000,
  });
  // The second, identical charge was a bank error the bank reversed later: ignored, with a reason.
  await expectError(run(db, finance, `select erp_bank_line_ignore($1, '')`, [lines[3].id]), /why/);
  await run(db, finance, `select erp_bank_line_ignore($1, 'Dikoreksi bank')`, [lines[3].id]);

  rec = (
    await run(db, finance, `select erp_bank_reconciliation($1, $2, current_date) as r`, [ws, bri])
  )[0].r;
  assert.equal(rec.open_lines, 0);
  assert.equal(rec.unmatched_ledger, 0);
  assert.equal(Number(rec.ledger_balance), 5_485_000);

  // Matching by hand: only a candidate (same amount, unmatched).
  await run(db, finance, `select erp_bank_line_unmatch($1)`, [lines[1].id]);
  const candidates = await run(db, finance, `select * from erp_bank_line_candidates($1)`, [
    lines[1].id,
  ]);
  assert.equal(candidates.length, 1);
  await expectError(
    run(db, finance, `select erp_bank_line_match($1, $2)`, [lines[1].id, lines[0].journal_line_id]),
    /same amount/
  );
  await run(db, finance, `select erp_bank_line_match($1, $2)`, [
    lines[1].id,
    candidates[0].journal_line_id,
  ]);

  // A statement with matched lines stays.
  await expectError(
    run(db, finance, `select erp_bank_statement_delete($1)`, [first.statement_id]),
    /Unmatch/
  );
  assert.equal(await unbalanced(), 0);
});

test('fixed assets: bought, depreciated monthly once, scheduled, and sold with a gain or a loss', async () => {
  const start = await monthsAgo(3);
  const create = (body, user = finance) =>
    run(db, user, `select erp_fixed_asset_create($1, $2::jsonb) as id`, [
      ws,
      JSON.stringify(body),
    ]).then((r) => r[0].id);

  const truck = await create({
    name: 'Dump truck Hino',
    category: 'vehicle',
    acquisition_date: start,
    cost: 12_000_000,
    salvage_value: 0,
    useful_life_months: 12,
    method: 'straight_line',
    funding: 'cash',
    cash_account_id: bca,
  });
  assert.deepEqual(await entry(`asset:${truck}`), { 1001: -12_000_000, fixed_assets: 12_000_000 });
  await expectError(
    create(
      { name: 'X', acquisition_date: start, cost: 1, useful_life_months: 12, funding: 'cash' },
      sales
    ),
    /does not allow/
  );
  await expectError(
    create({
      name: 'X',
      acquisition_date: start,
      cost: 100,
      salvage_value: 100,
      useful_life_months: 12,
      funding: 'payable',
    }),
    /salvage/
  );
  await expectError(
    create({
      name: 'X',
      acquisition_date: start,
      cost: 100,
      useful_life_months: 12,
      funding: 'payable',
      prior_accumulated: 10,
    }),
    /owned before/
  );

  // Through last month: the acquisition month and the two after it.
  const through = await monthsAgo(1);
  const run1 = (
    await run(db, finance, `select erp_fixed_assets_depreciate($1, $2) as r`, [ws, through])
  )[0].r;
  assert.equal(run1.months, 3);
  assert.equal(Number(run1.amount), 3_000_000);
  const run2 = (
    await run(db, finance, `select erp_fixed_assets_depreciate($1, $2) as r`, [ws, through])
  )[0].r;
  assert.equal(run2.months, 0);
  assert.deepEqual(await entry(`depreciation:${truck}:${start.slice(0, 7)}`), {
    depreciation: 1_000_000,
    accum_depreciation: -1_000_000,
  });
  await expectError(
    run(db, finance, `select erp_fixed_assets_depreciate($1, current_date + 40)`, [ws]),
    /current month/
  );

  const schedule = await run(db, finance, `select * from erp_fixed_asset_schedule($1)`, [truck]);
  assert.equal(schedule.length, 12);
  assert.equal(schedule.filter((s) => s.posted).length, 3);
  assert.equal(Number(schedule.at(-1).book_value), 0);

  // Declining balance at double the straight-line rate (4 years: 50% a year),
  // owned before the books, with depreciation already taken.
  const crusher = await create({
    name: 'Stone crusher',
    category: 'machinery',
    acquisition_date: await monthsAgo(30),
    depreciation_start: start,
    cost: 48_000_000,
    salvage_value: 0,
    useful_life_months: 48,
    method: 'declining_balance',
    funding: 'opening',
    prior_months: 27,
    prior_accumulated: 36_000_000,
  });
  const [c] = await run(
    db,
    finance,
    `select declining_rate, accumulated from erp_fixed_assets where id = $1`,
    [crusher]
  );
  assert.equal(Number(c.declining_rate), 50);
  assert.equal(Number(c.accumulated), 36_000_000);
  assert.deepEqual(await entry(`asset:${crusher}`), {
    fixed_assets: 48_000_000,
    opening: -12_000_000,
    accum_depreciation: -36_000_000,
  });
  await run(db, finance, `select erp_fixed_assets_depreciate($1, $2)`, [ws, start]);
  // (48m − 36m) × 50% / 12
  assert.deepEqual(await entry(`depreciation:${crusher}:${start.slice(0, 7)}`), {
    depreciation: 500_000,
    accum_depreciation: -500_000,
  });

  // Sold this month for more than its book value: the gain; depreciation through the month first.
  const [{ id: sale }] = await run(
    db,
    finance,
    `select erp_fixed_asset_dispose($1, current_date, 10000000, $2, 'Dijual') as id`,
    [truck, bca]
  );
  assert.ok(sale);
  const [t] = await run(
    db,
    finance,
    `select status, accumulated from erp_fixed_assets where id = $1`,
    [truck]
  );
  assert.equal(t.status, 'disposed');
  assert.equal(Number(t.accumulated), 4_000_000);
  assert.deepEqual(await entry(`asset_disposal:${truck}`), {
    1001: 10_000_000,
    accum_depreciation: 4_000_000,
    fixed_assets: -12_000_000,
    disposal_gain: -2_000_000,
  });
  // Scrapped for nothing: the loss.
  await run(db, finance, `select erp_fixed_asset_dispose($1, current_date, 0)`, [crusher]);
  const loss = await entry(`asset_disposal:${crusher}`);
  assert.equal(loss.fixed_assets, -48_000_000);
  assert.ok(loss.disposal_loss > 0);
  assert.equal(loss.accum_depreciation + loss.disposal_loss, 48_000_000);

  // A mistake is voided before any depreciation, and its entry reversed.
  const wrong = await create({
    name: 'Laptop',
    category: 'office',
    acquisition_date: await daysAgo(1),
    cost: 15_000_000,
    useful_life_months: 48,
    method: 'straight_line',
    funding: 'payable',
  });
  await expectError(run(db, finance, `select erp_fixed_asset_void($1, '')`, [wrong]), /reason/);
  await run(db, finance, `select erp_fixed_asset_void($1, 'Salah input')`, [wrong]);
  assert.deepEqual(await entry(`asset_void:${wrong}`), {
    ap: 15_000_000,
    fixed_assets: -15_000_000,
  });

  // Land is not depreciated.
  const land = await create({
    name: 'Tanah tambang',
    category: 'land',
    acquisition_date: start,
    cost: 500_000_000,
    useful_life_months: 600,
    method: 'none',
    funding: 'recorded',
  });
  assert.deepEqual(await entry(`asset:${land}`), {});
  const r = (
    await run(db, finance, `select erp_fixed_assets_depreciate($1, current_date) as r`, [ws])
  )[0].r;
  assert.equal(r.assets, 0);
  assert.equal(await unbalanced(), 0);
});

test('closing an account: never the default one, nor one that holds money', async () => {
  await expectError(
    run(db, finance, `select erp_cash_account_update($1, '{"is_active": false}'::jsonb)`, [petty]),
    /default/
  );
  await expectError(
    run(db, finance, `select erp_cash_account_update($1, '{"is_active": false}'::jsonb)`, [bca]),
    /Move the balance/
  );
  const [{ id: empty }] = await run(
    db,
    finance,
    `select erp_cash_account_create($1, '{"name":"BNI lama","kind":"bank"}'::jsonb) as id`,
    [ws]
  );
  await run(
    db,
    finance,
    `select erp_cash_account_update($1, '{"is_active": false, "name": "BNI (tutup)"}'::jsonb)`,
    [empty]
  );
  const [row] = await admin(
    db,
    `select c.name, a.name as gl_name, a.is_active from erp_cash_accounts c join erp_gl_accounts a on a.id = c.gl_account_id where c.id = $1`,
    [empty]
  );
  assert.deepEqual(row, { name: 'BNI (tutup)', gl_name: 'BNI (tutup)', is_active: false });
  await expectError(
    pay(finance, { payment_type: 'incoming', party: 'X', amount: 1, cash_account_id: empty }),
    /active cash or bank account/
  );
});

test('a workspace reset removes statements and assets; the rollback removes the rest', async () => {
  const d = await createDb();
  const u = await createUser(d, 'fin-reset');
  const [{ id: w }] = await run(d, u, `select erp_create_erp_v2('PT Reset', 'quarry') as id`);
  const [{ id: acc }] = await run(
    d,
    u,
    `select erp_cash_account_create($1, '{"name":"BCA","kind":"bank"}'::jsonb) as id`,
    [w]
  );
  await run(d, u, `select erp_bank_statement_import($1, $2, $3::jsonb)`, [
    w,
    acc,
    JSON.stringify({ lines: [{ date: '2026-01-02', description: 'x', amount: 5 }] }),
  ]);
  await run(d, u, `select erp_fixed_asset_create($1, $2::jsonb)`, [
    w,
    JSON.stringify({
      name: 'Genset',
      acquisition_date: '2026-01-02',
      cost: 1000,
      useful_life_months: 10,
      funding: 'recorded',
    }),
  ]);
  await admin(d, `select erp__reset_modules($1, 'documents')`, [w]);
  const count = async (t) => (await admin(d, `select count(*)::int as n from ${t}`))[0].n;
  assert.equal(await count('erp_bank_statements'), 0);
  assert.equal(await count('erp_fixed_assets'), 0);
  assert.equal(await count('erp_cash_accounts'), 2);

  await d.exec(
    readFileSync(
      new URL('../../db/rollback/rollback_20261012000054_erp_finance.sql', import.meta.url),
      'utf8'
    )
  );
  const [{ t }] = await admin(d, `select to_regclass('public.erp_cash_accounts') as t`);
  assert.equal(t, null);
  const [{ n }] = await admin(
    d,
    `select count(*)::int as n from information_schema.columns where table_name = 'erp_payments' and column_name = 'cash_account_id'`
  );
  assert.equal(n, 0);
  // Payments work as before.
  const [{ owner_id }] = await admin(d, `select owner_id from erp_workspaces where id = $1`, [w]);
  await run(
    d,
    u,
    `insert into erp_payments (user_id, workspace_id, payment_type, party, amount) values ($1, $2, 'incoming', 'X', 10)`,
    [owner_id, w]
  );
});
