// Terminal spreadsheet sources (20261012000063): one tab (and optionally a
// range) of a Google Sheet or of an Excel workbook in OneDrive / SharePoint,
// read as rows under a header row. Pure functions, shared by the screens, the
// app and the worker; no network (src/server/connectors/sheets.ts reads).

import { columnsFromSample, type RestColumn } from './restSource';
import { columnNames, inferType as inferText, type ColumnType } from './tabular';

export type SheetProvider = 'google' | 'microsoft';
export const SHEET_PROVIDERS: readonly SheetProvider[] = ['google', 'microsoft'];
/** Google: a sheet anyone with the link may view, or one shared with a service account. */
export const GOOGLE_AUTH = ['link', 'service_account'] as const;

export interface SheetSource {
  mode: 'sheet';
  /** The sheet's or workbook's address (as copied from the browser or "Share"). */
  url: string;
  /** The tab; empty: the first one (or, for a Google link, the tab in the address). */
  sheet: string | null;
  /** A1 range such as A1:H500; empty: everything used. */
  range: string | null;
  /** The row with the column names (1 = the first row of the range). */
  header_row: number;
  /** A column that identifies a row (updated in place); empty: replaced each run. */
  key: string | null;
}

/** Most rows and cells read from one sheet. */
export const MAX_SHEET_ROWS = 100_000;
export const MAX_SHEET_CELLS = 2_000_000;

const RANGE_RE = /^\$?[A-Za-z]{1,3}\$?\d{0,7}(:\$?[A-Za-z]{1,3}\$?\d{0,7})?$/;
const opt = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : v == null || v === '' ? null : (v as any);

/** The id of a Google Sheet in its address (…/spreadsheets/d/<id>/…), or a bare id. */
export function googleSheetId(url: string): string | null {
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(url);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{25,}$/.test(url) ? url : null;
}

/** The tab id ("gid") in a Google Sheet's address, when the link points at one. */
export function googleGid(url: string): string | null {
  const m = /[#&?]gid=(\d{1,12})/.exec(url);
  return m ? m[1] : null;
}

/** An https address on Microsoft's file hosts (a sharing link or the file's address). */
export function isMicrosoftFileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      /(^|\.)(sharepoint\.com|onedrive\.live\.com|1drv\.ms|sharepoint\.us)$/i.test(u.hostname)
    );
  } catch {
    return false;
  }
}

/** A sharing URL as Microsoft Graph's share id: "u!" + base64url, unpadded. */
export function graphShareId(url: string): string {
  const b64 =
    typeof Buffer !== 'undefined' ? Buffer.from(url, 'utf8').toString('base64') : btoa(url);
  return `u!${b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
}

export function parseSheetSource(v: any, provider?: SheetProvider): SheetSource | null {
  if (!v || typeof v !== 'object' || v.mode !== 'sheet') return null;
  const url = typeof v.url === 'string' ? v.url.trim() : '';
  if (!url || url.length > 2000) return null;
  if (provider === 'google' && !googleSheetId(url)) return null;
  if (provider === 'microsoft' && !isMicrosoftFileUrl(url)) return null;
  if (!provider && !googleSheetId(url) && !isMicrosoftFileUrl(url)) return null;
  const sheet = opt(v.sheet);
  if (sheet !== null && (typeof sheet !== 'string' || sheet.length > 100 || /[\0\r\n]/.test(sheet)))
    return null;
  const range = opt(v.range);
  if (range !== null && (typeof range !== 'string' || !RANGE_RE.test(range))) return null;
  const header = v.header_row == null ? 1 : Number(v.header_row);
  if (!Number.isInteger(header) || header < 1 || header > 50) return null;
  const key = opt(v.key);
  if (key !== null && (typeof key !== 'string' || key.length > 60)) return null;
  return {
    mode: 'sheet',
    url,
    sheet: sheet as string | null,
    range: range ? (range as string).toUpperCase() : null,
    header_row: header,
    key: key as string | null,
  };
}

export function sheetSourceLabel(s: SheetSource): string {
  return [s.sheet ?? 'Sheet', s.range].filter(Boolean).join(' · ').slice(0, 200);
}

type Cell = string | number | boolean | null;

/**
 * Rows of a sheet: the header row names the columns (trimmed, unique, never
 * empty), rows above it are skipped, empty rows are left out, and cells keep
 * their type (numbers stay numbers).
 */
export function rowsFromGrid(grid: unknown[][], headerRow = 1): Record<string, Cell>[] {
  // Leading rows with nothing in them (an export's empty label line) do not count.
  let start = 0;
  while (start < grid.length && (grid[start] ?? []).every(blank)) start += 1;
  const body = grid.slice(start + headerRow - 1);
  if (!body.length) return [];
  const width = Math.max(...body.slice(0, 1000).map((r) => r?.length ?? 0), 0);
  const names = columnNames(body[0] ?? [], width).map((n) => n.slice(0, 60));
  const rows: Record<string, Cell>[] = [];
  for (const r of body.slice(1)) {
    if (!r || r.every(blank)) continue;
    rows.push(Object.fromEntries(names.map((n, i) => [n, cell(r[i])])));
  }
  return rows;
}

function blank(v: unknown) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function cell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  const s = String(v);
  return s.trim() === '' ? null : s;
}

/** An Excel serial day (1900 date system) as YYYY-MM-DD, or YYYY-MM-DDTHH:MM:SS with a time. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const ms = Math.round((serial - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19);
}

/** Whether an Excel number format shows a date or time (d, m with y, or yyyy; not "0.00" or "General"). */
export function isDateFormat(format: unknown): boolean {
  if (typeof format !== 'string') return false;
  // Text in quotes and [colour]/[$-locale] parts are not format codes.
  const f = format.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /(^|[^a-z])(d{1,4}|y{2,4})([^a-z]|$)/i.test(f) || /m{1,4}[^a-z]*y|y[^a-z]*m{1,4}/i.test(f);
}

/** Excel values with their number formats: date cells become ISO dates. */
export function excelGrid(values: unknown[][], formats: unknown[][] | null): unknown[][] {
  if (!formats) return values;
  return values.map((row, i) =>
    row.map((v, j) => {
      if (typeof v !== 'number' || !isDateFormat(formats[i]?.[j])) return v;
      return excelSerialToIso(v) ?? v;
    })
  );
}

/**
 * Column types from the rows. Numbers and text that reads as numbers or
 * dates are read together (a sheet often mixes 12.5 and "7" in one column).
 */
export function sheetColumns(rows: Record<string, Cell>[]): RestColumn[] {
  return columnsFromSample(rows).map((c) => {
    if (c.type !== 'text' && c.type !== 'integer' && c.type !== 'decimal') return c;
    const values = rows.slice(0, 200).map((r) => r[c.name]);
    if (!values.every((v) => v === null || typeof v === 'string' || typeof v === 'number'))
      return { ...c, type: 'text' };
    const type: ColumnType = inferText(
      values.map((v) => (typeof v === 'number' ? String(v) : v)),
      '.'
    );
    return { ...c, type };
  });
}
