// A small, forgiving HTML and XML reader for TERMINAL web extraction
// (20261012000047): a tree of elements and text, and CSS selectors to find
// elements in it. No scripts run and nothing is fetched; pages are read as
// the server sent them (no JavaScript rendering).
//
// Selectors: tag, *, #id, .class, [attr], [attr=v], [attr~=v], [attr^=v],
// [attr$=v], [attr*=v], :first-child, :last-child, :nth-child(n),
// descendant (a b) and child (a > b) combinators, and lists (a, b).

export interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  parent: El | null;
}
export type Node = El | string;

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
// A start tag that closes an open element of these kinds first.
const CLOSES: Record<string, string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  thead: ['tbody', 'tfoot', 'tr', 'td', 'th'],
  tbody: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
  tfoot: ['thead', 'tbody', 'tr', 'td', 'th'],
  option: ['option'],
};
const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'dl',
  'fieldset',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);
// Elements that stop the search for an element to close (a table's cell does
// not close a list item outside the table).
const SCOPE = new Set(['table', 'ul', 'ol', 'dl', 'select', 'html', 'body']);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  euro: '€',
  pound: '£',
  yen: '¥',
  deg: '°',
  times: '×',
};

/** Character references (&amp; &#233; &#xE9;) as characters. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (all, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : all;
    }
    return ENTITIES[ref.toLowerCase()] ?? all;
  });
}

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(text: string, xml: boolean): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(text); m; m = ATTR_RE.exec(text)) {
    const name = xml ? m[1] : m[1].toLowerCase();
    if (!Object.hasOwn(attrs, name)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Most elements read from one document (a guard against huge pages). */
export const MAX_ELEMENTS = 200_000;

/**
 * The document as a tree under a root element ("#root"). HTML: tag names in
 * lower case, void elements, implied end tags. XML: names as written, CDATA.
 */
export function parseMarkup(source: string, xml = false): El {
  const root: El = { tag: '#root', attrs: {}, children: [], parent: null };
  let current = root;
  let count = 0;
  const open = (tag: string, attrs: Record<string, string>, selfClosing: boolean) => {
    if (++count > MAX_ELEMENTS) throw new Error('tooManyElements');
    if (!xml) {
      // Implied end tags: the outermost open element this one closes, within
      // the nearest table or list.
      const closes = CLOSES[tag] ?? (BLOCK.has(tag) ? ['p'] : null);
      if (closes) {
        let target: El | null = null;
        for (let e: El | null = current; e && e !== root && !SCOPE.has(e.tag); e = e.parent)
          if (closes.includes(e.tag)) target = e;
        if (target) current = target.parent ?? root;
      }
    }
    const el: El = { tag, attrs, children: [], parent: current };
    current.children.push(el);
    if (!selfClosing && (xml || !VOID.has(tag))) current = el;
    return el;
  };
  const close = (tag: string) => {
    for (let e: El | null = current; e && e !== root; e = e.parent) {
      if (e.tag === tag) {
        current = e.parent ?? root;
        return;
      }
      if (!xml && SCOPE.has(e.tag) && !SCOPE.has(tag)) return;
    }
  };
  const text = (t: string) => {
    if (t) current.children.push(decodeEntities(t));
  };

  let i = 0;
  const n = source.length;
  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      text(source.slice(i));
      break;
    }
    if (lt > i) text(source.slice(i, lt));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      current.children.push(source.slice(lt + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (source[lt + 1] === '!' || source[lt + 1] === '?') {
      const end = source.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9:_.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(
      source.slice(lt, lt + 20_000)
    );
    if (!m) {
      text('<');
      i = lt + 1;
      continue;
    }
    i = lt + m[0].length;
    const tag = xml ? m[2] : m[2].toLowerCase();
    if (m[1]) {
      close(tag);
      continue;
    }
    const selfClosing = /\/\s*$/.test(m[3]);
    const el = open(tag, parseAttrs(m[3].replace(/\/\s*$/, ''), xml), selfClosing);
    if (!xml && RAW.has(tag) && !selfClosing) {
      // Script, style and the like hold text up to their end tag.
      const end = source.toLowerCase().indexOf(`</${tag}`, i);
      const body = source.slice(i, end < 0 ? n : end);
      if (body)
        el.children.push(tag === 'title' || tag === 'textarea' ? decodeEntities(body) : body);
      const gt = end < 0 ? n : source.indexOf('>', end);
      i = gt < 0 ? n : gt + 1;
      current = el.parent ?? root;
    }
  }
  return root;
}

export const isEl = (n: Node): n is El => typeof n !== 'string';

/** The text inside an element, spaces collapsed (script and style left out). */
export function textOf(node: Node): string {
  const parts: string[] = [];
  const walk = (x: Node) => {
    if (typeof x === 'string') parts.push(x);
    else if (x.tag !== 'script' && x.tag !== 'style') {
      if (x.tag === 'br') parts.push(' ');
      for (const c of x.children) walk(c);
      if (BLOCK.has(x.tag) || x.tag === 'td' || x.tag === 'th' || x.tag === 'li') parts.push(' ');
    }
  };
  walk(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** Every element below one, in document order. */
export function* elements(root: El): Generator<El> {
  const stack: Node[] = [...root.children].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (typeof n === 'string') continue;
    yield n;
    for (let k = n.children.length - 1; k >= 0; k -= 1) stack.push(n.children[k]);
  }
}

// ─── Selectors ───────────────────────────────────────────────────────────────

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; op: string | null; value: string }[];
  pseudo: { kind: 'first' | 'last' | 'nth'; n: number }[];
}
type Complex = { compound: Compound; combinator: ' ' | '>' | null }[];

