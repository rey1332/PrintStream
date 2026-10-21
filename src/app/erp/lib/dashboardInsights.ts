// The ERP dashboard's receivables, revenue and trend figures, as returned by
// erp_dashboard_insights (db/migrations/20261012000059_erp_dashboard_insights.sql).
// All amounts are in the workspace's base currency.

export interface AgingBuckets {
  current: number;
  days30: number;
  days60: number;
  days90: number;
  over90: number;
}

export interface RankedItem {
  id: string | null;
  name: string;
  revenue: number;
}

export interface MonthFigures {
  /** YYYY-MM */
  month: string;
  revenue: number;
  cashIn: number;
  cashOut: number;
}

export interface DashboardInsights {
  asOf: string;
  since: string;
  receivables: {
    balanceDue: number;
    pastDue: number;
    openInvoices: number;
    invoicesPastDue: number;
    customersPastDue: number;
  };
  aging: AgingBuckets;
  credit: { overLimit: number; customersOver: number; customersWithLimit: number };
  revenue: { total: number; invoices: number };
  topProducts: (RankedItem & { qty: number })[];
  topCustomers: (RankedItem & { invoices: number })[];
  months: MonthFigures[];
}

export const AGING_KEYS = ['current', 'days30', 'days60', 'days90', 'over90'] as const;

// PostgreSQL numerics arrive as numbers or strings; anything else counts as 0.
const n = (value: unknown): number => {
  const x = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(x) ? x : 0;
};
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(obj) : [];

export function parseInsights(raw: unknown): DashboardInsights {
  const r = obj(raw);
  const rec = obj(r.receivables);
  const aging = obj(r.aging);
  const credit = obj(r.credit);
  const revenue = obj(r.revenue);
  return {
    asOf: String(r.asOf ?? ''),
    since: String(r.since ?? ''),
    receivables: {
      balanceDue: n(rec.balanceDue),
      pastDue: n(rec.pastDue),
      openInvoices: n(rec.openInvoices),
      invoicesPastDue: n(rec.invoicesPastDue),
      customersPastDue: n(rec.customersPastDue),
    },
    aging: Object.fromEntries(AGING_KEYS.map((k) => [k, n(aging[k])])) as unknown as AgingBuckets,
    credit: {
      overLimit: n(credit.overLimit),
      customersOver: n(credit.customersOver),
      customersWithLimit: n(credit.customersWithLimit),
    },
    revenue: { total: n(revenue.total), invoices: n(revenue.invoices) },
    topProducts: list(r.topProducts).map((p) => ({
      id: p.id == null ? null : String(p.id),
      name: String(p.name ?? ''),
      revenue: n(p.revenue),
      qty: n(p.qty),
    })),
    topCustomers: list(r.topCustomers).map((c) => ({
      id: c.id == null ? null : String(c.id),
      name: String(c.name ?? ''),
      revenue: n(c.revenue),
      invoices: n(c.invoices),
    })),
    months: list(r.months).map((m) => ({
      month: String(m.month ?? ''),
      revenue: n(m.revenue),
      cashIn: n(m.cashIn),
      cashOut: n(m.cashOut),
    })),
  };
}

/** True when the 12 months hold no revenue and no cash movement at all. */
export function monthsEmpty(months: MonthFigures[]): boolean {
  return months.every((m) => m.revenue === 0 && m.cashIn === 0 && m.cashOut === 0);
}
