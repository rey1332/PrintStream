import { beginAsUser, getCatalog, type RequestIdentity } from '@/server/db/execute';
import type { Executor, SqlTx } from '@/server/db/executor';
import {
  RateProviderError,
  fetchRates,
  providerLabel,
  providerStatus,
  type ProviderStatus,
} from './frankfurter';

export interface CurrencyContext {
  executor: Executor;
  identity: RequestIdentity;
  workspacesEnabled: boolean;
}

export class CurrencyError extends Error {
  code: string;
  userMessage?: string;
  constructor(code: string, userMessage?: string) {
    super(code);
    this.code = code;
    this.userMessage = userMessage;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const today = () => new Date().toISOString().slice(0, 10);

function workspaceOf(ctx: CurrencyContext, workspaceId: unknown): string | null {
  if (
    !ctx.workspacesEnabled ||
    workspaceId === null ||
    workspaceId === undefined ||
    workspaceId === ''
  )
    return null;
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId))
    throw new CurrencyError('invalidWorkspace');
  return workspaceId;
}

async function inTx<T>(
  ctx: CurrencyContext,
  path: string,
  fn: (tx: SqlTx) => Promise<T>
): Promise<T> {
  const catalog = await getCatalog(ctx.executor);
  try {
    return await ctx.executor.transaction(async (tx) => {
      await beginAsUser(tx, ctx.identity, path, 'POST', catalog);
      return fn(tx);
    });
  } catch (error) {
    if (error instanceof CurrencyError) throw error;
    const e = error as { code?: string; message?: string; hint?: string };
    // Business rules raised by ETNA's functions carry a message meant for people.
    if (e.code === 'P0001') throw new CurrencyError(e.hint || 'rule', e.message);
    console.error('[currency]', e.code || 'error');
    if (e.code === '42501') throw new CurrencyError('forbidden');
    if (e.code === '57014') throw new CurrencyError('timeout');
    if (e.code === '22023' || e.code === '22P02' || e.code === '23503')
      throw new CurrencyError('invalid');
    throw new CurrencyError('failed');
  }
}

export interface CurrencySettings {
  baseCurrency: string;
  confirmedAt: string | null;
  locked: boolean;
  hasRecords: boolean;
  canChangeBase: boolean;
  canManageRates: boolean;
  canFetchRates: boolean;
  provider: ProviderStatus;
  maxRateAgeDays: number;
  currencies: { code: string; name: string; minorUnits: number }[];
}

export async function currencySettings(
  ctx: CurrencyContext,
  workspaceId: unknown
): Promise<CurrencySettings> {
  const ws = workspaceOf(ctx, workspaceId);
  return inTx(ctx, '/currency/settings', async (tx) => {
    const { rows } = await tx.query('SELECT * FROM public.erp_currency_settings_get($1::uuid)', [
      ws,
    ]);
    const s = rows[0];
    if (!s) throw new CurrencyError('notFound');
    const currencies = (
      await tx.query('SELECT code, name, minor_units FROM public.erp_currencies ORDER BY code')
    ).rows.map((c: any) => ({ code: c.code, name: c.name, minorUnits: Number(c.minor_units) }));
    return {
      baseCurrency: s.base_currency,
      confirmedAt: s.confirmed_at ? new Date(s.confirmed_at).toISOString() : null,
      locked: s.locked === true,
      hasRecords: s.has_records === true,
      canChangeBase: s.can_change_base === true,
      canManageRates: s.can_manage_rates === true,
      canFetchRates: s.can_fetch_rates === true,
      provider: providerStatus(),
      maxRateAgeDays: 7,
      currencies,
    };
  });
}

export async function currencyPreview(
  ctx: CurrencyContext,
  workspaceId: unknown
): Promise<unknown> {
  const ws = workspaceOf(ctx, workspaceId);
  return inTx(
    ctx,
    '/currency/preview',
    async (tx) =>
      (await tx.query('SELECT public.erp_currency_preview($1::uuid) AS p', [ws])).rows[0].p
  );
}

