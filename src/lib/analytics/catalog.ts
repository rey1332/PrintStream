import type { Permission } from '@/app/erp/lib/erpRules';
import { UNIT_CODES } from '@/lib/units';

export type FieldType =
  | 'id'
  | 'text'
  | 'integer'
  | 'number'
  | 'money'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'boolean';

export type ErpModule =
  | 'masterData'
  | 'sales'
  | 'purchasing'
  | 'inventory'
  | 'finance'
  | 'accounting';

export interface CatalogField {
  key: string;
  type: FieldType;
  nullable: boolean;
  calculated?: 'database' | 'engine';
  enumValues?: readonly string[];
  references?: EntityKey;
  currency?: 'document' | 'base';
}

export interface CatalogRelation {
  key: string;
  target: EntityKey;
  column: string;
}

export interface CatalogEntity {
  key: EntityKey;
  table: string;
  module: ErpModule;
  permission: Permission;
  fields: readonly CatalogField[];
  relations: readonly CatalogRelation[];
  dateField?: string;
  scopeVia?: string;
  defaultSort: { field: string; direction: 'asc' | 'desc' };
  inactive?: { status?: string; column?: string };
}

export const ENTITY_KEYS = [
  'customers',
  'suppliers',
  'products',
  'salesOrders',
  'salesOrderItems',
  'purchaseOrders',
  'purchaseOrderItems',
  'invoices',
  'payments',
  'transactions',
  'stockMovements',
  'glAccounts',
  'journalEntries',
  'journalLines',
] as const;
export type EntityKey = (typeof ENTITY_KEYS)[number];

const SO_STATUS = ['draft', 'invoiced', 'delivered', 'cancelled'] as const;
const PO_STATUS = ['pending', 'approved', 'received', 'cancelled'] as const;
const INVOICE_STATUS = ['paid', 'unpaid', 'overdue', 'void'] as const;
const PAYMENT_STATE = ['unpaid', 'partially_paid', 'paid', 'void'] as const;
const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
const JOURNAL_SOURCES = [
  'invoice',
  'invoice_void',
  'invoice_adjust',
  'payment',
  'payment_void',
  'payment_adjust',
  'transaction',
  'purchase_receipt',
  'sales_delivery',
  'stock_adjustment',
  'opening_stock',
  'manual',
  'manual_reversal',
  'fx_settlement',
  'payroll',
  'payroll_reversal',
  'weigh_ticket',
  'weigh_ticket_cancel',
  'production',
  'production_reversal',
  'fuel_issue',
  'fuel_issue_reversal',
] as const;

const id: CatalogField = { key: 'id', type: 'id', nullable: false };
const createdAt: CatalogField = { key: 'created_at', type: 'datetime', nullable: true };
const updatedAt: CatalogField = { key: 'updated_at', type: 'datetime', nullable: true };

const partyFields: CatalogField[] = [
  id,
  { key: 'name', type: 'text', nullable: false },
  { key: 'email', type: 'text', nullable: false },
  { key: 'phone', type: 'text', nullable: false },
  { key: 'address', type: 'text', nullable: false },
  { key: 'city', type: 'text', nullable: false },
  { key: 'balance', type: 'money', nullable: false },
  createdAt,
  updatedAt,
];

const FX_SOURCES = ['manual', 'rate_table', 'document'] as const;

const orderItemFields = (
  orderKey: 'sales_order_id' | 'purchase_order_id',
  orderEntity: EntityKey,
  qtyDone: string
): CatalogField[] => [
  id,
  { key: orderKey, type: 'id', nullable: false, references: orderEntity },
  { key: 'product_id', type: 'id', nullable: true, references: 'products' },
  { key: 'product_name', type: 'text', nullable: false },
  { key: 'qty', type: 'number', nullable: false },
  { key: 'unit', type: 'enum', nullable: false, enumValues: UNIT_CODES },
  // In the order's currency (orders can be in a foreign currency).
  { key: 'price', type: 'money', nullable: false, currency: 'document' },
  { key: 'subtotal', type: 'money', nullable: true, calculated: 'database', currency: 'document' },
  { key: qtyDone, type: 'number', nullable: false },
];

