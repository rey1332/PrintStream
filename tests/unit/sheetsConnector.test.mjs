import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';

process.env.MFA_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const {
  parseSheetSource,
  googleSheetId,
  googleGid,
  graphShareId,
  rowsFromGrid,
  excelSerialToIso,
  isDateFormat,
  excelGrid,
  sheetColumns,
} = await import('../../src/lib/terminal/sheetSource.ts');
const { collectSheet, describeSheet, googleAssertion, sheets } = await import(
  '../../src/server/connectors/sheets.ts'
);

// Spreadsheets online (20261012000063): Google Sheets and Excel in OneDrive / SharePoint.

const GOOGLE = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=42';
const MS = 'https://contoso.sharepoint.com/:x:/s/finance/EAbCdEf?e=xyz';

test('sources: Google and Microsoft addresses, tab, range and header row', () => {
  assert.equal(googleSheetId(GOOGLE), '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  assert.equal(googleGid(GOOGLE), '42');
  const s = parseSheetSource({ mode: 'sheet', url: GOOGLE, sheet: 'Penjualan', range: 'a1:h500', header_row: 2 }, 'google');
  assert.deepEqual(s, { mode: 'sheet', url: GOOGLE, sheet: 'Penjualan', range: 'A1:H500', header_row: 2, key: null });
  assert.equal(parseSheetSource({ mode: 'sheet', url: MS }, 'google'), null, 'a SharePoint link is not a Google sheet');
  assert.ok(parseSheetSource({ mode: 'sheet', url: MS }, 'microsoft'));
  assert.equal(parseSheetSource({ mode: 'sheet', url: 'https://evil.example/x.xlsx' }, 'microsoft'), null);
  assert.equal(parseSheetSource({ mode: 'sheet', url: GOOGLE, range: 'A1:B2; DROP' }, 'google'), null);
  assert.equal(parseSheetSource({ mode: 'sheet', url: GOOGLE, header_row: 0 }, 'google'), null);
  // Microsoft's own example of a share id.
  assert.equal(
    graphShareId('https://onedrive.live.com/redir?resid=1231244193912!12&authKey=1201919!12921!1'),
    'u!aHR0cHM6Ly9vbmVkcml2ZS5saXZlLmNvbS9yZWRpcj9yZXNpZD0xMjMxMjQ0MTkzOTEyITEyJmF1dGhLZXk9MTIwMTkxOSExMjkyMSEx'
  );
});

test('rows: the header row names unique columns; empty rows and leading blank lines are skipped', () => {
  const grid = [
    ['', ''],
    ['Laporan penjualan', ''],
    ['Produk', 'Ton', 'Ton', ''],
    ['Split', 12.5, 3],
    [null, '', ''],
    ['Abu', '7', 1, 'catatan'],
  ];
  const rows = rowsFromGrid(grid, 2);
  assert.deepEqual(rows, [
    { Produk: 'Split', Ton: 12.5, 'Ton (2)': 3, 'Column 4': null },
    { Produk: 'Abu', Ton: '7', 'Ton (2)': 1, 'Column 4': 'catatan' },
  ]);
  assert.deepEqual(
    sheetColumns(rows).map((c) => [c.name, c.type]),
    [
      ['Produk', 'text'],
      ['Ton', 'decimal'],
      ['Ton (2)', 'integer'],
      ['Column 4', 'text'],
    ]
  );
});

test('Excel dates: serial days under a date format become ISO dates; other numbers stay', () => {
  assert.equal(excelSerialToIso(45953), '2025-10-23');
  assert.equal(excelSerialToIso(45953.5), '2025-10-23T12:00:00');
  for (const f of ['m/d/yyyy', 'dd-mm-yy', 'yyyy-mm-dd hh:mm', '[$-421]dd mmmm yyyy']) assert.equal(isDateFormat(f), true, f);
  for (const f of ['General', '0.00', '#,##0', '"Rp"#,##0', '0%']) assert.equal(isDateFormat(f), false, f);
  assert.deepEqual(
    excelGrid(
      [
        ['Tanggal', 'Nilai'],
        [45953, 45953],
      ],
      [
        ['General', 'General'],
        ['dd/mm/yyyy', '#,##0'],
      ]
    ),
    [
      ['Tanggal', 'Nilai'],
      ['2025-10-23', 45953],
    ]
  );
});

// A fake network: answers by URL prefix, records every request.
function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async request(url, options = {}) {
      calls.push({ url, ...options });
      const hit = Object.keys(routes).find((p) => url.startsWith(p));
      if (!hit) throw new Error(`unexpected ${url}`);
      const r = typeof routes[hit] === 'function' ? routes[hit](url, options) : routes[hit];
      const body = Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      return {
        status: r.status ?? 200,
        headers: { 'content-type': r.type ?? 'application/json' },
        body,
        url,
        text: () => body.toString('utf8'),
        json: () => JSON.parse(body.toString('utf8')),
      };
    },
  };
}
const ctxOf = (http, config, secret = {}) => ({
  http,
  privateHosts: [],
  config,
  secret,
  saveSecret: async () => {},
  saveConfig: async () => {},
  beat: async () => {},
});

