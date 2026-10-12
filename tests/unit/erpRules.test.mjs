import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROLE_PERMISSIONS, GRANTABLE_ROLES, WORKSPACE_ROLES, READ_AREAS, PO_TRANSITIONS, SO_TRANSITIONS,
  roleCan, canGrantRole, canTransition, isValidReason, remainingQty,
  invoicePaymentState, invoiceBalance, computeFinancialMetrics,
  normalizeAccessCode, isWellFormedAccessCode,
} from '../../src/app/erp/lib/erpRules.ts';

const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const inventorySql = fs.readFileSync(path.join(migrations, '20260926030000_erp_inventory_fulfillment.sql'), 'utf8');

function latestSqlDefining(name) {
  const files = fs.readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort().reverse();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrations, file), 'utf8');
    if (sql.includes(`FUNCTION public.${name}(`)) return sql;
  }
  assert.fail(`${name} is not defined`);
}

function sqlFunctionBody(sql, name) {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const bodyStart = sql.indexOf('$$', start);
  return sql.slice(bodyStart, sql.indexOf('$$', bodyStart + 2));
}

function sqlRoleTable(name) {
  const body = sqlFunctionBody(latestSqlDefining(name), name);
  const table = {};
  for (const [, role, list] of body.matchAll(/WHEN '(\w+)' THEN ARRAY\[([^\]]*)\]/g)) {
    table[role] = [...list.matchAll(/'([\w.]+)'/g)].map((m) => m[1]).sort();
  }
  const fallback = body.match(/ELSE ARRAY\[([^\]]*)\]/);
  if (fallback) table['*'] = [...fallback[1].matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
  return table;
}

function sqlTransitions(name) {
  const body = sqlFunctionBody(inventorySql, name);
  const table = {};
  for (const [, from, list] of body.matchAll(/\(OLD\.status = '(\w+)' AND NEW\.status IN \(([^)]*)\)\)/g)) {
    table[from] = [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
  }
  return table;
}

test('role permissions match the database definition', () => {
  const sql = sqlRoleTable('erp_role_permissions');
  for (const role of WORKSPACE_ROLES) {
    assert.deepEqual([...ROLE_PERMISSIONS[role]].sort(), sql[role], role);
  }
});

test('read areas match the database definition', () => {
  const sql = sqlRoleTable('erp_read_grants');
  for (const [area, grants] of Object.entries(READ_AREAS)) {
    assert.deepEqual([...grants].sort(), sql[area] ?? sql['*'], area);
  }
  for (const area of Object.keys(sql)) if (area !== '*') assert.ok(area in READ_AREAS, `${area} mirrored`);
});

test('the viewer role is gone and restricted roles cannot read everything', () => {
  assert.equal(WORKSPACE_ROLES.includes('viewer'), false);
  assert.deepEqual(sqlRoleTable('erp_role_permissions').viewer, undefined);
  assert.equal(roleCan('sales', 'read'), false);
  assert.equal(roleCan('inventory', 'read'), false);
});

test('grantable roles match the database definition', () => {
  const sql = sqlRoleTable('erp_grantable_roles');
  for (const role of WORKSPACE_ROLES) {
    assert.deepEqual([...GRANTABLE_ROLES[role]].sort(), sql[role] ?? [], role);
  }
});

test('order status transitions match the database guards', () => {
  const po = sqlTransitions('erp_guard_po_status');
  const so = sqlTransitions('erp_guard_so_status');
  for (const [from, to] of Object.entries(PO_TRANSITIONS)) assert.deepEqual([...to].sort(), po[from] ?? [], `PO ${from}`);
  for (const [from, to] of Object.entries(SO_TRANSITIONS)) assert.deepEqual([...to].sort(), so[from] ?? [], `SO ${from}`);
});

test('no role can grant itself or anything above it', () => {
  assert.equal(canGrantRole('admin', 'admin'), false);
  assert.equal(canGrantRole('admin', 'owner'), false);
  assert.equal(canGrantRole('owner', 'owner'), false);
  assert.equal(canGrantRole('owner', 'admin'), true);
  assert.equal(canGrantRole('finance', 'sales'), false);
  for (const role of WORKSPACE_ROLES) {
    for (const granted of GRANTABLE_ROLES[role]) {
      for (const permission of ROLE_PERMISSIONS[granted]) {
        assert.ok(roleCan(role, permission), `${role} grants ${granted} but lacks ${permission}`);
      }
    }
  }
});

test('permission checks', () => {
  assert.equal(roleCan('finance', 'read'), true);
  assert.equal(roleCan('finance', 'customers'), false);
  assert.equal(roleCan('sales', 'invoicing'), true);
  assert.equal(roleCan('sales', 'payments'), false);
  assert.equal(roleCan('finance', 'payments'), true);
  assert.equal(roleCan('inventory', 'fulfillment'), true);
  assert.equal(roleCan(null, 'read'), false);
});

test('transitions and reasons', () => {
  assert.equal(canTransition(PO_TRANSITIONS, 'pending', 'approved'), true);
  assert.equal(canTransition(PO_TRANSITIONS, 'pending', 'received'), false);
  assert.equal(canTransition(PO_TRANSITIONS, 'received', 'cancelled'), false);
  assert.equal(canTransition(SO_TRANSITIONS, 'invoiced', 'cancelled'), true);
  assert.equal(canTransition(SO_TRANSITIONS, 'cancelled', 'draft'), false);
  assert.equal(isValidReason('  ab '), false);
  assert.equal(isValidReason('Damaged'), true);
});

