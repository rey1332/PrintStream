'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { createClient } from '@/lib/data/client';
import { dashboardService } from './lib/erpService';
import type { FinancialMetrics } from './lib/erpRules';
import { realtimeFilter, rpcWorkspaceId } from './lib/workspace';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { txCategoryLabel } from '@/lib/i18n/labels';
import { useConsolePageContext } from '@/lib/console/bridge';
import { useDisplayConversion, type DisplayConversion } from './lib/useCurrency';
import { ConvertedAmount, DisplayBasis } from './components/CurrencyFields';
import {
  AgingDonut,
  BankBalances,
  KpiTile,
  MonthlyTrend,
  RankedBars,
  Widget,
  WidgetState,
} from './components/DashboardWidgets';
import { AGING_KEYS, type DashboardInsights } from './lib/dashboardInsights';
import { financeService, type CashAccount } from './lib/financeService';
import {
  TrendingUp,
  CreditCard,
  Wallet,
  Package,
  ShoppingCart,
  DollarSign,
  AlertTriangle,
  X,
  RefreshCw,
  ChevronRight,
  FileText,
  ClipboardList,
} from 'lucide-react';
import Link from 'next/link';

// ─── Thresholds ────────────────────────────────────────────────────────────────
const DEFAULT_THRESHOLDS = { cash: 5000, expenseRatio: 85, inventory: 10000 };

// ─── Types ─────────────────────────────────────────────────────────────────────
interface Alert {
  id: string;
  type: 'cash' | 'expense' | 'inventory';
  message: MessageKey;
  detail: MessageKey;
  values: { amount?: number; threshold: number; pct?: number };
  severity: 'critical' | 'warning';
}

interface MetricCard {
  label: MessageKey;
  value: number;
  icon: React.ElementType;
  status: 'critical' | 'warning' | null;
}

