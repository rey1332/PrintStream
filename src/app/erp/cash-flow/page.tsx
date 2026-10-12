'use client';

import React, { useEffect, useState } from 'react';
import { transactionService, cashFlowSummary } from '../lib/erpService';
import { useAuth } from '@/contexts/AuthContext';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from 'recharts';
import { Download, Search } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { txCategoryLabel } from '@/lib/i18n/labels';
import { Pagination, useServerPage } from '../components/Pagination';

interface Transaction {
  id: string;
  type: string;
  category: string;
  amount: number;
  date: string;
  description: string;
  isReversal?: boolean;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  const { fmt } = useI18n();
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-[0.75rem]">
      <p className="text-muted-foreground mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: {fmt.money(p.value ?? 0)}
        </p>
      ))}
    </div>
  );
};

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

export default function CashFlowPage() {
  const { user } = useAuth();
  const { t, fmt } = useI18n();
  const [figures, setFigures] = useState<Awaited<ReturnType<typeof cashFlowSummary>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // The ledger, one page at a time (a link from ERP → Search shows one entry).
  const ledger = useServerPage<Transaction>(
    (q) =>
      user?.id ? transactionService.page(user.id, q) : Promise.resolve({ rows: [], total: 0 }),
    [user?.id]
  );

  useEffect(() => {
    if (!user?.id) return;
    cashFlowSummary()
      .then(setFigures)
      .catch((err: Error) => setError(err.message));
  }, [user?.id]);

  useEffect(() => {
    if (ledger.error) setError(ledger.error instanceof Error ? ledger.error.message : '');
  }, [ledger.error]);

  const loading = !figures && !error;
  const income = figures?.income ?? 0;
  const expense = figures?.expense ?? 0;
  const net = income - expense;
  const monthlyData = (figures?.monthly ?? []).map((m) => {
    const [year, month] = m.month.split('-').map(Number);
    return { month: fmt.month(new Date(year, month - 1, 1)), income: m.income, expense: m.expense };
  });
  const netFlow = monthlyData.map((m) => ({ ...m, net: m.income - m.expense }));

  async function downloadTransactions() {
    if (!user?.id || exporting) return;
    setExporting(true);
    let transactions: Transaction[];
    try {
      transactions = await transactionService.getAll(user.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    } finally {
      setExporting(false);
    }
    downloadCSV(
      'cash_flow_transactions.csv',
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

  function downloadMonthlyChart() {
    downloadCSV(
      'cash_flow_monthly.csv',
      [t('cash.month'), t('cash.seriesIn'), t('cash.seriesOut'), t('cash.seriesNet')],
      monthlyData.map((m) => [m.month, m.income, m.expense, m.income - m.expense])
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[1.25rem] font-bold text-foreground">{t('cash.title')}</h1>
        <p className="text-[0.8rem] text-muted-foreground mt-0.5">{t('cash.subtitle')}</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-muted border-t-foreground/70 rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-border bg-card p-6 text-center">
          <p className="text-muted-foreground text-[0.85rem]">{t('cash.failed', { error })}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-[0.68rem] uppercase tracking-wider text-muted-foreground mb-2">
                {t('cash.in')}
              </p>
              <p className="text-[1.4rem] font-bold text-foreground">{fmt.money(income)}</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-[0.68rem] uppercase tracking-wider text-muted-foreground mb-2">
                {t('cash.out')}
              </p>
              <p className="text-[1.4rem] font-bold text-muted-foreground">{fmt.money(expense)}</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-[0.68rem] uppercase tracking-wider text-muted-foreground mb-2">
                {t('cash.net')}
              </p>
              <p
                className={`text-[1.4rem] font-bold ${net >= 0 ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                {figures?.payments ? `${net >= 0 ? '+' : ''}${fmt.money(net)}` : '—'}
              </p>
            </div>
          </div>

          {!figures?.transactions && !figures?.payments ? (
            <div className="rounded-xl border border-border bg-card p-12 text-center">
              <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 bg-muted">
                <svg
                  className="w-6 h-6 text-muted-foreground opacity-40"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
              <p className="text-foreground text-[0.9rem] font-medium mb-1">{t('cash.empty')}</p>
              <p className="text-muted-foreground text-[0.78rem]">{t('cash.emptyHint')}</p>
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-[0.85rem] font-semibold text-card-foreground">
                    {t('cash.monthly')}
                  </h2>
                  <button
                    onClick={downloadMonthlyChart}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.75rem] text-muted-foreground border border-border hover:text-foreground transition-colors"
                  >
                    <Download size={12} /> {t('common.exportCsv')}
                  </button>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={monthlyData} barGap={4}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="month"
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => fmt.moneyCompact(v)}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar
                      dataKey="income"
                      name={t('cash.seriesIn')}
                      fill="var(--foreground)"
                      radius={[3, 3, 0, 0]}
                    />
                    <Bar
                      dataKey="expense"
                      name={t('cash.seriesOut')}
                      fill="var(--muted-foreground)"
                      radius={[3, 3, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="rounded-xl border border-border bg-card p-4">
                <h2 className="text-[0.85rem] font-semibold text-card-foreground mb-4">
                  {t('cash.netPosition')}
                </h2>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={netFlow}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="month"
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => fmt.moneyCompact(v)}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="net"
                      name={t('cash.seriesNet')}
                      stroke="var(--foreground)"
                      fill="var(--surface-3)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="rounded-xl border border-border overflow-hidden bg-card">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                  <div>
                    <h2 className="text-[0.85rem] font-semibold text-card-foreground">
                      {t('cash.ledger')}
                    </h2>
                    <p className="text-[0.7rem] text-muted-foreground">{t('cash.ledgerHint')}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative">
                      <Search
                        size={13}
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                      />
                      <input
                        value={ledger.search}
                        onChange={(e) => ledger.setSearch(e.target.value)}
                        placeholder={t('common.search')}
                        aria-label={`${t('common.search')}: ${t('cash.ledger')}`}
                        className="w-48 rounded-lg border border-border bg-input pl-8 pr-3 py-1.5 text-[0.75rem] text-foreground placeholder:text-muted-foreground outline-none focus:border-foreground/40"
                      />
                    </div>
                    <button
                      onClick={() => void downloadTransactions()}
                      disabled={exporting}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.75rem] text-muted-foreground border border-border hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      <Download size={12} /> {t('common.exportCsv')}
                    </button>
                  </div>
                </div>
                {ledger.focusId && (
                  <div className="flex items-center justify-between gap-3 border-b border-border bg-[var(--surface-2)] px-4 py-2 text-[0.78rem] text-muted-foreground">
                    <span>{t('common.focusOnly')}</span>
                    <button
                      type="button"
                      onClick={ledger.showAll}
                      className="font-medium text-foreground underline"
                    >
                      {t('common.showAll')}
                    </button>
                  </div>
                )}
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      {[
                        t('common.date'),
                        t('common.description'),
                        t('common.category'),
                        t('common.type'),
                        t('common.amount'),
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
                    {ledger.items.length === 0 && !ledger.loading && (
                      <tr>
                        <td
                          colSpan={5}
                          className="px-4 py-6 text-center text-[0.8rem] text-muted-foreground"
                        >
                          {ledger.search.trim() ? t('picker.noMatches') : t('cash.empty')}
                        </td>
                      </tr>
                    )}
                    {ledger.items.map((txn, i) => (
                      <tr
                        key={txn.id}
                        {...ledger.focusAttrs(txn.id)}
                        className={`border-b border-border ${i === ledger.items.length - 1 ? 'border-b-0' : ''}`}
                      >
                        <td className="px-4 py-3 text-[0.75rem] text-muted-foreground">
                          {fmt.date(txn.date)}
                        </td>
                        <td className="px-4 py-3 text-[0.8rem] text-foreground">
                          {txn.description}
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded text-[0.68rem] text-muted-foreground bg-muted">
                            {txCategoryLabel(txn.category, t)}
                          </span>
                          {txn.isReversal && (
                            <span className="ml-1 px-1.5 py-0.5 rounded text-[0.62rem] text-amber-700 dark:text-amber-400 border border-amber-300/60">
                              {t('cash.reversal')}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-[0.75rem] text-muted-foreground">
                          {txn.type === 'income' ? t('txtype.income') : t('txtype.expense')}
                        </td>
                        <td
                          className={`px-4 py-3 text-[0.8rem] font-semibold ${txn.type === 'income' ? 'text-foreground' : 'text-muted-foreground'}`}
                        >
                          {txn.type === 'income' ? '+' : '−'}
                          {fmt.money(txn.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pagination {...ledger.props} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
