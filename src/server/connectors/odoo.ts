// Odoo (13 and later) through its external JSON-RPC API: sign in with the
// database, the user and an API key (Preferences → Account Security), then
// search_read on the models below. "Changed since" uses write_date (UTC).

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

const PAGE = 500;

interface ModelDef {
  model: string;
  domain: unknown[];
  fields: string[];
  map: (r: any) => Row;
}

const many2one = (v: unknown) => (Array.isArray(v) ? text(v[1]) : null);
// Odoo writes UTC times as "YYYY-MM-DD HH:MM:SS".
const utc = (v: unknown) => (typeof v === 'string' && v ? `${v.replace(' ', 'T')}Z` : null);

const party =
  (balanceField: string) =>
  (r: any): Row => ({
    id: String(r.id),
    code: text(pick(r, 'ref')),
    name: text(r.name),
    email: text(pick(r, 'email')),
    phone: text(pick(r, 'phone', 'mobile')),
    city: text(pick(r, 'city')),
    balance: num(r[balanceField]),
    updated_at: utc(r.write_date),
  });

const invoice = (r: any): Row => ({
  id: String(r.id),
  number: text(r.name),
  date: text(pick(r, 'invoice_date')),
  partner: many2one(r.partner_id),
  total: num(r.amount_total),
  outstanding: num(r.amount_residual),
  status: text(pick(r, 'payment_state', 'state')),
  currency: many2one(r.currency_id),
  updated_at: utc(r.write_date),
});

const MODELS: Record<ObjectKey, ModelDef> = {
  customers: {
    model: 'res.partner',
    domain: [['customer_rank', '>', 0]],
    fields: ['id', 'ref', 'name', 'email', 'phone', 'mobile', 'city', 'credit', 'write_date'],
    map: party('credit'),
  },
  suppliers: {
    model: 'res.partner',
    domain: [['supplier_rank', '>', 0]],
    fields: ['id', 'ref', 'name', 'email', 'phone', 'mobile', 'city', 'debit', 'write_date'],
    map: party('debit'),
  },
  products: {
    model: 'product.product',
    domain: [],
    fields: [
      'id',
      'default_code',
      'name',
      'uom_id',
      'list_price',
      'standard_price',
      'qty_available',
      'write_date',
    ],
    map: (r) => ({
      id: String(r.id),
      code: text(pick(r, 'default_code')),
      name: text(r.name),
      unit: many2one(r.uom_id),
      sale_price: num(r.list_price),
      cost_price: num(r.standard_price),
      on_hand: num(r.qty_available),
      updated_at: utc(r.write_date),
    }),
  },
  sales_invoices: {
    model: 'account.move',
    domain: [['move_type', '=', 'out_invoice']],
    fields: [
      'id',
      'name',
      'invoice_date',
      'partner_id',
      'amount_total',
      'amount_residual',
      'payment_state',
      'state',
      'currency_id',
      'write_date',
    ],
    map: invoice,
  },
  purchase_invoices: {
    model: 'account.move',
    domain: [['move_type', '=', 'in_invoice']],
    fields: [
      'id',
      'name',
      'invoice_date',
      'partner_id',
      'amount_total',
      'amount_residual',
      'payment_state',
      'state',
      'currency_id',
      'write_date',
    ],
    map: invoice,
  },
};

function baseUrl(ctx: ConnectorContext): string {
  const url = String(ctx.config.url ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) throw new TerminalError('invalid');
  return url;
}

async function rpc(
  ctx: ConnectorContext,
  service: string,
  method: string,
  args: unknown[]
): Promise<any> {
  const res = await ctx.http.request(`${baseUrl(ctx)}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service, method, args },
      id: Date.now(),
    }),
  });
  if (res.status !== 200) throw failure(res);
  const json = res.json();
  if (json.error) {
    const name = String(json.error?.data?.name ?? '');
    if (/AccessDenied|AccessError/.test(name)) throw new TerminalError('authFailed');
    throw new TerminalError('remoteError', {
      detail: String(json.error?.data?.message ?? json.error?.message ?? '').slice(0, 200),
    });
  }
  return json.result;
}

async function signIn(ctx: ConnectorContext): Promise<number> {
  const uid = await rpc(ctx, 'common', 'authenticate', [
    ctx.config.database,
    ctx.config.username,
    ctx.secret.api_key,
    {},
  ]);
  if (!uid) throw new TerminalError('authFailed');
  return Number(uid);
}

export const odoo: Adapter = {
  async test(ctx) {
    const version = await rpc(ctx, 'common', 'version', []);
    await signIn(ctx);
    return { version: text(version?.server_version) };
  },

  async *read(ctx, object, since) {
    const def = MODELS[object];
    const uid = await signIn(ctx);
    const domain = since
      ? [
          ...def.domain,
          [
            'write_date',
            '>',
            since
              .replace('T', ' ')
              .replace(/(\.\d+)?Z$/, '')
              .slice(0, 19),
          ],
        ]
      : def.domain;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = await rpc(ctx, 'object', 'execute_kw', [
        ctx.config.database,
        uid,
        ctx.secret.api_key,
        def.model,
        'search_read',
        [domain],
        { fields: def.fields, order: 'write_date asc, id asc', limit: PAGE, offset: page * PAGE },
      ]);
      if (!Array.isArray(rows)) throw new TerminalError('badResponse');
      yield rows.map(def.map);
      await ctx.beat();
      if (rows.length < PAGE) return;
    }
    throw new TerminalError('tooManyPages');
  },
};
