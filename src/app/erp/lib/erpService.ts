'use client';

import { createClient } from '@/lib/data/client';
import { containsPattern } from '@/lib/db/pattern';
import {
  computeFinancialMetrics,
  invoiceBalance,
  invoicePaymentState,
  type FinancialMetrics,
  type InvoicePaymentState,
} from './erpRules';
import { WORKSPACES_ENABLED, readScope, rpcWorkspaceId, writeOwner } from './workspace';
import { tr, translateServerMessage } from '@/lib/i18n/translate';
import { isUnit, roundQty, type UnitCode } from '@/lib/units';

interface DbError {
  code?: string;
  message?: string;
}

function logError(operation: string, error: DbError | null | undefined) {
  // Keep database error details out of production browser logs.
  if (process.env.NODE_ENV === 'development') {
    console.error(`[ERP ${operation}]`, error?.message || error);
  }
}

function safeERPError(operation: string, error: DbError | null | undefined): Error {
  logError(operation, error);
  if (error?.code === '42501' || error?.code === 'PGRST301') {
    return new Error(tr('erp.error.permission'));
  }
  if (error?.code === '23503') {
    return new Error(tr('erp.error.missingReference'));
  }
  if (error?.code === 'P0001' && typeof error?.message === 'string') {
    return new Error(translateServerMessage(error.message));
  }
  if (error?.code === 'PGRST202' || error?.code === '42883') {
    return new Error(tr('erp.error.needsUpdate'));
  }
  return new Error(tr('erp.error.generic'));
}

type Db = ReturnType<typeof createClient>;

export const PAGE_SIZE = 1000;
export const MAX_LIST_ROWS = 100_000;

export async function fetchAll<T = any>(make: () => any, label: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < MAX_LIST_ROWS; from += PAGE_SIZE) {
    const { data, error } = await make().range(from, from + PAGE_SIZE - 1);
    if (error) throw safeERPError(label, error);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
  throw new Error(tr('erp.error.tooManyRows', { max: MAX_LIST_ROWS }));
}

export interface PageQuery {
  offset: number;
  limit: number;
  search: string;
  onlyId?: string | null;
}

export interface PageResult<T> {
  rows: T[];
  total: number;
}

export type InvoiceFilter = 'all' | 'open' | 'partially_paid' | 'overdue' | 'paid' | 'void';

export async function listSummary(
  kind: 'invoices' | 'payments' | 'sales_orders' | 'purchase_orders'
): Promise<Record<string, any>> {
  const { data, error } = await createClient().rpc('erp_list_summary', {
    p_workspace_id: rpcWorkspaceId(),
    p_kind: kind,
  });
  if (error) throw safeERPError(`load ${kind} summary`, error);
  return (data ?? {}) as Record<string, any>;
}

export async function inventorySummary(): Promise<{
  products: number;
  stockValue: number;
  reorderCount: number;
  movements: number;
}> {
  const { data, error } = await createClient().rpc('erp_inventory_summary', {
    p_workspace_id: rpcWorkspaceId(),
  });
  if (error) throw safeERPError('load inventory summary', error);
  const r = (data ?? {}) as Record<string, number | string>;
  return {
    products: Number(r.products ?? 0),
    stockValue: Number(r.stock_value ?? 0),
    reorderCount: Number(r.reorder_count ?? 0),
    movements: Number(r.movements ?? 0),
  };
}

export async function cashFlowSummary(): Promise<{
  income: number;
  expense: number;
  payments: number;
  transactions: number;
  monthly: { month: string; income: number; expense: number }[];
}> {
  const { data, error } = await createClient().rpc('erp_cash_flow_summary', {
    p_workspace_id: rpcWorkspaceId(),
  });
  if (error) throw safeERPError('load cash flow', error);
  const r = (data ?? {}) as Record<string, any>;
  return {
    income: Number(r.income ?? 0),
    expense: Number(r.expense ?? 0),
    payments: Number(r.payments ?? 0),
    transactions: Number(r.transactions ?? 0),
    monthly: ((r.monthly ?? []) as { month: string; income: number; expense: number }[]).map(
      (m) => ({ month: m.month, income: Number(m.income), expense: Number(m.expense) })
    ),
  };
}

export async function fetchPage<T>(
  make: () => any,
  q: PageQuery,
  searchColumns: string[],
  label: string,
  map: (row: any) => T
): Promise<PageResult<T>> {
  let query = make();
  if (q.onlyId) query = query.eq('id', q.onlyId);
  else if (q.search.trim())
    query = query.anyOf(
      searchColumns.map((column) => ({
        column,
        op: 'ilike' as const,
        value: containsPattern(q.search),
      }))
    );
  const { data, error, count } = await query.range(q.offset, q.offset + q.limit - 1);
  if (error) throw safeERPError(label, error);
  return { rows: ((data ?? []) as unknown[]).map(map), total: count ?? 0 };
}

export const PICK_LIMIT = 20;

async function pickRows<T>(
  make: () => any,
  text: string,
  searchColumns: string[],
  label: string,
  map: (row: any) => T
): Promise<T[]> {
  const page = await fetchPage(
    () => make().order('name').order('id'),
    { offset: 0, limit: PICK_LIMIT, search: text },
    searchColumns,
    label,
    map
  );
  return page.rows;
}

function scoped<Q extends { eq: (column: string, value: string) => Q }>(
  query: Q,
  userId: string
): Q {
  const scope = readScope(userId);
  return query.eq(scope.column, scope.value);
}

// ─── Customers ────────────────────────────────────────────────────────────────

