import type { Entry } from './types';

// TERMINAL database sources (P2): another PostgreSQL database, synced by table or query.
export const terminalDbSourceMessages = {
  'ps.conn.kind.postgres': {
    en: 'PostgreSQL database',
    id: 'Database PostgreSQL',
    zh: 'PostgreSQL 数据库',
  },
  'ps.conn.help.postgres': {
    en: 'Another PostgreSQL database, read only: tables, views or a query you write. Use a database user that may only read what PrintStream should see. The server must be reachable from the internet with TLS, or be an internal server allowed by ETNA.',
    id: 'Database PostgreSQL lain, hanya dibaca: tabel, view, atau kueri yang Anda tulis. Gunakan pengguna database yang hanya boleh membaca apa yang perlu dilihat PrintStream. Server harus dapat dijangkau dari internet dengan TLS, atau server internal yang diizinkan ETNA.',
    zh: '另一个 PostgreSQL 数据库，只读：表、视图或您编写的查询。请使用只能读取 PrintStream 所需数据的数据库用户。服务器必须可通过 TLS 从互联网访问，或是 ETNA 允许的内网服务器。',
  },
  'ps.conn.field.host': { en: 'Server', id: 'Server', zh: '服务器' },
  'ps.conn.field.port': { en: 'Port', id: 'Port', zh: '端口' },
  'ps.conn.field.ssl': { en: 'Encryption (TLS)', id: 'Enkripsi (TLS)', zh: '加密 (TLS)' },
  'ps.conn.field.ca_pem': {
    en: 'CA certificate (PEM, if the server’s certificate is not from a public authority)',
    id: 'Sertifikat CA (PEM, jika sertifikat server bukan dari otoritas publik)',
    zh: 'CA 证书（PEM，若服务器证书并非公共机构签发）',
  },
  'ps.conn.opt.verify-full': {
    en: 'Verify certificate and server name',
    id: 'Periksa sertifikat dan nama server',
    zh: '验证证书和服务器名称',
  },
  'ps.conn.opt.verify-ca': {
    en: 'Verify certificate only (CA certificate needed)',
    id: 'Periksa sertifikat saja (perlu sertifikat CA)',
    zh: '仅验证证书（需要 CA 证书）',
  },
  'ps.conn.opt.disable': {
    en: 'No encryption (internal servers allowed by ETNA only)',
    id: 'Tanpa enkripsi (hanya server internal yang diizinkan ETNA)',
    zh: '不加密（仅限 ETNA 允许的内网服务器）',
  },
  'ps.dbs.add': {
    en: 'Sync a table or query',
    id: 'Sinkronkan tabel atau kueri',
    zh: '同步表或查询',
  },
  'ps.dbs.query': { en: 'query', id: 'kueri', zh: '查询' },
  'ps.dbs.mode.table': { en: 'A table or view', id: 'Tabel atau view', zh: '表或视图' },
  'ps.dbs.mode.query': { en: 'A query (SQL)', id: 'Kueri (SQL)', zh: '查询 (SQL)' },
  'ps.dbs.table': { en: 'Table', id: 'Tabel', zh: '表' },
  'ps.dbs.pickTable': { en: 'Choose a table', id: 'Pilih tabel', zh: '选择表' },
  'ps.dbs.loadingTables': {
    en: 'Asking the database for its tables…',
    id: 'Meminta daftar tabel dari database…',
    zh: '正在获取数据库的表…',
  },
  'ps.dbs.view': { en: 'view', id: 'view', zh: '视图' },
  'ps.dbs.truncated': {
    en: 'Only the first 500 tables are listed; for others, write a query.',
    id: 'Hanya 500 tabel pertama yang ditampilkan; untuk yang lain, tulis kueri.',
    zh: '仅列出前 500 个表；其他表请编写查询。',
  },
  'ps.dbs.sql': { en: 'Query', id: 'Kueri', zh: '查询' },
  'ps.dbs.sqlHint': {
    en: 'One SELECT, read in a read-only transaction. It is kept in the activity log.',
    id: 'Satu SELECT, dibaca dalam transaksi hanya-baca. Kueri dicatat di log aktivitas.',
    zh: '一条 SELECT，在只读事务中读取，并记录在活动日志中。',
  },
  'ps.dbs.describe': { en: 'Read the columns', id: 'Baca kolom', zh: '读取列' },
  'ps.dbs.column': { en: 'Column', id: 'Kolom', zh: '列' },
  'ps.dbs.sourceType': { en: 'In the database', id: 'Di database', zh: '数据库中' },
  'ps.dbs.datasetType': { en: 'In the dataset', id: 'Di dataset', zh: '数据集中' },
  'ps.dbs.key': {
    en: 'Key (rows are updated by it)',
    id: 'Kunci (baris diperbarui berdasarkan ini)',
    zh: '键（按此更新行）',
  },
  'ps.dbs.noKey': { en: 'No key', id: 'Tanpa kunci', zh: '无键' },
  'ps.dbs.primaryKey': { en: 'primary key', id: 'primary key', zh: '主键' },
  'ps.dbs.changed': {
    en: '“Changed” column (for reading only newer rows)',
    id: 'Kolom “diubah” (untuk membaca baris yang lebih baru saja)',
    zh: '“更改时间”列（仅读取较新的行）',
  },
  'ps.dbs.noChanged': {
    en: 'None: read everything',
    id: 'Tidak ada: baca semua',
    zh: '无：全部读取',
  },
  'ps.dbs.howNoKey': {
    en: 'Without a key, every run reads everything and replaces the dataset’s rows.',
    id: 'Tanpa kunci, setiap proses membaca semuanya dan mengganti baris dataset.',
    zh: '没有键时，每次运行都会读取全部数据并替换数据集的行。',
  },
  'ps.dbs.howFull': {
    en: 'Every run reads everything, updates rows by the key and removes rows the database no longer has.',
    id: 'Setiap proses membaca semuanya, memperbarui baris berdasarkan kunci, dan menghapus baris yang tidak ada lagi di database.',
    zh: '每次运行读取全部数据，按键更新行，并移除数据库中已不存在的行。',
  },
  'ps.dbs.howIncremental': {
    en: 'Runs read only rows changed since the last one and update them by the key; every few days a full read also removes rows the database no longer has.',
    id: 'Setiap proses hanya membaca baris yang berubah sejak proses terakhir dan memperbaruinya berdasarkan kunci; setiap beberapa hari pembacaan penuh juga menghapus baris yang tidak ada lagi di database.',
    zh: '每次运行仅读取自上次以来更改的行并按键更新；每隔几天进行一次全量读取，同时移除数据库中已不存在的行。',
  },
  'ps.job.kind.connector.describe': {
    en: 'Look at a source',
    id: 'Baca isi sumber',
    zh: '查看数据源',
  },
  'ps.err.remoteForbidden': {
    en: 'The database user may not read this.',
    id: 'Pengguna database tidak boleh membaca ini.',
    zh: '该数据库用户无权读取此内容。',
  },
  'ps.err.queryWrites': {
    en: 'The query tries to change data; only reading is allowed.',
    id: 'Kueri mencoba mengubah data; hanya membaca yang diizinkan.',
    zh: '该查询试图修改数据；只允许读取。',
  },
  'ps.err.queryInvalid': {
    en: 'The database refused the query. Check it in the database’s own tool first.',
    id: 'Database menolak kueri. Periksa dulu di alat database itu sendiri.',
    zh: '数据库拒绝了该查询。请先在数据库自身的工具中检查。',
  },
  'ps.err.tlsFailed': {
    en: 'The server’s certificate could not be verified. Add its CA certificate to the connection, or check the server name.',
    id: 'Sertifikat server tidak dapat diverifikasi. Tambahkan sertifikat CA-nya ke koneksi, atau periksa nama server.',
    zh: '无法验证服务器证书。请在连接中添加其 CA 证书，或检查服务器名称。',
  },
  'ps.err.tlsUnsupported': {
    en: 'The server does not accept encrypted connections.',
    id: 'Server tidak menerima koneksi terenkripsi.',
    zh: '服务器不接受加密连接。',
  },
  'ps.err.tlsRequired': {
    en: 'Connections without encryption are allowed only to internal servers ETNA allows.',
    id: 'Koneksi tanpa enkripsi hanya diizinkan ke server internal yang diizinkan ETNA.',
    zh: '仅允许与 ETNA 允许的内网服务器建立不加密的连接。',
  },
  'ps.err.duplicateColumns': {
    en: 'The query gives two columns the same name; rename one (AS …).',
    id: 'Kueri menghasilkan dua kolom dengan nama sama; ganti nama salah satunya (AS …).',
    zh: '查询返回了两个同名列；请重命名其中一个（AS …）。',
  },
  'ps.err.workerSlow': {
    en: 'The background worker has not answered yet. Check that it is running, then try again.',
    id: 'Worker latar belakang belum menjawab. Pastikan worker berjalan, lalu coba lagi.',
    zh: '后台 worker 尚未响应。请确认其正在运行后重试。',
  },
} satisfies Record<string, Entry>;
