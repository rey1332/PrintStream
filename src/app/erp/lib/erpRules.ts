// ─── Workspace roles ─────────────────────────────────────────────────────────

export const WORKSPACE_ROLES = ['owner', 'admin', 'finance', 'sales', 'inventory'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** A member's role: one of the built-in presets, or a workspace's own custom role. */
export type MemberRole = WorkspaceRole | 'custom';

export const ERP_PERMISSIONS = [
  'read',
  'customers',
  'suppliers',
  'products',
  'inventory',
  'sales',
  'invoicing',
  'fulfillment',
  'purchasing',
  'receiving',
  'payments',
  'members',
  'audit',
] as const;

// Mirrors public.erp_all_permissions() (db/migrations/20261012000061_pipeline_code.sql).
export const TERMINAL_PERMISSIONS = [
  'roles.manage',
  'policies.manage',
  'storage.view',
  'integrations.manage',
  'integrations.use',
  'datasets.view',
  'datasets.query',
  'datasets.import',
  'datasets.edit',
  'datasets.schema',
  'datasets.export',
  'datasets.share',
  'datasets.delete',
  'data.sensitive',
  'pipelines.view',
  'pipelines.create',
  'pipelines.edit',
  'pipelines.run',
  'pipelines.schedule',
  'pipelines.publish',
  'pipelines.disable',
  'pipelines.delete',
  'pipelines.code',
  'approvals.decide',
] as const;

export const PERMISSIONS = [...ERP_PERMISSIONS, ...TERMINAL_PERMISSIONS] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Permissions that make a role need two-factor (public.erp_sensitive_permissions). */
export const SENSITIVE_PERMISSIONS: readonly Permission[] = [
  'read',
  'invoicing',
  'payments',
  'members',
  'audit',
  'roles.manage',
  'policies.manage',
  'integrations.manage',
  'datasets.export',
  'data.sensitive',
  'approvals.decide',
  'pipelines.code',
];

/** How the role editor groups permissions. */
export const PERMISSION_GROUPS: { id: string; permissions: readonly Permission[] }[] = [
  { id: 'erp', permissions: ERP_PERMISSIONS },
  { id: 'workspace', permissions: ['roles.manage', 'policies.manage', 'storage.view'] },
  { id: 'integrations', permissions: ['integrations.manage', 'integrations.use'] },
  {
    id: 'datasets',
    permissions: TERMINAL_PERMISSIONS.filter(
      (p) => p.startsWith('datasets.') || p === 'data.sensitive'
    ),
  },
  { id: 'pipelines', permissions: TERMINAL_PERMISSIONS.filter((p) => p.startsWith('pipelines.')) },
  { id: 'approvals', permissions: ['approvals.decide'] },
];

export type HrCapability = 'hr.manage' | 'hr.record';
export type Capability = Permission | HrCapability;

const FULL_ACCESS: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<WorkspaceRole, Permission[]> = {
  owner: FULL_ACCESS,
  // Writing pipeline code is the Owner's, or a custom role's (20261012000061).
  admin: FULL_ACCESS.filter(
    (p) => p !== 'roles.manage' && p !== 'data.sensitive' && p !== 'pipelines.code'
  ),
  finance: [
    'read',
    'invoicing',
    'payments',
    'storage.view',
    'integrations.use',
    'datasets.view',
    'datasets.query',
    'datasets.import',
    'datasets.edit',
    'datasets.schema',
    'datasets.export',
    'pipelines.view',
    'pipelines.create',
    'pipelines.edit',
    'pipelines.run',
  ],
  sales: ['customers', 'sales', 'invoicing'],
  inventory: ['suppliers', 'products', 'inventory', 'fulfillment', 'purchasing', 'receiving'],
};

export const GRANTABLE_ROLES: Record<WorkspaceRole, WorkspaceRole[]> = {
  owner: ['admin', 'finance', 'sales', 'inventory'],
  admin: ['finance', 'sales', 'inventory'],
  finance: [],
  sales: [],
  inventory: [],
};

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  finance: 'Finance',
  sales: 'Sales',
  inventory: 'Inventory',
};

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: 'Full access, including members',
  admin: 'Full access, can invite non-admin roles',
  finance: 'Everything, plus invoices and payments',
  sales: 'Customers, sales orders and invoices only',
  inventory: 'Suppliers, products, stock, purchasing, receiving, delivery',
};

export const READ_AREAS = {
  customers: ['read', 'customers'],
  suppliers: ['read', 'suppliers'],
  products: ['read', 'products', 'sales'],
  stock: ['read', 'inventory'],
  purchase_orders: ['read', 'purchasing', 'receiving'],
  sales_orders: ['read', 'sales', 'fulfillment'],
  invoices: ['read', 'invoicing'],
  payments: ['read', 'payments'],
  books: ['read'],
} as const satisfies Record<string, readonly Permission[]>;
export type ReadArea = keyof typeof READ_AREAS;

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function roleCan(role: WorkspaceRole | null | undefined, permission: Permission): boolean {
  return !!role && ROLE_PERMISSIONS[role].includes(permission);
}