async function getCustomerWriteUserId(db: Db, expectedUserId: string) {
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) {
    throw new Error(tr('erp.error.sessionInactive'));
  }
  if (data.user.id !== expectedUserId) {
    throw new Error(tr('erp.error.sessionChanged'));
  }
  return data.user.id;
}

function customerWriteError(
  error: DbError | null | undefined,
  action: 'create' | 'update' | 'import'
) {
  if (error?.code === '42501') {
    return new Error(tr(WORKSPACES_ENABLED ? 'erp.error.customerRole' : 'erp.error.customerRls'));
  }
  if (error?.code === '23503') {
    return new Error(tr('erp.error.noProfile'));
  }
  return safeERPError(
    `${action === 'create' ? 'create' : action === 'update' ? 'update' : 'import'} customer`,
    error
  );
}

function mapParty(r: any) {
  return {
    id: r.id as string,
    name: r.name as string,
    email: r.email as string,
    phone: r.phone as string,
    address: r.address as string,
    city: r.city as string,
    // Customers only (weighbridge module, 20261012000024); null = no limit.
    creditLimit:
      r.credit_limit === null || r.credit_limit === undefined ? null : Number(r.credit_limit),
    createdAt: r.created_at as string,
  };
}

function mapProduct(r: any) {
  return {
    id: r.id as string,
    name: r.name as string,
    sku: r.sku as string,
    category: r.category as string,
    purchasePrice: Number(r.purchase_price),
    sellingPrice: Number(r.selling_price),
    currentStock: Number(r.current_stock),
    minStock: Number(r.min_stock),
    maxStock: Number(r.max_stock),
    unit: (isUnit(r.unit) ? r.unit : 'pcs') as UnitCode,
    density: r.density === null || r.density === undefined ? null : Number(r.density),
  };
}

export const customerService = {
  async getAll(userId: string) {
    const db = createClient();
    const data = await fetchAll(
      () =>
        scoped(db.from('erp_customers').select('*'), userId)
          .order('created_at', { ascending: false })
          .order('id'),
      'load customers'
    );
    return data.map(mapParty);
  },
  page(userId: string, q: PageQuery) {
    const db = createClient();
    return fetchPage(
      () =>
        scoped(db.from('erp_customers').select('*', { count: 'exact' }), userId)
          .order('created_at', { ascending: false })
          .order('id'),
      q,
      ['name', 'email', 'phone', 'city'],
      'load customers',
      mapParty
    );
  },
  pick(userId: string, text: string) {
    const db = createClient();
    return pickRows(
      () => scoped(db.from('erp_customers').select('*'), userId),
      text,
      ['name', 'email', 'phone'],
      'search customers',
      mapParty
    );
  },
  async allIds(userId: string): Promise<string[]> {
    const db = createClient();
    const rows = await fetchAll<{ id: string }>(
      () => scoped(db.from('erp_customers').select('id'), userId).order('id'),
      'load customers'
    );
    return rows.map((r) => r.id);
  },
  async upsert(userId: string, record: any) {
    const db = createClient();
    const authenticatedUserId = await getCustomerWriteUserId(db, userId);
    const scope = readScope(authenticatedUserId);
    const payload = {
      ...writeOwner(authenticatedUserId),
      name: record.name,
      email: record.email,
      phone: record.phone,
      address: record.address,
      city: record.city,
      ...(record.creditLimit !== undefined ? { credit_limit: record.creditLimit } : {}),
    };
    if (record.id) {
      const { data, error } = await db
        .from('erp_customers')
        .update(payload)
        .eq('id', record.id)
        .eq(scope.column, scope.value)
        .select()
        .single();
      if (error) {
        logError('upsert customer', error);
        if (error.code === '42501' || error.code === '23503')
          throw customerWriteError(error, 'update');
        throw safeERPError('update customer', error);
      }
      return data;
    }
    const { data, error } = await db.from('erp_customers').insert(payload).select().single();
    if (error) {
      logError('create customer', error);
      if (error.code === '42501' || error.code === '23503')
        throw customerWriteError(error, 'create');
      throw safeERPError('create customer', error);
    }
    return data;
  },
  async remove(userId: string, id: string) {
    const db = createClient();
    const { error } = await scoped(db.from('erp_customers').delete().eq('id', id), userId);
    if (error) {
      logError('delete customer', error);
      throw safeERPError('delete customer', error);
    }
  },
  async bulkInsert(userId: string, records: any[]) {
    const db = createClient();
    const authenticatedUserId = await getCustomerWriteUserId(db, userId);
    const owner = writeOwner(authenticatedUserId);
    const payload = records.map((r) => ({
      ...owner,
      name: r.name,
      email: r.email,
      phone: r.phone,
      address: r.address,
      city: r.city,
    }));
    const { data, error } = await db.from('erp_customers').insert(payload).select();
    if (error) {
      logError('bulkInsert customers', error);
      if (error.code === '42501' || error.code === '23503')
        throw customerWriteError(error, 'import');
      return { data: [], error };
    }
    return { data: data || [], error: null };
  },
};

