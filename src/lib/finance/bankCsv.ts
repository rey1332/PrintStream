// Bank statement CSV files as statement lines (date, text, reference,
// amount: + money in, − money out, and the running balance when the file
// has one), for erp_bank_statement_import (db/migrations/20261012000054).
//
// Any CSV works: the header row is found by its column names, and the
// columns can be chosen by hand. The presets know how BCA, Mandiri, BRI and
// BNI name their columns and write dates and amounts in their internet and
// business banking exports; they only pick the defaults. Indonesian number
// formats ("1.500.000,00") and English ones ("1,500,000.00") are both read,
// as are "DB" / "CR" (or "D" / "K") markers next to or after an amount.
// Nothing here talks to a bank.

export type BankFormat = 'bca' | 'mandiri' | 'bri' | 'bni' | 'custom';
export const BANK_FORMATS: readonly BankFormat[] = ['bca', 'mandiri', 'bri', 'bni', 'custom'];

/** Column indexes; description may join several columns (Mandiri has two). */
export interface ColumnMap {
  date: number;
  description: number[];
  reference: number | null;
  /** One signed amount (with an optional D/K column), or debit and credit columns. */
  amount: number | null;
  dc: number | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
}

export type DateOrder = 'dmy' | 'mdy' | 'ymd';

export interface ParseOptions {
  format?: BankFormat | 'auto';
  map?: ColumnMap;
  /** 0-based row with the column names; -1 for a file without one. Found by default. */
  headerRow?: number;
  dateOrder?: DateOrder;
  /** For dates without a year (BCA's "01/10"); else taken from the file's period. */
  year?: number;
}

export interface StatementLine {
  /** YYYY-MM-DD */
  date: string;
  description: string;
  reference: string;
  amount: number;
  balance: number | null;
  /** 1-based row of the file. */
  row: number;
}

export type RowProblem = { row: number; kind: 'date' | 'amount' | 'pending' };