export function roleCanAny(
  role: WorkspaceRole | null | undefined,
  permissions: readonly Permission[]
): boolean {
  return permissions.some((p) => roleCan(role, p));
}

export function roleCanRead(role: WorkspaceRole | null | undefined, area: ReadArea): boolean {
  return roleCanAny(role, READ_AREAS[area]);
}

export function isMemberRole(value: unknown): value is MemberRole {
  return value === 'custom' || isWorkspaceRole(value);
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * The permissions a member holds: those the database reported (custom roles,
 * erp_my_permissions), else the built-in role's preset.
 */
export function permissionsOf(
  role: MemberRole | null | undefined,
  reported?: readonly unknown[] | null
): Permission[] {
  if (Array.isArray(reported)) return reported.filter(isPermission);
  return role && role !== 'custom' ? [...ROLE_PERMISSIONS[role]] : [];
}

export function can(
  permissions: readonly string[] | null | undefined,
  permission: Permission
): boolean {
  return !!permissions && permissions.includes(permission);
}

export function canRead(
  permissions: readonly string[] | null | undefined,
  area: ReadArea
): boolean {
  return READ_AREAS[area].some((p) => can(permissions, p));
}

export function canGrantRole(
  actor: WorkspaceRole | null | undefined,
  role: WorkspaceRole
): boolean {
  return !!actor && GRANTABLE_ROLES[actor].includes(role);
}

export type PurchaseOrderStatus = 'pending' | 'approved' | 'received' | 'cancelled';
export type SalesOrderStatus = 'draft' | 'invoiced' | 'delivered' | 'cancelled';

export const PO_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  pending: ['approved', 'cancelled'],
  approved: ['received', 'cancelled'],
  received: [],
  cancelled: [],
};

