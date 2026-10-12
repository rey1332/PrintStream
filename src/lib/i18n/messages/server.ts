import type { Entry } from './types';

// Business-rule messages raised by the database (see translateServerMessage).
export const serverMessages = {
  'server.financialLocked': {
    en: 'Financial records cannot be edited or deleted directly. Use void, reverse or cancel instead.',
    id: 'Catatan keuangan tidak bisa diubah atau dihapus langsung. Gunakan batalkan (void), balik (reverse), atau batal.',
    zh: '财务记录不能直接修改或删除，请使用作废、冲销或取消。',
  },
  'server.insufficientAvailable': {
    en: 'Insufficient available stock for {product} (available {available}, requested {requested})',
    id: 'Stok tersedia untuk {product} tidak cukup (tersedia {available}, diminta {requested})',
    zh: '{product} 可用库存不足（可用 {available}，需求 {requested}）',
  },
  'server.insufficientStock': {
    en: 'Insufficient stock for {product} (available {available}, required {required})',
    id: 'Stok {product} tidak cukup (tersedia {available}, dibutuhkan {required})',
    zh: '{product} 库存不足（现有 {available}，需要 {required}）',
  },
  'server.insufficientStockPlain': {
    en: 'Insufficient stock',
    id: 'Stok tidak cukup',
    zh: '库存不足',
  },
  'server.exceedsRemaining': {
    en: 'Quantity for {product} exceeds the remaining {remaining} units',
    id: 'Jumlah untuk {product} melebihi sisa {remaining} unit',
    zh: '{product} 的数量超过剩余的 {remaining} 件',
  },
  'server.exceedsInvoice': {
    en: 'Payment exceeds the invoice balance (remaining {remaining})',
    id: 'Pembayaran melebihi sisa tagihan invoice (sisa {remaining})',
    zh: '付款超过发票余额（剩余 {remaining}）',
  },
  'server.exceedsPo': {
    en: 'Payment exceeds the purchase order balance (remaining {remaining})',
    id: 'Pembayaran melebihi sisa purchase order (sisa {remaining})',
    zh: '付款超过采购订单余额（剩余 {remaining}）',
  },
  'server.reasonRequired': {
    en: 'A reason (at least 3 characters) is required.',
    id: 'Alasan (minimal 3 karakter) wajib diisi.',
    zh: '必须填写原因（至少 3 个字符）。',
  },
  'server.onlyDraftEditable': {
    en: 'Only draft sales orders can be edited',
    id: 'Hanya sales order draf yang dapat diubah',
    zh: '只能编辑草稿状态的销售订单',
  },
  'server.onlyDraftInvoiced': {
    en: 'Only draft orders can be invoiced',
    id: 'Hanya order draf yang dapat dibuatkan invoice',
    zh: '只有草稿订单可以开具发票',
  },
  'server.onlyInvoicedDelivered': {
    en: 'Only invoiced sales orders can be delivered',
    id: 'Hanya sales order yang sudah diinvoice yang dapat dikirim',
    zh: '只有已开票的销售订单可以发货',
  },
  'server.onlyApprovedReceived': {
    en: 'Only approved purchase orders can be received',
    id: 'Hanya purchase order yang disetujui yang dapat diterima',
    zh: '只有已批准的采购订单可以收货',
  },
  'server.onlyApprovedPaid': {
    en: 'Only approved or received purchase orders can be paid',
    id: 'Hanya purchase order yang disetujui atau diterima yang dapat dibayar',
    zh: '只有已批准或已收货的采购订单可以付款',
  },
  'server.invalidTransition': {
    en: 'This status change is not allowed',
    id: 'Perubahan status ini tidak diizinkan',
    zh: '不允许此状态变更',
  },
  'server.voidPaymentsFirst': {
    en: 'Void the payments recorded on it first',
    id: 'Batalkan (void) pembayarannya terlebih dahulu',
    zh: '请先作废其已记录的付款',
  },
  'server.reverseDeliveriesFirst': {
    en: 'Orders with deliveries cannot be cancelled; reverse the deliveries first',
    id: 'Order yang sudah dikirim tidak dapat dibatalkan; batalkan pengirimannya terlebih dahulu',
    zh: '已发货的订单不能取消，请先冲销发货',
  },
  'server.reverseReceiptsFirst': {
    en: 'Orders with received goods cannot be cancelled; reverse the receipts first',
    id: 'Order dengan barang yang sudah diterima tidak dapat dibatalkan; batalkan penerimaannya terlebih dahulu',
    zh: '已收货的订单不能取消，请先冲销收货',
  },
  'server.cancelOrderToVoid': {
    en: 'This invoice belongs to a sales order; cancel the sales order to void it',
    id: 'Invoice ini milik sales order; batalkan sales order untuk membatalkannya',
    zh: '此发票属于销售订单，请取消该销售订单以作废发票',
  },
  'server.voidInvoicePayment': {
    en: 'Payments cannot be recorded against a void invoice',
    id: 'Pembayaran tidak dapat dicatat pada invoice yang dibatalkan',
    zh: '不能对已作废的发票记录付款',
  },
  'server.amountPositive': {
    en: 'Payment amount must be greater than zero',
    id: 'Jumlah pembayaran harus lebih dari nol',
    zh: '付款金额必须大于零',
  },
  'server.cannotReverseReceipt': {
    en: 'Cannot reverse the receipt of {product}: only {onHand} units are on hand',
    id: 'Tidak dapat membatalkan penerimaan {product}: hanya {onHand} unit di gudang',
    zh: '无法冲销 {product} 的收货：现有库存仅 {onHand} 件',
  },
  'server.alreadyReversed': {
    en: 'This event has already been reversed',
    id: 'Kejadian ini sudah dibatalkan',
    zh: '此记录已被冲销',
  },
  'server.productNotFound': {
    en: 'Product not found for this account',
    id: 'Produk tidak ditemukan untuk akun ini',
    zh: '此账户中未找到该产品',
  },
  'server.customerNotFound': {
    en: 'Customer not found for this account',
    id: 'Customer tidak ditemukan untuk akun ini',
    zh: '此账户中未找到该客户',
  },
  'server.supplierNotFound': {
    en: 'Supplier not found for this account',
    id: 'Supplier tidak ditemukan untuk akun ini',
    zh: '此账户中未找到该供应商',
  },
  'server.itemInvalid': {
    en: 'Item quantity must be positive and price cannot be negative',
    id: 'Jumlah item harus positif dan harga tidak boleh negatif',
    zh: '商品数量必须为正数，价格不能为负数',
  },
  'server.awaitingApprover': {
    en: 'This purchase order is awaiting an assigned approver',
    id: 'Purchase order ini menunggu persetujuan approver',
    zh: '此采购订单正在等待指定审批人审批',
  },
  'server.stockNegative': {
    en: 'Stock cannot be negative',
    id: 'Stok tidak boleh negatif',
    zh: '库存不能为负数',
  },
  'server.quantityPositive': {
    en: 'Quantity must be greater than zero',
    id: 'Jumlah harus lebih dari nol',
    zh: '数量必须大于零',
  },
  'server.tooManyInvitations': {
    en: 'Too many pending invitations. Revoke unused codes first',
    id: 'Terlalu banyak undangan tertunda. Cabut kode yang tidak dipakai terlebih dahulu',
    zh: '待处理的邀请过多，请先撤销未使用的访问码',
  },
  'server.paymentCurrencyPo': {
    en: 'A payment must be in the purchase order currency ({currency}).',
    id: 'Pembayaran harus dalam mata uang pesanan pembelian ({currency}).',
    zh: '付款必须使用采购订单币种（{currency}）。',
  },
  'server.fxMissing': {
    en: 'No {from} → {to} exchange rate on or before {date}. Add one in Settings → Currencies, fetch it, or enter the rate.',
    id: 'Belum ada kurs {from} → {to} pada atau sebelum {date}. Tambahkan di Pengaturan → Mata uang, ambil dari penyedia, atau isi kursnya.',
    zh: '{date}（含）之前没有 {from} → {to} 汇率。请在 设置 → 货币 中添加、获取，或手动输入汇率。',
  },
  'server.fxStale': {
    en: 'The latest {from} → {to} rate is from {rateDate}, more than {days} days before {date}. Add a current rate or enter the rate.',
    id: 'Kurs {from} → {to} terbaru bertanggal {rateDate}, lebih dari {days} hari sebelum {date}. Tambahkan kurs terbaru atau isi kursnya.',
    zh: '最新的 {from} → {to} 汇率日期为 {rateDate}，早于 {date} 超过 {days} 天。请添加最新汇率或手动输入。',
  },
  'server.fxRatePositive': {
    en: 'The exchange rate must be greater than zero.',
    id: 'Kurs harus lebih dari nol.',
    zh: '汇率必须大于零。',
  },
  'server.unknownCurrency': {
    en: 'Unknown currency {currency}.',
    id: 'Mata uang {currency} tidak dikenal.',
    zh: '未知币种 {currency}。',
  },
  'server.baseLocked': {
    en: 'The base currency is locked as {currency} because financial records exist.',
    id: 'Mata uang dasar terkunci sebagai {currency} karena sudah ada catatan keuangan.',
    zh: '因已有财务记录，本位币已锁定为 {currency}。',
  },
  'server.baseOwnerOnly': {
    en: 'Only the workspace owner can change or confirm the base currency.',
    id: 'Hanya pemilik workspace yang dapat mengubah atau mengonfirmasi mata uang dasar.',
    zh: '只有工作区所有者可以更改或确认本位币。',
  },
  'server.baseConfirmRequired': {
    en: 'Financial records already exist. Review them and confirm their currency in Settings → Currencies.',
    id: 'Sudah ada catatan keuangan. Tinjau dan konfirmasi mata uangnya di Pengaturan → Mata uang.',
    zh: '已有财务记录。请在 设置 → 货币 中核对并确认其币种。',
  },
  'server.basePreviewChanged': {
    en: 'Records changed since the preview. Review the preview again.',
    id: 'Catatan berubah sejak pratinjau. Tinjau pratinjau lagi.',
    zh: '预览后记录已变化，请重新查看预览。',
  },
  'server.baseForeignDocs': {
    en: '{count} foreign-currency documents have exchange rates to {currency}; they must be reviewed before the base currency can be declared differently.',
    id: '{count} dokumen mata uang asing memiliki kurs ke {currency}; dokumen tersebut perlu ditinjau sebelum mata uang dasar dinyatakan berbeda.',
    zh: '有 {count} 张外币单据的汇率以 {currency} 计价；在声明其他本位币之前需先核对这些单据。',
  },
} satisfies Record<string, Entry>;
