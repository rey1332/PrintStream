'use client';

import React from 'react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { UNIT_CODES, UNIT_LABEL, convertQty, roundQty, unitsFor, type UnitCode } from '@/lib/units';

/** What a person typed on an order line, and the line's own unit. */
export interface QtyEntry {
  /** As typed, in `entryUnit`. */
  entryQty: number;
  entryUnit: UnitCode;
  /** The line's unit: the product's unit, or chosen freely on a line without a product. */
  unit: UnitCode;
  /** Ton per m³ of the product, for weight ↔ volume. */
  density: number | null;
}

/** The quantity in the line's unit, or null when it cannot be converted. */
export function lineQty(entry: QtyEntry): number | null {
  const value = convertQty(entry.entryQty, entry.entryUnit, entry.unit, entry.density);
  return value === null ? null : roundQty(value);
}

/**
 * A quantity typed in any unit that converts to the line's unit (kg ↔ ton,
 * liter ↔ m³, and ton ↔ m³ with a density). Shows the converted quantity.
 * Without a product (`free`), the unit chosen is the line's unit.
 */
export function QtyUnitInput({
  entry,
  free,
  onChange,
  inputCls,
  inputStyle,
}: {
  entry: QtyEntry;
  free: boolean;
  onChange: (entry: QtyEntry) => void;
  inputCls: string;
  inputStyle?: React.CSSProperties;
}) {
  const { t, fmt } = useI18n();
  const choices = free ? [...UNIT_CODES] : unitsFor(entry.unit, entry.density);
  const converted = lineQty(entry);

  return (
    <div className="space-y-0.5">
      <div className="flex gap-1">
        <input
          type="number"
          min={0.001}
          step="any"
          inputMode="decimal"
          className={`${inputCls} min-w-0`}
          style={inputStyle}
          placeholder={t('common.qty')}
          value={Number.isFinite(entry.entryQty) ? entry.entryQty : ''}
          onChange={(e) => onChange({ ...entry, entryQty: Number(e.target.value) })}
        />
        <select
          aria-label={t('unit.label')}
          className={`${inputCls} w-auto shrink-0 px-1`}
          style={inputStyle}
          value={entry.entryUnit}
          onChange={(e) => {
            const unit = e.target.value as UnitCode;
            onChange(free ? { ...entry, entryUnit: unit, unit } : { ...entry, entryUnit: unit });
          }}
        >
          {choices.map((u) => (
            <option key={u} value={u}>
              {t(UNIT_LABEL[u])}
            </option>
          ))}
        </select>
      </div>
      {entry.entryUnit !== entry.unit && (
        <p className="text-[0.68rem] text-muted-foreground">
          {converted === null
            ? t('unit.noConversion', { unit: t(UNIT_LABEL[entry.unit]) })
            : t('unit.converted', { qty: fmt.number(converted), unit: t(UNIT_LABEL[entry.unit]) })}
        </p>
      )}
    </div>
  );
}
