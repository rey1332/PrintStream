'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { UNIT_LABEL, isUnit } from '@/lib/units';
import { useWorkspace } from '../../lib/WorkspaceContext';
import {
  WeighError,
  weighQty,
  weighbridgeService,
  type Vehicle,
  type WeighTicket,
} from '../../lib/weighbridgeService';
import {
  Dialog,
  DialogButtons,
  Field,
  FormError,
  errorKey,
  inputCls,
} from '../../components/moduleUi';
import type { WeighProduct } from './WeighInDialog';

export function WeighOutDialog({
  ticket,
  vehicle,
  product,
  onClose,
  onSaved,
}: {
  ticket: WeighTicket;
  vehicle: Vehicle | null;
  product: WeighProduct | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { t, fmt } = useI18n();
  const { can, role } = useWorkspace();
  const tare = vehicle?.tareKg ?? null;
  // A truck weighed in loaded can use its stored empty weight.
  const [useTare, setUseTare] = useState(false);
  const [weight, setWeight] = useState('');
  const [price, setPrice] = useState(String(ticket.price));
  const [override, setOverride] = useState(ticket.creditOverride);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [creditBlocked, setCreditBlocked] = useState(false);

  const second = useTare ? tare : weight ? Number(weight) : null;
  const net = second !== null && second > 0 ? Math.abs(second - ticket.firstKg) : null;
  const qty = net !== null ? weighQty(net, ticket.unit, product?.density ?? null) : null;
  const priceValue = Number(price) || 0;
  const unitLabel = isUnit(ticket.unit) ? t(UNIT_LABEL[ticket.unit]) : ticket.unit;
  const canOverride = role === 'owner' || role === 'admin';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await weighbridgeService.weighOut(
        ticket.id,
        useTare ? null : Number(weight),
        can('sales') && priceValue !== ticket.price ? priceValue : null,
        override.trim() || null
      );
      toast.success(t('wb.out.done', { ticket: ticket.docNo }), {
        action: {
          label: t('wb.out.printNow'),
          onClick: () => window.open(`/erp/print/ticket/${ticket.id}`, '_blank', 'noopener'),
        },
      });
      onSaved(ticket.id);
    } catch (err) {
      setCreditBlocked(err instanceof WeighError && err.key === 'wb.err.credit');
      setError(t(errorKey(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={t('wb.out.title', { ticket: ticket.docNo })} onClose={onClose} onSubmit={submit}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[0.78rem]">
        <dt className="text-muted-foreground">{t('wb.col.truck')}</dt>
        <dd className="text-foreground">
          {ticket.plateNo}
          {ticket.driverName ? ` · ${ticket.driverName}` : ''}
        </dd>
        <dt className="text-muted-foreground">{t('wb.col.customer')}</dt>
        <dd className="text-foreground">{ticket.customerName}</dd>
        <dt className="text-muted-foreground">{t('wb.col.product')}</dt>
        <dd className="text-foreground">{ticket.productName}</dd>
        <dt className="text-muted-foreground">{t('wb.col.first')}</dt>
        <dd className="tabular-nums text-foreground">
          {t('wb.kg', { value: fmt.number(ticket.firstKg) })} · {fmt.time(ticket.firstAt)}
        </dd>
      </dl>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={`${t('wb.out.weight')} *`} wide>
          <input
            autoFocus
            type="number"
            inputMode="decimal"
            min={1}
            max={200000}
            step="0.1"
            required={!useTare}
            disabled={useTare}
            value={useTare ? String(tare ?? '') : weight}
            onChange={(e) => setWeight(e.target.value)}
            className={`${inputCls} text-[1rem] tabular-nums disabled:opacity-60`}
          />
          {tare !== null && (
            <span className="mt-2 flex items-center gap-2 text-[0.75rem] text-foreground">
              <input
                type="checkbox"
                checked={useTare}
                onChange={(e) => setUseTare(e.target.checked)}
              />
              {t('wb.out.useTare', { value: fmt.number(tare) })}
            </span>
          )}
        </Field>
        {can('sales') && (
          <Field label={t('wb.in.price', { unit: unitLabel })}>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className={inputCls}
            />
          </Field>
        )}
        {creditBlocked && canOverride && (
          <Field label={t('wb.override')} wide>
            <input
              minLength={3}
              maxLength={500}
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              className={inputCls}
            />
          </Field>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-2 text-center">
        {[
          [t('wb.col.net'), net === null ? '—' : t('wb.kg', { value: fmt.number(net) })],
          [t('wb.col.qty'), qty === null ? '—' : `${fmt.number(qty)} ${unitLabel}`],
          [
            t('wb.col.amount'),
            qty === null ? '—' : fmt.money(Math.round(qty * priceValue * 100) / 100),
          ],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border px-2 py-2">
            <dt className="text-[0.68rem] text-muted-foreground">{label}</dt>
            <dd className="text-[0.95rem] font-semibold tabular-nums text-foreground">{value}</dd>
          </div>
        ))}
      </dl>

      <FormError text={error} />
      <DialogButtons
        busy={saving}
        disabled={!useTare && !weight}
        label={t('wb.out.submit')}
        onCancel={onClose}
      />
    </Dialog>
  );
}
