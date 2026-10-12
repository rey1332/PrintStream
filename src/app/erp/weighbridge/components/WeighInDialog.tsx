'use client';

import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { UNIT_LABEL, isUnit } from '@/lib/units';
import { useWorkspace } from '../../lib/WorkspaceContext';
import {
  WeighError,
  weighbridgeService,
  type Vehicle,
  type WeighCustomer,
} from '../../lib/weighbridgeService';
import {
  Dialog,
  DialogButtons,
  Field,
  FormError,
  errorKey,
  inputCls,
} from '../../components/moduleUi';

export interface WeighProduct {
  id: string;
  name: string;
  unit: string;
  density: number | null;
  sellingPrice: number;
  stock: number;
}

const WALK_IN = '__walk_in__';

export function WeighInDialog({
  vehicles,
  customers,
  products,
  onClose,
  onSaved,
}: {
  vehicles: Vehicle[];
  customers: WeighCustomer[];
  products: WeighProduct[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, fmt } = useI18n();
  const { can, role } = useWorkspace();
  const [plate, setPlate] = useState('');
  const [driver, setDriver] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [productId, setProductId] = useState(products[0]?.id ?? '');
  const [weight, setWeight] = useState('');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [override, setOverride] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [creditBlocked, setCreditBlocked] = useState(false);

  const plateKey = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const known = useMemo(
    () => vehicles.find((v) => plateKey(v.plateNo) === plateKey(plate)) ?? null,
    [vehicles, plate]
  );
  const customer = customers.find((c) => c.id === customerId) ?? null;
  const product = products.find((p) => p.id === productId) ?? null;
  const unitLabel = product && isUnit(product.unit) ? t(UNIT_LABEL[product.unit]) : '';
  const canOverride = role === 'owner' || role === 'admin';

  function pickPlate(value: string) {
    setPlate(value);
    const match = vehicles.find((v) => plateKey(v.plateNo) === plateKey(value));
    if (match) {
      if (!driver) setDriver(match.driverName);
      if (!customerId && match.customerId) setCustomerId(match.customerId);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const id = await weighbridgeService.weighIn({
        vehicle_id: known?.id ?? null,
        plate_no: plate.trim(),
        driver_name: driver.trim(),
        customer_id: customerId && customerId !== WALK_IN ? customerId : null,
        customer_name: customerId === WALK_IN ? customerName.trim() : '',
        product_id: productId,
        first_kg: Number(weight),
        price: price.trim() === '' ? null : Number(price),
        note: note.trim(),
        credit_override: override.trim() || undefined,
      });
      const ticket = await weighbridgeService.ticket(id);
      toast.success(t('wb.in.saved', { ticket: ticket?.docNo ?? '' }));
      onSaved();
    } catch (err) {
      setCreditBlocked(err instanceof WeighError && err.key === 'wb.err.credit');
      setError(t(errorKey(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={t('wb.in.title')} onClose={onClose} onSubmit={submit}>
      {products.length === 0 ? (
        <p className="text-[0.8rem] text-muted-foreground">{t('wb.in.noProducts')}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={`${t('wb.in.truck')} *`} hint={t('wb.in.truckHint')}>
            <input
              autoFocus
              required
              list="wb-plates"
              maxLength={20}
              value={plate}
              onChange={(e) => pickPlate(e.target.value)}
              className={`${inputCls} uppercase`}
            />
            <datalist id="wb-plates">
              {vehicles
                .filter((v) => v.active)
                .map((v) => (
                  <option key={v.id} value={v.plateNo}>
                    {[v.driverName, v.ownerName].filter(Boolean).join(' · ')}
                  </option>
                ))}
            </datalist>
          </Field>
          <Field label={t('wb.in.driver')}>
            <input
              maxLength={120}
              value={driver}
              onChange={(e) => setDriver(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label={`${t('wb.in.customer')} *`} wide>
            <select
              required
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className={inputCls}
            >
              <option value="" disabled>
                —
              </option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value={WALK_IN}>{t('wb.in.walkIn')}</option>
            </select>
            {customer?.creditLimit !== null && customer?.creditLimit !== undefined && (
              <span
                className={`mt-1 block text-[0.7rem] ${
                  (customer.exposure ?? 0) >= customer.creditLimit
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-muted-foreground'
                }`}
              >
                {t('wb.credit', {
                  exposure: fmt.money(customer.exposure ?? 0),
                  limit: fmt.money(customer.creditLimit),
                })}
              </span>
            )}
          </Field>
          {customerId === WALK_IN && (
            <Field label={`${t('wb.in.customerName')} *`} wide>
              <input
                required
                maxLength={200}
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                className={inputCls}
              />
            </Field>
          )}
          <Field label={`${t('wb.in.product')} *`} wide>
            <select
              required
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className={inputCls}
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({isUnit(p.unit) ? t(UNIT_LABEL[p.unit]) : p.unit}) ·{' '}
                  {fmt.number(p.stock)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`${t('wb.in.weight')} *`} hint={t('wb.in.weightHint')}>
            <input
              required
              type="number"
              inputMode="decimal"
              min={1}
              max={200000}
              step="0.1"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              className={`${inputCls} text-[1rem] tabular-nums`}
            />
          </Field>
          {can('sales') && (
            <Field label={t('wb.in.price', { unit: unitLabel })} hint={t('wb.in.priceHint')}>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={price}
                placeholder={product ? String(product.sellingPrice) : ''}
                onChange={(e) => setPrice(e.target.value)}
                className={inputCls}
              />
            </Field>
          )}
          <Field label={t('wb.in.note')} wide>
            <input
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={inputCls}
            />
          </Field>
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
      )}
      <FormError text={error} />
      <DialogButtons
        busy={saving}
        disabled={products.length === 0 || !plate.trim() || !weight || !customerId}
        label={t('wb.in.submit')}
        onCancel={onClose}
      />
    </Dialog>
  );
}
