import type { ReadArea, WorkspaceRole } from '@/app/erp/lib/erpRules';

export const ONTOLOGY_TYPES = [
  'supplier',
  'customer',
  'product',
  'purchaseOrder',
  'goodsReceipt',
  'salesOrder',
  'delivery',
  'invoice',
  'payment',
  'cashTransaction',
  'journalEntry',
  'glAccount',
  'stockMovement',
] as const;
export type OntologyTypeKey = (typeof ONTOLOGY_TYPES)[number];

export type OntologyModule =
  | 'masterData'
  | 'purchasing'
  | 'sales'
  | 'inventory'
  | 'finance'
  | 'accounting';

export type PropertyFormat =
  | 'text'
  | 'money'
  | 'number'
  | 'date'
  | 'datetime'
  | 'status'
  | 'boolean'
  | 'ref';

export interface OntologyProperty {
  key: string;
  format: PropertyFormat;
  documentCurrency?: boolean;
  refType?: OntologyTypeKey;
}

export type RelationKind = 'reference' | 'referencedBy' | 'through';

export interface OntologyRelation {
  key: string;
  target: OntologyTypeKey;
  kind: RelationKind;
  cardinality: 'one' | 'many';
}

export interface OntologyType {
  key: OntologyTypeKey;
  module: OntologyModule;
  table: string;
  area: ReadArea;
  reference:
    | { style: 'idPrefix'; prefix: string }
    | { style: 'entryNo'; prefix: string }
    | { style: 'code' };
  properties: readonly OntologyProperty[];
  title: string;
  summary: readonly string[];
  date?: string;
  status?: { property: string; values: readonly string[] };
  amount?: string;
  searchFields: readonly string[];
  page: { path: string; query: readonly { param: string; from: string }[] };
  relations: readonly OntologyRelation[];
}

const idRef = (prefix: string) => ({ style: 'idPrefix' as const, prefix });

