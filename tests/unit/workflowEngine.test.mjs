import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME, checkQuality, legacySourceSpec, matches } from '../../src/lib/workflow/runtime.ts';
import { analyzeGraph, canConnect } from '../../src/lib/workflow/schema.ts';
import { executeWorkflow, forDisplay, summarize, outputRowCount } from '../../src/lib/workflow/executor.ts';
import { WorkflowError } from '../../src/lib/workflow/errors.ts';

const table = (columns, rows, meta = {}) => ({ columns, rows, meta: { count: rows.length, ...meta } });
const noQuery = { query: async () => { throw new Error('no ERP access in this test'); } };
const node = (id, type, config = {}) => ({ id, type: 'workflowNode', position: { x: 0, y: 0 }, data: { type, label: type, config } });
const edge = (source, target, sourceHandle) => ({ id: `${source}-${target}-${sourceHandle ?? ''}`, source, target, sourceHandle });

// A fake ERP query function that records specs and returns invoice rows.
function fakeErp(rows = [
  { invoice_date: '2026-01-02', customer_name: 'Ana', total: 100, amount_paid: 40, balance_due: 60 },
  { invoice_date: '2026-01-03', customer_name: 'Budi', total: 50, amount_paid: 50, balance_due: 0 },
  { invoice_date: '2026-01-04', customer_name: '', total: 80, amount_paid: 0, balance_due: 80 },
]) {
  const specs = [];
  return {
    specs,
    ctx: {
      query: async (spec) => {
        specs.push(spec);
        const columns = [...spec.fields].map((name) => ({ name, type: name === 'customer_name' ? 'text' : name === 'invoice_date' ? 'date' : 'money', nullable: false, entity: spec.entity, field: name }));
        return {
          columns,
          rows: rows.map((r) => Object.fromEntries(spec.fields.map((f) => [f, r[f] ?? null]))),
          meta: { entity: spec.entity, fetchedAt: '2026-09-27T00:00:00.000Z', rowCount: rows.length, offset: 0, limit: spec.limit, truncated: false, quality: { relationMismatches: 0, unresolvedRelations: 2 } },
        };
      },
    },
  };
}

const erpConfig = { entity: 'invoices', fields: ['invoice_date', 'customer_name', 'total', 'amount_paid', 'balance_due'], related: [], filters: [], sort: null, limit: 100 };

// ─── Nodes ────────────────────────────────────────────────────────────────────

test('ERP source validates its query before reading and reports unresolved links', async () => {
  const erp = fakeErp();
  const out = await RUNTIME['src.erp'].run(erpConfig, [], erp.ctx);
  assert.equal(erp.specs.length, 1);
  assert.equal(out.rows.length, 3);
  assert.equal(out.meta.columnTypes.total, 'money');
  assert.deepEqual(out.meta.warnings, [{ key: 'cat.notice.unresolved', vars: { count: 2 } }]);
  await assert.rejects(RUNTIME['src.erp'].run({ ...erpConfig, fields: ['user_id'] }, [], erp.ctx), (e) => e instanceof WorkflowError && e.key === 'cat.err.unknownField');
  assert.equal(erp.specs.length, 1, 'an invalid query never reaches the database');
});

