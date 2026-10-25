// SQL text in the Query Tool: the statements of the editor (split at
// semicolons outside quotes, comments and dollar quotes), the one under the
// cursor, laying a query out (Format), and results as tab- or
// comma-separated text.

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

// ─── Format ─────────────────────────────────────────────────────────────────

type Tok = {
  kind: 'word' | 'string' | 'quoted' | 'number' | 'line' | 'block' | 'punct';
  text: string;
};

/** Words written in capitals; any unquoted word means the same in either case. */
const KEYWORDS = new Set(
  `select from where and or not in is null as on join left right full inner outer cross natural
   group by order having limit offset fetch union all distinct case when then else end with
   recursive asc desc nulls first last between like ilike similar exists any some true false
   over partition filter window except intersect using lateral values interval cast
   rows range preceding following unbounded current row only`
    .split(/\s+/)
    .filter(Boolean)
);
/** Clauses that start a line, with their content on the lines below. */
const BLOCK_CLAUSES = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'WINDOW',
]);
/** Clauses that start a line, with their content after them. */
const LINE_CLAUSES = new Set([
  'LIMIT',
  'OFFSET',
  'FETCH',
  'UNION',
  'UNION ALL',
  'EXCEPT',
  'INTERSECT',
  'WITH',
  'VALUES',
]);
const JOIN_WORDS = new Set(['LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'CROSS', 'NATURAL', 'JOIN']);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '-' && src[i + 1] === '-') {
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? src.length : nl;
      out.push({ kind: 'line', text: src.slice(i, end).trimEnd() });
      i = end;
    } else if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (src[j] === '*' && src[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else j += 1;
      }
      out.push({ kind: 'block', text: src.slice(i, j) });
      i = j;
    } else if (c === "'" || c === '"' || (/[EeBbXxNn]/.test(c) && src[i + 1] === "'")) {
      // E'…', B'…', X'…', N'…' stay one string: a space there would change it.
      const quote = c === '"' ? '"' : "'";
      let j = c === quote ? i + 1 : i + 2;
      const escapes = /[Ee]/.test(c);
      while (j < src.length) {
        if (escapes && src[j] === '\\') j += 2;
        else if (src[j] === quote && src[j + 1] === quote) j += 2;
        else if (src[j] === quote) {
          j += 1;
          break;
        } else j += 1;
      }
      out.push({ kind: quote === '"' ? 'quoted' : 'string', text: src.slice(i, j) });
      i = j;
    } else if (c === '$' && (m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest))) {
      const end = src.indexOf(m[0], i + m[0].length);
      const j = end < 0 ? src.length : end + m[0].length;
      out.push({ kind: 'string', text: src.slice(i, j) });
      i = j;
    } else if ((m = /^\$\d+/.exec(rest))) {
      out.push({ kind: 'word', text: m[0] });
      i += m[0].length;
    } else if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) {
      out.push({ kind: 'number', text: m[0] });
      i += m[0].length;
    } else if ((m = /^[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/.exec(rest))) {
      out.push({ kind: 'word', text: m[0] });
      i += m[0].length;
    } else if ((m = /^(::|[(),;.[\]]|[-+*/<>=~!@#%^&|`?]+)/.exec(rest))) {
      out.push({ kind: 'punct', text: m[0] });
      i += m[0].length;
    } else {
      out.push({ kind: 'punct', text: c });
      i += 1;
    }
  }
  return out;
}

/**
 * The query laid out: clauses on their own lines, a SELECT list and the
 * conditions one per line, subqueries indented, keywords in capitals. Only
 * the space between tokens changes (and the case of keywords); quoted text,
 * names and comments stay as they are.
 */
export function formatSql(src: string): string {
  const toks = tokenize(src);
  const word = (k: number) => (toks[k]?.kind === 'word' ? toks[k].text.toUpperCase() : '');
  let out = '';
  let depth = 0;
  // Each open parenthesis: a subquery (laid out under the line that opened
  // it) or not (kept on the line).
  const stack: { sub: boolean; clause: string; depth: number; at: number }[] = [];
  const lineIndent = () => Math.floor(/[^\n]*$/.exec(out)![0].search(/\S|$/) / 2);
  let clause = '';
  let between = false;
  // A line break before the next token (its indent), and whether it must come
  // even before a closing parenthesis or a comma (after a -- comment).
  let breakNext = -1;
  let mustBreak = false;
  const inline = () => stack.length > 0 && !stack[stack.length - 1].sub;
  const newline = (extra: number) => {
    // An empty line already started (after a comment) is the one used.
    out = out.replace(/[ \t]+$/, '');
    if (out && !out.endsWith('\n')) out += '\n';
    out += '  '.repeat(depth + extra);
  };
  const put = (text: string, space = true) => {
    if (space && out && !/[\s(.]$/.test(out) && !out.endsWith('::')) out += ' ';
    out += text;
  };

  for (let k = 0; k < toks.length; k += 1) {
    const tok = toks[k];
    const up = word(k);
    if (breakNext >= 0 && (mustBreak || !/^[),;]$/.test(tok.text))) {
      newline(breakNext);
      breakNext = -1;
      mustBreak = false;
    }
    if (tok.kind === 'line') {
      put(tok.text);
      breakNext = clause && !inline() ? 1 : 0;
      mustBreak = true;
      continue;
    }
    if (tok.kind === 'word' && !inline()) {
      // Two-word clauses (GROUP BY, ORDER BY, UNION ALL) and joins.
      const two = `${up} ${word(k + 1)}`;
      const name = BLOCK_CLAUSES.has(two) || LINE_CLAUSES.has(two) ? two : up;
      if (BLOCK_CLAUSES.has(name) || LINE_CLAUSES.has(name)) {
        newline(0);
        out += name;
        if (name.includes(' ')) k += 1;
        clause = name;
        between = false;
        if (BLOCK_CLAUSES.has(name)) breakNext = 1;
        continue;
      }
      const prevUp = word(k - 1);
      if (JOIN_WORDS.has(up) && !JOIN_WORDS.has(prevUp)) {
        // LEFT JOIN, CROSS JOIN, JOIN…: a line of their own under FROM.
        let j = k;
        while (JOIN_WORDS.has(word(j)) && word(j) !== 'JOIN') j += 1;
        if (word(j) === 'JOIN') {
          newline(1);
          out += up;
          clause = 'JOIN';
          continue;
        }
      }
      if ((up === 'AND' || up === 'OR') && clause !== 'SELECT') {
        if (between && up === 'AND') {
          between = false;
          put(up);
          continue;
        }
        newline(clause === 'JOIN' ? 2 : 1);
        out += up;
        continue;
      }
      if (up === 'BETWEEN') between = true;
    }
    if (tok.text === '(') {
      const sub = word(k + 1) === 'SELECT' || word(k + 1) === 'WITH';
      const prev = toks[k - 1];
      const call = prev?.kind === 'word' && !KEYWORDS.has(prev.text.toLowerCase());
      put('(', !call);
      stack.push({ sub, clause, depth, at: lineIndent() });
      if (sub) depth = lineIndent() + 1;
      continue;
    }
    if (tok.text === ')') {
      const top = stack.pop();
      if (top?.sub) {
        depth = top.at;
        newline(0);
        out += ')';
      } else put(')', false);
      if (top) {
        clause = top.clause;
        depth = top.depth;
      }
      continue;
    }
    if (tok.text === ',') {
      put(',', false);
      if (!inline() && clause) breakNext = 1;
      continue;
    }
    if (tok.text === ';') {
      put(';', false);
      out += '\n\n';
      clause = '';
      depth = 0;
      stack.length = 0;
      continue;
    }
    if (tok.text === '.' || tok.text === '::') {
      put(tok.text, false);
      continue;
    }
    if (tok.text === '[' || tok.text === ']') {
      put(tok.text, false);
      continue;
    }
    const text = tok.kind === 'word' && KEYWORDS.has(tok.text.toLowerCase()) ? up : tok.text;
    put(text);
  }
  return out
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
