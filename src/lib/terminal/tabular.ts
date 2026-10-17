// Reading uploaded tables (Terminal imports): CSV parsing, detection of the
// delimiter and header, column types, and turning cells into typed values.
// Pure functions, shared by the worker and the tests.

export type ColumnType = 'text' | 'integer' | 'decimal' | 'boolean' | 'date' | 'timestamp' | 'json';
export const COLUMN_TYPES: readonly ColumnType[] = [
  'text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'timestamp',
  'json',
];

export type Delimiter = ',' | ';' | '\t' | '|';
const DELIMITERS: Delimiter[] = [',', ';', '\t', '|'];

/** How numbers are written: 1,234.56 ('.') or 1.234,56 (',', common in Indonesia). */
export type DecimalMark = '.' | ',';

// ─── CSV ─────────────────────────────────────────────────────────────────────

/**
 * A streaming CSV parser (RFC 4180: quotes, doubled quotes, CR/LF/CRLF, line
 * breaks inside quotes). Feed text chunks; complete rows come back.
 */
export class CsvParser {
  private field = '';
  private row: string[] = [];
  // start: at a field's start; plain: in an unquoted field; quoted: inside
  // quotes; quote: just after a quote inside quotes (the next character decides).
  private state: 'start' | 'plain' | 'quoted' | 'quote' = 'start';
  private pendingCr = false;

  private readonly delimiter: Delimiter;
  private readonly maxField: number;

  constructor(delimiter: Delimiter, maxField = 1_000_000) {
    this.delimiter = delimiter;
    this.maxField = maxField;
  }

  push(text: string): string[][] {
    const rows: string[][] = [];
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (this.pendingCr) {
        this.pendingCr = false;
        if (c === '\n') continue;
      }
      if (this.state === 'quoted') {
        if (c === '"') this.state = 'quote';
        else this.field += c;
      } else if (this.state === 'quote' && c === '"') {
        this.field += '"';
        this.state = 'quoted';
      } else if (c === this.delimiter) {
        this.endField();
      } else if (c === '\n' || c === '\r') {
        this.endField();
        rows.push(this.row);
        this.row = [];
        if (c === '\r') this.pendingCr = true;
      } else if (c === '"' && this.state === 'start') {
        this.state = 'quoted';
      } else {
        // Text after a closing quote is kept, as spreadsheets do.
        this.field += c;
        this.state = 'plain';
      }
      if (this.field.length > this.maxField) throw new TabularError('field_too_long');
    }
    return rows;
  }

  private endField() {
    this.row.push(this.field);
    this.field = '';
    this.state = 'start';
  }

  /** The last row, when the file does not end with a line break. */
  end(): string[][] {
    if (this.state === 'quoted') throw new TabularError('unclosed_quote');
    if (this.field !== '' || this.row.length || this.state === 'quote') {
      this.endField();
      const row = this.row;
      this.row = [];
      return [row];
    }
    return [];
  }
}

export class TabularError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(key);
    this.key = key;
  }
}

export function parseCsv(text: string, delimiter: Delimiter): string[][] {
  const p = new CsvParser(delimiter);
  return [...p.push(text), ...p.end()];
}

