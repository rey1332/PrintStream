// Units of measure for products and order lines, and conversion between
// them. Mirrors public.erp_unit_valid / erp_unit_convert
// (db/migrations/20261012000015_erp_decimal_quantities_units.sql); a unit
// test checks they agree.

import type { MessageKey } from '@/lib/i18n/messages';

export const UNIT_CODES = ['m3', 'l', 'ton', 'kg', 'rit', 'pcs', 'hour', 'day'] as const;
export type UnitCode = (typeof UNIT_CODES)[number];

/** Quantities are stored with three decimals (kg in a ton, liters in a m³). */
export const QTY_DECIMALS = 3;

export const isUnit = (value: unknown): value is UnitCode =>
  typeof value === 'string' && (UNIT_CODES as readonly string[]).includes(value);

export const UNIT_LABEL: Record<UnitCode, MessageKey> = {
  m3: 'unit.m3',
  l: 'unit.l',
  ton: 'unit.ton',
  kg: 'unit.kg',
  rit: 'unit.rit',
  pcs: 'unit.pcs',
  hour: 'unit.hour',
  day: 'unit.day',
};

type Kind = 'mass' | 'volume';
const KIND: Partial<Record<UnitCode, Kind>> = {
  kg: 'mass',
  ton: 'mass',
  l: 'volume',
  m3: 'volume',
};
// In kg (mass) or liters (volume).
const FACTOR: Partial<Record<UnitCode, number>> = { kg: 1, ton: 1000, l: 1, m3: 1000 };

/** Rounds to the stored precision (three decimals). */
export function roundQty(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

/**
 * `qty` in `from` expressed in `to`, or null when they cannot be converted.
 * Mass (kg, ton) and volume (l, m³) convert within their kind; between mass
 * and volume only with a density in ton per m³ (= kg per liter).
 */
export function convertQty(
  qty: number,
  from: UnitCode,
  to: UnitCode,
  density: number | null = null
): number | null {
  if (!Number.isFinite(qty)) return null;
  if (from === to) return qty;
  const fromKind = KIND[from];
  const toKind = KIND[to];
  if (!fromKind || !toKind) return null;
  let base = qty * FACTOR[from]!;
  if (fromKind !== toKind) {
    if (!density || density <= 0) return null;
    base = fromKind === 'mass' ? base / density : base * density;
  }
  return base / FACTOR[to]!;
}

/** Units a quantity entered for a product with `unit` (and density) can be typed in. */
export function unitsFor(unit: UnitCode, density: number | null = null): UnitCode[] {
  return UNIT_CODES.filter((u) => convertQty(1, u, unit, density) !== null);
}

/** Parses a typed quantity ("12,5" or "12.5"); null when it is not a positive number. */
export function parseQty(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? roundQty(value) : null;
}
