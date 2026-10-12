// TERMINAL web sources (20261012000047): what a sync of a website reads
// (pages from a list or a sitemap, optionally following a "next page" link)
// and how records come out of them: an HTML table, repeated items picked with
// CSS selectors, JSON-LD, an RSS or Atom feed, or a JSON, CSV or XML file.
// Pure functions, shared by the screens, the app and the worker; no network.

import {
  decodeEntities,
  isEl,
  parseMarkup,
  parseSelector,
  selectAll,
  selectOne,
  textOf,
  type El,
} from './html';
import {
  columnsFromSample,
  flattenRecord,
  getPath,
  isFieldPath,
  type RestColumn,
} from './restSource';
import { detectDelimiter, inferType as inferText, parseCsv, type ColumnType } from './tabular';

export type WebFormat = 'table' | 'list' | 'jsonld' | 'feed' | 'json' | 'csv' | 'xml';
export const WEB_FORMATS: readonly WebFormat[] = [
  'table',
  'list',
  'jsonld',
  'feed',
  'json',
  'csv',
  'xml',
];
/** Formats read from HTML pages (the others are files). */
export const HTML_FORMATS: readonly WebFormat[] = ['table', 'list', 'jsonld'];

export interface WebField {
  name: string;
  /** Below the item; empty: the item itself. */
  selector: string;
  /** An attribute (href, src, content, datetime…); empty: the text. */
  attr: string | null;
}

export interface WebSource {
  mode: 'web';
  format: WebFormat;
  /** Pages from a list of addresses, or from the site's sitemap. */
  pages: 'urls' | 'sitemap';
  /** Paths ("/harga") or full addresses on the connection's site. */
  urls: string[];
  sitemap: string | null;
  /** Sitemap: only addresses containing this text. */
  filter: string | null;
  /** HTML: the link to the next page (followed on the same site). */
  next: string | null;
  max_pages: number;
  /** table: which table (a selector; the first match). */
  table: string | null;
  /** list: the repeated element, and the fields inside each. */
  item: string | null;
  fields: WebField[];
  /** jsonld: only items of these @types (comma-separated). */
  types: string | null;
  /** json: where the records are. */
  records: string;
  /** xml: the element that holds one record. */
  record: string | null;
  key: string | null;
}

export const MAX_WEB_PAGES = 1000;
export const MAX_URLS = 100;
export const MAX_FIELDS = 50;
/** Most rows one run keeps (they are compared as a whole for change detection). */
export const MAX_WEB_ROWS = 200_000;

const NAME_RE = /^[^\0]{1,60}$/;
const ATTR_RE = /^[A-Za-z_:][A-Za-z0-9_:.-]{0,60}$/;
const XML_NAME_RE = /^[A-Za-z_][A-Za-z0-9_:.-]{0,100}$/;

/** A path or address on the site: "/a/b?x=1" or "https://site/…" (checked against the site later). */
export const isPageRef = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= 1000 &&
  (/^\/(?!\/)\S*$/.test(v) || /^https?:\/\/\S+$/.test(v));

const opt = (v: unknown) => (v == null || (typeof v === 'string' && v.trim() === '') ? null : v);