/** The delimiter that splits the first lines most consistently. */
export function detectDelimiter(sample: string): Delimiter {
  const lines = sample
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim())
    .slice(0, 20);
  let best: Delimiter = ',';
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = parseCsv(lines.join('\n'), d).map((r) => r.length);
    if (!counts.length || counts[0] < 2) continue;
    const same = counts.filter((n) => n === counts[0]).length;
    const score = same * 100 + counts[0];
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Text from bytes: a BOM decides, else UTF-8 if valid, else Windows-1252. */
export function decodeBytes(
  bytes: Uint8Array,
  encoding?: string
): { text: string; encoding: string } {
  if (encoding) return { text: new TextDecoder(encoding).decode(bytes), encoding };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

// ─── Values ──────────────────────────────────────────────────────────────────

const TRUE = new Set(['true', 'yes', 'y', 'ya', '1', 'benar']);
const FALSE = new Set(['false', 'no', 'n', 'tidak', '0', 'salah']);

/** A number written with thousands separators and either decimal mark, or null. */
export function parseNumber(raw: string, mark: DecimalMark): number | null {
  let s = raw
    .trim()
    .replace(/\s/g, '')
    .replace(/^Rp\.?/i, '');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  const thousands = mark === ',' ? '.' : ',';
  if (mark === ',') {
    if (!/^[-+]?\d{1,3}(\.\d{3})*(,\d+)?$|^[-+]?\d+(,\d+)?$/.test(s)) return null;
  } else if (!/^[-+]?\d{1,3}(,\d{3})*(\.\d+)?$|^[-+]?\d+(\.\d+)?$/.test(s)) {
    // Scientific notation as written by spreadsheets.
    if (!/^[-+]?\d+(\.\d+)?e[-+]?\d+$/i.test(s)) return null;
  }
  const n = Number(s.split(thousands).join('').replace(mark, '.'));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** ISO dates, or day-first dd/mm/yyyy and dd-mm-yyyy (as used in Indonesia). */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s)))
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseTimestamp(raw: string): string | null {
  const s = raw.trim();
  const m =
    /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(
      s
    );
  if (!m) return null;
  const date = parseDate(m[1]);
  const [h, mi, se] = [Number(m[2]), Number(m[3]), Number(m[4] ?? 0)];
  if (!date || h > 23 || mi > 59 || se > 59) return null;
  const zone = m[6]
    ? m[6] === 'Z'
      ? 'Z'
      : m[6].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
    : '+07:00';
  return `${date}T${String(h).padStart(2, '0')}:${m[3]}:${String(se).padStart(2, '0')}${zone}`;
}

export type Coerced = { ok: true; value: unknown } | { ok: false; reason: string };

/** A cell as the column's type; empty cells are null. */
export function coerce(raw: unknown, type: ColumnType, mark: DecimalMark): Coerced {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (type === 'integer')
      return Number.isSafeInteger(raw)
        ? { ok: true, value: raw }
        : { ok: false, reason: 'bad_integer' };
    if (type === 'decimal') return { ok: true, value: raw };
    if (type === 'text') return { ok: true, value: String(raw) };
    if (type === 'boolean' && (raw === 0 || raw === 1)) return { ok: true, value: raw === 1 };
  }
  if (typeof raw === 'boolean') {
    if (type === 'boolean') return { ok: true, value: raw };
    if (type === 'text') return { ok: true, value: String(raw) };
  }
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { ok: false, reason: 'bad_date' };
    if (type === 'date') return { ok: true, value: raw.toISOString().slice(0, 10) };
    if (type === 'timestamp') return { ok: true, value: raw.toISOString() };
    if (type === 'text') return { ok: true, value: raw.toISOString() };
  }
  const s = String(raw);
  if (s.trim() === '') return { ok: true, value: null };
  switch (type) {
    case 'text':
      return s.length <= 10_000 ? { ok: true, value: s } : { ok: false, reason: 'too_long' };
    case 'integer': {
      const n = parseNumber(s, mark);
      return n !== null && Number.isSafeInteger(n)
        ? { ok: true, value: n }
        : { ok: false, reason: 'bad_integer' };
    }
    case 'decimal': {
      const n = parseNumber(s, mark);
      return n !== null ? { ok: true, value: n } : { ok: false, reason: 'bad_number' };
    }
    case 'boolean': {
      const v = s.trim().toLowerCase();
      return TRUE.has(v)
        ? { ok: true, value: true }
        : FALSE.has(v)
          ? { ok: true, value: false }
          : { ok: false, reason: 'bad_boolean' };
    }
    case 'date': {
      const d = parseDate(s);
      return d ? { ok: true, value: d } : { ok: false, reason: 'bad_date' };
    }
    case 'timestamp': {
      const t = parseTimestamp(s) ?? (parseDate(s) ? `${parseDate(s)}T00:00:00+07:00` : null);
      return t ? { ok: true, value: t } : { ok: false, reason: 'bad_timestamp' };
    }
    case 'json':
      try {
        return { ok: true, value: JSON.parse(s) };
      } catch {
        return { ok: false, reason: 'bad_json' };
      }
  }
}

