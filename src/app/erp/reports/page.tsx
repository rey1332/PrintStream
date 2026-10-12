'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { transactionService } from '../lib/erpService';
import { useAuth } from '@/contexts/AuthContext';
import { createClient } from '@/lib/data/client';
import { readScope, rpcWorkspaceId } from '../lib/workspace';
import { UNIT_LABEL, isUnit } from '@/lib/units';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { Download, RefreshCw } from 'lucide-react';
import { CustomSelect } from '@/components/ui/CustomSelect';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { tr } from '@/lib/i18n/translate';
import { hasMessage, statusLabel, txCategoryLabel } from '@/lib/i18n/labels';
import { useDisplayConversion } from '../lib/useCurrency';
import { ConvertedAmount, DisplayBasis } from '../components/CurrencyFields';

const CHART_COLORS = {
  grid: 'var(--border)',
  axis: 'var(--muted-foreground)',
  primaryBar: 'var(--foreground)',
  secondaryBar: 'var(--muted-foreground)',
  pieColors: ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6'],
};

const CustomTooltip = ({ active, payload, label }: any) => {
  const { fmt } = useI18n();
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-lg border border-border bg-card px-3 py-2 text-[0.75rem] shadow-lg"
      style={{ color: 'var(--card-foreground)' }}
    >
      <p className="text-muted-foreground mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: {fmt.money(p.value ?? 0)}
        </p>
      ))}
    </div>
  );
};

const EmptyState = ({ message }: { message: string }) => (
  <div className="flex flex-col items-center justify-center py-16 text-center">
    <svg
      className="w-12 h-12 text-muted-foreground opacity-30 mb-3"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
      />
    </svg>
    <p className="text-[0.8rem] text-muted-foreground">{message}</p>
  </div>
);

function downloadCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const csv = [headers.join(','), ...rows.map((r) => r.map(escape).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const REPORT_TABS = ['Sales', 'Inventory', 'Cash Flow', 'Net Cash', 'Audit Log'] as const;
type ReportTab = (typeof REPORT_TABS)[number];

interface Product {
  id: string;
  name: string;
  sku: string;
  category: string;
  unit: string;
  purchasePrice: number;
  currentStock: number;
  minStock: number;
  maxStock: number;
  value: number;
}
interface Monthly {
  month: string;
  income: number;
  expense: number;
}
/** erp_reports_summary: totals computed by the database (base currency). */
interface Summary {
  counts: { invoices: number; payments: number; transactions: number; products: number };
  revenue: number;
  incoming: number;
  outgoing: number;
  invoice_status: Record<string, { count: number; total: number }>;
  monthly_payments: Monthly[];
  monthly_transactions: Monthly[];
  expense_categories: { category: string; amount: number }[];
  products: {
    id: string;
    name: string;
    sku: string;
    category: string;
    unit: string;
    stock: number;
    purchase_price: number;
    min_stock: number;
    max_stock: number;
    value: number;
  }[];
}
interface AuditLog {
  id: string;
  tableName: string;
  recordId: string | null;
  action: string;
  changedBy: string;
  beforeData: Record<string, any> | null;
  afterData: Record<string, any> | null;
  createdAt: string;
}

const ACTION_COLORS: Record<string, string> = {
  INSERT: '#22c55e',
  UPDATE: '#f59e0b',
  DELETE: '#ef4444',
};

const AUDIT_TABLES = [
  'erp_transactions',
  'erp_invoices',
  'erp_payments',
  'erp_purchase_orders',
  'erp_sales_orders',
  'erp_products',
  'erp_customers',
  'erp_suppliers',
  'erp_stock_movements',
];

function tableLabel(table: string, t: (key: MessageKey) => string) {
  const key = `rep.table.${table}`;
  return hasMessage(key) ? t(key) : table;
}

// Field names and values in the diff are stored data and stay as recorded.
function formatDiff(
  before: Record<string, any> | null,
  after: Record<string, any> | null,
  action: string
): string {
  if (action === 'INSERT' && after) {
    const keys = [
      'amount',
      'total',
      'status',
      'name',
      'description',
      'category',
      'transaction_type',
      'payment_type',
    ];
    const parts = keys
      .filter((k) => after[k] !== undefined && after[k] !== null && after[k] !== '')
      .map((k) => `${k}: ${after[k]}`);
    return parts.slice(0, 3).join(' · ') || tr('rep.audit.created');
  }
  if (action === 'DELETE' && before) {
    const keys = ['amount', 'total', 'status', 'name', 'description'];
    const parts = keys
      .filter((k) => before[k] !== undefined && before[k] !== null && before[k] !== '')
      .map((k) => `${k}: ${before[k]}`);
    return parts.slice(0, 3).join(' · ') || tr('rep.audit.deleted');
  }
  if (action === 'UPDATE' && before && after) {
    const changed: string[] = [];
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const skipKeys = new Set(['updated_at', 'created_at', 'id', 'user_id']);
    allKeys.forEach((k) => {
      if (!skipKeys.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
        changed.push(`${k}: ${before[k]} → ${after[k]}`);
      }
    });
    return changed.slice(0, 3).join(' · ') || tr('rep.audit.noChanges');
  }
  return '—';
}

export default function ReportsPage() {
  const { user } = useAuth();
  const { t, fmt } = useI18n();
  const { convert, display, base } = useDisplayConversion();
  const auditFilterOptions = [
    { value: 'all', label: t('rep.audit.allModules') },
    ...AUDIT_TABLES.map((table) => ({ value: table, label: tableLabel(table, t) })),
  ];
  const [activeTab, setActiveTab] = useState<ReportTab>('Sales');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditFilter, setAuditFilter] = useState<string>('all');
  const [auditPage, setAuditPage] = useState(0);
  const AUDIT_PAGE_SIZE = 50;

  // Totals come from the database (erp_reports_summary), not from every row.
  const loadData = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcError } = await createClient().rpc('erp_reports_summary', {
        p_workspace_id: rpcWorkspaceId(),
      });
      if (rpcError || !data) {
        setError(tr('rep.loadFailed'));
        return;
      }
      setSummary(data as Summary);
    } catch {
      setError(tr('rep.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  const loadAuditLogs = useCallback(async () => {
    if (!user?.id) return;
    setAuditLoading(true);
    setAuditError(null);
    try {
      const db = createClient();
      const scope = readScope(user.id);
      let query = db
        .from('erp_audit_log')
        .select('*')
        .eq(scope.column, scope.value)
        .order('created_at', { ascending: false })
        .range(auditPage * AUDIT_PAGE_SIZE, (auditPage + 1) * AUDIT_PAGE_SIZE - 1);

      if (auditFilter !== 'all') {
        query = query.eq('table_name', auditFilter);
      }

      const { data, error: qErr } = await query;
      if (qErr) throw qErr;
      setAuditLogs(
        (data || []).map((r: any) => ({
          id: r.id,
          tableName: r.table_name,
          recordId: r.record_id,
          action: r.action,
          changedBy: r.changed_by,
          beforeData: r.before_data,
          afterData: r.after_data,
          createdAt: r.created_at,
        }))
      );
    } catch (err: any) {
      setAuditError(err?.message || tr('rep.audit.loadFailed'));
    } finally {
      setAuditLoading(false);
    }
  }, [user?.id, auditFilter, auditPage]);

  useEffect(() => {
    loadData();
  }, [loadData]);
  useEffect(() => {
    if (activeTab === 'Audit Log') loadAuditLogs();
  }, [activeTab, loadAuditLogs]);

  const totalRevenue = Number(summary?.revenue ?? 0);
  const totalIncoming = Number(summary?.incoming ?? 0);
  const totalOutgoing = Number(summary?.outgoing ?? 0);
  const totalExpenses = totalOutgoing;
  const netCash = totalIncoming - totalOutgoing;
  const invoiceStatus = (status: string) =>
    summary?.invoice_status?.[status] ?? { count: 0, total: 0 };

  const expenseData = (summary?.expense_categories ?? []).map((c) => ({
    name: txCategoryLabel(c.category, tr),
    value: Number(c.amount),
  }));

  const products: Product[] = (summary?.products ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    category: p.category,
    unit: p.unit,
    purchasePrice: Number(p.purchase_price),
    currentStock: Number(p.stock),
    minStock: Number(p.min_stock),
    maxStock: Number(p.max_stock),
    value: Number(p.value),
  }));
  const unitText = (unit: string) => (isUnit(unit) ? ` ${t(UNIT_LABEL[unit])}` : '');
  const inventoryData = products.map((p) => ({
    name: p.name.split(' ')[0],
    value: p.value,
    stock: p.currentStock,
  }));

  const monthLabel = (key: string) => {
    const [year, month] = key.split('-').map(Number);
    return fmt.month(new Date(year, month - 1, 1), true);
  };
  const monthlyCashFlow = (summary?.monthly_payments ?? []).map((m) => ({
    month: monthLabel(m.month),
    income: Number(m.income),
    expense: Number(m.expense),
  }));
  const monthlyTxnFlow = (summary?.monthly_transactions ?? []).map((m) => ({
    month: monthLabel(m.month),
    income: Number(m.income),
    expense: Number(m.expense),
  }));

  const profitData = monthlyTxnFlow.map((m) => ({
    month: m.month,
    profit: m.income - m.expense,
  }));

  async function downloadTransactions() {
    if (!user?.id || exporting) return;
    setExporting(true);
    let transactions: {
      date: string;
      description: string;
      category: string;
      type: string;
      amount: number;
    }[];
    try {
      transactions = await transactionService.getAll(user.id);
    } catch {
      setError(tr('rep.loadFailed'));
      return;
    } finally {
      setExporting(false);
    }
    downloadCSV(
      'transactions.csv',
      [
        t('common.date'),
        t('common.description'),
        t('common.category'),
        t('common.type'),
        t('common.amount'),
      ],
      transactions.map((txn) => [txn.date, txn.description, txn.category, txn.type, txn.amount])
    );
  }
  function downloadInventory() {
    downloadCSV(
      'inventory.csv',
      [
        t('common.name'),
        t('prod.sku'),
        t('common.category'),
        t('prod.stock'),
        t('rep.unitCost'),
        t('rep.totalValue'),
        t('inv.minStock'),
        t('inv.maxStock'),
      ],
      products.map((p) => [
        p.name,
        p.sku,
        p.category,
        `${p.currentStock}${unitText(p.unit)}`,
        p.purchasePrice,
        p.value,
        p.minStock,
        p.maxStock,
      ])
    );
  }
  function downloadCashFlow() {
    downloadCSV(
      'cash_flow.csv',
      [t('cash.month'), t('rep.series.incoming'), t('rep.series.outgoing'), t('cash.seriesNet')],
      monthlyCashFlow.map((m) => [m.month, m.income, m.expense, m.income - m.expense])
    );
  }
  function downloadProfit() {
    downloadCSV(
      'net_cash.csv',
      [
        t('cash.month'),
        t('cash.seriesIn'),
        t('cash.seriesOut'),
        t('rep.series.netCash'),
        t('rep.netPerCashInPct'),
      ],
      monthlyTxnFlow.map((m) => {
        const profit = m.income - m.expense;
        const margin = m.income > 0 ? ((profit / m.income) * 100).toFixed(1) : '0';
        return [m.month, m.income, m.expense, profit, margin];
      })
    );
  }
  function downloadAuditLog() {
    downloadCSV(
      'audit_log.csv',
      [
        t('rep.audit.timestamp'),
        t('rep.audit.table'),
        t('rep.audit.action'),
        t('rep.audit.changedBy'),
        t('rep.audit.recordId'),
        t('rep.audit.changes'),
      ],
      auditLogs.map((l) => [
        l.createdAt,
        tableLabel(l.tableName, t),
        l.action,
        l.changedBy,
        l.recordId || '',
        formatDiff(l.beforeData, l.afterData, l.action),
      ])
    );
  }

  if (loading) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('rep.title')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">{t('rep.subtitle')}</p>
        </div>
        <div className="flex items-center justify-center py-24">
          <div className="w-6 h-6 border-2 border-border border-t-foreground/70 rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('rep.title')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">{t('rep.subtitle')}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-6 text-center">
          <p className="text-[0.85rem] text-red-600 dark:text-red-400">{error}</p>
          <button
            onClick={loadData}
            className="mt-3 px-4 py-1.5 text-[0.8rem] rounded-lg border border-border text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  const hasTransactions = (summary?.counts.transactions ?? 0) > 0;
  const hasProducts = products.length > 0;
  const hasInvoices = (summary?.counts.invoices ?? 0) > 0;
  const hasPayments = (summary?.counts.payments ?? 0) > 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[1.25rem] font-bold text-foreground">{t('rep.title')}</h1>
        <p className="text-[0.8rem] text-muted-foreground mt-0.5">{t('rep.subtitle')}</p>
        <DisplayBasis convert={convert} display={display} base={base} />
      </div>

      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          {
            label: t('rep.kpi.invoiced'),
            value: hasInvoices ? fmt.money(totalRevenue) : '—',
            amount: hasInvoices ? totalRevenue : null,
          },
          {
            label: t('rep.kpi.cashIn'),
            value: hasPayments ? fmt.money(totalIncoming) : '—',
            amount: hasPayments ? totalIncoming : null,
          },
          {
            label: t('rep.kpi.cashOut'),
            value: hasPayments ? fmt.money(totalOutgoing) : '—',
            amount: hasPayments ? totalOutgoing : null,
          },
          {
            label: t('rep.kpi.netCash'),
            value: hasPayments ? fmt.money(netCash) : '—',
            amount: hasPayments ? netCash : null,
          },
        ].map((kpi) => (
          <div
            key={kpi.label}
            className="rounded-xl border border-border bg-card p-4 max-lg:min-w-0"
          >
            <p className="text-[0.68rem] uppercase tracking-wider text-muted-foreground mb-2">
              {kpi.label}
            </p>
            <p className="text-[1.3rem] font-bold text-foreground max-lg:text-[1.2rem] max-lg:[overflow-wrap:anywhere]">
              {kpi.value}
            </p>
            {kpi.amount != null && <ConvertedAmount conversion={convert(kpi.amount)} />}
          </div>
        ))}
      </div>

      <div className="flex gap-1 border-b border-border pb-0 overflow-x-auto">
        {REPORT_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-[0.8rem] font-medium transition-all border-b-2 whitespace-nowrap ${
              activeTab === tab
                ? 'text-foreground border-foreground'
                : 'text-muted-foreground border-transparent hover:text-foreground'
            }`}
          >
            {t(`rep.tab.${tab}`)}
          </button>
        ))}
      </div>

      {activeTab === 'Sales' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[0.85rem] font-semibold text-foreground">
                {t('rep.salesVsExpenses')}
              </h2>
              {hasTransactions && (
                <button
                  onClick={downloadTransactions}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.75rem] text-muted-foreground border border-border hover:text-foreground transition-colors"
                >
                  <Download size={12} /> {t('common.exportCsv')}
                </button>
              )}
            </div>
            {monthlyTxnFlow.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={monthlyTxnFlow}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke={CHART_COLORS.grid}
                    vertical={false}
                  />
                  <XAxis
                    dataKey="month"
                    tick={{ fill: CHART_COLORS.axis, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: CHART_COLORS.axis, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => fmt.moneyCompact(v)}
                  />
                  <Tooltip
                    content={<CustomTooltip />}
                    cursor={{ fill: 'var(--muted)', opacity: 0.3 }}
                  />
                  <Bar
                    dataKey="income"
                    name={t('rep.series.sales')}
                    fill="#6366f1"
                    radius={[3, 3, 0, 0]}
                  />
                  <Bar
                    dataKey="expense"
                    name={t('rep.series.expenses')}
                    fill="#ec4899"
                    radius={[3, 3, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState message={t('rep.emptyTransactions')} />
            )}
          </div>
          <div className="rounded-xl border border-border overflow-hidden bg-card">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-[0.85rem] font-semibold text-foreground">
                {t('rep.invoiceSummary')}
              </h2>
              {hasInvoices && (
                <button
                  onClick={() =>
                    downloadCSV(
                      'invoices.csv',
                      [t('common.status'), t('rep.count'), t('common.total')],
                      (['paid', 'unpaid', 'overdue'] as const).map((s) => {
                        const st = invoiceStatus(s);
                        return [statusLabel(s, t), st.count, Number(st.total)];
                      })
                    )
                  }
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.75rem] text-muted-foreground border border-border hover:text-foreground transition-colors"
                >
                  <Download size={12} /> {t('common.exportCsv')}
                </button>
              )}
            </div>
            {hasInvoices ? (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    {[t('common.status'), t('rep.count'), t('common.total')].map((h) => (
                      <th
                        key={h}
                        className="text-left px-4 py-3 text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(['paid', 'unpaid', 'overdue'] as const).map((s, i) => {
                    const st = invoiceStatus(s);
                    return (
                      <tr
                        key={s}
                        className={`border-b border-border ${i === 2 ? 'border-b-0' : ''}`}
                      >
                        <td className="px-4 py-3 text-[0.8rem] text-foreground">
                          {statusLabel(s, t)}
                        </td>
                        <td className="px-4 py-3 text-[0.8rem] text-muted-foreground">
                          {fmt.number(st.count)}
                        </td>
                        <td className="px-4 py-3 text-[0.8rem] font-semibold text-foreground">
                          {fmt.money(Number(st.total))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <EmptyState message={t('rep.emptyInvoices')} />
            )}
          </div>
        </div>
      )}

      {activeTab === 'Inventory' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-[0.85rem] font-semibold text-foreground mb-4">
              {t('rep.inventoryByProduct')}
            </h2>
            {hasProducts ? (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={inventoryData} layout="vertical">
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke={CHART_COLORS.grid}
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    tick={{ fill: CHART_COLORS.axis, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => fmt.moneyCompact(v)}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fill: CHART_COLORS.axis, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={80}
                  />
                  <Tooltip
                    content={<CustomTooltip />}
                    cursor={{ fill: 'var(--muted)', opacity: 0.3 }}
                  />
                  <Bar
                    dataKey="value"
                    name={t('rep.series.value')}
                    fill="#8b5cf6"
                    radius={[0, 3, 3, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState message={t('rep.emptyProductsChart')} />
            )}
          </div>
          <div className="rounded-xl border border-border overflow-hidden bg-card">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-[0.85rem] font-semibold text-foreground">
                {t('rep.inventoryDetails')}
              </h2>
              {hasProducts && (
                <button
                  onClick={downloadInventory}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.75rem] text-muted-foreground border border-border hover:text-foreground transition-colors"
                >
                  <Download size={12} /> {t('common.exportCsv')}
                </button>
              )}
            </div>
            {hasProducts ? (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    {[
                      t('inv.product'),
                      t('prod.sku'),
                      t('prod.stock'),
                      t('rep.unitCost'),
                      t('rep.totalValue'),
                    ].map((h) => (
                      <th
                        key={h}
                        className="text-left px-4 py-3 text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {products.map((p, i) => (
                    <tr
                      key={p.id}
                      className={`border-b border-border ${i === products.length - 1 ? 'border-b-0' : ''}`}
                    >
                      <td className="px-4 py-3 text-[0.8rem] font-medium text-foreground">
                        {p.name}
                      </td>
                      <td className="px-4 py-3 text-[0.72rem] text-muted-foreground font-mono">
                        {p.sku}
                      </td>
                      <td className="px-4 py-3 text-[0.8rem] text-foreground">
                        {fmt.number(p.currentStock)}
                        {unitText(p.unit)}
                      </td>
                      <td className="px-4 py-3 text-[0.8rem] text-muted-foreground">
                        {fmt.money(p.purchasePrice)}
                      </td>
                      <td className="px-4 py-3 text-[0.8rem] font-semibold text-foreground">
                        {fmt.money(p.value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState message={t('rep.emptyProducts')} />
            )}
          </div>
        </div>
      )}

      {activeTab === 'Cash Flow' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[0.85rem] font-semibold text-foreground">
                {t('rep.monthlyCashFlow')}
              </h2>
              {hasPayments && (
                <button
                  onClick={downloadCashFlow}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.75rem] text-muted-foreground border border-border hover:text-foreground transition-colors"
                >
                  <Download size={12} /> {t('common.exportCsv')}
                </button>
              )}
            </div>
            {monthlyCashFlow.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={monthlyCashFlow}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke={CHART_COLORS.grid}
                    vertical={false}
                  />
                  <XAxis
                    dataKey="month"
                    tick={{ fill: CHART_COLORS.axis, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: CHART_COLORS.axis, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => fmt.moneyCompact(v)}
                  />
                  <Tooltip
                    content={<CustomTooltip />}
                    cursor={{ fill: 'var(--muted)', opacity: 0.3 }}
                  />
                  <Bar
                    dataKey="income"
                    name={t('rep.series.incoming')}
                    fill="#22c55e"
                    radius={[3, 3, 0, 0]}
                  />
                  <Bar
                    dataKey="expense"
                    name={t('rep.series.outgoing')}
                    fill="#ef4444"
                    radius={[3, 3, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState message={t('rep.emptyPayments')} />
            )}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-[0.85rem] font-semibold text-foreground">
                  {t('rep.expenseBreakdown')}
                </h2>
                {expenseData.length > 0 && (
                  <button
                    onClick={() =>
                      downloadCSV(
                        'expense_breakdown.csv',
                        [t('common.category'), t('common.amount'), t('rep.shareCsv')],
                        expenseData.map((e) => [
                          e.name,
                          e.value,
                          totalExpenses > 0 ? ((e.value / totalExpenses) * 100).toFixed(1) : 0,
                        ])
                      )
                    }
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.75rem] text-muted-foreground border border-border hover:text-foreground transition-colors"
                  >
                    <Download size={12} /> {t('common.exportCsv')}
                  </button>
                )}
              </div>
              {expenseData.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={expenseData}
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      dataKey="value"
                      nameKey="name"
                      label={({ name, percent }) =>
                        `${name} ${fmt.number(percent * 100, { maximumFractionDigits: 0 })}%`
                      }
                      labelLine={false}
                      fontSize={10}
                      fill="var(--muted-foreground)"
                    >
                      {expenseData.map((_, idx) => (
                        <Cell
                          key={idx}
                          fill={CHART_COLORS.pieColors[idx % CHART_COLORS.pieColors.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState message={t('rep.emptyExpense')} />
              )}
            </div>
            <div className="rounded-xl border border-border overflow-hidden bg-card">
              <div className="px-4 py-3 border-b border-border">
                <h2 className="text-[0.85rem] font-semibold text-foreground">
                  {t('rep.expenseCategories')}
                </h2>
              </div>
              {expenseData.length > 0 ? (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      {[t('common.category'), t('common.amount'), t('rep.share')].map((h) => (
                        <th
                          key={h}
                          className="text-left px-4 py-3 text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {expenseData.map((e, i) => (
                      <tr
                        key={e.name}
                        className={`border-b border-border ${i === expenseData.length - 1 ? 'border-b-0' : ''}`}
                      >
                        <td className="px-4 py-3 text-[0.8rem] text-foreground">{e.name}</td>
                        <td className="px-4 py-3 text-[0.8rem] font-semibold text-foreground">
                          {fmt.money(e.value)}
                        </td>
                        <td className="px-4 py-3 text-[0.75rem] text-muted-foreground">
                          {fmt.number(totalExpenses > 0 ? (e.value / totalExpenses) * 100 : 0, {
                            minimumFractionDigits: 1,
                            maximumFractionDigits: 1,
                          })}
                          %
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <EmptyState message={t('rep.emptyExpenseCategories')} />
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'Net Cash' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-[0.85rem] font-semibold text-foreground mb-1">
              {t('rep.monthlyNetCash')}
            </h2>
            <p className="text-[0.72rem] text-muted-foreground mb-4">{t('rep.cashBasisNote')}</p>
            {profitData.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={profitData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke={CHART_COLORS.grid}
                    vertical={false}
                  />
                  <XAxis
                    dataKey="month"
                    tick={{ fill: CHART_COLORS.axis, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: CHART_COLORS.axis, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => fmt.moneyCompact(v)}
                  />
                  <Tooltip
                    content={<CustomTooltip />}
                    cursor={{ fill: 'var(--muted)', opacity: 0.3 }}
                  />
                  <Bar
                    dataKey="profit"
                    name={t('rep.series.netCash')}
                    fill="#10b981"
                    radius={[3, 3, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState message={t('rep.emptyNetCash')} />
            )}
          </div>
          <div className="rounded-xl border border-border overflow-hidden bg-card">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-[0.85rem] font-semibold text-foreground">
                {t('rep.netCashBreakdown')}
              </h2>
              {monthlyTxnFlow.length > 0 && (
                <button
                  onClick={downloadProfit}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.75rem] text-muted-foreground border border-border hover:text-foreground transition-colors"
                >
                  <Download size={12} /> {t('common.exportCsv')}
                </button>
              )}
            </div>
            {monthlyTxnFlow.length > 0 ? (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    {[
                      t('cash.month'),
                      t('cash.seriesIn'),
                      t('cash.seriesOut'),
                      t('rep.series.netCash'),
                      t('rep.netPerCashIn'),
                    ].map((h) => (
                      <th
                        key={h}
                        className="text-left px-4 py-3 text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {monthlyTxnFlow.map((m, i) => {
                    const profit = m.income - m.expense;
                    const margin = m.income > 0 ? (profit / m.income) * 100 : 0;
                    return (
                      <tr
                        key={m.month}
                        className={`border-b border-border ${i === monthlyTxnFlow.length - 1 ? 'border-b-0' : ''}`}
                      >
                        <td className="px-4 py-3 text-[0.8rem] font-medium text-foreground">
                          {m.month}
                        </td>
                        <td className="px-4 py-3 text-[0.8rem] text-foreground">
                          {fmt.money(m.income)}
                        </td>
                        <td className="px-4 py-3 text-[0.8rem] text-muted-foreground">
                          {fmt.money(m.expense)}
                        </td>
                        <td
                          className={`px-4 py-3 text-[0.8rem] font-semibold ${profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
                        >
                          {fmt.money(profit)}
                        </td>
                        <td className="px-4 py-3 text-[0.75rem] text-muted-foreground">
                          {fmt.number(margin, {
                            minimumFractionDigits: 1,
                            maximumFractionDigits: 1,
                          })}
                          %
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <EmptyState message={t('rep.emptyMonthly')} />
            )}
          </div>
        </div>
      )}

      {activeTab === 'Audit Log' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-[0.75rem] text-muted-foreground">
                {t('rep.audit.filter')}
              </label>
              <CustomSelect
                value={auditFilter}
                onChange={(v) => {
                  setAuditFilter(v);
                  setAuditPage(0);
                }}
                options={auditFilterOptions}
              />
            </div>
            <button
              onClick={loadAuditLogs}
              disabled={auditLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.75rem] text-muted-foreground border border-border hover:text-foreground transition-colors disabled:opacity-40"
            >
              <RefreshCw size={12} className={auditLoading ? 'animate-spin' : ''} />
              {t('common.refresh')}
            </button>
            {auditLogs.length > 0 && (
              <button
                onClick={downloadAuditLog}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.75rem] text-muted-foreground border border-border hover:text-foreground transition-colors"
              >
                <Download size={12} /> {t('common.exportCsv')}
              </button>
            )}
          </div>

          <div className="flex items-center gap-4">
            {Object.entries(ACTION_COLORS).map(([action, color]) => (
              <div key={action} className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full" style={{ background: color }} />
                <span className="text-[0.7rem] text-muted-foreground">
                  {t(`rep.action.${action}` as MessageKey)}
                </span>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-border overflow-hidden bg-card">
            {auditLoading ? (
              <div className="flex items-center justify-center py-16">
                <div className="w-5 h-5 border-2 border-border border-t-foreground/60 rounded-full animate-spin" />
              </div>
            ) : auditError ? (
              <div className="px-4 py-6 text-center">
                <p className="text-[0.8rem] text-red-600 dark:text-red-400">{auditError}</p>
                <button
                  onClick={loadAuditLogs}
                  className="mt-2 text-[0.75rem] text-muted-foreground hover:text-foreground underline"
                >
                  {t('common.retry')}
                </button>
              </div>
            ) : auditLogs.length === 0 ? (
              <EmptyState message={t('rep.audit.empty')} />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[700px]">
                    <thead>
                      <tr className="border-b border-border">
                        {[
                          t('rep.audit.timestamp'),
                          t('rep.audit.module'),
                          t('rep.audit.action'),
                          t('rep.audit.changedBy'),
                          t('rep.audit.changes'),
                        ].map((h) => (
                          <th
                            key={h}
                            className="text-left px-4 py-3 text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {auditLogs.map((log, i) => {
                        const actionColor = ACTION_COLORS[log.action] || '#888888';
                        const diff = formatDiff(log.beforeData, log.afterData, log.action);
                        const dateStr = fmt.dateTime(log.createdAt);
                        return (
                          <tr
                            key={log.id}
                            className={`border-b border-border ${i === auditLogs.length - 1 ? 'border-b-0' : ''}`}
                          >
                            <td className="px-4 py-3 text-[0.72rem] text-muted-foreground font-mono whitespace-nowrap">
                              {dateStr}
                            </td>
                            <td className="px-4 py-3 text-[0.8rem] text-foreground">
                              {tableLabel(log.tableName, t)}
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className="inline-flex items-center px-2 py-0.5 rounded text-[0.68rem] font-semibold uppercase tracking-wider"
                                style={{
                                  background: `${actionColor}18`,
                                  color: actionColor,
                                  border: `1px solid ${actionColor}30`,
                                }}
                              >
                                {hasMessage(`rep.action.${log.action}`)
                                  ? t(`rep.action.${log.action}` as MessageKey)
                                  : log.action}
                              </span>
                            </td>
                            <td
                              className="px-4 py-3 text-[0.75rem] text-muted-foreground max-w-[140px] truncate"
                              title={log.changedBy}
                            >
                              {log.changedBy}
                            </td>
                            <td className="px-4 py-3 text-[0.75rem] text-muted-foreground max-w-[280px]">
                              <span className="line-clamp-2" title={diff}>
                                {diff}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="px-4 py-3 border-t border-border flex items-center justify-between">
                  <span className="text-[0.72rem] text-muted-foreground">
                    {t('rep.audit.showing', {
                      from: auditPage * AUDIT_PAGE_SIZE + 1,
                      to: auditPage * AUDIT_PAGE_SIZE + auditLogs.length,
                    })}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setAuditPage((p) => Math.max(0, p - 1))}
                      disabled={auditPage === 0}
                      className="px-3 py-1 rounded text-[0.75rem] border border-border text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
                    >
                      {t('common.previous')}
                    </button>
                    <span className="text-[0.72rem] text-muted-foreground">
                      {t('common.page', { page: auditPage + 1 })}
                    </span>
                    <button
                      onClick={() => setAuditPage((p) => p + 1)}
                      disabled={auditLogs.length < AUDIT_PAGE_SIZE}
                      className="px-3 py-1 rounded text-[0.75rem] border border-border text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
                    >
                      {t('common.next')}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
