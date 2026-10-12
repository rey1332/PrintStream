import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME } from '../../src/lib/workflow/runtime.ts';
import { analyzeGraph } from '../../src/lib/workflow/schema.ts';
import { executeWorkflow } from '../../src/lib/workflow/executor.ts';
import { NODE_REGISTRY, CATEGORIES } from '../../src/lib/workflow/registry.ts';
import { normalizeName, similarity, UNIFY_META } from '../../src/lib/workflow/unifyNodes.ts';
import { hasMessage } from '../../src/lib/i18n/labels.ts';

const table = (columns, rows, columnTypes = {}) => ({ columns, rows, meta: { count: rows.length, columnTypes } });
const run = (type, cfg, ...inputs) => RUNTIME[type].run(cfg, inputs, {});
const node = (id, type, config = {}) => ({ id, type: 'workflowNode', position: { x: 0, y: 0 }, data: { type, label: type, config } });
const edge = (source, target, sourceHandle) => ({ id: `${source}-${target}-${sourceHandle ?? ''}`, source, target, sourceHandle });

const trips = table(
  ['id', 'customer', 'tonnes', 'date'],
  [
    { id: 1, customer: '  pt  batu jaya ', tonnes: 10, date: '2026-01-05' },
    { id: 2, customer: 'CV Kerikil', tonnes: null, date: '06/01/2026' },
    { id: 1, customer: 'PT Batu Jaya', tonnes: 12, date: '2026-02-10' },
  ],
  { id: 'integer', tonnes: 'number', date: 'date', customer: 'text' }
);

test('every new node is registered, labelled in all languages and in a palette group', () => {
  const groups = new Set(CATEGORIES.map((c) => c.id));
  for (const m of UNIFY_META) {
    assert.ok(NODE_REGISTRY[m.type], m.type);
    assert.ok(groups.has(m.category), m.category);
    assert.ok(hasMessage(`wf.node.${m.type}`) && hasMessage(`wf.desc.${m.type}`), m.type);
    for (const k of Object.keys(m.defaultConfig)) assert.ok(hasMessage(`wf.field.${k}`), `wf.field.${k}`);
  }
});

test('stack, dedupe, fill, change type, clean, split and combine', async () => {
  const other = table(['id', 'customer', 'site'], [{ id: 9, customer: 'UD Pasir', site: 'Bogor' }]);
  const u = await run('tf.union', { sourceColumn: 'from', firstLabel: 'tambang', secondLabel: 'kantor' }, trips, other);
  assert.deepEqual(u.columns, ['id', 'customer', 'tonnes', 'date', 'site', 'from']);
  assert.equal(u.rows.length, 4);
  assert.deepEqual([u.rows[0].from, u.rows[3].from, u.rows[3].tonnes], ['tambang', 'kantor', null]);

  const d = await run('tf.dedupe', { keyColumns: 'id', keep: 'last' }, trips);
  assert.deepEqual(d.rows.map((r) => r.tonnes), [12, null]);
  assert.equal((await run('tf.dedupe', { keyColumns: '' }, trips)).rows.length, 3);

  const f = await run('tf.fillMissing', { columns: 'tonnes', fillMethod: 'mean' }, trips);
  assert.equal(f.rows[1].tonnes, 11);
  assert.equal((await run('tf.fillMissing', { columns: 'tonnes', fillMethod: 'previous' }, trips)).rows[1].tonnes, 10);

  const c = await run('tf.cast', { column: 'date', toType: 'date' }, trips);
  assert.deepEqual(c.rows.map((r) => r.date), ['2026-01-05', '2026-01-06', '2026-02-10']);
  const bad = await run('tf.cast', { column: 'customer', toType: 'number' }, trips);
  assert.equal(bad.meta.warnings.at(-1).vars.count, 3);
  assert.equal(bad.meta.columnTypes.customer, 'number');

  const clean = await run('tf.cleanText', { columns: 'customer', textCase: 'title' }, trips);
  assert.equal(clean.rows[0].customer, 'Pt Batu Jaya');

  const s = await run('tf.split', { column: 'date', separator: '-', newColumns: 'y, rest' }, trips);
  assert.deepEqual([s.rows[0].y, s.rows[0].rest], ['2026', '01-05']);
  const j = await run('tf.concat', { columns: 'id, customer', separator: ' / ', newColumn: 'label' }, trips);
  assert.equal(j.rows[1].label, '2 / CV Kerikil');
});

