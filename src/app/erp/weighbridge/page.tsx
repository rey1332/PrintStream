'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Plus, Printer, Scale } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { UNIT_LABEL, isUnit } from '@/lib/units';
import { useWorkspace } from '../lib/WorkspaceContext';
import { rpcWorkspaceId } from '../lib/workspace';
import {
  weighbridgeService,
  type SummaryRow,
  type TicketStatus,
  type Vehicle,
  type WeighCustomer,
  type WeighTicket,
} from '../lib/weighbridgeService';
import { WeighInDialog, type WeighProduct } from './components/WeighInDialog';
import { WeighOutDialog } from './components/WeighOutDialog';
import { TrucksTab } from './components/TrucksTab';
import { InvoiceTab } from './components/InvoiceTab';
import { errorKey, inputCls, todayIso } from '../components/moduleUi';

type Tab = 'tickets' | 'trucks' | 'invoice';
const TABS: [Tab, MessageKey][] = [
  ['tickets', 'wb.tab.tickets'],
  ['trucks', 'wb.tab.trucks'],
  ['invoice', 'wb.tab.invoice'],
];
const STATUS_LABEL: Record<TicketStatus, MessageKey> = {
  open: 'wb.status.open',
  completed: 'wb.status.completed',
  cancelled: 'wb.status.cancelled',
};
const WEIGHABLE = ['kg', 'ton', 'm3', 'l', 'rit'];

