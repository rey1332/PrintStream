'use client';

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { RecordPicker } from './RecordPicker';
import { QtyUnitInput, lineQty, type QtyEntry } from './QtyUnitInput';
import { productOption, useRecordSearch, type PickedProduct } from '../lib/pickers';

/** One line of a manual invoice (erp_create_invoice_v6). */
export interface InvoiceLine extends QtyEntry {
  productId: string;
  description: string;
  /** In the line's unit, converted from what was typed. */
  qty: number;
  price: number;
}

export const newInvoiceLine = (): InvoiceLine => ({
  productId: '',
  description: '',
  qty: 1,
  price: 0,
  unit: 'pcs',
  entryQty: 1,
  entryUnit: 'pcs',
  density: null,
});

/** Net amount of the lines: each rounded to cents, as the database does. */
export const invoiceLinesNet = (lines: InvoiceLine[]) =>
  lines.reduce((sum, l) => sum + Math.round(l.qty * l.price * 100) / 100, 0);

export function InvoiceLinesEditor({
  lines,
  onChange,
  currency,
  inputCls,
  inputStyle,
}: {
  lines: InvoiceLine[];
  onChange: (lines: InvoiceLine[]) => void;
  currency: string | null;
  inputCls: string;
  inputStyle?: React.CSSProperties;
}) {
  const { t, fmt } = useI18n();
  const pickers = useRecordSearch();

  const set = (idx: number, patch: Partial<InvoiceLine>) =>
    onChange(lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  function pick(idx: number, prod: PickedProduct | null) {
    if (!prod) {
      set(idx, { productId: '' });
      return;
    }
    const entry: QtyEntry = {
      entryQty: lines[idx].entryQty,
      entryUnit: prod.unit,
      unit: prod.unit,
      density: prod.density,
    };
    set(idx, {
      ...entry,
      qty: lineQty(entry) ?? 0,
      productId: prod.id,
      description: lines[idx].description || prod.name,
      price: lines[idx].price || prod.sellingPrice,
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] text-muted-foreground">{t('invoice.lines')}</span>
        <button
          type="button"
          onClick={() => onChange([...lines, newInvoiceLine()])}
          className="flex items-center gap-1 text-[0.72rem] text-muted-foreground hover:text-foreground"
        >
          <Plus size={11} /> {t('order.addItem')}
        </button>
      </div>
      {lines.map((line, idx) => (
        <div key={idx} className="space-y-1.5 rounded-lg border border-border p-2">
          <div className="flex gap-1.5">
            <div className="min-w-0 flex-1">
              <RecordPicker
                className={inputCls}
                style={inputStyle}
                ariaLabel={t('order.selectProduct')}
                placeholder={t('invoice.lineProductOptional')}
                value={line.productId}
                valueLabel={line.description}
                search={(text) =>
                  pickers.products(text).then((rows) => rows.map((p) => productOption(p)))
                }
                onChange={(p) => pick(idx, p?.data ?? null)}
              />
            </div>
            <button
              type="button"
              onClick={() => onChange(lines.filter((_, i) => i !== idx))}
              disabled={lines.length === 1}
              aria-label={t('common.delete')}
              className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <Trash2 size={13} />
            </button>
          </div>
          <input
            className={inputCls}
            style={inputStyle}
            maxLength={200}
            placeholder={t('invoice.lineDescription')}
            value={line.description}
            onChange={(e) => set(idx, { description: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <QtyUnitInput
              entry={line}
              free={!line.productId}
              onChange={(entry) => set(idx, { ...entry, qty: lineQty(entry) ?? 0 })}
              inputCls={inputCls}
              inputStyle={inputStyle}
            />
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              aria-label={t('common.price')}
              placeholder={t('common.price')}
              className={inputCls}
              style={inputStyle}
              value={line.price}
              onChange={(e) => set(idx, { price: Number(e.target.value) })}
            />
          </div>
          <p className="text-right text-[0.72rem] text-muted-foreground tabular-nums">
            {fmt.moneyIn(Math.round(line.qty * line.price * 100) / 100, currency)}
          </p>
        </div>
      ))}
    </div>
  );
}
