// Spreadsheets online as a Terminal connection (20261012000063): one tab of a
// Google Sheet, or of an Excel workbook in OneDrive / SharePoint, read as rows
// (src/lib/terminal/sheetSource.ts).
//
// Google: a sheet anyone with the link may view is read as CSV (no sign-in);
// a private sheet is shared with a service account and read with the Sheets
// API (a JWT signed with its key, read-only scope).
// Microsoft: an app registration with Files.Read.All (application), signed in
// with client credentials; the workbook is found from its sharing link
// (Graph /shares) and read with the workbook API (values and number formats,
// so date cells become dates).
// Every request goes through the network guard; a whole read is hashed, and
// when nothing changed since the last run the dataset is left as it is.

import { createHash, createSign } from 'node:crypto';
import {
  MAX_SHEET_CELLS,
  MAX_SHEET_ROWS,
  excelGrid,
  googleGid,
  googleSheetId,
  graphShareId,
  parseSheetSource,
  rowsFromGrid,
  sheetColumns,
  type SheetProvider,
  type SheetSource,
} from '@/lib/terminal/sheetSource';
import { parseCsv } from '@/lib/terminal/tabular';
import { TerminalError } from '@/server/terminal/session';
import { failure, type Adapter, type ConnectorContext, type Row } from './types';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SHEET_BYTES = 50 * 1024 * 1024;

const providerOf = (ctx: ConnectorContext): SheetProvider =>
  ctx.config.provider === 'microsoft' ? 'microsoft' : 'google';

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

// ─── Google ──────────────────────────────────────────────────────────────────

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function serviceAccount(ctx: ConnectorContext): ServiceAccount {
  let key: any;
  try {
    key = JSON.parse(String(ctx.secret.service_account_json ?? ''));
  } catch {
    throw new TerminalError('fieldInvalid', { field: 'service_account_json' });
  }
  if (typeof key?.client_email !== 'string' || typeof key?.private_key !== 'string')
    throw new TerminalError('fieldInvalid', { field: 'service_account_json' });
  return key;
}

/** A Google access token for the service account (read-only Sheets), from a signed JWT. */
export function googleAssertion(sa: ServiceAccount, now = Math.floor(Date.now() / 1000)): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: SHEETS_SCOPE,
    aud: GOOGLE_TOKEN,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  return `${unsigned}.${signature}`;
}

async function googleToken(ctx: ConnectorContext): Promise<string> {
  const sa = serviceAccount(ctx);
  let assertion: string;
  try {
    assertion = googleAssertion(sa);
  } catch {
    throw new TerminalError('fieldInvalid', { field: 'service_account_json' });
  }
  const res = await ctx.http.request(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (res.status === 400 || res.status === 401) throw new TerminalError('authFailed');
  if (res.status !== 200) throw failure(res);
  const token = res.json<{ access_token?: string }>().access_token;
  if (!token) throw new TerminalError('authFailed');
  return token;
}

/** A sheet anyone with the link may view, as CSV: the tab in the link, a named tab, or the first. */
async function googleLinkGrid(ctx: ConnectorContext, source: SheetSource): Promise<unknown[][]> {
  const id = googleSheetId(source.url)!;
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}`;
  const gid = googleGid(source.url);
  const url = source.sheet
    ? `${base}/gviz/tq?${form({ tqx: 'out:csv', headers: '0', sheet: source.sheet, ...(source.range ? { range: source.range } : {}) })}`
    : `${base}/export?${form({ format: 'csv', ...(gid ? { gid } : {}), ...(source.range ? { range: source.range } : {}) })}`;
  const res = await ctx.http.request(url, {
    headers: { Accept: 'text/csv' },
    maxBytes: SHEET_BYTES,
  });
  // A private sheet sends its sign-in page instead.
  const type = String(res.headers['content-type'] ?? '');
  if (res.status === 401 || res.status === 403 || (res.status === 200 && /text\/html/.test(type)))
    throw new TerminalError('sheetNotShared');
  if (res.status !== 200) throw failure(res);
  return parseCsv(res.text(), ',');
}

async function googleApiGrid(ctx: ConnectorContext, source: SheetSource) {
  const token = await googleToken(ctx);
  const id = encodeURIComponent(googleSheetId(source.url)!);
  const headers = { Authorization: `Bearer ${token}` };
  const meta = await ctx.http.request(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties(title,sheetId)`,
    { headers }
  );
  if (meta.status === 403 || meta.status === 404) throw new TerminalError('sheetNotShared');
  if (meta.status !== 200) throw failure(meta);
  const tabs = (meta.json<any>().sheets ?? []).map((s: any) => ({
    title: String(s.properties?.title ?? ''),
    id: String(s.properties?.sheetId ?? ''),
  }));
  const gid = googleGid(source.url);
  const tab =
    source.sheet ?? tabs.find((t: { id: string }) => t.id === gid)?.title ?? tabs[0]?.title;
  if (!tab) throw new TerminalError('sheetNotFound');
  if (source.sheet && !tabs.some((t: { title: string }) => t.title === source.sheet))
    throw new TerminalError('sheetNotFound');
  // 'Tab name'!A1:H500, with quotes doubled inside the name.
  const a1 = `'${tab.replace(/'/g, "''")}'${source.range ? `!${source.range}` : ''}`;
  const res = await ctx.http.request(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(a1)}?${form({ valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING', majorDimension: 'ROWS' })}`,
    { headers, maxBytes: SHEET_BYTES }
  );
  if (res.status !== 200) throw failure(res);
  return {
    grid: (res.json<any>().values ?? []) as unknown[][],
    sheets: tabs.map((t: { title: string }) => t.title),
  };
}

// ─── Microsoft ───────────────────────────────────────────────────────────────

async function graphToken(ctx: ConnectorContext): Promise<string> {
  const tenant = String(ctx.config.tenant_id ?? '').trim();
  if (!/^[A-Za-z0-9.-]{1,100}$/.test(tenant))
    throw new TerminalError('fieldInvalid', { field: 'tenant_id' });
  const res = await ctx.http.request(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'client_credentials',
        client_id: String(ctx.config.client_id ?? ''),
        client_secret: String(ctx.secret.client_secret ?? ''),
        scope: 'https://graph.microsoft.com/.default',
      }),
    }
  );
  if (res.status === 400 || res.status === 401) throw new TerminalError('authFailed');
  if (res.status !== 200) throw failure(res);
  const token = res.json<{ access_token?: string }>().access_token;
  if (!token) throw new TerminalError('authFailed');
  return token;
}