test('original source nodes read stored catalog fields only, optionally one record', () => {
  const spec = legacySourceSpec('invoices', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.ok(!spec.fields.includes('balance_due') && !spec.fields.includes('user_id'));
  assert.deepEqual(spec.filters, [{ field: 'id', op: 'eq', value: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]);
});

test('select & rename keeps and renames columns, rejecting clashes', async () => {
  const input = table(['a', 'b', 'c'], [{ a: 1, b: 2, c: 3 }], { columnTypes: { a: 'money' } });
  const out = await RUNTIME['tf.select'].run({ columns: 'a, c', rename: 'a:amount' }, [input], noQuery);
  assert.deepEqual(out.columns, ['amount', 'c']);
  assert.deepEqual(out.rows, [{ amount: 1, c: 3 }]);
  assert.deepEqual(out.meta.columnTypes, { amount: 'money' });
  await assert.rejects(RUNTIME['tf.select'].run({ columns: 'a,b', rename: 'a:b' }, [input], noQuery), /same name/);
  await assert.rejects(RUNTIME['tf.select'].run({ columns: 'zzz' }, [input], noQuery), /"zzz"/);
});

test('calculated field uses column names, including bracketed names', async () => {
  const input = table(['total', 'customer.balance'], [{ total: 100, 'customer.balance': 30 }, { total: null, 'customer.balance': 5 }]);
  const out = await RUNTIME['tf.calc'].run({ newColumn: 'net', formula: 'total - [customer.balance]' }, [input], noQuery);
  assert.deepEqual(out.rows.map((r) => r.net), [70, null]);
  await assert.rejects(RUNTIME['tf.calc'].run({ newColumn: 'x', formula: 'fetch(1)' }, [input], noQuery), /formula/i);
});

test('validate data counts problems, lists affected rows and can exclude them', async () => {
  const input = table(['id', 'name', 'total', 'date'], [
    { id: 1, name: 'a', total: 5, date: '2026-01-01' },
    { id: 1, name: '', total: 'x', date: 'soon' },
    { id: 2, name: 'c', total: 7, date: null },
  ], { warnings: [{ key: 'cat.notice.unresolved', vars: { count: 4 } }] });
  const cfg = { requiredColumns: 'name', numericColumns: 'total', dateColumns: 'date', uniqueKey: 'id' };
  const report = await RUNTIME['tf.validate'].run({ ...cfg, action: 'report' }, [input], noQuery);
  assert.deepEqual(report.meta.quality, { checkedRows: 3, invalidRows: 1, missingRequired: 1, invalidType: 2, duplicateKeys: 1, failedRelationships: 4 });
  assert.equal(report.rows.length, 3);
  assert.ok(report.meta.issues.every((i) => i.row === 1));
  const excluded = await RUNTIME['tf.validate'].run({ ...cfg, action: 'exclude' }, [input], noQuery);
  assert.deepEqual(excluded.rows.map((r) => r.id), [1, 2]);
  assert.throws(() => checkQuality(input, { requiredColumns: 'missing' }), /"missing"/);
});

test('branch splits rows into match and otherwise', async () => {
  const input = table(['status'], [{ status: 'paid' }, { status: 'unpaid' }, { status: 'paid' }]);
  const out = await RUNTIME['tf.branch'].run({ column: 'status', operator: '=', value: 'paid' }, [input], noQuery);
  assert.deepEqual([out.match.rows.length, out.else.rows.length], [2, 1]);
  assert.equal(matches(null, '=', ''), true);
  assert.equal(matches('10', '>', '9'), true);
});

test('bar chart points are aggregated on the server', async () => {
  const input = table(['city', 'total'], [{ city: 'A', total: 1 }, { city: 'B', total: 5 }, { city: 'A', total: 2 }]);
  const out = await RUNTIME['out.barChart'].run({ categoryColumn: 'city', valueColumn: 'total', aggregation: 'count' }, [input], noQuery);
  assert.deepEqual(out.rows, [{ city: 'A', total: 2 }, { city: 'B', total: 1 }]);
  assert.equal(out.meta.preAggregated, true);
  assert.equal(out.meta.sourceRows, 3);
});

// ─── Static checks ────────────────────────────────────────────────────────────

test('field names and types flow along connections before running', () => {
  const graph = {
    nodes: [
      node('src', 'src.erp', erpConfig),
      node('calc', 'tf.calc', { newColumn: 'open', formula: 'total - amount_paid' }),
      node('sel', 'tf.select', { columns: 'customer_name, open', rename: 'open:open_amount' }),
      node('kpi', 'out.kpi', { column: 'open_amount', operation: 'sum', label: 'Open' }),
    ],
    edges: [edge('src', 'calc'), edge('calc', 'sel'), edge('sel', 'kpi')],
  };
  const a = analyzeGraph(graph);
  assert.deepEqual(a.issues, []);
  assert.deepEqual(a.nodes.sel.outputs.out.map(({ name, type }) => ({ name, type })), [{ name: 'customer_name', type: 'text' }, { name: 'open_amount', type: 'number' }]);
  assert.deepEqual(a.nodes.sel.outputs.out[0].lineage, { entity: 'invoices', field: 'customer_name' }, 'ERP origin follows renames');
  assert.deepEqual(a.nodes.kpi.inputs[0].map((c) => c.name), ['customer_name', 'open_amount']);
});

test('configuration problems are found before running', () => {
  const graph = {
    nodes: [
      node('src', 'src.erp', erpConfig),
      node('f', 'tf.filter', { column: 'no_such_column', operator: '=', value: '1' }),
      node('j', 'tf.join', { leftKey: 'id', rightKey: 'id', joinType: 'inner' }),
      node('calc', 'tf.calc', { newColumn: 'x', formula: 'total * nope' }),
      node('bad', 'src.erp', { ...erpConfig, fields: ['workspace_id'] }),
      node('mystery', 'tf.unknown', {}),
    ],
    edges: [edge('src', 'f'), edge('src', 'calc')],
  };
  const keys = analyzeGraph(graph).issues.map((i) => `${i.nodeId}:${i.key}`);
  assert.ok(keys.includes('f:wf.err.unknownColumn'));
  assert.ok(keys.includes('j:wf.err.missingInput'));
  assert.ok(keys.includes('calc:wf.err.formula'));
  assert.ok(keys.includes('bad:cat.err.unknownField'));
  assert.ok(keys.includes('mystery:wf.err.unknownType'));
});

test('connections that would loop or overfill an input are refused', () => {
  const graph = {
    nodes: [node('a', 'src.erp', erpConfig), node('b', 'tf.filter'), node('c', 'tf.sort'), node('j', 'tf.join')],
    edges: [edge('a', 'b'), edge('b', 'c')],
  };
  assert.equal(canConnect(graph, 'c', 'b'), false, 'cycle');
  assert.equal(canConnect(graph, 'b', 'b'), false, 'self');
  assert.equal(canConnect(graph, 'a', 'b'), false, 'input already connected');
  assert.equal(canConnect(graph, 'a', 'c'), false, 'filter/sort take one input');
  assert.equal(canConnect(graph, 'c', 'j'), true);
  assert.equal(canConnect(graph, 'a', 'x'), false, 'unknown target');
  assert.ok(analyzeGraph({ nodes: graph.nodes, edges: [...graph.edges, edge('c', 'b')] }).issues.some((i) => i.key === 'wf.err.cycles'));
});

// ─── Engine ───────────────────────────────────────────────────────────────────

test('runs a branching workflow and routes each output to its own path', async () => {
  const erp = fakeErp();
  const graph = {
    nodes: [
      node('src', 'src.erp', erpConfig),
      node('br', 'tf.branch', { column: 'balance_due', operator: '>', value: '0' }),
      node('open', 'out.kpi', { column: 'balance_due', operation: 'sum', label: 'Open' }),
      node('paid', 'out.table', { maxRows: 1 }),
    ],
    edges: [edge('src', 'br'), edge('br', 'open', 'match'), edge('br', 'paid', 'else')],
  };
  const outcome = await executeWorkflow(graph, { ctx: erp.ctx, deadline: Date.now() + 5000 });
  assert.equal(outcome.status, 'success');
  assert.equal(outcome.results.open.output.rows[0].value, 140);
  assert.equal(outcome.results.paid.output.rows.length, 1);
  assert.equal(outputRowCount(graph, outcome.results), 2);
});

test('a graph with problems never runs and never reads ERP data', async () => {
  const erp = fakeErp();
  const graph = { nodes: [node('src', 'src.erp', erpConfig), node('f', 'tf.filter', { column: 'nope' })], edges: [edge('src', 'f')] };
  const outcome = await executeWorkflow(graph, { ctx: erp.ctx, deadline: Date.now() + 5000 });
  assert.deepEqual([outcome.status, outcome.errorCode], ['failed', 'invalidGraph']);
  assert.equal(erp.specs.length, 0);
});

test('failures skip later steps; time limits and cancellation stop the run', async () => {
  const erp = fakeErp();
  const graph = {
    nodes: [node('src', 'src.erp', erpConfig), node('j', 'tf.limit', { n: 1 }), node('t', 'out.table')],
    edges: [edge('src', 'j'), edge('j', 't')],
  };
  const failing = { query: async () => { throw new WorkflowError('cat.err.queryFailed'); } };
  const failed = await executeWorkflow(graph, { ctx: failing, deadline: Date.now() + 5000 });
  assert.deepEqual([failed.status, failed.errorCode], ['failed', 'nodeFailed']);
  assert.equal(failed.results.src.error.key, 'cat.err.queryFailed');
  assert.deepEqual([failed.results.t.skipped, failed.results.t.error.key], [true, 'wf.err.upstreamFailed']);

  let clock = 0;
  const timed = await executeWorkflow(graph, { ctx: erp.ctx, deadline: 1, now: () => (clock += 1) });
  assert.deepEqual([timed.status, timed.errorCode], ['failed', 'timeout']);
  assert.equal(timed.results.t.error.key, 'wf.err.timeout');

  let checks = 0;
  const cancelled = await executeWorkflow(graph, { ctx: erp.ctx, deadline: Date.now() + 5000, isCancelled: async () => ++checks > 1 });
  assert.deepEqual([cancelled.status, cancelled.errorCode], ['cancelled', 'cancelled']);
  assert.equal(cancelled.results.src.ok, true);
  assert.equal(cancelled.results.j.error.key, 'wf.err.cancelled');
});

test('run history keeps metadata only and the browser gets capped rows', async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ invoice_date: '2026-01-01', customer_name: `c${i}`, total: i, amount_paid: 0, balance_due: i }));
  const erp = fakeErp(many);
  const graph = { nodes: [node('src', 'src.erp', erpConfig), node('t', 'out.table', { maxRows: 30 })], edges: [edge('src', 't')] };
  const outcome = await executeWorkflow(graph, { ctx: erp.ctx, deadline: Date.now() + 5000 });
  const history = summarize(outcome.results);
  assert.deepEqual(history.src, { ok: true, ms: history.src.ms, rows: 120, cols: 5, warnings: ['cat.notice.unresolved'] });
  assert.ok(!JSON.stringify(history).includes('c119'), 'no row data in history');
  const shown = forDisplay(graph, outcome.results);
  assert.equal(shown.src.output.rows.length, 50);
  assert.equal(shown.t.output.rows.length, 30);
  assert.equal(shown.t.output.meta.count, 120);
  assert.equal(shown.t.output.meta.displayTruncated, true);
});

