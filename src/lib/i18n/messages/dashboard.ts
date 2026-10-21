import type { Entry } from './types';

// ERP dashboard, main ETNA dashboard, cash flow, shared metric labels.
export const dashboardMessages = {
  'dash.title': { en: 'Dashboard', id: 'Dasbor', zh: '仪表板' },
  'dash.loadingMetrics': {
    en: 'Loading metrics...',
    id: 'Memuat metrik...',
    zh: '正在加载指标...',
  },
  'dash.financialOverview': { en: 'Financial overview', id: 'Ringkasan keuangan', zh: '财务概览' },
  'dash.cashSection': {
    en: 'Cash flow · recorded payments',
    id: 'Arus kas · pembayaran tercatat',
    zh: '现金流 · 已记录付款',
  },
  'dash.positionSection': {
    en: 'Receivables, payables & commitments · accrual',
    id: 'Piutang, utang & komitmen · akrual',
    zh: '应收、应付与承诺 · 权责发生制',
  },
  'dash.supplierPrepayments': {
    en: 'Supplier prepayments (paid before goods arrived): {amount}',
    id: 'Uang muka supplier (dibayar sebelum barang tiba): {amount}',
    zh: '供应商预付款（到货前已付款）：{amount}',
  },
  'dash.recentTransactions': { en: 'Recent Transactions', id: 'Transaksi Terbaru', zh: '最近交易' },
  'dash.noTransactions': { en: 'No transactions yet', id: 'Belum ada transaksi', zh: '暂无交易' },
  'dash.createInvoice': { en: 'Create an invoice', id: 'Buat invoice', zh: '创建发票' },
  'dash.or': { en: 'or', id: 'atau', zh: '或' },
  'dash.recordPayment': { en: 'record a payment', id: 'catat pembayaran', zh: '记录付款' },

  // Receivables, revenue and trend widgets (erp_dashboard_insights)
  'dash.kpi.customersPastDue': {
    en: 'Customers past due',
    id: 'Pelanggan lewat jatuh tempo',
    zh: '逾期客户',
  },
  'dash.kpi.customersPastDueHint': {
    en: '{n} overdue invoices',
    id: '{n} invoice lewat jatuh tempo',
    zh: '{n} 张逾期发票',
  },
  'dash.kpi.balanceDue': {
    en: 'Customers balance due',
    id: 'Saldo piutang pelanggan',
    zh: '客户应收余额',
  },
  'dash.kpi.balanceDueHint': {
    en: '{amount} past due',
    id: '{amount} lewat jatuh tempo',
    zh: '逾期 {amount}',
  },
  'dash.kpi.overLimit': {
    en: 'Amount over credit limit',
    id: 'Melebihi limit kredit',
    zh: '超出信用额度金额',
  },
  'dash.kpi.overLimitHint': {
    en: '{n} of {total} customers with a limit',
    id: '{n} dari {total} pelanggan berlimit',
    zh: '{total} 个有额度客户中的 {n} 个',
  },
  'dash.kpi.noLimits': {
    en: 'No credit limits set',
    id: 'Belum ada limit kredit',
    zh: '未设置信用额度',
  },
  'dash.kpi.revenue': {
    en: 'Revenue · last 12 months',
    id: 'Pendapatan · 12 bulan terakhir',
    zh: '收入 · 近 12 个月',
  },
  'dash.kpi.revenueHint': {
    en: 'Net of tax · {n} invoices',
    id: 'Tanpa pajak · {n} invoice',
    zh: '不含税 · {n} 张发票',
  },
  'dash.w.topProducts': {
    en: 'Top 10 products by revenue',
    id: '10 produk teratas menurut pendapatan',
    zh: '收入前 10 产品',
  },
  'dash.w.topCustomers': {
    en: 'Top 10 customers by revenue',
    id: '10 pelanggan teratas menurut pendapatan',
    zh: '收入前 10 客户',
  },
  'dash.w.aging': {
    en: 'Customer aged balances',
    id: 'Umur piutang pelanggan',
    zh: '客户账龄余额',
  },
  'dash.w.bank': { en: 'Balance by bank account', id: 'Saldo per rekening', zh: '各账户余额' },
  'dash.w.trend': {
    en: 'Revenue and cash by month',
    id: 'Pendapatan dan kas per bulan',
    zh: '每月收入与现金',
  },
  'dash.w.last12': {
    en: 'Last 12 months · net of tax',
    id: '12 bulan terakhir · tanpa pajak',
    zh: '近 12 个月 · 不含税',
  },
  'dash.w.ledgerBase': {
    en: 'Ledger balance in {currency}',
    id: 'Saldo buku besar dalam {currency}',
    zh: '以 {currency} 计的总账余额',
  },
  'dash.aging.current': { en: 'Not yet due', id: 'Belum jatuh tempo', zh: '未到期' },
  'dash.aging.days30': { en: '1–30 days', id: '1–30 hari', zh: '1–30 天' },
  'dash.aging.days60': { en: '31–60 days', id: '31–60 hari', zh: '31–60 天' },
  'dash.aging.days90': { en: '61–90 days', id: '61–90 hari', zh: '61–90 天' },
  'dash.aging.over90': { en: 'Over 90 days', id: 'Lebih dari 90 hari', zh: '90 天以上' },
  'dash.aging.total': { en: 'Open', id: 'Terbuka', zh: '未结' },
  'dash.series.revenue': {
    en: 'Revenue (invoiced)',
    id: 'Pendapatan (ditagih)',
    zh: '收入（已开票）',
  },
  'dash.series.cashIn': { en: 'Cash in', id: 'Kas masuk', zh: '现金流入' },
  'dash.series.cashOut': { en: 'Cash out', id: 'Kas keluar', zh: '现金流出' },
  'dash.empty.products': {
    en: 'No invoice lines with products in the last 12 months',
    id: 'Belum ada baris invoice berproduk dalam 12 bulan terakhir',
    zh: '近 12 个月没有含产品的发票行',
  },
  'dash.empty.customers': {
    en: 'No invoices in the last 12 months',
    id: 'Belum ada invoice dalam 12 bulan terakhir',
    zh: '近 12 个月没有发票',
  },
  'dash.empty.aging': {
    en: 'No open receivables',
    id: 'Tidak ada piutang terbuka',
    zh: '没有未结应收款',
  },
  'dash.empty.bank': {
    en: 'No cash or bank accounts',
    id: 'Belum ada akun kas atau bank',
    zh: '没有现金或银行账户',
  },
  'dash.empty.trend': {
    en: 'No invoices or payments in the last 12 months',
    id: 'Belum ada invoice atau pembayaran dalam 12 bulan terakhir',
    zh: '近 12 个月没有发票或付款',
  },
  'dash.unavailable': {
    en: 'Not available for your role or this ERP',
    id: 'Tidak tersedia untuk peran Anda atau ERP ini',
    zh: '您的角色或此 ERP 不可用',
  },
  'dash.bank.account': { en: 'Account', id: 'Akun', zh: '账户' },
  'dash.bank.balance': { en: 'Balance', id: 'Saldo', zh: '余额' },
  'dash.bank.subtotal': { en: 'Total', id: 'Total', zh: '合计' },
  'dash.bank.total': { en: 'All accounts', id: 'Semua akun', zh: '全部账户' },
  'dash.bank.inactive': { en: 'inactive', id: 'nonaktif', zh: '停用' },
  'dash.more': { en: 'Open', id: 'Buka', zh: '打开' },

  // KPI labels
  'metric.cashIn': {
    en: 'Cash In (payments received)',
    id: 'Kas Masuk (pembayaran diterima)',
    zh: '现金流入（已收款）',
  },
  'metric.cashOut': {
    en: 'Cash Out (payments made)',
    id: 'Kas Keluar (pembayaran dilakukan)',
    zh: '现金流出（已付款）',
  },
  'metric.netCash': {
    en: 'Net Cash (in − out)',
    id: 'Kas Bersih (masuk − keluar)',
    zh: '净现金（流入 − 流出）',
  },
  'metric.ar': {
    en: 'Accounts Receivable (unpaid invoices)',
    id: 'Piutang Usaha (invoice belum dibayar)',
    zh: '应收账款（未付发票）',
  },
  'metric.ap': {
    en: 'Accounts Payable (received, unpaid)',
    id: 'Utang Usaha (diterima, belum dibayar)',
    zh: '应付账款（已收货未付款）',
  },
  'metric.committed': {
    en: 'Committed Purchases (approved, not received)',
    id: 'Pembelian Terkomitmen (disetujui, belum diterima)',
    zh: '已承诺采购（已批准未收货）',
  },
  'metric.invoiced': {
    en: 'Invoiced Revenue (all invoices)',
    id: 'Pendapatan Diinvoice (semua invoice)',
    zh: '已开票收入（全部发票）',
  },
  'metric.inventory': {
    en: 'Inventory Value (at cost)',
    id: 'Nilai Inventaris (harga pokok)',
    zh: '库存价值（按成本）',
  },

  // Alerts
  'alert.cashLow.title': { en: 'Net Cash Critical', id: 'Kas Bersih Kritis', zh: '净现金告急' },
  'alert.cashLow.detail': {
    en: 'Net cash from recorded payments is {amount} — below the {threshold} minimum threshold.',
    id: 'Kas bersih dari pembayaran tercatat adalah {amount} — di bawah ambang minimum {threshold}.',
    zh: '已记录付款的净现金为 {amount}，低于最低阈值 {threshold}。',
  },
  'alert.cashOut.title': {
    en: 'Cash Out Spike Detected',
    id: 'Lonjakan Kas Keluar Terdeteksi',
    zh: '检测到现金流出激增',
  },
  'alert.cashOut.detail': {
    en: 'Cash paid out is {pct}% of cash received — exceeding the {threshold}% warning threshold.',
    id: 'Kas keluar adalah {pct}% dari kas masuk — melebihi ambang peringatan {threshold}%.',
    zh: '现金流出占现金流入的 {pct}%，超过 {threshold}% 的警告阈值。',
  },
  'alert.inventoryLow.title': {
    en: 'Inventory Below Minimum',
    id: 'Inventaris di Bawah Minimum',
    zh: '库存低于最低值',
  },
  'alert.inventoryLow.detail': {
    en: 'Inventory value is {amount} — below the {threshold} minimum threshold.',
    id: 'Nilai inventaris adalah {amount} — di bawah ambang minimum {threshold}.',
    zh: '库存价值为 {amount}，低于最低阈值 {threshold}。',
  },

  // Transaction categories written by the system (display labels only)
  'txcat.Payment Received': { en: 'Payment Received', id: 'Pembayaran Diterima', zh: '收到付款' },
  'txcat.Payment Sent': { en: 'Payment Sent', id: 'Pembayaran Dikirim', zh: '已付款' },
  'txcat.Payment Voided': { en: 'Payment Voided', id: 'Pembayaran Di-void', zh: '付款已作废' },
  'txcat.Accounts Receivable': { en: 'Accounts Receivable', id: 'Piutang Usaha', zh: '应收账款' },
  'txtype.income': { en: 'Income', id: 'Pemasukan', zh: '收入' },
  'txtype.expense': { en: 'Expense', id: 'Pengeluaran', zh: '支出' },

  // Main ETNA dashboard (/)
  'home.trend.up': { en: 'Positive', id: 'Positif', zh: '向好' },
  'home.trend.down': { en: 'Negative', id: 'Negatif', zh: '向差' },
  'home.trend.neutral': { en: 'Neutral', id: 'Netral', zh: '持平' },
  'home.netCashFlow': {
    en: 'Net Cash Flow (payments)',
    id: 'Arus Kas Bersih (pembayaran)',
    zh: '净现金流（付款）',
  },
  'home.pctOfCashIn': {
    en: '{pct}% of cash in',
    id: '{pct}% dari kas masuk',
    zh: '占现金流入的 {pct}%',
  },
  'home.cashInLabel': { en: 'Cash in:', id: 'Kas masuk:', zh: '现金流入：' },
  'home.cashOutLabel': { en: 'Cash out:', id: 'Kas keluar:', zh: '现金流出：' },
  'home.financialOverview': { en: 'Financial Overview', id: 'Ringkasan Keuangan', zh: '财务概览' },
  'home.series.cashIn': { en: 'Cash in', id: 'Kas masuk', zh: '现金流入' },
  'home.series.cashOut': { en: 'Cash out', id: 'Kas keluar', zh: '现金流出' },
  'home.series.netCash': { en: 'Net cash', id: 'Kas bersih', zh: '净现金' },
  'home.noTransactions': {
    en: 'No transactions yet.',
    id: 'Belum ada transaksi.',
    zh: '暂无交易。',
  },
  'home.exportFailedTable': {
    en: 'Could not export {table}',
    id: 'Gagal mengekspor {table}',
    zh: '无法导出 {table}',
  },
  'home.exported': {
    en: 'ERP data exported to Excel',
    id: 'Data ERP diekspor ke Excel',
    zh: 'ERP 数据已导出到 Excel',
  },
  'home.exportFailed': { en: 'ERP export failed', id: 'Ekspor ERP gagal', zh: 'ERP 导出失败' },
  'home.liveMetrics': {
    en: 'Live metrics from invoices, payments & transactions',
    id: 'Metrik langsung dari invoice, pembayaran & transaksi',
    zh: '来自发票、付款和交易的实时指标',
  },
  'home.erpModule': { en: 'ERP Module', id: 'Modul ERP', zh: 'ERP 模块' },
  'home.signIn': { en: 'Sign in', id: 'Masuk', zh: '登录' },
  'home.signInSuffix': {
    en: 'to view your live ERP financial metrics.',
    id: 'untuk melihat metrik keuangan ERP Anda secara langsung.',
    zh: '以查看实时 ERP 财务指标。',
  },
  'home.kpi.cashIn': {
    en: 'Cash In (payments)',
    id: 'Kas Masuk (pembayaran)',
    zh: '现金流入（付款）',
  },
  'home.kpi.netCash': {
    en: 'Net Cash (payments)',
    id: 'Kas Bersih (pembayaran)',
    zh: '净现金（付款）',
  },
  'home.kpi.cashOut': {
    en: 'Cash Out (payments)',
    id: 'Kas Keluar (pembayaran)',
    zh: '现金流出（付款）',
  },
  'home.kpi.receivable': {
    en: 'Receivable (unpaid invoices)',
    id: 'Piutang (invoice belum dibayar)',
    zh: '应收（未付发票）',
  },
  'home.kpi.payable': {
    en: 'Payable (received, unpaid)',
    id: 'Utang (diterima, belum dibayar)',
    zh: '应付（已收货未付款）',
  },
  'home.kpi.inventory': { en: 'Inventory Value', id: 'Nilai Inventaris', zh: '库存价值' },
  'home.link.invoices': { en: 'Invoices', id: 'Invoice', zh: '发票' },
  'home.link.invoicesDesc': { en: 'Revenue source', id: 'Sumber pendapatan', zh: '收入来源' },
  'home.link.payments': { en: 'Payments', id: 'Pembayaran', zh: '付款' },
  'home.link.paymentsDesc': { en: 'Cash flow', id: 'Arus kas', zh: '现金流' },
  'home.link.cashFlow': { en: 'Cash Flow', id: 'Arus Kas', zh: '现金流' },
  'home.link.cashFlowDesc': { en: 'Transactions', id: 'Transaksi', zh: '交易' },
  'home.link.reports': { en: 'Reports', id: 'Laporan', zh: '报表' },
  'home.link.reportsDesc': { en: 'Full analytics', id: 'Analitik lengkap', zh: '完整分析' },

  // Cash flow page
  'cash.title': { en: 'Cash Flow', id: 'Arus Kas', zh: '现金流' },
  'cash.subtitle': {
    en: 'Cash received and paid out, from recorded payments (voided payments excluded)',
    id: 'Kas diterima dan dibayarkan, dari pembayaran tercatat (pembayaran yang di-void tidak dihitung)',
    zh: '根据已记录付款统计的现金收支（不含已作废付款）',
  },
  'cash.failed': {
    en: 'Failed to load transactions: {error}',
    id: 'Gagal memuat transaksi: {error}',
    zh: '加载交易失败：{error}',
  },
  'cash.in': { en: 'Cash In', id: 'Kas Masuk', zh: '现金流入' },
  'cash.out': { en: 'Cash Out', id: 'Kas Keluar', zh: '现金流出' },
  'cash.net': { en: 'Net Cash Flow', id: 'Arus Kas Bersih', zh: '净现金流' },
  'cash.empty': { en: 'No transactions yet', id: 'Belum ada transaksi', zh: '暂无交易' },
  'cash.emptyHint': {
    en: 'Transactions will appear here once payments are recorded.',
    id: 'Transaksi akan muncul di sini setelah pembayaran dicatat.',
    zh: '记录付款后，交易将显示在此处。',
  },
  'cash.monthly': {
    en: 'Monthly Cash Flow (payments)',
    id: 'Arus Kas Bulanan (pembayaran)',
    zh: '月度现金流（付款）',
  },
  'cash.netPosition': { en: 'Net Cash Position', id: 'Posisi Kas Bersih', zh: '净现金头寸' },
  'cash.ledger': { en: 'Cash ledger', id: 'Buku kas', zh: '现金台账' },
  'cash.ledgerHint': {
    en: 'Every payment and every void reversal, as booked',
    id: 'Setiap pembayaran dan setiap pembalikan void, sesuai pencatatan',
    zh: '按记账顺序列出所有付款及作废冲销',
  },
  'cash.reversal': { en: 'reversal', id: 'pembalikan', zh: '冲销' },
  'cash.seriesIn': { en: 'Cash in', id: 'Kas masuk', zh: '现金流入' },
  'cash.seriesOut': { en: 'Cash out', id: 'Kas keluar', zh: '现金流出' },
  'cash.seriesNet': { en: 'Net', id: 'Bersih', zh: '净额' },
  'cash.month': { en: 'Month', id: 'Bulan', zh: '月份' },
} satisfies Record<string, Entry>;