export const supplierService = {
  async getAll(userId: string) {
    const db = createClient();
    const data = await fetchAll(
      () =>
        scoped(db.from('erp_suppliers').select('*'), userId)
          .order('created_at', { ascending: false })
          .order('id'),
      'load suppliers'
    );
    return data.map(mapParty);
  },
  page(userId: string, q: PageQuery) {
    const db = createClient();
    return fetchPage(
      () =>
        scoped(db.from('erp_suppliers').select('*', { count: 'exact' }), userId)
          .order('created_at', { ascending: false })
          .order('id'),
      q,
      ['name', 'email', 'phone', 'city'],
      'load suppliers',
      mapParty
    );
  },
  pick(userId: string, text: string) {
    const db = createClient();
    return pickRows(
      () => scoped(db.from('erp_suppliers').select('*'), userId),
      text,
      ['name', 'email', 'phone'],
      'search suppliers',
      mapParty
    );
  },
  async allIds(userId: string): Promise<string[]> {
    const db = createClient();
    const rows = await fetchAll<{ id: string }>(
      () => scoped(db.from('erp_suppliers').select('id'), userId).order('id'),
      'load suppliers'
    );
    return rows.map((r) => r.id);
  },
  async upsert(userId: string, record: any) {
    const db = createClient();
    const payload = {
      ...writeOwner(userId),
      name: record.name,
      email: record.email,
      phone: record.phone,
      address: record.address,
      city: record.city,
    };
    if (record.id) {
      const { data, error } = await scoped(
        db.from('erp_suppliers').update(payload).eq('id', record.id),
        userId
      )
        .select()
        .single();
      if (error) throw safeERPError('update supplier', error);
      return data;
    }
    const { data, error } = await db.from('erp_suppliers').insert(payload).select().single();
    if (error) throw safeERPError('create supplier', error);
    return data;
  },
  async remove(userId: string, id: string) {
    const db = createClient();
    const { error } = await scoped(db.from('erp_suppliers').delete().eq('id', id), userId);
    if (error) throw safeERPError('delete supplier', error);
  },
  async bulkInsert(userId: string, records: any[]) {
    const db = createClient();
    const owner = writeOwner(userId);
    const payload = records.map((r) => ({
      ...owner,
      name: r.name,
      email: r.email,
      phone: r.phone,
      address: r.address,
      city: r.city,
    }));
    const { data, error } = await db.from('erp_suppliers').insert(payload).select();
    if (error) {
      logError('import suppliers', error);
      return { data: [], error };
    }
    return { data: data || [], error: null };
  },
};

export interface PartyBalance {
  /** Open invoices (customers) or unpaid approved orders (suppliers), base currency. */
  outstanding: number;
  overdue: number;
  openDocuments: number;
}

/** Balances calculated from the documents (erp_party_balances), by id. */
export async function partyBalances(
  kind: 'customers' | 'suppliers',
  ids: string[]
): Promise<Record<string, PartyBalance>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};
  const { data, error } = await createClient().rpc('erp_party_balances', {
    p_workspace_id: rpcWorkspaceId(),
    p_kind: kind,
    p_ids: unique,
  });
  if (error) throw safeERPError('load balances', error);
  const map: Record<string, PartyBalance> = {};
  for (const row of (data as any[]) ?? []) {
    map[row.party_id] = {
      outstanding: Number(row.outstanding),
      overdue: Number(row.overdue),
      openDocuments: Number(row.open_documents),
    };
  }
  return map;
}

export const productService = {
  async getAll(userId: string) {
    const db = createClient();
    const data = await fetchAll(
      () =>
        scoped(db.from('erp_products').select('*'), userId)
          .order('created_at', { ascending: false })
          .order('id'),
      'load products'
    );
    return data.map(mapProduct);
  },
  page(userId: string, q: PageQuery) {
    const db = createClient();
    return fetchPage(
      () =>
        scoped(db.from('erp_products').select('*', { count: 'exact' }), userId)
          .order('created_at', { ascending: false })
          .order('id'),
      q,
      ['name', 'sku', 'category'],
      'load products',
      mapProduct
    );
  },
  pick(userId: string, text: string, opts: { inStock?: boolean } = {}) {
    const db = createClient();
    return pickRows(
      () => {
        const query = scoped(db.from('erp_products').select('*'), userId);
        return opts.inStock ? query.gt('current_stock', 0) : query;
      },
      text,
      ['name', 'sku', 'category'],
      'search products',
      mapProduct
    );
  },
  async availabilityOf(
    ids: string[]
  ): Promise<Record<string, { onHand: number; reserved: number; available: number }>> {
    const map: Record<string, { onHand: number; reserved: number; available: number }> = {};
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return map;
    const { data, error } = await createClient()
      .from('erp_product_availability')
      .select('product_id, on_hand, reserved, available')
      .in('product_id', unique);
    if (error) throw safeERPError('load availability', error);
    for (const row of data ?? []) {
      map[row.product_id] = {
        onHand: Number(row.on_hand),
        reserved: Number(row.reserved),
        available: Number(row.available),
      };
    }
    return map;
  },
  async allIds(userId: string): Promise<string[]> {
    const db = createClient();
    const rows = await fetchAll<{ id: string }>(
      () => scoped(db.from('erp_products').select('id'), userId).order('id'),
      'load products'
    );
    return rows.map((r) => r.id);
  },
  async upsert(userId: string, record: any) {
    const db = createClient();
    const payload = {
      ...writeOwner(userId),
      name: record.name,
      sku: record.sku,
      category: record.category,
      purchase_price: record.purchasePrice,
      selling_price: record.sellingPrice,
      current_stock: record.currentStock,
      min_stock: record.minStock,
      max_stock: record.maxStock,
      unit: isUnit(record.unit) ? record.unit : 'pcs',
      density: record.density && record.density > 0 ? record.density : null,
    };
    if (record.id) {
      const { data, error } = await scoped(
        db.from('erp_products').update(payload).eq('id', record.id),
        userId
      )
        .select()
        .single();
      if (error) throw safeERPError('update product', error);
      return data;
    }
    const { data, error } = await db.from('erp_products').insert(payload).select().single();
    if (error) throw safeERPError('create product', error);
    return data;
  },
  async remove(userId: string, id: string) {
    const db = createClient();
    const { error } = await scoped(db.from('erp_products').delete().eq('id', id), userId);
    if (error) throw safeERPError('delete product', error);
  },
  async bulkInsert(userId: string, records: any[]) {
    const db = createClient();
    const owner = writeOwner(userId);
    const payload = records.map((r) => ({
      ...owner,
      name: r.name,
      sku: r.sku,
      category: r.category,
      purchase_price: r.purchasePrice,
      selling_price: r.sellingPrice,
      current_stock: r.currentStock,
      min_stock: r.minStock,
      max_stock: r.maxStock,
      unit: isUnit(r.unit) ? r.unit : 'pcs',
      density: r.density && r.density > 0 ? r.density : null,
    }));
    const { data, error } = await db.from('erp_products').insert(payload).select();
    if (error) {
      logError('import products', error);
      return { data: [], error };
    }
    return { data: data || [], error: null };
  },
};

