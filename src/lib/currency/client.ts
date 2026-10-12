export interface CurrencyInfo {
  code: string;
  name: string;
  minorUnits: number;
}

export interface CurrencySettings {
  baseCurrency: string;
  confirmedAt: string | null;
  locked: boolean;
  hasRecords: boolean;
  canChangeBase: boolean;
  canManageRates: boolean;
  canFetchRates: boolean;
  provider: { enabled: boolean; name: string; providers: string | null };
  maxRateAgeDays: number;
  currencies: CurrencyInfo[];
}

export interface PreviewTable {
  table: string;
  baseRows: number;
  baseSum: number | string;
  baseRowsCertain: number;
  firstDate: string | null;
  lastDate: string | null;
  foreignRows: number;
  foreignCurrencies: string[];
}

export interface CurrencyPreview {
  baseCurrency: string;
  confirmedAt: string | null;
  settingsSavedAt: string | null;
  baseCurrencyIsDefault: boolean;
  status: 'confirmed' | 'noRecords' | 'unambiguous' | 'needsDecision';
  baseRows: number;
  uncertainRows: number;
  foreignDocuments: number;
  tables: PreviewTable[];
}

export interface RateRow {
  id: string;
  from: string;
  to: string;
  rate: string;
  effectiveDate: string;
  source: 'manual' | 'frankfurter';
  provider: string;
  retrievedAt: string;
  note: string;
  createdAt: string;
}

export interface RateLookup {
  rate: string | null;
  rateDate: string | null;
  source: string | null;
  provider: string | null;
  method: string | null;
  ageDays: number | null;
  stale: boolean;
  fetched: boolean;
  fetchError: string | null;
}

export class CurrencyApiError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.code = code;
  }
}

async function call<T>(
  action: string,
  workspaceId: string | null,
  body: Record<string, unknown> = {},
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch('/api/erp/currency', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, workspaceId, ...body }),
    cache: 'no-store',
    signal,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success)
    throw new CurrencyApiError(String(result?.error ?? `http${response.status}`), result?.message);
  return result.data as T;
}

export const currencyApi = {
  settings: (ws: string | null) => call<CurrencySettings>('settings', ws),
  preview: (ws: string | null) => call<CurrencyPreview>('preview', ws),
  confirm: (ws: string | null, currency: string, baseRows: number) =>
    call<CurrencyPreview>('confirm', ws, { currency, baseRows }),
  rates: (ws: string | null) => call<RateRow[]>('rates', ws),
  addRate: (
    ws: string | null,
    input: { from: string; to: string; rate: string; date: string; note?: string }
  ) => call<{ id: string }>('addRate', ws, input),
  lookup: (
    ws: string | null,
    input: { from: string; to: string; date?: string; fetch?: boolean },
    signal?: AbortSignal
  ) => call<RateLookup>('lookup', ws, input, signal),
  fetch: (ws: string | null, input: { base: string; quotes: string[]; date?: string }) =>
    call<{ stored: number; fetched: number }>('fetch', ws, input),
};

// ─── Display currency (per browser) ──────────────────────────────────────────

const DISPLAY_KEY = 'etna.displayCurrency';
export const DISPLAY_CURRENCY_EVENT = 'etna:display-currency';

export function readDisplayCurrency(): string | null {
  try {
    const value = window.localStorage.getItem(DISPLAY_KEY);
    return value && /^[A-Z]{3}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeDisplayCurrency(code: string | null) {
  try {
    if (code) window.localStorage.setItem(DISPLAY_KEY, code);
    else window.localStorage.removeItem(DISPLAY_KEY);
  } catch {
    // A preference only; the page works without it.
  }
  window.dispatchEvent(new Event(DISPLAY_CURRENCY_EVENT));
}

function parseDecimal(text: string): [bigint, number] | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const frac = m[3] ?? '';
  const digits = BigInt(`${m[2]}${frac}`);
  return [m[1] ? -digits : digits, frac.length];
}

export function convertAmount(
  amount: number | string,
  rate: string | number,
  minorUnits: number
): number | null {
  const a = parseDecimal(typeof amount === 'number' ? amount.toFixed(4) : amount);
  const r = parseDecimal(typeof rate === 'number' ? String(rate) : rate);
  if (!a || !r || !Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) return null;
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  const TWO = BigInt(2);
  const TEN = BigInt(10);
  const product = a[0] * r[0];
  const scale = a[1] + r[1];
  const drop = scale - minorUnits;
  let result: bigint;
  if (drop <= 0) {
    result = product * TEN ** BigInt(-drop);
  } else {
    const divisor = TEN ** BigInt(drop);
    const abs = product < ZERO ? -product : product;
    const q = abs / divisor;
    const rounded = (abs % divisor) * TWO >= divisor ? q + ONE : q;
    result = product < ZERO ? -rounded : rounded;
  }
  return Number(result) / 10 ** minorUnits;
}
