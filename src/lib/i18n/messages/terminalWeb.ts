import type { Entry } from './types';

// Terminal web extraction (P2, 20261012000047).
export const terminalWebMessages = {
  'ps.conn.kind.web': { en: 'Website', id: 'Situs web', zh: '网站' },
  'ps.conn.help.web': {
    en: 'A website’s public pages, feeds or files: price lists, catalogues, announcements. PrintStream reads them as the server sends them (no JavaScript), obeys the site’s robots.txt and reads one page a second. Use it only for sites whose terms allow it.',
    id: 'Halaman publik, feed, atau file sebuah situs: daftar harga, katalog, pengumuman. PrintStream membacanya seperti yang dikirim server (tanpa JavaScript), mematuhi robots.txt situs, dan membaca satu halaman per detik. Gunakan hanya untuk situs yang ketentuannya mengizinkan.',
    zh: '网站的公开页面、订阅源或文件：价目表、目录、公告。PrintStream 按服务器发送的内容读取（不运行 JavaScript），遵守网站的 robots.txt，每秒读取一页。仅用于条款允许的网站。',
  },
  'ps.web.add': { en: 'Sync from the site', id: 'Sinkronkan dari situs', zh: '从网站同步' },
  'ps.web.step': { en: 'Step {n} of 3', id: 'Langkah {n} dari 3', zh: '第 {n} 步，共 3 步' },
  'ps.web.step1': { en: 'Pages', id: 'Halaman', zh: '页面' },
  'ps.web.step2': { en: 'What to read', id: 'Yang dibaca', zh: '读取内容' },
  'ps.web.step3': { en: 'Columns', id: 'Kolom', zh: '列' },
  'ps.web.pages.urls': { en: 'A list of pages', id: 'Daftar halaman', zh: '页面列表' },
  'ps.web.pages.sitemap': { en: 'The site’s sitemap', id: 'Sitemap situs', zh: '网站地图' },
  'ps.web.urls': {
    en: 'Pages (a path or an address on the site, one a line; at most 100)',
    id: 'Halaman (path atau alamat di situs, satu per baris; maks. 100)',
    zh: '页面（站内路径或地址，每行一个；最多 100 个）',
  },
  'ps.web.sitemap': { en: 'Sitemap', id: 'Sitemap', zh: '网站地图' },
  'ps.web.filter': {
    en: 'Only addresses containing (optional)',
    id: 'Hanya alamat yang memuat (opsional)',
    zh: '仅包含以下文字的地址（可选）',
  },
  'ps.web.max_pages': {
    en: 'At most pages a run',
    id: 'Maks. halaman per proses',
    zh: '每次最多页数',
  },
  'ps.web.next': {
    en: 'Next page link (CSS selector, optional)',
    id: 'Tautan halaman berikutnya (selector CSS, opsional)',
    zh: '下一页链接（CSS 选择器，可选）',
  },
  'ps.web.format': { en: 'Read', id: 'Baca', zh: '读取' },
  'ps.web.format.table': { en: 'An HTML table', id: 'Tabel HTML', zh: 'HTML 表格' },
  'ps.web.format.list': {
    en: 'Repeated items (CSS selectors)',
    id: 'Item berulang (selector CSS)',
    zh: '重复项（CSS 选择器）',
  },
  'ps.web.format.jsonld': {
    en: 'Structured data (JSON-LD, schema.org)',
    id: 'Data terstruktur (JSON-LD, schema.org)',
    zh: '结构化数据（JSON-LD，schema.org）',
  },
  'ps.web.format.feed': {
    en: 'An RSS or Atom feed',
    id: 'Feed RSS atau Atom',
    zh: 'RSS 或 Atom 订阅源',
  },
  'ps.web.format.json': { en: 'A JSON file', id: 'File JSON', zh: 'JSON 文件' },
  'ps.web.format.csv': { en: 'A CSV file', id: 'File CSV', zh: 'CSV 文件' },
  'ps.web.format.xml': { en: 'An XML file', id: 'File XML', zh: 'XML 文件' },
  'ps.web.table': {
    en: 'Which table (CSS selector; empty: the first table)',
    id: 'Tabel yang mana (selector CSS; kosong: tabel pertama)',
    zh: '哪个表格（CSS 选择器；留空：第一个表格）',
  },
  'ps.web.item': {
    en: 'Each item (CSS selector)',
    id: 'Setiap item (selector CSS)',
    zh: '每一项（CSS 选择器）',
  },
  'ps.web.fields': { en: 'Fields of each item', id: 'Kolom setiap item', zh: '每项的字段' },
  'ps.web.fieldName': { en: 'Name', id: 'Nama', zh: '名称' },
  'ps.web.fieldSelector': {
    en: 'Inside the item (selector; empty: the item)',
    id: 'Di dalam item (selector; kosong: item itu)',
    zh: '项内位置（选择器；留空：该项本身）',
  },
  'ps.web.fieldAttr': {
    en: 'Attribute (empty: the text)',
    id: 'Atribut (kosong: teksnya)',
    zh: '属性（留空：文本）',
  },
  'ps.web.addField': { en: 'Add a field', id: 'Tambah kolom', zh: '添加字段' },
  'ps.web.removeField': { en: 'Remove field', id: 'Hapus kolom', zh: '删除字段' },
  'ps.web.types': {
    en: 'Only these types (e.g. Product, Offer; optional)',
    id: 'Hanya tipe ini (mis. Product, Offer; opsional)',
    zh: '仅这些类型（如 Product、Offer；可选）',
  },
  'ps.web.record': {
    en: 'Element of one record',
    id: 'Elemen satu record',
    zh: '单条记录的元素',
  },
  'ps.web.preview': { en: 'Read the first page', id: 'Baca halaman pertama', zh: '读取第一页' },
  'ps.web.noRecords': {
    en: 'No records on the first page. Check the settings.',
    id: 'Tidak ada record di halaman pertama. Periksa pengaturannya.',
    zh: '第一页没有记录。请检查设置。',
  },
  'ps.web.manners': {
    en: 'Each run reads the pages again, obeying robots.txt, one page a second. When everything is as last time, the dataset is left unchanged; otherwise rows are updated by the key (or replaced) and rows no longer on the site are marked removed. Every row keeps its page address (_url).',
    id: 'Setiap proses membaca ulang halaman, mematuhi robots.txt, satu halaman per detik. Bila semuanya sama seperti sebelumnya, dataset dibiarkan; jika tidak, baris diperbarui berdasarkan kunci (atau diganti) dan baris yang tidak lagi ada di situs ditandai terhapus. Setiap baris menyimpan alamat halamannya (_url).',
    zh: '每次运行都会重新读取页面，遵守 robots.txt，每秒一页。若内容与上次完全相同，数据集保持不变；否则按键更新（或替换）行，并将网站上已不存在的行标记为已删除。每行都保留其页面地址 (_url)。',
  },

  'ps.err.robotsDisallowed': {
    en: 'The site’s robots.txt does not allow reading {path}.',
    id: 'robots.txt situs tidak mengizinkan membaca {path}.',
    zh: '该网站的 robots.txt 不允许读取 {path}。',
  },
  'ps.err.robotsUnavailable': {
    en: 'The site’s robots.txt could not be read (server error), so the site is not read.',
    id: 'robots.txt situs tidak bisa dibaca (galat server), jadi situs tidak dibaca.',
    zh: '无法读取该网站的 robots.txt（服务器错误），因此不读取该网站。',
  },
  'ps.err.pageOutsideSite': {
    en: 'A page is on another site than the connection’s; it was not read.',
    id: 'Sebuah halaman berada di situs lain dari situs koneksi; tidak dibaca.',
    zh: '某页面不在连接所属网站上，未予读取。',
  },
  'ps.err.tooManyRows': {
    en: 'More than 200,000 records; read fewer pages.',
    id: 'Lebih dari 200.000 record; baca lebih sedikit halaman.',
    zh: '记录超过 200,000 条；请减少读取的页面。',
  },
} satisfies Record<string, Entry>;