test('lookup, fuzzy match and standardize', async () => {
  const customers = table(['code', 'name', 'city'], [
    { code: 'C1', name: 'Batu Jaya, PT', city: 'Bogor' },
    { code: 'C2', name: 'CV. Kerikil Makmur', city: 'Depok' },
  ]);
  const withCode = table(['ref', 'v'], [{ ref: 'C2', v: 1 }, { ref: 'C9', v: 2 }]);
  const l = await run('tf.lookup', { key: 'ref', lookupKey: 'code', bring: 'city' }, withCode, customers);
  assert.deepEqual(l.rows.map((r) => r.city), ['Depok', null]);

  assert.equal(normalizeName('PT. Batu Jaya'), normalizeName('Batu Jaya, PT'));
  assert.ok(similarity('kerikil', 'kerikil makmur') > 0.6);
  const m = await run('tf.fuzzyMatch', { matchColumn: 'customer', candidateColumn: 'name', threshold: 0.7, bring: 'code' }, trips, customers);
  assert.deepEqual(m.rows.map((r) => r.code), ['C1', 'C2', 'C1']);
  assert.equal(m.rows[0].match_score, 1);
  const strict = await run('tf.fuzzyMatch', { matchColumn: 'customer', candidateColumn: 'name', threshold: 0.99, bring: 'code' }, trips, customers);
  assert.equal(strict.rows[1].code, null);

  const st = await run('tf.standardize', { column: 'customer', mapping: 'cv kerikil=Kerikil; x=y', unmatched: 'keep' }, trips);
  assert.deepEqual(st.rows.map((r) => r.customer), ['  pt  batu jaya ', 'Kerikil', 'PT Batu Jaya']);
});

test('pivot, unpivot, running values and dates', async () => {
  const sales = table(['site', 'month', 't'], [
    { site: 'A', month: 'Jan', t: 5 },
    { site: 'A', month: 'Feb', t: 7 },
    { site: 'B', month: 'Jan', t: 3 },
    { site: 'A', month: 'Jan', t: 1 },
  ]);
  const p = await run('tf.pivot', { rowKey: 'site', pivotColumn: 'month', valueColumn: 't', operation: 'sum' }, sales);
  assert.deepEqual(p.columns, ['site', 'Jan', 'Feb']);
  assert.deepEqual(p.rows, [{ site: 'A', Jan: 6, Feb: 7 }, { site: 'B', Jan: 3, Feb: null }]);

  const up = await run('tf.unpivot', { idColumns: 'site', valueColumns: 'Jan, Feb', nameColumn: 'month', valueName: 't' }, p);
  assert.equal(up.rows.length, 4);
  assert.deepEqual(up.rows[1], { site: 'A', month: 'Feb', t: 7 });

  const w = await run('tf.window', { windowOp: 'running_sum', column: 't', partitionBy: 'site', newColumn: 'cum' }, sales);
  assert.deepEqual(w.rows.map((r) => r.cum), [5, 12, 3, 13]);
  const r = await run('tf.window', { windowOp: 'rank', column: 't', newColumn: 'rank' }, sales);
  assert.deepEqual(r.rows.map((x) => x.rank), [2, 1, 3, 4]);
  const pct = await run('tf.window', { windowOp: 'percent_of_total', column: 't', partitionBy: 'site', newColumn: 'pct' }, sales);
  assert.equal(pct.rows[2].pct, 100);

  const dp = await run('tf.dateParts', { column: 'date', datePart: 'year_month' }, trips);
  assert.deepEqual(dp.rows.map((x) => x.date_year_month), ['2026-01', '2026-01', '2026-02']);
  const wk = await run('tf.dateParts', { column: 'date', datePart: 'weekday', newColumn: 'wd' }, trips);
  assert.equal(wk.rows[0].wd, 1);
  const dd = await run(
    'tf.dateDiff',
    { startColumn: 'a', endColumn: 'b', diffUnit: 'months', newColumn: 'm' },
    table(['a', 'b'], [{ a: '2026-01-31', b: '2026-03-30' }, { a: null, b: '2026-01-01' }])
  );
  assert.deepEqual(dd.rows.map((x) => x.m), [1, null]);
});