// ─── Alert Banner (subtle, solid, opaque) ──────────────────────────────────────
function AlertBanner({ alerts, onDismiss }: { alerts: Alert[]; onDismiss: (id: string) => void }) {
  const { t, fmt } = useI18n();
  if (alerts.length === 0) return null;

  return (
    <div className="space-y-2">
      {alerts.map((a) => {
        const accent = a.severity === 'critical' ? 'var(--negative)' : 'var(--warning, #f59e0b)';
        return (
          <div
            key={a.id}
            className="rounded-xl border border-border bg-card px-4 py-3 flex items-start gap-3"
            style={{ borderLeftWidth: '3px', borderLeftColor: accent }}
          >
            <div
              className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5"
              style={{ background: 'var(--surface-3)' }}
            >
              <AlertTriangle size={12} style={{ color: accent }} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[0.8rem] font-semibold text-foreground">{t(a.message)}</p>
              <p className="text-[0.72rem] text-muted-foreground mt-0.5 leading-relaxed">
                {t(
                  a.detail,
                  a.type === 'expense'
                    ? { pct: a.values.pct ?? 0, threshold: fmt.number(a.values.threshold) }
                    : {
                        amount: fmt.money(a.values.amount ?? 0),
                        threshold: fmt.money(a.values.threshold),
                      }
                )}
              </p>
            </div>
            <button
              onClick={() => onDismiss(a.id)}
              className="p-1 rounded-md flex-shrink-0 text-muted-foreground opacity-60 hover:opacity-100 transition-opacity"
              aria-label={t('common.dismiss')}
              title={t('common.dismiss')}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── KPI Card (clean, uniform) ─────────────────────────────────────────────────
function KPICard({
  label,
  value,
  icon: Icon,
  status,
  loading,
  convert,
}: MetricCard & { loading: boolean; convert: (amount: number) => DisplayConversion | null }) {
  const { t, fmt } = useI18n();
  const isNegative = value < 0;

  const statusColor =
    status === 'critical'
      ? 'var(--negative)'
      : status === 'warning'
        ? 'var(--warning, #f59e0b)'
        : 'transparent';

  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-2.5 max-lg:min-w-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--surface-3)' }}
          >
            <Icon size={12} className="text-muted-foreground" />
          </div>
          <p className="text-[0.68rem] uppercase tracking-wider font-medium text-muted-foreground">
            {t(label)}
          </p>
        </div>

        {status && (
          <div
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-full"
            style={{ background: 'var(--surface-3)' }}
            title={status === 'critical' ? t('common.critical') : t('common.warning')}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor }} />
            <span
              className="text-[0.58rem] font-bold uppercase tracking-wider"
              style={{ color: statusColor }}
            >
              {status === 'critical' ? t('common.critical') : t('common.warning')}
            </span>
          </div>
        )}
      </div>

      <p
        className={`text-[1.5rem] font-bold leading-none tracking-tight max-lg:text-[1.25rem] max-lg:[overflow-wrap:anywhere] ${
          isNegative ? 'text-muted-foreground' : 'text-foreground'
        }`}
      >
        {loading ? (
          <span className="inline-block w-20 h-6 rounded animate-pulse bg-[var(--surface-3)]" />
        ) : (
          fmt.money(value)
        )}
      </p>
      {!loading && <ConvertedAmount conversion={convert(value)} />}
    </div>
  );
}

// ─── Live Indicator ────────────────────────────────────────────────────────────
function LiveIndicator({ active }: { active: boolean }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ background: active ? 'var(--positive)' : 'var(--muted-foreground)' }}
      />
      <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-medium">
        {active ? t('common.live') : t('common.offline')}
      </span>
    </span>
  );
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────
export default function ERPDashboard() {
  const { user } = useAuth();
  const { t, fmt } = useI18n();
  const { convert, display, base } = useDisplayConversion();
  const [metrics, setMetrics] = useState<FinancialMetrics>({
    cashIn: 0,
    cashOut: 0,
    netCash: 0,
    invoicedRevenue: 0,
    accountsReceivable: 0,
    accountsPayable: 0,
    committedPurchases: 0,
    supplierPrepayments: 0,
    inventoryValue: 0,
    totalRevenue: 0,
    totalExpenses: 0,
    cashBalance: 0,
  });
  const [recentTransactions, setRecentTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());
  const [realtimeActive, setRealtimeActive] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS);
  // null = not available (a role without that read, or a database without the function).
  const [insights, setInsights] = useState<DashboardInsights | null>(null);
  const [accounts, setAccounts] = useState<CashAccount[] | null>(null);

  const fetchTimerRef = useRef<NodeJS.Timeout | null>(null);
  const statusTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingStatusRef = useRef<boolean>(false);
  const userId = user?.id;

  const fetchMetrics = useCallback(async (uid: string) => {
    try {
      const db = createClient();
      const [m, recentTxns, settingsResult, insightsResult, accountsResult] = await Promise.all([
        dashboardService.getMetrics(uid),
        dashboardService.getRecentTransactions(uid, 7),
        // Thresholds of the open ERP (db/migrations/20261012000005_erp_workspace_settings.sql).
        db.rpc('erp_workspace_settings_get', { p_workspace_id: rpcWorkspaceId() }),
        // Each widget group fails on its own: an empty state, never invented figures.
        dashboardService.getInsights().catch((err) => {
          console.error('[dashboard insights]', err);
          return null;
        }),
        financeService.accounts().catch(() => null),
      ]);
      setInsights(insightsResult);
      setAccounts(accountsResult);

      const savedSettings = settingsResult.data;
      const activeThresholds = savedSettings
        ? {
            cash: Number(savedSettings.cash_low_threshold ?? DEFAULT_THRESHOLDS.cash),
            expenseRatio: Number(
              savedSettings.expense_spike_ratio ?? DEFAULT_THRESHOLDS.expenseRatio
            ),
            inventory: Number(
              savedSettings.inventory_low_threshold ?? DEFAULT_THRESHOLDS.inventory
            ),
          }
        : DEFAULT_THRESHOLDS;
      setThresholds(activeThresholds);

      const { cashIn, cashOut, netCash, inventoryValue } = m;

      setMetrics(m);
      setRecentTransactions(recentTxns);
      setLastUpdated(new Date());

      const newAlerts: Alert[] = [];

      if (netCash < activeThresholds.cash) {
        newAlerts.push({
          id: 'cash-low',
          type: 'cash',
          severity: 'critical',
          message: 'alert.cashLow.title',
          detail: 'alert.cashLow.detail',
          values: { amount: netCash, threshold: activeThresholds.cash },
        });
      }

      // Both sides are cash (recorded payments), never invoices vs. payments.
      if (cashIn > 0 && cashOut / cashIn > activeThresholds.expenseRatio / 100) {
        const pct = Math.round((cashOut / cashIn) * 100);
        newAlerts.push({
          id: 'expense-spike',
          type: 'expense',
          severity: 'warning',
          message: 'alert.cashOut.title',
          detail: 'alert.cashOut.detail',
          values: { pct, threshold: activeThresholds.expenseRatio },
        });
      }

      if (inventoryValue < activeThresholds.inventory) {
        newAlerts.push({
          id: 'inventory-low',
          type: 'inventory',
          severity: 'warning',
          message: 'alert.inventoryLow.title',
          detail: 'alert.inventoryLow.detail',
          values: { amount: inventoryValue, threshold: activeThresholds.inventory },
        });
      }

      setAlerts(newAlerts);
    } catch (err) {
      console.error('[fetchMetrics]', err);
    }
  }, []);

  // The app-wide console (ConsoleHost) shows these metrics and refreshes after data commands.
  const refreshForConsole = useCallback(() => {
    if (userId) fetchMetrics(userId);
  }, [userId, fetchMetrics]);
  useConsolePageContext({ metrics, onDataChange: refreshForConsole });

  // ✅ Debounce fetch dari realtime events
  const debouncedFetch = useCallback(
    (uid: string) => {
      if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
      fetchTimerRef.current = setTimeout(() => fetchMetrics(uid), 400);
    },
    [fetchMetrics]
  );

  // ✅ Stabilkan realtime status
  const handleRealtimeStatus = useCallback((isActive: boolean) => {
    pendingStatusRef.current = isActive;
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => {
      setRealtimeActive((prev) =>
        prev === pendingStatusRef.current ? prev : pendingStatusRef.current
      );
    }, 1500);
  }, []);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    fetchMetrics(userId).finally(() => {
      if (!cancelled) setLoading(false);
    });

    const db = createClient();
    const scopeFilter = realtimeFilter(userId);
    const channel = db
      .channel('erp_dashboard_realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'erp_transactions', filter: scopeFilter },
        () => debouncedFetch(userId)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'erp_products', filter: scopeFilter },
        () => debouncedFetch(userId)
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'erp_purchase_orders',
          filter: scopeFilter,
        },
        () => debouncedFetch(userId)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'erp_invoices', filter: scopeFilter },
        () => debouncedFetch(userId)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'erp_payments', filter: scopeFilter },
        () => debouncedFetch(userId)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'erp_settings', filter: `user_id=eq.${userId}` },
        () => debouncedFetch(userId)
      )
      .subscribe((status) => handleRealtimeStatus(status === 'SUBSCRIBED'));

    return () => {
      cancelled = true;
      if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      db.removeChannel(channel);
      setRealtimeActive(false);
    };
  }, [userId, fetchMetrics, debouncedFetch, handleRealtimeStatus]);

  const visibleAlerts = alerts.filter((a) => !dismissedAlerts.has(a.id));

  function dismissAlert(id: string) {
    setDismissedAlerts((prev) => new Set([...prev, id]));
  }

  // Status per KPI card
  const cashCritical = metrics.netCash < thresholds.cash;
  const inventoryWarning = metrics.inventoryValue < thresholds.inventory;
  const expenseWarning =
    metrics.cashIn > 0 && metrics.cashOut / metrics.cashIn > thresholds.expenseRatio / 100;

  // Cash = recorded payments only. Kept apart from accrual figures below.
  const CASH_CARDS: MetricCard[] = [
    { label: 'metric.cashIn', value: metrics.cashIn, icon: TrendingUp, status: null },
    {
      label: 'metric.cashOut',
      value: metrics.cashOut,
      icon: CreditCard,
      status: expenseWarning ? 'warning' : null,
    },
    {
      label: 'metric.netCash',
      value: metrics.netCash,
      icon: Wallet,
      status: cashCritical ? 'critical' : null,
    },
  ];

  const POSITION_CARDS: MetricCard[] = [
    { label: 'metric.ar', value: metrics.accountsReceivable, icon: ShoppingCart, status: null },
    { label: 'metric.ap', value: metrics.accountsPayable, icon: DollarSign, status: null },
    {
      label: 'metric.committed',
      value: metrics.committedPurchases,
      icon: ClipboardList,
      status: null,
    },
    { label: 'metric.invoiced', value: metrics.invoicedRevenue, icon: FileText, status: null },
    {
      label: 'metric.inventory',
      value: metrics.inventoryValue,
      icon: Package,
      status: inventoryWarning ? 'warning' : null,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground tracking-tight">
            {t('dash.title')}
          </h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">
            {loading ? t('dash.loadingMetrics') : t('dash.financialOverview')}
          </p>
        </div>
        <div className="flex items-center gap-3 text-[0.7rem] pt-0.5">
          <LiveIndicator active={realtimeActive} />
          {lastUpdated && !loading && (
            <span className="hidden sm:block text-muted-foreground">
              {t('common.updatedAt', { time: fmt.time(lastUpdated) })}
            </span>
          )}
          <button
            onClick={() => userId && fetchMetrics(userId)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors"
            title={t('common.refresh')}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      <DisplayBasis convert={convert} display={display} base={base} />

      {!loading && <AlertBanner alerts={visibleAlerts} onDismiss={dismissAlert} />}

      {/* Receivables, revenue and trends: dense, widget by widget. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 space-y-3 min-w-0">
          <div className="grid grid-cols-1 min-[420px]:grid-cols-2 xl:grid-cols-4 gap-3">
            <KpiTile
              loading={loading}
              label={t('dash.kpi.customersPastDue')}
              value={insights ? fmt.number(insights.receivables.customersPastDue) : '—'}
              hint={
                insights
                  ? t('dash.kpi.customersPastDueHint', {
                      n: fmt.number(insights.receivables.invoicesPastDue),
                    })
                  : t('dash.unavailable')
              }
              tone={insights && insights.receivables.customersPastDue > 0 ? 'warning' : null}
            />
            <KpiTile
              loading={loading}
              label={t('dash.kpi.balanceDue')}
              value={insights ? fmt.moneyCompact(insights.receivables.balanceDue) : '—'}
              hint={
                insights
                  ? t('dash.kpi.balanceDueHint', {
                      amount: fmt.money(insights.receivables.pastDue),
                    })
                  : t('dash.unavailable')
              }
            />
            <KpiTile
              loading={loading}
              label={t('dash.kpi.overLimit')}
              value={insights ? fmt.moneyCompact(insights.credit.overLimit) : '—'}
              hint={
                !insights
                  ? t('dash.unavailable')
                  : insights.credit.customersWithLimit === 0
                    ? t('dash.kpi.noLimits')
                    : t('dash.kpi.overLimitHint', {
                        n: fmt.number(insights.credit.customersOver),
                        total: fmt.number(insights.credit.customersWithLimit),
                      })
              }
              tone={insights && insights.credit.overLimit > 0 ? 'critical' : null}
            />
            <KpiTile
              loading={loading}
              label={t('dash.kpi.revenue')}
              value={insights ? fmt.moneyCompact(insights.revenue.total) : '—'}
              hint={
                insights
                  ? t('dash.kpi.revenueHint', { n: fmt.number(insights.revenue.invoices) })
                  : t('dash.unavailable')
              }
            />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <Widget
              title={t('dash.w.topProducts')}
              subtitle={t('dash.w.last12')}
              href="/erp/products"
            >
              {loading || !insights || insights.topProducts.length === 0 ? (
                <WidgetState
                  loading={loading}
                  empty={insights ? t('dash.empty.products') : t('dash.unavailable')}
                />
              ) : (
                <RankedBars items={insights.topProducts} />
              )}
            </Widget>
            <Widget
              title={t('dash.w.topCustomers')}
              subtitle={t('dash.w.last12')}
              href="/erp/customers"
            >
              {loading || !insights || insights.topCustomers.length === 0 ? (
                <WidgetState
                  loading={loading}
                  empty={insights ? t('dash.empty.customers') : t('dash.unavailable')}
                />
              ) : (
                <RankedBars items={insights.topCustomers} />
              )}
            </Widget>
          </div>
        </div>

        <div className="space-y-3 min-w-0">
          <Widget title={t('dash.w.aging')} href="/erp/invoices">
            {loading || !insights || AGING_KEYS.every((k) => insights.aging[k] === 0) ? (
              <WidgetState
                loading={loading}
                height={150}
                empty={insights ? t('dash.empty.aging') : t('dash.unavailable')}
              />
            ) : (
              <AgingDonut aging={insights.aging} />
            )}
          </Widget>
          <Widget
            title={t('dash.w.bank')}
            subtitle={base ? t('dash.w.ledgerBase', { currency: base }) : undefined}
            href="/erp/cash-bank"
          >
            {loading || !accounts || accounts.length === 0 ? (
              <WidgetState
                loading={loading}
                height={120}
                empty={accounts ? t('dash.empty.bank') : t('dash.unavailable')}
              />
            ) : (
              <BankBalances accounts={accounts} currency={base ?? ''} />
            )}
          </Widget>
        </div>
      </div>

      <Widget title={t('dash.w.trend')} subtitle={t('dash.w.last12')} href="/erp/cash-flow">
        {loading || !insights ? (
          <WidgetState loading={loading} height={220} empty={t('dash.unavailable')} />
        ) : (
          <MonthlyTrend months={insights.months} />
        )}
      </Widget>

      <section className="space-y-2">
        <h2 className="text-[0.68rem] font-semibold uppercase tracking-widest text-muted-foreground">
          {t('dash.cashSection')}
        </h2>
        <div className="grid grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-3 gap-3">
          {CASH_CARDS.map((card) => (
            <KPICard key={card.label} {...card} loading={loading} convert={convert} />
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-[0.68rem] font-semibold uppercase tracking-widest text-muted-foreground">
          {t('dash.positionSection')}
        </h2>
        <div className="grid grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-3 gap-3">
          {POSITION_CARDS.map((card) => (
            <KPICard key={card.label} {...card} loading={loading} convert={convert} />
          ))}
        </div>
        {!loading && metrics.supplierPrepayments > 0 && (
          <p className="text-[0.7rem] text-muted-foreground">
            {t('dash.supplierPrepayments', { amount: fmt.money(metrics.supplierPrepayments) })}
          </p>
        )}
      </section>

      <div className="rounded-xl border border-border overflow-hidden bg-card">
        <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
          <h2 className="text-[0.8125rem] font-semibold text-foreground">
            {t('dash.recentTransactions')}
          </h2>
          <div className="flex items-center gap-3">
            {realtimeActive && (
              <span className="text-[0.62rem] text-muted-foreground italic">
                {t('common.autoUpdating')}
              </span>
            )}
            <Link
              href="/erp/cash-flow"
              className="flex items-center gap-1 text-[0.7rem] text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('common.viewAll')} <ChevronRight size={11} />
            </Link>
          </div>
        </div>

        {loading ? (
          <div className="p-5 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-10 rounded animate-pulse bg-[var(--surface-3)]" />
            ))}
          </div>
        ) : recentTransactions.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[0.8rem] text-muted-foreground">{t('dash.noTransactions')}</p>
            <p className="text-[0.7rem] text-muted-foreground mt-1 opacity-70">
              <Link
                href="/erp/invoices"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t('dash.createInvoice')}
              </Link>{' '}
              {t('dash.or')}{' '}
              <Link
                href="/erp/payments"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t('dash.recordPayment')}
              </Link>
            </p>
          </div>
        ) : (
          // Phones: the table scrolls sideways inside the card instead of being cut off.
          <div className="max-lg:overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {[
                    t('common.date'),
                    t('common.description'),
                    t('common.category'),
                    t('common.type'),
                    t('common.amount'),
                  ].map((h, i) => (
                    <th
                      key={h}
                      className={`py-2.5 px-5 text-[0.62rem] font-semibold uppercase tracking-wider text-muted-foreground ${
                        i === 4 ? 'text-right' : 'text-left'
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentTransactions.map((txn: any, i) => {
                  const isIncome = txn.type === 'income';
                  return (
                    <tr
                      key={txn.id}
                      className={`border-b border-border ${i === recentTransactions.length - 1 ? 'border-b-0' : ''}`}
                    >
                      <td className="py-3 px-5 text-[0.72rem] font-mono text-muted-foreground whitespace-nowrap">
                        {fmt.date(txn.date)}
                      </td>
                      <td className="py-3 px-5 text-[0.8rem] text-foreground truncate max-w-[240px]">
                        {txn.description}
                      </td>
                      <td className="py-3 px-5">
                        <span
                          className="inline-flex items-center text-[0.68rem] text-muted-foreground px-1.5 py-0.5 rounded"
                          style={{ background: 'var(--surface-3)' }}
                        >
                          {txCategoryLabel(txn.category, t)}
                        </span>
                      </td>
                      <td className="py-3 px-5">
                        <span className="inline-flex items-center gap-1 text-[0.68rem] text-muted-foreground">
                          <span
                            className="w-1 h-1 rounded-full"
                            style={{ background: isIncome ? 'var(--positive)' : 'var(--negative)' }}
                          />
                          <span>{isIncome ? t('txtype.income') : t('txtype.expense')}</span>
                        </span>
                      </td>
                      <td
                        className="py-3 px-5 text-[0.8rem] font-semibold text-right tabular-nums"
                        style={{ color: isIncome ? 'var(--positive)' : 'var(--negative)' }}
                      >
                        {isIncome ? '+' : '−'}
                        {fmt.money(txn.amount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
