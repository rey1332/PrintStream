'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileCheck2, HandCoins, Plus, ReceiptText, Stamp, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useWorkspace } from '../lib/WorkspaceContext';
import { errorKey, inputCls } from '../components/moduleUi';
import { ReasonDialog } from '../components/ReasonDialog';
import {
  TaxError,
  taxService,
  type FakturRow,
  type SupplierBill,
  type TaxMonth,
} from '../lib/taxService';
import { BillDialog, BupotDialog, FakturDialog, PayBillDialog, WithheldDialog } from './dialogs';

type Tab = 'faktur' | 'bills' | 'summary';

function save({ blob, fileName }: { blob: Blob; fileName: string }) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const monthStart = (offset = 0) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
};
const monthEnd = (start: string) => {
  const d = new Date(`${start}T00:00:00`);
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function TaxPage() {
  const { t } = useI18n();
  const { can } = useWorkspace();
  const tabs: { key: Tab; label: MessageKey; show: boolean }[] = [
    { key: 'faktur', label: 'tax.tab.faktur', show: can('invoicing') },
    {
      key: 'bills',
      label: 'tax.tab.bills',
      show: can('read') || can('purchasing') || can('payments'),
    },
    { key: 'summary', label: 'tax.tab.summary', show: can('read') },
  ];
  const visible = tabs.filter((x) => x.show);
  const [tab, setTab] = useState<Tab>(visible[0]?.key ?? 'faktur');
  const [month, setMonth] = useState(monthStart());

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[1.25rem] font-semibold text-foreground">{t('tax.title')}</h1>
          <p className="text-[0.8rem] text-muted-foreground">{t('tax.subtitle')}</p>
        </div>
        <label className="text-[0.75rem] text-muted-foreground">
          {t('tax.month')}
          <input
            type="month"
            className={`${inputCls} mt-1 w-44`}
            value={month.slice(0, 7)}
            onChange={(e) => e.target.value && setMonth(`${e.target.value}-01`)}
          />
        </label>
      </header>
      <nav className="flex gap-1 border-b border-border" role="tablist">
        {visible.map((x) => (
          <button
            key={x.key}
            role="tab"
            aria-selected={tab === x.key}
            onClick={() => setTab(x.key)}
            className={`px-3 py-2 text-[0.8rem] -mb-px border-b-2 ${
              tab === x.key
                ? 'border-foreground text-foreground font-medium'
                : 'border-transparent text-muted-foreground'
            }`}
          >
            {t(x.label)}
          </button>
        ))}
      </nav>
      {tab === 'faktur' && can('invoicing') && <FakturTab month={month} />}
      {tab === 'bills' && <BillsTab month={month} />}
      {tab === 'summary' && can('read') && <SummaryTab month={month} />}
    </div>
  );
}

const MISSING: Record<string, MessageKey> = {
  seller_npwp: 'tax.missing.sellerNpwp',
  seller_nitku: 'tax.missing.sellerNitku',
  customer: 'tax.missing.customer',
  customer_tax_id: 'tax.missing.customerTaxId',
  customer_nitku: 'tax.missing.customerNitku',
  lines: 'tax.missing.lines',
  currency: 'tax.missing.currency',
};

