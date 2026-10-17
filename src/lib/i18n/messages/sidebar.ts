import type { Entry } from './types';

// Home sidebar: search, File menu, Add modules and documents.
export const sidebarMessages = {
  // ── Search ──
  'nav.search.label': { en: 'Search the ERP', id: 'Cari di ERP', zh: '搜索 ERP' },
  'nav.search.placeholder': { en: 'Search…', id: 'Cari…', zh: '搜索…' },
  'nav.search.hint': {
    en: 'Type at least 3 characters',
    id: 'Ketik minimal 3 karakter',
    zh: '请至少输入 3 个字符',
  },
  'nav.search.searching': { en: 'Searching…', id: 'Mencari…', zh: '正在搜索…' },
  'nav.search.noResults': {
    en: 'Nothing found in {erp}',
    id: 'Tidak ada hasil di {erp}',
    zh: '在 {erp} 中未找到结果',
  },
  'nav.search.failed': {
    en: 'Search is unavailable right now.',
    id: 'Pencarian sedang tidak tersedia.',
    zh: '搜索暂时不可用。',
  },
  'nav.search.forbidden': {
    en: 'You cannot search this ERP.',
    id: 'Anda tidak dapat mencari di ERP ini.',
    zh: '您无法搜索此 ERP。',
  },
  'nav.search.seeAll': { en: 'See all results', id: 'Lihat semua hasil', zh: '查看全部结果' },
  'nav.search.clear': { en: 'Clear search', id: 'Hapus pencarian', zh: '清除搜索' },
  'nav.search.scope': { en: 'Searching {erp}', id: 'Mencari di {erp}', zh: '正在搜索 {erp}' },

  // ── File ──
  'nav.file': { en: 'File', id: 'File', zh: '文件' },
  'nav.file.myErps': { en: 'My ERPs', id: 'ERP saya', zh: '我的 ERP' },
  'nav.file.export': { en: 'Export', id: 'Ekspor', zh: '导出' },
  'nav.file.documents': { en: 'Documents', id: 'Dokumen', zh: '文档' },
  'nav.file.active': { en: 'Active', id: 'Aktif', zh: '当前' },
  'nav.file.noErps': { en: 'No ERPs yet', id: 'Belum ada ERP', zh: '暂无 ERP' },
  'nav.file.loadFailed': {
    en: 'ERPs could not be loaded',
    id: 'Daftar ERP gagal dimuat',
    zh: '无法加载 ERP 列表',
  },
  'nav.file.exportErp': { en: 'Export ERP data', id: 'Ekspor data ERP', zh: '导出 ERP 数据' },

  // ── Add modules ──
  'nav.addModules': { en: 'Add modules', id: 'Tambah modul', zh: '添加模块' },
  'nav.terminal': { en: 'Terminal', id: 'Terminal', zh: 'Terminal' },
  'terminal.openErp': { en: 'Open the ERP', id: 'Buka ERP', zh: '打开 ERP' },
  'modules.terminal.title': {
    en: 'PrintStream Terminal',
    id: 'PrintStream Terminal',
    zh: 'PrintStream Terminal',
  },
  'modules.terminal.help': {
    en: 'Or add Terminal to an ERP (its Owner or an Admin), to work with that ERP’s data:',
    id: 'Atau tambahkan Terminal ke sebuah ERP (oleh Pemilik atau Admin-nya), untuk mengolah data ERP itu:',
    zh: '或将 Terminal 添加到某个 ERP（由其所有者或管理员），以处理该 ERP 的数据：',
  },
  'modules.terminal.ownHelp': {
    en: 'A Terminal of its own: datasets, imports, pipelines and connections, with its own members. No ERP needed, and it does not use an ERP slot.',
    id: 'Terminal tersendiri: dataset, impor, pipeline, dan koneksi, dengan anggotanya sendiri. Tidak perlu ERP dan tidak memakai slot ERP.',
    zh: '独立的 Terminal：数据集、导入、管道和连接，并有自己的成员。无需 ERP，也不占用 ERP 名额。',
  },
  'terminal.members': { en: 'Members', id: 'Anggota', zh: '成员' },
  'settings.deleteTerminal': {
    en: 'Delete this Terminal',
    id: 'Hapus Terminal ini',
    zh: '删除此 Terminal',
  },
  'settings.deleteTerminalDesc': {
    en: 'Its datasets, imports, pipelines, connections and members are removed for good. Export what you need first.',
    id: 'Dataset, impor, pipeline, koneksi, dan anggotanya dihapus permanen. Ekspor dulu yang Anda perlukan.',
    zh: '其数据集、导入、管道、连接和成员将被永久删除。请先导出所需内容。',
  },
  'settings.deleteTerminalDone': {
    en: '{name} was deleted.',
    id: '{name} telah dihapus.',
    zh: '{name} 已删除。',
  },
  'terminal.ofErp': { en: 'Terminal of the ERP', id: 'Terminal milik ERP', zh: 'ERP 的 Terminal' },
  'terminal.none': {
    en: 'No Terminal yet',
    id: 'Belum ada Terminal',
    zh: '还没有 Terminal',
  },
  'terminal.noneHint': {
    en: 'Create one: it has its own datasets and members, and you can connect it to ERPs or databases whenever you like.',
    id: 'Buat satu: punya dataset dan anggota sendiri, dan bisa dihubungkan ke ERP atau database kapan saja.',
    zh: '创建一个：它有自己的数据集和成员，可随时连接 ERP 或数据库。',
  },
  'terminal.create.title': { en: 'New Terminal', id: 'Terminal baru', zh: '新建 Terminal' },
  'terminal.create.placeholder': {
    en: 'Name, e.g. Production data',
    id: 'Nama, mis. Data produksi',
    zh: '名称，例如：生产数据',
  },
  'terminal.create.submit': { en: 'Create', id: 'Buat', zh: '创建' },
  'terminal.create.limit': {
    en: 'This account already belongs to the maximum of 10 Terminals.',
    id: 'Akun ini sudah tergabung di maksimal 10 Terminal.',
    zh: '此账户已加入最多 10 个 Terminal。',
  },
  'terminal.create.mfa': {
    en: 'Sign in with two-factor first.',
    id: 'Masuk dengan verifikasi dua langkah terlebih dahulu.',
    zh: '请先使用双重验证登录。',
  },
  'modules.terminal.added': {
    en: 'Terminal added',
    id: 'Terminal sudah ditambahkan',
    zh: '已添加 Terminal',
  },
  'modules.terminal.notAdded': { en: 'Not added', id: 'Belum ditambahkan', zh: '未添加' },
  'modules.terminal.askOwner': {
    en: 'Not added · ask the Owner or an Admin',
    id: 'Belum ditambahkan · minta ke Pemilik atau Admin',
    zh: '未添加 · 请联系所有者或管理员',
  },
  'modules.terminal.add': { en: 'Add', id: 'Tambah', zh: '添加' },
  'modules.terminal.remove': { en: 'Remove', id: 'Hapus', zh: '移除' },
  'modules.terminal.removeConfirm': {
    en: 'Remove Terminal from {name}? It is hidden and stops running; datasets and pipelines are kept and come back when you add it again.',
    id: 'Hapus Terminal dari {name}? Disembunyikan dan berhenti berjalan; dataset dan pipeline tetap disimpan dan kembali saat ditambahkan lagi.',
    zh: '从 {name} 移除 Terminal？它将被隐藏并停止运行；数据集和管道会保留，重新添加后恢复。',
  },
  'modules.terminal.failed': {
    en: 'Could not change Terminal. Only the Owner or an Admin (with two-factor) can.',
    id: 'Tidak bisa mengubah Terminal. Hanya Pemilik atau Admin (dengan dua faktor) yang bisa.',
    zh: '无法更改 Terminal。只有所有者或管理员（已启用双重验证）可以。',
  },
  'terminal.notAdded': {
    en: 'Terminal is not added to {name}.',
    id: 'Terminal belum ditambahkan ke {name}.',
    zh: '{name} 尚未添加 Terminal。',
  },
  'terminal.notAddedHint': {
    en: 'The Owner or an Admin adds it from the Dashboard: Add modules → PrintStream Terminal.',
    id: 'Pemilik atau Admin menambahkannya dari Dasbor: Tambah modul → PrintStream Terminal.',
    zh: '所有者或管理员可在仪表板中添加：添加模块 → PrintStream Terminal。',
  },
  'terminal.backToDashboard': {
    en: 'Back to the Dashboard',
    id: 'Kembali ke Dasbor',
    zh: '返回仪表板',
  },
  'modules.subtitle': {
    en: 'An account can use up to {limit} ERPs, its own included.',
    id: 'Satu akun dapat memakai hingga {limit} ERP, termasuk ERP miliknya sendiri.',
    zh: '每个账户最多可使用 {limit} 个 ERP（包括自己的）。',
  },
  'modules.used': {
    en: '{used} of {limit} ERPs used',
    id: '{used} dari {limit} ERP terpakai',
    zh: '已使用 {used}/{limit} 个 ERP',
  },
  'modules.yourErps': { en: 'Your ERPs', id: 'ERP Anda', zh: '您的 ERP' },
  'modules.open': { en: 'Open', id: 'Buka', zh: '打开' },
  'modules.ownedBy': { en: 'Owned by {email}', id: 'Milik {email}', zh: '所有者：{email}' },
  'modules.join.title': { en: 'Join an ERP', id: 'Gabung ke ERP', zh: '加入 ERP' },
  'modules.join.help': {
    en: 'Enter the access code an owner or admin of that ERP gave you.',
    id: 'Masukkan kode akses yang diberikan pemilik atau admin ERP tersebut.',
    zh: '请输入该 ERP 的所有者或管理员提供的访问码。',
  },
  'modules.join.submit': { en: 'Join', id: 'Gabung', zh: '加入' },
  'modules.join.joining': { en: 'Joining…', id: 'Bergabung…', zh: '正在加入…' },
  'modules.join.joined': {
    en: 'You joined {name} as {role}.',
    id: 'Anda bergabung ke {name} sebagai {role}.',
    zh: '您已作为{role}加入 {name}。',
  },
  'modules.limitReached': {
    en: 'You already use {limit} ERPs, the maximum. Leave or delete one first.',
    id: 'Anda sudah memakai {limit} ERP, batas maksimum. Keluar dari atau hapus salah satunya dulu.',
    zh: '您已使用 {limit} 个 ERP（上限）。请先退出或删除一个。',
  },
  'modules.create.title': { en: 'Create a new ERP', id: 'Buat ERP baru', zh: '新建 ERP' },
  'modules.create.help': {
    en: 'An ERP of your own with separate books, stock and team. Choose its currency in Settings → Currencies.',
    id: 'ERP milik Anda sendiri dengan pembukuan, stok, dan tim terpisah. Atur mata uangnya di Pengaturan → Mata uang.',
    zh: '属于您自己的 ERP，账簿、库存和团队都独立。可在 设置 → 货币 中选择其货币。',
  },
  'modules.create.placeholder': {
    en: 'Name, e.g. Branch Bandung',
    id: 'Nama, mis. Cabang Bandung',
    zh: '名称，例如 万隆分公司',
  },
  'modules.create.submit': { en: 'Create', id: 'Buat', zh: '创建' },
  'modules.create.creating': { en: 'Creating…', id: 'Membuat…', zh: '正在创建…' },
  'settings.deleteErp': { en: 'Delete this ERP', id: 'Hapus ERP ini', zh: '删除此 ERP' },
  'settings.deleteErpDesc': {
    en: 'Permanently deletes this ERP you created with everything in it: records, books, stock, employees, documents and its team. Its place in your limit is free right away. Your other ERPs, including data synced into them, are not touched. This cannot be undone.',
    id: 'Menghapus permanen ERP buatan Anda ini beserta seluruh isinya: data, pembukuan, stok, karyawan, dokumen, dan timnya. Slotnya langsung tersedia kembali. ERP Anda yang lain, termasuk data hasil sync di dalamnya, tidak tersentuh. Tindakan ini tidak dapat dibatalkan.',
    zh: '永久删除您创建的此 ERP 及其全部内容：记录、账簿、库存、员工、文档和团队。名额会立即释放。您的其他 ERP（包括同步到其中的数据）不受影响。此操作无法撤销。',
  },
  'settings.emptyErp': { en: 'Empty this ERP', id: 'Kosongkan ERP ini', zh: '清空此 ERP' },
  'settings.emptyErpDesc': {
    en: 'Every account keeps one ERP of its own, so this empties it instead of deleting it: all records, books, stock, warehouses, employees and payroll, documents, workflows, settings, sync history and the sync inbox are deleted permanently, invitations are revoked and every member but you is removed. The audit trails stay. Data synced into your other ERPs is not touched. This cannot be undone.',
    id: 'Setiap akun selalu punya satu ERP sendiri, jadi ERP ini dikosongkan, bukan dihapus: semua data, pembukuan, stok, gudang, karyawan dan penggajian, dokumen, workflow, pengaturan, riwayat sync, dan kotak masuk sync dihapus permanen; undangan dicabut dan semua anggota selain Anda dikeluarkan. Jejak audit tetap disimpan. Data hasil sync di ERP Anda yang lain tidak tersentuh. Tindakan ini tidak dapat dibatalkan.',
    zh: '每个账户都保留一个自己的 ERP，因此此操作会清空而非删除它：所有记录、账簿、库存、仓库、员工和工资、文档、工作流、设置、同步记录和同步收件箱都将被永久删除，邀请将被撤销，除您以外的成员都将被移除。审计记录保留。同步到您其他 ERP 的数据不受影响。此操作无法撤销。',
  },
  'settings.emptyErpDone': {
    en: '{name} was emptied.',
    id: '{name} telah dikosongkan.',
    zh: '已清空 {name}。',
  },
  'settings.deleteErpNameMismatch': {
    en: 'Type the ERP’s name exactly as shown.',
    id: 'Ketik nama ERP persis seperti yang tertera.',
    zh: '请准确输入所显示的 ERP 名称。',
  },
  'settings.deleteErpDone': {
    en: '{name} was deleted.',
    id: '{name} telah dihapus.',
    zh: '已删除 {name}。',
  },
  'settings.deleteErpPersonal': {
    en: 'Your own ERP cannot be deleted; reset it instead.',
    id: 'ERP milik akun Anda sendiri tidak bisa dihapus; reset saja.',
    zh: '您账户自己的 ERP 无法删除，请改为重置。',
  },

  // ── Documents ──
  'erp.nav.documents': { en: 'Documents', id: 'Dokumen', zh: '文档' },
  'docs.subtitle': {
    en: 'Files shared with every member of {erp}. Up to 10 MB per file.',
    id: 'File yang dibagikan ke semua anggota {erp}. Maksimal 10 MB per file.',
    zh: '与 {erp} 的所有成员共享的文件。每个文件最大 10 MB。',
  },
  'docs.upload': { en: 'Upload file', id: 'Unggah file', zh: '上传文件' },
  'docs.uploading': { en: 'Uploading…', id: 'Mengunggah…', zh: '正在上传…' },
  'docs.empty': {
    en: 'No documents yet. Upload invoices, contracts or receipts to keep them with this ERP.',
    id: 'Belum ada dokumen. Unggah faktur, kontrak, atau kuitansi agar tersimpan bersama ERP ini.',
    zh: '暂无文档。上传发票、合同或收据，与此 ERP 一同保存。',
  },
  'docs.col.name': { en: 'Name', id: 'Nama', zh: '名称' },
  'docs.col.size': { en: 'Size', id: 'Ukuran', zh: '大小' },
  'docs.col.uploadedBy': { en: 'Uploaded by', id: 'Diunggah oleh', zh: '上传者' },
  'docs.col.date': { en: 'Date', id: 'Tanggal', zh: '日期' },
  'docs.download': { en: 'Download {name}', id: 'Unduh {name}', zh: '下载 {name}' },
  'docs.delete': { en: 'Delete {name}', id: 'Hapus {name}', zh: '删除 {name}' },
  'docs.confirmDelete': {
    en: 'Delete "{name}"? This cannot be undone.',
    id: 'Hapus "{name}"? Tindakan ini tidak bisa dibatalkan.',
    zh: '删除“{name}”？此操作无法撤销。',
  },
  'docs.uploaded': { en: 'Uploaded {name}', id: '{name} diunggah', zh: '已上传 {name}' },
  'docs.deleted': { en: 'Document deleted', id: 'Dokumen dihapus', zh: '文档已删除' },
  'audit.document.uploaded': { en: 'Document uploaded', id: 'Dokumen diunggah', zh: '文档已上传' },
  'audit.document.deleted': { en: 'Document deleted', id: 'Dokumen dihapus', zh: '文档已删除' },
  'docs.unknownUploader': { en: 'A former member', id: 'Mantan anggota', zh: '前成员' },
  'docs.error.fileType': {
    en: 'This file type is not allowed. Use PDF, images, Office or text files.',
    id: 'Jenis file ini tidak diizinkan. Gunakan PDF, gambar, Office, atau file teks.',
    zh: '不允许此文件类型。请使用 PDF、图片、Office 或文本文件。',
  },
  'docs.error.tooLarge': {
    en: 'Files can be at most 10 MB.',
    id: 'Ukuran file maksimal 10 MB.',
    zh: '文件最大为 10 MB。',
  },
  'docs.error.empty': { en: 'The file is empty.', id: 'File kosong.', zh: '文件为空。' },
  'docs.error.quota': {
    en: 'This company has used its storage quota. Ask your Owner to free space or request more from ETNA.',
    id: 'Kuota penyimpanan perusahaan ini sudah habis. Minta Pemilik mengosongkan ruang atau meminta tambahan ke ETNA.',
    zh: '该公司的存储配额已用完。请让所有者释放空间或向 ETNA 申请更多空间。',
  },
  'docs.error.full': {
    en: 'This ERP has no room for more documents (1 GB in total).',
    id: 'ERP ini tidak punya ruang untuk dokumen lagi (total 1 GB).',
    zh: '此 ERP 的文档空间已满（共 1 GB）。',
  },
  'docs.error.forbidden': {
    en: 'You are not allowed to do that in this ERP.',
    id: 'Anda tidak diizinkan melakukan itu di ERP ini.',
    zh: '您无权在此 ERP 中执行此操作。',
  },
  'docs.error.notFound': {
    en: 'The document no longer exists.',
    id: 'Dokumen sudah tidak ada.',
    zh: '该文档已不存在。',
  },
  'docs.error.failed': {
    en: 'Something went wrong. Please try again.',
    id: 'Terjadi kesalahan. Silakan coba lagi.',
    zh: '出现问题，请重试。',
  },
} satisfies Record<string, Entry>;