export const CATALOG: Record<EntityKey, CatalogEntity> = {
  customers: {
    key: 'customers',
    table: 'erp_customers',
    module: 'masterData',
    permission: 'read',
    // Credit limit: weighbridge module (20261012000024).
    fields: [...partyFields, { key: 'credit_limit', type: 'money', nullable: true }],
    relations: [],
    defaultSort: { field: 'name', direction: 'asc' },
  },
  suppliers: {
    key: 'suppliers',
    table: 'erp_suppliers',
    module: 'masterData',
    permission: 'read',
    fields: partyFields,
    relations: [],
    defaultSort: { field: 'name', direction: 'asc' },
  },
  products: {
    key: 'products',
    table: 'erp_products',
    module: 'inventory',
    permission: 'read',
    fields: [
      id,
      { key: 'name', type: 'text', nullable: false },
      { key: 'sku', type: 'text', nullable: false },
      { key: 'category', type: 'text', nullable: false },
      { key: 'purchase_price', type: 'money', nullable: false },
      { key: 'selling_price', type: 'money', nullable: false },
      { key: 'current_stock', type: 'number', nullable: false },
      { key: 'min_stock', type: 'number', nullable: false },
      { key: 'max_stock', type: 'number', nullable: false },
      { key: 'unit', type: 'enum', nullable: false, enumValues: UNIT_CODES },
      { key: 'density', type: 'number', nullable: true },
      { key: 'avg_cost', type: 'money', nullable: false },
      createdAt,
      updatedAt,
    ],
    relations: [],
    defaultSort: { field: 'name', direction: 'asc' },
  },
  salesOrders: {
    key: 'salesOrders',
    table: 'erp_sales_orders',
    module: 'sales',
    permission: 'read',
    fields: [
      id,
      { key: 'doc_no', type: 'text', nullable: true },
      { key: 'customer_id', type: 'id', nullable: true, references: 'customers' },
      { key: 'customer_name', type: 'text', nullable: false },
      { key: 'order_date', type: 'date', nullable: false },
      { key: 'status', type: 'enum', nullable: false, enumValues: SO_STATUS },
      { key: 'total', type: 'money', nullable: false, currency: 'document' },
      { key: 'currency', type: 'text', nullable: true },
      { key: 'fx_rate', type: 'number', nullable: false },
      { key: 'fx_rate_date', type: 'date', nullable: true },
      { key: 'fx_rate_source', type: 'enum', nullable: true, enumValues: FX_SOURCES },
      {
        key: 'base_total',
        type: 'money',
        nullable: true,
        calculated: 'database',
        currency: 'base',
      },
      { key: 'notes', type: 'text', nullable: false },
      createdAt,
      updatedAt,
      { key: 'cancelled_at', type: 'datetime', nullable: true },
      { key: 'cancel_reason', type: 'text', nullable: false },
    ],
    relations: [{ key: 'customer', target: 'customers', column: 'customer_id' }],
    dateField: 'order_date',
    defaultSort: { field: 'order_date', direction: 'desc' },
    inactive: { status: 'cancelled', column: 'cancelled_at' },
  },
  salesOrderItems: {
    key: 'salesOrderItems',
    table: 'erp_sales_order_items',
    module: 'sales',
    permission: 'read',
    fields: orderItemFields('sales_order_id', 'salesOrders', 'qty_delivered'),
    scopeVia: 'order',
    relations: [
      { key: 'order', target: 'salesOrders', column: 'sales_order_id' },
      { key: 'product', target: 'products', column: 'product_id' },
    ],
    defaultSort: { field: 'product_name', direction: 'asc' },
  },
  purchaseOrders: {
    key: 'purchaseOrders',
    table: 'erp_purchase_orders',
    module: 'purchasing',
    permission: 'read',
    fields: [
      id,
      { key: 'doc_no', type: 'text', nullable: true },
      { key: 'supplier_id', type: 'id', nullable: true, references: 'suppliers' },
      { key: 'supplier_name', type: 'text', nullable: false },
      { key: 'order_date', type: 'date', nullable: false },
      { key: 'status', type: 'enum', nullable: false, enumValues: PO_STATUS },
      { key: 'total', type: 'money', nullable: false, currency: 'document' },
      { key: 'tax_rate', type: 'number', nullable: false },
      { key: 'tax_amount', type: 'money', nullable: false, currency: 'document' },
      { key: 'currency', type: 'text', nullable: true },
      { key: 'fx_rate', type: 'number', nullable: false },
      { key: 'fx_rate_date', type: 'date', nullable: true },
      { key: 'fx_rate_source', type: 'enum', nullable: true, enumValues: FX_SOURCES },
      {
        key: 'base_total',
        type: 'money',
        nullable: true,
        calculated: 'database',
        currency: 'base',
      },
      { key: 'notes', type: 'text', nullable: false },
      createdAt,
      updatedAt,
      { key: 'cancelled_at', type: 'datetime', nullable: true },
      { key: 'cancel_reason', type: 'text', nullable: false },
    ],
    relations: [{ key: 'supplier', target: 'suppliers', column: 'supplier_id' }],
    dateField: 'order_date',
    defaultSort: { field: 'order_date', direction: 'desc' },
    inactive: { status: 'cancelled', column: 'cancelled_at' },
  },
  purchaseOrderItems: {
    key: 'purchaseOrderItems',
    table: 'erp_purchase_order_items',
    module: 'purchasing',
    permission: 'read',
    fields: orderItemFields('purchase_order_id', 'purchaseOrders', 'qty_received'),
    scopeVia: 'order',
    relations: [
      { key: 'order', target: 'purchaseOrders', column: 'purchase_order_id' },
      { key: 'product', target: 'products', column: 'product_id' },
    ],
    defaultSort: { field: 'product_name', direction: 'asc' },
  },
  invoices: {
    key: 'invoices',
    table: 'erp_invoices',
    module: 'finance',
    permission: 'read',
    fields: [
      id,
      { key: 'doc_no', type: 'text', nullable: true },
      { key: 'customer_id', type: 'id', nullable: true, references: 'customers' },
      { key: 'sales_order_id', type: 'id', nullable: true, references: 'salesOrders' },
      { key: 'customer_name', type: 'text', nullable: false },
      { key: 'invoice_date', type: 'date', nullable: false },
      { key: 'due_date', type: 'date', nullable: false },
      { key: 'status', type: 'enum', nullable: false, enumValues: INVOICE_STATUS },
      { key: 'payment_state', type: 'enum', nullable: false, enumValues: PAYMENT_STATE },
      { key: 'total', type: 'money', nullable: false, currency: 'document' },
      { key: 'tax_rate', type: 'number', nullable: false },
      { key: 'tax_amount', type: 'money', nullable: false, currency: 'document' },
      { key: 'amount_paid', type: 'money', nullable: false, currency: 'document' },
      {
        key: 'balance_due',
        type: 'money',
        nullable: false,
        calculated: 'engine',
        currency: 'document',
      },
      { key: 'currency', type: 'text', nullable: true },
      { key: 'fx_rate', type: 'number', nullable: false },
      { key: 'fx_rate_date', type: 'date', nullable: true },
      { key: 'fx_rate_source', type: 'enum', nullable: true, enumValues: FX_SOURCES },
      {
        key: 'base_total',
        type: 'money',
        nullable: true,
        calculated: 'database',
        currency: 'base',
      },
      createdAt,
      updatedAt,
      { key: 'voided_at', type: 'datetime', nullable: true },
      { key: 'void_reason', type: 'text', nullable: false },
    ],
    relations: [
      { key: 'customer', target: 'customers', column: 'customer_id' },
      { key: 'salesOrder', target: 'salesOrders', column: 'sales_order_id' },
    ],
    dateField: 'invoice_date',
    defaultSort: { field: 'invoice_date', direction: 'desc' },
    inactive: { status: 'void', column: 'voided_at' },
  },
  payments: {
    key: 'payments',
    table: 'erp_payments',
    module: 'finance',
    permission: 'read',
    fields: [
      id,
      { key: 'doc_no', type: 'text', nullable: true },
      { key: 'payment_type', type: 'enum', nullable: false, enumValues: ['incoming', 'outgoing'] },
      { key: 'party', type: 'text', nullable: false },
      { key: 'amount', type: 'money', nullable: false, currency: 'document' },
      { key: 'payment_date', type: 'date', nullable: false },
      { key: 'method', type: 'text', nullable: false },
      { key: 'note', type: 'text', nullable: false },
      { key: 'invoice_id', type: 'id', nullable: true, references: 'invoices' },
      { key: 'purchase_order_id', type: 'id', nullable: true, references: 'purchaseOrders' },
      { key: 'currency', type: 'text', nullable: true },
      { key: 'fx_rate', type: 'number', nullable: false },
      { key: 'fx_rate_date', type: 'date', nullable: true },
      { key: 'fx_rate_source', type: 'enum', nullable: true, enumValues: FX_SOURCES },
      {
        key: 'base_amount',
        type: 'money',
        nullable: true,
        calculated: 'database',
        currency: 'base',
      },
      createdAt,
      { key: 'voided_at', type: 'datetime', nullable: true },
      { key: 'void_reason', type: 'text', nullable: false },
    ],
    relations: [
      { key: 'invoice', target: 'invoices', column: 'invoice_id' },
      { key: 'purchaseOrder', target: 'purchaseOrders', column: 'purchase_order_id' },
    ],
    dateField: 'payment_date',
    defaultSort: { field: 'payment_date', direction: 'desc' },
    inactive: { column: 'voided_at' },
  },
  transactions: {
    key: 'transactions',
    table: 'erp_transactions',
    module: 'finance',
    permission: 'read',
    fields: [
      id,
      { key: 'transaction_type', type: 'enum', nullable: false, enumValues: ['income', 'expense'] },
      { key: 'category', type: 'text', nullable: false },
      { key: 'amount', type: 'money', nullable: false },
      { key: 'transaction_date', type: 'date', nullable: false },
      { key: 'description', type: 'text', nullable: false },
      { key: 'is_reversal', type: 'boolean', nullable: false },
      createdAt,
    ],
    relations: [],
    dateField: 'transaction_date',
    defaultSort: { field: 'transaction_date', direction: 'desc' },
  },
  stockMovements: {
    key: 'stockMovements',
    table: 'erp_stock_movements',
    module: 'inventory',
    permission: 'read',
    fields: [
      id,
      { key: 'product_id', type: 'id', nullable: true, references: 'products' },
      { key: 'product_name', type: 'text', nullable: false },
      { key: 'movement_type', type: 'enum', nullable: false, enumValues: ['in', 'out'] },
      { key: 'quantity', type: 'number', nullable: false },
      { key: 'movement_date', type: 'date', nullable: false },
      { key: 'note', type: 'text', nullable: false },
      { key: 'source_type', type: 'text', nullable: true },
      createdAt,
    ],
    relations: [{ key: 'product', target: 'products', column: 'product_id' }],
    dateField: 'movement_date',
    defaultSort: { field: 'movement_date', direction: 'desc' },
  },
  glAccounts: {
    key: 'glAccounts',
    table: 'erp_gl_accounts',
    module: 'accounting',
    permission: 'read',
    fields: [
      id,
      { key: 'code', type: 'text', nullable: false },
      { key: 'name', type: 'text', nullable: false },
      { key: 'account_type', type: 'enum', nullable: false, enumValues: ACCOUNT_TYPES },
      { key: 'is_active', type: 'boolean', nullable: false },
      { key: 'created_at', type: 'datetime', nullable: false },
    ],
    relations: [],
    defaultSort: { field: 'code', direction: 'asc' },
  },
  journalEntries: {
    key: 'journalEntries',
    table: 'erp_journal_entries',
    module: 'accounting',
    permission: 'read',
    fields: [
      id,
      { key: 'entry_no', type: 'integer', nullable: false },
      { key: 'entry_date', type: 'date', nullable: false },
      { key: 'memo', type: 'text', nullable: false },
      { key: 'source_type', type: 'enum', nullable: false, enumValues: JOURNAL_SOURCES },
      { key: 'reverses_entry_id', type: 'id', nullable: true, references: 'journalEntries' },
      { key: 'created_at', type: 'datetime', nullable: false },
    ],
    relations: [],
    dateField: 'entry_date',
    defaultSort: { field: 'entry_date', direction: 'desc' },
  },
  journalLines: {
    key: 'journalLines',
    table: 'erp_journal_lines',
    module: 'accounting',
    permission: 'read',
    fields: [
      id,
      { key: 'entry_id', type: 'id', nullable: false, references: 'journalEntries' },
      { key: 'account_id', type: 'id', nullable: false, references: 'glAccounts' },
      { key: 'debit', type: 'money', nullable: false, currency: 'base' },
      { key: 'credit', type: 'money', nullable: false, currency: 'base' },
      { key: 'memo', type: 'text', nullable: false },
    ],
    scopeVia: 'entry',
    relations: [
      { key: 'entry', target: 'journalEntries', column: 'entry_id' },
      { key: 'account', target: 'glAccounts', column: 'account_id' },
    ],
    defaultSort: { field: 'debit', direction: 'desc' },
  },
};

