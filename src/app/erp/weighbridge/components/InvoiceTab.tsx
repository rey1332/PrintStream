'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { FileText } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { accountingService } from '../../lib/accountingService';
import { weighbridgeService, type WeighTicket } from '../../lib/weighbridgeService';
import { Field, FormError, errorKey, inputCls, todayIso } from '../../components/moduleUi';

export function InvoiceTab({ canInvoice }: { canInvoice: boolean }) {
  const { t, fmt } = useI18n();
  const [tickets, setTickets] = useState<WeighTicket[] | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [from, setFrom] = useState(() => todayIso().slice(0, 8) + '01');
  const [to, setTo] = useState(() => todayIso());
  const [tax, setTax] = useState('0');
  const [due, setDue] = useState(() => todayIso(30));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(false);

  const load = () =>
    weighbridgeService
      .uninvoiced()
      .then(setTickets)
      .catch((err) => {
        setTickets([]);
        setError(t(errorKey(err)));
      });

  useEffect(() => {
    void load();
    accountingService
      .settings()
      .then((s) => setTax(String(s.salesTaxRate)))
      .catch(() => undefined);
    // Loaded once when the tab opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byCustomer = useMemo(() => {
    const groups = new Map<string, { name: string; count: number; amount: number }>();
    for (const ticket of tickets ?? []) {
      if (!ticket.customerId) continue;
      const g = groups.get(ticket.customerId) ?? { name: ticket.customerName, count: 0, amount: 0 };
      g.count += 1;
      g.amount += ticket.amount;
      groups.set(ticket.customerId, g);
    }
    return [...groups.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [tickets]);
  const walkIns = (tickets ?? []).filter((x) => !x.customerId).length;
  const inPeriod = (tickets ?? []).filter(
    (x) => x.customerId === customerId && x.ticketDate >= from && x.ticketDate <= to
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!customerId || busy) return;
    setBusy(true);
    setError('');
    setCreated(false);
    try {
      await weighbridgeService.invoice(customerId, from, to, Number(tax) || 0, due);
      toast.success(t('wb.inv.created'));
      setCreated(true);
      await load();
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setBusy(false);
    }
  }

  if (tickets === null)
    return <p className="text-[0.8rem] text-muted-foreground">{t('common.loading')}</p>;

  return (
    <div className="space-y-4">
      <p className="text-[0.78rem] text-muted-foreground">{t('wb.inv.help')}</p>
      {byCustomer.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <FileText size={30} className="mx-auto mb-3 text-muted-foreground opacity-40" />
          <p className="text-[0.8rem] text-muted-foreground">{t('wb.inv.none')}</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {byCustomer.map(([id, g]) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => setCustomerId(id)}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[var(--surface-3)] max-lg:min-h-11 ${customerId === id ? 'bg-[var(--surface-3)]' : ''}`}
                >
                  <span className="text-[0.8rem] font-medium text-foreground">{g.name}</span>
                  <span className="text-[0.72rem] tabular-nums text-muted-foreground">
                    {t('wb.inv.pending', { count: g.count, amount: fmt.money(g.amount) })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <form onSubmit={submit} className="space-y-3 rounded-xl border border-border bg-card p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('wb.col.customer')} wide>
                <select
                  required
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  className={inputCls}
                >
                  <option value="" disabled>
                    —
                  </option>
                  {byCustomer.map(([id, g]) => (
                    <option key={id} value={id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('wb.inv.from')}>
                <input
                  type="date"
                  required
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label={t('wb.inv.to')}>
                <input
                  type="date"
                  required
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label={t('wb.inv.tax')}>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={tax}
                  onChange={(e) => setTax(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label={t('wb.inv.due')}>
                <input
                  type="date"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                  className={inputCls}
                />
              </Field>
            </div>
            {customerId && (
              <p className="text-[0.78rem] text-foreground">
                {t('wb.inv.inPeriod', {
                  count: inPeriod.length,
                  amount: fmt.money(inPeriod.reduce((sum, x) => sum + x.amount, 0)),
                })}
              </p>
            )}
            <FormError text={error} />
            {canInvoice ? (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={busy || !customerId || inPeriod.length === 0}
                  className="rounded-lg bg-primary px-3 py-2 text-[0.8rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
                >
                  {busy ? t('common.saving') : t('wb.inv.submit')}
                </button>
                {created && (
                  <Link href="/erp/invoices" className="text-[0.78rem] text-foreground underline">
                    {t('wb.inv.openInvoices')}
                  </Link>
                )}
              </div>
            ) : (
              <p className="text-[0.75rem] text-muted-foreground">{t('wb.inv.noRight')}</p>
            )}
          </form>
        </div>
      )}
      {walkIns > 0 && (
        <p className="text-[0.72rem] text-muted-foreground">
          {t('wb.inv.walkIn', { count: walkIns })}
        </p>
      )}
    </div>
  );
}
