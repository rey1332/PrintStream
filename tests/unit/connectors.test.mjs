import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

process.env.MFA_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const { checkTarget } = await import('../../src/server/connectors/http.ts');
const { sealJson, openJson } = await import('../../src/server/vault.ts');
const { mekariHeaders, jurnal } = await import('../../src/server/connectors/jurnal.ts');
const { odoo } = await import('../../src/server/connectors/odoo.ts');
const { sapB1 } = await import('../../src/server/connectors/sapb1.ts');
const { accurate } = await import('../../src/server/connectors/accurate.ts');

// A fake ERP: handlers by method + path; records every request.
function fakeHttp(handlers) {
  const calls = [];
  return {
    calls,
    async request(url, options = {}) {
      const u = new URL(url);
      calls.push({ url: u, options });
      const key = `${options.method ?? 'GET'} ${u.pathname}`;
      const handler = handlers[key];
      if (!handler) throw new Error(`unexpected ${key}`);
      const out = await handler(u, options, calls);
      const body = Buffer.from(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {}));
      return { status: out.status ?? 200, headers: out.headers ?? {}, body, url, text: () => body.toString(), json: () => JSON.parse(body.toString()) };
    },
  };
}

function ctxOf(http, config, secret = {}) {
  const saved = { secret: null, config: {} };
  return {
    saved,
    ctx: {
      http,
      config,
      secret,
      saveSecret: async (s) => {
        saved.secret = s;
      },
      saveConfig: async (p) => {
        Object.assign(saved.config, p);
      },
      beat: async () => {},
    },
  };
}

async function collect(gen) {
  const out = [];
  for await (const page of gen) out.push(...page);
  return out;
}

test('the network guard refuses internal targets unless ETNA allows them', async () => {
  await assert.rejects(checkTarget(new URL('https://127.0.0.1/x')), /hostBlocked/);
  await assert.rejects(checkTarget(new URL('http://169.254.169.254/latest/meta-data')), /hostBlocked/);
  await assert.rejects(checkTarget(new URL('https://[::ffff:127.0.0.1]/')), /hostBlocked/);
  // IPv6 forms that carry an internal IPv4 address, and IPv4 tunnels.
  await assert.rejects(checkTarget(new URL('https://[::127.0.0.1]/')), /hostBlocked/);
  await assert.rejects(checkTarget(new URL('https://[64:ff9b::127.0.0.1]/')), /hostBlocked/);
  await assert.rejects(checkTarget(new URL('https://[64:ff9b::a9fe:a9fe]/')), /hostBlocked/);
  await assert.rejects(checkTarget(new URL('https://[64:ff9b::10.0.0.5]/')), /hostPrivate/);
  await assert.rejects(checkTarget(new URL('https://[64:ff9b:1::1]/')), /hostBlocked/);
  await assert.rejects(checkTarget(new URL('https://[2002:7f00:1::1]/')), /hostBlocked/);
  await assert.rejects(checkTarget(new URL('https://[2001:0:4136:e378::1]/')), /hostBlocked/);
  await assert.rejects(checkTarget(new URL('https://[fec0::1]/')), /hostBlocked/);
  assert.equal((await checkTarget(new URL('https://[64:ff9b::5db8:d822]/'))).internal, false);
  assert.equal((await checkTarget(new URL('https://[2606:4700::1111]/'))).internal, false);
  await assert.rejects(checkTarget(new URL('https://10.0.0.5:50000/b1s/v1')), /hostPrivate/);
  const ok = await checkTarget(new URL('https://10.0.0.5:50000/b1s/v1'), ['10.0.0.0/8']);
  assert.deepEqual([ok.address, ok.internal], ['10.0.0.5', true]);
  assert.equal((await checkTarget(new URL('http://10.0.0.5/'), ['10.0.0.5'])).internal, true);
  await assert.rejects(checkTarget(new URL('http://93.184.216.34/')), /httpsRequired/);
  await assert.rejects(checkTarget(new URL('ftp://93.184.216.34/')), /urlScheme/);
  await assert.rejects(checkTarget(new URL('https://user:pw@93.184.216.34/')), /urlCredentials/);
});

