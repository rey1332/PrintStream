import type { Entry } from './types';

// Sync between ERPs: the ERP list, running a sync and the sync inbox.
export const syncMessages = {
  // ── Navigation ──
  'erp.nav.sync': { en: 'ERPs & sync', id: 'ERP & sync', zh: 'ERP 与同步' },
  'erp.nav.syncInbox': { en: 'Sync inbox', id: 'Masuk dari sync', zh: '同步收件箱' },
  'nav.file.manageErps': {
    en: 'Manage ERPs & sync',
    id: 'Kelola ERP & sync',
    zh: '管理 ERP 与同步',
  },

  // ── ERP list ──
  'sync.subtitle': {
    en: 'Your ERPs. Tick two or more to sync data between them; each ERP keeps its own books.',
    id: 'ERP Anda. Centang dua atau lebih untuk menyinkronkan data; setiap ERP tetap punya pembukuan sendiri.',
    zh: '您的 ERP。勾选两个或以上即可在它们之间同步数据；每个 ERP 保留各自的账簿。',
  },
  'sync.col.erp': { en: 'ERP', id: 'ERP', zh: 'ERP' },
  'sync.col.currency': { en: 'Currency', id: 'Mata uang', zh: '币种' },
  'sync.col.members': { en: 'Members', id: 'Anggota', zh: '成员' },
  'sync.col.included': { en: 'In sync', id: 'Ikut sync', zh: '参与同步' },
  'sync.col.lastSync': { en: 'Last sync', id: 'Sync terakhir', zh: '上次同步' },
  'sync.select': { en: 'Select {name}', id: 'Pilih {name}', zh: '选择 {name}' },
  'sync.personal': { en: 'Your own', id: 'Milik Anda', zh: '您自己的' },
  'sync.created': { en: 'Created by you', id: 'Buatan Anda', zh: '您创建的' },
  'sync.joined': { en: 'Joined', id: 'Bergabung', zh: '已加入' },
  'sync.never': { en: 'Never', id: 'Belum pernah', zh: '从未' },
  'sync.cannot': {
    en: 'Only an Owner or Admin can sync this ERP',
    id: 'Hanya Owner atau Admin yang bisa sync ERP ini',
    zh: '只有所有者或管理员可以同步此 ERP',
  },
  'sync.excluded': {
    en: 'Left out of sync (turn on “In sync”)',
    id: 'Tidak ikut sync (nyalakan “Ikut sync”)',
    zh: '未参与同步（请打开“参与同步”）',
  },
  'sync.includedOn': {
    en: '{name} is included in sync',
    id: '{name} ikut sync',
    zh: '{name} 已参与同步',
  },
  'sync.includedOff': {
    en: '{name} is left out of sync',
    id: '{name} tidak ikut sync',
    zh: '{name} 已退出同步',
  },
  'sync.selectHint': {
    en: 'Tick two or more ERPs to sync them.',
    id: 'Centang dua ERP atau lebih untuk sync.',
    zh: '勾选两个或以上 ERP 以进行同步。',
  },
  'sync.selected': { en: '{n} selected', id: '{n} dipilih', zh: '已选 {n} 个' },
  'sync.button': { en: 'Sync', id: 'Sync', zh: '同步' },
  'sync.chooseDirection': { en: 'Choose direction', id: 'Pilih arah', zh: '选择方向' },
  'sync.dir.push': { en: 'Push', id: 'Push', zh: '推送' },
  'sync.dir.pull': { en: 'Pull', id: 'Pull', zh: '拉取' },
  'sync.dir.both': { en: 'Both ways', id: 'Dua arah', zh: '双向' },
  'sync.dir.pushHint': {
    en: 'Source → targets',
    id: 'Sumber → tujuan',
    zh: '源 → 目标',
  },
  'sync.dir.pullHint': {
    en: 'Targets → source',
    id: 'Tujuan → sumber',
    zh: '目标 → 源',
  },
  'sync.dir.bothHint': {
    en: 'Newest change wins, both ways',
    id: 'Perubahan terbaru menang, dua arah',
    zh: '双向，以最新修改为准',
  },
  'sync.leave': { en: 'Leave this ERP', id: 'Keluar dari ERP ini', zh: '退出此 ERP' },
  'sync.leaveTitle': { en: 'Leave {name}?', id: 'Keluar dari {name}?', zh: '退出 {name}？' },
  'sync.leaveBody': {
    en: 'You lose access to {name} and its place in your limit of three ERPs is free again. Its data stays with its owner, who can invite you again.',
    id: 'Akses Anda ke {name} dicabut dan slotnya di batas 3 ERP langsung tersedia kembali. Datanya tetap aman di pemiliknya, yang bisa mengundang Anda lagi.',
    zh: '您将失去对 {name} 的访问权限，并释放三个 ERP 名额中的一个。其数据仍归所有者所有，所有者可以再次邀请您。',
  },
  'sync.leftToast': { en: 'You left {name}', id: 'Anda keluar dari {name}', zh: '您已退出 {name}' },
  'sync.deleteTitle': { en: 'Delete {name}', id: 'Hapus {name}', zh: '删除 {name}' },

  // ── Running a sync ──
  'sync.dialog.title': { en: 'Sync ERPs', id: 'Sync ERP', zh: '同步 ERP' },
  'sync.dialog.source': { en: 'Source ERP', id: 'ERP sumber', zh: '源 ERP' },
  'sync.dialog.targets': { en: 'Target ERPs', id: 'ERP tujuan', zh: '目标 ERP' },
  'sync.dialog.direction': { en: 'Direction', id: 'Arah', zh: '方向' },
  'sync.dialog.what': { en: 'What to sync', id: 'Data yang di-sync', zh: '同步内容' },
  'sync.dialog.since': {
    en: 'Documents dated from',
    id: 'Dokumen sejak tanggal',
    zh: '单据起始日期',
  },
  'sync.dialog.sinceHint': {
    en: 'Orders, invoices and payments from this date that are not in the other ERP yet.',
    id: 'Order, invoice, dan pembayaran sejak tanggal ini yang belum ada di ERP lain.',
    zh: '自此日期起、尚未在另一 ERP 中的订单、发票和付款。',
  },
  'sync.dialog.rules': {
    en: 'Rows are matched by e-mail or SKU (else name). The most recent change to each field wins; deletions are not synced. Prices are converted with the target ERP’s exchange rate.',
    id: 'Baris dicocokkan lewat email atau SKU (jika kosong, nama). Perubahan terbaru per kolom yang menang; penghapusan tidak ikut. Harga dikonversi memakai kurs di ERP tujuan.',
    zh: '按邮箱或 SKU（否则按名称）匹配记录。每个字段以最新修改为准；删除不会同步。价格按目标 ERP 的汇率换算。',
  },
  'sync.dialog.start': { en: 'Start sync', id: 'Mulai sync', zh: '开始同步' },
  'sync.dialog.progress': {
    en: 'Syncing {done} of {total}…',
    id: 'Sync {done} dari {total}…',
    zh: '正在同步 {done}/{total}…',
  },
  'sync.dialog.step': {
    en: '{entity} with {erp}',
    id: '{entity} dengan {erp}',
    zh: '与 {erp} 同步{entity}',
  },
  'sync.dialog.done': { en: 'Sync finished', id: 'Sync selesai', zh: '同步完成' },
  'sync.dialog.stopped': {
    en: 'Sync stopped. The steps before the error were kept.',
    id: 'Sync berhenti. Langkah sebelum error tetap tersimpan.',
    zh: '同步已停止。出错前完成的步骤已保留。',
  },
  'sync.entity.customers': { en: 'Customers', id: 'Pelanggan', zh: '客户' },
  'sync.entity.suppliers': { en: 'Suppliers', id: 'Pemasok', zh: '供应商' },
  'sync.entity.products': { en: 'Products', id: 'Produk', zh: '产品' },
  'sync.entity.stock': { en: 'Stock levels', id: 'Stok produk', zh: '库存数量' },
  'sync.entity.sales_orders': { en: 'Sales orders', id: 'Sales order', zh: '销售订单' },
  'sync.entity.purchase_orders': { en: 'Purchase orders', id: 'Purchase order', zh: '采购订单' },
  'sync.entity.invoices': { en: 'Invoices', id: 'Invoice', zh: '发票' },
  'sync.entity.payments': { en: 'Payments', id: 'Pembayaran', zh: '付款' },
  'sync.group.master': { en: 'Master data', id: 'Data master', zh: '主数据' },
  'sync.group.documents': { en: 'Transactions', id: 'Transaksi', zh: '交易' },
  'sync.hint.stock': {
    en: 'Stock differences are booked as stock adjustments.',
    id: 'Selisih stok dibukukan sebagai penyesuaian stok.',
    zh: '库存差异记为库存调整。',
  },
  'sync.hint.documents': {
    en: 'Copied once: orders as draft or pending; invoices and payments wait in the other ERP’s sync inbox until someone posts them.',
    id: 'Disalin sekali: order sebagai draft/pending; invoice dan pembayaran menunggu di kotak masuk sync ERP tujuan sampai diposting.',
    zh: '仅复制一次：订单为草稿或待审批；发票和付款在另一 ERP 的同步收件箱中等待过账。',
  },
  'sync.count.ok': { en: 'Synced', id: 'Berhasil', zh: '成功' },
  'sync.count.skipped': { en: 'Skipped', id: 'Dilewati', zh: '跳过' },
  'sync.count.failed': { en: 'Failed', id: 'Gagal', zh: '失败' },
  'sync.summary': {
    en: '{ok} synced · {skipped} skipped · {failed} failed',
    id: '{ok} berhasil · {skipped} dilewati · {failed} gagal',
    zh: '{ok} 成功 · {skipped} 跳过 · {failed} 失败',
  },
  'sync.status.success': { en: 'Succeeded', id: 'Berhasil', zh: '成功' },
  'sync.status.partial': { en: 'Partly failed', id: 'Sebagian gagal', zh: '部分失败' },
  'sync.status.failed': { en: 'Failed', id: 'Gagal', zh: '失败' },
  'sync.status.running': { en: 'Running', id: 'Berjalan', zh: '进行中' },
  'sync.notes': { en: 'Notes', id: 'Catatan', zh: '备注' },

  // ── Pairs and history ──
  'sync.pairs.title': {
    en: 'Last sync per pair',
    id: 'Sync terakhir per pasangan',
    zh: '每对 ERP 的上次同步',
  },
  'sync.pairs.empty': {
    en: 'No sync has run yet.',
    id: 'Belum ada sync.',
    zh: '尚未进行同步。',
  },
  'sync.runs.title': { en: 'Recent syncs', id: 'Riwayat sync', zh: '最近的同步' },
  'sync.runs.by': { en: 'by {email}', id: 'oleh {email}', zh: '由 {email}' },
  'sync.runs.details': { en: 'Details', id: 'Detail', zh: '详情' },
  'sync.removedErp': { en: 'Deleted ERP', id: 'ERP terhapus', zh: '已删除的 ERP' },

  // ── Inbox ──
  'sync.inbox.subtitle': {
    en: 'Invoices and payments synced into {erp}. Posting books them here with their journal, as if entered in this ERP.',
    id: 'Invoice dan pembayaran hasil sync ke {erp}. Memposting akan membukukannya di sini beserta jurnalnya, seperti dimasukkan langsung di ERP ini.',
    zh: '同步到 {erp} 的发票和付款。过账后会在此记账并生成分录，如同在本 ERP 中录入。',
  },
  'sync.inbox.pending': { en: 'Waiting', id: 'Menunggu', zh: '待处理' },
  'sync.inbox.handled': { en: 'Handled', id: 'Sudah diproses', zh: '已处理' },
  'sync.inbox.empty': {
    en: 'Nothing is waiting. Synced invoices and payments appear here.',
    id: 'Tidak ada yang menunggu. Invoice dan pembayaran hasil sync muncul di sini.',
    zh: '没有待处理的项目。同步的发票和付款会显示在这里。',
  },
  'sync.inbox.kind': { en: 'Type', id: 'Jenis', zh: '类型' },
  'sync.inbox.kind.invoice': { en: 'Invoice', id: 'Invoice', zh: '发票' },
  'sync.inbox.kind.payment': { en: 'Payment', id: 'Pembayaran', zh: '付款' },
  'sync.inbox.from': { en: 'From', id: 'Dari', zh: '来自' },
  'sync.inbox.party': { en: 'Customer / party', id: 'Pelanggan / pihak', zh: '客户 / 对方' },
  'sync.inbox.due': { en: 'Due {date}', id: 'Jatuh tempo {date}', zh: '到期 {date}' },
  'sync.inbox.incoming': { en: 'Received', id: 'Diterima', zh: '收款' },
  'sync.inbox.outgoing': { en: 'Paid out', id: 'Dibayar', zh: '付款' },
  'sync.inbox.post': { en: 'Post', id: 'Posting', zh: '过账' },
  'sync.inbox.dismiss': { en: 'Dismiss', id: 'Abaikan', zh: '忽略' },
  'sync.inbox.posted': { en: 'Posted', id: 'Diposting', zh: '已过账' },
  'sync.inbox.dismissed': { en: 'Dismissed', id: 'Diabaikan', zh: '已忽略' },
  'sync.inbox.postTitle': {
    en: 'Post this {kind}?',
    id: 'Posting {kind} ini?',
    zh: '过账此{kind}？',
  },
  'sync.inbox.postBody': {
    en: 'It is booked in this ERP with its journal entry. This is like entering it yourself; correct it later by voiding.',
    id: 'Akan dibukukan di ERP ini beserta jurnalnya, sama seperti Anda memasukkannya sendiri. Koreksi nanti dengan void.',
    zh: '将在本 ERP 中记账并生成分录，如同您亲自录入；之后可通过作废更正。',
  },
  'sync.inbox.rate': {
    en: 'Exchange rate to {base} (optional)',
    id: 'Kurs ke {base} (opsional)',
    zh: '兑 {base} 汇率（可选）',
  },
  'sync.inbox.rateHint': {
    en: 'Leave empty to use the stored rate for the document date.',
    id: 'Kosongkan untuk memakai kurs tersimpan pada tanggal dokumen.',
    zh: '留空则使用单据日期的已存汇率。',
  },
  'sync.inbox.dismissTitle': {
    en: 'Dismiss this {kind}?',
    id: 'Abaikan {kind} ini?',
    zh: '忽略此{kind}？',
  },
  'sync.inbox.reason': { en: 'Reason (optional)', id: 'Alasan (opsional)', zh: '原因（可选）' },
  'sync.inbox.postedToast': { en: 'Posted', id: 'Berhasil diposting', zh: '已过账' },
  'sync.inbox.dismissedToast': { en: 'Dismissed', id: 'Diabaikan', zh: '已忽略' },

  // ── Errors ──
  'sync.err.notAllowed': {
    en: 'Only an Owner or Admin of every ERP in a sync can run it.',
    id: 'Hanya Owner atau Admin di setiap ERP yang dipilih yang bisa menjalankan sync.',
    zh: '只有同步中每个 ERP 的所有者或管理员才能执行同步。',
  },
  'sync.err.disabled': {
    en: 'An ERP you chose is left out of sync.',
    id: 'Ada ERP yang dipilih sedang tidak ikut sync.',
    zh: '所选的某个 ERP 未参与同步。',
  },
  'sync.err.targets': {
    en: 'Choose at least one target ERP other than the source.',
    id: 'Pilih minimal satu ERP tujuan selain sumber.',
    zh: '请至少选择一个不同于源的目标 ERP。',
  },
  'sync.err.entities': {
    en: 'Choose what to sync.',
    id: 'Pilih data yang mau di-sync.',
    zh: '请选择要同步的内容。',
  },
  'sync.err.invoiceFirst': {
    en: 'Post the invoice of this payment first.',
    id: 'Posting dulu invoice dari pembayaran ini.',
    zh: '请先过账此付款对应的发票。',
  },
  'sync.err.orderFirst': {
    en: 'Sync the purchase order of this payment first.',
    id: 'Sync dulu purchase order dari pembayaran ini.',
    zh: '请先同步此付款对应的采购订单。',
  },
  'sync.err.handled': {
    en: 'This item was already handled.',
    id: 'Item ini sudah diproses.',
    zh: '此项目已处理。',
  },
  'sync.err.fx': {
    en: 'There is no current exchange rate for this currency. Add one in Settings → Currencies, or enter the rate.',
    id: 'Belum ada kurs terbaru untuk mata uang ini. Tambahkan di Pengaturan → Mata uang, atau isi kursnya.',
    zh: '此币种没有最新汇率。请在 设置 → 币种 中添加，或输入汇率。',
  },
  'sync.err.failed': {
    en: 'Something went wrong. Please try again.',
    id: 'Terjadi kesalahan. Silakan coba lagi.',
    zh: '出现问题，请重试。',
  },

  // ── Workspace audit trail ──
  'audit.settings.changed': {
    en: 'Alerts or purchase approval changed',
    id: 'Peringatan atau approval pembelian diubah',
    zh: '已更改提醒或采购审批',
  },
  'audit.sync.run': { en: 'Sync run', id: 'Sync dijalankan', zh: '执行了同步' },
  'audit.sync.enabled': { en: 'Included in sync', id: 'Diikutkan sync', zh: '已参与同步' },
  'audit.sync.disabled': { en: 'Left out of sync', id: 'Dikeluarkan dari sync', zh: '已退出同步' },
  'audit.sync.inbox_posted': {
    en: 'Synced document posted',
    id: 'Dokumen sync diposting',
    zh: '同步单据已过账',
  },
  'audit.sync.inbox_dismissed': {
    en: 'Synced document dismissed',
    id: 'Dokumen sync diabaikan',
    zh: '同步单据已忽略',
  },
} satisfies Record<string, Entry>;
