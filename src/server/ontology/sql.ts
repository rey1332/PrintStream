import type { OntologyTypeKey } from '@/lib/ontology/registry';

type Expr = (a: string) => string;

interface TypeSql {
  table: string;
  where?: Expr;
  order: Expr;
  properties: Record<string, Expr>;
}

const date =
  (col: string): Expr =>
  (a) =>
    `to_char(${a}.${col}, 'YYYY-MM-DD')`;
const datetime =
  (col: string): Expr =>
  (a) =>
    `to_char(${a}.${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const col =
  (name: string): Expr =>
  (a) =>
    `${a}.${name}`;
const num =
  (name: string): Expr =>
  (a) =>
    `${a}.${name}::text`;
const eventStatus: Expr = (a) =>
  `CASE WHEN ${a}.is_reversal THEN 'reversal' WHEN ${a}.reversed_by_event_id IS NOT NULL THEN 'reversed' ELSE 'posted' END`;
const eventUnits: Expr = (a) =>
  `(SELECT COALESCE(sum(l.quantity), 0)::text FROM public.erp_fulfillment_event_lines l WHERE l.event_id = ${a}.id)`;

const party = {
  name: col('name'),
  city: col('city'),
  email: col('email'),
};

export const TYPE_SQL: Record<OntologyTypeKey, TypeSql> = {
  supplier: {
    table: 'public.erp_suppliers',
    order: (a) => `${a}.name, ${a}.id`,
    properties: party,
  },
  customer: {
    table: 'public.erp_customers',
    order: (a) => `${a}.name, ${a}.id`,
    properties: party,
  },
  product: {
    table: 'public.erp_products',
    order: (a) => `${a}.name, ${a}.id`,
    properties: {
      name: col('name'),
      sku: col('sku'),
      category: col('category'),
      currentStock: num('current_stock'),
      sellingPrice: num('selling_price'),
    },
  },
  purchaseOrder: {
    table: 'public.erp_purchase_orders',
    order: (a) => `${a}.order_date DESC, ${a}.id`,
    properties: {
      supplierName: col('supplier_name'),
      orderDate: date('order_date'),
      status: (a) => `${a}.status::text`,
      total: num('total'),
      currency: col('currency'),
      unitsOrdered: (a) =>
        `(SELECT COALESCE(sum(i.qty), 0)::text FROM public.erp_purchase_order_items i WHERE i.purchase_order_id = ${a}.id)`,
      unitsReceived: (a) =>
        `(SELECT COALESCE(sum(i.qty_received), 0)::text FROM public.erp_purchase_order_items i WHERE i.purchase_order_id = ${a}.id)`,
    },
  },
  goodsReceipt: {
    table: 'public.erp_fulfillment_events',
    where: (a) => `${a}.kind = 'purchase_receipt'`,
    order: (a) => `${a}.created_at DESC, ${a}.id`,
    properties: {
      supplierName: (a) =>
        `(SELECT o.supplier_name FROM public.erp_purchase_orders o WHERE o.id = ${a}.purchase_order_id)`,
      orderRef: (a) => `${a}.purchase_order_id::text`,
      receivedAt: datetime('created_at'),
      status: eventStatus,
      units: eventUnits,
      note: col('note'),
    },
  },
  salesOrder: {
    table: 'public.erp_sales_orders',
    order: (a) => `${a}.order_date DESC, ${a}.id`,
    properties: {
      customerName: col('customer_name'),
      orderDate: date('order_date'),
      status: (a) => `${a}.status::text`,
      total: num('total'),
      currency: col('currency'),
      unitsOrdered: (a) =>
        `(SELECT COALESCE(sum(i.qty), 0)::text FROM public.erp_sales_order_items i WHERE i.sales_order_id = ${a}.id)`,
      unitsDelivered: (a) =>
        `(SELECT COALESCE(sum(i.qty_delivered), 0)::text FROM public.erp_sales_order_items i WHERE i.sales_order_id = ${a}.id)`,
    },
  },
  delivery: {
    table: 'public.erp_fulfillment_events',
    where: (a) => `${a}.kind = 'sales_delivery'`,
    order: (a) => `${a}.created_at DESC, ${a}.id`,
    properties: {
      customerName: (a) =>
        `(SELECT o.customer_name FROM public.erp_sales_orders o WHERE o.id = ${a}.sales_order_id)`,
      orderRef: (a) => `${a}.sales_order_id::text`,
      deliveredAt: datetime('created_at'),
      status: eventStatus,
      units: eventUnits,
      note: col('note'),
    },
  },
  invoice: {
    table: 'public.erp_invoices',
    order: (a) => `${a}.invoice_date DESC, ${a}.id`,
    properties: {
      customerName: col('customer_name'),
      invoiceDate: date('invoice_date'),
      dueDate: date('due_date'),
      status: (a) => `${a}.status::text`,
      paymentState: col('payment_state'),
      total: num('total'),
      amountPaid: num('amount_paid'),
      currency: col('currency'),
    },
  },
  payment: {
    table: 'public.erp_payments',
    order: (a) => `${a}.payment_date DESC, ${a}.id`,
    properties: {
      party: col('party'),
      paymentDate: date('payment_date'),
      status: (a) =>
        `CASE WHEN ${a}.voided_at IS NOT NULL THEN 'void' ELSE ${a}.payment_type::text END`,
      amount: num('amount'),
      currency: col('currency'),
      method: col('method'),
    },
  },
  cashTransaction: {
    table: 'public.erp_transactions',
    order: (a) => `${a}.transaction_date DESC, ${a}.id`,
    properties: {
      category: col('category'),
      description: col('description'),
      transactionDate: date('transaction_date'),
      status: (a) => `${a}.transaction_type::text`,
      amount: num('amount'),
      isReversal: col('is_reversal'),
    },
  },
  journalEntry: {
    table: 'public.erp_journal_entries',
    order: (a) => `${a}.entry_date DESC, ${a}.entry_no DESC, ${a}.id`,
    properties: {
      memo: col('memo'),
      entryDate: date('entry_date'),
      status: col('source_type'),
      totalDebit: (a) =>
        `(SELECT COALESCE(sum(l.debit), 0)::text FROM public.erp_journal_lines l WHERE l.entry_id = ${a}.id)`,
      entryNo: num('entry_no'),
    },
  },
  glAccount: {
    table: 'public.erp_gl_accounts',
    order: (a) => `${a}.code, ${a}.id`,
    properties: {
      name: col('name'),
      code: col('code'),
      status: col('account_type'),
      isActive: col('is_active'),
    },
  },
  stockMovement: {
    table: 'public.erp_stock_movements',
    order: (a) => `${a}.movement_date DESC, ${a}.id`,
    properties: {
      productName: col('product_name'),
      movementDate: date('movement_date'),
      status: (a) => `${a}.movement_type::text`,
      quantity: num('quantity'),
      note: col('note'),
    },
  },
};

const INVOICE_SOURCES = `('invoice', 'invoice_void', 'invoice_adjust')`;
const PAYMENT_SOURCES = `('payment', 'payment_void', 'payment_adjust')`;
const STOCK_SOURCES = `('stock_adjustment', 'opening_stock')`;

const refFrom =
  (table: string, column: string, extra = ''): Expr =>
  (r) =>
    `${r}.id = (SELECT s.${column} FROM ${table} s WHERE s.id = $1${extra})`;
const referencedBy =
  (column: string, extra = ''): Expr =>
  (r) =>
    `${r}.${column} = $1${extra ? ` AND ${extra.replaceAll('{r}', r)}` : ''}`;
const through =
  (link: string, from: string, to: string): Expr =>
  (r) =>
    `${r}.id IN (SELECT l.${to} FROM ${link} l WHERE l.${from} = $1)`;

export const RELATION_SQL: Record<OntologyTypeKey, Record<string, Expr>> = {
  supplier: {
    purchaseOrders: referencedBy('supplier_id'),
  },
  customer: {
    salesOrders: referencedBy('customer_id'),
    invoices: referencedBy('customer_id'),
  },
  product: {
    purchaseOrders: through('public.erp_purchase_order_items', 'product_id', 'purchase_order_id'),
    goodsReceipts: through('public.erp_fulfillment_event_lines', 'product_id', 'event_id'),
    salesOrders: through('public.erp_sales_order_items', 'product_id', 'sales_order_id'),
    deliveries: through('public.erp_fulfillment_event_lines', 'product_id', 'event_id'),
    stockMovements: referencedBy('product_id'),
  },
  purchaseOrder: {
    supplier: refFrom('public.erp_purchase_orders', 'supplier_id'),
    products: through('public.erp_purchase_order_items', 'purchase_order_id', 'product_id'),
    goodsReceipts: referencedBy('purchase_order_id'),
    payments: referencedBy('purchase_order_id'),
  },
  goodsReceipt: {
    purchaseOrder: refFrom('public.erp_fulfillment_events', 'purchase_order_id'),
    products: through('public.erp_fulfillment_event_lines', 'event_id', 'product_id'),
    reverses: refFrom('public.erp_fulfillment_events', 'reverses_event_id'),
    reversedBy: refFrom('public.erp_fulfillment_events', 'reversed_by_event_id'),
    journalEntries: referencedBy('source_id', `{r}.source_type = 'purchase_receipt'`),
  },
  salesOrder: {
    customer: refFrom('public.erp_sales_orders', 'customer_id'),
    products: through('public.erp_sales_order_items', 'sales_order_id', 'product_id'),
    deliveries: referencedBy('sales_order_id'),
    invoices: referencedBy('sales_order_id'),
  },
  delivery: {
    salesOrder: refFrom('public.erp_fulfillment_events', 'sales_order_id'),
    products: through('public.erp_fulfillment_event_lines', 'event_id', 'product_id'),
    reverses: refFrom('public.erp_fulfillment_events', 'reverses_event_id'),
    reversedBy: refFrom('public.erp_fulfillment_events', 'reversed_by_event_id'),
    journalEntries: referencedBy('source_id', `{r}.source_type = 'sales_delivery'`),
  },
  invoice: {
    customer: refFrom('public.erp_invoices', 'customer_id'),
    salesOrder: refFrom('public.erp_invoices', 'sales_order_id'),
    payments: referencedBy('invoice_id'),
    journalEntries: referencedBy('source_id', `{r}.source_type IN ${INVOICE_SOURCES}`),
  },
  payment: {
    invoice: refFrom('public.erp_payments', 'invoice_id'),
    purchaseOrder: refFrom('public.erp_payments', 'purchase_order_id'),
    cashTransaction: refFrom('public.erp_payments', 'transaction_id'),
    journalEntries: referencedBy('source_id', `{r}.source_type IN ${PAYMENT_SOURCES}`),
  },
  cashTransaction: {
    payment: refFrom('public.erp_transactions', 'source_payment_id'),
    journalEntries: referencedBy('source_id', `{r}.source_type = 'transaction'`),
  },
  journalEntry: {
    accounts: through('public.erp_journal_lines', 'entry_id', 'account_id'),
    sourceInvoice: refFrom(
      'public.erp_journal_entries',
      'source_id',
      ` AND s.source_type IN ${INVOICE_SOURCES}`
    ),
    sourcePayment: refFrom(
      'public.erp_journal_entries',
      'source_id',
      ` AND s.source_type IN ${PAYMENT_SOURCES}`
    ),
    sourceTransaction: refFrom(
      'public.erp_journal_entries',
      'source_id',
      ` AND s.source_type = 'transaction'`
    ),
    sourceReceipt: refFrom(
      'public.erp_journal_entries',
      'source_id',
      ` AND s.source_type = 'purchase_receipt'`
    ),
    sourceDelivery: refFrom(
      'public.erp_journal_entries',
      'source_id',
      ` AND s.source_type = 'sales_delivery'`
    ),
    sourceStockMovement: refFrom(
      'public.erp_journal_entries',
      'source_id',
      ` AND s.source_type IN ${STOCK_SOURCES}`
    ),
    reverses: refFrom('public.erp_journal_entries', 'reverses_entry_id'),
    reversedBy: referencedBy('reverses_entry_id'),
  },
  glAccount: {
    journalEntries: through('public.erp_journal_lines', 'account_id', 'entry_id'),
  },
  stockMovement: {
    product: refFrom('public.erp_stock_movements', 'product_id'),
    journalEntries: referencedBy('source_id', `{r}.source_type IN ${STOCK_SOURCES}`),
  },
};

// ─── Statements ──────────────────────────────────────────────────────────────

export interface Scope {
  column: 'workspace_id' | 'user_id';
  workspaceId: string | null;
}

// The parameter is referenced either way so its type is always known.
const scopeSql = (a: string, scope: Scope, param: string) =>
  scope.workspaceId
    ? `${a}.workspace_id = ${param}::uuid`
    : `(${a}.user_id = auth.uid() AND ${param}::uuid IS NULL)`;

function selectList(type: OntologyTypeKey, a: string): string {
  const props = TYPE_SQL[type].properties;
  return [
    `${a}.id::text AS id`,
    ...Object.entries(props).map(([key, expr]) => `${expr(a)} AS "${key}"`),
  ].join(', ');
}

export interface Built {
  sql: string;
  params: unknown[];
}

export function rowsByIds(type: OntologyTypeKey, ids: string[], scope: Scope): Built {
  const t = TYPE_SQL[type];
  const where = [`t.id = ANY($1::uuid[])`, scopeSql('t', scope, '$2'), t.where?.('t')]
    .filter(Boolean)
    .join(' AND ');
  return {
    sql: `SELECT ${selectList(type, 't')} FROM ${t.table} t WHERE ${where}`,
    params: [ids, scope.workspaceId],
  };
}

export function rowById(type: OntologyTypeKey, id: string, scope: Scope): Built {
  return rowsByIds(type, [id], scope);
}

export function relatedRows(
  source: OntologyTypeKey,
  relation: string,
  target: OntologyTypeKey,
  id: string,
  scope: Scope,
  limit: number,
  countCap: number
): { rows: Built; count: Built } {
  const t = TYPE_SQL[target];
  const rel = RELATION_SQL[source][relation];
  const where = [rel('r'), scopeSql('r', scope, '$2'), t.where?.('r')]
    .filter(Boolean)
    .join(' AND ');
  return {
    rows: {
      sql: `SELECT ${selectList(target, 'r')} FROM ${t.table} r WHERE ${where} ORDER BY ${t.order('r')} LIMIT ${Number(limit)}`,
      params: [id, scope.workspaceId],
    },
    count: {
      sql: `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${t.table} r WHERE ${where} LIMIT ${Number(countCap) + 1}) x`,
      params: [id, scope.workspaceId],
    },
  };
}