export const ONTOLOGY: Record<OntologyTypeKey, OntologyType> = {
  supplier: {
    key: 'supplier',
    module: 'masterData',
    table: 'erp_suppliers',
    area: 'suppliers',
    reference: idRef('SUP'),
    properties: [
      { key: 'name', format: 'text' },
      { key: 'city', format: 'text' },
      { key: 'email', format: 'text' },
    ],
    title: 'name',
    summary: ['city', 'email'],
    searchFields: ['name', 'email', 'phone', 'city', 'address'],
    page: { path: '/erp/suppliers', query: [{ param: 'focus', from: 'id' }] },
    relations: [
      { key: 'purchaseOrders', target: 'purchaseOrder', kind: 'referencedBy', cardinality: 'many' },
    ],
  },
  customer: {
    key: 'customer',
    module: 'masterData',
    table: 'erp_customers',
    area: 'customers',
    reference: idRef('CUS'),
    properties: [
      { key: 'name', format: 'text' },
      { key: 'city', format: 'text' },
      { key: 'email', format: 'text' },
    ],
    title: 'name',
    summary: ['city', 'email'],
    searchFields: ['name', 'email', 'phone', 'city', 'address'],
    page: { path: '/erp/customers', query: [{ param: 'focus', from: 'id' }] },
    relations: [
      { key: 'salesOrders', target: 'salesOrder', kind: 'referencedBy', cardinality: 'many' },
      { key: 'invoices', target: 'invoice', kind: 'referencedBy', cardinality: 'many' },
    ],
  },
  product: {
    key: 'product',
    module: 'inventory',
    table: 'erp_products',
    area: 'products',
    reference: idRef('PRD'),
    properties: [
      { key: 'name', format: 'text' },
      { key: 'sku', format: 'text' },
      { key: 'category', format: 'text' },
      { key: 'currentStock', format: 'number' },
      { key: 'sellingPrice', format: 'money' },
    ],
    title: 'name',
    summary: ['sku', 'category', 'currentStock'],
    amount: 'sellingPrice',
    searchFields: ['name', 'sku', 'category'],
    page: { path: '/erp/products', query: [{ param: 'focus', from: 'id' }] },
    relations: [
      { key: 'purchaseOrders', target: 'purchaseOrder', kind: 'through', cardinality: 'many' },
      { key: 'goodsReceipts', target: 'goodsReceipt', kind: 'through', cardinality: 'many' },
      { key: 'salesOrders', target: 'salesOrder', kind: 'through', cardinality: 'many' },
      { key: 'deliveries', target: 'delivery', kind: 'through', cardinality: 'many' },
      { key: 'stockMovements', target: 'stockMovement', kind: 'referencedBy', cardinality: 'many' },
    ],
  },
  purchaseOrder: {
    key: 'purchaseOrder',
    module: 'purchasing',
    table: 'erp_purchase_orders',
    area: 'purchase_orders',
    reference: idRef('PO'),
    properties: [
      { key: 'supplierName', format: 'text' },
      { key: 'orderDate', format: 'date' },
      { key: 'status', format: 'status' },
      { key: 'total', format: 'money', documentCurrency: true },
      { key: 'currency', format: 'text' },
      { key: 'unitsOrdered', format: 'number' },
      { key: 'unitsReceived', format: 'number' },
    ],
    title: 'supplierName',
    summary: ['unitsReceived', 'unitsOrdered'],
    date: 'orderDate',
    amount: 'total',
    status: { property: 'status', values: ['pending', 'approved', 'received', 'cancelled'] },
    searchFields: ['supplier', 'notes', 'cancel reason', 'reference'],
    page: { path: '/erp/purchase-orders', query: [{ param: 'focus', from: 'id' }] },
    relations: [
      { key: 'supplier', target: 'supplier', kind: 'reference', cardinality: 'one' },
      { key: 'products', target: 'product', kind: 'through', cardinality: 'many' },
      { key: 'goodsReceipts', target: 'goodsReceipt', kind: 'referencedBy', cardinality: 'many' },
      { key: 'payments', target: 'payment', kind: 'referencedBy', cardinality: 'many' },
    ],
  },
  goodsReceipt: {
    key: 'goodsReceipt',
    module: 'purchasing',
    table: 'erp_fulfillment_events',
    area: 'purchase_orders',
    reference: idRef('GR'),
    properties: [
      { key: 'supplierName', format: 'text' },
      { key: 'orderRef', format: 'ref', refType: 'purchaseOrder' },
      { key: 'receivedAt', format: 'datetime' },
      { key: 'status', format: 'status' },
      { key: 'units', format: 'number' },
      { key: 'note', format: 'text' },
    ],
    title: 'supplierName',
    summary: ['orderRef', 'units', 'note'],
    date: 'receivedAt',
    status: { property: 'status', values: ['posted', 'reversed', 'reversal'] },
    searchFields: ['note', 'reason', 'purchase order supplier', 'reference'],
    page: { path: '/erp/purchase-orders', query: [{ param: 'focus', from: 'orderRef' }] },
    relations: [
      { key: 'purchaseOrder', target: 'purchaseOrder', kind: 'reference', cardinality: 'one' },
      { key: 'products', target: 'product', kind: 'through', cardinality: 'many' },
      { key: 'reverses', target: 'goodsReceipt', kind: 'reference', cardinality: 'one' },
      { key: 'reversedBy', target: 'goodsReceipt', kind: 'reference', cardinality: 'one' },
      { key: 'journalEntries', target: 'journalEntry', kind: 'referencedBy', cardinality: 'many' },
    ],
  },
  salesOrder: {
    key: 'salesOrder',
    module: 'sales',
    table: 'erp_sales_orders',
    area: 'sales_orders',
    reference: idRef('SO'),
    properties: [
      { key: 'customerName', format: 'text' },
      { key: 'orderDate', format: 'date' },
      { key: 'status', format: 'status' },
      { key: 'total', format: 'money', documentCurrency: true },
      { key: 'currency', format: 'text' },
      { key: 'unitsOrdered', format: 'number' },
      { key: 'unitsDelivered', format: 'number' },
    ],
    title: 'customerName',
    summary: ['unitsDelivered', 'unitsOrdered'],
    date: 'orderDate',
    amount: 'total',
    status: { property: 'status', values: ['draft', 'invoiced', 'delivered', 'cancelled'] },
    searchFields: ['customer', 'notes', 'cancel reason', 'reference'],
    page: { path: '/erp/sales-orders', query: [{ param: 'focus', from: 'id' }] },
    relations: [
      { key: 'customer', target: 'customer', kind: 'reference', cardinality: 'one' },
      { key: 'products', target: 'product', kind: 'through', cardinality: 'many' },
      { key: 'deliveries', target: 'delivery', kind: 'referencedBy', cardinality: 'many' },
      { key: 'invoices', target: 'invoice', kind: 'referencedBy', cardinality: 'many' },
    ],
  },
  delivery: {
    key: 'delivery',
    module: 'sales',
    table: 'erp_fulfillment_events',
    area: 'sales_orders',
    reference: idRef('DN'),
    properties: [
      { key: 'customerName', format: 'text' },
      { key: 'orderRef', format: 'ref', refType: 'salesOrder' },
      { key: 'deliveredAt', format: 'datetime' },
      { key: 'status', format: 'status' },
      { key: 'units', format: 'number' },
      { key: 'note', format: 'text' },
    ],
    title: 'customerName',
    summary: ['orderRef', 'units', 'note'],
    date: 'deliveredAt',
    status: { property: 'status', values: ['posted', 'reversed', 'reversal'] },
    searchFields: ['note', 'reason', 'sales order customer', 'reference'],
    page: { path: '/erp/sales-orders', query: [{ param: 'focus', from: 'orderRef' }] },
    relations: [
      { key: 'salesOrder', target: 'salesOrder', kind: 'reference', cardinality: 'one' },
      { key: 'products', target: 'product', kind: 'through', cardinality: 'many' },
      { key: 'reverses', target: 'delivery', kind: 'reference', cardinality: 'one' },
      { key: 'reversedBy', target: 'delivery', kind: 'reference', cardinality: 'one' },
      { key: 'journalEntries', target: 'journalEntry', kind: 'referencedBy', cardinality: 'many' },
    ],
  },
  invoice: {
    key: 'invoice',
    module: 'finance',
    table: 'erp_invoices',
    area: 'invoices',
    reference: idRef('INV'),
    properties: [
      { key: 'customerName', format: 'text' },
      { key: 'invoiceDate', format: 'date' },
      { key: 'dueDate', format: 'date' },
      { key: 'status', format: 'status' },
      { key: 'paymentState', format: 'status' },
      { key: 'total', format: 'money', documentCurrency: true },
      { key: 'amountPaid', format: 'money', documentCurrency: true },
      { key: 'currency', format: 'text' },
    ],
    title: 'customerName',
    summary: ['paymentState', 'dueDate'],
    date: 'invoiceDate',
    amount: 'total',
    status: { property: 'status', values: ['unpaid', 'paid', 'overdue', 'void'] },
    searchFields: ['customer', 'void reason', 'reference', 'sales order reference'],
    page: { path: '/erp/invoices', query: [{ param: 'focus', from: 'id' }] },
    relations: [
      { key: 'customer', target: 'customer', kind: 'reference', cardinality: 'one' },
      { key: 'salesOrder', target: 'salesOrder', kind: 'reference', cardinality: 'one' },
      { key: 'payments', target: 'payment', kind: 'referencedBy', cardinality: 'many' },
      { key: 'journalEntries', target: 'journalEntry', kind: 'referencedBy', cardinality: 'many' },
    ],
  },
  payment: {
    key: 'payment',
    module: 'finance',
    table: 'erp_payments',
    area: 'payments',
    reference: idRef('PAY'),
    properties: [
      { key: 'party', format: 'text' },
      { key: 'paymentDate', format: 'date' },
      { key: 'status', format: 'status' },
      { key: 'amount', format: 'money', documentCurrency: true },
      { key: 'currency', format: 'text' },
      { key: 'method', format: 'text' },
    ],
    title: 'party',
    summary: ['method'],
    date: 'paymentDate',
    amount: 'amount',
    status: { property: 'status', values: ['incoming', 'outgoing', 'void'] },
    searchFields: [
      'party',
      'method',
      'note',
      'void reason',
      'reference',
      'invoice or purchase order reference',
    ],
    page: { path: '/erp/payments', query: [{ param: 'focus', from: 'id' }] },
    relations: [
      { key: 'invoice', target: 'invoice', kind: 'reference', cardinality: 'one' },
      { key: 'purchaseOrder', target: 'purchaseOrder', kind: 'reference', cardinality: 'one' },
      { key: 'cashTransaction', target: 'cashTransaction', kind: 'reference', cardinality: 'one' },
      { key: 'journalEntries', target: 'journalEntry', kind: 'referencedBy', cardinality: 'many' },
    ],
  },
  cashTransaction: {
    key: 'cashTransaction',
    module: 'finance',
    table: 'erp_transactions',
    area: 'books',
    reference: idRef('TRX'),
    properties: [
      { key: 'category', format: 'text' },
      { key: 'description', format: 'text' },
      { key: 'transactionDate', format: 'date' },
      { key: 'status', format: 'status' },
      { key: 'amount', format: 'money' },
      { key: 'isReversal', format: 'boolean' },
    ],
    title: 'category',
    summary: ['description'],
    date: 'transactionDate',
    amount: 'amount',
    status: { property: 'status', values: ['income', 'expense'] },
    searchFields: ['category', 'description', 'reference'],
    page: { path: '/erp/cash-flow', query: [{ param: 'focus', from: 'id' }] },
    relations: [
      { key: 'payment', target: 'payment', kind: 'reference', cardinality: 'one' },
      { key: 'journalEntries', target: 'journalEntry', kind: 'referencedBy', cardinality: 'many' },
    ],
  },
  journalEntry: {
    key: 'journalEntry',
    module: 'accounting',
    table: 'erp_journal_entries',
    area: 'books',
    reference: { style: 'entryNo', prefix: 'JE' },
    properties: [
      { key: 'memo', format: 'text' },
      { key: 'entryDate', format: 'date' },
      { key: 'status', format: 'status' },
      { key: 'totalDebit', format: 'money' },
      { key: 'entryNo', format: 'number' },
    ],
    title: 'memo',
    summary: ['status'],
    date: 'entryDate',
    amount: 'totalDebit',
    status: {
      property: 'status',
      values: [
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
      ],
    },
    searchFields: ['memo', 'entry number', 'source document reference'],
    // The journal is paged on the server: open it on the entry's date.
    page: {
      path: '/erp/accounting',
      query: [
        { param: 'entry', from: 'id' },
        { param: 'date', from: 'entryDate' },
      ],
    },
    relations: [
      { key: 'accounts', target: 'glAccount', kind: 'through', cardinality: 'many' },
      { key: 'sourceInvoice', target: 'invoice', kind: 'reference', cardinality: 'one' },
      { key: 'sourcePayment', target: 'payment', kind: 'reference', cardinality: 'one' },
      {
        key: 'sourceTransaction',
        target: 'cashTransaction',
        kind: 'reference',
        cardinality: 'one',
      },
      { key: 'sourceReceipt', target: 'goodsReceipt', kind: 'reference', cardinality: 'one' },
      { key: 'sourceDelivery', target: 'delivery', kind: 'reference', cardinality: 'one' },
      {
        key: 'sourceStockMovement',
        target: 'stockMovement',
        kind: 'reference',
        cardinality: 'one',
      },
      { key: 'reverses', target: 'journalEntry', kind: 'reference', cardinality: 'one' },
      { key: 'reversedBy', target: 'journalEntry', kind: 'referencedBy', cardinality: 'one' },
    ],
  },
  glAccount: {
    key: 'glAccount',
    module: 'accounting',
    table: 'erp_gl_accounts',
    area: 'books',
    reference: { style: 'code' },
    properties: [
      { key: 'name', format: 'text' },
      { key: 'code', format: 'text' },
      { key: 'status', format: 'status' },
      { key: 'isActive', format: 'boolean' },
    ],
    title: 'name',
    summary: ['code', 'status'],
    status: { property: 'status', values: ['asset', 'liability', 'equity', 'income', 'expense'] },
    searchFields: ['code', 'name'],
    // Opens the journal filtered to the account.
    page: { path: '/erp/accounting', query: [{ param: 'account', from: 'id' }] },
    relations: [
      { key: 'journalEntries', target: 'journalEntry', kind: 'through', cardinality: 'many' },
    ],
  },
  stockMovement: {
    key: 'stockMovement',
    module: 'inventory',
    table: 'erp_stock_movements',
    area: 'stock',
    reference: idRef('MOV'),
    properties: [
      { key: 'productName', format: 'text' },
      { key: 'movementDate', format: 'date' },
      { key: 'status', format: 'status' },
      { key: 'quantity', format: 'number' },
      { key: 'note', format: 'text' },
    ],
    title: 'productName',
    summary: ['quantity', 'note'],
    date: 'movementDate',
    status: { property: 'status', values: ['in', 'out'] },
    searchFields: ['product', 'note', 'product reference'],
    page: { path: '/erp/inventory', query: [{ param: 'focus', from: 'id' }] },
    relations: [
      { key: 'product', target: 'product', kind: 'reference', cardinality: 'one' },
      { key: 'journalEntries', target: 'journalEntry', kind: 'referencedBy', cardinality: 'many' },
    ],
  },
};