/** The source to keep, or null when something is missing or wrong. */
export function parseWebSource(v: any): WebSource | null {
  if (!v || typeof v !== 'object' || v.mode !== 'web' || !WEB_FORMATS.includes(v.format))
    return null;
  const pages = v.pages === 'sitemap' ? 'sitemap' : v.pages === 'urls' ? 'urls' : null;
  if (!pages) return null;
  const urls = Array.isArray(v.urls)
    ? v.urls.map((u: unknown) => (typeof u === 'string' ? u.trim() : u))
    : [];
  if (pages === 'urls' && (!urls.length || urls.length > MAX_URLS || !urls.every(isPageRef)))
    return null;
  const sitemap = opt(v.sitemap);
  if (pages === 'sitemap' && !isPageRef(sitemap ?? '/sitemap.xml')) return null;
  const filter = opt(v.filter);
  if (filter !== null && (typeof filter !== 'string' || filter.length > 200)) return null;
  const next = opt(v.next);
  if (next !== null && (!HTML_FORMATS.includes(v.format) || !parseSelector(next as string)))
    return null;
  const max = v.max_pages == null ? 100 : Number(v.max_pages);
  if (!Number.isInteger(max) || max < 1 || max > MAX_WEB_PAGES) return null;
  const table = opt(v.table);
  if (table !== null && !parseSelector(table as string)) return null;
  const item = opt(v.item);
  const fields: WebField[] = [];
  if (v.format === 'list') {
    if (!item || !parseSelector(item as string)) return null;
    if (!Array.isArray(v.fields) || !v.fields.length || v.fields.length > MAX_FIELDS) return null;
    const seen = new Set<string>();
    for (const f of v.fields) {
      const name = typeof f?.name === 'string' ? f.name.trim() : '';
      const selector = typeof f?.selector === 'string' ? f.selector.trim() : '';
      const attr = opt(f?.attr);
      if (!NAME_RE.test(name) || seen.has(name.toLowerCase())) return null;
      if (selector && !parseSelector(selector)) return null;
      if (attr !== null && !ATTR_RE.test(attr as string)) return null;
      seen.add(name.toLowerCase());
      fields.push({ name, selector, attr: attr as string | null });
    }
  }
  const types = opt(v.types);
  if (types !== null && (typeof types !== 'string' || types.length > 200)) return null;
  const records = v.records ?? '';
  if (!isFieldPath(records, true)) return null;
  const record = opt(v.record);
  if (v.format === 'xml' && (!record || !XML_NAME_RE.test(record as string))) return null;
  const key = opt(v.key);
  if (key !== null && (typeof key !== 'string' || !NAME_RE.test(key))) return null;
  return {
    mode: 'web',
    format: v.format,
    pages,
    urls: pages === 'urls' ? urls : [],
    sitemap: pages === 'sitemap' ? ((sitemap as string) ?? '/sitemap.xml') : null,
    filter: pages === 'sitemap' ? (filter as string | null) : null,
    next: next as string | null,
    max_pages: max,
    table: v.format === 'table' ? (table as string | null) : null,
    item: v.format === 'list' ? (item as string) : null,
    fields,
    types: v.format === 'jsonld' ? (types as string | null) : null,
    records: v.format === 'json' ? records : '',
    record: v.format === 'xml' ? (record as string) : null,
    key: key as string | null,
  };
}

/** What a sync of this source is called on the screens. */
export const webSourceLabel = (s: WebSource) =>
  `${s.format.toUpperCase()} · ${s.pages === 'sitemap' ? s.sitemap : s.urls[0]}${s.urls.length > 1 ? ` +${s.urls.length - 1}` : ''}`.slice(
    0,
    200
  );

// ─── Records from one page ───────────────────────────────────────────────────

export type Row = Record<string, unknown>;

/** Names that are unique (ignoring case), never empty, at most 60 characters. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw, i) => {
    let name = raw.replace(/\s+/g, ' ').trim().slice(0, 50) || `column_${i + 1}`;
    const k = name.toLowerCase();
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    if (n) name = `${name}_${n + 1}`;
    return name;
  });
}

/** An HTML table: the header row names the columns; colspans fill in blanks. */
export function tableRows(doc: El, selector: string | null): Row[] {
  const table = selectOne(doc, selector || 'table');
  if (!table) return [];
  const rows = selectAll(table, 'tr').filter((tr) => {
    // Rows of this table only, not of tables inside its cells.
    let p = tr.parent;
    while (p && p.tag !== 'table') p = p.parent;
    return p === table;
  });
  const cells = rows.map((tr) => {
    const out: { text: string; th: boolean }[] = [];
    for (const c of tr.children) {
      if (!isEl(c) || (c.tag !== 'td' && c.tag !== 'th')) continue;
      out.push({ text: textOf(c), th: c.tag === 'th' });
      const span = Math.min(50, Math.max(1, Number(c.attrs.colspan) || 1));
      for (let k = 1; k < span; k += 1) out.push({ text: '', th: c.tag === 'th' });
    }
    return out;
  });
  const headerAt = cells.findIndex((r) => r.length > 0);
  if (headerAt < 0) return [];
  const width = Math.max(...cells.map((r) => r.length));
  const names = uniqueNames(
    Array.from({ length: width }, (_, i) => cells[headerAt][i]?.text ?? '')
  );
  return cells
    .slice(headerAt + 1)
    .filter((r) => r.length && r.some((c) => c.text))
    .map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]?.text ?? null])));
}

