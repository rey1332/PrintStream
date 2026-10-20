import type { Entry } from './types';

// Admin panel: companies, usage and modules, ERP limits, announcements,
// system and backups, exports, sign-in history, e-mail (20261012000028).
export const platformAdminOpsMessages = {
  'padmin.nav.announcements': { en: 'Announcements', id: 'Pengumuman', zh: '公告' },
  'padmin.nav.system': { en: 'System & backups', id: 'Sistem & cadangan', zh: '系统与备份' },

  'padmin.event.COMPANY_CREATED': {
    en: 'Company created',
    id: 'Perusahaan dibuat',
    zh: '已创建公司',
  },
  'padmin.event.ACCOUNT_ERP_LIMIT_CHANGED': {
    en: 'ERP limit changed',
    id: 'Batas ERP diubah',
    zh: 'ERP 上限已更改',
  },
  'padmin.event.WORKSPACE_MODULES_CHANGED': {
    en: 'Modules changed',
    id: 'Modul diubah',
    zh: '模块已更改',
  },
  'padmin.event.ANNOUNCEMENT_CREATED': {
    en: 'Announcement published',
    id: 'Pengumuman diterbitkan',
    zh: '已发布公告',
  },
  'padmin.event.ANNOUNCEMENT_CANCELLED': {
    en: 'Announcement withdrawn',
    id: 'Pengumuman ditarik',
    zh: '已撤回公告',
  },
  'padmin.event.BACKUP_STARTED': {
    en: 'Backup started',
    id: 'Pencadangan dimulai',
    zh: '已开始备份',
  },
  'padmin.event.EMAIL_TEST_SENT': {
    en: 'Test e-mail sent',
    id: 'E-mail uji dikirim',
    zh: '已发送测试邮件',
  },
  'padmin.event.ADMIN_EXPORT': { en: 'Data exported', id: 'Data diekspor', zh: '已导出数据' },
  'padmin.event.INVITE_EMAILED': {
    en: 'Link e-mailed',
    id: 'Tautan dikirim via e-mail',
    zh: '已通过邮件发送链接',
  },

  'padmin.err.busy': {
    en: 'A backup is already running.',
    id: 'Pencadangan sedang berjalan.',
    zh: '已有备份正在进行。',
  },
  'padmin.err.mail_off': {
    en: 'E-mail is not set up.',
    id: 'E-mail belum diatur.',
    zh: '尚未设置邮件。',
  },
  'padmin.err.mail_failed': {
    en: 'The e-mail could not be sent. Check the SMTP settings.',
    id: 'E-mail tidak dapat dikirim. Periksa pengaturan SMTP.',
    zh: '邮件发送失败，请检查 SMTP 设置。',
  },

  'padmin.co.new': { en: 'New company', id: 'Perusahaan baru', zh: '新公司' },
  'padmin.co.title': { en: 'New client company', id: 'Perusahaan klien baru', zh: '新客户公司' },
  'padmin.co.help': {
    en: 'Creates an ERP for the company with its Owner. A new Owner gets an account and an invitation link; an existing account gets the ERP among theirs.',
    id: 'Membuat ERP untuk perusahaan beserta Pemiliknya. Pemilik baru mendapat akun dan tautan undangan; akun yang sudah ada mendapat ERP ini di daftarnya.',
    zh: '为公司创建 ERP 并设定所有者。新所有者将获得账户和邀请链接；已有账户则直接获得该 ERP。',
  },
  'padmin.co.name': { en: 'Company name', id: 'Nama perusahaan', zh: '公司名称' },
  'padmin.co.ownerEmail': { en: 'Owner’s e-mail', id: 'E-mail pemilik', zh: '所有者邮箱' },
  'padmin.co.ownerName': {
    en: 'Owner’s name (for a new account)',
    id: 'Nama pemilik (untuk akun baru)',
    zh: '所有者姓名（新账户）',
  },
  'padmin.co.reason': {
    en: 'Reason (kept in the security log)',
    id: 'Alasan (disimpan di log keamanan)',
    zh: '原因（记入安全日志）',
  },
  'padmin.co.create': { en: 'Create company', id: 'Buat perusahaan', zh: '创建公司' },
  'padmin.co.created': {
    en: 'Company “{name}” created.',
    id: 'Perusahaan “{name}” dibuat.',
    zh: '已创建公司“{name}”。',
  },
  'padmin.co.existingOwner': {
    en: 'The Owner already had an account: the company is now among their ERPs.',
    id: 'Pemilik sudah punya akun: perusahaan kini ada di daftar ERP-nya.',
    zh: '所有者已有账户：该公司已加入其 ERP 列表。',
  },
  'padmin.co.open': { en: 'Open the company', id: 'Buka perusahaan', zh: '打开公司' },

  'padmin.mail.send': {
    en: 'Also e-mail the link',
    id: 'Kirim juga tautannya via e-mail',
    zh: '同时通过邮件发送链接',
  },
  'padmin.mail.sent': {
    en: 'The link was e-mailed.',
    id: 'Tautan sudah dikirim via e-mail.',
    zh: '链接已通过邮件发送。',
  },
  'padmin.mail.failed': {
    en: 'The e-mail could not be sent; copy the link and send it yourself.',
    id: 'E-mail tidak terkirim; salin tautan dan kirim sendiri.',
    zh: '邮件发送失败；请复制链接自行发送。',
  },
  'padmin.mail.off': {
    en: 'E-mail is not set up (System & backups); copy the link and send it yourself.',
    id: 'E-mail belum diatur (Sistem & cadangan); salin tautan dan kirim sendiri.',
    zh: '尚未设置邮件（系统与备份）；请复制链接自行发送。',
  },

  'padmin.usage.title': {
    en: 'Usage, industry and modules',
    id: 'Pemakaian, industri, dan modul',
    zh: '使用情况、行业与模块',
  },
  'padmin.usage.documents': { en: 'Documents', id: 'Dokumen', zh: '文档' },
  'padmin.usage.documentsValue': {
    en: '{count} files · {size}',
    id: '{count} berkas · {size}',
    zh: '{count} 个文件 · {size}',
  },
  'padmin.usage.customers': { en: 'Customers', id: 'Pelanggan', zh: '客户' },
  'padmin.usage.suppliers': { en: 'Suppliers', id: 'Pemasok', zh: '供应商' },
  'padmin.usage.products': { en: 'Products', id: 'Produk', zh: '产品' },
  'padmin.usage.sales_orders': { en: 'Sales orders', id: 'Pesanan penjualan', zh: '销售订单' },
  'padmin.usage.purchase_orders': {
    en: 'Purchase orders',
    id: 'Pesanan pembelian',
    zh: '采购订单',
  },
  'padmin.usage.invoices': { en: 'Invoices', id: 'Faktur', zh: '发票' },
  'padmin.usage.payments': { en: 'Payments', id: 'Pembayaran', zh: '付款' },
  'padmin.usage.journal_entries': { en: 'Journal entries', id: 'Jurnal', zh: '分录' },
  'padmin.usage.employees': { en: 'Employees', id: 'Karyawan', zh: '员工' },
  'padmin.usage.weigh_tickets': { en: 'Weigh tickets', id: 'Tiket timbang', zh: '过磅单' },
  'padmin.usage.production_runs': { en: 'Production runs', id: 'Produksi', zh: '生产记录' },
  'padmin.usage.equipment': { en: 'Machines', id: 'Alat berat', zh: '设备' },
  'padmin.usage.reason': { en: 'Reason for the change', id: 'Alasan perubahan', zh: '更改原因' },
  'padmin.usage.save': {
    en: 'Save industry and modules',
    id: 'Simpan industri dan modul',
    zh: '保存行业与模块',
  },
  'padmin.usage.saved': {
    en: 'Industry and modules saved.',
    id: 'Industri dan modul disimpan.',
    zh: '行业与模块已保存。',
  },

  'padmin.limit.title': { en: 'ERP limit', id: 'Batas ERP', zh: 'ERP 上限' },
  'padmin.limit.value': {
    en: 'May belong to {limit} ERPs ({used} now)',
    id: 'Boleh tergabung di {limit} ERP (sekarang {used})',
    zh: '最多可加入 {limit} 个 ERP（当前 {used} 个）',
  },
  'padmin.limit.default': { en: 'the default', id: 'bawaan', zh: '默认值' },
  'padmin.limit.custom': {
    en: 'set for this account',
    id: 'diatur untuk akun ini',
    zh: '为此账户单独设置',
  },
  'padmin.limit.unlimited': {
    en: 'Platform admins have no ERP limit.',
    id: 'Admin platform tidak dibatasi jumlah ERP.',
    zh: '平台管理员不受 ERP 数量限制。',
  },
  'padmin.limit.new': {
    en: 'New limit (empty = default)',
    id: 'Batas baru (kosong = bawaan)',
    zh: '新上限（留空为默认）',
  },
  'padmin.limit.save': { en: 'Save limit', id: 'Simpan batas', zh: '保存上限' },
  'padmin.limit.saved': {
    en: 'ERP limit saved.',
    id: 'Batas ERP disimpan.',
    zh: 'ERP 上限已保存。',
  },

  'padmin.logins.title': { en: 'Sign-in history', id: 'Riwayat masuk', zh: '登录记录' },
  'padmin.logins.empty': {
    en: 'No sign-ins recorded.',
    id: 'Belum ada catatan masuk.',
    zh: '暂无登录记录。',
  },
  'padmin.logins.when': { en: 'When', id: 'Waktu', zh: '时间' },
  'padmin.logins.what': { en: 'What', id: 'Kejadian', zh: '事件' },
  'padmin.logins.ip': { en: 'IP address', id: 'Alamat IP', zh: 'IP 地址' },
  'padmin.logins.device': { en: 'Device', id: 'Perangkat', zh: '设备' },

  'padmin.export.csv': { en: 'Export CSV', id: 'Ekspor CSV', zh: '导出 CSV' },

  'padmin.ann.subtitle': {
    en: 'A banner at the top of the ERP, for everyone or one ERP, between a start and an optional end.',
    id: 'Spanduk di atas ERP, untuk semua orang atau satu ERP, dari waktu mulai sampai waktu selesai (opsional).',
    zh: '显示在 ERP 顶部的横幅，可面向所有人或单个 ERP，有开始时间和可选的结束时间。',
  },
  'padmin.ann.new': { en: 'New announcement', id: 'Pengumuman baru', zh: '新公告' },
  'padmin.ann.message': { en: 'Message', id: 'Pesan', zh: '内容' },
  'padmin.ann.level': { en: 'Kind', id: 'Jenis', zh: '类型' },
  'padmin.ann.level.info': { en: 'Information', id: 'Informasi', zh: '信息' },
  'padmin.ann.level.warning': { en: 'Warning', id: 'Peringatan', zh: '警告' },
  'padmin.ann.level.maintenance': { en: 'Maintenance', id: 'Pemeliharaan', zh: '维护' },
  'padmin.ann.scope': { en: 'Shown to', id: 'Ditampilkan ke', zh: '显示对象' },
  'padmin.ann.everyone': { en: 'Everyone', id: 'Semua orang', zh: '所有人' },
  'padmin.ann.workspace': {
    en: 'One ERP (its ID from Workspaces)',
    id: 'Satu ERP (ID dari Workspace)',
    zh: '单个 ERP（工作区 ID）',
  },
  'padmin.ann.starts': { en: 'From', id: 'Mulai', zh: '开始' },
  'padmin.ann.ends': { en: 'Until (optional)', id: 'Sampai (opsional)', zh: '结束（可选）' },
  'padmin.ann.create': { en: 'Publish', id: 'Terbitkan', zh: '发布' },
  'padmin.ann.created': {
    en: 'Announcement published.',
    id: 'Pengumuman diterbitkan.',
    zh: '公告已发布。',
  },
  'padmin.ann.cancel': { en: 'Withdraw', id: 'Tarik', zh: '撤回' },
  'padmin.ann.empty': {
    en: 'No announcements yet.',
    id: 'Belum ada pengumuman.',
    zh: '暂无公告。',
  },
  'padmin.ann.state.active': { en: 'Showing', id: 'Tampil', zh: '显示中' },
  'padmin.ann.state.scheduled': { en: 'Scheduled', id: 'Terjadwal', zh: '已排期' },
  'padmin.ann.state.ended': { en: 'Ended', id: 'Selesai', zh: '已结束' },
  'padmin.ann.state.cancelled': { en: 'Withdrawn', id: 'Ditarik', zh: '已撤回' },

  'padmin.sys.subtitle': {
    en: 'The database, disk, backups and e-mail of this PrintStream server.',
    id: 'Basis data, disk, cadangan, dan e-mail server PrintStream ini.',
    zh: '本 PrintStream 服务器的数据库、磁盘、备份和邮件。',
  },
  'padmin.sys.database': { en: 'Database', id: 'Basis data', zh: '数据库' },
  'padmin.sys.size': { en: 'Size', id: 'Ukuran', zh: '大小' },
  'padmin.sys.latency': { en: 'Response time', id: 'Waktu respons', zh: '响应时间' },
  'padmin.sys.down': { en: 'Not answering', id: 'Tidak merespons', zh: '无响应' },
  'padmin.sys.disk': {
    en: 'Disk (backup drive)',
    id: 'Disk (drive cadangan)',
    zh: '磁盘（备份盘）',
  },
  'padmin.sys.diskValue': {
    en: '{free} free of {total}',
    id: '{free} kosong dari {total}',
    zh: '共 {total}，可用 {free}',
  },
  'padmin.sys.diskLow': {
    en: 'Less than 10% free: backups may fail soon.',
    id: 'Kurang dari 10% kosong: cadangan bisa segera gagal.',
    zh: '可用空间不足 10%：备份可能很快失败。',
  },
  'padmin.sys.app': { en: 'App', id: 'Aplikasi', zh: '应用' },
  'padmin.sys.uptime': {
    en: 'running for {hours} h · Node {node}',
    id: 'berjalan {hours} jam · Node {node}',
    zh: '已运行 {hours} 小时 · Node {node}',
  },
  'padmin.sys.backups': { en: 'Backups', id: 'Cadangan', zh: '备份' },
  'padmin.sys.runBackup': { en: 'Back up now', id: 'Cadangkan sekarang', zh: '立即备份' },
  'padmin.sys.backupDone': { en: 'Backup finished.', id: 'Pencadangan selesai.', zh: '备份完成。' },
  'padmin.sys.backupNone': { en: 'No backups yet.', id: 'Belum ada cadangan.', zh: '暂无备份。' },
  'padmin.sys.backupOff': {
    en: 'Backups are not set up on this server (see docs/teknis/OPERATIONS.md).',
    id: 'Pencadangan belum diatur di server ini (lihat docs/teknis/OPERATIONS.md).',
    zh: '本服务器尚未设置备份（见 docs/teknis/OPERATIONS.md）。',
  },
  'padmin.sys.offsite': {
    en: 'Copy the backups to another place regularly (USB drive, cloud folder): a backup on the same computer is lost with it.',
    id: 'Salin cadangan ke tempat lain secara rutin (flashdisk, folder cloud): cadangan di komputer yang sama ikut hilang bersamanya.',
    zh: '请定期将备份复制到其他位置（U 盘、云文件夹）：与服务器在同一台电脑上的备份会随之丢失。',
  },
  'padmin.sys.email': { en: 'E-mail', id: 'E-mail', zh: '邮件' },
  'padmin.sys.emailOn': {
    en: 'Sending as {sender}',
    id: 'Mengirim sebagai {sender}',
    zh: '发件人：{sender}',
  },
  'padmin.sys.emailOff': {
    en: 'Not set up. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and SMTP_FROM to .env.local and restart PrintStream (docs/teknis/CONFIGURATION.md).',
    id: 'Belum diatur. Tambahkan SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, dan SMTP_FROM ke .env.local lalu mulai ulang PrintStream (docs/teknis/CONFIGURATION.md).',
    zh: '尚未设置。请在 .env.local 中添加 SMTP_HOST、SMTP_PORT、SMTP_USER、SMTP_PASSWORD 和 SMTP_FROM，然后重启 PrintStream（见 docs/teknis/CONFIGURATION.md）。',
  },
  'padmin.sys.testTo': {
    en: 'Send a test e-mail to',
    id: 'Kirim e-mail uji ke',
    zh: '发送测试邮件至',
  },
  'padmin.sys.test': { en: 'Send test', id: 'Kirim uji', zh: '发送测试' },
  'padmin.sys.testSent': {
    en: 'Test e-mail sent.',
    id: 'E-mail uji terkirim.',
    zh: '测试邮件已发送。',
  },
} satisfies Record<string, Entry>;