const COMPOUND_RE =
  /^(\*|[A-Za-z][A-Za-z0-9_-]*)?((?:#[A-Za-z0-9_-]+|\.[A-Za-z0-9_-]+|\[[A-Za-z_:][A-Za-z0-9_:.-]*(?:[~^$*]?=(?:"[^"]*"|'[^']*'|[^\]]*))?\]|:first-child|:last-child|:nth-child\(\d+\))*)/;

/** A selector, or null when it is not one this reader understands. */
export function parseSelector(selector: string): Complex[] | null {
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 500) return null;
  const out: Complex[] = [];
  for (const part of selector.split(',')) {
    let rest = part.trim();
    if (!rest) return null;
    const complex: Complex = [];
    let combinator: ' ' | '>' | null = null;
    while (rest) {
      const m = COMPOUND_RE.exec(rest);
      if (!m || !m[0]) return null;
      const c: Compound = {
        tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : null,
        id: null,
        classes: [],
        attrs: [],
        pseudo: [],
      };
      for (const piece of m[2].match(
        /#[A-Za-z0-9_-]+|\.[A-Za-z0-9_-]+|\[[^\]]*\]|:first-child|:last-child|:nth-child\(\d+\)/g
      ) ?? []) {
        if (piece[0] === '#') c.id = piece.slice(1);
        else if (piece[0] === '.') c.classes.push(piece.slice(1));
        else if (piece === ':first-child') c.pseudo.push({ kind: 'first', n: 1 });
        else if (piece === ':last-child') c.pseudo.push({ kind: 'last', n: 1 });
        else if (piece.startsWith(':nth-child'))
          c.pseudo.push({ kind: 'nth', n: Number(/\d+/.exec(piece)![0]) });
        else {
          const a = /^\[([^\]~^$*=]+)(?:([~^$*]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(
            piece
          );
          if (!a) return null;
          c.attrs.push({
            name: a[1].trim().toLowerCase(),
            op: a[2] ?? null,
            value: a[3] ?? a[4] ?? (a[5] ?? '').trim(),
          });
        }
      }
      complex.push({ compound: c, combinator });
      rest = rest.slice(m[0].length);
      const comb = /^\s*(>)\s*|^\s+/.exec(rest);
      if (!rest) break;
      if (!comb) return null;
      combinator = comb[1] ? '>' : ' ';
      rest = rest.slice(comb[0].length);
      // A combinator needs something after it ("a >" is not a selector).
      if (!rest && comb[1]) return null;
    }
    out.push(complex);
  }
  return out;
}

const elementSiblings = (e: El) => (e.parent ? e.parent.children.filter(isEl) : [e]);

function matchesCompound(e: El, c: Compound): boolean {
  if (c.tag && e.tag.toLowerCase() !== c.tag) return false;
  if (c.id && e.attrs.id !== c.id) return false;
  if (c.classes.length) {
    const have = (e.attrs.class ?? '').split(/\s+/);
    if (!c.classes.every((k) => have.includes(k))) return false;
  }
  for (const a of c.attrs) {
    const v = e.attrs[a.name];
    if (v === undefined) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
  }
  for (const p of c.pseudo) {
    const sibs = elementSiblings(e);
    const index = sibs.indexOf(e) + 1;
    if (p.kind === 'first' && index !== 1) return false;
    if (p.kind === 'last' && index !== sibs.length) return false;
    if (p.kind === 'nth' && index !== p.n) return false;
  }
  return true;
}

function matchesComplex(e: El, complex: Complex, scope: El): boolean {
  let k = complex.length - 1;
  if (!matchesCompound(e, complex[k].compound)) return false;
  let node: El | null = e;
  while (k > 0) {
    const how = complex[k].combinator;
    k -= 1;
    if (how === '>') {
      node = node.parent;
      if (!node || node === scope || !matchesCompound(node, complex[k].compound)) return false;
    } else {
      node = node.parent;
      while (node && node !== scope && !matchesCompound(node, complex[k].compound))
        node = node.parent;
      if (!node || node === scope) return false;
    }
  }
  return true;
}

/** The elements below `scope` that match a selector, in document order. */
export function selectAll(scope: El, selector: string | Complex[]): El[] {
  const parsed = typeof selector === 'string' ? parseSelector(selector) : selector;
  if (!parsed) return [];
  const out: El[] = [];
  for (const e of elements(scope)) if (parsed.some((c) => matchesComplex(e, c, scope))) out.push(e);
  return out;
}

export const selectOne = (scope: El, selector: string): El | null =>
  selectAll(scope, selector)[0] ?? null;