test('Google, link: the tab in the address as CSV; a private sheet says so', async () => {
  const http = fakeHttp({
    'https://docs.google.com/spreadsheets/d/': { type: 'text/csv', body: 'Kode,Produk,Harga\nBS12,Batu split,285000\nAB,Abu batu,120000\n' },
  });
  const ctx = ctxOf(http, { provider: 'google', google_auth: 'link' });
  const source = parseSheetSource({ mode: 'sheet', url: GOOGLE }, 'google');
  const out = await describeSheet(ctx, source);
  assert.match(http.calls[0].url, /\/export\?format=csv&gid=42$/);
  assert.equal(out.count, 2);
  assert.equal(out.key, 'Kode');
  assert.deepEqual(out.sample[0], { Kode: 'BS12', Produk: 'Batu split', Harga: '285000' });
  // A named tab goes through the query endpoint.
  await collectSheet(ctx, { ...source, sheet: 'Stok gudang', range: 'A1:C9' });
  assert.match(http.calls[1].url, /gviz\/tq\?tqx=out%3Acsv&headers=0&sheet=Stok\+gudang&range=A1%3AC9/);
  const signIn = fakeHttp({ 'https://docs.google.com/': { type: 'text/html; charset=utf-8', body: '<html>Sign in</html>' } });
  await assert.rejects(collectSheet(ctxOf(signIn, { provider: 'google', google_auth: 'link' }), source), (e) => e.code === 'sheetNotShared');
  // Same rows, same hash: an unchanged sheet is not written again.
  const a = await collectSheet(ctx, source);
  const b = await collectSheet(ctx, source);
  assert.equal(a.hash, b.hash);
});