// ─── Fulfillment events (receipts / deliveries) ──────────────────────────────

export interface FulfillmentLineInput {
  itemId: string;
  qty: number;
}

export interface FulfillmentEvent {
  id: string;
  /** SJ/2026/0001 for a delivery, GR/2026/0001 for a receipt. */
  docNo: string | null;
  kind: 'purchase_receipt' | 'sales_delivery';
  createdAt: string;
  note: string;
  reason: string;
  isReversal: boolean;
  reversedByEventId: string | null;
  lines: { productName: string; quantity: number }[];
}

function toLinesPayload(lines: FulfillmentLineInput[]) {
  return lines.filter((l) => l.qty > 0).map((l) => ({ item_id: l.itemId, qty: roundQty(l.qty) }));
}

// ─── Inventory ────────────────────────────────────────────────────────────────

function mapStock(r: any) {
  return {
    id: r.id as string,
    name: r.name as string,
    sku: (r.sku as string) ?? '',
    currentStock: Number(r.current_stock),
    minStock: Number(r.min_stock),
    maxStock: Number(r.max_stock),
    reserved: Number(r.reserved),
    available: Number(r.available),
    stockValue: Number(r.stock_value),
    suggestedQty: Number(r.suggested_qty),
    unit: (isUnit(r.unit) ? r.unit : 'pcs') as UnitCode,
  };
}

export type StockRow = ReturnType<typeof mapStock>;

function mapMovement(r: any) {
  return {
    id: r.id as string,
    productId: r.product_id as string | null,
    productName: r.product_name as string,
    type: r.movement_type as 'in' | 'out',
    quantity: Number(r.quantity),
    date: r.movement_date as string,
    note: (r.note as string) ?? '',
  };
}

export const inventoryService = {
  page(userId: string, q: PageQuery, opts: { reorderOnly?: boolean } = {}) {
    const db = createClient();
    return fetchPage(
      () => {
        let query = scoped(db.from('erp_inventory_stock').select('*', { count: 'exact' }), userId);
        if (opts.reorderOnly) query = query.eq('needs_reorder', true);
        return query.order('name').order('id');
      },
      q,
      ['name', 'sku', 'category'],
      'load stock',
      mapStock
    );
  },
  movements(userId: string, q: PageQuery) {
    const db = createClient();
    return fetchPage(
      () =>
        scoped(db.from('erp_stock_movements').select('*', { count: 'exact' }), userId)
          .order('created_at', { ascending: false })
          .order('id'),
      q,
      ['product_name', 'note'],
      'load stock movements',
      mapMovement
    );
  },
};

export const fulfillmentService = {
  async getEvents(kind: 'purchase' | 'sales', orderId: string): Promise<FulfillmentEvent[]> {
    const db = createClient();
    const { data, error } = await db
      .from('erp_fulfillment_events')
      .select('*, lines:erp_fulfillment_event_lines(product_name, quantity)')
      .eq(kind === 'purchase' ? 'purchase_order_id' : 'sales_order_id', orderId)
      .order('created_at', { ascending: true });
    if (error) throw safeERPError('load receipts and deliveries', error);
    return (data || []).map((e: any) => ({
      id: e.id,
      docNo: (e.doc_no as string | null) ?? null,
      kind: e.kind,
      createdAt: e.created_at,
      note: e.note || '',
      reason: e.reason || '',
      isReversal: !!e.is_reversal,
      reversedByEventId: e.reversed_by_event_id || null,
      lines: (e.lines || []).map((l: any) => ({
        productName: l.product_name,
        quantity: Number(l.quantity),
      })),
    }));
  },
  async reverse(eventId: string, reason: string, requestId: string) {
    const db = createClient();
    const { error } = await db.rpc('erp_reverse_fulfillment_event', {
      p_event_id: eventId,
      p_reason: reason,
      p_request_id: requestId,
    });
    if (error) throw safeERPError('reverse this event', error);
  },
};

// ─── Purchase Orders ──────────────────────────────────────────────────────────

function mapPurchaseOrder(r: any) {
  return {
    id: r.id,
    docNo: (r.doc_no as string | null) ?? null,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    date: r.order_date,
    status: r.status,
    total: Number(r.total),
    notes: r.notes,
    taxAmount: Number(r.tax_amount ?? 0),
    taxRate: Number(r.tax_rate ?? 0),
    currency: (r.currency as string | null) ?? null,
    fxRate: Number(r.fx_rate ?? 1) || 1,
    baseTotal: r.base_total != null ? Number(r.base_total) : Number(r.total),
    fxRateDate: (r.fx_rate_date as string | null) ?? null,
    fxRateSource: (r.fx_rate_source as string | null) ?? null,
    approvalStatus: r.approval?.[0]?.status || null,
    cancelReason: r.cancel_reason || '',
    items: (r.items || []).map((i: any) => ({
      id: i.id,
      productId: i.product_id,
      productName: i.product_name,
      qty: Number(i.qty),
      unit: (isUnit(i.unit) ? i.unit : 'pcs') as UnitCode,
      price: Number(i.price),
      qtyReceived: Number(i.qty_received ?? (r.status === 'received' ? i.qty : 0)),
    })),
  };
}