/** Repeated items: one record per item, one value per field (text or an attribute). */
export function listRows(doc: El, item: string, fields: WebField[], pageUrl: string): Row[] {
  return selectAll(doc, item).map((el) => {
    const row: Row = {};
    for (const f of fields) {
      const target = f.selector ? selectOne(el, f.selector) : el;
      let value: string | null = null;
      if (target) {
        value = f.attr ? (target.attrs[f.attr.toLowerCase()] ?? null) : textOf(target);
        // Links and images as full addresses.
        if (value !== null && f.attr && ['href', 'src'].includes(f.attr.toLowerCase())) {
          try {
            value = new URL(value, pageUrl).toString();
          } catch {
            /* kept as written */
          }
        }
      }
      row[f.name] = value;
    }
    return row;
  });
}

/** JSON-LD blocks (schema.org data), each item (and @graph member) a record. */
export function jsonLdRows(doc: El, types: string | null): Row[] {
  const wanted = types
    ? types
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
    : null;
  const out: Row[] = [];
  for (const s of selectAll(doc, 'script[type]')) {
    if (!/^application\/ld\+json$/i.test(s.attrs.type.trim())) continue;
    let data: unknown;
    try {
      data = JSON.parse(s.children.filter((c) => typeof c === 'string').join(''));
    } catch {
      continue;
    }
    const items = (Array.isArray(data) ? data : [data]).flatMap((d: any) =>
      d && Array.isArray(d['@graph']) ? d['@graph'] : [d]
    );
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const type = [it['@type']].flat().map((x: unknown) => String(x).toLowerCase());
      if (wanted && !type.some((x) => wanted.includes(x))) continue;
      out.push(flattenRecord(it));
    }
  }
  return out;
}

const childText = (el: El, tag: string): string | null => {
  const c = el.children.find((x) => isEl(x) && x.tag.toLowerCase() === tag) as El | undefined;
  return c ? textOf(c) : null;
};

/** An RSS 2.0, RSS 1.0 or Atom feed: one record per item or entry. */
export function feedRows(xml: string): Row[] {
  const doc = parseMarkup(xml, true);
  const all = [...selectAllXml(doc, (e) => /^(item|entry)$/i.test(e.tag.replace(/^.*:/, '')))];
  return all.map((e) => {
    const atom = /entry$/i.test(e.tag);
    const linkEl = e.children.find(
      (x) =>
        isEl(x) && x.tag.toLowerCase() === 'link' && (!x.attrs.rel || x.attrs.rel === 'alternate')
    ) as El | undefined;
    const link = atom ? (linkEl?.attrs.href ?? null) : (childText(e, 'link') ?? null);
    const author = atom
      ? (() => {
          const a = e.children.find((x) => isEl(x) && x.tag.toLowerCase() === 'author') as
            | El
            | undefined;
          return a ? (childText(a, 'name') ?? textOf(a)) : null;
        })()
      : (childText(e, 'author') ?? childText(e, 'dc:creator'));
    const html = (v: string | null) => (v === null ? null : textOf(parseMarkup(v)));
    return {
      id: childText(e, atom ? 'id' : 'guid') ?? link,
      title: childText(e, 'title'),
      link,
      published: toIso(childText(e, atom ? 'published' : 'pubdate') ?? childText(e, 'dc:date')),
      updated: toIso(childText(e, 'updated') ?? childText(e, 'pubdate') ?? childText(e, 'dc:date')),
      author,
      summary:
        html(childText(e, atom ? 'summary' : 'description') ?? childText(e, 'content'))?.slice(
          0,
          4000
        ) ?? null,
      category: childText(e, 'category'),
    };
  });
}

function* selectAllXml(root: El, test: (e: El) => boolean): Generator<El> {
  const stack: El[] = [root];
  while (stack.length) {
    const e = stack.pop()!;
    if (e !== root && test(e)) {
      yield e;
      continue;
    }
    for (let k = e.children.length - 1; k >= 0; k -= 1) {
      const c = e.children[k];
      if (isEl(c)) stack.push(c);
    }
  }
}

function toIso(v: string | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? v : new Date(t).toISOString();
}

/** XML records: each <record> element; its attributes (@name) and child elements' text. */
export function xmlRows(xml: string, record: string): Row[] {
  const doc = parseMarkup(xml, true);
  return [...selectAllXml(doc, (e) => e.tag === record)].map((e) => {
    const row: Row = {};
    for (const [k, v] of Object.entries(e.attrs)) row[`@${k}`] = v;
    for (const c of e.children) if (isEl(c) && !Object.hasOwn(row, c.tag)) row[c.tag] = textOf(c);
    if (!e.children.some(isEl)) row.value = textOf(e);
    return row;
  });
}

