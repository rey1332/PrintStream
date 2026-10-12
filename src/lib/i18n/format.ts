import type { Locale } from './config';

export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions
): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale, options).format(value);
}

export const isCurrencyCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z]{3}$/.test(value);

const AMBIGUOUS_SYMBOLS = new Set([
  '$',
  '¥',
  '￥',
  'kr',
  'kr.',
  'Kr',
  'R',
  'Rs',
  'Rs.',
  '₨',
  'K',
  'Fr',
  'Fr.',
  'Sh',
  '﷼',
  'D',
  'L',
  'P',
]);
const formatters = new Map<string, Intl.NumberFormat>();

export function currencyFormatter(
  locale: Locale | string,
  currency: string,
  options?: Intl.NumberFormatOptions
): Intl.NumberFormat {
  const key = `${locale}|${currency}|${JSON.stringify(options ?? {})}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.NumberFormat(locale, { style: 'currency', currency, ...options });
    const symbol = found
      .formatToParts(1)
      .find((p) => p.type === 'currency')
      ?.value.trim();
    if (!options?.currencyDisplay && symbol && AMBIGUOUS_SYMBOLS.has(symbol)) {
      found = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'code',
        ...options,
      });
    }
    formatters.set(key, found);
  }
  return found;
}

export function formatMoney(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
  currency?: string | null
): string {
  if (!Number.isFinite(value)) return '—';
  if (isCurrencyCode(currency)) {
    try {
      return currencyFormatter(locale, currency, options).format(value);
    } catch {
      // Unknown currency code: fall through to the plain notation.
    }
  }
  const abs = new Intl.NumberFormat(locale, { maximumFractionDigits: 2, ...options }).format(
    Math.abs(value)
  );
  return `${value < 0 ? '-' : ''}$${abs}`;
}

export function formatMoneyCompact(
  locale: Locale,
  value: number,
  currency?: string | null
): string {
  if (!Number.isFinite(value)) return '—';
  if (isCurrencyCode(currency)) {
    try {
      return currencyFormatter(locale, currency, {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(value);
    } catch {
      // fall through
    }
  }
  const abs = new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Math.abs(value));
  return `${value < 0 ? '-' : ''}$${abs}`;
}

function toDate(value: string | number | Date): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Calendar dates (YYYY-MM-DD) are shown as that day, never shifted by time zone.
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(
  locale: Locale,
  value: string | number | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions
): string {
  if (value == null || value === '') return '—';
  const date = toDate(value);
  if (!date) return String(value);
  return new Intl.DateTimeFormat(locale, options ?? { dateStyle: 'medium' }).format(date);
}

export function formatDateTime(
  locale: Locale,
  value: string | number | Date | null | undefined
): string {
  return formatDate(locale, value, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatTime(
  locale: Locale,
  value: string | number | Date | null | undefined
): string {
  return formatDate(locale, value, { hour: '2-digit', minute: '2-digit' });
}

export function formatMonth(
  locale: Locale,
  value: string | number | Date,
  withYear = false
): string {
  return formatDate(
    locale,
    value,
    withYear ? { month: 'short', year: '2-digit' } : { month: 'short' }
  );
}
