'use client';

import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { isUnit, type UnitCode } from '@/lib/units';
import { QtyUnitInput, lineQty, type QtyEntry } from '../components/QtyUnitInput';
import {
  Dialog,
  DialogButtons,
  Field,
  FormError,
  errorKey,
  inputCls,
  todayIso,
} from '../components/moduleUi';
import { productionService, type Stockpile } from '../lib/productionService';

export interface ProductOption {
  id: string;
  name: string;
  unit: UnitCode;
  density: number | null;
  stock: number;
}

interface Line {
  productId: string;
  entry: QtyEntry;
  warehouseId: string;
}

function newLine(product: ProductOption | undefined): Line {
  const unit = product?.unit ?? 'pcs';
  return {
    productId: product?.id ?? '',
    entry: { entryQty: NaN, entryUnit: unit, unit, density: product?.density ?? null },
    warehouseId: '',
  };
}

export function RecordDialog({
  products,
  stockpiles,
  onClose,
  onSaved,
}: {
  products: ProductOption[];
  stockpiles: Stockpile[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [date, setDate] = useState(() => todayIso());
  const [shift, setShift] = useState('');
  const [plant, setPlant] = useState('');
  const [hours, setHours] = useState('');
  const [downtime, setDowntime] = useState('');
  const [note, setNote] = useState('');
  const [outputs, setOutputs] = useState<Line[]>(() => [newLine(products[0])]);
  const [input, setInput] = useState<Line>(() => ({ ...newLine(undefined), productId: '' }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const productOf = (id: string) => products.find((p) => p.id === id);
  const defaultPile = stockpiles.find((s) => s.isDefault);

  function setProduct(line: Line, id: string): Line {
    const p = productOf(id);
    const unit = p?.unit ?? 'pcs';
    return {
      ...line,
      productId: id,
      entry: { ...line.entry, entryUnit: unit, unit, density: p?.density ?? null },
    };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError('');
    const parsed = outputs.map((l) => ({ ...l, qty: lineQty(l.entry) }));
    if (parsed.some((l) => !l.productId || !l.qty || l.qty <= 0)) {
      setError(t('prd.err.qty'));
      return;
    }
    const inputQty = input.productId ? lineQty(input.entry) : null;
    if (input.productId && (!inputQty || inputQty <= 0)) {
      setError(t('prd.err.qty'));
      return;
    }
    setSaving(true);
    try {
      await productionService.record({
        run_date: date,
        shift: shift.trim(),
        plant: plant.trim(),
        hours: Number(hours) || 0,
        downtime_hours: Number(downtime) || 0,
        note: note.trim(),
        input:
          input.productId && inputQty
            ? {
                product_id: input.productId,
                qty: inputQty,
                warehouse_id: input.warehouseId || null,
              }
            : null,
        outputs: parsed.map((l) => ({
          product_id: l.productId,
          qty: l.qty as number,
          warehouse_id: l.warehouseId || null,
        })),
      });
      toast.success(t('prd.form.saved'));
      onSaved();
    } catch (err) {
      setError(t(errorKey(err, 'prd.err.failed')));
    } finally {
      setSaving(false);
    }
  }

  const pileSelect = (value: string, onChange: (v: string) => void) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={t('prd.form.stockpile')}
      className={inputCls}
    >
      <option value="">
        {t('prd.form.defaultStockpile', { name: defaultPile?.name ?? 'MAIN' })}
      </option>
      {stockpiles
        .filter((s) => !s.isDefault)
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.code} · {s.name}
          </option>
        ))}
    </select>
  );

  return (
    <Dialog title={t('prd.form.title')} onClose={onClose} onSubmit={submit} wide>
      {products.length === 0 ? (
        <p className="text-[0.8rem] text-muted-foreground">{t('prd.form.noProducts')}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label={t('prd.form.date')}>
              <input
                type="date"
                required
                max={todayIso()}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label={t('prd.form.shift')}>
              <input
                maxLength={40}
                value={shift}
                onChange={(e) => setShift(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label={t('prd.form.hours')}>
              <input
                type="number"
                min={0}
                max={24}
                step="0.25"
                inputMode="decimal"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label={t('prd.form.downtime')}>
              <input
                type="number"
                min={0}
                max={24}
                step="0.25"
                inputMode="decimal"
                value={downtime}
                onChange={(e) => setDowntime(e.target.value)}
                className={inputCls}
              />
            </Field>
            <div className="col-span-2 sm:col-span-4">
              <Field label={t('prd.form.plant')}>
                <input
                  maxLength={120}
                  placeholder={t('prd.form.plantHint')}
                  value={plant}
                  onChange={(e) => setPlant(e.target.value)}
                  className={inputCls}
                />
              </Field>
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-[0.78rem] font-semibold text-foreground">
              {t('prd.form.outputs')}
            </legend>
            {outputs.map((line, i) => (
              <div
                key={i}
                className="grid grid-cols-1 gap-2 rounded-lg border border-border p-2 sm:grid-cols-[1.4fr_1fr_1fr_auto]"
              >
                <select
                  required
                  aria-label={t('prd.form.product')}
                  value={line.productId}
                  onChange={(e) =>
                    setOutputs((ls) =>
                      ls.map((l, j) => (j === i ? setProduct(l, e.target.value) : l))
                    )
                  }
                  className={inputCls}
                >
                  <option value="" disabled>
                    —
                  </option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <QtyUnitInput
                  entry={line.entry}
                  free={false}
                  inputCls={inputCls}
                  onChange={(entry) =>
                    setOutputs((ls) => ls.map((l, j) => (j === i ? { ...l, entry } : l)))
                  }
                />
                {pileSelect(line.warehouseId, (v) =>
                  setOutputs((ls) => ls.map((l, j) => (j === i ? { ...l, warehouseId: v } : l)))
                )}
                <button
                  type="button"
                  disabled={outputs.length === 1}
                  onClick={() => setOutputs((ls) => ls.filter((_, j) => j !== i))}
                  aria-label={t('common.delete')}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:text-red-600 disabled:opacity-30 max-lg:h-11 max-lg:w-11"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {outputs.length < 50 && (
              <button
                type="button"
                onClick={() => setOutputs((ls) => [...ls, newLine(undefined)])}
                className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-[0.75rem] text-muted-foreground hover:text-foreground max-lg:min-h-11"
              >
                <Plus size={13} /> {t('prd.form.addOutput')}
              </button>
            )}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-[0.78rem] font-semibold text-foreground">
              {t('prd.form.input')}
            </legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1.4fr_1fr_1fr]">
              <select
                aria-label={t('prd.form.product')}
                value={input.productId}
                onChange={(e) =>
                  setInput((l) =>
                    e.target.value ? setProduct(l, e.target.value) : { ...l, productId: '' }
                  )
                }
                className={inputCls}
              >
                <option value="">{t('prd.form.none')}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {input.productId && (
                <>
                  <QtyUnitInput
                    entry={input.entry}
                    free={false}
                    inputCls={inputCls}
                    onChange={(entry) => setInput((l) => ({ ...l, entry }))}
                  />
                  {pileSelect(input.warehouseId, (v) =>
                    setInput((l) => ({ ...l, warehouseId: v }))
                  )}
                </>
              )}
            </div>
            <p className="text-[0.68rem] text-muted-foreground">{t('prd.form.inputHint')}</p>
          </fieldset>

          <Field label={t('prd.form.note')}>
            <input
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={inputCls}
            />
          </Field>
          <p className="text-[0.7rem] text-muted-foreground">{t('prd.form.costHint')}</p>
        </>
      )}
      <FormError text={error} />
      <DialogButtons
        busy={saving}
        disabled={products.length === 0}
        label={t('prd.form.submit')}
        onCancel={onClose}
      />
    </Dialog>
  );
}

export function toProductOption(r: {
  id: string;
  name: string;
  unit: string;
  density: unknown;
  current_stock: unknown;
}): ProductOption {
  return {
    id: r.id,
    name: r.name,
    unit: isUnit(r.unit) ? r.unit : 'pcs',
    density: r.density === null || r.density === undefined ? null : Number(r.density),
    stock: Number(r.current_stock ?? 0),
  };
}