export default function WeighbridgePage() {
  const { t, fmt } = useI18n();
  const { active, can, role } = useWorkspace();
  const [tab, setTab] = useState<Tab>('tickets');
  const [date, setDate] = useState(() => todayIso());
  const [tickets, setTickets] = useState<WeighTicket[]>([]);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [customers, setCustomers] = useState<WeighCustomer[]>([]);
  const [products, setProducts] = useState<WeighProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [weighIn, setWeighIn] = useState(false);
  const [weighOut, setWeighOut] = useState<WeighTicket | null>(null);
  const canWeigh = can('fulfillment');

  const loadTickets = useCallback(async () => {
    const [list, sum] = await Promise.all([
      weighbridgeService.tickets(date),
      weighbridgeService.summary(date, date),
    ]);
    setTickets(list);
    setSummary(sum);
  }, [date]);

  const loadMaster = useCallback(async () => {
    const [v, c, p] = await Promise.all([
      weighbridgeService.vehicles(),
      weighbridgeService.customers(),
      createClient()
        .from('erp_products')
        .select('id, name, unit, density, selling_price, current_stock')
        .eq('workspace_id', rpcWorkspaceId())
        .order('name', { ascending: true })
        .limit(2000),
    ]);
    setVehicles(v);
    setCustomers(c);
    setProducts(
      (p.data ?? [])
        .filter((r: any) => WEIGHABLE.includes(r.unit))
        .map((r: any) => ({
          id: r.id,
          name: r.name,
          unit: r.unit,
          density: r.density === null ? null : Number(r.density),
          sellingPrice: Number(r.selling_price ?? 0),
          stock: Number(r.current_stock ?? 0),
        }))
    );
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadTickets(), loadMaster()])
      .catch((err) => toast.error(t(errorKey(err))))
      .finally(() => setLoading(false));
  }, [active?.id, loadTickets, loadMaster, t]);

  const refresh = useCallback(() => {
    void Promise.all([loadTickets(), loadMaster()]).catch((err) => toast.error(t(errorKey(err))));
  }, [loadTickets, loadMaster, t]);

  const open = tickets.filter((x) => x.status === 'open');
  const done = tickets.filter((x) => x.status !== 'open');
  const totals = useMemo(
    () =>
      summary.reduce(
        (acc, r) => ({
          tickets: acc.tickets + r.tickets,
          kg: acc.kg + r.netKg,
          amount: acc.amount + r.amount,
        }),
        { tickets: 0, kg: 0, amount: 0 }
      ),
    [summary]
  );
  const unitText = (unit: string) => (isUnit(unit) ? t(UNIT_LABEL[unit]) : unit);
  const kg = (value: number | null) => (value === null ? '—' : fmt.number(value));

  async function cancel(ticket: WeighTicket) {
    const reason = window.prompt(t('wb.cancelPrompt', { ticket: ticket.docNo }));
    if (reason === null) return;
    try {
      await weighbridgeService.cancel(ticket.id, reason);
      toast.success(t('wb.cancelled'));
      refresh();
    } catch (err) {
      toast.error(t(errorKey(err)));
    }
  }

  const iconBtn =
    'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('erp.nav.weighbridge')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">{t('wb.subtitle')}</p>
        </div>
        {canWeigh && tab === 'tickets' && (
          <button
            type="button"
            onClick={() => setWeighIn(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground max-lg:min-h-11"
          >
            <Plus size={14} /> {t('wb.newTicket')}
          </button>
        )}
      </div>

      <div role="tablist" className="flex gap-1 border-b border-border">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-[0.8rem] max-lg:min-h-11 ${tab === key ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {tab === 'trucks' && (
        <TrucksTab
          vehicles={vehicles}
          customers={customers}
          canEdit={canWeigh}
          onChanged={refresh}
        />
      )}
      {tab === 'invoice' && <InvoiceTab canInvoice={can('invoicing')} />}

      {tab === 'tickets' && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-[0.7rem] text-muted-foreground">{t('wb.date')}</span>
              <input
                type="date"
                value={date}
                onChange={(e) => e.target.value && setDate(e.target.value)}
                className={`${inputCls} w-auto`}
              />
            </label>
            <dl className="flex flex-wrap gap-2">
              {[
                [t('wb.summary.tickets'), fmt.number(totals.tickets)],
                [t('wb.summary.weight'), t('wb.tons', { value: fmt.number(totals.kg / 1000) })],
                [t('wb.summary.value'), fmt.money(totals.amount)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-card px-3 py-1.5">
                  <dt className="text-[0.66rem] text-muted-foreground">{label}</dt>
                  <dd className="text-[0.9rem] font-semibold tabular-nums text-foreground">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {summary.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full text-[0.78rem]">
                <caption className="px-4 pt-3 text-left text-[0.75rem] font-semibold text-foreground">
                  {t('wb.summary.byProduct')}
                </caption>
                <tbody>
                  {summary.map((r) => (
                    <tr key={`${r.productId}-${r.unit}`} className="border-t border-border">
                      <td className="px-4 py-2 text-foreground">{r.productName}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmt.number(r.tickets)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {t('wb.tons', { value: fmt.number(r.netKg / 1000) })}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {fmt.number(r.qty)} {unitText(r.unit)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmt.money(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <section className="space-y-2">
            <h2 className="text-[0.85rem] font-semibold text-foreground">{t('wb.open')}</h2>
            {loading ? (
              <div className="h-12 rounded-lg animate-pulse bg-[var(--surface-3)]" />
            ) : open.length === 0 ? (
              <p className="text-[0.78rem] text-muted-foreground">{t('wb.openEmpty')}</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {open.map((x) => (
                  <li key={x.id} className="rounded-xl border border-border bg-card p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-[0.95rem] font-semibold text-foreground">{x.plateNo}</p>
                        <p className="text-[0.72rem] text-muted-foreground">
                          {x.docNo} · {fmt.time(x.firstAt)}
                          {x.driverName ? ` · ${x.driverName}` : ''}
                        </p>
                      </div>
                      <p className="text-right text-[0.8rem] tabular-nums text-foreground">
                        {t('wb.kg', { value: kg(x.firstKg) })}
                      </p>
                    </div>
                    <p className="mt-1 text-[0.78rem] text-foreground">
                      {x.customerName} · {x.productName}
                    </p>
                    {canWeigh && (
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() => setWeighOut(x)}
                          className="flex-1 rounded-lg bg-primary px-3 py-1.5 text-[0.78rem] font-medium text-primary-foreground max-lg:min-h-11"
                        >
                          <Scale size={13} className="mr-1 inline" aria-hidden />
                          {t('wb.weighOut')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void cancel(x)}
                          title={t('wb.cancel')}
                          aria-label={`${t('wb.cancel')}: ${x.docNo}`}
                          className={iconBtn}
                        >
                          <Ban size={14} />
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-[0.85rem] font-semibold text-foreground">{t('wb.done')}</h2>
            {!loading && done.length === 0 ? (
              <p className="text-[0.78rem] text-muted-foreground">{t('wb.doneEmpty')}</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full text-[0.78rem]">
                  <thead className="bg-[var(--surface-2)] text-left text-[0.7rem] text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t('wb.col.ticket')}</th>
                      <th className="px-3 py-2 font-medium">{t('wb.col.truck')}</th>
                      <th className="px-3 py-2 font-medium max-md:hidden">
                        {t('wb.col.customer')}
                      </th>
                      <th className="px-3 py-2 font-medium max-md:hidden">{t('wb.col.product')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('wb.col.net')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('wb.col.qty')}</th>
                      <th className="px-3 py-2 font-medium text-right max-sm:hidden">
                        {t('wb.col.amount')}
                      </th>
                      <th className="px-3 py-2 font-medium">{t('common.status')}</th>
                      <th className="px-3 py-2">
                        <span className="sr-only">{t('common.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {done.map((x) => (
                      <tr
                        key={x.id}
                        className={`border-t border-border ${x.status === 'cancelled' ? 'text-muted-foreground line-through decoration-1' : ''}`}
                      >
                        <td className="px-3 py-2 whitespace-nowrap">
                          {x.docNo}
                          <span className="block text-[0.68rem] text-muted-foreground no-underline">
                            {fmt.time(x.secondAt ?? x.firstAt)}
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{x.plateNo}</td>
                        <td className="px-3 py-2 max-md:hidden">{x.customerName}</td>
                        <td className="px-3 py-2 max-md:hidden">{x.productName}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{kg(x.netKg)}</td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                          {x.qty === null ? '—' : `${fmt.number(x.qty)} ${unitText(x.unit)}`}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums max-sm:hidden">
                          {fmt.money(x.amount)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {t(x.invoiceId ? 'wb.invoiced' : STATUS_LABEL[x.status])}
                        </td>
                        <td className="px-1 py-1 text-right whitespace-nowrap">
                          <a
                            href={`/erp/print/ticket/${x.id}`}
                            target="_blank"
                            rel="noopener"
                            title={t('wb.print')}
                            aria-label={`${t('wb.print')}: ${x.docNo}`}
                            className={iconBtn}
                          >
                            <Printer size={14} />
                          </a>
                          {x.status === 'completed' &&
                            !x.invoiceId &&
                            (role === 'owner' || role === 'admin') && (
                              <button
                                type="button"
                                onClick={() => void cancel(x)}
                                title={t('wb.cancel')}
                                aria-label={`${t('wb.cancel')}: ${x.docNo}`}
                                className={iconBtn}
                              >
                                <Ban size={14} />
                              </button>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {weighIn && (
        <WeighInDialog
          vehicles={vehicles}
          customers={customers}
          products={products}
          onClose={() => setWeighIn(false)}
          onSaved={() => {
            setWeighIn(false);
            refresh();
          }}
        />
      )}
      {weighOut && (
        <WeighOutDialog
          ticket={weighOut}
          vehicle={vehicles.find((v) => v.id === weighOut.vehicleId) ?? null}
          product={products.find((p) => p.id === weighOut.productId) ?? null}
          onClose={() => setWeighOut(null)}
          onSaved={() => {
            setWeighOut(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
