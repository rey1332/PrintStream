'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { accountingService } from '../lib/accountingService';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { invoiceService, listSummary } from '../lib/erpService';
import { RecordPicker } from '../components/RecordPicker';
import { useRecordSearch } from '../lib/pickers';
import type { InvoicePaymentState } from '../lib/erpRules';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { tr } from '@/lib/i18n/translate';
import { useWorkspace } from '../lib/WorkspaceContext';
import { ReasonDialog } from '../components/ReasonDialog';
import { Plus, FileText, X, Check, Ban, Printer, Search } from 'lucide-react';
import { Pagination, useServerPage } from '../components/Pagination';
import {
  InvoiceLinesEditor,
  invoiceLinesNet,
  newInvoiceLine,
  type InvoiceLine,
} from '../components/InvoiceLinesEditor';
import { useCurrencySettings } from '../lib/useCurrency';
import {
  BaseEquivalent,
  CurrencySelect,
  EMPTY_RATE,
  RateField,
  rateForServer,
  type RateChoice,
} from '../components/CurrencyFields';

interface Invoice {
  id?: string;
  docNo?: string | null;
  customerId: string;
  customerName: string;
  date: string;
  dueDate: string;
  status: 'paid' | 'unpaid' | 'overdue' | 'void';
  paymentState?: InvoicePaymentState;
  total: number;
  paid?: number;
  outstanding?: number;
  dueDays?: number;
  salesOrderId?: string | null;
  voidReason?: string;
  taxRate?: number;
  taxAmount?: number;
  currency?: string | null;
  fxRate?: number;
  baseTotal?: number;
  fxRateDate?: string | null;
  fxRateSource?: string | null;
}

type Filter = 'all' | 'open' | 'partially_paid' | 'overdue' | 'paid' | 'void';

const emptyInvoice = (): Omit<Invoice, 'id'> => ({
  customerId: '',
  customerName: '',
  date: new Date().toISOString().slice(0, 10),
  dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  status: 'unpaid',
  total: 0,
  taxRate: 0,
  currency: null,
  fxRate: 1,
});

function statusBadge(inv: Invoice) {
  if (inv.status === 'void') return 'bg-muted text-muted-foreground line-through';
  if (inv.paymentState === 'paid')
    return 'bg-green-100 dark:bg-green-950/30 text-green-700 dark:text-green-400';
  if (inv.status === 'overdue')
    return 'bg-red-100 dark:bg-red-950/30 text-red-700 dark:text-red-400';
  if (inv.paymentState === 'partially_paid')
    return 'bg-blue-100 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400';
  return 'bg-yellow-100 dark:bg-yellow-950/30 text-yellow-700 dark:text-yellow-400';
}

function statusText(inv: Invoice, t: ReturnType<typeof useI18n>['t']) {
  if (inv.status === 'void') return t('status.void');
  const state = t(`status.${inv.paymentState ?? 'unpaid'}`);
  return inv.status === 'overdue' ? t('status.overdueSuffix', { state }) : state;
}

const FILTERS: Filter[] = ['all', 'open', 'partially_paid', 'overdue', 'paid', 'void'];