function FakturTab({ month }: { month: string }) {
  const { t, fmt } = useI18n();
  const [rows, setRows] = useState<FakturRow[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<FakturRow | null>(null);
  const [withholding, setWithholding] = useState<FakturRow | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const load = useCallback(async () => {
    const list = await taxService.faktur(month, monthEnd(month));
    setRows(list);
    setChosen(
      new Set(list.filter((r) => r.status === 'none' && !r.missing.length).map((r) => r.invoiceId))
    );
  }, [month]);

  useEffect(() => {
    setLoading(true);
    load()
      .catch((err) => toast.error(t(errorKey(err, 'tax.err.failed'))))
      .finally(() => setLoading(false));
  }, [load, t]);

  const ready = rows.filter((r) => chosen.has(r.invoiceId));
  const totals = rows.reduce((a, r) => ({ dpp: a.dpp + r.subtotal, ppn: a.ppn + r.taxAmount }), {
    dpp: 0,
    ppn: 0,
  });

  async function exportXml() {
    setBusy(true);
    setProblems([]);
    try {
      save(await taxService.coretax(ready.map((r) => r.invoiceId)));
      toast.success(t('tax.faktur.exported', { count: ready.length }));
      await load();
    } catch (err) {
      if (err instanceof TaxError && err.problems.length) {
        setProblems(
          err.problems.map((p) =>
            p.kind === 'vat_mismatch'
              ? t('tax.problem.vat', {
                  invoice: p.invoice,
                  booked: fmt.money(p.booked ?? 0),
                  faktur: fmt.money(p.faktur ?? 0),
                })
              : t(`tax.problem.${p.kind}` as MessageKey, { invoice: p.invoice })
          )
        );
      } else toast.error(t(errorKey(err, 'tax.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) =>
    setChosen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.78rem] text-muted-foreground">
          {t('tax.faktur.totals', {
            count: rows.length,
            dpp: fmt.money(totals.dpp),
            ppn: fmt.money(totals.ppn),
          })}
        </p>
        <button
          onClick={exportXml}
          disabled={busy || !ready.length}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[0.8rem] font-medium text-primary-foreground disabled:opacity-50"
        >
          <Download size={14} /> {t('tax.faktur.export', { count: ready.length })}
        </button>
      </div>
      {problems.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[0.78rem] text-red-700 dark:text-red-300"
        >
          <p className="font-medium">{t('tax.err.problems')}</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-[0.78rem]">
          <thead className="bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 w-8" />
              <th className="px-3 py-2">{t('tax.col.invoice')}</th>
              <th className="px-3 py-2">{t('tax.col.customer')}</th>
              <th className="px-3 py-2 text-right">{t('tax.col.dpp')}</th>
              <th className="px-3 py-2 text-right">{t('tax.col.ppn')}</th>
              <th className="px-3 py-2">{t('tax.col.code')}</th>
              <th className="px-3 py-2">{t('tax.col.faktur')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  {t('common.loading')}
                </td>
              </tr>
            )}
            {!loading && !rows.length && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  {t('tax.faktur.empty')}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.invoiceId} className="border-t border-border align-top">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={t('tax.faktur.choose', { invoice: r.docNo ?? '' })}
                    checked={chosen.has(r.invoiceId)}
                    disabled={r.missing.length > 0}
                    onChange={() => toggle(r.invoiceId)}
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium">{r.docNo ?? '—'}</div>
                  <div className="text-muted-foreground">{fmt.date(r.invoiceDate)}</div>
                </td>
                <td className="px-3 py-2">
                  {r.customerName}
                  {r.missing.length > 0 && (
                    <ul className="mt-1 text-[0.7rem] text-amber-700 dark:text-amber-400">
                      {r.missing.map((m) => (
                        <li key={m}>{t(MISSING[m] ?? 'tax.err.failed')}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt.money(r.subtotal)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt.money(r.taxAmount)}</td>
                <td className="px-3 py-2">{r.trxCode}</td>
                <td className="px-3 py-2">
                  {r.status === 'approved' ? (
                    <span className="tabular-nums">{r.fakturNumber}</span>
                  ) : (
                    <span className="text-muted-foreground">
                      {t(`tax.status.${r.status}` as MessageKey)}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-right">
                  <button
                    onClick={() => setEditing(r)}
                    className="p-1 text-muted-foreground hover:text-foreground"
                    aria-label={t('tax.faktur.edit')}
                    title={t('tax.faktur.edit')}
                  >
                    <FileCheck2 size={15} />
                  </button>
                  <button
                    onClick={() => setWithholding(r)}
                    className="p-1 text-muted-foreground hover:text-foreground"
                    aria-label={t('tax.withheld.title')}
                    title={t('tax.withheld.title')}
                  >
                    <HandCoins size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[0.72rem] text-muted-foreground">{t('tax.faktur.howTo')}</p>
      {editing && (
        <FakturDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {withholding && (
        <WithheldDialog
          row={withholding}
          onClose={() => setWithholding(null)}
          onSaved={() => {
            setWithholding(null);
            toast.success(t('tax.withheld.saved'));
          }}
        />
      )}
    </section>
  );
}

function BillsTab({ month }: { month: string }) {
  const { t, fmt } = useI18n();
  const { can, role } = useWorkspace();
  const [bills, setBills] = useState<SupplierBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<SupplierBill | null>(null);
  const [bupot, setBupot] = useState<SupplierBill | null>(null);
  const [voiding, setVoiding] = useState<SupplierBill | null>(null);
  const canVoid = role === 'owner' || role === 'admin';

  const load = useCallback(
    async () => setBills(await taxService.bills(month, monthEnd(month))),
    [month]
  );
  useEffect(() => {
    setLoading(true);
    load()
      .catch((err) => toast.error(t(errorKey(err, 'tax.err.failed'))))
      .finally(() => setLoading(false));
  }, [load, t]);

  const totals = useMemo(
    () =>
      bills
        .filter((b) => b.status !== 'void')
        .reduce(
          (a, b) => ({
            ppn: a.ppn + b.ppnAmount,
            pph: a.pph + b.pph23Amount,
            open: a.open + b.totalPayable - b.amountPaid,
          }),
          {
            ppn: 0,
            pph: 0,
            open: 0,
          }
        ),
    [bills]
  );

  async function csv() {
    try {
      save(await taxService.pph23Csv(month, monthEnd(month)));
    } catch (err) {
      toast.error(t(errorKey(err, 'tax.err.failed')));
    }
  }

  const done = () => {
    setPaying(null);
    setBupot(null);
    setCreating(false);
    void load();
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.78rem] text-muted-foreground">
          {t('tax.bills.totals', {
            ppn: fmt.money(totals.ppn),
            pph: fmt.money(totals.pph),
            open: fmt.money(totals.open),
          })}
        </p>
        <div className="flex gap-2">
          <button
            onClick={csv}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[0.8rem]"
          >
            <Download size={14} /> {t('tax.bills.pph23Csv')}
          </button>
          {can('purchasing') && (
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[0.8rem] font-medium text-primary-foreground"
            >
              <Plus size={14} /> {t('tax.bill.new')}
            </button>
          )}
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-[0.78rem]">
          <thead className="bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2">{t('tax.col.bill')}</th>
              <th className="px-3 py-2">{t('tax.col.supplier')}</th>
              <th className="px-3 py-2 text-right">{t('tax.col.dpp')}</th>
              <th className="px-3 py-2 text-right">{t('tax.col.ppn')}</th>
              <th className="px-3 py-2 text-right">{t('tax.col.pph23')}</th>
              <th className="px-3 py-2 text-right">{t('tax.col.open')}</th>
              <th className="px-3 py-2">{t('tax.col.bupot')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  {t('common.loading')}
                </td>
              </tr>
            )}
            {!loading && !bills.length && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  {t('tax.bills.empty')}
                </td>
              </tr>
            )}
            {bills.map((b) => (
              <tr
                key={b.id}
                className={`border-t border-border align-top ${b.status === 'void' ? 'opacity-50' : ''}`}
              >
                <td className="px-3 py-2">
                  <div className="font-medium">{b.billNo || '—'}</div>
                  <div className="text-muted-foreground">{fmt.date(b.billDate)}</div>
                </td>
                <td className="px-3 py-2">
                  {b.supplierName}
                  <div className="text-muted-foreground">{b.description}</div>
                  {b.pph23Amount > 0 && !b.supplierHasTaxId && (
                    <div className="text-[0.7rem] text-amber-700 dark:text-amber-400">
                      {t('tax.bills.noTaxId')}
                    </div>
                  )}
                  {b.status === 'void' && (
                    <div className="text-[0.7rem]">
                      {t('tax.bills.voided', { reason: b.voidReason })}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt.money(b.subtotal)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt.money(b.ppnAmount)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {b.pph23Amount > 0
                    ? `${fmt.money(b.pph23Amount)} (${fmt.number(b.pph23Rate)}%)`
                    : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {b.status === 'paid'
                    ? t('tax.bills.paid')
                    : fmt.money(b.totalPayable - b.amountPaid)}
                </td>
                <td className="px-3 py-2">
                  {b.pph23Amount > 0 ? b.bupotNumber || t('tax.bills.bupotMissing') : '—'}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-right">
                  {b.status === 'open' && can('payments') && (
                    <button
                      onClick={() => setPaying(b)}
                      className="p-1 text-muted-foreground hover:text-foreground"
                      aria-label={t('tax.pay.save')}
                      title={t('tax.pay.save')}
                    >
                      <ReceiptText size={15} />
                    </button>
                  )}
                  {b.status !== 'void' && b.pph23Amount > 0 && can('purchasing') && (
                    <button
                      onClick={() => setBupot(b)}
                      className="p-1 text-muted-foreground hover:text-foreground"
                      aria-label={t('tax.bupot.action')}
                      title={t('tax.bupot.action')}
                    >
                      <Stamp size={15} />
                    </button>
                  )}
                  {b.status === 'open' && b.amountPaid === 0 && canVoid && (
                    <button
                      onClick={() => setVoiding(b)}
                      className="p-1 text-muted-foreground hover:text-foreground"
                      aria-label={t('tax.bills.void')}
                      title={t('tax.bills.void')}
                    >
                      <Undo2 size={15} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <BillDialog onClose={() => setCreating(false)} onSaved={done} />}
      {paying && <PayBillDialog bill={paying} onClose={() => setPaying(null)} onSaved={done} />}
      {bupot && <BupotDialog bill={bupot} onClose={() => setBupot(null)} onSaved={done} />}
      {voiding && (
        <ReasonDialog
          title={t('tax.bills.void')}
          description={t('tax.bills.voidHelp', { supplier: voiding.supplierName })}
          confirmLabel={t('tax.bills.void')}
          required
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            try {
              await taxService.voidBill(voiding.id, reason);
              setVoiding(null);
              void load();
            } catch (err) {
              toast.error(t(errorKey(err, 'tax.err.failed')));
            }
          }}
        />
      )}
    </section>
  );
}

function SummaryTab({ month }: { month: string }) {
  const { t, fmt } = useI18n();
  const [months, setMonths] = useState<TaxMonth[]>([]);
  const [loading, setLoading] = useState(true);
  // The chosen month and the five before it.
  const from = useMemo(() => {
    const d = new Date(`${month}T00:00:00`);
    d.setMonth(d.getMonth() - 5);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }, [month]);

  useEffect(() => {
    setLoading(true);
    taxService
      .summary(from, monthEnd(month))
      .then((rows) => setMonths(rows.reverse()))
      .catch((err) => toast.error(t(errorKey(err, 'tax.err.failed'))))
      .finally(() => setLoading(false));
  }, [from, month, t]);

  return (
    <section className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-[0.78rem]">
          <thead className="bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2">{t('tax.month')}</th>
              <th className="px-3 py-2 text-right">{t('tax.sum.ppnOut')}</th>
              <th className="px-3 py-2 text-right">{t('tax.sum.ppnIn')}</th>
              <th className="px-3 py-2 text-right">{t('tax.sum.ppnNet')}</th>
              <th className="px-3 py-2 text-right">{t('tax.sum.pph21')}</th>
              <th className="px-3 py-2 text-right">{t('tax.sum.pph23')}</th>
              <th className="px-3 py-2 text-right">{t('tax.sum.pph23Prepaid')}</th>
              <th className="px-3 py-2">{t('tax.sum.open')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  {t('common.loading')}
                </td>
              </tr>
            )}
            {months.map((m) => (
              <tr key={m.month} className="border-t border-border">
                <td className="px-3 py-2 font-medium">{fmt.month(m.month, true)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt.money(m.ppnOut)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt.money(m.ppnIn)}</td>
                <td
                  className={`px-3 py-2 text-right tabular-nums font-medium ${m.ppnNet < 0 ? 'text-emerald-700 dark:text-emerald-400' : ''}`}
                >
                  {fmt.money(m.ppnNet)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt.money(m.pph21)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt.money(m.pph23Withheld)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt.money(m.pph23Prepaid)}</td>
                <td className="px-3 py-2 text-[0.72rem] text-muted-foreground">
                  {m.invoicesWithoutFaktur > 0 && (
                    <div>{t('tax.sum.openFaktur', { count: m.invoicesWithoutFaktur })}</div>
                  )}
                  {m.billsWithoutBupot > 0 && (
                    <div>{t('tax.sum.openBupot', { count: m.billsWithoutBupot })}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[0.72rem] text-muted-foreground">{t('tax.sum.note')}</p>
    </section>
  );
}
