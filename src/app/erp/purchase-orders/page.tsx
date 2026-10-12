'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import {
  purchaseOrderService,
  fulfillmentService,
  type FulfillmentEvent,
  listSummary,
} from '../lib/erpService';
import { QtyUnitInput, lineQty, type QtyEntry } from '../components/QtyUnitInput';
import { UNIT_LABEL, roundQty, type UnitCode } from '@/lib/units';
import { remainingQty } from '../lib/erpRules';
import { useWorkspace } from '../lib/WorkspaceContext';
import { newRequestId } from '../lib/workspace';
import { ReasonDialog } from '../components/ReasonDialog';
import { RecordPicker } from '../components/RecordPicker';
import { productOption, useRecordSearch, type PickedProduct } from '../lib/pickers';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { tr } from '@/lib/i18n/translate';
import { statusLabel } from '@/lib/i18n/labels';
import {
  Plus,
  Check,
  Package,
  Trash2,
  X,
  Ban,
  History,
  Undo2,
  Printer,
  Search,
} from 'lucide-react';
import Link from 'next/link';
import { Pagination, useServerPage } from '../components/Pagination';
import { useCurrencySettings } from '../lib/useCurrency';
import { convertAmount } from '@/lib/currency/client';
import {
  BaseEquivalent,
  CurrencySelect,
  EMPTY_RATE,
  RateField,
  rateForServer,
  type RateChoice,
} from '../components/CurrencyFields';

interface LineItem extends QtyEntry {
  productId: string;
  productName: string;
  /** In the line's unit (converted from what was typed). */
  qty: number;
  price: number;
}

const newLine = (): LineItem => ({
  productId: '',
  productName: '',
  qty: 1,
  price: 0,
  unit: 'pcs',
  entryQty: 1,
  entryUnit: 'pcs',
  density: null,
});

interface POFormData {
  supplierId: string;
  supplierName: string;
  date: string;
  notes: string;
  items: LineItem[];
  currency: string | null;
}

const emptyForm = (): POFormData => ({
  supplierId: '',
  supplierName: '',
  date: new Date().toISOString().slice(0, 10),
  notes: '',
  items: [],
  currency: null,
});

function receivedUnits(order: any) {
  const items = order.items || [];
  return {
    received: items.reduce((s: number, i: any) => s + (i.qtyReceived || 0), 0),
    ordered: items.reduce((s: number, i: any) => s + (i.qty || 0), 0),
  };
}