/** A CSV file: the first row names the columns. */
export function csvRows(text: string): Row[] {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''), detectDelimiter(text.slice(0, 20_000)));
  if (rows.length < 1) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const names = uniqueNames(Array.from({ length: width }, (_, i) => rows[0][i] ?? ''));
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? null])));
}

/** A JSON file: the records at a path (or the file itself). */
export function jsonRows(text: string, records: string): Row[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const found = getPath(data, records);
  const list = Array.isArray(found) ? found : found && typeof found === 'object' ? [found] : [];
  return list.map(flattenRecord);
}

/** The records of one fetched page or file, each with the address it came from. */
export function extractRows(source: WebSource, body: string, pageUrl: string, doc?: El): Row[] {
  let rows: Row[];
  switch (source.format) {
    case 'table':
      rows = tableRows(doc ?? parseMarkup(body), source.table);
      break;
    case 'list':
      rows = listRows(doc ?? parseMarkup(body), source.item!, source.fields, pageUrl);
      break;
    case 'jsonld':
      rows = jsonLdRows(doc ?? parseMarkup(body), source.types);
      break;
    case 'feed':
      rows = feedRows(body);
      break;
    case 'xml':
      rows = xmlRows(body, source.record!);
      break;
    case 'csv':
      rows = csvRows(body);
      break;
    case 'json':
      rows = jsonRows(body, source.records);
      break;
  }
  return rows.map((r) => ({ ...r, _url: pageUrl }));
}

/** Columns for the records: JSON values keep their types; text is typed as an import would. */
export function webColumns(rows: Row[]): RestColumn[] {
  return columnsFromSample(rows).map((c) => {
    if (c.type !== 'text') return c;
    const values = rows.slice(0, 200).map((r) => r[c.name]);
    const type: ColumnType = values.every((v) => v === null || typeof v === 'string')
      ? inferText(values, '.')
      : 'text';
    return { ...c, type };
  });
}

// ─── Sitemaps and robots.txt ─────────────────────────────────────────────────

/** The page addresses (and nested sitemaps) a sitemap lists. */
export function sitemapEntries(xml: string): { urls: string[]; sitemaps: string[] } {
  const doc = parseMarkup(xml, true);
  const urls: string[] = [];
  const sitemaps: string[] = [];
  for (const e of selectAllXml(doc, (x) => /^(url|sitemap)$/i.test(x.tag.replace(/^.*:/, '')))) {
    const loc = e.children.find((c) => isEl(c) && /^(.*:)?loc$/i.test(c.tag)) as El | undefined;
    const href = loc ? decodeEntities(textOf(loc)) : '';
    if (!href) continue;
    if (/sitemap$/i.test(e.tag)) sitemaps.push(href);
    else urls.push(href);
  }
  return { urls, sitemaps };
}

export interface RobotsRules {
  rules: { allow: boolean; path: string }[];
  delay: number | null;
}

/**
 * The rules of robots.txt for PrintStream (RFC 9309): the group naming
 * "printstream", else the "*" group; the longest matching rule wins, Allow on a tie.
 */
export function parseRobots(text: string, agent = 'printstream'): RobotsRules {
  const groups: {
    agents: string[];
    rules: { allow: boolean; path: string }[];
    delay: number | null;
  }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      if (value || field === 'allow') current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const d = Number(value);
      if (Number.isFinite(d) && d >= 0) current.delay = d;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return {
    rules: chosen.flatMap((g) => g.rules),
    delay: chosen.find((g) => g.delay !== null)?.delay ?? null,
  };
}

function ruleMatches(rule: string, path: string): number {
  if (!rule) return -1;
  const anchored = rule.endsWith('$');
  const pattern = (anchored ? rule.slice(0, -1) : rule)
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path) ? rule.length : -1;
}

/** Whether robots.txt lets PrintStream read a path (with its query). */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  let best = -1;
  let allow = true;
  for (const r of rules.rules) {
    const len = ruleMatches(r.path, path);
    if (len > best || (len === best && len >= 0 && r.allow)) {
      best = len;
      allow = r.allow;
    }
  }
  return allow;
}
