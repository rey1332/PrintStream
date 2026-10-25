import type { Entry } from './types';

// Terminal as a database workbench: the Query Tool and the object browser
// (src/app/terminal/query/*).
export const terminalQueryMessages = {
  // ─── Workbench ─────────────────────────────────────────────────────────────
  'ps.wb.explorer': { en: 'Object Explorer', id: 'Penjelajah Objek', zh: '对象浏览器' },
  'ps.wb.queryTool': { en: 'Query Tool', id: 'Query Tool', zh: '查询工具' },
  'ps.wb.hideExplorer': {
    en: 'Hide the Object Explorer',
    id: 'Sembunyikan Penjelajah Objek',
    zh: '隐藏对象浏览器',
  },
  'ps.wb.showExplorer': {
    en: 'Show the Object Explorer',
    id: 'Tampilkan Penjelajah Objek',
    zh: '显示对象浏览器',
  },
  'ps.wb.resizeExplorer': {
    en: 'Resize the Object Explorer',
    id: 'Ubah lebar Penjelajah Objek',
    zh: '调整对象浏览器宽度',
  },
  'ps.wb.datasetHint': {
    en: '{rows} rows · double-click to see the first 100',
    id: '{rows} baris · klik dua kali untuk melihat 100 pertama',
    zh: '{rows} 行 · 双击查看前 100 行',
  },
  'ps.wb.viewData': { en: 'View data', id: 'Lihat data', zh: '查看数据' },
  'ps.wb.insertName': { en: 'Insert name', id: 'Sisipkan nama', zh: '插入名称' },
  'ps.wb.openScreen': { en: 'Open', id: 'Buka', zh: '打开' },
  'ps.wb.sensitive': { en: 'sensitive', id: 'sensitif', zh: '敏感' },
  'ps.wb.noDatasets': { en: 'No datasets yet', id: 'Belum ada dataset', zh: '暂无数据集' },
  'ps.wb.askingWorker': {
    en: 'Asking the worker…',
    id: 'Menanyakan worker…',
    zh: '正在询问后台进程…',
  },
  'ps.wb.table': { en: 'Table', id: 'Tabel', zh: '表' },
  'ps.wb.view': { en: 'View', id: 'View', zh: '视图' },

  // ─── Connection bar ────────────────────────────────────────────────────────
  'ps.qt.connection': { en: 'Connection', id: 'Koneksi', zh: '连接' },
  'ps.qt.datasetsTarget': {
    en: "This Terminal's datasets ({n})",
    id: 'Dataset Terminal ini ({n})',
    zh: '此 Terminal 的数据集（{n}）',
  },
  'ps.qt.datasetsShort': { en: 'Datasets', id: 'Dataset', zh: '数据集' },
  'ps.qt.sandboxReady': {
    en: 'Read-only · a copy of the datasets as you see them, made for each query',
    id: 'Hanya baca · salinan dataset seperti yang Anda lihat, dibuat untuk tiap kueri',
    zh: '只读 · 每次查询都会按您可见的内容复制数据集',
  },
  'ps.qt.noDatasetRight': {
    en: 'You may not query datasets here (datasets.query)',
    id: 'Anda tidak boleh mengkueri dataset di sini (datasets.query)',
    zh: '您无权在此查询数据集（datasets.query）',
  },
  'ps.qt.noConnectionRight': {
    en: 'Querying a connection needs integrations.manage',
    id: 'Mengkueri koneksi perlu integrations.manage',
    zh: '查询连接需要 integrations.manage 权限',
  },
  'ps.qt.needsTwoFactor': {
    en: 'Querying a connection needs a two-factor session',
    id: 'Mengkueri koneksi perlu sesi dua faktor',
    zh: '查询连接需要双重验证会话',
  },
  'ps.qt.connectionOk': {
    en: 'Read-only · connection tested {when}',
    id: 'Hanya baca · koneksi diuji {when}',
    zh: '只读 · 连接测试于 {when}',
  },
  'ps.qt.connectionState': {
    en: 'Read-only · connection state: {status}',
    id: 'Hanya baca · status koneksi: {status}',
    zh: '只读 · 连接状态：{status}',
  },
  'ps.qt.reconnect': {
    en: 'Test the connection again',
    id: 'Uji koneksi lagi',
    zh: '重新测试连接',
  },
  'ps.qt.refreshTargets': {
    en: 'Reload datasets and connections',
    id: 'Muat ulang dataset dan koneksi',
    zh: '重新加载数据集和连接',
  },
  'ps.qt.workerOffline': {
    en: 'Background worker not running: queries wait until it starts',
    id: 'Worker latar belakang tidak berjalan: kueri menunggu sampai ia mulai',
    zh: '后台进程未运行：查询将等待其启动',
  },

  // ─── Tabs and tools ────────────────────────────────────────────────────────
  'ps.qt.query': { en: 'Query', id: 'Kueri', zh: '查询' },
  'ps.qt.history': { en: 'Query History', id: 'Riwayat Kueri', zh: '查询历史' },
  'ps.qt.tools': { en: 'Query tools', id: 'Alat kueri', zh: '查询工具栏' },
  'ps.qt.openFile': { en: 'Open SQL file', id: 'Buka file SQL', zh: '打开 SQL 文件' },
  'ps.qt.saveFile': {
    en: 'Save SQL file (Ctrl+S)',
    id: 'Simpan file SQL (Ctrl+S)',
    zh: '保存 SQL 文件（Ctrl+S）',
  },
  'ps.qt.find': {
    en: 'Find and replace (Ctrl+F)',
    id: 'Cari dan ganti (Ctrl+F)',
    zh: '查找和替换（Ctrl+F）',
  },
  'ps.qt.comment': {
    en: 'Comment / uncomment lines (Ctrl+/)',
    id: 'Komentari / batalkan komentar baris (Ctrl+/)',
    zh: '注释/取消注释行（Ctrl+/）',
  },
  'ps.qt.execute': {
    en: 'Execute (F5, Ctrl+Enter): the selection, or the statement at the cursor',
    id: 'Jalankan (F5, Ctrl+Enter): pilihan, atau pernyataan di kursor',
    zh: '执行（F5、Ctrl+Enter）：所选内容或光标处的语句',
  },
  'ps.qt.explain': { en: 'Explain (F7)', id: 'Explain (F7)', zh: '解释（F7）' },
  'ps.qt.explainAnalyze': {
    en: 'Explain analyze (runs the query)',
    id: 'Explain analyze (menjalankan kueri)',
    zh: '解释分析（会执行查询）',
  },
  'ps.qt.stop': { en: 'Stop the query', id: 'Hentikan kueri', zh: '停止查询' },
  'ps.qt.downloadCsv': {
    en: 'Save the results as CSV',
    id: 'Simpan hasil sebagai CSV',
    zh: '将结果保存为 CSV',
  },
  'ps.qt.scratchToggle': { en: 'Scratch Pad', id: 'Scratch Pad', zh: '草稿板' },
  'ps.qt.help': { en: 'Help', id: 'Bantuan', zh: '帮助' },
  'ps.qt.helpIntro': {
    en: 'Read-only SQL (PostgreSQL). Execute runs the selection, or the statement at the cursor.',
    id: 'SQL hanya baca (PostgreSQL). Jalankan memproses pilihan, atau pernyataan di kursor.',
    zh: '只读 SQL（PostgreSQL）。执行会运行所选内容或光标处的语句。',
  },
  'ps.qt.helpRun': { en: 'Execute', id: 'Jalankan', zh: '执行' },
  'ps.qt.helpExplain': { en: 'Explain the plan', id: 'Jelaskan rencana', zh: '解释执行计划' },
  'ps.qt.helpSave': {
    en: 'Save as a .sql file',
    id: 'Simpan sebagai file .sql',
    zh: '保存为 .sql 文件',
  },
  'ps.qt.helpFind': { en: 'Find and replace', id: 'Cari dan ganti', zh: '查找和替换' },
  'ps.qt.helpComment': { en: 'Comment lines', id: 'Komentari baris', zh: '注释行' },
  'ps.qt.helpCopy': {
    en: 'Copy the selected cells (whole rows with column names)',
    id: 'Salin sel terpilih (baris utuh dengan nama kolom)',
    zh: '复制所选单元格（整行时含列名）',
  },
  'ps.qt.helpLimits': {
    en: 'At most 2,000 rows are shown; a query may run 60 seconds. Datasets and ERP lists: up to 100,000 rows each (500,000 in all) are copied for a query, as you may see them, and the Messages tab says when one was larger. Results are kept for an hour, the SQL in your Query History.',
    id: 'Paling banyak 2.000 baris ditampilkan; kueri boleh berjalan 60 detik. Dataset dan daftar ERP: hingga 100.000 baris per tabel (500.000 total) disalin untuk satu kueri, sesuai hak lihat Anda, dan tab Pesan memberi tahu bila ada yang lebih besar. Hasil disimpan satu jam, SQL-nya di Riwayat Kueri Anda.',
    zh: '最多显示 2,000 行；查询最长运行 60 秒。数据集和 ERP 列表：每次查询每个表最多复制 100,000 行（总计 500,000 行），按您的查看权限复制，超出时“消息”选项卡会提示。结果保留一小时，SQL 保存在您的查询历史中。',
  },
  'ps.qt.editor': { en: 'SQL editor', id: 'Editor SQL', zh: 'SQL 编辑器' },
  'ps.qt.placeholder': {
    en: 'Write a query, e.g. select * from "Dataset name" limit 100',
    id: 'Tulis kueri, mis. select * from "Nama dataset" limit 100',
    zh: '编写查询，例如 select * from "数据集名称" limit 100',
  },
  'ps.qt.scratch': { en: 'Scratch Pad', id: 'Scratch Pad', zh: '草稿板' },
  'ps.qt.scratchHint': {
    en: 'Notes and SQL fragments; kept in this browser, never run.',
    id: 'Catatan dan potongan SQL; disimpan di browser ini, tidak pernah dijalankan.',
    zh: '笔记和 SQL 片段；保存在此浏览器中，不会被执行。',
  },
  'ps.qt.scratchHide': {
    en: 'Hide the Scratch Pad',
    id: 'Sembunyikan Scratch Pad',
    zh: '隐藏草稿板',
  },
  'ps.qt.resizeScratch': {
    en: 'Resize the editor and the Scratch Pad',
    id: 'Ubah ukuran editor dan Scratch Pad',
    zh: '调整编辑器和草稿板大小',
  },
  'ps.qt.resizeResults': {
    en: 'Resize the results',
    id: 'Ubah ukuran hasil',
    zh: '调整结果区大小',
  },

  // ─── Results ───────────────────────────────────────────────────────────────
  'ps.qt.tab.data': { en: 'Data Output', id: 'Keluaran Data', zh: '数据输出' },
  'ps.qt.tab.messages': { en: 'Messages', id: 'Pesan', zh: '消息' },
  'ps.qt.tab.notifications': { en: 'Notifications', id: 'Notifikasi', zh: '通知' },
  'ps.qt.dataOutput': { en: 'Data Output', id: 'Keluaran Data', zh: '数据输出' },
  'ps.qt.rowNumber': {
    en: 'Row number (select all)',
    id: 'Nomor baris (pilih semua)',
    zh: '行号（全选）',
  },
  'ps.qt.noResult': {
    en: 'Run a query to see its rows here.',
    id: 'Jalankan kueri untuk melihat barisnya di sini.',
    zh: '运行查询后在此查看结果行。',
  },
  'ps.qt.seeMessages': {
    en: 'No rows: see Messages.',
    id: 'Tidak ada baris: lihat Pesan.',
    zh: '没有结果行：请查看“消息”。',
  },
  'ps.qt.noRows': {
    en: 'The query returned no rows.',
    id: 'Kueri tidak mengembalikan baris.',
    zh: '查询未返回任何行。',
  },
  'ps.qt.truncatedRows': {
    en: 'Showing the first {n} rows; the query returned more. Narrow it (WHERE, LIMIT) or sync it into a dataset for all rows.',
    id: 'Menampilkan {n} baris pertama; kueri mengembalikan lebih banyak. Persempit (WHERE, LIMIT) atau sinkronkan ke dataset untuk semua baris.',
    zh: '显示前 {n} 行；查询返回了更多行。请缩小范围（WHERE、LIMIT），或同步到数据集以获取全部行。',
  },
  'ps.qt.truncatedSize': {
    en: 'Showing the first {n} rows: the result was too large to keep in full (16 MB). Select fewer or narrower columns.',
    id: 'Menampilkan {n} baris pertama: hasilnya terlalu besar untuk disimpan utuh (16 MB). Pilih kolom lebih sedikit atau lebih sempit.',
    zh: '显示前 {n} 行：结果过大，无法完整保留（16 MB）。请选择更少或更窄的列。',
  },
  'ps.qt.copied': { en: '{n} cells copied', id: '{n} sel disalin', zh: '已复制 {n} 个单元格' },
  'ps.qt.noMessages': { en: 'No messages yet.', id: 'Belum ada pesan.', zh: '暂无消息。' },
  'ps.qt.noNotifications': {
    en: 'No notifications. PostgreSQL notifications (NOTIFY) that arrive while a query on a connection runs are shown here; each query has its own read-only session, so LISTEN does not carry over.',
    id: 'Tidak ada notifikasi. Notifikasi PostgreSQL (NOTIFY) yang tiba saat kueri pada koneksi berjalan ditampilkan di sini; setiap kueri punya sesi hanya-baca sendiri, jadi LISTEN tidak berlanjut.',
    zh: '没有通知。对连接执行查询期间收到的 PostgreSQL 通知（NOTIFY）会显示在这里；每个查询使用独立的只读会话，因此 LISTEN 不会延续。',
  },
  'ps.qt.msgSuccess': {
    en: 'Query returned successfully: {n} rows in {ms} msec.',
    id: 'Kueri berhasil: {n} baris dalam {ms} md.',
    zh: '查询成功返回：{n} 行，用时 {ms} 毫秒。',
  },
  'ps.qt.sqlState': { en: 'SQL state: {code}', id: 'SQL state: {code}', zh: 'SQL 状态：{code}' },
  'ps.qt.character': { en: 'Character: {n}', id: 'Karakter: {n}', zh: '字符位置：{n}' },
  'ps.qt.msg.loaded': {
    en: 'Dataset "{name}": {rows} rows copied for this query.',
    id: 'Dataset "{name}": {rows} baris disalin untuk kueri ini.',
    zh: '数据集“{name}”：已为本次查询复制 {rows} 行。',
  },
  'ps.qt.msg.partial': {
    en: 'Dataset "{name}" has {total} rows: only the first {rows} were copied, so the result covers those rows only.',
    id: 'Dataset "{name}" memiliki {total} baris: hanya {rows} pertama yang disalin, jadi hasil hanya mencakup baris tersebut.',
    zh: '数据集“{name}”共有 {total} 行：仅复制了前 {rows} 行，结果只覆盖这些行。',
  },
  'ps.qt.msg.noAccess': {
    en: 'Dataset "{name}" was not copied: you may not query it.',
    id: 'Dataset "{name}" tidak disalin: Anda tidak boleh mengkuerinya.',
    zh: '未复制数据集“{name}”：您无权查询它。',
  },
  'ps.qt.msg.notLoaded': {
    en: 'Dataset "{name}" was not copied: at most {max} rows are copied for one query.',
    id: 'Dataset "{name}" tidak disalin: paling banyak {max} baris disalin untuk satu kueri.',
    zh: '未复制数据集“{name}”：单次查询最多复制 {max} 行。',
  },
  'ps.qt.msg.noDatasets': {
    en: 'The query names none of this Terminal\'s datasets (use the dataset\'s name as the table, in "quotes" when it has capitals or spaces).',
    id: 'Kueri tidak menyebut dataset Terminal ini (gunakan nama dataset sebagai tabel, dalam "tanda kutip" bila ada huruf besar atau spasi).',
    zh: '查询未引用此 Terminal 的任何数据集（请将数据集名称用作表名，包含大写字母或空格时加“引号”）。',
  },
  'ps.qt.msg.command': {
    en: '{command} completed ({rows} rows).',
    id: '{command} selesai ({rows} baris).',
    zh: '{command} 已完成（{rows} 行）。',
  },
  'ps.qt.msg.erpLoaded': {
    en: 'ERP list "{name}": {rows} rows copied for this query.',
    id: 'Daftar ERP "{name}": {rows} baris disalin untuk kueri ini.',
    zh: 'ERP 列表“{name}”：已为本次查询复制 {rows} 行。',
  },
  'ps.qt.msg.erpPartial': {
    en: 'ERP list "{name}" has more rows: only the first {rows} were copied, so the result covers those rows only.',
    id: 'Daftar ERP "{name}" punya lebih banyak baris: hanya {rows} pertama yang disalin, jadi hasil hanya mencakup baris tersebut.',
    zh: 'ERP 列表“{name}”的行数更多：仅复制了前 {rows} 行，结果只覆盖这些行。',
  },
  'ps.qt.msg.noErpTables': {
    en: "The query names none of this ERP's lists you may read (see them under ERPs in the Object Explorer, e.g. customers, invoices, journal_lines).",
    id: 'Kueri tidak menyebut daftar ERP ini yang boleh Anda baca (lihat di bawah ERP pada Penjelajah Objek, mis. customers, invoices, journal_lines).',
    zh: '查询未引用此 ERP 中您可读取的任何列表（见对象浏览器中的 ERP，例如 customers、invoices、journal_lines）。',
  },

  // ─── ERPs as a target ──────────────────────────────────────────────────────
  'ps.qt.erpGroup': { en: 'ERPs', id: 'ERP', zh: 'ERP' },
  'ps.qt.connectionGroup': {
    en: 'PostgreSQL connections',
    id: 'Koneksi PostgreSQL',
    zh: 'PostgreSQL 连接',
  },
  'ps.qt.erpOwn': { en: '{name} (this ERP)', id: '{name} (ERP ini)', zh: '{name}（本 ERP）' },
  'ps.qt.erpReady': {
    en: 'Sandbox copy of the ERP · {n} lists you may read',
    id: 'Salinan sandbox ERP · {n} daftar yang boleh Anda baca',
    zh: 'ERP 的沙箱副本 · 您可读取 {n} 个列表',
  },
  'ps.qt.erpNotMember': {
    en: 'You are not a member of this ERP',
    id: 'Anda bukan anggota ERP ini',
    zh: '您不是此 ERP 的成员',
  },
  'ps.qt.erpNoTables': {
    en: 'Your role in this ERP may not read its lists',
    id: 'Peran Anda di ERP ini tidak boleh membaca daftarnya',
    zh: '您在此 ERP 中的角色无权读取其列表',
  },
  'ps.wb.erpTableHint': {
    en: 'An ERP list, as you see it there · double-click to see the first 100',
    id: 'Daftar ERP, seperti yang Anda lihat di sana · klik dua kali untuk melihat 100 pertama',
    zh: 'ERP 列表（按您在该 ERP 中的权限）· 双击查看前 100 行',
  },

  // ─── Data Output: search, sort, a cell's value ─────────────────────────────
  'ps.qt.gridFilter': {
    en: 'Search the result…',
    id: 'Cari di hasil…',
    zh: '在结果中搜索…',
  },
  'ps.qt.gridShown': { en: '{n} of {total}', id: '{n} dari {total}', zh: '{total} 中的 {n}' },
  'ps.qt.gridSort': { en: 'Sort by {col}', id: 'Urutkan menurut {col}', zh: '按 {col} 排序' },
  'ps.qt.gridSortedAsc': {
    en: 'sorted by {col} ↑',
    id: 'diurutkan menurut {col} ↑',
    zh: '按 {col} 升序',
  },
  'ps.qt.gridSortedDesc': {
    en: 'sorted by {col} ↓',
    id: 'diurutkan menurut {col} ↓',
    zh: '按 {col} 降序',
  },
  'ps.qt.gridUnsort': { en: 'Original order', id: 'Urutan asli', zh: '原始顺序' },
  'ps.qt.gridNoMatch': {
    en: 'No rows contain that text.',
    id: 'Tidak ada baris yang berisi teks itu.',
    zh: '没有包含该文本的行。',
  },
  'ps.qt.cellTitle': {
    en: '{col} · row {row}',
    id: '{col} · baris {row}',
    zh: '{col} · 第 {row} 行',
  },
  'ps.qt.cellCopy': { en: 'Copy', id: 'Salin', zh: '复制' },
  'ps.qt.cellCopied': { en: 'Copied', id: 'Tersalin', zh: '已复制' },

  // ─── Format and history ────────────────────────────────────────────────────
  'ps.qt.format': {
    en: 'Format the query (or the selection) (Shift+Alt+F)',
    id: 'Rapikan kueri (atau pilihan) (Shift+Alt+F)',
    zh: '格式化查询（或所选内容）(Shift+Alt+F)',
  },
  'ps.qt.helpFormat': { en: 'Format the query', id: 'Rapikan kueri', zh: '格式化查询' },
  'ps.qt.helpCellKey': {
    en: 'Double-click / Enter',
    id: 'Klik dua kali / Enter',
    zh: '双击 / Enter',
  },
  'ps.qt.helpCell': {
    en: "A cell's whole value (JSON laid out)",
    id: 'Isi lengkap sel (JSON dirapikan)',
    zh: '单元格的完整值（JSON 已格式化）',
  },
  'ps.qt.historySearch': {
    en: 'Search the SQL…',
    id: 'Cari di SQL…',
    zh: '搜索 SQL…',
  },
  'ps.qt.historyStatus': { en: 'Status', id: 'Status', zh: '状态' },
  'ps.qt.historyAllStatus': { en: 'Any status', id: 'Semua status', zh: '所有状态' },
  'ps.qt.historyTarget': { en: 'Ran on', id: 'Dijalankan pada', zh: '运行于' },
  'ps.qt.historyAllTargets': { en: 'Anywhere', id: 'Di mana saja', zh: '全部' },
  'ps.qt.historyNoMatch': {
    en: 'No queries match.',
    id: 'Tidak ada kueri yang cocok.',
    zh: '没有匹配的查询。',
  },

  // ─── Status bar and state ──────────────────────────────────────────────────
  'ps.qt.totalRowsNone': { en: 'Total rows: —', id: 'Total baris: —', zh: '总行数：—' },
  'ps.qt.totalRows': { en: 'Total rows: {n}', id: 'Total baris: {n}', zh: '总行数：{n}' },
  'ps.qt.totalRowsFirst': {
    en: 'Total rows: first {n}',
    id: 'Total baris: {n} pertama',
    zh: '总行数：前 {n}',
  },
  'ps.qt.running': { en: 'Running… {s} s', id: 'Berjalan… {s} dtk', zh: '运行中… {s} 秒' },
  'ps.qt.done': {
    en: 'Query complete · {ms} msec',
    id: 'Kueri selesai · {ms} md',
    zh: '查询完成 · {ms} 毫秒',
  },
  'ps.qt.failed': {
    en: 'Query failed: see Messages',
    id: 'Kueri gagal: lihat Pesan',
    zh: '查询失败：请查看“消息”',
  },
  'ps.qt.cancelled': { en: 'Query cancelled', id: 'Kueri dibatalkan', zh: '查询已取消' },
  'ps.qt.cancelling': { en: 'Cancelling…', id: 'Membatalkan…', zh: '正在取消…' },
  'ps.qt.lnCol': {
    en: 'Ln {line}, Col {col}',
    id: 'Brs {line}, Kol {col}',
    zh: '行 {line}，列 {col}',
  },
  'ps.qt.selected': { en: '{n} selected', id: '{n} dipilih', zh: '已选 {n}' },
  'ps.qt.lineEnding': { en: 'Line endings', id: 'Akhir baris', zh: '换行符' },
  'ps.qt.queued': {
    en: 'Waiting for the background worker…',
    id: 'Menunggu worker latar belakang…',
    zh: '正在等待后台进程…',
  },
  'ps.qt.queuedNoWorker': {
    en: 'Waiting: the background worker is not running (Terminal → Dashboard shows its state).',
    id: 'Menunggu: worker latar belakang tidak berjalan (Terminal → Dasbor menampilkan statusnya).',
    zh: '等待中：后台进程未运行（Terminal → 仪表板显示其状态）。',
  },
  'ps.qt.executing': { en: 'Executing the query…', id: 'Menjalankan kueri…', zh: '正在执行查询…' },
  'ps.qt.notAllowed': {
    en: 'You may not run queries on this connection (see the connection bar).',
    id: 'Anda tidak boleh menjalankan kueri pada koneksi ini (lihat bilah koneksi).',
    zh: '您无权在此连接上运行查询（请查看连接栏）。',
  },
  'ps.qt.nothingToRun': {
    en: 'Nothing to run: write a statement, or select the SQL to run.',
    id: 'Tidak ada yang dijalankan: tulis pernyataan, atau pilih SQL yang akan dijalankan.',
    zh: '没有可运行的内容：请编写语句，或选中要运行的 SQL。',
  },
  'ps.qt.fileTooLarge': {
    en: 'The file is too large for the editor (at most 2 MB).',
    id: 'File terlalu besar untuk editor (maks. 2 MB).',
    zh: '文件过大，无法在编辑器中打开（最大 2 MB）。',
  },

  // ─── History ───────────────────────────────────────────────────────────────
  'ps.qt.historyEmpty': {
    en: 'No queries yet. Your last 200 queries in this Terminal are listed here.',
    id: 'Belum ada kueri. 200 kueri terakhir Anda di Terminal ini tercantum di sini.',
    zh: '暂无查询。这里会列出您在此 Terminal 中最近的 200 条查询。',
  },
  'ps.qt.historyLoad': {
    en: 'Put this query in the editor',
    id: 'Masukkan kueri ini ke editor',
    zh: '将此查询放入编辑器',
  },
  'ps.qt.msShort': { en: '{n} ms', id: '{n} md', zh: '{n} 毫秒' },
  'ps.qt.rowsShort': { en: '{n} rows', id: '{n} baris', zh: '{n} 行' },
  'ps.qt.status.queued': { en: 'Waiting', id: 'Menunggu', zh: '等待中' },
  'ps.qt.status.running': { en: 'Running', id: 'Berjalan', zh: '运行中' },
  'ps.qt.status.succeeded': { en: 'Succeeded', id: 'Berhasil', zh: '成功' },
  'ps.qt.status.failed': { en: 'Failed', id: 'Gagal', zh: '失败' },
  'ps.qt.status.cancelled': { en: 'Cancelled', id: 'Dibatalkan', zh: '已取消' },
  'ps.qt.mode.explain': { en: 'Explain', id: 'Explain', zh: '解释' },
  'ps.qt.mode.analyze': { en: 'Explain analyze', id: 'Explain analyze', zh: '解释分析' },

  // ─── Errors ────────────────────────────────────────────────────────────────
  'ps.err.sql_empty': { en: 'The query is empty.', id: 'Kueri kosong.', zh: '查询为空。' },
  'ps.err.sql_too_long': {
    en: 'The query is too long (at most 100,000 characters).',
    id: 'Kueri terlalu panjang (maks. 100.000 karakter).',
    zh: '查询过长（最多 100,000 个字符）。',
  },
  'ps.err.sandboxStopped': {
    en: 'The query used too much memory and was stopped. Select fewer rows or columns.',
    id: 'Kueri memakai terlalu banyak memori dan dihentikan. Pilih baris atau kolom lebih sedikit.',
    zh: '查询占用内存过多已被停止。请选择更少的行或列。',
  },
} satisfies Record<string, Entry>;
