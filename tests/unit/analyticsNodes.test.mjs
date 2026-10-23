import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME } from '../../src/lib/workflow/runtime.ts';
import { analyzeGraph } from '../../src/lib/workflow/schema.ts';
import { periodLabel, periodStart, rfmSegment, shiftPeriod } from '../../src/lib/workflow/analyticsNodes.ts';

// Business analysis nodes (src/lib/workflow/analyticsNodes.ts) and per-group outliers.

const tableOf = (rows, columns = Object.keys(rows[0] ?? {})) => ({ columns, rows, meta: {} });
const run = (type, config, rows) => RUNTIME[type].run(config, [tableOf(rows)], {});
const pick = (rows, ...cols) => rows.map((r) => cols.map((c) => r[c]));

test('periods: weeks start on Monday, labels sort in time order', () => {
  const d = new Date('2026-10-23T00:00:00Z'); // a Friday
  assert.equal(periodLabel(periodStart(d, 'week'), 'week'), '2026-10-19');
  assert.equal(periodLabel(periodStart(d, 'month'), 'month'), '2026-10');
  assert.equal(periodLabel(periodStart(d, 'quarter'), 'quarter'), '2026-Q4');
  assert.equal(periodLabel(shiftPeriod(periodStart(d, 'month'), 'month', 3), 'month'), '2027-01');
  assert.equal(periodLabel(shiftPeriod(periodStart(d, 'quarter'), 'quarter', -4), 'quarter'), '2025-Q4');
});

test('Pareto: summed per item, largest first, the item crossing 80% is still A', async () => {
  const rows = [
    { product: 'Split', amount: 500 },
    { product: 'Abu', amount: 200 },
    { product: 'Split', amount: 100 },
    { product: 'Sirtu', amount: 150 },
    { product: 'Pasir', amount: 50 },
  ];
  const out = await run('an.pareto', { itemColumn: 'product', valueColumn: 'amount', aThreshold: 80, bThreshold: 95 }, rows);
  assert.deepEqual(out.columns, ['product', 'amount', 'rank', 'share_pct', 'cumulative_pct', 'abc_class']);
  assert.deepEqual(pick(out.rows, 'product', 'amount', 'cumulative_pct', 'abc_class'), [
    ['Split', 600, 60, 'A'],
    ['Abu', 200, 80, 'A'],
    ['Sirtu', 150, 95, 'B'],
    ['Pasir', 50, 100, 'C'],
  ]);
});

test('RFM: recency from the newest order, scores 1–5 and a segment', async () => {
  const rows = [];
  // A buys often and a lot, recently; E bought once, long ago.
  for (const [who, dates, amount] of [
    ['A', ['2026-10-01', '2026-10-10', '2026-10-20'], 1000],
    ['B', ['2026-09-01', '2026-10-15'], 600],
    ['C', ['2026-07-01', '2026-08-01'], 300],
    ['D', ['2026-10-18'], 50],
    ['E', ['2026-01-05'], 20],
  ])
    for (const date of dates) rows.push({ customer: who, date, amount });
  const out = await run('an.rfm', { customerColumn: 'customer', dateColumn: 'date', amountColumn: 'amount', asOf: '' }, rows);
  const by = Object.fromEntries(out.rows.map((r) => [r.customer, r]));
  assert.equal(by.A.recency_days, 0);
  assert.equal(by.A.frequency, 3);
  assert.equal(by.A.monetary, 3000);
  assert.equal(by.A.segment, 'Champions');
  assert.equal(by.E.segment, 'Lost');
  assert.equal(by.E.recency_days, 288);
  assert.deepEqual(out.rows.map((r) => r.customer), ['A', 'B', 'C', 'D', 'E']);
  // A fixed date moves recency.
  const later = await run('an.rfm', { customerColumn: 'customer', dateColumn: 'date', amountColumn: 'amount', asOf: '2026-10-30' }, rows);
  assert.equal(later.rows[0].recency_days, 10);
  await assert.rejects(
    run('an.rfm', { customerColumn: 'customer', dateColumn: 'date', amountColumn: 'amount', asOf: 'kemarin' }, rows),
    (e) => e.key === 'wf.err.badAsOf'
  );
  assert.equal(rfmSegment(5, 1, 1), 'New');
  assert.equal(rfmSegment(1, 5, 5), 'At risk');
});