// ─── Honest totals ────────────────────────────────────────────────────────────

const invoiceTable = (rows, extra = {}) => table(['status', 'currency', 'total'], rows, {
  columnTypes: { status: 'enum', currency: 'text', total: 'money' },
  lineage: { status: { entity: 'invoices', field: 'status' }, currency: { entity: 'invoices', field: 'currency' }, total: { entity: 'invoices', field: 'total' } },
  ...extra,
});

test('aggregates count any filled value, add money in cents and leave empty results empty', async () => {
  const input = table(['name', 'amount'], [{ name: 'a', amount: 0.1 }, { name: 'b', amount: 0.2 }, { name: '', amount: null }], { columnTypes: { amount: 'money' } });
  const kpi = (column, operation) => RUNTIME['out.kpi'].run({ column, operation, label: 'x' }, [input], noQuery);
  assert.equal((await kpi('name', 'count')).rows[0].value, 2, 'text values are counted');
  assert.equal((await kpi('amount', 'sum')).rows[0].value, 0.3, 'no floating-point noise');
  const empty = table(['v'], [{ v: null }]);
  for (const op of ['avg', 'min', 'max']) {
    assert.equal((await RUNTIME['out.kpi'].run({ column: 'v', operation: op }, [empty], noQuery)).rows[0].value, null, op);
  }
  const grouped = await RUNTIME['tf.aggregate'].run({ groupBy: 'name', aggregateColumn: 'amount', operation: 'sum' }, [input], noQuery);
  assert.deepEqual(grouped.columns, ['name', 'sum_amount', 'record_count']);
});