export function isOntologyType(value: unknown): value is OntologyTypeKey {
  return typeof value === 'string' && (ONTOLOGY_TYPES as readonly string[]).includes(value);
}

export function getRelation(type: OntologyTypeKey, key: string): OntologyRelation | undefined {
  return ONTOLOGY[type].relations.find((r) => r.key === key);
}

// ─── References ──────────────────────────────────────────────────────────────

export function recordReference(
  type: OntologyTypeKey,
  id: string,
  row?: { entryNo?: unknown; code?: unknown }
): string {
  const ref = ONTOLOGY[type].reference;
  if (ref.style === 'entryNo')
    return row?.entryNo != null ? `${ref.prefix}-${row.entryNo}` : ref.prefix;
  if (ref.style === 'code') return String(row?.code ?? '');
  return `${ref.prefix}-${id.slice(0, 8).toUpperCase()}`;
}

export function recordHref(
  type: OntologyTypeKey,
  id: string,
  row?: Record<string, unknown>
): string {
  const page = ONTOLOGY[type].page;
  const params = new URLSearchParams();
  for (const { param, from } of page.query) {
    const value = from === 'id' ? id : row?.[from];
    if (typeof value === 'string' && value) params.set(param, value);
  }
  const query = params.toString();
  return query ? `${page.path}?${query}` : page.path;
}

export const ROLE_SEARCH_PRESETS: Record<WorkspaceRole, readonly OntologyTypeKey[]> = {
  owner: ONTOLOGY_TYPES,
  admin: ONTOLOGY_TYPES,
  finance: [
    'invoice',
    'payment',
    'cashTransaction',
    'journalEntry',
    'glAccount',
    'customer',
    'supplier',
  ],
  // ETNA has no separate purchasing role: purchasing and receiving belong to Inventory.
  inventory: ['supplier', 'purchaseOrder', 'goodsReceipt', 'product', 'stockMovement'],
  sales: ['customer', 'salesOrder', 'delivery', 'invoice', 'product'],
};

export const MODULE_ORDER: readonly OntologyModule[] = [
  'masterData',
  'purchasing',
  'sales',
  'inventory',
  'finance',
  'accounting',
];
