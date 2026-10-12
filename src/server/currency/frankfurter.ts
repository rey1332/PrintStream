const CODE = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMEOUT_MS = 8000;

export interface ProviderRate {
  from: string;
  to: string;
  rate: string;
  date: string;
}

export interface ProviderStatus {
  enabled: boolean;
  name: string;
  providers: string | null;
}

export class RateProviderError extends Error {
  code: 'disabled' | 'unavailable' | 'invalidResponse' | 'notFound';
  constructor(code: RateProviderError['code']) {
    super(code);
    this.code = code;
  }
}

function settings() {
  const enabled = (process.env.EXCHANGE_RATE_PROVIDER ?? 'frankfurter').toLowerCase() !== 'off';
  const url = (process.env.FRANKFURTER_URL || 'https://api.frankfurter.dev/v2').replace(/\/+$/, '');
  const providers = (process.env.FRANKFURTER_PROVIDERS ?? '')
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter((p) => /^[A-Z0-9_]{2,20}$/.test(p));
  return { enabled, url, providers: providers.length ? providers.join(',') : null };
}

export function providerStatus(): ProviderStatus {
  const s = settings();
  return { enabled: s.enabled, name: 'Frankfurter', providers: s.providers };
}

export function providerLabel(): string {
  const s = settings();
  return `Frankfurter (${s.providers ?? 'blend'})`;
}

export function parseRates(body: unknown, base: string, quotes: string[]): ProviderRate[] {
  if (!Array.isArray(body)) throw new RateProviderError('invalidResponse');
  const wanted = new Set(quotes);
  const out: ProviderRate[] = [];
  for (const row of body) {
    if (!row || typeof row !== 'object') throw new RateProviderError('invalidResponse');
    const { date, base: b, quote, rate } = row as Record<string, unknown>;
    if (
      typeof date !== 'string' ||
      !DATE.test(date) ||
      b !== base ||
      typeof quote !== 'string' ||
      !CODE.test(quote)
    ) {
      throw new RateProviderError('invalidResponse');
    }
    if (quote === base || !wanted.has(quote)) continue;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0)
      throw new RateProviderError('invalidResponse');
    // String() gives the shortest text that round-trips, i.e. the published digits.
    out.push({ from: base, to: quote, rate: String(rate), date });
  }
  return out;
}

export async function fetchRates(
  base: string,
  quotes: string[],
  date: string,
  fetchImpl: typeof fetch = fetch
): Promise<ProviderRate[]> {
  const s = settings();
  if (!s.enabled) throw new RateProviderError('disabled');
  if (
    !CODE.test(base) ||
    quotes.length === 0 ||
    quotes.length > 30 ||
    !quotes.every((q) => CODE.test(q)) ||
    !DATE.test(date)
  ) {
    throw new RateProviderError('invalidResponse');
  }
  const params = new URLSearchParams({ base, quotes: quotes.join(','), date });
  if (s.providers) params.set('providers', s.providers);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${s.url}/rates?${params}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
  } catch {
    console.error('[currency] provider unreachable');
    throw new RateProviderError('unavailable');
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404 || response.status === 422) throw new RateProviderError('notFound');
  if (!response.ok) {
    console.error('[currency] provider status', response.status);
    throw new RateProviderError('unavailable');
  }
  const rows = parseRates(await response.json().catch(() => null), base, quotes);
  if (rows.length === 0) throw new RateProviderError('notFound');
  return rows;
}