test('values repeated from a parent record are never summed or averaged', async () => {
  const erp = fakeErp([{ total: 10, 'customer.balance': 500 }, { total: 20, 'customer.balance': 500 }]);
  erp.ctx.query = async (spec) => ({
    columns: [
      { name: 'total', type: 'money', nullable: false, entity: 'invoices', field: 'total' },
      { name: 'customer.balance', type: 'money', nullable: true, entity: 'customers', field: 'balance', relation: 'customer' },
    ],
    rows: [{ total: 10, 'customer.balance': 500 }, { total: 20, 'customer.balance': 500 }],
    meta: { entity: 'invoices', fetchedAt: 'now', rowCount: 2, offset: 0, limit: 10, truncated: false, quality: { relationMismatches: 0, unresolvedRelations: 0 } },
  });
  const src = await RUNTIME['src.erp'].run({ ...erpConfig, fields: ['total'], related: [{ relation: 'customer', fields: ['balance'] }] }, [], erp.ctx);
  assert.deepEqual(src.meta.repeated, ['customer.balance']);
  await assert.rejects(RUNTIME['out.kpi'].run({ column: 'customer.balance', operation: 'sum' }, [src], noQuery), (e) => e.key === 'wf.err.repeatedValues');
  await assert.rejects(RUNTIME['tf.aggregate'].run({ groupBy: 'total', aggregateColumn: 'customer.balance', operation: 'avg' }, [src], noQuery), (e) => e.key === 'wf.err.repeatedValues');
  assert.equal((await RUNTIME['out.kpi'].run({ column: 'customer.balance', operation: 'max' }, [src], noQuery)).rows[0].value, 500, 'comparing is fine');
  const calc = await RUNTIME['tf.calc'].run({ newColumn: 'twice', formula: '[customer.balance] * 2' }, [src], noQuery);
  assert.ok(calc.meta.repeated.includes('twice'), 'a formula over repeated values repeats too');

  const graph = {
    nodes: [
      node('src', 'src.erp', { ...erpConfig, fields: ['total'], related: [{ relation: 'customer', fields: ['balance'] }] }),
      node('kpi', 'out.kpi', { column: 'customer.balance', operation: 'sum', label: 'x' }),
    ],
    edges: [edge('src', 'kpi')],
  };
  assert.ok(analyzeGraph(graph).issues.some((i) => i.nodeId === 'kpi' && i.key === 'wf.err.repeatedValues'), 'caught before running');
});