export const SO_TRANSITIONS: Record<SalesOrderStatus, SalesOrderStatus[]> = {
  draft: ['invoiced', 'cancelled'],
  invoiced: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

export function canTransition<S extends string>(table: Record<S, S[]>, from: S, to: S): boolean {
  return from === to || (table[from] ?? []).includes(to);
}

export const MIN_REASON_LENGTH = 3;

export function isValidReason(reason: string | null | undefined): boolean {
  return (reason ?? '').trim().length >= MIN_REASON_LENGTH;
}

// ─── Quantities and balances ─────────────────────────────────────────────────

export function remainingQty(ordered: number, moved: number): number {
  // Three decimals, so 0.3 − 0.1 is 0.2 and not 0.19999999999999998.
  return Math.max(0, Math.round(((ordered || 0) - (moved || 0)) * 1000) / 1000);
}

export type InvoicePaymentState = 'unpaid' | 'partially_paid' | 'paid' | 'void';

export const PAYMENT_STATE_LABELS: Record<InvoicePaymentState, string> = {
  unpaid: 'Unpaid',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  void: 'Void',
};

const CENT = 0.005;

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function invoicePaymentState(
  total: number,
  paid: number,
  status?: string
): InvoicePaymentState {
  if (status === 'void') return 'void';
  if (paid >= total - CENT) return 'paid';
  if (paid > CENT) return 'partially_paid';
  return 'unpaid';
}

export function invoiceBalance(total: number, paid: number, status?: string): number {
  if (status === 'void') return 0;
  return roundMoney(Math.max(0, total - paid));
}

export interface MetricInvoice {
  id: string;
  total: number | string;
  status?: string | null;
  fx_rate?: number | string | null;
  base_total?: number | string | null;
}

export interface MetricPayment {
  amount: number | string;
  payment_type: 'incoming' | 'outgoing' | string;
  invoice_id?: string | null;
  purchase_order_id?: string | null;
  voided_at?: string | null;
  fx_rate?: number | string | null;
  base_amount?: number | string | null;
}

export interface MetricPurchaseOrderItem {
  qty: number;
  price: number | string;
  qty_received?: number | null;
}

export interface MetricPurchaseOrder {
  id: string;
  status: string;
  total: number | string;
  items?: MetricPurchaseOrderItem[] | null;
  tax_rate?: number | string | null;
  fx_rate?: number | string | null;
}

export interface MetricProduct {
  current_stock: number;
  purchase_price: number | string;
  avg_cost?: number | string | null;
}

const rateOf = (value: number | string | null | undefined) =>
  Number(value) > 0 ? Number(value) : 1;

export interface FinancialMetrics {
  cashIn: number;
  cashOut: number;
  netCash: number;
  invoicedRevenue: number;
  accountsReceivable: number;
  accountsPayable: number;
  committedPurchases: number;
  supplierPrepayments: number;
  inventoryValue: number;
  totalRevenue: number;
  totalExpenses: number;
  cashBalance: number;
}

function poReceivedAndOrderedValue(po: MetricPurchaseOrder) {
  const items = po.items ?? [];
  if (items.length === 0) {
    const total = Number(po.total) || 0;
    return { ordered: total, received: po.status === 'received' ? total : 0 };
  }
  // Line prices are net; the order total and payments include purchase tax.
  const gross = 1 + (Number(po.tax_rate) || 0) / 100;
  let ordered = 0;
  let received = 0;
  for (const item of items) {
    const qty = Math.max(0, Number(item.qty) || 0);
    const price = Number(item.price) || 0;
    // Older rows (before partial receiving existed) have no qty_received.
    const got =
      item.qty_received == null
        ? po.status === 'received'
          ? qty
          : 0
        : Math.min(qty, Math.max(0, item.qty_received));
    ordered += qty * price * gross;
    received += got * price * gross;
  }
  return { ordered, received };
}

export function computeFinancialMetrics(input: {
  invoices: MetricInvoice[];
  payments: MetricPayment[];
  purchaseOrders: MetricPurchaseOrder[];
  products: MetricProduct[];
}): FinancialMetrics {
  const payments = input.payments.filter((p) => !p.voided_at);

  let cashIn = 0;
  let cashOut = 0;
  const paidByInvoice = new Map<string, number>();
  const paidByPurchaseOrder = new Map<string, number>();
  // Cash is counted in the base currency; invoice balances in the invoice's.
  for (const p of payments) {
    const amount = Number(p.amount) || 0;
    const base =
      p.base_amount != null && p.base_amount !== ''
        ? Number(p.base_amount)
        : amount * rateOf(p.fx_rate);
    if (p.payment_type === 'incoming') {
      cashIn += base;
      if (p.invoice_id)
        paidByInvoice.set(p.invoice_id, (paidByInvoice.get(p.invoice_id) ?? 0) + amount);
    } else {
      cashOut += base;
      if (p.purchase_order_id) {
        paidByPurchaseOrder.set(
          p.purchase_order_id,
          (paidByPurchaseOrder.get(p.purchase_order_id) ?? 0) + amount
        );
      }
    }
  }

  let invoicedRevenue = 0;
  let accountsReceivable = 0;
  for (const invoice of input.invoices) {
    if (invoice.status === 'void') continue;
    const total = Number(invoice.total) || 0;
    const rate = rateOf(invoice.fx_rate);
    invoicedRevenue +=
      invoice.base_total != null && invoice.base_total !== ''
        ? Number(invoice.base_total)
        : total * rate;
    accountsReceivable += Math.max(0, total - (paidByInvoice.get(invoice.id) ?? 0)) * rate;
  }

  let accountsPayable = 0;
  let committedPurchases = 0;
  let supplierPrepayments = 0;
  for (const po of input.purchaseOrders) {
    if (po.status !== 'approved' && po.status !== 'received') continue;
    const { ordered, received } = poReceivedAndOrderedValue(po);
    const paid = paidByPurchaseOrder.get(po.id) ?? 0;
    const rate = rateOf(po.fx_rate);
    accountsPayable += Math.max(0, received - paid) * rate;
    supplierPrepayments += Math.max(0, paid - received) * rate;
    if (po.status === 'approved') committedPurchases += Math.max(0, ordered - received) * rate;
  }

  const inventoryValue = input.products.reduce(
    (sum, p) =>
      sum + (Number(p.current_stock) || 0) * (Number(p.avg_cost) || Number(p.purchase_price) || 0),
    0
  );

  const netCash = cashIn - cashOut;
  return {
    cashIn: roundMoney(cashIn),
    cashOut: roundMoney(cashOut),
    netCash: roundMoney(netCash),
    invoicedRevenue: roundMoney(invoicedRevenue),
    accountsReceivable: roundMoney(accountsReceivable),
    accountsPayable: roundMoney(accountsPayable),
    committedPurchases: roundMoney(committedPurchases),
    supplierPrepayments: roundMoney(supplierPrepayments),
    inventoryValue: roundMoney(inventoryValue),
    totalRevenue: roundMoney(cashIn),
    totalExpenses: roundMoney(cashOut),
    cashBalance: roundMoney(netCash),
  };
}

const CODE_ALPHABET = /^[0-9A-HJKMNP-TV-Z]{20}$/;

export function normalizeAccessCode(input: string): string {
  const cleaned = (input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return cleaned.length === 24 && cleaned.startsWith('ETNA') ? cleaned.slice(4) : cleaned;
}

export function isWellFormedAccessCode(input: string): boolean {
  return CODE_ALPHABET.test(normalizeAccessCode(input));
}