export interface ParseResult {
  format: BankFormat;
  headerRow: number;
  headers: string[];
  rows: string[][];
  map: ColumnMap | null;
  dateOrder: DateOrder;
  lines: StatementLine[];
  problems: RowProblem[];
  opening: number | null;
  closing: number | null;
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

/** The file's delimiter: the one that splits the first lines most consistently. */
export function detectDelimiter(text: string): string {
  const sample = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 30);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = sample.map((l) => splitLine(l, d).length).filter((n) => n > 1);
    if (!counts.length) continue;
    const mode = [...counts].sort(
      (a, b) => counts.filter((x) => x === b).length - counts.filter((x) => x === a).length
    )[0];
    const score = counts.filter((n) => n === mode).length * mode;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function splitLine(line: string, delimiter: string): string[] {
  return parseCsv(line, delimiter)[0] ?? [];
}

/** RFC 4180: quoted fields, "" for a quote, line breaks inside quotes. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  // A byte order mark at the start is not part of the first cell.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

// ─── Numbers and dates ───────────────────────────────────────────────────────

const DEBIT_MARK = /^(DB|D|DR|DEBIT|DEBET)$/i;
const CREDIT_MARK = /^(CR|C|K|KR|CREDIT|KREDIT)$/i;

/**
 * An amount in either convention: "1.500.000,00", "1,500,000.00", "1500000",
 * "(2.000)", "-2,000.00", "2.000-", "Rp 1.000", "1,500.00 DB" (negative) or
 * "1,500.00 CR". Null when it is not a number.
 */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/^'/, '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let sign = 1;
  const mark = s.match(/\s*\b(DB|DR|CR|D|K|C)\.?$/i);
  if (mark && /\d/.test(s.slice(0, mark.index))) {
    if (DEBIT_MARK.test(mark[1])) sign = -1;
    s = s.slice(0, mark.index).trim();
  }
  s = s.replace(/^(Rp\.?|IDR)\s*/i, '').trim();
  if (/^\(.*\)$/.test(s)) {
    sign *= -1;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    sign *= -1;
    s = s.slice(1).trim();
  } else if (s.endsWith('-')) {
    sign *= -1;
    s = s.slice(0, -1).trim();
  } else if (s.startsWith('+')) s = s.slice(1).trim();
  s = s.replace(/[\s']/g, '');
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimal: '.' | ',' | null = null;
  if (lastDot >= 0 && lastComma >= 0) decimal = lastDot > lastComma ? '.' : ',';
  else {
    const sep = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : null;
    if (sep) {
      const parts = s.split(sep);
      // One separator with one or two digits after it is a decimal point;
      // otherwise (1.500.000, 1,500) it groups thousands.
      if (parts.length === 2 && parts[1].length >= 1 && parts[1].length <= 2) decimal = sep;
    }
  }
  const thousands = decimal === '.' ? ',' : decimal === ',' ? '.' : null;
  let normal = s;
  if (thousands) normal = normal.split(thousands).join('');
  else normal = normal.replace(/[.,]/g, '');
  if (decimal) normal = normal.replace(decimal, '.');
  if (normal.startsWith('.')) normal = `0${normal}`;
  if (!/^\d+(\.\d+)?$/.test(normal)) return null;
  const value = Math.round(Number(normal) * 100) / 100;
  return Number.isFinite(value) ? sign * value : null;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  januari: 1,
  january: 1,
  feb: 2,
  februari: 2,
  february: 2,
  peb: 2,
  mar: 3,
  maret: 3,
  march: 3,
  apr: 4,
  april: 4,
  mei: 5,
  may: 5,
  jun: 6,
  juni: 6,
  june: 6,
  jul: 7,
  juli: 7,
  july: 7,
  agu: 8,
  agt: 8,
  ags: 8,
  agustus: 8,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  okt: 10,
  oktober: 10,
  oct: 10,
  october: 10,
  nov: 11,
  nop: 11,
  november: 11,
  nopember: 11,
  des: 12,
  desember: 12,
  dec: 12,
  december: 12,
};

const iso = (y: number, m: number, d: number): string | null => {
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/**
 * A date as YYYY-MM-DD: "31/10/2026", "31-10-26", "2026-10-31", "31 Okt 2026",
 * "31-OCT-26", "31/10" (with `year`), with or without a time after it.
 */
export function parseDate(raw: string, order: DateOrder = 'dmy', year?: number): string | null {
  const s = raw
    .replace(/^'/, '')
    .trim()
    .replace(/[T\s]+\d{1,2}[:.]\d{2}([:.]\d{2})?(\s*(AM|PM|WIB))?$/i, '')
    .trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.\s]+([A-Za-z]{3,9})\.?[-/.\s]+(\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    return month ? iso(+m[3], month, +m[1]) : null;
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    if (order === 'mdy') return iso(+m[3], +m[1], +m[2]);
    if (order === 'ymd') return null;
    return iso(+m[3], +m[2], +m[1]);
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (m && year) return order === 'mdy' ? iso(year, +m[1], +m[2]) : iso(year, +m[2], +m[1]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  return null;
}

// ─── Columns ─────────────────────────────────────────────────────────────────

type Role = 'date' | 'description' | 'reference' | 'amount' | 'dc' | 'debit' | 'credit' | 'balance';

const norm = (h: string) => h.toLowerCase().replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Column names by role (normalized: lower case, "_" and "." as spaces). */
const ALIASES: Record<Role, string[]> = {
  date: [
    'tanggal transaksi',
    'tanggal',
    'tgl',
    'tgl tran',
    'tgl transaksi',
    'date',
    'post date',
    'posting date',
    'transaction date',
    'trans date',
    'tanggal posting',
  ],
  description: [
    'keterangan',
    'uraian transaksi',
    'uraian',
    'desk tran',
    'description',
    'deskripsi',
    'remark',
    'remarks',
    'transaction description',
    'keterangan transaksi',
    'narasi',
    'detail',
    'berita',
  ],
  reference: [
    'reference no',
    'reference',
    'no referensi',
    'referensi',
    'ref',
    'ref no',
    'journal no',
    'no jurnal',
    'nomor referensi',
    'cheque no',
    'no cek',
  ],
  amount: ['jumlah', 'nominal', 'amount', 'mutasi', 'nilai'],
  dc: ['tipe', 'type', 'd/k', 'db/cr', 'dk', 'dc', 'jenis', 'd/c', 'cr/db'],
  debit: ['debet', 'debit', 'mutasi debet', 'withdrawal', 'withdrawals', 'keluar', 'pengeluaran'],
  credit: ['kredit', 'credit', 'mutasi kredit', 'deposit', 'deposits', 'masuk', 'pemasukan'],
  balance: [
    'saldo',
    'balance',
    'saldo akhir',
    'saldo akhir mutasi',
    'running balance',
    'ending balance',
  ],
};

const roleOf = (header: string): Role | null => {
  const h = norm(header);
  if (!h) return null;
  for (const role of Object.keys(ALIASES) as Role[]) if (ALIASES[role].includes(h)) return role;
  return null;
};

/** Columns found from the header row's names. */
export function mapColumns(headers: string[], rows: string[][] = []): ColumnMap | null {
  const found: Partial<Record<Role, number[]>> = {};
  headers.forEach((h, i) => {
    const role = roleOf(h);
    if (role) (found[role] ??= []).push(i);
  });
  if (found.date === undefined || (!found.amount && !found.debit && !found.credit)) return null;
  const amount = found.amount?.[0] ?? null;
  let dc = found.dc?.[0] ?? null;
  // BCA: the DB / CR marker sits in the unnamed column after "Jumlah".
  if (amount !== null && dc === null && (headers[amount + 1] ?? '') === '') {
    const marks = rows.map((r) => r[amount + 1] ?? '').filter(Boolean);
    if (marks.length && marks.every((v) => DEBIT_MARK.test(v) || CREDIT_MARK.test(v)))
      dc = amount + 1;
  }
  return {
    date: found.date[0],
    description: found.description ?? [],
    reference: found.reference?.[0] ?? null,
    amount: found.debit || found.credit ? null : amount,
    dc: found.debit || found.credit ? null : dc,
    debit: found.debit?.[0] ?? null,
    credit: found.credit?.[0] ?? null,
    balance: found.balance?.at(-1) ?? null,
  };
}

/** The first row that names a date column and an amount (or debit / credit) column. */
export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const roles = new Set(rows[i].map(roleOf).filter(Boolean));
    if (roles.has('date') && (roles.has('amount') || roles.has('debit') || roles.has('credit')))
      return i;
  }
  return -1;
}

/** The bank, from the lines above the table and the column names. */
export function detectFormat(rows: string[][], headerRow: number): BankFormat {
  const top = rows
    .slice(0, Math.max(headerRow, 0) + 1)
    .map((r) => r.join(' ').toLowerCase())
    .join('\n');
  const headers = (rows[headerRow] ?? []).map(norm);
  if (/kode mata uang|no\.? rekening\s*:/.test(top) && headers.includes('cabang')) return 'bca';
  if (headers.includes('val date') || headers.includes('transaction code') || /mandiri/.test(top))
    return 'mandiri';
  if (
    headers.includes('tgl tran') ||
    headers.includes('desk tran') ||
    headers.includes('teller') ||
    /\bbri\b/.test(top)
  )
    return 'bri';
  if (
    headers.includes('journal no') ||
    (headers.includes('tipe') && headers.includes('nominal')) ||
    /\bbni\b/.test(top)
  )
    return 'bni';
  if (/bca/.test(top) || headers.includes('cabang')) return 'bca';
  return 'custom';
}

/** The statement period from a "Periode : 01/10/2026 - 31/10/2026" line (BCA). */
function periodEnd(rows: string[][], headerRow: number): string | null {
  for (const r of rows.slice(0, Math.max(headerRow, 0))) {
    const text = r.join(' ');
    if (!/periode|period/i.test(text)) continue;
    const dates = text.match(/\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/g);
    if (dates?.length) return parseDate(dates.at(-1)!, 'dmy');
  }
  return null;
}

/** "Saldo Awal : 1,000.00" / "Saldo Akhir : …" lines (BCA's footer, some headers). */
function balanceLine(row: string[], kind: 'opening' | 'closing'): number | null {
  const text = row.join(' ').trim();
  const re =
    kind === 'opening'
      ? /^(saldo awal|opening balance|beginning balance)\b/i
      : /^(saldo akhir|closing balance|ending balance)\b/i;
  if (!re.test(text)) return null;
  const cells = row.slice(1).filter(Boolean);
  const inline = text.replace(re, '').replace(/^[\s:]+/, '');
  for (const candidate of [inline, ...cells]) {
    const v = parseAmount(candidate.replace(/^[\s:]+/, ''));
    if (v !== null) return v;
  }
  return null;
}

// ─── Parse ───────────────────────────────────────────────────────────────────

export function parseStatement(text: string, options: ParseOptions = {}): ParseResult {
  const rows = parseCsv(text);
  const headerRow = options.headerRow ?? findHeaderRow(rows);
  const format: BankFormat =
    options.format && options.format !== 'auto' ? options.format : detectFormat(rows, headerRow);
  const headers = headerRow >= 0 ? rows[headerRow] : [];
  const body = headerRow >= 0 ? rows.slice(headerRow + 1) : rows;
  const map = options.map ?? (headerRow >= 0 ? mapColumns(headers, body) : null);
  const dateOrder = options.dateOrder ?? 'dmy';
  const end = periodEnd(rows, headerRow);
  const year = options.year ?? (end ? Number(end.slice(0, 4)) : undefined);
  const result: ParseResult = {
    format,
    headerRow,
    headers,
    rows,
    map,
    dateOrder,
    lines: [],
    problems: [],
    opening: null,
    closing: null,
  };
  if (!map) return result;

  const cell = (r: string[], i: number | null) => (i === null ? '' : (r[i] ?? ''));
  body.forEach((r, k) => {
    const row = headerRow + 2 + k;
    if (!r.some((c) => c !== '')) return;
    const opening = balanceLine(r, 'opening');
    if (opening !== null) {
      result.opening = opening;
      return;
    }
    const closing = balanceLine(r, 'closing');
    if (closing !== null) {
      result.closing = closing;
      return;
    }
    const rawDate = cell(r, map.date);
    let amount: number | null = null;
    if (map.amount !== null) {
      amount = parseAmount(cell(r, map.amount));
      const mark = cell(r, map.dc);
      if (amount !== null && mark) {
        if (DEBIT_MARK.test(mark)) amount = -Math.abs(amount);
        else if (CREDIT_MARK.test(mark)) amount = Math.abs(amount);
      }
    } else {
      const debit = parseAmount(cell(r, map.debit));
      const credit = parseAmount(cell(r, map.credit));
      if (debit !== null || credit !== null) amount = Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
    }
    // Totals and other text rows below the table: no date and no amount.
    if (!rawDate && amount === null) return;
    if (/^'?pend/i.test(rawDate)) {
      result.problems.push({ row, kind: 'pending' });
      return;
    }
    let date = parseDate(rawDate, dateOrder, year);
    // "31/12" in a statement ending in January belongs to the year before.
    if (date && end && year && !/\d{4}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2}/.test(rawDate) && date > end) {
      date = parseDate(rawDate, dateOrder, year - 1);
    }
    if (!date) {
      // A row with neither a date nor an amount is text (totals, notes): skipped.
      if (amount !== null) result.problems.push({ row, kind: 'date' });
      return;
    }
    if (amount === null) {
      result.problems.push({ row, kind: 'amount' });
      return;
    }
    if (amount === 0) return;
    const description = map.description
      .map((i) => cell(r, i))
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const balance = map.balance === null ? null : parseAmount(cell(r, map.balance));
    result.lines.push({
      date,
      description,
      reference: cell(r, map.reference).replace(/^'/, ''),
      amount: Math.round(amount * 100) / 100,
      balance,
      row,
    });
  });
  return result;
}