/** The narrowest type every non-empty sample fits. */
export function inferType(samples: unknown[], mark: DecimalMark): ColumnType {
  const values = samples.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (!values.length) return 'text';
  // Codes with leading zeros (NIK, NPWP, phone numbers) stay text.
  if (values.some((v) => typeof v === 'string' && /^0\d+$/.test(v.trim()))) return 'text';
  for (const type of ['integer', 'decimal', 'boolean', 'date', 'timestamp'] as ColumnType[]) {
    if (type === 'boolean' && values.every((v) => /^[01]$/.test(String(v).trim()))) continue;
    if (values.every((v) => coerce(v, type, mark).ok)) return type;
  }
  return 'text';
}

/** Which decimal mark the numbers of the sample use. */
export function detectDecimalMark(cells: string[]): DecimalMark {
  let comma = 0;
  let dot = 0;
  for (const c of cells) {
    const s = c.trim();
    if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$|^[-+]?\d+,\d{1,2}$/.test(s)) comma += 1;
    else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$|^[-+]?\d+\.\d+$/.test(s)) dot += 1;
  }
  return comma > dot ? ',' : '.';
}

/** Whether the first row is a header: filled, unique, and no numbers or dates. */
export function looksLikeHeader(rows: unknown[][], mark: DecimalMark): boolean {
  const [first, ...rest] = rows;
  if (!first?.length || !rest.length) return true;
  const cells = first.map((c) => String(c ?? '').trim());
  if (cells.some((c) => !c) || new Set(cells.map((c) => c.toLowerCase())).size !== cells.length)
    return false;
  // A number or date in the first row is data; otherwise it names the columns
  // (files without a header are rare, and the wizard lets the user switch).
  const typed = (v: unknown) => inferType([v], mark) !== 'text';
  return !cells.some(typed);
}

/** Header names: trimmed, never empty, unique. */
export function columnNames(header: unknown[] | null, width: number): string[] {
  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, i) => {
    let name =
      String(header?.[i] ?? '')
        .trim()
        .slice(0, 120) || `Column ${i + 1}`;
    const key = name.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n) name = `${name} (${n + 1})`.slice(0, 120);
    return name;
  });
}

export interface AnalyzedColumn {
  name: string;
  type: ColumnType;
  empty: number;
  samples: string[];
}

/** Columns, types and a sample from the first rows of a table. */
export function analyzeRows(
  rows: unknown[][],
  options: { header?: boolean; mark?: DecimalMark } = {}
) {
  const textCells = rows
    .slice(0, 200)
    .flat()
    .map((c) => (typeof c === 'string' ? c : ''));
  const mark = options.mark ?? detectDecimalMark(textCells);
  const header = options.header ?? looksLikeHeader(rows, mark);
  const body = header ? rows.slice(1) : rows;
  const width = Math.min(Math.max(0, ...rows.slice(0, 200).map((r) => r.length)), 500);
  const names = columnNames(header ? rows[0] : null, width);
  const sample = body.slice(0, 1000);
  const columns: AnalyzedColumn[] = names.map((name, i) => {
    const values = sample.map((r) => r[i]);
    return {
      name,
      type: inferType(values, mark),
      empty: values.filter((v) => v === null || v === undefined || String(v).trim() === '').length,
      samples: values
        .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
        .slice(0, 5)
        .map((v) => String(v).slice(0, 200)),
    };
  });
  return {
    header,
    decimal: mark,
    columns,
    preview: body
      .slice(0, 20)
      .map((r) =>
        names.map((_, i) =>
          r[i] === undefined || r[i] === null ? null : String(r[i]).slice(0, 200)
        )
      ),
  };
}
