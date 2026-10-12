import type { Entry } from './types';

export const settingsMessages = {
  'settings.title': { en: 'ERP Settings', id: 'Pengaturan ERP', zh: 'ERP 设置' },
  'settings.subtitle': {
    en: 'Configure alert thresholds and system preferences',
    id: 'Atur ambang peringatan dan preferensi sistem',
    zh: '配置警报阈值和系统偏好',
  },
  'settings.resetDefaults': { en: 'Reset Defaults', id: 'Kembalikan Default', zh: '恢复默认值' },
  'settings.save': { en: 'Save Settings', id: 'Simpan Pengaturan', zh: '保存设置' },
  'settings.saveFailed': {
    en: 'Failed to save settings',
    id: 'Gagal menyimpan pengaturan',
    zh: '保存设置失败',
  },
  'settings.invalidApprover': {
    en: 'Invalid approver email: {email}',
    id: 'Email approver tidak valid: {email}',
    zh: '审批人邮箱无效：{email}',
  },
  'settings.invalidAdminEmail': {
    en: 'Admin notification email is invalid.',
    id: 'Email notifikasi admin tidak valid.',
    zh: '管理员通知邮箱无效。',
  },
  'settings.needApprover': {
    en: 'Add at least one approver email or set the approval threshold to 0 to disable approvals.',
    id: 'Tambahkan minimal satu email approver atau atur ambang approval ke 0 untuk menonaktifkan approval.',
    zh: '请至少添加一个审批人邮箱，或将审批阈值设为 0 以停用审批。',
  },
  'settings.loadApprovalsFailed': {
    en: 'Could not load approval requests.',
    id: 'Gagal memuat permintaan approval.',
    zh: '无法加载审批请求。',
  },
  'settings.decisionFailed': {
    en: 'Could not save the approval decision.',
    id: 'Gagal menyimpan keputusan approval.',
    zh: '无法保存审批决定。',
  },

  'settings.thresholds': {
    en: 'Critical Alert Thresholds',
    id: 'Ambang Peringatan Kritis',
    zh: '关键警报阈值',
  },
  'settings.cashAlert': { en: 'Net Cash Alert', id: 'Peringatan Kas Bersih', zh: '净现金警报' },
  'settings.cashAlertDesc': {
    en: 'Trigger a critical alert when net cash from recorded payments drops below this amount.',
    id: 'Munculkan peringatan kritis ketika kas bersih dari pembayaran tercatat turun di bawah jumlah ini.',
    zh: '当已记录付款的净现金低于此金额时触发严重警报。',
  },
  'settings.cashAlertHint': {
    en: 'Recommended: $5,000 – $20,000 depending on your monthly expenses.',
    id: 'Disarankan: $5.000 – $20.000 tergantung pengeluaran bulanan Anda.',
    zh: '建议：根据每月支出设置为 $5,000 – $20,000。',
  },
  'settings.expenseAlert': {
    en: 'Cash Out Ratio Warning',
    id: 'Peringatan Rasio Kas Keluar',
    zh: '现金流出比例警告',
  },
  'settings.expenseAlertDesc': {
    en: 'Trigger a warning when cash paid out exceeds this percentage of cash received.',
    id: 'Munculkan peringatan ketika kas keluar melebihi persentase ini dari kas masuk.',
    zh: '当现金流出超过现金流入的此百分比时发出警告。',
  },
  'settings.expenseAlertHint': {
    en: 'Recommended: 80–90%. Above 100% means more cash is going out than coming in.',
    id: 'Disarankan: 80–90%. Di atas 100% berarti kas keluar lebih besar dari kas masuk.',
    zh: '建议：80–90%。超过 100% 表示流出的现金多于流入。',
  },
  'settings.inventoryAlert': {
    en: 'Inventory Value Alert',
    id: 'Peringatan Nilai Inventaris',
    zh: '库存价值警报',
  },
  'settings.inventoryAlertDesc': {
    en: 'Trigger an alert when total inventory value falls below this amount.',
    id: 'Munculkan peringatan ketika total nilai inventaris turun di bawah jumlah ini.',
    zh: '当库存总价值低于此金额时触发警报。',
  },
  'settings.inventoryAlertHint': {
    en: 'Recommended: Set to your minimum reorder buffer value.',
    id: 'Disarankan: atur ke nilai buffer pemesanan ulang minimum Anda.',
    zh: '建议：设为最低补货缓冲价值。',
  },
  'settings.current': { en: 'Current: {value}', id: 'Saat ini: {value}', zh: '当前：{value}' },
  'settings.default': { en: 'Default: {value}', id: 'Default: {value}', zh: '默认：{value}' },

  'settings.approvals': {
    en: 'Admin & Purchase Approvals',
    id: 'Admin & Persetujuan Pembelian',
    zh: '管理员与采购审批',
  },
  'settings.approvalsDesc': {
    en: 'Choose which staff emails may approve Purchase Orders. They must sign in to ETNA with the same email address.',
    id: 'Pilih email staf yang boleh menyetujui Purchase Order. Mereka harus masuk ke ETNA dengan alamat email yang sama.',
    zh: '选择可以审批采购订单的员工邮箱。他们必须使用相同的邮箱登录 ETNA。',
  },
  'settings.adminEmail': {
    en: 'Admin notification email',
    id: 'Email notifikasi admin',
    zh: '管理员通知邮箱',
  },
  'settings.adminEmailHint': {
    en: 'This email receives approval results; the currently signed-in account remains the data owner and admin.',
    id: 'Email ini menerima pemberitahuan hasil approval; akun login saat ini tetap menjadi pemilik dan admin data.',
    zh: '此邮箱接收审批结果通知；当前登录的账户仍是数据所有者和管理员。',
  },
  'settings.poThreshold': {
    en: 'Require approval for PO above',
    id: 'Wajib approval untuk PO di atas',
    zh: '采购订单金额超过以下值需审批',
  },
  'settings.poThresholdHint': {
    en: 'Set 0 to turn approvals off. POs at or above this amount enter the approval queue.',
    id: 'Atur 0 untuk mematikan approval. PO senilai atau di atas batas ini akan masuk antrean persetujuan.',
    zh: '设为 0 可关闭审批。金额达到或超过此值的采购订单将进入审批队列。',
  },
  'settings.approverEmails': { en: 'Approver emails', id: 'Email approver', zh: '审批人邮箱' },
  'settings.approverEmailsHint': {
    en: 'Separate with new lines, commas, or semicolons. Approval emails are sent with Resend; the deployment needs',
    id: 'Bisa dipisah dengan baris baru, koma, atau titik koma. Email notifikasi approval memakai Resend; deploy perlu',
    zh: '可用换行、逗号或分号分隔。审批邮件通过 Resend 发送；部署需要配置',
  },
  'settings.and': { en: 'and', id: 'dan', zh: '和' },

  'settings.inbox': {
    en: 'Purchase Order Approval Inbox',
    id: 'Kotak Masuk Persetujuan Purchase Order',
    zh: '采购订单审批收件箱',
  },
  'settings.inboxDesc': {
    en: 'Approval decisions are restricted to the email addresses assigned when the request was created.',
    id: 'Keputusan approval dibatasi pada alamat email yang ditetapkan saat permintaan dibuat.',
    zh: '只有创建请求时指定的邮箱才能做出审批决定。',
  },
  'settings.loadingApprovals': {
    en: 'Loading approvals…',
    id: 'Memuat approval…',
    zh: '正在加载审批…',
  },
  'settings.noApprovals': {
    en: 'No purchase approvals to review.',
    id: 'Tidak ada approval pembelian untuk ditinjau.',
    zh: '没有需要审核的采购审批。',
  },
  'settings.reject': { en: 'Reject', id: 'Tolak', zh: '拒绝' },
  'settings.approve': { en: 'Approve', id: 'Setujui', zh: '批准' },

  'settings.preview': { en: 'Threshold Preview', id: 'Pratinjau Ambang', zh: '阈值预览' },
  'settings.previewDesc': {
    en: 'These thresholds will trigger alerts on the ERP Dashboard.',
    id: 'Ambang ini akan memunculkan peringatan di Dasbor ERP.',
    zh: '这些阈值会在 ERP 仪表板上触发警报。',
  },
  'settings.below': { en: 'Below {value}', id: 'Di bawah {value}', zh: '低于 {value}' },
  'settings.aboveOfCashIn': {
    en: 'Above {value}% of cash in',
    id: 'Di atas {value}% dari kas masuk',
    zh: '超过现金流入的 {value}%',
  },

  'settings.sharedWorkspaceNote': {
    en: 'Data reset options are only available in your own workspace. Switch to it from the Workspace panel.',
    id: 'Opsi reset data hanya tersedia di workspace Anda sendiri. Beralih melalui panel Workspace.',
    zh: '数据重置选项仅在您自己的工作区中可用，请在工作区面板中切换。',
  },
  'settings.danger': { en: 'Danger Zone', id: 'Zona Berbahaya', zh: '危险操作' },
  'settings.deleteTx': {
    en: 'Delete All Transactions',
    id: 'Hapus Semua Transaksi',
    zh: '删除所有交易',
  },
  'settings.deleteTxDesc': {
    en: 'Permanently deletes all transactions, payments, invoices, purchase orders, sales orders, stock movements and journal entries of this ERP. The audit log is kept and records the reset. This cannot be undone.',
    id: 'Menghapus permanen semua transaksi, pembayaran, invoice, purchase order, sales order, mutasi stok, dan jurnal di ERP ini. Log audit tetap disimpan dan mencatat reset ini. Tindakan ini tidak dapat dibatalkan.',
    zh: '永久删除此 ERP 中的所有交易、付款、发票、采购订单、销售订单、库存变动和日记账。审计日志会保留并记录此次重置。此操作无法撤销。',
  },
  'settings.typeToConfirm': {
    en: 'Type {phrase} to confirm deletion:',
    id: 'Ketik {phrase} untuk mengonfirmasi penghapusan:',
    zh: '输入 {phrase} 以确认删除：',
  },
  'settings.deleteTxDone': {
    en: 'All transaction data has been deleted and synchronized across all modules.',
    id: 'Semua data transaksi telah dihapus dan disinkronkan di semua modul.',
    zh: '所有交易数据已删除并已在各模块间同步。',
  },
  'settings.deleteTxFailed': {
    en: 'Failed to delete transactions. Please try again.',
    id: 'Gagal menghapus transaksi. Silakan coba lagi.',
    zh: '删除交易失败，请重试。',
  },
  'settings.wipe': {
    en: 'Delete All History & Data',
    id: 'Hapus Semua Riwayat & Data',
    zh: '删除所有历史与数据',
  },
  'settings.wipeDesc': {
    en: 'Permanently wipes this ERP: transactions, payments, invoices, purchase orders, sales orders, stock movements, journal entries, chart of accounts, products, suppliers, customers and workflows. The audit log, employees and documents are kept. This cannot be undone.',
    id: 'Menghapus permanen isi ERP ini: transaksi, pembayaran, invoice, purchase order, sales order, mutasi stok, jurnal, bagan akun, produk, supplier, customer, dan workflow. Log audit, karyawan, dan dokumen tetap disimpan. Tindakan ini tidak dapat dibatalkan.',
    zh: '永久清除此 ERP：交易、付款、发票、采购订单、销售订单、库存变动、日记账、会计科目、产品、供应商、客户和工作流。审计日志、员工和文档会保留。此操作无法撤销。',
  },
  'settings.enterPassword': {
    en: 'Enter your account password to confirm:',
    id: 'Masukkan kata sandi akun Anda untuk konfirmasi:',
    zh: '请输入账户密码以确认：',
  },
  'settings.wrongPassword': {
    en: 'Incorrect password. Try again.',
    id: 'Password salah. Coba lagi.',
    zh: '密码错误，请重试。',
  },
  'settings.resetForbidden': {
    en: 'Only the owner of this ERP can reset it.',
    id: 'Hanya pemilik ERP ini yang dapat mereset.',
    zh: '只有此 ERP 的所有者可以重置。',
  },
  'settings.wiping': {
    en: 'Verifying & deleting...',
    id: 'Memverifikasi & menghapus...',
    zh: '正在验证并删除...',
  },
  'settings.wipeDone': {
    en: 'This ERP has been reset.',
    id: 'ERP ini telah direset.',
    zh: '此 ERP 已重置。',
  },
  'settings.wipeFailed': {
    en: 'Failed to delete data. Please try again.',
    id: 'Gagal menghapus data. Silakan coba lagi.',
    zh: '删除数据失败，请重试。',
  },
} satisfies Record<string, Entry>;
