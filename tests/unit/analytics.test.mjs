import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpression, evaluate, ExpressionError } from '../../src/lib/analytics/expression.ts';
import {
  validateQuery, buildSelect, shapeRows, resultColumns, likePattern, operatorsFor, QUERY_LIMITS,
} from '../../src/lib/analytics/query.ts';
import { CATALOG, ENTITY_KEYS, excludedFieldReason, getField } from '../../src/lib/analytics/catalog.ts';
import { joinTables } from '../../src/lib/analytics/join.ts';
import { messages } from '../../src/lib/i18n/messages/index.ts';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// ─── Formulas ─────────────────────────────────────────────────────────────────

test('formulas evaluate arithmetic with precedence, functions and Math.* aliases', () => {
  const run = (src, vars = { a: 6, b: 4 }) => evaluate(parseExpression(src, ['a', 'b']), vars);
  assert.equal(run('a + b * 2'), 14);
  assert.equal(run('(a + b) * 2'), 20);
  assert.equal(run('-a + b'), -2);
  assert.equal(run('a % b'), 2);
  assert.equal(run('max(a, b, 10) - min(a, b)'), 6);
  assert.equal(run('Math.round(a / b)'), 2);
  assert.equal(run('round(a / b * 100) / 100'), 1.5);
  assert.equal(run('1.5e2'), 150);
});

test('formulas never execute code: anything beyond arithmetic is rejected', () => {
  const attacks = [
    'alert(1)', 'constructor', 'a.constructor', 'this', 'globalThis', "'x'", '`x`', 'a; b',
    'fetch("/api")', 'a => a', 'a = 1', '[1]', '{}', 'process.exit()', 'Math.constructor', 'a b',
  ];
  for (const src of attacks) {
    assert.throws(() => parseExpression(src, ['a', 'b']), ExpressionError, src);
  }
  assert.throws(() => parseExpression('c + 1', ['a', 'b']), /unknownName/);
  assert.throws(() => parseExpression('round(a, b)', ['a', 'b']), /arity/);
  assert.throws(() => parseExpression('1+'.repeat(300) + '1', ['a']), /tooLong/);
});

test('division by zero gives an empty value instead of Infinity', () => {
  assert.equal(evaluate(parseExpression('a / b', ['a', 'b']), { a: 1, b: 0 }), null);
});

// ─── Catalog ──────────────────────────────────────────────────────────────────

test('catalog never exposes owner, workspace or acting-user columns', () => {
  for (const key of ENTITY_KEYS) {
    for (const f of CATALOG[key].fields) {
      assert.ok(!['user_id', 'workspace_id', 'created_by', 'cancelled_by', 'voided_by'].includes(f.key), `${key}.${f.key}`);
    }
  }
  assert.equal(excludedFieldReason('invoices', 'workspace_id'), 'owner');
  assert.equal(excludedFieldReason('invoices', 'created_by'), 'actor');
  assert.equal(excludedFieldReason('invoices', 'total'), null);
});

test('every catalog entity, field, relation and type has a label in all languages', () => {
  const need = new Set();
  for (const key of ENTITY_KEYS) {
    need.add(`cat.entity.${key}`).add(`cat.entity.${key}.desc`).add(`cat.module.${CATALOG[key].module}`);
    for (const f of CATALOG[key].fields) {
      need.add(`cat.f.${f.key}`).add(`cat.type.${f.type}`);
      assert.ok(messages[`cat.fd.${key}.${f.key}`] || messages[`cat.fd.${f.key}`], `description for ${key}.${f.key}`);
    }
    for (const r of CATALOG[key].relations) need.add(`cat.rel.${r.key}`);
  }
  for (const k of need) {
    const entry = messages[k];
    assert.ok(entry, `missing ${k}`);
    assert.ok(entry.en && entry.id && entry.zh, `incomplete ${k}`);
  }
});

// ─── Query validation ─────────────────────────────────────────────────────────

