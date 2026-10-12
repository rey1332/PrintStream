// A website as a TERMINAL connection (20261012000047): static pages, feeds
// and files read as the server sends them (no JavaScript is run). The
// connection is one site; each sync reads pages from a list or the site's
// sitemap, optionally following a "next page" link, and takes records out of
// them (src/lib/terminal/webSource.ts).
//
// Manners: robots.txt is read first and obeyed (a site whose robots.txt
// cannot be read because of a server error is not read at all, RFC 9309);
// one request a second, or the site's Crawl-delay up to 10 s; pages stay on
// the connection's site, through the network guard.
// Change detection: the whole result is hashed; when nothing changed since the
// last run, the dataset is left as it is.

import { createHash } from 'node:crypto';
import { parseMarkup, selectOne } from '@/lib/terminal/html';
import { decodeBytes } from '@/lib/terminal/tabular';
import {
  HTML_FORMATS,
  MAX_WEB_ROWS,
  extractRows,
  parseRobots,
  robotsAllows,
  sitemapEntries,
  webColumns,
  type RobotsRules,
  type Row,
  type WebSource,
} from '@/lib/terminal/webSource';
import { parseHeaderLines } from '@/lib/terminal/restSource';
import { TerminalError } from '@/server/terminal/session';
import { failure, type Adapter, type ConnectorContext } from './types';

const PAGE_BYTES = 20 * 1024 * 1024;
const MAX_DELAY_S = 10;
const MAX_SITEMAP_URLS = 50_000;
export const WEB_RUN_MS = 2 * 3600_000;

/** The connection's site: its origin. */
export function siteOf(ctx: ConnectorContext): URL {
  try {
    const url = new URL(String(ctx.config.base_url ?? '').trim());
    return new URL(url.origin);
  } catch {
    throw new TerminalError('fieldInvalid', { field: 'base_url' });
  }
}

