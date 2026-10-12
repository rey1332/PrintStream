// Accurate Online. The ERP's Owner authorises PrintStream once (OAuth, with
// the client ID and secret of their Accurate developer app); the tokens are
// kept in the vault and refreshed when they run out. Each run opens the chosen
// database (api/open-db.do gives the data host and a session) and reads the
// list endpoints page by page (sp.page, sp.pageSize); "changed since" uses
// filter.lastUpdate (Accurate's time, dd/MM/yyyy HH:mm:ss, Jakarta).
//
// Built from Accurate's published API (accurate.id/api-integration and the
// OpenAPI at account.accurate.id/open-api/json.do); field names marked as
// assumed are checked on the first live connection.

import type { ObjectKey } from '@/lib/terminal/connectors';
import { TerminalError } from '@/server/terminal/session';
import type { GuardedHttp } from './http';
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

export const ACCURATE_ACCOUNT = 'https://account.accurate.id';
export const ACCURATE_SCOPES =
  'customer_view vendor_view item_view sales_invoice_view purchase_invoice_view';
const PAGE = 100;

// Accurate's dates: "31/03/2016" and "31/03/2016 18:30:43" (Jakarta time).
function date(v: unknown): string | null {
  const m = typeof v === 'string' ? /^(\d{2})\/(\d{2})\/(\d{4})/.exec(v) : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function stamp(v: unknown): string | null {
  const m =
    typeof v === 'string'
      ? /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?/.exec(v)
      : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}+07:00` : null;
}
function accurateTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 7 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

interface EndpointDef {
  path: string;
  fields: string[];
  map: (r: any) => Row;
}

const party = (path: string, numberField: string): EndpointDef => ({
  path,
  fields: [
    'id',
    numberField,
    'name',
    'email',
    'mobilePhone',
    'workPhone',
    'billCity',
    'balance',
    'lastUpdate',
  ],
  map: (r) => ({
    id: text(r.id),
    code: text(pick(r, numberField)),
    name: text(r.name),
    email: text(pick(r, 'email')),
    phone: text(pick(r, 'mobilePhone', 'workPhone')),
    city: text(pick(r, 'billCity')),
    balance: num(pick(r, 'balance')),
    updated_at: stamp(pick(r, 'lastUpdate')),
  }),
});

const invoice = (path: string, partner: string): EndpointDef => ({
  path,
  fields: [
    'id',
    'number',
    'transDate',
    partner,
    'totalAmount',
    'primeOwing',
    'statusName',
    'currency',
    'lastUpdate',
  ],
  map: (r) => ({
    id: text(r.id),
    number: text(r.number),
    date: date(r.transDate),
    partner: text(pick(r, `${partner}.name`, partner)),
    total: num(pick(r, 'totalAmount')),
    outstanding: num(pick(r, 'primeOwing', 'owing')),
    status: text(pick(r, 'statusName', 'status')),
    currency: text(pick(r, 'currency.code', 'currency')),
    updated_at: stamp(pick(r, 'lastUpdate')),
  }),
});

const ENDPOINTS: Record<ObjectKey, EndpointDef> = {
  customers: party('customer', 'customerNo'),
  suppliers: party('vendor', 'vendorNo'),
  products: {
    path: 'item',
    fields: [
      'id',
      'no',
      'name',
      'unit1Name',
      'unitPrice',
      'unitCost',
      'availableToSell',
      'lastUpdate',
    ],
    map: (r) => ({
      id: text(r.id),
      code: text(pick(r, 'no')),
      name: text(r.name),
      unit: text(pick(r, 'unit1Name', 'unit1.name')),
      sale_price: num(pick(r, 'unitPrice')),
      cost_price: num(pick(r, 'unitCost')),
      on_hand: num(pick(r, 'availableToSell', 'quantity')),
      updated_at: stamp(pick(r, 'lastUpdate')),
    }),
  },
  sales_invoices: invoice('sales-invoice', 'customer'),
  purchase_invoices: invoice('purchase-invoice', 'vendor'),
};

function basic(ctx: ConnectorContext): string {
  return `Basic ${Buffer.from(`${ctx.config.client_id}:${ctx.secret.client_secret}`).toString('base64')}`;
}

async function tokenRequest(http: GuardedHttp, auth: string, form: Record<string, string>) {
  const res = await http.request(`${ACCURATE_ACCOUNT}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  if (res.status !== 200)
    throw res.status === 400 || res.status === 401 ? new TerminalError('authFailed') : failure(res);
  const json = res.json();
  if (!json.access_token) throw new TerminalError('authFailed');
  return {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : null,
    expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000,
  };
}