export default function InvoicesPage() {
  const { user } = useAuth();
  const { can } = useWorkspace();
  const { t, fmt } = useI18n();
  // The customer is searched by the database, not loaded with every customer.
  const pickers = useRecordSearch();
  const [filter, setFilter] = useState<Filter>('all');
  // One page at a time, filtered and searched by the database.
  const list = useServerPage<Invoice>(
    (q) =>
      user ? invoiceService.page(user.id, q, filter) : Promise.resolve({ rows: [], total: 0 }),
    [user?.id, filter]
  );
  const loading = list.loading;
  // Figures above the list, for every invoice (db/migrations/20261012000008_erp_list_summaries.sql).
  const [figures, setFigures] = useState<Record<string, any> | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<Omit<Invoice, 'id'>>(emptyInvoice());
  const [lines, setLines] = useState<InvoiceLine[]>([newInvoiceLine()]);
  const net = invoiceLinesNet(lines);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [voiding, setVoiding] = useState<Invoice | null>(null);
  const [rate, setRate] = useState<RateChoice>(EMPTY_RATE);
  const { settings: currency } = useCurrencySettings();
  const base = currency?.baseCurrency ?? '';

  const loadFigures = useCallback(() => {
    listSummary('invoices')
      .then(setFigures)
      .catch(() => setFigures(null));
  }, []);

  const reload = useCallback(async () => {
    list.reload();
    loadFigures();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- list.reload is stable in effect
  }, [loadFigures]);

  useEffect(() => {
    if (!user) return;
    loadFigures();
  }, [user, loadFigures]);

  useEffect(() => {
    if (list.error)
      setError((list.error instanceof Error && list.error.message) || tr('invoice.loadFailed'));
  }, [list.error]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!form.customerName) {
      setError(t('invoice.selectCustomer'));
      return;
    }
    if (form.currency && !rate.valid) {
      setError(t('cur.err.invalid'));
      return;
    }
    if (lines.some((l) => !(l.qty > 0) || (!l.productId && !l.description.trim()))) {
      setError(t('invoice.lineIncomplete'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await invoiceService.create(user.id, {
        ...form,
        total: net,
        lines,
        fxRate: rateForServer(rate, form.currency ?? null),
      });
      await reload();
      setShowForm(false);
      setForm(emptyInvoice());
      setLines([newInvoiceLine()]);
      setRate(EMPTY_RATE);
    } catch (err: any) {
      setError(err?.message || t('invoice.createFailed'));
    } finally {
      setSaving(false);
    }
  }

  const num = (key: string) => Number(figures?.[key] ?? 0);
  const summary = [
    {
      key: 'open' as Filter,
      label: t('invoice.outstanding'),
      count: num('open_count'),
      amount: num('open_amount'),
    },
    {
      key: 'partially_paid' as Filter,
      label: t('status.partially_paid'),
      count: num('partial_count'),
      amount: num('partial_amount'),
    },
    {
      key: 'overdue' as Filter,
      label: t('status.overdue'),
      count: num('overdue_count'),
      amount: num('overdue_amount'),
    },
    {
      key: 'paid' as Filter,
      label: t('status.paid'),
      count: num('paid_count'),
      amount: num('paid_amount'),
    },
  ];
  const aging = [
    { label: t('invoice.aging.current'), amount: num('aging_current') },
    { label: t('invoice.aging.1_30'), amount: num('aging_1_30') },
    { label: t('invoice.aging.31_60'), amount: num('aging_31_60') },
    { label: t('invoice.aging.61'), amount: num('aging_61') },
  ];

  const inputCls =
    'w-full rounded-lg border px-3 py-2 text-[0.8rem] text-foreground placeholder:text-muted-foreground outline-none focus:border-foreground/40 transition-colors';
  const inputStyle = { background: 'var(--input)', borderColor: 'var(--border)' };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('invoice.title')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">
            {loading ? t('common.loading') : t('invoice.count', { count: num('count') })}
          </p>
        </div>
        {can('invoicing') && (
          <button
            onClick={() => {
              setShowForm(true);
              setForm(emptyInvoice());
              setError('');
              // Start from the workspace's default sales tax rate.
              accountingService
                .settings()
                .then((s) => setForm((f) => (f.taxRate ? f : { ...f, taxRate: s.salesTaxRate })))
                .catch(() => undefined);
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground"
          >
            <Plus size={14} /> {t('invoice.create')}
          </button>
        )}
      </div>

      {error && !showForm && (
        <div className="rounded-lg px-4 py-3 text-[0.8rem] text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {summary.map((s) => (
          <button
            key={s.key}
            onClick={() => setFilter(filter === s.key ? 'all' : s.key)}
            className={`rounded-xl border p-4 text-left transition-all ${
              filter === s.key ? 'bg-muted border-foreground/30' : 'bg-card border-border'
            }`}
          >
            <p className="text-[0.68rem] uppercase tracking-wider text-muted-foreground mb-2">
              {s.label}
            </p>
            <p className="text-[1.3rem] font-bold text-foreground">{s.count}</p>
            <p className="text-[0.72rem] text-muted-foreground mt-0.5">
              {s.key === 'paid'
                ? t('invoice.invoicedAmount', { amount: fmt.money(s.amount) })
                : t('invoice.remainingAmount', { amount: fmt.money(s.amount) })}
            </p>
          </button>
        ))}
      </div>

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="text-[0.85rem] font-semibold text-foreground">{t('invoice.aging')}</h2>
            <p className="text-[0.72rem] text-muted-foreground">{t('invoice.agingDesc')}</p>
          </div>
          {can('payments') && (
            <Link
              href="/erp/payments"
              className="rounded-lg border border-border px-3 py-2 text-[0.75rem] font-medium text-foreground hover:bg-muted"
            >
              {t('invoice.recordPaymentLink')}
            </Link>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {aging.map((bucket) => (
            <div
              key={bucket.label}
              className="rounded-lg border border-border bg-background px-3 py-2.5"
            >
              <p className="text-[0.68rem] uppercase tracking-wide text-muted-foreground">
                {bucket.label}
              </p>
              <p className="text-[0.95rem] font-semibold text-foreground mt-1">
                {fmt.money(bucket.amount)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <div className="relative">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          className="w-full rounded-lg border border-zinc-200 dark:border-border bg-white dark:bg-input pl-9 pr-3 py-2 text-[0.8rem] text-zinc-900 dark:text-foreground placeholder:text-zinc-400 dark:placeholder:text-muted-foreground outline-none focus:border-zinc-400 dark:focus:border-foreground/40"
          placeholder={t('invoice.search')}
          value={list.search}
          onChange={(e) => list.setSearch(e.target.value)}
        />
      </div>

      {list.focusId && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-[var(--surface-2)] px-4 py-2 text-[0.78rem] text-muted-foreground">
          <span>{t('common.focusOnly')}</span>
          <button
            type="button"
            onClick={list.showAll}
            className="font-medium text-foreground underline"
          >
            {t('common.showAll')}
          </button>
        </div>
      )}

      <div className="flex gap-1 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-[0.75rem] font-medium transition-all border ${
              filter === f
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-transparent text-muted-foreground border-border'
            }`}
          >
            {t(`invoice.filter.${f}`)}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border overflow-x-auto bg-card">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              {[
                t('invoice.customer'),
                t('common.date'),
                t('invoice.dueDate'),
                t('invoice.total'),
                t('invoice.paid'),
                t('invoice.remaining'),
                t('common.status'),
                t('common.action'),
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
            {loading ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-[0.8rem] text-muted-foreground"
                >
                  {t('invoice.loading')}
                </td>
              </tr>
            ) : (
              list.items.map((inv, i) => {
                const total = inv.total || 1;
                const paidPct = Math.min(100, Math.round(((inv.paid ?? 0) / total) * 100));
                return (
                  <tr
                    key={inv.id}
                    {...list.focusAttrs(inv.id)}
                    className={`border-b border-border ${i === list.items.length - 1 ? 'border-b-0' : ''}`}
                  >
                    <td className="px-4 py-3 text-[0.8rem] font-medium text-foreground">
                      {inv.customerName}
                      {inv.docNo && (
                        <span className="block font-mono text-[0.68rem] font-normal text-muted-foreground">
                          {inv.docNo}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[0.75rem] text-muted-foreground">
                      {fmt.date(inv.date)}
                    </td>
                    <td className="px-4 py-3 text-[0.75rem] text-muted-foreground">
                      {fmt.date(inv.dueDate)}
                    </td>
                    <td className="px-4 py-3 text-[0.8rem] font-semibold text-foreground">
                      {fmt.moneyIn(inv.total, inv.currency)}
                      {(inv.taxAmount ?? 0) > 0 && (
                        <span className="block text-[0.65rem] font-normal text-muted-foreground">
                          {t('tax.included', {
                            amount: fmt.moneyIn(inv.taxAmount ?? 0, inv.currency),
                            rate: fmt.number(inv.taxRate ?? 0),
                          })}
                        </span>
                      )}
                      <BaseEquivalent
                        base={inv.baseTotal ?? inv.total}
                        currency={inv.currency ?? null}
                        rate={inv.fxRate || 1}
                        rateDate={inv.fxRateDate}
                        source={inv.fxRateSource}
                      />
                    </td>
                    <td className="px-4 py-3 text-[0.78rem] text-muted-foreground">
                      {fmt.moneyIn(inv.paid ?? 0, inv.currency)}
                      {inv.status !== 'void' && inv.paymentState === 'partially_paid' && (
                        <div
                          className="mt-1 h-1 w-16 rounded-full bg-muted"
                          aria-label={t('invoice.paidPct', { pct: paidPct })}
                        >
                          <div
                            className="h-full rounded-full bg-foreground/50"
                            style={{ width: `${paidPct}%` }}
                          />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[0.8rem] font-semibold text-foreground">
                      {fmt.moneyIn(inv.outstanding ?? inv.total, inv.currency)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded text-[0.68rem] font-medium ${statusBadge(inv)}`}
                        title={inv.voidReason || undefined}
                      >
                        {statusText(inv, t)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/erp/print/invoice/${inv.id}`}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[0.72rem] font-medium text-muted-foreground border border-border hover:text-foreground transition-colors"
                        >
                          <Printer size={11} /> {t('print.print')}
                        </Link>
                        {inv.status !== 'void' &&
                          inv.paymentState !== 'paid' &&
                          can('payments') && (
                            <Link
                              href={`/erp/payments?invoice=${inv.id}`}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[0.72rem] font-medium text-muted-foreground border border-border hover:text-foreground transition-colors"
                            >
                              <FileText size={11} />{' '}
                              {inv.paymentState === 'partially_paid'
                                ? t('invoice.payRemaining')
                                : t('invoice.recordPayment')}
                            </Link>
                          )}
                        {inv.status !== 'void' &&
                          !inv.salesOrderId &&
                          (inv.paid ?? 0) === 0 &&
                          can('payments') && (
                            <button
                              onClick={() => setVoiding(inv)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[0.72rem] text-muted-foreground border border-border hover:text-foreground"
                              title={t('invoice.voidInvoice')}
                            >
                              <Ban size={11} /> {t('invoice.void')}
                            </button>
                          )}
                        {inv.status === 'void' && (
                          <span
                            className="text-[0.72rem] text-muted-foreground opacity-60 truncate max-w-[160px]"
                            title={inv.voidReason}
                          >
                            {inv.voidReason || t('status.void')}
                          </span>
                        )}
                        {inv.status !== 'void' && inv.paymentState === 'paid' && (
                          <span className="text-[0.72rem] text-muted-foreground opacity-60">
                            {t('status.paid')}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
            {!loading && list.items.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-[0.8rem] text-muted-foreground"
                >
                  {t('invoice.none')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination {...list.props} />
      </div>
      <p className="text-[0.7rem] text-muted-foreground">{t('invoice.correctionHint')}</p>

      {voiding && (
        <ReasonDialog
          title={t('invoice.voidInvoice')}
          description={t('invoice.voidBody', {
            customer: voiding.customerName,
            amount: fmt.money(voiding.total),
          })}
          confirmLabel={t('invoice.voidInvoice')}
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            await invoiceService.void(voiding.id!, reason);
            await reload();
          }}
        />
      )}

      {showForm && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)' }}
        >
          <div
            className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border"
            style={{ background: 'var(--card)', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}
          >
            <div className="flex items-center justify-between p-5 border-b border-border">
              <h2 className="text-[1rem] font-semibold text-foreground">{t('invoice.create')}</h2>
              <button
                onClick={() => setShowForm(false)}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreate} className="p-5 space-y-4">
              <div>
                <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                  {t('invoice.customerRequired')}
                </label>
                <RecordPicker
                  className={inputCls}
                  style={inputStyle}
                  ariaLabel={t('invoice.customerRequired')}
                  placeholder={t('invoice.selectCustomerOption')}
                  value={form.customerId}
                  valueLabel={form.customerName}
                  required
                  search={pickers.customers}
                  onChange={(c) =>
                    setForm((f) => ({
                      ...f,
                      customerId: c?.id ?? '',
                      customerName: c?.label ?? '',
                    }))
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                    {t('invoice.invoiceDate')}
                  </label>
                  <input
                    type="date"
                    className={inputCls}
                    style={inputStyle}
                    value={form.date}
                    onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                    {t('invoice.dueDate')}
                  </label>
                  <input
                    type="date"
                    className={inputCls}
                    style={inputStyle}
                    value={form.dueDate}
                    onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
                  />
                </div>
              </div>
              <InvoiceLinesEditor
                lines={lines}
                onChange={setLines}
                currency={form.currency ?? null}
                inputCls={inputCls}
                inputStyle={inputStyle}
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="invoice-tax"
                    className="block text-[0.7rem] text-muted-foreground mb-1.5"
                  >
                    {t('tax.rate')}
                  </label>
                  <input
                    id="invoice-tax"
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    list="tax-rates"
                    className={inputCls}
                    style={inputStyle}
                    value={form.taxRate}
                    onChange={(e) => setForm((f) => ({ ...f, taxRate: Number(e.target.value) }))}
                  />
                  <datalist id="tax-rates">
                    <option value="0" />
                    <option value="11" />
                    <option value="12" />
                  </datalist>
                </div>
              </div>
              {currency && (
                <div className="space-y-3">
                  <div>
                    <label
                      htmlFor="invoice-currency"
                      className="block text-[0.7rem] text-muted-foreground mb-1.5"
                    >
                      {t('fx.currency')}
                    </label>
                    <CurrencySelect
                      id="invoice-currency"
                      className={inputCls}
                      style={inputStyle}
                      value={form.currency ?? null}
                      base={base}
                      currencies={currency.currencies}
                      onChange={(code) => {
                        setForm((f) => ({ ...f, currency: code }));
                        setRate(EMPTY_RATE);
                      }}
                    />
                  </div>
                  <RateField
                    id="invoice-rate"
                    currency={form.currency ?? null}
                    base={base}
                    date={form.date}
                    value={rate}
                    onChange={setRate}
                    inputClassName={inputCls}
                    inputStyle={inputStyle}
                  />
                </div>
              )}
              <p className="text-[0.75rem] text-muted-foreground tabular-nums">
                {t('tax.summary', {
                  net: fmt.moneyIn(net, form.currency),
                  tax: fmt.moneyIn(Math.round(net * (form.taxRate || 0)) / 100, form.currency),
                  total: fmt.moneyIn(
                    net + Math.round(net * (form.taxRate || 0)) / 100,
                    form.currency
                  ),
                })}
              </p>
              <p className="text-[0.72rem] text-muted-foreground">{t('invoice.autoStatus')}</p>
              {error && (
                <p className="text-[0.78rem] text-muted-foreground bg-muted rounded-lg px-3 py-2 border border-border">
                  {error}
                </p>
              )}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border bg-transparent"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {saving ? (
                    t('common.saving')
                  ) : (
                    <>
                      <Check size={13} /> {t('common.create')}
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