export async function confirmBaseCurrency(
  ctx: CurrencyContext,
  workspaceId: unknown,
  currency: unknown,
  baseRows: unknown
): Promise<unknown> {
  const ws = workspaceOf(ctx, workspaceId);
  if (typeof currency !== 'string' || !CODE.test(currency)) throw new CurrencyError('invalid');
  if (!Number.isInteger(baseRows) || (baseRows as number) < 0) throw new CurrencyError('invalid');
  return inTx(
    ctx,
    '/currency/confirm',
    async (tx) =>
      (
        await tx.query('SELECT public.erp_confirm_base_currency($1::uuid, $2, $3::bigint) AS p', [
          ws,
          currency,
          baseRows,
        ])
      ).rows[0].p
  );
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

export async function listRates(ctx: CurrencyContext, workspaceId: unknown): Promise<RateRow[]> {
  const ws = workspaceOf(ctx, workspaceId);
  return inTx(ctx, '/currency/rates', async (tx) => {
    // The workspace owner's books (rates are kept per ledger, like accounts).
    const { rows } = await tx.query(
      `SELECT r.id, r.from_currency, r.to_currency, r.rate::text AS rate, r.effective_date::text AS effective_date,
              r.source, r.provider, r.retrieved_at, r.note, r.created_at
       FROM public.erp_exchange_rates r
       WHERE r.user_id = COALESCE((SELECT owner_id FROM public.erp_workspaces WHERE id = $1::uuid), auth.uid())
       ORDER BY r.effective_date DESC, r.created_at DESC LIMIT 200`,
      [ws]
    );
    return rows.map((r: any) => ({
      id: r.id,
      from: r.from_currency,
      to: r.to_currency,
      rate: r.rate,
      effectiveDate: r.effective_date,
      source: r.source,
      provider: r.provider,
      retrievedAt: new Date(r.retrieved_at).toISOString(),
      note: r.note,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  });
}

export async function addRate(
  ctx: CurrencyContext,
  workspaceId: unknown,
  input: any
): Promise<string> {
  const ws = workspaceOf(ctx, workspaceId);
  const from = String(input?.from ?? '').toUpperCase();
  const to = String(input?.to ?? '').toUpperCase();
  const rate = String(input?.rate ?? '').trim();
  const date = String(input?.date ?? '');
  if (
    !CODE.test(from) ||
    !CODE.test(to) ||
    !/^\d{1,12}(\.\d{1,12})?$/.test(rate) ||
    !DATE.test(date)
  )
    throw new CurrencyError('invalid');
  const note = typeof input?.note === 'string' ? input.note.slice(0, 300) : '';
  return inTx(
    ctx,
    '/currency/rates',
    async (tx) =>
      (
        await tx.query(
          'SELECT public.erp_add_exchange_rate($1::uuid, $2, $3, $4::numeric, $5::date, $6) AS id',
          [ws, from, to, rate, date, note]
        )
      ).rows[0].id
  );
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

async function lookupOnce(
  ctx: CurrencyContext,
  ws: string | null,
  from: string,
  to: string,
  date: string
): Promise<RateLookup> {
  return inTx(ctx, '/currency/lookup', async (tx) => {
    const { rows } = await tx.query(
      `SELECT rate::text AS rate, rate_date::text AS rate_date, source, provider, method, age_days, stale
       FROM public.erp_exchange_rate_lookup($1::uuid, $2, $3, $4::date)`,
      [ws, from, to, date]
    );
    const r = rows[0];
    return r
      ? {
          rate: r.rate,
          rateDate: r.rate_date,
          source: r.source,
          provider: r.provider,
          method: r.method,
          ageDays: Number(r.age_days),
          stale: r.stale === true,
          fetched: false,
          fetchError: null,
        }
      : {
          rate: null,
          rateDate: null,
          source: null,
          provider: null,
          method: null,
          ageDays: null,
          stale: false,
          fetched: false,
          fetchError: null,
        };
  });
}

async function mayFetch(ctx: CurrencyContext, ws: string | null): Promise<boolean> {
  return inTx(
    ctx,
    '/currency/settings',
    async (tx) =>
      (
        await tx.query('SELECT can_fetch_rates FROM public.erp_currency_settings_get($1::uuid)', [
          ws,
        ])
      ).rows[0]?.can_fetch_rates === true
  );
}

async function importRates(
  ctx: CurrencyContext,
  ws: string | null,
  rows: { from: string; to: string; rate: string; date: string }[]
): Promise<number> {
  return inTx(ctx, '/currency/import', async (tx) =>
    Number(
      (
        await tx.query(
          'SELECT public.erp_import_exchange_rates($1::uuid, $2, now(), $3::jsonb) AS n',
          [ws, providerLabel(), JSON.stringify(rows)]
        )
      ).rows[0].n
    )
  );
}

export async function lookupRate(
  ctx: CurrencyContext,
  workspaceId: unknown,
  input: any
): Promise<RateLookup> {
  const ws = workspaceOf(ctx, workspaceId);
  const from = String(input?.from ?? '').toUpperCase();
  const to = String(input?.to ?? '').toUpperCase();
  const date = input?.date ? String(input.date) : today();
  if (!CODE.test(from) || !CODE.test(to) || !DATE.test(date) || date > today())
    throw new CurrencyError('invalid');
  const first = await lookupOnce(ctx, ws, from, to, date);
  if (from === to || !input?.fetch || (first.rate && !first.stale)) return first;
  if (!(await mayFetch(ctx, ws))) return { ...first, fetchError: 'forbidden' };
  try {
    await importRates(ctx, ws, await fetchRates(from, [to], date));
  } catch (error) {
    if (error instanceof RateProviderError) return { ...first, fetchError: error.code };
    if (error instanceof CurrencyError && error.code === 'forbidden')
      return { ...first, fetchError: 'forbidden' };
    throw error;
  }
  return { ...(await lookupOnce(ctx, ws, from, to, date)), fetched: true };
}

export async function fetchAndStore(
  ctx: CurrencyContext,
  workspaceId: unknown,
  input: any
): Promise<{ stored: number; fetched: number }> {
  const ws = workspaceOf(ctx, workspaceId);
  const base = String(input?.base ?? '').toUpperCase();
  const quotes = Array.isArray(input?.quotes)
    ? input.quotes.map((q: unknown) => String(q).toUpperCase())
    : [];
  const date = input?.date ? String(input.date) : today();
  if (
    !CODE.test(base) ||
    quotes.length === 0 ||
    quotes.length > 30 ||
    !quotes.every((q: string) => CODE.test(q) && q !== base) ||
    !DATE.test(date) ||
    date > today()
  ) {
    throw new CurrencyError('invalid');
  }
  if (!(await mayFetch(ctx, ws))) throw new CurrencyError('forbidden');
  let rows;
  try {
    rows = await fetchRates(base, quotes, date);
  } catch (error) {
    if (error instanceof RateProviderError) throw new CurrencyError(`provider_${error.code}`);
    throw error;
  }
  return { stored: await importRates(ctx, ws, rows), fetched: rows.length };
}