test('profile, rules (valid / not valid) and outliers', async () => {
  const prof = await run('an.profile', {}, trips);
  const tonnes = prof.rows.find((r) => r.column === 'tonnes');
  assert.deepEqual([tonnes.missing, tonnes.distinct, tonnes.min, tonnes.max], [1, 2, '10', '12']);

  const rules = await run(
    'tf.rules',
    { requiredColumns: 'tonnes', uniqueKey: 'id', rangeColumn: 'tonnes', min: '0', max: '11' },
    trips
  );
  assert.equal(rules.valid.rows.length, 1);
  assert.deepEqual(rules.invalid.rows.map((r) => r._reason), ['missing:tonnes', 'out_of_range:tonnes']);

  const vals = table(['v'], [1, 2, 2, 3, 2, 50].map((v) => ({ v })));
  const o = await run('an.outliers', { column: 'v', outlierMethod: 'iqr', threshold: 1.5 }, vals);
  assert.deepEqual(o.rows.map((r) => r.is_outlier), [false, false, false, false, false, true]);
});

test('the editor knows the output columns; a whole pipeline runs', async () => {
  const graph = {
    nodes: [
      node('a', 'src.psDataset', { datasetId: 'x', columns: [{ name: 'id', type: 'integer' }, { name: 'customer', type: 'text' }, { name: 'tonnes', type: 'number' }, { name: 'date', type: 'date' }] }),
      node('b', 'tf.dedupe', { keyColumns: 'id' }),
      node('c', 'tf.dateParts', { column: 'date', datePart: 'month', newColumn: 'month' }),
      node('d', 'tf.rules', { requiredColumns: 'tonnes' }),
      node('e', 'out.table'),
    ],
    edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e', 'valid')],
  };
  const analysis = analyzeGraph(graph);
  assert.deepEqual(analysis.issues.filter((i) => i.severity === 'error'), []);
  assert.deepEqual(analysis.nodes.c.outputs.out.map((c) => c.name), ['id', 'customer', 'tonnes', 'date', 'month']);
  assert.deepEqual(analysis.nodes.d.outputs.invalid.at(-1), { name: '_reason', type: 'text' });

  const bad = { ...graph, nodes: graph.nodes.map((n) => (n.id === 'c' ? node('c', 'tf.dateParts', { column: 'nope' }) : n)) };
  assert.ok(analyzeGraph(bad).issues.some((i) => i.key === 'wf.err.unknownColumn'));

  const outcome = await executeWorkflow(graph, {
    ctx: { query: async () => ({}), readDataset: async () => trips },
    deadline: Date.now() + 10_000,
  });
  assert.equal(outcome.status, 'success');
  assert.deepEqual(outcome.results.e.output.rows.map((r) => r.month), [1]);
});

test('ERP nodes name the linked ERP; adding to an ERP list only happens in background runs', async () => {
  const seen = [];
  const ctx = {
    query: async (spec, erp) => {
      seen.push(erp);
      return { columns: [], rows: [], meta: { entity: spec.entity, fetchedAt: '', rowCount: 0, offset: 0, limit: 1, truncated: false, quality: {} } };
    },
  };
  await RUNTIME['src.customers'].run({ selectedId: '', erpId: 'erp-1' }, [], ctx);
  await RUNTIME['src.customers'].run({ selectedId: '' }, [], ctx);
  assert.deepEqual(seen, ['erp-1', null]);

  const rows = table(['name', 'city'], [{ name: 'PT Satu', city: 'Bogor' }]);
  const preview = await RUNTIME['out.erpList'].run({ erpId: 'erp-1', list: 'customers' }, [rows], ctx);
  assert.equal(preview.meta.warnings.at(-1).key, 'wf.warn.wouldWriteErp');
  const calls = [];
  const written = await RUNTIME['out.erpList'].run({ erpId: 'erp-1', list: 'suppliers', erpMode: 'add_or_update' }, [rows], {
    ...ctx,
    writeErpList: async (spec) => (calls.push(spec), { added: 1, updated: 0, skipped: 0, rejected: 0 }),
  });
  assert.deepEqual(calls, [{ erpId: 'erp-1', list: 'suppliers', mode: 'add_or_update' }]);
  assert.equal(written.meta.warnings.at(-1).vars.added, 1);
  await assert.rejects(RUNTIME['out.erpList'].run({ list: 'customers' }, [table(['city'], [])], ctx), (e) => e.key === 'wf.err.erpNameColumn');
});
