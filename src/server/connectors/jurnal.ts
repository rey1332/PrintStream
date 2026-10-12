// Jurnal by Mekari through the Mekari API (api.mekari.com, or the sandbox),
// signed with HMAC (a client ID and secret Mekari gives per company): every
// request carries a Date header and an Authorization header whose signature is
// HMAC-SHA256 over "date: <Date>\n<METHOD> <path?query> HTTP/1.1".
// Lists are read in full every run (page, page_size); a later full read
// removes rows deleted in Jurnal.
//
// Signing follows developers.mekari.com (HMAC authentication); the list
// paths and fields follow the Jurnal API v1 and are checked on the first live
// connection.

import { createHmac } from 'node:crypto';
import type { ObjectKey } from '@/lib/terminal/connectors';
import { TerminalError } from '@/server/terminal/session';
import {
  MAX_PAGES,
  failure,
  num,
  pick,
  text,
  type Adapter,
  type ConnectorContext,
  type Row,
} from './types';

const PAGE = 100;
const BASES = {
  production: 'https://api.mekari.com',
  sandbox: 'https://sandbox-api.mekari.com',
} as const;
const PREFIX = '/public/jurnal/api/v1';

/** The Authorization and Date headers for one request (exported for tests). */
export function mekariHeaders(
  clientId: string,
  clientSecret: string,
  method: string,
  pathWithQuery: string,
  now = new Date()
) {
  const date = now.toUTCString();
  const payload = [`date: ${date}`, `${method} ${pathWithQuery} HTTP/1.1`].join('\n');
  const signature = createHmac('sha256', clientSecret).update(payload).digest('base64');
  return {
    Date: date,
    Authorization: `hmac username="${clientId}", algorithm="hmac-sha256", headers="date request-line", signature="${signature}"`,
  };
}

const iso = (v: unknown) => (typeof v === 'string' && v ? v : null);

const party = (r: any): Row => ({
  id: text(r.id),
  code: text(pick(r, 'custom_id', 'code')),
  name: text(pick(r, 'display_name', 'name')),
  email: text(pick(r, 'email')),
  phone: text(pick(r, 'phone', 'mobile')),
  city: text(pick(r, 'billing_address.city', 'city')),
  balance: num(pick(r, 'balance', 'receivable', 'payable')),
  updated_at: iso(pick(r, 'updated_at')),
});

const invoice = (r: any): Row => ({
  id: text(r.id),
  number: text(pick(r, 'transaction_no', 'number')),
  date: text(pick(r, 'transaction_date')),
  partner: text(pick(r, 'person.display_name', 'person.name', 'customer.name', 'vendor.name')),
  total: num(pick(r, 'original_amount', 'total_amount', 'total')),
  outstanding: num(pick(r, 'remaining', 'remaining_amount', 'due')),
  status: text(pick(r, 'transaction_status.name', 'status')),
  currency: text(pick(r, 'currency_code', 'currency.code')),
  updated_at: iso(pick(r, 'updated_at')),
});

const RESOURCES: Record<ObjectKey, { path: string; key: string; map: (r: any) => Row }> = {
  customers: { path: 'customers', key: 'customers', map: party },
  suppliers: { path: 'vendors', key: 'vendors', map: party },
  products: {
    path: 'products',
    key: 'products',
    map: (r) => ({
      id: text(r.id),
      code: text(pick(r, 'product_code', 'code')),
      name: text(r.name),
      unit: text(pick(r, 'unit.name', 'unit')),
      sale_price: num(pick(r, 'sell_price_per_unit', 'sell_price')),
      cost_price: num(pick(r, 'buy_price_per_unit', 'average_price', 'buy_price')),
      on_hand: num(pick(r, 'quantity_available', 'quantity')),
      updated_at: iso(pick(r, 'updated_at')),
    }),
  },
  sales_invoices: { path: 'sales_invoices', key: 'sales_invoices', map: invoice },
  purchase_invoices: { path: 'purchase_invoices', key: 'purchase_invoices', map: invoice },
};

async function get(ctx: ConnectorContext, path: string): Promise<any> {
  const env = ctx.config.environment === 'sandbox' ? 'sandbox' : 'production';
  const signed = mekariHeaders(
    String(ctx.secret.client_id ?? ''),
    String(ctx.secret.client_secret ?? ''),
    'GET',
    path
  );
  const res = await ctx.http.request(`${BASES[env]}${path}`, { headers: signed });
  if (res.status !== 200) throw failure(res);
  return res.json();
}

/** The list in an answer: under its name, under "data", or the first list found. */
function listOf(json: any, key: string): any[] {
  if (Array.isArray(json?.[key])) return json[key];
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.data?.[key])) return json.data[key];
  const first = json && typeof json === 'object' ? Object.values(json).find(Array.isArray) : null;
  return (first as any[]) ?? [];
}

export const jurnal: Adapter = {
  async test(ctx) {
    await get(ctx, `${PREFIX}/customers?page=1&page_size=1`);
    return {};
  },

  // Full reads only (since is ignored).
  async *read(ctx, object) {
    const def = RESOURCES[object];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const json = await get(ctx, `${PREFIX}/${def.path}?page=${page}&page_size=${PAGE}`);
      const rows = listOf(json, def.key);
      yield rows.map(def.map);
      await ctx.beat();
      const total = Number(json?.total_pages ?? json?.meta?.total_pages ?? 0);
      if (rows.length < PAGE || (total && page >= total)) return;
    }
    throw new TerminalError('tooManyPages');
  },
};