test('Google, service account: a signed JWT for read-only Sheets, then the values of the tab', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'etna@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const jwt = googleAssertion(sa, 1_800_000_000);
  const [h, p, sig] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, sig, 'base64url'));

  const http = fakeHttp({
    'https://oauth2.googleapis.com/token': (_u, o) => {
      assert.match(String(o.body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
      return { body: { access_token: 'ya29.token' } };
    },
    'https://sheets.googleapis.com/v4/spreadsheets/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789?': {
      body: { sheets: [{ properties: { title: 'Ringkasan', sheetId: 0 } }, { properties: { title: "Penjualan '26", sheetId: 42 } }] },
    },
    'https://sheets.googleapis.com/v4/spreadsheets/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/values/': {
      body: { values: [['Tanggal', 'Ton'], ['23/10/2026', 12.5], ['24/10/2026', 8]] },
    },
  });
  const ctx = ctxOf(http, { provider: 'google', google_auth: 'service_account' }, { service_account_json: JSON.stringify(sa) });
  const out = await describeSheet(ctx, parseSheetSource({ mode: 'sheet', url: GOOGLE }, 'google'));
  // The tab in the address (gid 42), its quote doubled in the A1 name.
  assert.match(http.calls[2].url, /\/values\/'Penjualan%20''26'\?valueRenderOption=UNFORMATTED_VALUE/);
  assert.equal(http.calls[2].headers.Authorization, 'Bearer ya29.token');
  assert.deepEqual(out.sheets, ['Ringkasan', "Penjualan '26"]);
  assert.deepEqual(out.sample, [{ Tanggal: '23/10/2026', Ton: 12.5 }, { Tanggal: '24/10/2026', Ton: 8 }]);
  await assert.rejects(
    collectSheet(ctx, parseSheetSource({ mode: 'sheet', url: GOOGLE, sheet: 'Tidak ada' }, 'google')),
    (e) => e.code === 'sheetNotFound'
  );
  const info = await sheets.test(ctx);
  assert.deepEqual(info, { provider: 'google', account: sa.client_email });
});

test('Microsoft: client credentials, the workbook from its sharing link, values with date formats', async () => {
  const http = fakeHttp({
    'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token': (_u, o) => {
      assert.match(String(o.body), /grant_type=client_credentials/);
      assert.match(String(o.body), /scope=https%3A%2F%2Fgraph.microsoft.com%2F.default/);
      return { body: { access_token: 'graph-token' } };
    },
    'https://graph.microsoft.com/v1.0/shares/': { body: { id: 'ITEM1', name: 'Stok.xlsx', parentReference: { driveId: 'b!drive' } } },
    'https://graph.microsoft.com/v1.0/drives/b!drive/items/ITEM1/workbook/worksheets?': { body: { value: [{ name: 'Gudang' }, { name: 'Harga' }] } },
    "https://graph.microsoft.com/v1.0/drives/b!drive/items/ITEM1/workbook/worksheets('Gudang')/usedRange": {
      body: {
        values: [['SKU', 'Masuk', 'Qty'], ['BS12', 45953, 30], ['AB', 45954, 12]],
        numberFormat: [['General', 'General', 'General'], ['General', 'd/m/yyyy', '0'], ['General', 'd/m/yyyy', '0']],
      },
    },
  });
  const ctx = ctxOf(http, { provider: 'microsoft', tenant_id: 'contoso.onmicrosoft.com', client_id: 'app' }, { client_secret: 's3cret' });
  const out = await describeSheet(ctx, parseSheetSource({ mode: 'sheet', url: MS }, 'microsoft'));
  assert.ok(http.calls[1].url.includes(`/shares/${graphShareId(MS)}/driveItem`));
  assert.deepEqual(out.sample, [
    { SKU: 'BS12', Masuk: '2025-10-23', Qty: 30 },
    { SKU: 'AB', Masuk: '2025-10-24', Qty: 12 },
  ]);
  assert.equal(out.key, 'SKU');
  assert.deepEqual(out.sheets, ['Gudang', 'Harga']);
  const notBook = fakeHttp({
    'https://login.microsoftonline.com/': { body: { access_token: 't' } },
    'https://graph.microsoft.com/v1.0/shares/': { body: { id: 'X', name: 'notes.docx', parentReference: { driveId: 'd' } } },
  });
  await assert.rejects(
    collectSheet(ctxOf(notBook, ctx.config, ctx.secret), parseSheetSource({ mode: 'sheet', url: MS }, 'microsoft')),
    (e) => e.code === 'notAWorkbook'
  );
  const bad = fakeHttp({ 'https://login.microsoftonline.com/': { status: 401, body: { error: 'invalid_client' } } });
  await assert.rejects(sheets.test(ctxOf(bad, ctx.config, ctx.secret)), (e) => e.code === 'authFailed');
});