async function graphGrid(ctx: ConnectorContext, source: SheetSource) {
  const token = await graphToken(ctx);
  const headers = { Authorization: `Bearer ${token}` };
  const item = await ctx.http.request(
    `${GRAPH}/shares/${graphShareId(source.url)}/driveItem?$select=id,name,parentReference`,
    { headers }
  );
  if (item.status === 403 || item.status === 404) throw new TerminalError('sheetNotShared');
  if (item.status !== 200) throw failure(item);
  const it = item.json<any>();
  if (!/\.xls[xmb]?$/i.test(String(it.name ?? ''))) throw new TerminalError('notAWorkbook');
  const book = `${GRAPH}/drives/${encodeURIComponent(it.parentReference?.driveId ?? '')}/items/${encodeURIComponent(it.id)}/workbook`;
  const list = await ctx.http.request(`${book}/worksheets?$select=name`, { headers });
  if (list.status !== 200) throw failure(list);
  const sheets: string[] = (list.json<any>().value ?? []).map((w: any) => String(w.name));
  const tab = source.sheet ?? sheets[0];
  if (!tab || !sheets.includes(tab)) throw new TerminalError('sheetNotFound');
  const ws = `${book}/worksheets('${encodeURIComponent(tab.replace(/'/g, "''"))}')`;
  const res = await ctx.http.request(
    source.range
      ? `${ws}/range(address='${encodeURIComponent(source.range)}')?$select=values,numberFormat`
      : `${ws}/usedRange(valuesOnly=true)?$select=values,numberFormat`,
    { headers, maxBytes: SHEET_BYTES, timeoutMs: 120_000 }
  );
  if (res.status !== 200) throw failure(res);
  const body = res.json<any>();
  return { grid: excelGrid(body.values ?? [], body.numberFormat ?? null), sheets };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** The sheet's rows, the tabs it has (when the provider lists them), and a hash of everything. */
export async function collectSheet(ctx: ConnectorContext, source: SheetSource) {
  const provider = providerOf(ctx);
  if (!parseSheetSource(source, provider)) throw new TerminalError('invalid');
  const { grid, sheets } =
    provider === 'microsoft'
      ? await graphGrid(ctx, source)
      : ctx.config.google_auth === 'service_account'
        ? await googleApiGrid(ctx, source)
        : { grid: await googleLinkGrid(ctx, source), sheets: null as string[] | null };
  if (grid.length > MAX_SHEET_ROWS + 50)
    throw new TerminalError('sheetTooLarge', { max: MAX_SHEET_ROWS });
  const cells = grid.reduce((n, r) => n + (r?.length ?? 0), 0);
  if (cells > MAX_SHEET_CELLS) throw new TerminalError('sheetTooLarge', { max: MAX_SHEET_ROWS });
  const rows = rowsFromGrid(grid, source.header_row) as Row[];
  const hash = createHash('sha256');
  for (const r of rows) hash.update(`${JSON.stringify(r)}\n`);
  return { rows, sheets, hash: hash.digest('hex') };
}

/** The columns, a few rows to look at, how many rows, the tabs, and a likely key. */
export async function describeSheet(ctx: ConnectorContext, source: SheetSource) {
  const { rows, sheets } = await collectSheet(ctx, source);
  const columns = sheetColumns(rows as any);
  const sample = rows
    .slice(0, 5)
    .map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : v])
      )
    );
  const key =
    columns.find((c) => /^(id|kode|code|sku|no|nomor|invoice|no\.? ?invoice)$/i.test(c.name))
      ?.name ?? null;
  return { columns, sample, count: rows.length, key, sheets };
}

export const sheets: Adapter = {
  // Signs in (a service account or an app registration); a link needs nothing.
  async test(ctx) {
    const provider = providerOf(ctx);
    if (provider === 'microsoft') {
      await graphToken(ctx);
      return { provider };
    }
    if (ctx.config.google_auth === 'service_account') {
      await googleToken(ctx);
      return { provider, account: serviceAccount(ctx).client_email };
    }
    return { provider, access: 'link' };
  },
  // eslint-disable-next-line require-yield
  async *read() {
    // A spreadsheet is read by source (collectSheet), not by ERP list.
    throw new TerminalError('invalid');
  },
};
