import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.MFA_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const { parseMarkup, selectAll, selectOne, textOf, parseSelector, decodeEntities } =
  await import('../../src/lib/terminal/html.ts');
const {
  parseWebSource,
  tableRows,
  listRows,
  jsonLdRows,
  feedRows,
  xmlRows,
  csvRows,
  jsonRows,
  webColumns,
  sitemapEntries,
  parseRobots,
  robotsAllows,
} = await import('../../src/lib/terminal/webSource.ts');
const { collectWeb, describeWeb, web } = await import('../../src/server/connectors/web.ts');

const PAGE = `<!doctype html><html><head><title>Harga &amp; stok</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"Product","name":"Batu split 1-2","sku":"BS12","offers":{"price":"285000","priceCurrency":"IDR"}},
  {"@type":"Organization","name":"PT Batu"}]}</script>
<style>td { color: red }</style></head><body>
<p>Intro<div class="box">x</div>
<table class="harga"><thead><tr><th>Produk</th><th>Harga</th><th>Harga</th></tr></thead>
<tbody><tr><td>Abu batu<td>120,000<td>1</tr>
<tr><td colspan=2>Split &lt;2cm&gt;</td><td>2</td></tr></tbody></table>
<ul class="items">
  <li class="card" data-id="7"><a href="/p/7">Batu <b>A</b></a><span class=price>10</span>
  <li class="card featured" data-id="8"><a href="p/8">Batu B</a><span class="price">20</span>
</ul>
<a rel="next" href="/harga?page=2">Next</a>
</body></html>`;

test('the HTML reader builds a forgiving tree', () => {
  const doc = parseMarkup(PAGE);
  assert.equal(textOf(selectOne(doc, 'title')), 'Harga & stok');
  // Implied end tags: list items and cells close each other.
  assert.equal(selectAll(doc, 'ul.items > li').length, 2);
  assert.equal(selectAll(doc, 'table.harga tbody tr').length, 2);
  assert.equal(
    selectAll(doc, 'tr:first-child > td:nth-child(2)')[0] &&
      textOf(selectAll(doc, 'tr:first-child > td:nth-child(2)')[0]),
    '120,000'
  );
  // A block element closes an open paragraph.
  assert.equal(selectOne(doc, 'div.box').parent.tag, 'body');
  assert.equal(textOf(selectOne(doc, 'li.featured a')), 'Batu B');
  assert.equal(selectAll(doc, '[data-id^="7"], .featured').length, 2);
  assert.equal(selectAll(doc, 'a[rel=next]').length, 1);
  assert.equal(selectAll(doc, 'li[class~=card]').length, 2);
  assert.equal(parseSelector('a >'), null);
  assert.equal(parseSelector('div:hover'), null);
  assert.equal(decodeEntities('&#233;&#xE9;&euro;&bogus;'), 'éé€&bogus;');
});

test('tables, repeated items and JSON-LD become records', () => {
  const doc = parseMarkup(PAGE);
  assert.deepEqual(tableRows(doc, 'table.harga'), [
    { Produk: 'Abu batu', Harga: '120,000', Harga_2: '1' },
    { Produk: 'Split <2cm>', Harga: '', Harga_2: '2' },
  ]);
  assert.deepEqual(
    listRows(
      doc,
      'li.card',
      [
        { name: 'name', selector: 'a', attr: null },
        { name: 'link', selector: 'a', attr: 'href' },
        { name: 'price', selector: '.price', attr: null },
        { name: 'id', selector: '', attr: 'data-id' },
      ],
      'https://site.example/harga'
    ),
    [
      { name: 'Batu A', link: 'https://site.example/p/7', price: '10', id: '7' },
      { name: 'Batu B', link: 'https://site.example/p/8', price: '20', id: '8' },
    ]
  );
  const ld = jsonLdRows(doc, 'Product');
  assert.equal(ld.length, 1);
  assert.equal(ld[0].sku, 'BS12');
  assert.equal(ld[0]['offers.price'], '285000');
  assert.equal(jsonLdRows(doc, null).length, 2);
});

