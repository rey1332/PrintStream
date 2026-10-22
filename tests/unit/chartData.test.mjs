import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME } from '../../src/lib/workflow/runtime.ts';
import { MAX_SERIES, OTHER, TOTAL, naturalCompare } from '../../src/lib/workflow/chartData.ts';

// The Chart node (out.chart): data shaped on the server for each kind.

const run = (config, rows, columns = Object.keys(rows[0] ?? {})) =>
  RUNTIME['out.chart'].run({ chartKind: 'bar', aggregation: 'sum', ...config }, [{ columns, rows, meta: {} }], {});

const sales = [
  { month: '2026-02', site: 'Utara', product: 'Split', tonnes: 10, amount: 100 },
  { month: '2026-01', site: 'Utara', product: 'Abu', tonnes: 5, amount: 40 },
  { month: '2026-01', site: 'Selatan', product: 'Split', tonnes: 7, amount: 70 },
  { month: '2026-02', site: 'Selatan', product: 'Sirtu', tonnes: 3, amount: 20 },
  { month: '2026-03', site: 'Utara', product: 'Split', tonnes: 8, amount: 80 },
];

test('bars: one row per category, several values, largest first or by label', async () => {
  const out = await run({ xColumn: 'product', measures: 'tonnes, amount' }, sales);
  assert.deepEqual(out.columns, ['product', 'tonnes', 'amount']);
  assert.deepEqual(out.rows.map((r) => [r.product, r.tonnes, r.amount]), [
    ['Split', 25, 250],
    ['Abu', 5, 40],
    ['Sirtu', 3, 20],
  ]);
  assert.equal(out.meta.chart.kind, 'bar');
  assert.deepEqual(out.meta.chart.series, ['tonnes', 'amount']);
  assert.equal(out.meta.preAggregated, true);
  assert.equal(out.meta.sourceRows, 5);
  const byLabel = await run({ xColumn: 'product', measures: 'tonnes', chartSort: 'byLabel' }, sales);
  assert.deepEqual(byLabel.rows.map((r) => r.product), ['Abu', 'Sirtu', 'Split']);
});

test('series from a column: stacked bars and lines over time, sorted by time', async () => {
  const out = await run({ chartKind: 'stackedArea', xColumn: 'month', measures: 'tonnes', seriesColumn: 'site' }, sales);
  assert.deepEqual(out.meta.chart.series, ['Utara', 'Selatan']);
  assert.deepEqual(out.rows, [
    { month: '2026-01', Utara: 5, Selatan: 7 },
    { month: '2026-02', Utara: 10, Selatan: 3 },
    { month: '2026-03', Utara: 8, Selatan: 0 },
  ]);
});

test('more series than colours fold into "Other"; pie slices too', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ k: `k${i}`, s: `s${i}`, v: 100 - i }));
  const stacked = await run({ chartKind: 'stackedBar', xColumn: 'k', measures: 'v', seriesColumn: 's' }, rows);
  assert.equal(stacked.meta.chart.series.length, MAX_SERIES);
  assert.equal(stacked.meta.chart.series.at(-1), OTHER);
  assert.equal(stacked.rows.find((r) => r.k === 'k11')[OTHER], 89);
  const pie = await run({ chartKind: 'pie', xColumn: 'k', measures: 'v' }, rows);
  assert.equal(pie.rows.length, MAX_SERIES);
  const other = pie.rows.find((r) => r.k === OTHER);
  assert.equal(other.v, [93, 92, 91, 90, 89].reduce((a, b) => a + b));
  // Nothing is lost: the slices add up to the total.
  assert.equal(pie.rows.reduce((n, r) => n + r.v, 0), rows.reduce((n, r) => n + r.v, 0));
});

test('count needs no value column; avg works per group', async () => {
  const count = await run({ xColumn: 'site', aggregation: 'count' }, sales);
  assert.deepEqual(count.meta.chart.series, ['count']);
  assert.deepEqual(count.rows, [{ site: 'Utara', count: 3 }, { site: 'Selatan', count: 2 }]);
  const avg = await run({ xColumn: 'site', measures: 'tonnes', aggregation: 'avg' }, sales);
  assert.equal(avg.rows.find((r) => r.site === 'Selatan').tonnes, 5);
});

