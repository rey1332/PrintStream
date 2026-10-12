// SAP Business One through the Service Layer (OData, …/b1s/v1 or /b1s/v2):
// POST /Login with the company database, user and password gives a session
// cookie (B1SESSION, and ROUTEID behind a load balancer); pages follow
// odata.nextLink. "Changed since" uses UpdateDate (a date, so a day is read
// again; rows are updated by key, never doubled). A self-signed server
// certificate can be pinned by its SHA-256 fingerprint.

import type { ObjectKey } from '@/lib/terminal/connectors';
import { TerminalError } from '@/server/terminal/session';
import type { HttpResponse } from './http';
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

interface EntityDef {
  entity: string;
  filter?: string;
  select: string[];
  map: (r: any) => Row;
}

// UpdateDate "2026-10-09" or "2026-10-09T00:00:00Z", UpdateTime "14:05:00" or 140500.
function updated(r: any): string | null {
  const d = typeof r.UpdateDate === 'string' ? r.UpdateDate.slice(0, 10) : null;
  if (!d) return null;
  const t = r.UpdateTime;
  let time = '00:00:00';
  if (typeof t === 'string' && /^\d{2}:\d{2}/.test(t))
    time = t.length === 5 ? `${t}:00` : t.slice(0, 8);
  else if (typeof t === 'number') {
    const s = String(t).padStart(6, '0');
    time = `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
  }
  // The Service Layer gives the server's local time; it is kept as written (Jakarta time assumed).
  return `${d}T${time}+07:00`;
}

const party = (type: string): EntityDef => ({
  entity: 'BusinessPartners',
  filter: `CardType eq '${type}'`,
  select: [
    'CardCode',
    'CardName',
    'EmailAddress',
    'Phone1',
    'City',
    'CurrentAccountBalance',
    'UpdateDate',
    'UpdateTime',
  ],
  map: (r) => ({
    id: text(r.CardCode),
    code: text(r.CardCode),
    name: text(r.CardName),
    email: text(pick(r, 'EmailAddress')),
    phone: text(pick(r, 'Phone1')),
    city: text(pick(r, 'City')),
    balance: num(r.CurrentAccountBalance),
    updated_at: updated(r),
  }),
});

const invoice = (entity: string): EntityDef => ({
  entity,
  select: [
    'DocEntry',
    'DocNum',
    'DocDate',
    'CardName',
    'DocTotal',
    'PaidToDate',
    'DocumentStatus',
    'DocCurrency',
    'UpdateDate',
    'UpdateTime',
  ],
  map: (r) => ({
    id: text(r.DocEntry),
    number: text(r.DocNum),
    date: typeof r.DocDate === 'string' ? r.DocDate.slice(0, 10) : null,
    partner: text(r.CardName),
    total: num(r.DocTotal),
    outstanding: num(r.DocTotal) !== null ? Number(r.DocTotal) - (num(r.PaidToDate) ?? 0) : null,
    status: text(r.DocumentStatus),
    currency: text(r.DocCurrency),
    updated_at: updated(r),
  }),
});

const ENTITIES: Record<ObjectKey, EntityDef> = {
  customers: party('cCustomer'),
  suppliers: party('cSupplier'),
  products: {
    entity: 'Items',
    select: [
      'ItemCode',
      'ItemName',
      'SalesUnit',
      'AvgStdPrice',
      'QuantityOnStock',
      'UpdateDate',
      'UpdateTime',
    ],
    map: (r) => ({
      id: text(r.ItemCode),
      code: text(r.ItemCode),
      name: text(r.ItemName),
      unit: text(pick(r, 'SalesUnit')),
      sale_price: null,
      cost_price: num(r.AvgStdPrice),
      on_hand: num(r.QuantityOnStock),
      updated_at: updated(r),
    }),
  },
  sales_invoices: invoice('Invoices'),
  purchase_invoices: invoice('PurchaseInvoices'),
};

class Session {
  private cookie: string | null = null;
  private readonly ctx: ConnectorContext;
  private readonly base: string;

  constructor(ctx: ConnectorContext) {
    this.ctx = ctx;
    this.base = String(ctx.config.url ?? '').replace(/\/+$/, '');
    if (!/^https?:\/\/.+\/b1s\/v[12]$/.test(this.base)) throw new TerminalError('sapUrl');
  }

  private async login() {
    const res = await this.ctx.http.request(`${this.base}/Login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CompanyDB: this.ctx.config.company_db,
        UserName: this.ctx.config.username,
        Password: this.ctx.secret.password,
      }),
    });
    if (res.status !== 200)
      throw res.status === 401 || res.status === 400
        ? new TerminalError('authFailed')
        : failure(res);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const pairs = cookies
      .map((c) => c.split(';')[0])
      .filter((c) => /^(B1SESSION|ROUTEID)=/.test(c));
    if (!pairs.some((c) => c.startsWith('B1SESSION='))) throw new TerminalError('authFailed');
    this.cookie = pairs.join('; ');
  }

  async get(pathOrUrl: string, pageSize = 500): Promise<any> {
    if (!this.cookie) await this.login();
    // Next-page links come relative ("Items?$skip=500") or absolute ("/b1s/v1/Items?…").
    const url = new URL(pathOrUrl, `${this.base}/`).toString();
    const send = () =>
      this.ctx.http.request(url, {
        headers: { Cookie: this.cookie!, Prefer: `odata.maxpagesize=${pageSize}` },
      });
    let res: HttpResponse = await send();
    if (res.status === 401) {
      // The session ran out (30 minutes idle by default): sign in again once.
      await this.login();
      res = await send();
    }
    if (res.status !== 200) throw failure(res);
    return res.json();
  }

  async logout() {
    if (!this.cookie) return;
    await this.ctx.http
      .request(`${this.base}/Logout`, { method: 'POST', headers: { Cookie: this.cookie } })
      .catch(() => undefined);
  }
}

export const sapB1: Adapter = {
  async test(ctx) {
    const s = new Session(ctx);
    try {
      await s.get('BusinessPartners?$select=CardCode&$top=1', 1);
      return {};
    } finally {
      await s.logout();
    }
  },

  async *read(ctx, object, since) {
    const def = ENTITIES[object];
    const filters = [def.filter, since ? `UpdateDate ge '${since.slice(0, 10)}'` : null].filter(
      Boolean
    );
    const q = new URLSearchParams({ $select: def.select.join(',') });
    if (filters.length) q.set('$filter', filters.join(' and '));
    q.set('$orderby', def.select[0]);
    const s = new Session(ctx);
    try {
      let next: string | null = `${def.entity}?${q.toString().replace(/\+/g, '%20')}`;
      for (let page = 0; next && page < MAX_PAGES; page += 1) {
        const json: any = await s.get(next);
        const rows: any[] = Array.isArray(json?.value) ? json.value : [];
        yield rows.map(def.map);
        await ctx.beat();
        next = (json['odata.nextLink'] ?? json['@odata.nextLink'] ?? null) as string | null;
      }
      if (next) throw new TerminalError('tooManyPages');
    } finally {
      await s.logout();
    }
  },
};