test('valid queries are accepted and normalized', () => {
  const r = validateQuery({
    entity: 'invoices',
    fields: ['invoice_date', 'total', 'total', 'balance_due'],
    related: [{ relation: 'customer', fields: ['name', 'city'] }],
    filters: [
      { field: 'invoice_date', op: 'gte', value: '2026-01-01' },
      { field: 'status', op: 'in', value: ['paid', 'overdue'] },
      { field: 'total', op: 'gt', value: '100' },
      { field: 'voided_at', op: 'isNull' },
    ],
    sort: { field: 'invoice_date', direction: 'desc' },
    limit: 200,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec.fields, ['invoice_date', 'total', 'balance_due']);
  assert.equal(r.spec.filters[2].value, 100);
});

test('queries cannot reach unknown entities, internal columns or undeclared relations', () => {
  const codes = (input) => {
    const r = validateQuery(input);
    assert.equal(r.ok, false);
    return r.errors.map((e) => e.code);
  };
  assert.deepEqual(codes({ entity: 'erp_audit_log', fields: ['id'] }), ['unknownEntity']);
  assert.deepEqual(codes({ entity: 'user_profiles', fields: ['id'] }), ['unknownEntity']);
  assert.ok(codes({ entity: 'invoices', fields: ['user_id'] }).includes('unknownField'));
  assert.ok(codes({ entity: 'invoices', fields: ['workspace_id'] }).includes('unknownField'));
  assert.ok(codes({ entity: 'invoices', fields: ['total'], filters: [{ field: 'workspace_id', op: 'eq', value: WS_A }] }).includes('unknownField'));
  // One-to-many links are not relations of the base entity (no fan-out).
  assert.ok(codes({ entity: 'customers', fields: ['name'], related: [{ relation: 'invoices', fields: ['total'] }] }).includes('unknownRelation'));
  assert.ok(codes({ entity: 'salesOrders', fields: ['total'], related: [{ relation: 'customer', fields: ['user_id'] }] }).includes('unknownField'));
  assert.deepEqual(codes({ entity: 'invoices', fields: [] }), ['noFields']);
});

test('filter operators and values must match the field type', () => {
  const firstCode = (filter) => validateQuery({ entity: 'invoices', fields: ['total'], filters: [filter] }).errors?.[0]?.code;
  assert.equal(firstCode({ field: 'total', op: 'contains', value: '1' }), 'invalidOperator');
  assert.equal(firstCode({ field: 'total', op: 'gt', value: 'abc' }), 'invalidValue');
  assert.equal(firstCode({ field: 'invoice_date', op: 'gte', value: '01/02/2026' }), 'invalidValue');
  assert.equal(firstCode({ field: 'status', op: 'eq', value: 'deleted' }), 'invalidValue');
  assert.equal(firstCode({ field: 'id', op: 'eq', value: "1' or '1'='1" }), 'invalidValue');
  assert.equal(firstCode({ field: 'balance_due', op: 'gt', value: 0 }), 'calculatedNotFilterable');
  assert.equal(firstCode({ field: 'status', op: 'in', value: Array(QUERY_LIMITS.maxInValues + 1).fill('paid') }), 'invalidValue');
  assert.equal(firstCode({ field: 'total', op: 'isNull' }), 'invalidOperator'); // total is NOT NULL
  assert.equal(firstCode({ field: 'customer_name', op: 'contains', value: 'x'.repeat(QUERY_LIMITS.maxTextValue + 1) }), 'invalidValue');
  assert.deepEqual(operatorsFor('boolean', false), ['eq']);
});

test('row limits are bounded', () => {
  assert.equal(validateQuery({ entity: 'customers', fields: ['name'], limit: QUERY_LIMITS.maxRows + 1 }).ok, false);
  assert.equal(validateQuery({ entity: 'customers', fields: ['name'], limit: 0 }).ok, false);
  assert.equal(validateQuery({ entity: 'customers', fields: ['name'], offset: -1 }).ok, false);
  assert.equal(validateQuery({ entity: 'customers', fields: ['name'] }).spec.limit, QUERY_LIMITS.defaultRows);
});

test('select reads scope columns and names the exact foreign key for relations', () => {
  const spec = validateQuery({
    entity: 'payments', fields: ['amount'],
    related: [{ relation: 'invoice', fields: ['balance_due'] }, { relation: 'purchaseOrder', fields: ['supplier_name'] }],
  }).spec;
  const select = buildSelect(spec);
  assert.match(select, /^amount,user_id,workspace_id,invoice_id,/);
  assert.match(select, /invoice:erp_invoices!invoice_id\(total,amount_paid,voided_at,user_id,workspace_id\)/);
  assert.match(select, /purchaseOrder:erp_purchase_orders!purchase_order_id\(supplier_name,user_id,workspace_id\)/);
});

test('contains-filters match % and _ literally', () => {
  assert.equal(likePattern('50%_off'), '*50\\%\\_off*');
});

// ─── Result shaping ───────────────────────────────────────────────────────────

test('results drop scope columns, compute balance due and hide cross-workspace links', () => {
  const spec = validateQuery({
    entity: 'invoices', fields: ['total', 'balance_due'],
    related: [{ relation: 'customer', fields: ['name'] }],
  }).spec;
  const raw = [
    { total: 100, amount_paid: 40, voided_at: null, user_id: 'u', workspace_id: WS_A, customer_id: ID_1, customer: { name: 'Ana', user_id: 'u', workspace_id: WS_A } },
    { total: 50, amount_paid: 0, voided_at: '2026-01-01T00:00:00Z', user_id: 'u', workspace_id: WS_A, customer_id: ID_1, customer: { name: 'Eve', user_id: 'x', workspace_id: WS_B } },
    { total: 10, amount_paid: 0, voided_at: null, user_id: 'u', workspace_id: WS_A, customer_id: ID_1, customer: null },
    { total: 10, amount_paid: 0, voided_at: null, user_id: 'u', workspace_id: WS_A, customer_id: null, customer: null },
  ];
  const { rows, quality } = shapeRows(spec, raw);
  assert.deepEqual(rows[0], { total: 100, balance_due: 60, 'customer.name': 'Ana' });
  assert.deepEqual(rows[1], { total: 50, balance_due: 0, 'customer.name': null });
  assert.deepEqual(quality, { relationMismatches: 1, unresolvedRelations: 1 });
  for (const row of rows) {
    assert.ok(!('user_id' in row) && !('workspace_id' in row) && !('customer_id' in row));
  }
  const cols = resultColumns(spec);
  assert.deepEqual(cols.map((c) => [c.name, c.type, c.calculated ?? null]), [
    ['total', 'money', null], ['balance_due', 'money', 'engine'], ['customer.name', 'text', null],
  ]);
  assert.equal(getField('invoices', 'balance_due').calculated, 'engine');
});

// ─── Join node ────────────────────────────────────────────────────────────────

const table = (columns, rows) => ({ columns, rows, meta: { count: rows.length } });

test('join keeps left values when column names clash', () => {
  const invoices = table(['id', 'customer_id', 'total'], [{ id: 'i1', customer_id: 'c1', total: 10 }, { id: 'i2', customer_id: 'c9', total: 5 }]);
  const customers = table(['id', 'name'], [{ id: 'c1', name: 'Ana' }]);
  const out = joinTables(invoices, customers, { leftKey: 'customer_id', rightKey: 'id', joinType: 'left' });
  assert.deepEqual(out.columns, ['id', 'customer_id', 'total', 'right.id', 'name']);
  assert.deepEqual(out.rows[0], { id: 'i1', customer_id: 'c1', total: 10, 'right.id': 'c1', name: 'Ana' });
  assert.deepEqual(out.rows[1], { id: 'i2', customer_id: 'c9', total: 5, 'right.id': null, name: null });
});

test('join refuses duplicate right keys that would inflate totals', () => {
  const orders = table(['id', 'total'], [{ id: 'o1', total: 100 }]);
  const lines = table(['order_id', 'qty'], [{ order_id: 'o1', qty: 1 }, { order_id: 'o1', qty: 2 }]);
  assert.throws(() => joinTables(orders, lines, { leftKey: 'id', rightKey: 'order_id', joinType: 'inner' }), /repeated|berulang|重复/);
});

test('join reports a missing key column', () => {
  assert.throws(() => joinTables(table(['a'], []), table(['b'], []), { leftKey: 'x', rightKey: 'b', joinType: 'inner' }), /"x"/);
});

test('outer join includes unmatched rows from both sides once', () => {
  const l = table(['k', 'v'], [{ k: 1, v: 'l1' }, { k: 2, v: 'l2' }]);
  const r = table(['k', 'w'], [{ k: 2, w: 'r2' }, { k: 3, w: 'r3' }]);
  const out = joinTables(l, r, { leftKey: 'k', rightKey: 'k', joinType: 'outer' });
  assert.deepEqual(out.rows, [
    { k: 1, v: 'l1', w: null }, { k: 2, v: 'l2', w: 'r2' }, { k: 3, v: null, w: 'r3' },
  ]);
});

test('order lines are scoped through their order and never read their own scope columns', async () => {
  const { scopeFilterColumn } = await import('../../src/lib/analytics/query.ts');
  const spec = validateQuery({ entity: 'salesOrderItems', fields: ['qty', 'subtotal'], related: [{ relation: 'product', fields: ['name'] }] }).spec;
  const select = buildSelect(spec);
  assert.match(select, /scope:erp_sales_orders!sales_order_id!inner\(user_id,workspace_id\)/);
  assert.doesNotMatch(select.split('scope:')[0], /user_id|workspace_id/);
  assert.equal(scopeFilterColumn('salesOrderItems', 'workspace_id'), 'scope.workspace_id');
  assert.equal(scopeFilterColumn('invoices', 'workspace_id'), 'workspace_id');
  const { rows, quality } = shapeRows(spec, [
    { qty: 2, subtotal: 20, product_id: ID_1, scope: { user_id: 'u', workspace_id: WS_A }, product: { name: 'Pen', user_id: 'u', workspace_id: WS_A } },
    { qty: 1, subtotal: 5, product_id: ID_1, scope: { user_id: 'u', workspace_id: WS_A }, product: { name: 'Other', user_id: 'x', workspace_id: WS_B } },
  ]);
  assert.deepEqual(rows, [{ qty: 2, subtotal: 20, 'product.name': 'Pen' }, { qty: 1, subtotal: 5, 'product.name': null }]);
  assert.equal(quality.relationMismatches, 1);
});

test('CSV cells neutralise spreadsheet formulas and quote when needed', async () => {
  const { csvCell } = await import('../../src/lib/csv.ts');
  assert.equal(csvCell('=HYPERLINK("http://x","click")'), `"'=HYPERLINK(""http://x"",""click"")"`);
  assert.equal(csvCell('+1-555'), "'+1-555");
  assert.equal(csvCell('-cmd'), "'-cmd");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(-42.5), '-42.5', 'numbers stay numbers');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
  assert.equal(csvCell('plain'), 'plain');
});