export default function PurchaseOrdersPage() {
  const { user } = useAuth();
  const { can } = useWorkspace();
  const { t, fmt } = useI18n();
  // One page at a time, searched by the database; `orders` is the page shown.
  const list = useServerPage<any>(
    (q) => (user ? purchaseOrderService.page(user.id, q) : Promise.resolve({ rows: [], total: 0 })),
    [user?.id]
  );
  const orders = list.items;
  // Counts and totals of every order (db/migrations/20261012000008_erp_list_summaries.sql).
  const [figures, setFigures] = useState<Record<string, any> | null>(null);
  const loadFigures = useCallback(() => {
    listSummary('purchase_orders')
      .then(setFigures)
      .catch(() => setFigures(null));
  }, []);
  const pickers = useRecordSearch();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<POFormData>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<{
    order: any;
    qty: Record<string, number>;
    note: string;
    requestId: string;
  } | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [receiptError, setReceiptError] = useState('');
  const [cancelling, setCancelling] = useState<any | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [events, setEvents] = useState<FulfillmentEvent[]>([]);
  const [reversing, setReversing] = useState<{ event: FulfillmentEvent; requestId: string } | null>(
    null
  );
  const [rate, setRate] = useState<RateChoice>(EMPTY_RATE);
  const [receiptRate, setReceiptRate] = useState<RateChoice>(EMPTY_RATE);
  const { settings: currencySettings } = useCurrencySettings();
  const base = currencySettings?.baseCurrency ?? '';
  const today = new Date().toISOString().slice(0, 10);

  const refresh = useCallback(async () => {
    if (!user) return;
    list.reload();
    loadFigures();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- list.reload only bumps a counter
  }, [user, loadFigures]);

  const loading = list.loading;
  useEffect(() => {
    loadFigures();
  }, [loadFigures, user?.id]);
  useEffect(() => {
    if (list.error)
      setError((list.error instanceof Error && list.error.message) || tr('po.loadFailed'));
  }, [list.error]);

  const loadEvents = useCallback(async (orderId: string) => {
    try {
      setEvents(await fulfillmentService.getEvents('purchase', orderId));
    } catch (err: any) {
      setError(err?.message || tr('po.historyFailed'));
    }
  }, []);

  const total = form.items.reduce((s, i) => s + i.qty * i.price, 0);

  function addItem() {
    setForm((f) => ({
      ...f,
      items: [...f.items, newLine()],
    }));
  }

  function removeItem(idx: number) {
    setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
  }

  function pickProduct(idx: number, prod: PickedProduct | null) {
    setForm((f) => {
      const items = [...f.items];
      if (!prod) {
        items[idx] = { ...items[idx], productId: '', productName: '' };
        return { ...f, items };
      }
      // Product prices are in the base currency: converted for a foreign order (at its rate), else left for the user.
      const price = !f.currency
        ? prod.purchasePrice
        : rate.valid
          ? (convertAmount(prod.purchasePrice, String(1 / Number(rate.rate)), 2) ?? 0)
          : 0;
      // The line takes the product's unit; what was typed is converted to it.
      const entry: QtyEntry = {
        entryQty: items[idx].entryQty,
        entryUnit: prod.unit,
        unit: prod.unit,
        density: prod.density,
      };
      items[idx] = {
        ...items[idx],
        ...entry,
        qty: lineQty(entry) ?? 0,
        productId: prod.id,
        productName: prod.name,
        price,
      };
      return { ...f, items };
    });
  }

  function updateQty(idx: number, entry: QtyEntry) {
    setForm((f) => {
      const items = [...f.items];
      items[idx] = { ...items[idx], ...entry, qty: lineQty(entry) ?? 0 };
      return { ...f, items };
    });
  }

  function updateItem(idx: number, field: 'qty' | 'price', value: string) {
    setForm((f) => {
      const items = [...f.items];
      items[idx] = { ...items[idx], [field]: Number(value) };
      return { ...f, items };
    });
  }

  const searchProducts = (text: string) =>
    pickers
      .products(text)
      .then((rows) =>
        rows.map((p) =>
          productOption(p, t('so.onHandCount', { count: fmt.number(p.currentStock) }))
        )
      );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!form.supplierName) {
      setError(t('po.pleaseSelectSupplier'));
      return;
    }
    if (form.items.length === 0) {
      setError(t('order.addLine'));
      return;
    }
    if (form.items.some((i) => !(i.qty > 0))) {
      setError(t('order.badQty'));
      return;
    }
    if (form.currency && !rate.valid) {
      setError(t('cur.err.invalid'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const created = await purchaseOrderService.create(user.id, {
        ...form,
        total,
        fxRate: rateForServer(rate, form.currency),
      });
      if (created?.id) {
        try {
          const notificationResponse = await fetch('/api/erp/workflows', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'notify', purchaseOrderId: created.id }),
          });
          const notification = await notificationResponse.json();
          if (notification.data?.required && !notification.data?.sent) {
            setError(
              notification.data.emailConfigured ? t('po.emailFailed') : t('po.emailNotConfigured')
            );
          }
        } catch {
          setError(t('po.notificationFailed'));
        }
      }
      await refresh();
      setShowForm(false);
      setForm(emptyForm());
      setRate(EMPTY_RATE);
    } catch (err: any) {
      setError(err?.message || t('po.createFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function approve(id: string) {
    if (!user) return;
    setError('');
    try {
      await purchaseOrderService.updateStatus(user.id, id, 'approved');
      await refresh();
    } catch (err: any) {
      setError(err?.message || t('po.needsApprover'));
    }
  }

  function openReceipt(order: any) {
    const qty: Record<string, number> = {};
    for (const item of order.items || []) qty[item.id] = remainingQty(item.qty, item.qtyReceived);
    // Stable per attempt: retrying after a network error cannot double-count stock.
    setReceipt({ order, qty, note: '', requestId: newRequestId() });
    setReceiptRate(EMPTY_RATE);
    setReceiptError('');
  }

  async function submitReceipt(e: React.FormEvent) {
    e.preventDefault();
    if (!receipt) return;
    const lines = Object.entries(receipt.qty)
      .filter(([, q]) => q > 0)
      .map(([itemId, q]) => ({ itemId, qty: q }));
    if (lines.length === 0) {
      setReceiptError(t('order.enterQty'));
      return;
    }
    if (receipt.order.currency && !receiptRate.valid) {
      setReceiptError(t('cur.err.invalid'));
      return;
    }
    setReceiving(true);
    setReceiptError('');
    try {
      await purchaseOrderService.recordReceipt(
        receipt.order.id,
        lines,
        receipt.requestId,
        receipt.note,
        rateForServer(receiptRate, receipt.order.currency)
      );
      const orderId = receipt.order.id;
      setReceipt(null);
      await refresh();
      if (historyFor === orderId) await loadEvents(orderId);
    } catch (err: any) {
      setReceiptError(err?.message || t('po.receiptFailed'));
    } finally {
      setReceiving(false);
    }
  }

  async function toggleHistory(orderId: string) {
    if (historyFor === orderId) {
      setHistoryFor(null);
      return;
    }
    setHistoryFor(orderId);
    setEvents([]);
    await loadEvents(orderId);
  }

  const statusClass = (s: string) =>
    s === 'received'
      ? 'bg-green-100 dark:bg-green-950/30 text-green-700 dark:text-green-400'
      : s === 'approved'
        ? 'bg-blue-100 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400'
        : s === 'cancelled'
          ? 'bg-muted text-muted-foreground line-through'
          : 'bg-muted text-muted-foreground';

  const inputCls =
    'w-full rounded-lg border px-3 py-2 text-[0.8rem] text-foreground placeholder:text-muted-foreground outline-none focus:border-foreground/40 transition-colors';
  const inputStyle = { background: 'var(--input)', borderColor: 'var(--border)' };
  const actionCls =
    'flex items-center gap-1.5 px-2.5 py-1 rounded text-[0.72rem] font-medium text-muted-foreground border border-border hover:text-foreground transition-colors bg-transparent';
  const liveCount = Number(figures?.count ?? 0) - Number(figures?.by_status?.cancelled?.count ?? 0);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('po.title')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">
            {loading
              ? t('common.loading')
              : t('order.activeSummary', {
                  count: liveCount,
                  total: fmt.money(Number(figures?.live_total ?? 0)),
                })}
          </p>
        </div>
        {can('purchasing') && (
          <button
            onClick={() => {
              setShowForm(true);
              setForm(emptyForm());
              setError('');
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground"
          >
            <Plus size={14} /> {t('po.create')}
          </button>
        )}
      </div>

      {error && !showForm && (
        <div className="rounded-lg px-4 py-3 text-[0.8rem] text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(['pending', 'approved', 'received', 'cancelled'] as const).map((s) => {
          const count = Number(figures?.by_status?.[s]?.count ?? 0);
          // In the base currency (each order's stored base amount).
          const tot = Number(figures?.by_status?.[s]?.total ?? 0);
          return (
            <div key={s} className="rounded-xl border border-border bg-card p-4">
              <p className="text-[0.68rem] uppercase tracking-wider text-muted-foreground mb-2">
                {statusLabel(s, t)}
              </p>
              <p className="text-[1.3rem] font-bold text-foreground">{fmt.number(count)}</p>
              <p className="text-[0.72rem] text-muted-foreground mt-0.5">{fmt.money(tot)}</p>
            </div>
          );
        })}
      </div>

      <div className="relative">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          className="w-full rounded-lg border border-zinc-200 dark:border-border bg-white dark:bg-input pl-9 pr-3 py-2 text-[0.8rem] text-zinc-900 dark:text-foreground placeholder:text-zinc-400 dark:placeholder:text-muted-foreground outline-none focus:border-zinc-400 dark:focus:border-foreground/40"
          placeholder={t('po.search')}
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

      {loading ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-[0.8rem] text-muted-foreground">
          {t('po.loading')}
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-x-auto bg-card">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {[
                  t('po.supplier'),
                  t('order.date'),
                  t('order.items'),
                  t('po.received'),
                  t('common.total'),
                  t('common.status'),
                  t('common.actions'),
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
              {list.items.map((o, i) => {
                const units = receivedUnits(o);
                const partial = o.status === 'approved' && units.received > 0;
                return (
                  <React.Fragment key={o.id}>
                    <tr
                      {...list.focusAttrs(o.id)}
                      className={`border-b border-border ${i === list.items.length - 1 && historyFor !== o.id ? 'border-b-0' : ''}`}
                    >
                      <td className="px-4 py-3 text-[0.8rem] font-medium text-foreground">
                        {o.supplierName}
                        {o.docNo && (
                          <span className="block font-mono text-[0.68rem] font-normal text-muted-foreground">
                            {o.docNo}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[0.75rem] text-muted-foreground">
                        {fmt.date(o.date)}
                      </td>
                      <td className="px-4 py-3 text-[0.75rem] text-muted-foreground">
                        {t('order.itemsCount', { count: o.items?.length ?? 0 })}
                      </td>
                      <td className="px-4 py-3 text-[0.75rem] text-muted-foreground">
                        {t('order.unitsProgress', {
                          done: fmt.number(units.received),
                          total: fmt.number(units.ordered),
                        })}
                        {partial ? t('order.partial') : ''}
                      </td>
                      <td className="px-4 py-3 text-[0.8rem] font-semibold text-foreground">
                        {fmt.moneyIn(o.total, o.currency)}
                        {(o.taxAmount ?? 0) > 0 && (
                          <span className="block text-[0.65rem] font-normal text-muted-foreground">
                            {t('tax.included', {
                              amount: fmt.moneyIn(o.taxAmount ?? 0, o.currency),
                              rate: fmt.number(o.taxRate ?? 0),
                            })}
                          </span>
                        )}
                        <BaseEquivalent
                          base={o.baseTotal ?? o.total}
                          currency={o.currency}
                          rate={o.fxRate || 1}
                          rateDate={o.fxRateDate}
                          source={o.fxRateSource}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[0.68rem] font-medium ${statusClass(o.status)}`}
                          title={o.cancelReason || undefined}
                        >
                          {partial ? t('status.partiallyReceived') : statusLabel(o.status, t)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {o.status === 'pending' && o.approvalStatus === 'pending' && (
                            <span className="text-[0.72rem] text-amber-700 dark:text-amber-400">
                              {t('po.awaitingApproval')}
                            </span>
                          )}
                          {o.status === 'pending' && o.approvalStatus === 'rejected' && (
                            <span className="text-[0.72rem] text-red-600 dark:text-red-400">
                              {t('po.approvalRejected')}
                            </span>
                          )}
                          {o.status === 'pending' &&
                            o.approvalStatus !== 'pending' &&
                            o.approvalStatus !== 'rejected' &&
                            can('purchasing') && (
                              <button onClick={() => approve(o.id)} className={actionCls}>
                                <Check size={11} /> {t('po.approve')}
                              </button>
                            )}
                          {o.status === 'approved' && can('receiving') && (
                            <button onClick={() => openReceipt(o)} className={actionCls}>
                              <Package size={11} /> {t('po.receive')}
                            </button>
                          )}
                          {(o.status === 'pending' ||
                            (o.status === 'approved' && units.received === 0)) &&
                            can('purchasing') && (
                              <button onClick={() => setCancelling(o)} className={actionCls}>
                                <Ban size={11} /> {t('order.cancel')}
                              </button>
                            )}
                          <Link href={`/erp/print/purchase-order/${o.id}`} className={actionCls}>
                            <Printer size={11} /> {t('print.print')}
                          </Link>
                          {(o.status === 'approved' || o.status === 'received') && (
                            <button onClick={() => toggleHistory(o.id)} className={actionCls}>
                              <History size={11} /> {t('order.history')}
                            </button>
                          )}
                          {o.status === 'cancelled' && (
                            <span
                              className="text-[0.72rem] text-muted-foreground opacity-70 truncate max-w-[200px]"
                              title={o.cancelReason}
                            >
                              {o.cancelReason || t('status.cancelled')}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {historyFor === o.id && (
                      <tr className="border-b border-border">
                        <td
                          colSpan={7}
                          className="px-4 py-3"
                          style={{ background: 'var(--background)' }}
                        >
                          {events.length === 0 ? (
                            <p className="text-[0.75rem] text-muted-foreground">
                              {t('po.noReceipts')}
                            </p>
                          ) : (
                            <ul className="space-y-1.5">
                              {events.map((ev) => (
                                <li
                                  key={ev.id}
                                  className="flex flex-wrap items-center justify-between gap-2 text-[0.75rem]"
                                >
                                  <span className="text-muted-foreground">
                                    <span
                                      className={
                                        ev.isReversal
                                          ? 'text-amber-700 dark:text-amber-400'
                                          : 'text-foreground'
                                      }
                                    >
                                      {ev.isReversal ? t('order.reversal') : t('po.receipt')}
                                    </span>
                                    {ev.docNo ? ` ${ev.docNo}` : ''}
                                    {' · '}
                                    {fmt.dateTime(ev.createdAt)}
                                    {' · '}
                                    {ev.lines
                                      .map((l) => `${l.quantity} × ${l.productName}`)
                                      .join(', ')}
                                    {ev.reason ? ` · ${ev.reason}` : ev.note ? ` · ${ev.note}` : ''}
                                    {ev.reversedByEventId ? t('order.reversed') : ''}
                                  </span>
                                  {!ev.isReversal && !ev.reversedByEventId && can('receiving') && (
                                    <button
                                      onClick={() =>
                                        setReversing({ event: ev, requestId: newRequestId() })
                                      }
                                      className={actionCls}
                                    >
                                      <Undo2 size={11} /> {t('order.reverse')}
                                    </button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {orders.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-[0.8rem] text-muted-foreground"
                  >
                    {t('po.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <Pagination {...list.props} />
        </div>
      )}

      {orders.length > 0 && (
        <div className="space-y-3">
          {list.items.map((o) => (
            <div key={`detail-${o.id}`} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <span className="text-[0.8rem] font-semibold text-foreground">
                    {o.supplierName}
                  </span>
                  <span className="text-[0.75rem] text-muted-foreground ml-2">
                    · {fmt.date(o.date)}
                  </span>
                </div>
                <span className="text-[0.8rem] font-bold text-foreground">
                  {fmt.moneyIn(o.total, o.currency)}
                </span>
              </div>
              {o.items?.map((item: any, idx: number) => (
                <div key={idx} className="flex items-center justify-between text-[0.75rem]">
                  <span className="text-muted-foreground">
                    {item.productName}
                    {o.status !== 'pending' && o.status !== 'cancelled' && (
                      <span className="ml-2 opacity-70">
                        {t('po.receivedOfTotal', {
                          received: fmt.number(item.qtyReceived),
                          total: fmt.number(item.qty),
                        })}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {fmt.number(item.qty)} × {fmt.moneyIn(item.price, o.currency)} ={' '}
                    <span className="text-foreground">
                      {fmt.moneyIn(item.qty * item.price, o.currency)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {receipt && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
          style={{ background: 'rgba(0,0,0,0.7)' }}
        >
          <form
            onSubmit={submitReceipt}
            className="w-full max-w-xl rounded-2xl border border-border bg-card my-8"
          >
            <div className="flex items-center justify-between p-5 border-b border-border">
              <h2 className="text-[1rem] font-semibold text-foreground">
                {t('po.receiveTitle', { supplier: receipt.order.supplierName })}
              </h2>
              <button
                type="button"
                onClick={() => setReceipt(null)}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-[0.75rem] text-muted-foreground">{t('po.receiveHint')}</p>
              <table className="w-full">
                <thead>
                  <tr>
                    {[
                      t('order.product'),
                      t('order.ordered'),
                      t('po.received'),
                      t('order.remaining'),
                      t('po.receiveNow'),
                    ].map((h) => (
                      <th
                        key={h}
                        className="text-left py-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(receipt.order.items || []).map((item: any) => {
                    const remaining = remainingQty(item.qty, item.qtyReceived);
                    return (
                      <tr key={item.id}>
                        <td className="py-1.5 text-[0.78rem] text-foreground">
                          {item.productName}
                        </td>
                        <td className="py-1.5 text-[0.78rem] text-muted-foreground">
                          {fmt.number(item.qty)}{' '}
                          {t(UNIT_LABEL[item.unit as UnitCode] ?? 'unit.pcs')}
                        </td>
                        <td className="py-1.5 text-[0.78rem] text-muted-foreground">
                          {fmt.number(item.qtyReceived)}
                        </td>
                        <td className="py-1.5 text-[0.78rem] text-muted-foreground">
                          {fmt.number(remaining)}
                        </td>
                        <td className="py-1.5">
                          <input
                            type="number"
                            min={0}
                            max={remaining}
                            step="any"
                            inputMode="decimal"
                            disabled={remaining === 0}
                            aria-label={t('po.receiveNowFor', { product: item.productName })}
                            className="w-20 rounded border px-2 py-1 text-[0.78rem] text-foreground disabled:opacity-40"
                            style={inputStyle}
                            value={receipt.qty[item.id] ?? 0}
                            onChange={(e) =>
                              setReceipt(
                                (r) =>
                                  r && {
                                    ...r,
                                    qty: {
                                      ...r.qty,
                                      [item.id]: Math.max(
                                        0,
                                        Math.min(remaining, roundQty(Number(e.target.value) || 0))
                                      ),
                                    },
                                  }
                              )
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <input
                className={inputCls}
                style={inputStyle}
                placeholder={t('po.receiptNotePlaceholder')}
                maxLength={500}
                value={receipt.note}
                onChange={(e) => setReceipt((r) => r && { ...r, note: e.target.value })}
              />
              {receipt.order.currency && base && (
                <div className="space-y-1">
                  <RateField
                    id="receipt-rate"
                    currency={receipt.order.currency}
                    base={base}
                    date={today}
                    value={receiptRate}
                    onChange={setReceiptRate}
                    inputClassName={inputCls}
                    inputStyle={inputStyle}
                  />
                  <p className="text-[0.68rem] text-muted-foreground">{t('cur.receiptRate')}</p>
                </div>
              )}
              {receiptError && (
                <p className="text-[0.78rem] text-red-600 dark:text-red-400">{receiptError}</p>
              )}
            </div>
            <div className="flex gap-2 p-5 border-t border-border">
              <button
                type="button"
                onClick={() => setReceipt(null)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
              >
                {t('common.close')}
              </button>
              <button
                type="submit"
                disabled={receiving}
                className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
              >
                {receiving
                  ? t('common.saving')
                  : receiptError
                    ? t('common.retry')
                    : t('po.recordReceipt')}
              </button>
            </div>
          </form>
        </div>
      )}

      {cancelling && (
        <ReasonDialog
          title={t('po.cancelTitle')}
          description={t('po.cancelBody', {
            supplier: cancelling.supplierName,
            total: fmt.money(cancelling.total),
          })}
          confirmLabel={t('order.cancelOrder')}
          onClose={() => setCancelling(null)}
          onConfirm={async (reason) => {
            await purchaseOrderService.cancel(cancelling.id, reason);
            await refresh();
          }}
        />
      )}

      {reversing && (
        <ReasonDialog
          title={t('po.reverseTitle')}
          description={t('po.reverseBody')}
          confirmLabel={t('po.reverseTitle')}
          onClose={() => setReversing(null)}
          onConfirm={async (reason) => {
            await fulfillmentService.reverse(reversing.event.id, reason, reversing.requestId);
            await refresh();
            if (historyFor) await loadEvents(historyFor);
          }}
        />
      )}

      {showForm && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
          style={{ background: 'rgba(0,0,0,0.7)' }}
        >
          <div
            className="w-full max-w-2xl rounded-2xl border border-border my-8"
            style={{ background: 'var(--card)', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}
          >
            <div className="flex items-center justify-between p-5 border-b border-border">
              <h2 className="text-[1rem] font-semibold text-foreground">{t('po.createTitle')}</h2>
              <button
                onClick={() => setShowForm(false)}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                    {t('po.supplierRequired')}
                  </label>
                  <RecordPicker
                    className={inputCls}
                    style={inputStyle}
                    ariaLabel={t('po.supplierRequired')}
                    placeholder={t('po.selectSupplier')}
                    value={form.supplierId}
                    valueLabel={form.supplierName}
                    required
                    search={pickers.suppliers}
                    onChange={(sup) =>
                      setForm((f) => ({
                        ...f,
                        supplierId: sup?.id ?? '',
                        supplierName: sup?.label ?? '',
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                    {t('order.orderDate')}
                  </label>
                  <input
                    type="date"
                    className={inputCls}
                    style={inputStyle}
                    value={form.date}
                    onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                  />
                </div>
              </div>

              {currencySettings && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="po-currency"
                      className="block text-[0.7rem] text-muted-foreground mb-1.5"
                    >
                      {t('cur.currency')}
                    </label>
                    <CurrencySelect
                      id="po-currency"
                      className={inputCls}
                      style={inputStyle}
                      value={form.currency}
                      base={base}
                      currencies={currencySettings.currencies}
                      onChange={(code) => {
                        setForm((f) => ({ ...f, currency: code }));
                        setRate(EMPTY_RATE);
                      }}
                    />
                  </div>
                  {form.currency && (
                    <div className="space-y-1">
                      <RateField
                        id="po-rate"
                        currency={form.currency}
                        base={base}
                        date={form.date}
                        value={rate}
                        onChange={setRate}
                        inputClassName={inputCls}
                        inputStyle={inputStyle}
                      />
                      <p className="text-[0.68rem] text-muted-foreground">
                        {t('cur.orderRateNote')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[0.7rem] text-muted-foreground">
                    {t('order.lineItemsRequired')}
                  </label>
                  <button
                    type="button"
                    onClick={addItem}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[0.72rem] text-muted-foreground border border-border hover:text-foreground transition-colors"
                  >
                    <Plus size={11} /> {t('order.addItem')}
                  </button>
                </div>

                {form.items.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border p-4 text-center text-[0.78rem] text-muted-foreground opacity-60">
                    {t('order.noItems')}
                  </div>
                )}

                <div className="space-y-2">
                  {form.items.map((item, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                      <div className="col-span-4">
                        <RecordPicker
                          className={inputCls}
                          style={inputStyle}
                          ariaLabel={t('order.selectProduct')}
                          placeholder={t('order.selectProduct')}
                          value={item.productId}
                          valueLabel={item.productName}
                          search={searchProducts}
                          onChange={(p) => pickProduct(idx, p?.data ?? null)}
                        />
                      </div>
                      <div className="col-span-3">
                        <QtyUnitInput
                          entry={item}
                          free={!item.productId}
                          onChange={(entry) => updateQty(idx, entry)}
                          inputCls={inputCls}
                          inputStyle={inputStyle}
                        />
                      </div>
                      <div className="col-span-3">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          className={inputCls}
                          style={inputStyle}
                          placeholder={t('common.price')}
                          value={item.price}
                          onChange={(e) => updateItem(idx, 'price', e.target.value)}
                        />
                      </div>
                      <div className="col-span-1 text-[0.75rem] text-muted-foreground text-right">
                        {fmt.moneyIn(item.qty * item.price, form.currency)}
                      </div>
                      <div className="col-span-1 flex justify-end">
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          className="p-1 text-muted-foreground hover:text-foreground"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {form.items.length > 0 && (
                  <div className="flex justify-end mt-3 pt-3 border-t border-border">
                    <div className="text-right">
                      <span className="text-[0.72rem] text-muted-foreground mr-3">
                        {t('common.total')}
                      </span>
                      <span className="text-[1rem] font-bold text-foreground">
                        {fmt.moneyIn(total, form.currency)}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                  {t('common.notes')}
                </label>
                <input
                  className={inputCls}
                  style={inputStyle}
                  placeholder={t('order.notesPlaceholder')}
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                />
              </div>

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
                      <Check size={13} /> {t('po.create')}
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
