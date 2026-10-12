'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import {
  salesOrderService,
  productService,
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
  FileText,
  Truck,
  Trash2,
  X,
  Check,
  Pencil,
  Ban,
  History,
  Undo2,
  Search,
  Printer,
} from 'lucide-react';
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

interface SOFormData {
  customerId: string;
  customerName: string;
  date: string;
  notes: string;
  items: LineItem[];
  currency: string | null;
}

type Availability = Record<string, { onHand: number; reserved: number; available: number }>;

const emptyForm = (): SOFormData => ({
  customerId: '',
  customerName: '',
  date: new Date().toISOString().slice(0, 10),
  notes: '',
  items: [],
  currency: null,
});

function deliveredUnits(order: any) {
  const items = order.items || [];
  return {
    delivered: items.reduce((s: number, i: any) => s + (i.qtyDelivered || 0), 0),
    ordered: items.reduce((s: number, i: any) => s + (i.qty || 0), 0),
  };
}

export default function SalesOrdersPage() {
  const { user } = useAuth();
  const { can } = useWorkspace();
  const { t, fmt } = useI18n();
  // One page at a time, searched by the database; `orders` is the page shown.
  const list = useServerPage<any>(
    (q) => (user ? salesOrderService.page(user.id, q) : Promise.resolve({ rows: [], total: 0 })),
    [user?.id]
  );
  const orders = list.items;
  // Counts and totals of every order (db/migrations/20261012000008_erp_list_summaries.sql).
  const [figures, setFigures] = useState<Record<string, any> | null>(null);
  const loadFigures = useCallback(() => {
    listSummary('sales_orders')
      .then(setFigures)
      .catch(() => setFigures(null));
  }, []);
  const pickers = useRecordSearch();
  // Stock of the products on screen (picked, or on the order being edited or delivered).
  const [availability, setAvailability] = useState<Availability>({});
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SOFormData>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [delivery, setDelivery] = useState<{
    order: any;
    qty: Record<string, number>;
    note: string;
    requestId: string;
  } | null>(null);
  const [delivering, setDelivering] = useState(false);
  const [deliveryError, setDeliveryError] = useState('');
  const [cancelling, setCancelling] = useState<any | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [events, setEvents] = useState<FulfillmentEvent[]>([]);
  const [reversing, setReversing] = useState<{ event: FulfillmentEvent; requestId: string } | null>(
    null
  );
  const [rate, setRate] = useState<RateChoice>(EMPTY_RATE);
  const [invoicing, setInvoicing] = useState<any | null>(null);
  const [invoiceRate, setInvoiceRate] = useState<RateChoice>(EMPTY_RATE);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [invoiceError, setInvoiceError] = useState('');
  const { settings: currencySettings } = useCurrencySettings();
  const base = currencySettings?.baseCurrency ?? '';
  const today = new Date().toISOString().slice(0, 10);

  const refresh = useCallback(async () => {
    if (!user) return;
    list.reload();
    loadFigures();
    // Stock changed: read it again when products are picked or shown.
    setAvailability({});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- list.reload only bumps a counter
  }, [user, loadFigures]);

  const loadAvailability = useCallback(async (ids: string[]) => {
    try {
      const found = await productService.availabilityOf(ids);
      setAvailability((a) => ({ ...a, ...found }));
      return found;
    } catch {
      return {} as Availability;
    }
  }, []);

  const loading = list.loading;
  useEffect(() => {
    loadFigures();
  }, [loadFigures, user?.id]);
  useEffect(() => {
    if (list.error)
      setError((list.error instanceof Error && list.error.message) || tr('so.loadFailed'));
  }, [list.error]);

  const loadEvents = useCallback(async (orderId: string) => {
    try {
      setEvents(await fulfillmentService.getEvents('sales', orderId));
    } catch (err: any) {
      setError(err?.message || tr('so.historyFailed'));
    }
  }, []);

  const total = form.items.reduce((s, i) => s + i.qty * i.price, 0);

  function availableFor(productId: string, from: Availability = availability) {
    if (!from[productId]) return null;
    const own = editingId
      ? (orders.find((o) => o.id === editingId)?.items || [])
          .filter((i: any) => i.productId === productId)
          .reduce((s: number, i: any) => s + remainingQty(i.qty, i.qtyDelivered), 0)
      : 0;
    return from[productId].available + own;
  }

  async function searchProducts(text: string) {
    const rows = await pickers.products(text);
    const found = await loadAvailability(rows.map((p) => p.id));
    return rows.map((p) => {
      const a = availableFor(p.id, found);
      return productOption(p, a != null ? t('picker.stock', { count: fmt.number(a) }) : undefined);
    });
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
        ? prod.sellingPrice
        : rate.valid
          ? (convertAmount(prod.sellingPrice, String(1 / Number(rate.rate)), 2) ?? 0)
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

  function addItem() {
    setForm((f) => ({
      ...f,
      items: [...f.items, newLine()],
    }));
  }

  function removeItem(idx: number) {
    setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
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

  function openEdit(order: any) {
    setEditingId(order.id);
    setForm({
      customerId: order.customerId || '',
      customerName: order.customerName,
      date: order.date,
      notes: order.notes || '',
      items: (order.items || []).map((i: any) => ({
        productId: i.productId || '',
        productName: i.productName,
        qty: i.qty,
        price: i.price,
        unit: i.unit ?? 'pcs',
        entryQty: i.qty,
        entryUnit: i.unit ?? 'pcs',
        density: null,
      })),
      currency: order.currency ?? null,
    });
    setRate(EMPTY_RATE);
    setError('');
    setShowForm(true);
    void loadAvailability((order.items || []).map((i: any) => i.productId));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!form.customerName) {
      setError(t('so.selectCustomer'));
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
    if (!editingId && form.currency && !rate.valid) {
      setError(t('cur.err.invalid'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (editingId) await salesOrderService.updateItems(editingId, form.items, form.notes);
      else
        await salesOrderService.create(user.id, {
          ...form,
          total,
          fxRate: rateForServer(rate, form.currency),
        });
      await refresh();
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm());
      setRate(EMPTY_RATE);
    } catch (err: any) {
      setError(err?.message || t('so.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function issueInvoice(order: any) {
    if (!user) return;
    // A foreign-currency order asks for the invoice-date rate first.
    if (order.currency) {
      setInvoicing(order);
      setInvoiceRate(EMPTY_RATE);
      setInvoiceError('');
      return;
    }
    setError('');
    try {
      await salesOrderService.issueInvoice(user.id, order.id);
      await refresh();
    } catch (err: any) {
      setError(err?.message || t('so.updateFailed'));
    }
  }

  async function submitForeignInvoice(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !invoicing) return;
    if (!invoiceRate.valid) {
      setInvoiceError(t('cur.err.invalid'));
      return;
    }
    setInvoiceBusy(true);
    setInvoiceError('');
    try {
      await salesOrderService.issueInvoice(
        user.id,
        invoicing.id,
        rateForServer(invoiceRate, invoicing.currency)
      );
      setInvoicing(null);
      await refresh();
    } catch (err: any) {
      setInvoiceError(err?.message || t('so.updateFailed'));
    } finally {
      setInvoiceBusy(false);
    }
  }

  function openDelivery(order: any) {
    const qty: Record<string, number> = {};
    for (const item of order.items || []) qty[item.id] = remainingQty(item.qty, item.qtyDelivered);
    setDelivery({ order, qty, note: '', requestId: newRequestId() });
    setDeliveryError('');
    void loadAvailability((order.items || []).map((i: any) => i.productId));
  }

  async function submitDelivery(e: React.FormEvent) {
    e.preventDefault();
    if (!delivery) return;
    const lines = Object.entries(delivery.qty)
      .filter(([, q]) => q > 0)
      .map(([itemId, q]) => ({ itemId, qty: q }));
    if (lines.length === 0) {
      setDeliveryError(t('order.enterQty'));
      return;
    }
    setDelivering(true);
    setDeliveryError('');
    try {
      await salesOrderService.recordDelivery(
        delivery.order.id,
        lines,
        delivery.requestId,
        delivery.note
      );
      const orderId = delivery.order.id;
      setDelivery(null);
      await refresh();
      if (historyFor === orderId) await loadEvents(orderId);
    } catch (err: any) {
      setDeliveryError(err?.message || t('so.deliveryFailed'));
    } finally {
      setDelivering(false);
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
    s === 'delivered'
      ? 'bg-green-100 dark:bg-green-950/30 text-green-700 dark:text-green-400'
      : s === 'invoiced'
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
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('so.title')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">
            {loading
              ? t('common.loading')
              : t('order.activeSummary', {
                  count: liveCount,
                  total: fmt.money(Number(figures?.live_total ?? 0)),
                })}
          </p>
        </div>
        {can('sales') && (
          <button
            onClick={() => {
              setShowForm(true);
              setEditingId(null);
              setForm(emptyForm());
              setError('');
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground"
          >
            <Plus size={14} /> {t('so.create')}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(['draft', 'invoiced', 'delivered', 'cancelled'] as const).map((s) => {
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
          placeholder={t('so.search')}
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

      {error && !showForm && (
        <div className="rounded-lg px-4 py-3 text-[0.8rem] text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-border overflow-x-auto bg-card">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              {[
                t('so.customer'),
                t('order.date'),
                t('order.items'),
                t('so.delivered'),
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
            {loading ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-[0.8rem] text-muted-foreground"
                >
                  {t('so.loading')}
                </td>
              </tr>
            ) : (
              list.items.map((o, i) => {
                const units = deliveredUnits(o);
                const partial = o.status === 'invoiced' && units.delivered > 0;
                return (
                  <React.Fragment key={o.id}>
                    <tr
                      {...list.focusAttrs(o.id)}
                      className={`border-b border-border ${i === list.items.length - 1 && historyFor !== o.id ? 'border-b-0' : ''}`}
                    >
                      <td className="px-4 py-3 text-[0.8rem] font-medium text-foreground">
                        {o.customerName}
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
                          done: fmt.number(units.delivered),
                          total: fmt.number(units.ordered),
                        })}
                        {partial ? t('order.partial') : ''}
                      </td>
                      <td className="px-4 py-3 text-[0.8rem] font-semibold text-foreground">
                        {fmt.moneyIn(o.total, o.currency)}
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
                          {partial ? t('status.partiallyDelivered') : statusLabel(o.status, t)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {o.status === 'draft' && can('sales') && (
                            <button onClick={() => openEdit(o)} className={actionCls}>
                              <Pencil size={11} /> {t('common.edit')}
                            </button>
                          )}
                          {o.status === 'draft' && can('invoicing') && (
                            <button onClick={() => issueInvoice(o)} className={actionCls}>
                              <FileText size={11} /> {t('so.invoice')}
                            </button>
                          )}
                          {o.status === 'invoiced' && can('fulfillment') && (
                            <button onClick={() => openDelivery(o)} className={actionCls}>
                              <Truck size={11} /> {t('so.deliver')}
                            </button>
                          )}
                          {(o.status === 'draft' ||
                            (o.status === 'invoiced' && units.delivered === 0)) &&
                            can('sales') && (
                              <button onClick={() => setCancelling(o)} className={actionCls}>
                                <Ban size={11} /> {t('order.cancel')}
                              </button>
                            )}
                          <Link href={`/erp/print/sales-order/${o.id}`} className={actionCls}>
                            <Printer size={11} /> {t('print.print')}
                          </Link>
                          {(o.status === 'invoiced' || o.status === 'delivered') && (
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
                              {t('so.noDeliveries')}
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
                                      {ev.isReversal ? t('order.reversal') : t('so.delivery')}
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
                                  <Link href={`/erp/print/delivery/${ev.id}`} className={actionCls}>
                                    <Printer size={11} /> {t('print.printDeliveryNote')}
                                  </Link>
                                  {!ev.isReversal &&
                                    !ev.reversedByEventId &&
                                    can('fulfillment') && (
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
              })
            )}
            {!loading && orders.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-[0.8rem] text-muted-foreground"
                >
                  {t('so.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination {...list.props} />
      </div>

      {delivery && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
          style={{ background: 'rgba(0,0,0,0.7)' }}
        >
          <form
            onSubmit={submitDelivery}
            className="w-full max-w-xl rounded-2xl border border-border bg-card my-8"
          >
            <div className="flex items-center justify-between p-5 border-b border-border">
              <h2 className="text-[1rem] font-semibold text-foreground">
                {t('so.recordDeliveryTitle', { customer: delivery.order.customerName })}
              </h2>
              <button
                type="button"
                onClick={() => setDelivery(null)}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-[0.75rem] text-muted-foreground">{t('so.deliveryHint')}</p>
              <table className="w-full">
                <thead>
                  <tr>
                    {[
                      t('order.product'),
                      t('order.ordered'),
                      t('so.delivered'),
                      t('order.remaining'),
                      t('so.deliverNow'),
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
                  {(delivery.order.items || []).map((item: any) => {
                    const remaining = remainingQty(item.qty, item.qtyDelivered);
                    const onHand = availability?.[item.productId]?.onHand;
                    return (
                      <tr key={item.id}>
                        <td className="py-1.5 text-[0.78rem] text-foreground">
                          {item.productName}
                          {onHand != null && (
                            <span className="block text-[0.65rem] text-muted-foreground">
                              {t('so.onHandCount', { count: fmt.number(onHand) })}
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 text-[0.78rem] text-muted-foreground">
                          {fmt.number(item.qty)}{' '}
                          {t(UNIT_LABEL[item.unit as UnitCode] ?? 'unit.pcs')}
                        </td>
                        <td className="py-1.5 text-[0.78rem] text-muted-foreground">
                          {fmt.number(item.qtyDelivered)}
                        </td>
                        <td className="py-1.5 text-[0.78rem] text-muted-foreground">{remaining}</td>
                        <td className="py-1.5">
                          <input
                            type="number"
                            min={0}
                            max={remaining}
                            step="any"
                            inputMode="decimal"
                            disabled={remaining === 0}
                            aria-label={t('so.deliverNowFor', { product: item.productName })}
                            className="w-20 rounded border px-2 py-1 text-[0.78rem] text-foreground disabled:opacity-40"
                            style={inputStyle}
                            value={delivery.qty[item.id] ?? 0}
                            onChange={(e) =>
                              setDelivery(
                                (d) =>
                                  d && {
                                    ...d,
                                    qty: {
                                      ...d.qty,
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
                placeholder={t('so.deliveryNotePlaceholder')}
                maxLength={500}
                value={delivery.note}
                onChange={(e) => setDelivery((d) => d && { ...d, note: e.target.value })}
              />
              {deliveryError && (
                <p className="text-[0.78rem] text-red-600 dark:text-red-400">{deliveryError}</p>
              )}
            </div>
            <div className="flex gap-2 p-5 border-t border-border">
              <button
                type="button"
                onClick={() => setDelivery(null)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
              >
                {t('common.close')}
              </button>
              <button
                type="submit"
                disabled={delivering}
                className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
              >
                {delivering
                  ? t('common.saving')
                  : deliveryError
                    ? t('common.retry')
                    : t('so.recordDelivery')}
              </button>
            </div>
          </form>
        </div>
      )}

      {invoicing && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
          style={{ background: 'rgba(0,0,0,0.7)' }}
        >
          <form
            onSubmit={submitForeignInvoice}
            className="w-full max-w-md rounded-2xl border border-border bg-card my-8"
          >
            <div className="flex items-center justify-between p-5 border-b border-border">
              <h2 className="text-[1rem] font-semibold text-foreground">
                {t('so.invoice')} · {invoicing.customerName}
              </h2>
              <button
                type="button"
                onClick={() => setInvoicing(null)}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-[0.85rem] font-semibold text-foreground">
                {fmt.moneyIn(invoicing.total, invoicing.currency)}
              </p>
              {base && (
                <RateField
                  id="so-invoice-rate"
                  currency={invoicing.currency}
                  base={base}
                  date={today}
                  value={invoiceRate}
                  onChange={setInvoiceRate}
                  inputClassName={inputCls}
                  inputStyle={inputStyle}
                />
              )}
              <p className="text-[0.68rem] text-muted-foreground">{t('cur.invoiceRate')}</p>
              {invoiceError && (
                <p className="text-[0.78rem] text-red-600 dark:text-red-400">{invoiceError}</p>
              )}
            </div>
            <div className="flex gap-2 p-5 border-t border-border">
              <button
                type="button"
                onClick={() => setInvoicing(null)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={invoiceBusy || !invoiceRate.valid}
                className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
              >
                {invoiceBusy ? t('common.saving') : t('so.invoice')}
              </button>
            </div>
          </form>
        </div>
      )}

      {cancelling && (
        <ReasonDialog
          title={t('so.cancelTitle')}
          description={t(
            cancelling.status === 'invoiced' ? 'so.cancelBodyInvoiced' : 'so.cancelBody',
            {
              customer: cancelling.customerName,
              total: fmt.moneyIn(cancelling.total, cancelling.currency),
            }
          )}
          confirmLabel={t('order.cancelOrder')}
          onClose={() => setCancelling(null)}
          onConfirm={async (reason) => {
            await salesOrderService.cancel(cancelling.id, reason);
            await refresh();
          }}
        />
      )}

      {reversing && (
        <ReasonDialog
          title={t('so.reverseTitle')}
          description={t('so.reverseBody')}
          confirmLabel={t('so.reverseTitle')}
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
              <h2 className="text-[1rem] font-semibold text-foreground">
                {editingId ? t('so.editTitle') : t('so.createTitle')}
              </h2>
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
                    {t('invoice.customerRequired')}
                  </label>
                  <RecordPicker
                    className={inputCls}
                    style={inputStyle}
                    ariaLabel={t('invoice.customerRequired')}
                    placeholder={t('invoice.selectCustomerOption')}
                    value={form.customerId}
                    valueLabel={form.customerName}
                    disabled={!!editingId}
                    required={!editingId}
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
                <div>
                  <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
                    {t('order.orderDate')}
                  </label>
                  <input
                    type="date"
                    className={inputCls}
                    style={inputStyle}
                    value={form.date}
                    disabled={!!editingId}
                    onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                  />
                </div>
              </div>

              {currencySettings && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="so-currency"
                      className="block text-[0.7rem] text-muted-foreground mb-1.5"
                    >
                      {t('cur.currency')}
                    </label>
                    <CurrencySelect
                      id="so-currency"
                      className={inputCls}
                      style={inputStyle}
                      value={form.currency}
                      base={base}
                      currencies={currencySettings.currencies}
                      disabled={!!editingId}
                      onChange={(code) => {
                        setForm((f) => ({ ...f, currency: code }));
                        setRate(EMPTY_RATE);
                      }}
                    />
                  </div>
                  {form.currency && !editingId && (
                    <div className="space-y-1">
                      <RateField
                        id="so-rate"
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
                    {t('order.lineItemsRequired')}{' '}
                    <span className="opacity-70">{t('so.reserveHint')}</span>
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
                  {form.items.map((item, idx) => {
                    const available = item.productId ? availableFor(item.productId) : null;
                    const requested = form.items
                      .filter((x) => x.productId === item.productId)
                      .reduce((s, x) => s + x.qty, 0);
                    const short = available != null && requested > available;
                    return (
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
                          {short && (
                            <p className="text-[0.65rem] text-red-600 dark:text-red-400 mt-0.5">
                              {t('so.onlyAvailable', {
                                count: fmt.number(Math.max(0, available!)),
                              })}
                            </p>
                          )}
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
                    );
                  })}
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
                      <Check size={13} /> {editingId ? t('common.saveChanges') : t('so.create')}
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