test('histogram: equal bins over the range, every value counted once', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ v: i }));
  const out = await run({ chartKind: 'histogram', measures: 'v', bins: 10 }, rows);
  assert.equal(out.rows.length, 10);
  assert.equal(out.rows.reduce((n, r) => n + r.count, 0), 100);
  assert.equal(out.rows[0].from, 0);
  assert.equal(out.rows.at(-1).to, 99);
  const flat = await run({ chartKind: 'histogram', measures: 'v' }, [{ v: 5 }, { v: 5 }]);
  assert.deepEqual(flat.rows.map((r) => r.count), [2]);
});

test('scatter: numeric pairs only, sampled past 2000 points, series by a column', async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ x: i, y: i * 2, g: i % 2 ? 'a' : 'b' }));
  rows.push({ x: 'n/a', y: 1, g: 'a' });
  const out = await run({ chartKind: 'scatter', xColumn: 'x', measures: 'y', seriesColumn: 'g' }, rows);
  assert.equal(out.rows.length, 2000);
  assert.equal(out.meta.chart.omitted, 3000);
  assert.equal(out.rows[0].x, 0);
  assert.equal(out.rows.at(-1).x, 4999);
  assert.ok(out.rows.every((r) => r.y === r.x * 2));
  assert.deepEqual([...out.meta.chart.series].sort(), ['a', 'b']);
});

test('heatmap and pivot: two categories against one value, with totals', async () => {
  const heat = await run({ chartKind: 'heatmap', xColumn: 'month', seriesColumn: 'site', measures: 'tonnes' }, sales);
  assert.equal(heat.rows.length, 6);
  assert.equal(heat.rows.find((r) => r.month === '2026-01' && r.site === 'Selatan').value, 7);
  const pivot = await run({ chartKind: 'pivot', xColumn: 'site', seriesColumn: 'month', measures: 'tonnes' }, sales);
  assert.deepEqual(pivot.columns, ['site', '2026-01', '2026-02', '2026-03', TOTAL]);
  assert.deepEqual(pivot.rows.find((r) => r.site === 'Utara'), { site: 'Utara', '2026-01': 5, '2026-02': 10, '2026-03': 8, [TOTAL]: 23 });
  assert.deepEqual(pivot.rows.at(-1), { site: TOTAL, '2026-01': 12, '2026-02': 13, '2026-03': 8, [TOTAL]: 33 });
});

test('errors name the missing setting or the unknown column', async () => {
  await assert.rejects(run({ xColumn: '', measures: 'tonnes' }, sales), (e) => e.key === 'wf.err.missingConfig');
  await assert.rejects(run({ xColumn: 'nope', measures: 'tonnes' }, sales), (e) => e.key === 'wf.err.unknownColumn');
  await assert.rejects(run({ xColumn: 'site', measures: 'missing' }, sales), (e) => e.key === 'wf.err.unknownColumn');
  await assert.rejects(run({ chartKind: 'pivot', xColumn: 'site', measures: 'tonnes' }, sales), (e) => e.key === 'wf.err.missingConfig');
});

test('mixed currencies are not added together', async () => {
  const lineage = {
    status: { entity: 'invoices', field: 'status' },
    total: { entity: 'invoices', field: 'total' },
    currency: { entity: 'invoices', field: 'currency' },
  };
  const rows = [
    { status: 'paid', total: 100, currency: null },
    { status: 'paid', total: 10, currency: 'USD' },
    { status: 'unpaid', total: 5, currency: null },
  ];
  const out = await RUNTIME['out.chart'].run(
    { chartKind: 'bar', xColumn: 'status', measures: 'total', aggregation: 'sum' },
    [{ columns: ['status', 'total', 'currency'], rows, meta: { lineage, columnTypes: { total: 'money' } } }],
    {}
  );
  assert.deepEqual(out.rows.map((r) => [r.status, r.total]), [['unpaid', 5], ['paid', null]]);
  assert.ok(out.meta.warnings.some((w) => w.key === 'wf.notice.mixedCurrency'));
});

test('natural order: numbers as numbers, dates as dates', () => {
  assert.deepEqual(['10', '9', '100'].sort(naturalCompare), ['9', '10', '100']);
  assert.deepEqual(['2026-10', '2026-02'].sort(naturalCompare), ['2026-02', '2026-10']);
});