test('aging: per row with terms, or one row per party with buckets', async () => {
  const rows = [
    { customer: 'PT A', invoice_date: '2026-10-01', amount: 100 }, // due 10-31: current
    { customer: 'PT A', invoice_date: '2026-09-01', amount: 200 }, // due 10-01: 22 days
    { customer: 'PT B', invoice_date: '2026-06-01', amount: 300 }, // due 07-01: 114 days
    { customer: 'PT B', invoice_date: 'n/a', amount: 999 },
  ];
  const cfg = { dateColumn: 'invoice_date', amountColumn: 'amount', termsDays: 30, asOf: '2026-10-23' };
  const perRow = await run('an.aging', { ...cfg, partyColumn: '' }, rows);
  assert.deepEqual(pick(perRow.rows, 'days_overdue', 'aging_bucket'), [
    [-8, 'current'],
    [22, 'd1_30'],
    [114, 'd90_plus'],
    [null, null],
  ]);
  const perParty = await run('an.aging', { ...cfg, partyColumn: 'customer' }, rows);
  assert.deepEqual(perParty.columns, ['customer', 'current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'total', 'oldest_days']);
  assert.deepEqual(perParty.rows, [
    { customer: 'PT B', current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 300, total: 300, oldest_days: 114 },
    { customer: 'PT A', current: 100, d1_30: 200, d31_60: 0, d61_90: 0, d90_plus: 0, total: 300, oldest_days: 22 },
  ]);
});

test('cohorts: first month, then who came back in later months', async () => {
  const rows = [
    { c: 'a', d: '2026-01-05' },
    { c: 'a', d: '2026-02-10' },
    { c: 'b', d: '2026-01-20' },
    { c: 'b', d: '2026-03-02' },
    { c: 'c', d: '2026-02-14' },
  ];
  const out = await run('an.cohort', { customerColumn: 'c', dateColumn: 'd', cohortPeriod: 'monthly' }, rows);
  assert.deepEqual(pick(out.rows, 'cohort', 'period_index', 'period', 'cohort_size', 'active_customers', 'retention_pct'), [
    ['2026-01', 0, '2026-01', 2, 2, 100],
    ['2026-01', 1, '2026-02', 2, 1, 50],
    ['2026-01', 2, '2026-03', 2, 1, 50],
    ['2026-02', 0, '2026-02', 1, 1, 100],
  ]);
});

test('compare periods: gaps are 0, change vs previous and last year, moving average', async () => {
  const rows = [
    { date: '2025-01-15', site: 'U', amount: 50 },
    { date: '2026-01-10', site: 'U', amount: 100 },
    { date: '2026-01-20', site: 'U', amount: 20 },
    { date: '2026-03-05', site: 'U', amount: 60 },
  ];
  const out = await run('an.periodCompare', { dateColumn: 'date', valueColumn: 'amount', operation: 'sum', period: 'monthly', groupBy: '', movingWindow: 2 }, rows);
  const last = out.rows.slice(-3);
  assert.deepEqual(pick(last, 'period', 'value', 'previous', 'change', 'change_pct', 'moving_avg'), [
    ['2026-01', 120, 0, 120, null, 60],
    ['2026-02', 0, 120, -120, -100, 60],
    ['2026-03', 60, 0, 60, null, 30],
  ]);
  assert.equal(last[0].last_year, 50);
  assert.equal(last[0].yoy_pct, 140);
  assert.equal(out.rows.length, 15); // 2025-01 … 2026-03
  assert.equal(out.rows.at(-1).running_total, 230);
  // Per group, counting rows without a value column.
  const grouped = await run('an.periodCompare', { dateColumn: 'date', valueColumn: '', operation: 'count', period: 'yearly', groupBy: 'site', movingWindow: 3 }, rows);
  assert.deepEqual(pick(grouped.rows, 'site', 'period', 'value', 'change'), [
    ['U', '2025', 1, null],
    ['U', '2026', 3, 2],
  ]);
});

test('correlation: numeric columns found by themselves, strongest pair first', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    name: `r${i}`,
    tonnes: i,
    amount: i * 10 + (i % 3),
    returns: (i * 7) % 5,
  }));
  const out = await run('an.correlation', { columns: '' }, rows);
  assert.deepEqual(out.columns, ['column_a', 'column_b', 'correlation', 'pairs', 'strength']);
  assert.equal(out.rows.length, 3);
  assert.deepEqual([out.rows[0].column_a, out.rows[0].column_b, out.rows[0].pairs], ['tonnes', 'amount', 20]);
  assert.ok(out.rows[0].correlation > 0.99);
  assert.equal(out.rows[0].strength, 'strong positive');
  await assert.rejects(run('an.correlation', { columns: 'tonnes' }, rows), (e) => e.key === 'wf.err.needTwoNumeric');
});