test('amounts in different currencies are not added together', async () => {
  const input = invoiceTable([
    { status: 'paid', currency: null, total: 100 }, { status: 'paid', currency: 'USD', total: 10 }, { status: 'unpaid', currency: null, total: 5 },
  ]);
  const out = await RUNTIME['tf.aggregate'].run({ groupBy: 'status', aggregateColumn: 'total', operation: 'sum' }, [input], noQuery);
  assert.deepEqual(out.rows.map((r) => [r.status, r.sum_total]), [['paid', null], ['unpaid', 5]]);
  assert.ok(out.meta.warnings.some((w) => w.key === 'wf.notice.mixedCurrency' && w.vars.count === 1));
  const noCurrency = { ...input, columns: ['status', 'total'] };
  const kpi = await RUNTIME['out.kpi'].run({ column: 'total', operation: 'sum' }, [noCurrency], noQuery);
  assert.ok(kpi.meta.warnings.some((w) => w.key === 'wf.notice.currencyUnchecked'));
});

test('totals over a cut-off source are marked partial', async () => {
  const input = invoiceTable([{ status: 'paid', currency: null, total: 1 }], { truncated: true });
  const kpi = await RUNTIME['out.kpi'].run({ column: 'total', operation: 'sum' }, [input], noQuery);
  assert.equal(kpi.meta.partial, true);
  assert.ok(kpi.meta.warnings.some((w) => w.key === 'wf.notice.partialTotals'));
  const agg = await RUNTIME['tf.aggregate'].run({ groupBy: 'status', aggregateColumn: 'total', operation: 'sum' }, [input], noQuery);
  const again = await RUNTIME['out.kpi'].run({ column: 'sum_total', operation: 'sum' }, [agg], noQuery);
  assert.equal(again.meta.partial, true, 'partial carries through later steps');
});