export const purchaseOrderService = {
  page(userId: string, q: PageQuery) {
    const db = createClient();
    return fetchPage(
      () =>
        scoped(
          db
            .from('erp_purchase_orders')
            .select(
              '*, items:erp_purchase_order_items(*), approval:erp_approval_requests(status)',
              { count: 'exact' }
            ),
          userId
        )
          .order('created_at', { ascending: false })
          .order('id'),
      q,
      ['supplier_name', 'doc_no', 'notes'],
      'load purchase orders',
      mapPurchaseOrder
    );
  },
  async getAll(userId: string) {
    const db = createClient();
    const data = await fetchAll(
      () =>
        scoped(
          db
            .from('erp_purchase_orders')
            .select('*, items:erp_purchase_order_items(*), approval:erp_approval_requests(status)'),
          userId
        )
          .order('created_at', { ascending: false })
          .order('id'),
      'load purchase orders'
    );
    return data.map(mapPurchaseOrder);
  },
  async create(userId: string, record: any) {
    const db = createClient();
    const args = {
      p_supplier_id: record.supplierId || null,
      p_supplier_name: record.supplierName || '',
      p_order_date: record.date || null,
      p_notes: record.notes || '',
      p_items: (record.items || []).map((item: any) => ({
        product_id: item.productId || null,
        product_name: item.productName || '',
        qty: roundQty(Number(item.qty)),
        price: item.price,
        unit: isUnit(item.unit) ? item.unit : 'pcs',
      })),
    };
    // No currency = the base currency; a foreign one uses the rate entered or stored.
    const { data, error } = await db.rpc('erp_create_purchase_order_v3', {
      p_workspace_id: rpcWorkspaceId(),
      ...args,
      p_currency: record.currency || null,
      p_fx_rate: record.currency ? (record.fxRate ?? null) : null,
    });
    if (error) throw safeERPError('create purchase order', error);
    return { id: data };
  },
  async updateStatus(userId: string, id: string, status: string) {
    const db = createClient();
    void userId;
    const { error } = await db.rpc('erp_update_purchase_order_status', {
      p_purchase_order_id: id,
      p_status: status,
    });
    if (error) throw safeERPError('update purchase order', error);
  },
  async recordReceipt(
    id: string,
    lines: FulfillmentLineInput[],
    requestId: string,
    note = '',
    fxRate: number | null = null
  ) {
    const db = createClient();
    // Without an entered rate, the stored rate for the receipt date is used.
    const { data, error } = await db.rpc('erp_record_purchase_receipt_v2', {
      p_purchase_order_id: id,
      p_lines: toLinesPayload(lines),
      p_request_id: requestId,
      p_note: note,
      p_fx_rate: fxRate || null,
    });
    if (error) throw safeERPError('record the receipt', error);
    return data as string;
  },
  async cancel(id: string, reason: string) {
    const db = createClient();
    const { error } = await db.rpc('erp_cancel_purchase_order', {
      p_purchase_order_id: id,
      p_reason: reason,
    });
    if (error) throw safeERPError('cancel purchase order', error);
  },
};

// ─── Sales Orders ─────────────────────────────────────────────────────────────

function salesItemsPayload(items: any[]) {
  return (items || []).map((item: any) => ({
    product_id: item.productId || null,
    product_name: item.productName || '',
    qty: roundQty(Number(item.qty)),
    price: item.price,
    unit: isUnit(item.unit) ? item.unit : 'pcs',
  }));
}

function mapSalesOrder(r: any) {
  return {
    id: r.id,
    docNo: (r.doc_no as string | null) ?? null,
    customerId: r.customer_id,
    customerName: r.customer_name,
    date: r.order_date,
    status: r.status,
    total: Number(r.total),
    notes: r.notes,
    cancelReason: r.cancel_reason || '',
    currency: (r.currency as string | null) ?? null,
    fxRate: Number(r.fx_rate ?? 1) || 1,
    baseTotal: r.base_total != null ? Number(r.base_total) : Number(r.total),
    fxRateDate: (r.fx_rate_date as string | null) ?? null,
    fxRateSource: (r.fx_rate_source as string | null) ?? null,
    items: (r.items || []).map((i: any) => ({
      id: i.id,
      productId: i.product_id,
      productName: i.product_name,
      qty: Number(i.qty),
      unit: (isUnit(i.unit) ? i.unit : 'pcs') as UnitCode,
      price: Number(i.price),
      qtyDelivered: Number(i.qty_delivered ?? (r.status === 'delivered' ? i.qty : 0)),
    })),
  };
}