const INTERNAL_COLUMNS: Record<string, 'owner' | 'actor' | 'link'> = {
  user_id: 'owner',
  workspace_id: 'owner',
  created_by: 'actor',
  cancelled_by: 'actor',
  voided_by: 'actor',
  transaction_id: 'link',
  reversal_transaction_id: 'link',
  source_payment_id: 'link',
  source_id: 'link',
  source_key: 'link',
  system_key: 'link',
  fx_rate_id: 'link',
};

export function excludedFieldReason(
  entity: EntityKey,
  column: string
): 'owner' | 'actor' | 'link' | 'unknown' | null {
  if (CATALOG[entity].fields.some((f) => f.key === column)) return null;
  return INTERNAL_COLUMNS[column] ?? 'unknown';
}

export function isEntityKey(value: unknown): value is EntityKey {
  return typeof value === 'string' && (ENTITY_KEYS as readonly string[]).includes(value);
}

export function getField(entity: EntityKey, key: string): CatalogField | undefined {
  return CATALOG[entity].fields.find((f) => f.key === key);
}

export function getRelation(entity: EntityKey, key: string): CatalogRelation | undefined {
  return CATALOG[entity].relations.find((r) => r.key === key);
}

export function relatedFieldName(relation: string, field: string): string {
  return `${relation}.${field}`;
}

export function incomingRelations(
  entity: EntityKey
): { from: EntityKey; relation: CatalogRelation }[] {
  return ENTITY_KEYS.flatMap((from) =>
    CATALOG[from].relations
      .filter((r) => r.target === entity)
      .map((relation) => ({ from, relation }))
  );
}

export const NUMERIC_TYPES: readonly FieldType[] = ['integer', 'number', 'money'];
export const isNumericType = (type: FieldType) => NUMERIC_TYPES.includes(type);