test('remaining quantities and invoice balances', () => {
  assert.equal(remainingQty(10, 4), 6);
  assert.equal(remainingQty(3, 5), 0);
  assert.equal(invoicePaymentState(100, 0), 'unpaid');
  assert.equal(invoicePaymentState(100, 40), 'partially_paid');
  assert.equal(invoicePaymentState(100, 99.999), 'paid');
  assert.equal(invoicePaymentState(100, 0, 'void'), 'void');
  assert.equal(invoiceBalance(100, 40.1), 59.9);
  assert.equal(invoiceBalance(100, 20, 'void'), 0);
});

test('financial metrics keep cash, receivables, payables, and commitments apart', () => {
  const metrics = computeFinancialMetrics({
    invoices: [
      { id: 'i1', total: 100, status: 'unpaid' },
      { id: 'i2', total: 50, status: 'paid' },
      { id: 'i3', total: 999, status: 'void' },
    ],
    payments: [
      { amount: 30, payment_type: 'incoming', invoice_id: 'i1' },
      { amount: 50, payment_type: 'incoming', invoice_id: 'i2' },
      { amount: 70, payment_type: 'incoming', invoice_id: 'i1', voided_at: '2026-09-01T00:00:00Z' },
      { amount: 10, payment_type: 'incoming' },
      { amount: 40, payment_type: 'outgoing', purchase_order_id: 'po-received' },
      { amount: 25, payment_type: 'outgoing', purchase_order_id: 'po-approved' },
      { amount: 5, payment_type: 'outgoing' },
    ],
    purchaseOrders: [
      // Fully received, partly paid → 60 payable.
      { id: 'po-received', status: 'received', total: 100, items: [{ qty: 10, price: 10, qty_received: 10 }] },
      // Half received: 50 received value, 25 paid → 25 payable; 50 still committed.
      { id: 'po-approved', status: 'approved', total: 100, items: [{ qty: 10, price: 10, qty_received: 5 }] },
      // Legacy received order without qty_received → fully received, unpaid.
      { id: 'po-legacy', status: 'received', total: 30, items: [{ qty: 3, price: 10 }] },
      // Pending and cancelled orders are not commitments.
      { id: 'po-pending', status: 'pending', total: 500, items: [{ qty: 5, price: 100 }] },
      { id: 'po-cancelled', status: 'cancelled', total: 500, items: [{ qty: 5, price: 100 }] },
    ],
    products: [{ current_stock: 4, purchase_price: 2.5 }],
  });

  assert.deepEqual(metrics, {
    cashIn: 90,
    cashOut: 70,
    netCash: 20,
    invoicedRevenue: 150,
    accountsReceivable: 70,
    accountsPayable: 115,
    committedPurchases: 50,
    supplierPrepayments: 0,
    inventoryValue: 10,
    totalRevenue: 90,
    totalExpenses: 70,
    cashBalance: 20,
  });
});

test('approved purchase orders paid in advance show a prepayment, not a payable', () => {
  const metrics = computeFinancialMetrics({
    invoices: [],
    payments: [{ amount: 40, payment_type: 'outgoing', purchase_order_id: 'po' }],
    purchaseOrders: [{ id: 'po', status: 'approved', total: 100, items: [{ qty: 10, price: 10, qty_received: 0 }] }],
    products: [],
  });
  assert.equal(metrics.accountsPayable, 0);
  assert.equal(metrics.committedPurchases, 100);
  assert.equal(metrics.supplierPrepayments, 40);
  assert.equal(metrics.netCash, -40);
});

test('access code normalization mirrors the database', () => {
  assert.equal(normalizeAccessCode('etna-ab1cd-ef2gh-jk3mn-pq4rs'), 'AB1CDEF2GHJK3MNPQ4RS');
  assert.equal(normalizeAccessCode('ETNA-0O0O0-IIL11-00000-00000'), '00000111110000000000');
  assert.equal(isWellFormedAccessCode('ETNA-AB1CD-EF2GH-JK3MN-PQ4RS'), true);
  assert.equal(isWellFormedAccessCode('ETNA-AB1CD-EF2GH-JK3MN-PQ4R'), false);
  assert.equal(isWellFormedAccessCode('ETNA-UUUUU-UUUUU-UUUUU-UUUUU'), false);
});

test('metrics convert foreign-currency documents and include purchase tax and average cost', () => {
  const metrics = computeFinancialMetrics({
    invoices: [{ id: 'usd', total: 100, status: 'unpaid', fx_rate: 16000 }],
    payments: [
      { amount: 40, payment_type: 'incoming', invoice_id: 'usd', fx_rate: 16500 },
      { amount: 111, payment_type: 'outgoing', purchase_order_id: 'po' },
    ],
    // 10 received at 10 net with 11% tax = 111 gross, fully paid.
    purchaseOrders: [{ id: 'po', status: 'received', total: 111, tax_rate: 11, items: [{ qty: 10, price: 10, qty_received: 10 }] }],
    products: [{ current_stock: 3, purchase_price: 5, avg_cost: 7 }],
  });
  assert.equal(metrics.cashIn, 660000, '40 USD at the payment rate');
  assert.equal(metrics.invoicedRevenue, 1600000);
  assert.equal(metrics.accountsReceivable, 960000, '60 USD open at the invoice rate');
  assert.equal(metrics.accountsPayable, 0);
  assert.equal(metrics.supplierPrepayments, 0, 'tax is not mistaken for a prepayment');
  assert.equal(metrics.inventoryValue, 21);
});