export const salesOrderService = {
  page(userId: string, q: PageQuery) {
    const db = createClient();
    return fetchPage(
      () =>
        scoped(
          db
            .from('erp_sales_orders')
            .select('*, items:erp_sales_order_items(*)', { count: 'exact' }),
          userId
        )
          .order('created_at', { ascending: false })
          .order('id'),
      q,
      ['customer_name', 'doc_no', 'notes'],
      'load sales orders',
      mapSalesOrder
    );
  },
  async getAll(userId: string) {
    const db = createClient();
    const data = await fetchAll(
      () =>
        scoped(db.from('erp_sales_orders').select('*, items:erp_sales_order_items(*)'), userId)
          .order('created_at', { ascending: false })
          .order('id'),
      'load sales orders'
    );
    return data.map(mapSalesOrder);
  },
  async create(userId: string, record: any) {
    const db = createClient();
    const args = {
      p_customer_id: record.customerId || null,
      p_customer_name: record.customerName || '',
      p_order_date: record.date || null,
      p_notes: record.notes || '',
      p_items: salesItemsPayload(record.items),
    };
    const { data, error } = await db.rpc('erp_create_sales_order_v3', {
      p_workspace_id: rpcWorkspaceId(),
      ...args,
      p_currency: record.currency || null,
      p_fx_rate: record.currency ? (record.fxRate ?? null) : null,
    });
    if (error) throw safeERPError('create sales order', error);
    return { id: data };
  },
  async updateItems(id: string, items: any[], notes?: string) {
    const db = createClient();
    const { error } = await db.rpc('erp_update_sales_order_items', {
      p_sales_order_id: id,
      p_items: salesItemsPayload(items),
      p_notes: notes ?? null,
    });
    if (error) throw safeERPError('update sales order', error);
  },
  async updateStatus(userId: string, id: string, status: string) {
    const db = createClient();
    void userId;
    if (status !== 'delivered') throw new Error(tr('erp.error.salesDeliverAfterInvoice'));
    const { error } = await db.rpc('erp_deliver_sales_order', {
      p_sales_order_id: id,
    });
    if (error) throw safeERPError('update sales order', error);
  },
  async recordDelivery(id: string, lines: FulfillmentLineInput[], requestId: string, note = '') {
    const db = createClient();
    const { data, error } = await db.rpc('erp_record_sales_delivery', {
      p_sales_order_id: id,
      p_lines: toLinesPayload(lines),
      p_request_id: requestId,
      p_note: note,
    });
    if (error) throw safeERPError('record the delivery', error);
    return data as string;
  },
  async cancel(id: string, reason: string) {
    const db = createClient();
    const { error } = await db.rpc('erp_cancel_sales_order', {
      p_sales_order_id: id,
      p_reason: reason,
    });
    if (error) throw safeERPError('cancel sales order', error);
  },
  async issueInvoice(userId: string, id: string, fxRate: number | null = null) {
    const db = createClient();
    // Due in 30 days; without an entered rate, the stored rate for today is used.
    const { data, error } = await db.rpc('erp_issue_invoice_from_sales_order_v2', {
      p_sales_order_id: id,
      p_due_date: null,
      p_fx_rate: fxRate || null,
    });
    if (error) throw safeERPError('issue invoice', error);
    return data as string;
  },
};

// ─── Invoices ─────────────────────────────────────────────────────────────────

interface PaymentRow {
  payment_type: string;
  voided_at: string | null;
  amount: number | string;
}

function invoicePaid(row: {
  amount_paid?: number | string | null;
  payments?: PaymentRow[] | null;
}): number {
  if (row.amount_paid != null) return Number(row.amount_paid);
  return (row.payments || [])
    .filter((p) => p.payment_type === 'incoming' && !p.voided_at)
    .reduce((sum, p) => sum + Number(p.amount), 0);
}

function mapInvoice(r: any) {
  const total = Number(r.total);
  const paid = invoicePaid(r);
  const isVoid = r.status === 'void';
  const paymentState: InvoicePaymentState = isVoid ? 'void' : invoicePaymentState(total, paid);
  const outstanding = invoiceBalance(total, paid, r.status);
  const status: 'paid' | 'overdue' | 'unpaid' | 'void' = isVoid
    ? 'void'
    : paymentState === 'paid'
      ? 'paid'
      : r.due_date < new Date().toISOString().slice(0, 10)
        ? 'overdue'
        : 'unpaid';
  const dueDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(`${r.due_date}T00:00:00`).getTime()) / 86400000)
  );
  return {
    id: r.id,
    docNo: (r.doc_no as string | null) ?? null,
    customerId: r.customer_id,
    customerName: r.customer_name,
    date: r.invoice_date,
    dueDate: r.due_date,
    status,
    paymentState,
    total,
    paid,
    outstanding,
    dueDays,
    salesOrderId: r.sales_order_id || null,
    voidReason: r.void_reason || '',
    taxRate: Number(r.tax_rate ?? 0),
    taxAmount: Number(r.tax_amount ?? 0),
    currency: (r.currency as string | null) ?? null,
    fxRate: Number(r.fx_rate ?? 1) || 1,
    baseTotal: r.base_total != null ? Number(r.base_total) : total,
    fxRateDate: (r.fx_rate_date as string | null) ?? null,
    fxRateSource: (r.fx_rate_source as string | null) ?? null,
  };
}