test('the vault seals and opens; a changed byte is refused', () => {
  const sealed = sealJson({ api_key: 'k-123' });
  assert.match(sealed, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.deepEqual(openJson(sealed), { api_key: 'k-123' });
  const parts = sealed.split(':');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => openJson(parts.join(':')));
});

test('Mekari HMAC: the signed line includes the query; header as documented', () => {
  const now = new Date('2026-10-10T07:24:29Z');
  const h = mekariHeaders('cid', 'secret', 'GET', '/public/jurnal/api/v1/customers?page=1&page_size=100', now);
  assert.equal(h.Date, 'Sat, 10 Oct 2026 07:24:29 GMT');
  const expected = createHmac('sha256', 'secret')
    .update('date: Sat, 10 Oct 2026 07:24:29 GMT\nGET /public/jurnal/api/v1/customers?page=1&page_size=100 HTTP/1.1')
    .digest('base64');
  assert.equal(h.Authorization, `hmac username="cid", algorithm="hmac-sha256", headers="date request-line", signature="${expected}"`);
});

test('Odoo: signs in, reads search_read pages, asks only for changes since the cursor', async () => {
  const http = fakeHttp({
    'POST /jsonrpc': (_u, o) => {
      const { params } = JSON.parse(o.body);
      if (params.method === 'authenticate') return { body: { result: 7 } };
      const [, uid, , model, , [domain], kw] = params.args;
      assert.equal(uid, 7);
      assert.equal(model, 'res.partner');
      assert.deepEqual(domain[1], ['write_date', '>', '2026-10-01 00:00:00']);
      return {
        body: {
          result:
            kw.offset === 0
              ? [{ id: 5, ref: 'C-5', name: 'PT Batu', email: false, phone: '021', city: 'Bogor', credit: 1500, write_date: '2026-10-02 03:04:05' }]
              : [],
        },
      };
    },
  });
  const { ctx } = ctxOf(http, { url: 'https://odoo.example.com', database: 'prod', username: 'a@b.c' }, { api_key: 'k' });
  const rows = await collect(odoo.read(ctx, 'customers', '2026-10-01T00:00:00.000Z'));
  assert.deepEqual(rows, [{ id: '5', code: 'C-5', name: 'PT Batu', email: null, phone: '021', city: 'Bogor', balance: 1500, updated_at: '2026-10-02T03:04:05Z' }]);
  const bad = fakeHttp({ 'POST /jsonrpc': () => ({ body: { result: false } }) });
  await assert.rejects(collect(odoo.read(ctxOf(bad, ctx.config, ctx.secret).ctx, 'customers', null)), /authFailed/);
});

test('SAP B1: logs in, follows nextLink, signs in again after a 401', async () => {
  let gets = 0;
  const http = fakeHttp({
    'POST /b1s/v1/Login': (_u, o) => {
      assert.deepEqual(JSON.parse(o.body), { CompanyDB: 'SBODEMO', UserName: 'manager', Password: 'pw' });
      return { headers: { 'set-cookie': ['B1SESSION=abc; path=/b1s', 'ROUTEID=.node1; path=/b1s'] } };
    },
    'POST /b1s/v1/Logout': () => ({ status: 204 }),
    'GET /b1s/v1/BusinessPartners': (u, o) => {
      gets += 1;
      if (gets === 1) return { status: 401 };
      assert.equal(o.headers.Cookie, 'B1SESSION=abc; ROUTEID=.node1');
      if (!u.searchParams.get('$skip')) {
        assert.match(u.searchParams.get('$filter'), /CardType eq 'cCustomer' and UpdateDate ge '2026-10-01'/);
        return { body: { value: [{ CardCode: 'C001', CardName: 'PT A', CurrentAccountBalance: 10, UpdateDate: '2026-10-02', UpdateTime: '13:05:00' }], 'odata.nextLink': 'BusinessPartners?$skip=500' } };
      }
      return { body: { value: [{ CardCode: 'C002', CardName: 'PT B', UpdateDate: '2026-10-03T00:00:00Z', UpdateTime: 90500 }] } };
    },
  });
  const { ctx } = ctxOf(http, { url: 'https://sap.example.com:50000/b1s/v1', company_db: 'SBODEMO', username: 'manager' }, { password: 'pw' });
  const rows = await collect(sapB1.read(ctx, 'customers', '2026-10-01T05:00:00Z'));
  assert.deepEqual(rows.map((r) => [r.id, r.updated_at]), [['C001', '2026-10-02T13:05:00+07:00'], ['C002', '2026-10-03T09:05:00+07:00']]);
  assert.equal(http.calls.filter((c) => c.url.pathname.endsWith('/Login')).length, 2);
});

