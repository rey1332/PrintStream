'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { paymentService, listSummary } from '../lib/erpService';
import { useWorkspace } from '../lib/WorkspaceContext';
import { ReasonDialog } from '../components/ReasonDialog';
import { RecordPicker } from '../components/RecordPicker';
import { useRecordSearch } from '../lib/pickers';
import { ArrowDownLeft, ArrowUpRight, Plus, X, Check, Search, Ban, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { tr } from '@/lib/i18n/translate';
import { hasMessage } from '@/lib/i18n/labels';
import { Pagination, useServerPage } from '../components/Pagination';
import { useCurrencySettings } from '../lib/useCurrency';
import { convertAmount } from '@/lib/currency/client';
import {
  BaseEquivalent,
  EMPTY_RATE,
  RateField,
  type RateChoice,
} from '../components/CurrencyFields';

interface Payment {
  docNo?: string | null;
  id?: string;
  type: 'incoming' | 'outgoing';
  party: string;
  amount: number;
  date: string;
  method: string;
  note: string;
  invoiceId?: string | null;
  purchaseOrderId?: string | null;
  voidedAt?: string | null;
  voidReason?: string;
  currency?: string | null;
  fxRate?: number;
  baseAmount?: number;
  fxRateDate?: string | null;
  fxRateSource?: string | null;
}

interface Invoice {
  id: string;
  docNo?: string | null;
  customerId: string;
  customerName: string;
  date: string;
  dueDate: string;
  status: string;
  total: number;
  outstanding?: number;
  paid?: number;
  paymentState?: string;
  currency?: string | null;
  fxRate?: number;
}
interface PurchaseOrder {
  id: string;
  docNo?: string | null;
  supplierId: string;
  supplierName: string;
  date: string;
  status: string;
  total: number;
  outstanding?: number;
  currency?: string | null;
}

const docRef = (d: { id: string; docNo?: string | null }) => d.docNo || d.id.slice(0, 8);

const METHODS = ['Bank Transfer', 'Cash', 'Check', 'Wire', 'Credit Card', 'E-Wallet'];

const emptyPayment = (): Omit<Payment, 'id'> => ({
  type: 'incoming',
  party: '',
  amount: 0,
  date: new Date().toISOString().slice(0, 10),
  method: 'Bank Transfer',
  note: '',
  invoiceId: null,
  purchaseOrderId: null,
  fxRate: 1,
});

export default function PaymentsPage() {
  const { user } = useAuth();
  const [rate, setRate] = useState<RateChoice>(EMPTY_RATE);
  const { settings: currencySettings } = useCurrencySettings();
  const base = currencySettings?.baseCurrency ?? '';
  const { can } = useWorkspace();
  const { t, fmt } = useI18n();
  // Stored method values stay English; only their label is translated.
  const methodLabel = (method: string) => {
    const key = `pay.method.${method}`;
    return hasMessage(key) ? t(key) : method;
  };
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const pickers = useRecordSearch();
  // The customer or supplier picked; open invoices or orders are loaded for them only.
  const [partyId, setPartyId] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [filter, setFilter] = useState<'all' | 'incoming' | 'outgoing'>('all');
  // One page at a time, filtered and searched by the database.
  const list = useServerPage<Payment>(
    (q) =>
      user
        ? (paymentService.page(user.id, q, filter) as Promise<{ rows: Payment[]; total: number }>)
        : Promise.resolve({ rows: [], total: 0 }),
    [user?.id, filter]
  );
  const loading = list.loading;
  // Money in and out of every payment (db/migrations/20261012000008_erp_list_summaries.sql).
  const [figures, setFigures] = useState<Record<string, any> | null>(null);
  const loadFigures = () =>
    listSummary('payments')
      .then(setFigures)
      .catch(() => setFigures(null));
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<Omit<Payment, 'id'>>(emptyPayment());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadOpenDocuments = useCallback(
    async (type: Payment['type'], id: string | null, name: string) => {
      if (!user || !name) {
        setInvoices([]);
        setPurchaseOrders([]);
        return;
      }
      try {
        if (type === 'incoming') {
          setInvoices(
            (await paymentService.getUnpaidInvoices(user.id, {
              customerId: id,
              customerName: name,
            })) as Invoice[]
          );
          setPurchaseOrders([]);
        } else {
          setPurchaseOrders(
            (await paymentService.getPendingPurchaseOrders(user.id, {
              supplierId: id,
              supplierName: name,
            })) as PurchaseOrder[]
          );
          setInvoices([]);
        }
      } catch (err: any) {
        setError(err?.message || tr('pay.loadFailed'));
      }
    },
    [user]
  );

  useEffect(() => {
    if (!user) return;
    void loadFigures();
    const invoiceId = new URLSearchParams(window.location.search).get('invoice');
    if (!invoiceId) return;
    paymentService
      .getUnpaidInvoices(user.id, { invoiceId })
      .then((found) => {
        const selectedInvoice = (found as Invoice[])[0];
        if (!selectedInvoice) return;
        setInvoices(found as Invoice[]);
        setPartyId(selectedInvoice.customerId || null);
        setForm({
          ...emptyPayment(),
          invoiceId: selectedInvoice.id,
          party: selectedInvoice.customerName,
          amount: selectedInvoice.outstanding ?? selectedInvoice.total,
          fxRate: selectedInvoice.currency ? (selectedInvoice.fxRate ?? 1) : 1,
          note: tr('pay.noteForInvoice', { ref: docRef(selectedInvoice) }),
        });
        setShowForm(true);
      })
      .catch((err: any) => setError(err?.message || tr('pay.loadFailed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadFigures only reads the active ERP
  }, [user]);

  useEffect(() => {
    if (list.error)
      setError((list.error instanceof Error && list.error.message) || tr('pay.loadFailed'));
  }, [list.error]);

  async function refreshAll() {
    if (!user) return;
    list.reload();
    void loadFigures();
  }

  // Loaded for the picked party only.
  const filteredInvoices = form.type === 'incoming' ? invoices : [];
  const filteredPOs = form.type === 'outgoing' ? purchaseOrders : [];

  function pickParty(option: { id: string; label: string } | null) {
    const name = option?.label ?? '';
    setPartyId(option?.id ?? null);
    setForm((f) => ({ ...f, party: name, invoiceId: null, purchaseOrderId: null }));
    void loadOpenDocuments(form.type, option?.id ?? null, name);
  }

  function handleInvoiceSelect(invoiceId: string) {
    const inv = invoices.find((i) => i.id === invoiceId);
    setRate(EMPTY_RATE);
    setForm((f) => ({
      ...f,
      invoiceId: invoiceId || null,
      amount: inv ? (inv.outstanding ?? inv.total) : f.amount,
      fxRate: inv?.currency ? (inv.fxRate ?? 1) : 1,
      note: inv ? t('pay.noteForInvoice', { ref: docRef(inv) }) : f.note,
      party: inv ? inv.customerName : f.party,
    }));
  }

  function handlePOSelect(poId: string) {
    const po = purchaseOrders.find((p) => p.id === poId);
    setRate(EMPTY_RATE);
    setForm((f) => ({
      ...f,
      purchaseOrderId: poId || null,
      amount: po ? (po.outstanding ?? po.total) : f.amount,
      note: po ? t('pay.noteForPo', { ref: docRef(po) }) : f.note,
      party: po ? po.supplierName : f.party,
    }));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!form.party) {
      setError(t('pay.partyRequired'));
      return;
    }
    if (!form.amount || form.amount <= 0) {
      setError(t('pay.amountPositive'));
      return;
    }
    if (selectedCurrency && !rate.valid) {
      setError(t('cur.err.invalid'));
      return;
    }

    setSaving(true);
    setError('');
    try {
      await paymentService.create(user.id, {
        ...form,
        fxRate: selectedCurrency && rate.mode === 'manual' ? Number(rate.rate) : undefined,
        fxRateSource: selectedCurrency
          ? rate.mode === 'manual'
            ? 'manual'
            : 'rate_table'
          : undefined,
      });
      await refreshAll();
      setShowForm(false);
      setForm(emptyPayment());
      setPartyId(null);
      setInvoices([]);
      setPurchaseOrders([]);
      setRate(EMPTY_RATE);
      toast.success(t('pay.recordedToast'));
    } catch (err: any) {
      setError(err?.message || t('pay.recordFailed'));
    } finally {
      setSaving(false);
    }
  }

  // Paying a foreign-currency invoice or purchase order: the amount is in its currency.
  const selectedCurrency =
    (form.invoiceId
      ? invoices.find((i) => i.id === form.invoiceId)?.currency
      : form.purchaseOrderId
        ? purchaseOrders.find((p) => p.id === form.purchaseOrderId)?.currency
        : null) ?? null;

  // Voided payments stay listed for history but are not cash (base currency).
  const totalIn = Number(figures?.incoming ?? 0);
  const totalOut = Number(figures?.outgoing ?? 0);
  const netBalance = totalIn - totalOut;

  const inputCls =
    'w-full rounded-lg border border-zinc-200 dark:border-border bg-white dark:bg-input px-3 py-2 text-[0.8rem] text-zinc-900 dark:text-foreground outline-none focus:border-zinc-400 dark:focus:border-foreground/40';

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('pay.title')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">
            {loading
              ? t('common.loading')
              : t('pay.count', { count: Number(figures?.count ?? list.total) })}
          </p>
        </div>
        {can('payments') && (
          <button
            onClick={() => {
              setShowForm(true);
              setForm(emptyPayment());
              setPartyId(null);
              setInvoices([]);
              setPurchaseOrders([]);
              setError('');
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground"
          >
            <Plus size={14} /> {t('pay.record')}
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <ArrowDownLeft size={14} className="text-muted-foreground" />
            <span className="text-[0.68rem] uppercase tracking-wider text-muted-foreground">
              {t('pay.incoming')}
            </span>
          </div>
          <p className="text-[1.4rem] font-bold text-foreground">{fmt.money(totalIn)}</p>
          <p className="text-[0.72rem] text-muted-foreground mt-0.5">
            {t('pay.countPayments', {
              count: Number(figures?.incoming_count ?? 0),
            })}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <ArrowUpRight size={14} className="text-muted-foreground" />
            <span className="text-[0.68rem] uppercase tracking-wider text-muted-foreground">
              {t('pay.outgoing')}
            </span>
          </div>
          <p className="text-[1.4rem] font-bold text-muted-foreground">{fmt.money(totalOut)}</p>
          <p className="text-[0.72rem] text-muted-foreground mt-0.5">
            {t('pay.countPayments', {
              count: Number(figures?.outgoing_count ?? 0),
            })}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[0.68rem] uppercase tracking-wider text-muted-foreground">
              {t('pay.netCash')}
            </span>
          </div>
          <p
            className={`text-[1.4rem] font-bold ${netBalance >= 0 ? 'text-foreground' : 'text-red-500'}`}
          >
            {fmt.money(netBalance)}
          </p>
          <p className="text-[0.72rem] text-muted-foreground mt-0.5">{t('pay.netHint')}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1">
          {(['all', 'incoming', 'outgoing'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-[0.75rem] font-medium transition-all border ${
                filter === f
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-transparent text-muted-foreground border-border hover:text-foreground'
              }`}
            >
              {f === 'all'
                ? t('common.all')
                : f === 'incoming'
                  ? t('pay.incoming')
                  : t('pay.outgoing')}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search
            size={13}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            placeholder={t('pay.search')}
            className="w-full rounded-lg border border-zinc-200 dark:border-border bg-white dark:bg-input pl-9 pr-3 py-1.5 text-[0.78rem] text-zinc-900 dark:text-foreground placeholder:text-zinc-400 outline-none focus:border-zinc-400 dark:focus:border-foreground/40"
          />
        </div>
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

      <div className="rounded-xl border border-border overflow-hidden bg-card">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              {[
                t('common.date'),
                t('pay.party'),
                t('common.type'),
                t('pay.method'),
                t('common.reference'),
                t('common.amount'),
                '',
              ].map((h, idx) => (
                <th
                  key={idx}
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
                  colSpan={7}
                  className="px-4 py-8 text-center text-[0.8rem] text-muted-foreground"
                >
                  {t('pay.loading')}
                </td>
              </tr>
            ) : list.items.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-[0.8rem] text-muted-foreground"
                >
                  {t('pay.none')}
                </td>
              </tr>
            ) : (
              list.items.map((p, i) => (
                <tr
                  key={p.id}
                  {...list.focusAttrs(p.id)}
                  className={`border-b border-border ${i === list.items.length - 1 ? 'border-b-0' : ''} ${p.voidedAt ? 'opacity-60' : ''}`}
                >
                  <td className="px-4 py-3 text-[0.75rem] text-muted-foreground">
                    {fmt.date(p.date)}
                  </td>
                  <td className="px-4 py-3 text-[0.8rem] font-medium text-foreground">
                    {p.party}
                    {p.docNo && (
                      <span className="block font-mono text-[0.68rem] font-normal text-muted-foreground">
                        {p.docNo}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
                      {p.type === 'incoming' ? (
                        <ArrowDownLeft size={11} />
                      ) : (
                        <ArrowUpRight size={11} />
                      )}
                      {p.type === 'incoming' ? t('pay.incoming') : t('pay.outgoing')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[0.75rem] text-muted-foreground">
                    {methodLabel(p.method)}
                  </td>
                  <td className="px-4 py-3 text-[0.72rem] text-muted-foreground font-mono truncate max-w-[200px]">
                    {p.note || '—'}
                  </td>
                  <td
                    className={`px-4 py-3 text-[0.8rem] font-semibold ${p.type === 'incoming' ? 'text-foreground' : 'text-muted-foreground'} ${p.voidedAt ? 'line-through' : ''}`}
                  >
                    {p.type === 'incoming' ? '+' : '−'}
                    {fmt.moneyIn(p.amount, p.currency)}
                    <BaseEquivalent
                      base={p.baseAmount ?? p.amount}
                      currency={p.currency ?? null}
                      rate={p.fxRate || 1}
                      rateDate={p.fxRateDate}
                      source={p.fxRateSource}
                    />
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <Link
                      href={`/erp/print/payment/${p.id}`}
                      className="mr-1.5 inline-flex items-center gap-1 px-2 py-1 rounded text-[0.7rem] text-muted-foreground border border-border hover:text-foreground"
                    >
                      <Printer size={11} /> {t('print.print')}
                    </Link>
                    {p.voidedAt ? (
                      <span
                        className="text-[0.68rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                        title={p.voidReason}
                      >
                        {t('pay.voided')}
                      </span>
                    ) : can('payments') ? (
                      <button
                        onClick={() => setVoiding(p)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-[0.7rem] text-muted-foreground border border-border hover:text-foreground"
                        title={t('pay.voidTitle')}
                      >
                        <Ban size={11} /> {t('pay.void')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <Pagination {...list.props} />
      </div>

      {voiding && (
        <ReasonDialog
          title={t('pay.voidDialog')}
          description={t('pay.voidBody', {
            party: voiding.party,
            amount: fmt.money(voiding.amount),
            date: fmt.date(voiding.date),
          })}
          confirmLabel={t('pay.voidDialog')}
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            await paymentService.void(voiding.id!, reason);
            await refreshAll();
            toast.success(t('pay.voidedToast'));
          }}
        />
      )}

      {showForm && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)' }}
        >
          <div className="w-full max-w-lg rounded-2xl border border-border bg-card flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between p-5 border-b border-border flex-shrink-0">
              <h2 className="text-[1rem] font-semibold text-foreground">{t('pay.record')}</h2>
              <button
                onClick={() => setShowForm(false)}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleCreate} className="p-5 space-y-4 overflow-y-auto flex-1">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                    {t('pay.typeRequired')}
                  </label>
                  <select
                    className={inputCls}
                    value={form.type}
                    onChange={(e) => {
                      const type = e.target.value as 'incoming' | 'outgoing';
                      setPartyId(null);
                      setInvoices([]);
                      setPurchaseOrders([]);
                      setForm((f) => ({
                        ...emptyPayment(),
                        type,
                        date: f.date,
                        method: f.method,
                      }));
                    }}
                  >
                    <option value="incoming">{t('pay.incomingFromCustomer')}</option>
                    <option value="outgoing">{t('pay.outgoingToSupplier')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                    {t('pay.dateRequired')}
                  </label>
                  <input
                    type="date"
                    className={inputCls}
                    value={form.date}
                    onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                  {form.type === 'incoming' ? t('pay.customerRequired') : t('pay.supplierRequired')}
                </label>
                <RecordPicker
                  // A new picker per type, so no search from the other list lingers.
                  key={form.type}
                  className={inputCls}
                  ariaLabel={
                    form.type === 'incoming' ? t('pay.customerRequired') : t('pay.supplierRequired')
                  }
                  placeholder={
                    form.type === 'incoming' ? t('pay.chooseCustomer') : t('pay.chooseSupplier')
                  }
                  value={partyId ?? (form.party ? form.party : '')}
                  valueLabel={form.party}
                  required
                  search={form.type === 'incoming' ? pickers.customers : pickers.suppliers}
                  onChange={pickParty}
                />
              </div>

              {form.type === 'incoming' && form.party && (
                <div>
                  <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                    {t('pay.linkInvoice')}
                  </label>
                  <select
                    className={inputCls}
                    value={form.invoiceId || ''}
                    onChange={(e) => handleInvoiceSelect(e.target.value)}
                  >
                    <option value="">{t('pay.noInvoiceLink')}</option>
                    {filteredInvoices.map((inv) => (
                      <option key={inv.id} value={inv.id}>
                        {t('pay.invoiceOption', {
                          ref: docRef(inv),
                          remaining: fmt.moneyIn(inv.outstanding ?? inv.total, inv.currency),
                          total: fmt.moneyIn(inv.total, inv.currency),
                          partial:
                            inv.paymentState === 'partially_paid' ? t('pay.partialSuffix') : '',
                          due: fmt.date(inv.dueDate),
                        })}
                      </option>
                    ))}
                  </select>
                  {filteredInvoices.length === 0 && (
                    <p className="text-[0.68rem] text-muted-foreground mt-1">
                      {t('pay.noOpenInvoices')}
                    </p>
                  )}
                </div>
              )}

              {form.type === 'outgoing' && form.party && (
                <div>
                  <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                    {t('pay.linkPo')}
                  </label>
                  <select
                    className={inputCls}
                    value={form.purchaseOrderId || ''}
                    onChange={(e) => handlePOSelect(e.target.value)}
                  >
                    <option value="">{t('pay.noPoLink')}</option>
                    {filteredPOs.map((po) => (
                      <option key={po.id} value={po.id}>
                        {t('pay.poOption', {
                          ref: docRef(po),
                          balance: fmt.moneyIn(po.outstanding ?? po.total, po.currency ?? null),
                          status: t(`status.${po.status === 'received' ? 'received' : 'approved'}`),
                        })}
                      </option>
                    ))}
                  </select>
                  {filteredPOs.length === 0 && (
                    <p className="text-[0.68rem] text-muted-foreground mt-1">
                      {t('pay.noOpenPos')}
                    </p>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                    {t('pay.amountRequired')}
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className={inputCls}
                    value={form.amount}
                    onChange={(e) => setForm((f) => ({ ...f, amount: Number(e.target.value) }))}
                    required
                  />
                  {selectedCurrency && (
                    <p className="text-[0.65rem] text-muted-foreground mt-1">
                      {t('fx.inCurrency', { currency: selectedCurrency })}
                    </p>
                  )}
                </div>
                {selectedCurrency && base && (
                  <div>
                    <RateField
                      id="payment-rate"
                      currency={selectedCurrency}
                      base={base}
                      date={form.date}
                      value={rate}
                      onChange={setRate}
                      inputClassName={inputCls}
                    />
                    {rate.valid && (
                      <p className="text-[0.65rem] text-muted-foreground mt-1">
                        ≈ {fmt.money(convertAmount(form.amount || 0, rate.rate, 2) ?? 0)}
                      </p>
                    )}
                  </div>
                )}
                <div>
                  <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                    {t('pay.methodRequired')}
                  </label>
                  <select
                    className={inputCls}
                    value={form.method}
                    onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))}
                  >
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {methodLabel(m)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                  {t('pay.referenceNote')}
                </label>
                <input
                  className={inputCls}
                  placeholder={t('pay.referencePlaceholder')}
                  value={form.note}
                  onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                />
              </div>

              {error && (
                <p className="text-[0.78rem] text-red-500 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2 border border-red-200 dark:border-red-900/50">
                  {error}
                </p>
              )}
            </form>

            <div className="flex gap-2 p-5 border-t border-border flex-shrink-0">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border bg-transparent"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleCreate as any}
                disabled={saving}
                className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {saving ? (
                  t('common.saving')
                ) : (
                  <>
                    <Check size={13} /> {t('pay.recordShort')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