export const invoiceService = {
  page(userId: string, q: PageQuery, filter: InvoiceFilter) {
    const db = createClient();
    const today = new Date().toISOString().slice(0, 10);
    return fetchPage(
      () => {
        let query = scoped(
          db.from('erp_invoices').select('*, payments:erp_payments(*)', { count: 'exact' }),
          userId
        );
        if (filter === 'void') query = query.eq('status', 'void');
        else if (filter !== 'all') {
          query = query.neq('status', 'void');
          if (filter === 'paid') query = query.eq('payment_state', 'paid');
          else if (filter === 'partially_paid') query = query.eq('payment_state', 'partially_paid');
          else query = query.neq('payment_state', 'paid');
          if (filter === 'overdue') query = query.lt('due_date', today);
        }
        return query.order('created_at', { ascending: false }).order('id');
      },
      q,
      ['customer_name', 'doc_no'],
      'load invoices',
      mapInvoice
    );
  },
  async getAll(userId: string) {
    const db = createClient();
    const data = await fetchAll(
      () =>
        scoped(db.from('erp_invoices').select('*, payments:erp_payments(*)'), userId)
          .order('created_at', { ascending: false })
          .order('id'),
      'load invoices'
    );
    return data.map(mapInvoice);
  },
  async create(userId: string, record: any) {
    const db = createClient();
    void userId;
    const args = {
      p_customer_id: record.customerId || null,
      p_customer_name: record.customerName || '',
      p_invoice_date: record.date || null,
      p_due_date: record.dueDate || null,
      p_total: record.total,
    };
    const taxRate = Number(record.taxRate) || 0;
    // With lines (every invoice made in this version): the database adds them up.
    if (Array.isArray(record.lines) && record.lines.length > 0) {
      const { data, error } = await db.rpc('erp_create_invoice_v6', {
        p_workspace_id: rpcWorkspaceId(),
        p_customer_id: args.p_customer_id,
        p_customer_name: args.p_customer_name,
        p_invoice_date: args.p_invoice_date,
        p_due_date: args.p_due_date,
        p_lines: record.lines.map((l: any) => ({
          product_id: l.productId || null,
          description: (l.description || '').trim(),
          qty: roundQty(Number(l.qty)),
          unit: isUnit(l.unit) ? l.unit : 'pcs',
          price: Number(l.price) || 0,
        })),
        p_tax_rate: taxRate,
        p_currency: record.currency || null,
        p_fx_rate: record.fxRate ?? null,
      });
      if (error) throw safeERPError('create invoice', error);
      return { id: data };
    }
    // Without lines (one amount): the net amount; the database adds the tax.
    const { data, error } = await db.rpc('erp_create_invoice_v5', {
      p_workspace_id: rpcWorkspaceId(),
      p_customer_id: args.p_customer_id,
      p_customer_name: args.p_customer_name,
      p_invoice_date: args.p_invoice_date,
      p_due_date: args.p_due_date,
      p_subtotal: record.total,
      p_tax_rate: taxRate,
      p_currency: record.currency || null,
      p_fx_rate: record.currency ? (record.fxRate ?? null) : null,
    });
    if (error) throw safeERPError('create invoice', error);
    return { id: data };
  },
  async void(id: string, reason: string) {
    const db = createClient();
    const { error } = await db.rpc('erp_void_invoice', { p_invoice_id: id, p_reason: reason });
    if (error) throw safeERPError('void invoice', error);
  },
};

// ─── Payments ─────────────────────────────────────────────────────────────────

function mapPayment(r: any) {
  return {
    id: r.id,
    docNo: (r.doc_no as string | null) ?? null,
    type: r.payment_type,
    party: r.party,
    amount: Number(r.amount),
    date: r.payment_date,
    method: r.method,
    note: r.note,
    invoiceId: r.invoice_id || null,
    purchaseOrderId: r.purchase_order_id || null,
    voidedAt: r.voided_at || null,
    voidReason: r.void_reason || '',
    currency: (r.currency as string | null) ?? null,
    fxRate: Number(r.fx_rate ?? 1) || 1,
    baseAmount: r.base_amount != null ? Number(r.base_amount) : Number(r.amount),
    fxRateDate: (r.fx_rate_date as string | null) ?? null,
    fxRateSource: (r.fx_rate_source as string | null) ?? null,
  };
}