test('Accurate: refreshes an expired token, opens the database, reads list pages', async () => {
  const http = fakeHttp({
    'POST /oauth/token': (_u, o) => {
      assert.equal(o.headers.Authorization, `Basic ${Buffer.from('cid:cs').toString('base64')}`);
      assert.match(o.body, /grant_type=refresh_token&refresh_token=r1/);
      return { body: { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 } };
    },
    'GET /api/open-db.do': (u, o) => {
      assert.equal(u.searchParams.get('id'), '1156');
      assert.equal(o.headers.Authorization, 'Bearer a2');
      return { body: { s: true, host: 'https://public.accurate.id', session: 'sess' } };
    },
    'GET /accurate/api/customer/list.do': (u, o) => {
      assert.equal(o.headers['X-Session-ID'], 'sess');
      assert.equal(u.searchParams.get('filter.lastUpdate.op'), 'GREATER_THAN');
      assert.equal(u.searchParams.get('filter.lastUpdate.val'), '01/10/2026 07:00:00');
      const page = Number(u.searchParams.get('sp.page'));
      return { body: { s: true, d: [{ id: page, customerNo: `C-${page}`, name: 'PT X', lastUpdate: '02/10/2026 08:00:00' }], sp: { page, pageCount: 2 } } };
    },
  });
  const { ctx, saved } = ctxOf(http, { client_id: 'cid', database_id: '1156' }, { client_secret: 'cs', access_token: 'a1', refresh_token: 'r1', expires_at: 0 });
  const rows = await collect(accurate.read(ctx, 'customers', '2026-10-01T00:00:00Z'));
  assert.deepEqual(rows.map((r) => [r.id, r.code, r.updated_at]), [['1', 'C-1', '2026-10-02T08:00:00+07:00'], ['2', 'C-2', '2026-10-02T08:00:00+07:00']]);
  assert.equal(saved.secret.access_token, 'a2');
  assert.equal(saved.secret.refresh_token, 'r2');
});

test('Jurnal: signed requests, pages until a short page', async () => {
  const http = fakeHttp({
    'GET /public/jurnal/api/v1/sales_invoices': (u, o) => {
      assert.match(o.headers.Authorization, /^hmac username="cid", algorithm="hmac-sha256"/);
      const page = Number(u.searchParams.get('page'));
      const rows = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, transaction_no: `INV-${i + 1}`, original_amount: '1000', remaining: '0', person: { display_name: 'PT Y' } })) : [{ id: 101, transaction_no: 'INV-101' }];
      return { body: { sales_invoices: rows, total_pages: 2 } };
    },
  });
  const { ctx } = ctxOf(http, { environment: 'sandbox' }, { client_id: 'cid', client_secret: 'cs' });
  const rows = await collect(jurnal.read(ctx, 'sales_invoices', null));
  assert.equal(rows.length, 101);
  assert.deepEqual([rows[0].number, rows[0].partner, rows[0].total], ['INV-1', 'PT Y', 1000]);
  assert.equal(http.calls[0].url.host, 'sandbox-api.mekari.com');
});