test('feeds, XML, CSV and JSON files', () => {
  const rss = `<?xml version="1.0"?><rss><channel><title>t</title>
    <item><title>Harga naik</title><link>https://s.example/a</link><guid>a1</guid>
      <pubDate>Tue, 06 Oct 2026 08:00:00 +0700</pubDate><description><![CDATA[<p>Mulai <b>Senin</b></p>]]></description></item>
    <item><title>Libur</title><link>https://s.example/b</link></item></channel></rss>`;
  const rows = feedRows(rss);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'a1');
  assert.equal(rows[0].published, '2026-10-06T01:00:00.000Z');
  assert.equal(rows[0].summary, 'Mulai Senin');
  assert.equal(rows[1].id, 'https://s.example/b');
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>urn:1</id><title>X</title>
    <link rel="alternate" href="https://s.example/x"/><updated>2026-10-01T00:00:00Z</updated>
    <author><name>Rina</name></author><summary>s</summary></entry></feed>`;
  assert.deepEqual(feedRows(atom)[0], {
    id: 'urn:1',
    title: 'X',
    link: 'https://s.example/x',
    published: null,
    updated: '2026-10-01T00:00:00.000Z',
    author: 'Rina',
    summary: 's',
    category: null,
  });
  assert.deepEqual(
    xmlRows(
      '<list><item code="A"><name>Abu</name><qty>3</qty></item><item code="B"><name>Split</name></item></list>',
      'item'
    ),
    [
      { '@code': 'A', name: 'Abu', qty: '3' },
      { '@code': 'B', name: 'Split' },
    ]
  );
  assert.deepEqual(csvRows('\uFEFFkode;nama\nA;Abu\n\nB;Split\n'), [
    { kode: 'A', nama: 'Abu' },
    { kode: 'B', nama: 'Split' },
  ]);
  assert.deepEqual(jsonRows('{"data":{"items":[{"id":1,"x":{"y":2}}]}}', 'data.items'), [
    { id: 1, 'x.y': 2 },
  ]);
  const cols = webColumns([
    { id: '1', price: '120000', when: '2026-10-01', ok: true },
    { id: '2', price: '12.5', when: '2026-10-02', ok: false },
  ]);
  assert.deepEqual(
    cols.map((c) => `${c.name}:${c.type}`),
    ['id:integer', 'price:decimal', 'when:date', 'ok:boolean']
  );
});

test('web sources are checked before they are kept', () => {
  const base = { mode: 'web', format: 'table', pages: 'urls', urls: ['/harga'] };
  assert.ok(parseWebSource(base));
  assert.equal(parseWebSource({ ...base, urls: [] }), null);
  assert.equal(parseWebSource({ ...base, urls: ['//evil.example/x'] }), null);
  assert.equal(parseWebSource({ ...base, urls: ['javascript:alert(1)'] }), null);
  assert.equal(parseWebSource({ ...base, max_pages: 5000 }), null);
  assert.equal(parseWebSource({ ...base, next: 'a:hover' }), null);
  assert.equal(
    parseWebSource({ ...base, format: 'csv', next: 'a' }),
    null,
    'files do not follow links'
  );
  assert.equal(parseWebSource({ ...base, format: 'list', item: '.c', fields: [] }), null);
  assert.equal(
    parseWebSource({
      ...base,
      format: 'list',
      item: '.c',
      fields: [
        { name: 'a', selector: '' },
        { name: 'A', selector: '' },
      ],
    }),
    null,
    'field names are unique'
  );
  assert.equal(parseWebSource({ ...base, format: 'xml' }), null, 'XML names its record element');
  const sm = parseWebSource({
    mode: 'web',
    format: 'jsonld',
    pages: 'sitemap',
    urls: ['/ignored'],
  });
  assert.equal(sm.sitemap, '/sitemap.xml');
  assert.deepEqual(sm.urls, []);
});

test('sitemaps and robots.txt', () => {
  assert.deepEqual(
    sitemapEntries(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://s.example/a?x=1&amp;y=2</loc></url><url><loc>https://s.example/b</loc></url></urlset>`
    ),
    { urls: ['https://s.example/a?x=1&y=2', 'https://s.example/b'], sitemaps: [] }
  );
  assert.deepEqual(
    sitemapEntries(
      '<sitemapindex><sitemap><loc>https://s.example/s1.xml</loc></sitemap></sitemapindex>'
    ).sitemaps,
    ['https://s.example/s1.xml']
  );
  const robots = parseRobots(`# hi
User-agent: *
Disallow: /admin
Disallow: /*.pdf$
Allow: /admin/public
Crawl-delay: 3

User-agent: OtherBot
Disallow: /`);
  assert.equal(robotsAllows(robots, '/harga'), true);
  assert.equal(robotsAllows(robots, '/admin/x'), false);
  assert.equal(robotsAllows(robots, '/admin/public/x'), true);
  assert.equal(robotsAllows(robots, '/file.pdf'), false);
  assert.equal(robotsAllows(robots, '/file.pdf?x'), true);
  assert.equal(robots.delay, 3);
  const mine = parseRobots(
    'User-agent: PrintStream\nDisallow: /private\n\nUser-agent: *\nDisallow: /'
  );
  assert.equal(robotsAllows(mine, '/harga'), true, 'our own group wins over *');
  assert.equal(robotsAllows(mine, '/private/a'), false);
});