export const paymentService = {
  page(userId: string, q: PageQuery, type: 'all' | 'incoming' | 'outgoing') {
    const db = createClient();
    return fetchPage(
      () => {
        let query = scoped(db.from('erp_payments').select('*', { count: 'exact' }), userId);
        if (type !== 'all') query = query.eq('payment_type', type);
        return query.order('created_at', { ascending: false }).order('id');
      },
      q,
      ['party', 'doc_no', 'note', 'method'],
      'load payments',
      mapPayment
    );
  },
  async getAll(userId: string) {
    const db = createClient();
    const data = await fetchAll(
      () =>
        scoped(db.from('erp_payments').select('*'), userId)
          .order('created_at', { ascending: false })
          .order('id'),
      'load payments'
    );
    return data.map(mapPayment);
  },

  async getUnpaidInvoices(
    userId: string,
    by: { customerId?: string | null; customerName?: string; invoiceId?: string } = {}
  ) {
    const db = createClient();
    const make = () => {
      let q = scoped(db.from('erp_invoices').select('*, payments:erp_payments(*)'), userId)
        .in('status', ['unpaid', 'overdue'])
        .order('invoice_date', { ascending: false })
        .order('id');
      if (by.invoiceId) q = q.eq('id', by.invoiceId);
      else if (by.customerId && by.customerName)
        q = q.anyOf([
          { column: 'customer_id', op: 'eq', value: by.customerId },
          { column: 'customer_name', op: 'eq', value: by.customerName },
        ]);
      else if (by.customerId) q = q.eq('customer_id', by.customerId);
      return q;
    };
    const data = await fetchAll(make, 'load unpaid invoices');
    return data.map(mapInvoice).filter((inv) => inv.outstanding > 0);
  },

  async getPendingPurchaseOrders(
    userId: string,
    by: { supplierId?: string | null; supplierName?: string } = {}
  ) {
    const db = createClient();
    const make = () => {
      let q = scoped(db.from('erp_purchase_orders').select('*, payments:erp_payments(*)'), userId)
        .in('status', ['approved', 'received'])
        .order('order_date', { ascending: false })
        .order('id');
      if (by.supplierId && by.supplierName)
        q = q.anyOf([
          { column: 'supplier_id', op: 'eq', value: by.supplierId },
          { column: 'supplier_name', op: 'eq', value: by.supplierName },
        ]);
      else if (by.supplierId) q = q.eq('supplier_id', by.supplierId);
      return q;
    };
    const data = await fetchAll(make, 'load pending purchase orders');
    return data.map((r: any) => {
      const total = Number(r.total);
      const paid = ((r.payments || []) as PaymentRow[])
        .filter((p) => p.payment_type === 'outgoing' && !p.voided_at)
        .reduce((sum, p) => sum + Number(p.amount), 0);
      return {
        id: r.id,
        docNo: (r.doc_no as string | null) ?? null,
        supplierId: r.supplier_id,
        supplierName: r.supplier_name,
        date: r.order_date,
        status: r.status,
        total,
        outstanding: Math.max(0, total - paid),
        currency: (r.currency as string | null) ?? null,
      };
    });
  },

  async getPaidAmountForInvoice(userId: string, invoiceId: string): Promise<number> {
    const db = createClient();
    const { data, error } = await scoped(db.from('erp_payments').select('*'), userId).eq(
      'invoice_id',
      invoiceId
    );
    if (error) throw safeERPError('load invoice payment total', error);
    return ((data || []) as PaymentRow[])
      .filter((r) => !r.voided_at)
      .reduce((s, r) => s + Number(r.amount), 0);
  },

  async create(userId: string, record: any) {
    const db = createClient();
    const payload: any = {
      ...writeOwner(userId),
      payment_type: record.type,
      party: record.party,
      amount: record.amount,
      payment_date: record.date,
      method: record.method,
      note: record.note || '',
    };
    if (record.invoiceId) payload.invoice_id = record.invoiceId;
    if (record.purchaseOrderId) payload.purchase_order_id = record.purchaseOrderId;
    if (record.fxRateSource === 'manual' && Number(record.fxRate) > 0) {
      payload.fx_rate = Number(record.fxRate);
      payload.fx_rate_source = 'manual';
    } else if (record.fxRateSource === 'rate_table') {
      payload.fx_rate_source = 'rate_table';
    }

    const { data, error } = await db.from('erp_payments').insert(payload).select().single();
    if (error) throw safeERPError('record payment', error);

    return data;
  },

  async void(id: string, reason: string) {
    const db = createClient();
    const { error } = await db.rpc('erp_void_payment', { p_payment_id: id, p_reason: reason });
    if (error) throw safeERPError('void payment', error);
  },
};

// ─── Transactions ─────────────────────────────────────────────────────────────

function mapTransaction(r: any) {
  return {
    id: r.id as string,
    type: r.transaction_type as string,
    category: r.category as string,
    amount: Number(r.amount),
    date: r.transaction_date as string,
    description: r.description as string,
    isReversal: !!r.is_reversal,
  };
}

export const transactionService = {
  page(userId: string, q: PageQuery) {
    const db = createClient();
    return fetchPage(
      () =>
        scoped(db.from('erp_transactions').select('*', { count: 'exact' }), userId)
          .order('created_at', { ascending: false })
          .order('id'),
      q,
      ['description', 'category'],
      'load transactions',
      mapTransaction
    );
  },
  async getAll(userId: string) {
    const db = createClient();
    const data = await fetchAll(
      () =>
        scoped(db.from('erp_transactions').select('*'), userId)
          .order('created_at', { ascending: false })
          .order('id'),
      'load transactions'
    );
    return data.map(mapTransaction);
  },
  async create(userId: string, record: any) {
    const db = createClient();
    const { data, error } = await db
      .from('erp_transactions')
      .insert({
        ...writeOwner(userId),
        transaction_type: record.type,
        category: record.category,
        amount: record.amount,
        transaction_date: record.date,
        description: record.description,
      })
      .select()
      .single();
    if (error) throw safeERPError('record transaction', error);
    return data;
  },
};

// ─── Dashboard Metrics ────────────────────────────────────────────────────────

export const dashboardService = {
  async getMetrics(userId: string): Promise<FinancialMetrics> {
    const db = createClient();
    const summary = await db.rpc('erp_dashboard_metrics', { p_workspace_id: rpcWorkspaceId() });
    if (!summary.error && summary.data) {
      const figures = summary.data as Record<keyof FinancialMetrics, number | string>;
      return Object.fromEntries(
        Object.entries(figures).map(([key, value]) => [key, Number(value) || 0])
      ) as unknown as FinancialMetrics;
    }

    // A database without the function yet: add the rows up here, as before.
    const label = 'load dashboard metrics';
    const [invoices, payments, products, purchaseOrders] = await Promise.all([
      fetchAll(() => scoped(db.from('erp_invoices').select('*'), userId).order('id'), label),
      fetchAll(() => scoped(db.from('erp_payments').select('*'), userId).order('id'), label),
      fetchAll(() => scoped(db.from('erp_products').select('*'), userId).order('id'), label),
      fetchAll(
        () =>
          scoped(
            db.from('erp_purchase_orders').select('*, items:erp_purchase_order_items(*)'),
            userId
          ).order('id'),
        label
      ),
    ]);

    return computeFinancialMetrics({ invoices, payments, purchaseOrders, products });
  },

  async getRecentTransactions(userId: string, limit = 7) {
    const db = createClient();
    const { data, error } = await scoped(db.from('erp_transactions').select('*'), userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw safeERPError('load recent transactions', error);
    return (data || []).map((r: any) => ({
      id: r.id,
      type: r.transaction_type,
      category: r.category,
      amount: Number(r.amount),
      date: r.transaction_date,
      description: r.description,
    }));
  },
};