/** A page reference as an address on the site, or why not. */
export function onSite(site: URL, ref: string, base: URL | string = site): URL {
  let url: URL;
  try {
    url = new URL(ref, base);
  } catch {
    throw new TerminalError('badResponse');
  }
  url.hash = '';
  if (url.origin !== site.origin) throw new TerminalError('pageOutsideSite');
  return url;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One run's reader: robots.txt once, polite pacing, the site's own pages only. */
export class SiteReader {
  readonly site: URL;
  private robots: RobotsRules | null = null;
  private last = 0;
  private readonly ctx: ConnectorContext;
  constructor(ctx: ConnectorContext) {
    this.ctx = ctx;
    this.site = siteOf(ctx);
  }

  private async rules(): Promise<RobotsRules> {
    if (this.robots) return this.robots;
    const res = await this.ctx.http.request(new URL('/robots.txt', this.site).toString(), {
      headers: { Accept: 'text/plain' },
      maxBytes: 512 * 1024,
    });
    if (res.status >= 500) throw new TerminalError('robotsUnavailable');
    this.robots =
      res.status >= 200 && res.status < 300 ? parseRobots(res.text()) : { rules: [], delay: null };
    return this.robots;
  }

  /** A page's text (decoded), or null when it is gone (404, 410). */
  async get(url: URL): Promise<{ text: string; type: string } | null> {
    const rules = await this.rules();
    if (!robotsAllows(rules, `${url.pathname}${url.search}`))
      throw new TerminalError('robotsDisallowed', { path: url.pathname.slice(0, 100) });
    const gap = Math.min(MAX_DELAY_S, Math.max(1, rules.delay ?? 1)) * 1000;
    const wait = this.last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
    const headers: Record<string, string> = {
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/csv;q=0.8,*/*;q=0.5',
    };
    for (const [k, v] of parseHeaderLines(this.ctx.config.headers)) headers[k] = v;
    const res = await this.ctx.http.request(url.toString(), { headers, maxBytes: PAGE_BYTES });
    if (res.status === 404 || res.status === 410) return null;
    if (res.status < 200 || res.status >= 300) throw failure(res);
    // The page must not have left the site through a redirect.
    if (new URL(res.url).origin !== this.site.origin) throw new TerminalError('pageOutsideSite');
    const type = String(res.headers['content-type'] ?? '');
    const charset = /charset=([^;]+)/i.exec(type)?.[1]?.trim();
    let text: string;
    try {
      text = decodeBytes(res.body, charset).text;
    } catch {
      // A charset the runtime does not know: decided from the bytes.
      text = decodeBytes(res.body).text;
    }
    return { text, type };
  }
}

/** The pages a source starts from: its list, or its sitemap's (nested once), filtered. */
async function startPages(
  reader: SiteReader,
  source: WebSource,
  ctx: ConnectorContext
): Promise<URL[]> {
  if (source.pages === 'urls') return source.urls.map((u) => onSite(reader.site, u));
  const urls: URL[] = [];
  const queue = [onSite(reader.site, source.sitemap ?? '/sitemap.xml')];
  for (let n = 0; queue.length && n < 20; n += 1) {
    const page = await reader.get(queue.shift()!);
    await ctx.beat();
    if (!page) continue;
    const found = sitemapEntries(page.text);
    for (const s of found.sitemaps) if (n === 0) queue.push(onSite(reader.site, s));
    for (const u of found.urls) {
      if (urls.length >= MAX_SITEMAP_URLS) break;
      if (source.filter && !u.includes(source.filter)) continue;
      try {
        urls.push(onSite(reader.site, u));
      } catch {
        // Addresses of other sites in a sitemap are left out.
      }
    }
  }
  return urls;
}

/**
 * Every record of a source (at most MAX_WEB_ROWS) and a hash of them all.
 * `limit` reads only that many pages (for a preview).
 */
export async function collectWeb(
  ctx: ConnectorContext,
  source: WebSource,
  limit: number = source.max_pages,
  deadline = Date.now() + WEB_RUN_MS
): Promise<{ rows: Row[]; hash: string; pages: number; missing: number }> {
  const reader = new SiteReader(ctx);
  const queue = await startPages(reader, source, ctx);
  const seen = new Set<string>();
  const rows: Row[] = [];
  const hash = createHash('sha256');
  let pages = 0;
  let missing = 0;
  while (queue.length && pages < Math.min(limit, source.max_pages)) {
    if (Date.now() > deadline) throw new TerminalError('runTooLong');
    const url = queue.shift()!;
    if (seen.has(url.toString())) continue;
    seen.add(url.toString());
    const page = await reader.get(url);
    pages += 1;
    await ctx.beat();
    if (!page) {
      missing += 1;
      continue;
    }
    const html = HTML_FORMATS.includes(source.format);
    const doc = html ? parseMarkup(page.text) : undefined;
    for (const r of extractRows(source, page.text, url.toString(), doc)) {
      if (rows.length >= MAX_WEB_ROWS) throw new TerminalError('tooManyRows');
      rows.push(r);
      hash.update(JSON.stringify(r));
      hash.update('\n');
    }
    // The next page, on the same site, once.
    if (doc && source.next) {
      const link = selectOne(doc, source.next);
      const href = link?.attrs.href;
      if (href) {
        const next = onSite(reader.site, href, url);
        if (!seen.has(next.toString())) queue.unshift(next);
      }
    }
  }
  return { rows, hash: hash.digest('hex'), pages, missing };
}

/** The first page of a source: its columns, a few rows to look at, how many records. */
export async function describeWeb(ctx: ConnectorContext, source: WebSource) {
  const { rows, pages } = await collectWeb(ctx, source, 1, Date.now() + 120_000);
  const sample = rows
    .slice(0, 5)
    .map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : v])
      )
    );
  const columns = webColumns(rows);
  const key =
    ['id', 'guid', 'url', 'link', 'sku', 'code'].find((k) => columns.some((c) => c.name === k)) ??
    null;
  return { columns, sample, count: rows.length, pages, key };
}

export const web: Adapter = {
  // robots.txt and the home page answer (without a server error).
  async test(ctx) {
    const reader = new SiteReader(ctx);
    const page = await reader.get(reader.site);
    return { status: page ? 200 : 404 };
  },
  // eslint-disable-next-line require-yield
  async *read() {
    // A site is read by source (collectWeb), not by ERP list.
    throw new TerminalError('invalid');
  },
};