// A fake site: pages by path; records every request.
function fakeSite(pages) {
  const calls = [];
  return {
    calls,
    async request(url) {
      const u = new URL(url);
      calls.push(u);
      const page = pages[`${u.pathname}${u.search}`];
      const out = typeof page === 'function' ? page() : page;
      const body = Buffer.from(out?.body ?? '');
      return {
        status: out ? (out.status ?? 200) : 404,
        headers: { 'content-type': out?.type ?? 'text/html; charset=utf-8' },
        body,
        url: out?.redirect ?? url,
        text: () => body.toString(),
        json: () => JSON.parse(body.toString()),
      };
    },
  };
}
const ctxOf = (http) => ({
  http,
  privateHosts: [],
  config: { base_url: 'https://site.example/katalog' },
  secret: {},
  saveSecret: async () => {},
  saveConfig: async () => {},
  beat: async () => {},
});

test('a run reads robots.txt first, follows next links on the site, and hashes the result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const page = (n, next) => ({
    body: `<table><tr><th>id</th><th>name</th></tr><tr><td>${n}</td><td>Item ${n}</td></tr></table>${next ? `<a rel="next" href="${next}">n</a>` : ''}`,
  });
  const http = fakeSite({
    '/robots.txt': { body: 'User-agent: *\nDisallow: /secret', type: 'text/plain' },
    '/harga': page(1, '/harga?p=2'),
    '/harga?p=2': page(2, 'https://site.example/harga'),
  });
  const source = parseWebSource({
    mode: 'web',
    format: 'table',
    pages: 'urls',
    urls: ['/harga'],
    next: 'a[rel=next]',
  });
  const running = collectWeb(ctxOf(http), source);
  // One page a second: let the polite waits pass.
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(1000);
  }
  const first = await running;
  assert.deepEqual(
    first.rows.map((r) => r.id),
    ['1', '2']
  );
  assert.equal(first.rows[0]._url, 'https://site.example/harga');
  assert.equal(http.calls[0].pathname, '/robots.txt');
  assert.equal(http.calls.length, 3, 'the link back to page 1 is not read again');
  t.mock.timers.reset();
  const again = await collectWeb(ctxOf(http), source);
  assert.equal(again.hash, first.hash, 'the same pages hash the same');
});

test('robots.txt, other sites and server errors stop a run', async () => {
  const blocked = fakeSite({
    '/robots.txt': { body: 'User-agent: *\nDisallow: /', type: 'text/plain' },
    '/': { body: '' },
  });
  await assert.rejects(web.test(ctxOf(blocked)), /robotsDisallowed/);
  const down = fakeSite({ '/robots.txt': { status: 503, body: '' } });
  await assert.rejects(web.test(ctxOf(down)), /robotsUnavailable/);
  const away = fakeSite({ '/': { body: 'x', redirect: 'https://other.example/' } });
  await assert.rejects(web.test(ctxOf(away)), /pageOutsideSite/);
  const ok = fakeSite({ '/': { body: '<p>hi</p>' } });
  assert.deepEqual(await web.test(ctxOf(ok)), { status: 200 });
  const source = parseWebSource({
    mode: 'web',
    format: 'table',
    pages: 'urls',
    urls: ['https://other.example/x'],
  });
  await assert.rejects(collectWeb(ctxOf(ok), source), /pageOutsideSite/);
});

test('a sitemap gives the pages; describing reads one', async () => {
  const http = fakeSite({
    '/sitemap.xml': {
      type: 'application/xml',
      body: '<urlset><url><loc>https://site.example/produk/1</loc></url><url><loc>https://site.example/blog/x</loc></url><url><loc>https://other.example/produk/9</loc></url></urlset>',
    },
    '/produk/1': {
      body: '<script type="application/ld+json">{"@type":"Product","sku":"A1","name":"Abu"}</script>',
    },
  });
  const source = parseWebSource({
    mode: 'web',
    format: 'jsonld',
    pages: 'sitemap',
    filter: '/produk/',
  });
  const d = await describeWeb(ctxOf(http), source);
  assert.equal(d.count, 1);
  assert.equal(d.key, 'sku');
  assert.deepEqual(
    d.columns.map((c) => c.name),
    ['@type', 'sku', 'name', '_url']
  );
});