test('joins refuse keys for different kinds of records and mark fanned-in values', async () => {
  const invoices = table(['id', 'customer_id', 'total'], [{ id: 'i1', customer_id: 'c1', total: 5 }, { id: 'i2', customer_id: 'c1', total: 7 }], {
    columnTypes: { id: 'id', customer_id: 'id', total: 'money' },
    lineage: { id: { entity: 'invoices', field: 'id' }, customer_id: { entity: 'invoices', field: 'customer_id' }, total: { entity: 'invoices', field: 'total' } },
  });
  const customers = table(['id', 'balance'], [{ id: 'c1', balance: 100 }], {
    columnTypes: { id: 'id', balance: 'money' }, lineage: { id: { entity: 'customers', field: 'id' }, balance: { entity: 'customers', field: 'balance' } },
  });
  const products = table(['id'], [{ id: 'c1' }], { columnTypes: { id: 'id' }, lineage: { id: { entity: 'products', field: 'id' } } });
  const joined = await RUNTIME['tf.join'].run({ leftKey: 'customer_id', rightKey: 'id', joinType: 'inner' }, [invoices, customers], noQuery);
  assert.deepEqual(joined.meta.repeated, ['right.id', 'balance'], 'one customer on two invoices');
  await assert.rejects(RUNTIME['out.kpi'].run({ column: 'balance', operation: 'sum' }, [joined], noQuery), (e) => e.key === 'wf.err.repeatedValues');
  assert.equal((await RUNTIME['out.kpi'].run({ column: 'total', operation: 'sum' }, [joined], noQuery)).rows[0].value, 12, 'the invoices\' own totals are fine');
  await assert.rejects(RUNTIME['tf.join'].run({ leftKey: 'customer_id', rightKey: 'id', joinType: 'inner' }, [invoices, products], noQuery), (e) => e.key === 'wf.err.joinKeyMismatch');
  await assert.rejects(RUNTIME['tf.join'].run({ leftKey: 'total', rightKey: 'id', joinType: 'inner' }, [invoices, customers], noQuery), (e) => e.key === 'wf.err.joinKeyMismatch');
});

test('ERP Summary validates before asking the server and describes its rows', async () => {
  const specs = [];
  const ctx = {
    ...noQuery,
    summarize: async (spec) => {
      specs.push(spec);
      return {
        columns: [
          { name: 'status', type: 'enum', role: 'group', entity: 'invoices', field: 'status' },
          { name: 'sum_base_total', type: 'money', role: 'measure', entity: 'invoices', field: 'base_total', op: 'sum' },
          { name: 'record_count', type: 'integer', role: 'measure', entity: 'invoices', op: 'count' },
        ],
        rows: [{ status: 'paid', sum_base_total: 150, record_count: 2 }],
        truncated: false, mixedCurrencyRows: 0, unresolvedRelations: 0, recordCount: 2, fetchedAt: 'now',
      };
    },
  };
  const cfg = { entity: 'invoices', groupBy: [{ field: 'status' }], measures: [{ op: 'sum', field: 'base_total' }] };
  const out = await RUNTIME['src.erpSummary'].run(cfg, [], ctx);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].includeInactive, false, 'voided records are left out unless asked for');
  assert.deepEqual(out.meta.summary, { entity: 'invoices', recordCount: 2 });
  assert.deepEqual(out.meta.lineage.sum_base_total, { entity: 'invoices', field: 'base_total', op: 'sum' });
  await assert.rejects(RUNTIME['src.erpSummary'].run({ ...cfg, measures: [{ op: 'sum', relation: 'customer', field: 'balance' }] }, [], ctx), (e) => e.key === 'sum.err.repeatedMeasure');
  assert.equal(specs.length, 1, 'an invalid summary never reaches the database');
  await assert.rejects(RUNTIME['src.erpSummary'].run(cfg, [], noQuery), (e) => e.key === 'wf.err.summaryUnavailable');
  const schema = analyzeGraph({ nodes: [node('s', 'src.erpSummary', cfg)], edges: [] }).nodes.s.outputs.out;
  assert.deepEqual(schema.map((c) => c.name), ['status', 'sum_base_total', 'record_count']);
});