/** After the Owner authorised PrintStream in Accurate: the code becomes tokens. */
export async function accurateExchangeCode(
  ctx: ConnectorContext,
  code: string,
  redirectUri: string
) {
  const tokens = await tokenRequest(ctx.http, basic(ctx), {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  await ctx.saveSecret({ ...ctx.secret, ...tokens });
  ctx.secret = { ...ctx.secret, ...tokens };
}

async function accessToken(ctx: ConnectorContext, force = false): Promise<string> {
  if (!ctx.secret.access_token) throw new TerminalError('needsAuth');
  if (!force && Number(ctx.secret.expires_at ?? 0) > Date.now() + 60_000)
    return ctx.secret.access_token;
  if (!ctx.secret.refresh_token) throw new TerminalError('needsAuth');
  const tokens = await tokenRequest(ctx.http, basic(ctx), {
    grant_type: 'refresh_token',
    refresh_token: ctx.secret.refresh_token,
  }).catch((e) => {
    throw e instanceof TerminalError && e.code === 'authFailed'
      ? new TerminalError('needsAuth')
      : e;
  });
  ctx.secret = {
    ...ctx.secret,
    ...tokens,
    refresh_token: tokens.refresh_token ?? ctx.secret.refresh_token,
  };
  await ctx.saveSecret(ctx.secret);
  return ctx.secret.access_token;
}

async function account(ctx: ConnectorContext, path: string): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await ctx.http.request(`${ACCURATE_ACCOUNT}${path}`, {
      headers: { Authorization: `Bearer ${await accessToken(ctx, attempt > 0)}` },
    });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status !== 200) throw failure(res);
    const json = res.json();
    if (json.s === false)
      throw new TerminalError('remoteError', { detail: String(json.d ?? '').slice(0, 200) });
    return json;
  }
  throw new TerminalError('authFailed');
}

export const accurate: Adapter = {
  async test(ctx) {
    const list = await account(ctx, '/api/db-list.do');
    const databases = (Array.isArray(list.d) ? list.d : []).map((d: any) => ({
      id: String(d.id),
      alias: text(d.alias),
    }));
    if (!ctx.config.database_id && databases.length === 1)
      await ctx.saveConfig({ database_id: databases[0].id });
    return { databases };
  },

  async *read(ctx, object, since) {
    const def = ENDPOINTS[object];
    if (!ctx.config.database_id) throw new TerminalError('accurateDatabase');
    const opened = await account(
      ctx,
      `/api/open-db.do?id=${encodeURIComponent(ctx.config.database_id)}`
    );
    const host = String(pick(opened, 'host', 'd.host') ?? '').replace(/\/+$/, '');
    const session = String(pick(opened, 'session', 'd.session') ?? '');
    if (!/^https:\/\//.test(host) || !session) throw new TerminalError('badResponse');
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const q = new URLSearchParams({
        fields: def.fields.join(','),
        'sp.page': String(page),
        'sp.pageSize': String(PAGE),
        'sp.sort': 'id|asc',
      });
      if (since) {
        q.set('filter.lastUpdate.op', 'GREATER_THAN');
        q.set('filter.lastUpdate.val', accurateTime(since));
      }
      const res = await ctx.http.request(`${host}/accurate/api/${def.path}/list.do?${q}`, {
        headers: { Authorization: `Bearer ${await accessToken(ctx)}`, 'X-Session-ID': session },
      });
      if (res.status !== 200) throw failure(res);
      const json = res.json();
      if (json.s === false)
        throw new TerminalError('remoteError', {
          detail: String(Array.isArray(json.d) ? json.d.join(' ') : (json.d ?? '')).slice(0, 200),
        });
      const rows: any[] = Array.isArray(json.d) ? json.d : [];
      yield rows.map(def.map);
      await ctx.beat();
      const pageCount = Number(json.sp?.pageCount ?? 0);
      if (!rows.length || (pageCount && page >= pageCount)) return;
    }
    throw new TerminalError('tooManyPages');
  },
};