test('quantiles: group 1 holds the smallest values; ties share a group', async () => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8, null, 8].map((v) => ({ v }));
  const out = await run('an.quantiles', { column: 'v', buckets: 4, newColumn: 'q' }, rows);
  assert.deepEqual(out.columns, ['v', 'q', 'q_percentile']);
  assert.deepEqual(out.rows.map((r) => r.q), [1, 1, 1, 2, 2, 3, 3, 4, null, 4]);
  assert.equal(out.rows[0].q_percentile, 5.56);
});

test('outliers per group: a big order is normal for a big customer', async () => {
  const rows = [
    ...[10, 11, 9, 10, 12, 10, 11].map((amount) => ({ customer: 'small', amount })),
    ...[1000, 1100, 900, 1050, 950, 1000, 1020].map((amount) => ({ customer: 'big', amount })),
    { customer: 'small', amount: 1000 },
  ];
  const all = await run('an.outliers', { column: 'amount', outlierMethod: 'iqr', threshold: 1.5, partitionBy: '' }, rows);
  assert.equal(all.rows.filter((r) => r.is_outlier).length, 0);
  const per = await run('an.outliers', { column: 'amount', outlierMethod: 'iqr', threshold: 1.5, partitionBy: 'customer' }, rows);
  assert.deepEqual(per.rows.filter((r) => r.is_outlier).map((r) => [r.customer, r.amount]), [['small', 1000]]);
});

test('the editor knows the output columns before running', () => {
  const node = (id, type, config) => ({ id, type: 'workflowNode', position: { x: 0, y: 0 }, data: { type, label: type, config } });
  const graph = {
    nodes: [
      node('src', 'src.psDataset', { datasetId: '', limit: 100, columns: [{ name: 'customer' }, { name: 'date' }, { name: 'amount' }] }),
      node('rfm', 'an.rfm', { customerColumn: 'customer', dateColumn: 'date', amountColumn: 'amount', asOf: '' }),
      node('cmp', 'an.periodCompare', { dateColumn: 'date', valueColumn: 'amount', operation: 'sum', period: 'monthly', groupBy: 'customer', movingWindow: 3 }),
      node('bad', 'an.pareto', { itemColumn: 'nope', valueColumn: 'amount', aThreshold: 80, bThreshold: 95 }),
    ],
    edges: [
      { id: 'e1', source: 'src', target: 'rfm' },
      { id: 'e2', source: 'src', target: 'cmp' },
      { id: 'e3', source: 'src', target: 'bad' },
    ],
  };
  const info = analyzeGraph(graph);
  const names = (id) => info.nodes[id]?.outputs.out?.map((c) => c.name);
  assert.deepEqual(names('rfm').slice(0, 3), ['customer', 'last_date', 'recency_days']);
  assert.deepEqual(names('cmp').slice(0, 3), ['customer', 'period', 'period_start']);
  assert.ok(info.nodes.bad.issues.some((i) => i.key === 'wf.err.unknownColumn' || /column/i.test(i.key)));
});
