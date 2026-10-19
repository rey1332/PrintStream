// SQL text in the Query Tool: the statements of the editor (split at
// semicolons outside quotes, comments and dollar quotes), the one under the
// cursor, and results as tab- or comma-separated text.

export interface Statement {
  from: number;
  to: number;
  text: string;
}

/** The statements of `doc`, each trimmed, with its place in `doc`. */
export function splitStatements(doc: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const raw = doc.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text && !onlyComments(text))
      out.push({ from: start + lead, to: start + lead + text.length, text });
  };
  while (i < doc.length) {
    const c = doc[i];
    const next = doc[i + 1];
    if (c === '-' && next === '-') {
      const nl = doc.indexOf('\n', i);
      i = nl < 0 ? doc.length : nl + 1;
    } else if (c === '/' && next === '*') {
      // Block comments nest in PostgreSQL.
      let depth = 1;
      i += 2;
      while (i < doc.length && depth > 0) {
        if (doc[i] === '/' && doc[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (doc[i] === '*' && doc[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
    } else if (c === "'" || c === '"') {
      i += 1;
      while (i < doc.length) {
        if (doc[i] === c && doc[i + 1] === c) i += 2;
        else if (doc[i] === c) {
          i += 1;
          break;
        } else i += 1;
      }
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(doc.slice(i));
      if (m && !/[A-Za-z0-9_]/.test(doc[i - 1] ?? '')) {
        const end = doc.indexOf(m[0], i + m[0].length);
        i = end < 0 ? doc.length : end + m[0].length;
      } else i += 1;
    } else if (c === ';') {
      push(i);
      start = i + 1;
      i += 1;
    } else i += 1;
  }
  push(doc.length);
  return out;
}

function onlyComments(text: string): boolean {
  return (
    text
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim() === ''
  );
}

/** The statement at `pos` (or the nearest one before it), or null in an empty editor. */
export function statementAt(doc: string, pos: number): Statement | null {
  const all = splitStatements(doc);
  if (!all.length) return null;
  const inside = all.find((s) => pos >= s.from && pos <= s.to + 1);
  if (inside) return inside;
  const before = all.filter((s) => s.to < pos);
  return before.length ? before[before.length - 1] : all[0];
}

/** A cell as text to copy: NULL as empty (the grid shows it apart). */
const cellText = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** Tab-separated, as spreadsheets paste it. */
export function toTsv(header: string[] | null, rows: unknown[][]): string {
  const clean = (v: unknown) => cellText(v).replace(/[\t\r\n]+/g, ' ');
  const lines = rows.map((r) => r.map(clean).join('\t'));
  return (header ? [header.map(clean).join('\t'), ...lines] : lines).join('\n');
}

/** CSV (RFC 4180); NULL as an empty field, an empty text as "". */
export function toCsv(header: string[], rows: unknown[][]): string {
  const field = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return s === '' || /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.map(field).join(','), ...rows.map((r) => r.map(field).join(','))].join('\r\n');
}
