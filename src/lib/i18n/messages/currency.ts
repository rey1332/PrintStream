import type { Entry } from './types';

// Settings → Currencies, currency pickers, rates on documents and converted amounts.
export const currencyMessages = {
  'cur.title': { en: 'Currencies', id: 'Mata uang', zh: '货币' },

  // ── Base currency ──
  'cur.base.title': {
    en: 'Base (accounting) currency',
    id: 'Mata uang dasar (akuntansi)',
    zh: '本位币（记账货币）',
  },
  'cur.base.description': {
    en: 'The ledger and financial reports are in this currency. Documents in other currencies keep their own amount and currency, plus the exchange rate used.',
    id: 'Buku besar dan laporan keuangan memakai mata uang ini. Dokumen dalam mata uang lain menyimpan jumlah dan mata uangnya sendiri, beserta kurs yang dipakai.',
    zh: '总账与财务报表使用此货币。其他币种的单据保留原币金额、币种及所用汇率。',
  },
  'cur.base.statusLocked': {
    en: 'Confirmed · locked',
    id: 'Dikonfirmasi · terkunci',
    zh: '已确认 · 已锁定',
  },
  'cur.base.statusConfirmed': { en: 'Confirmed', id: 'Dikonfirmasi', zh: '已确认' },
  'cur.base.statusUnconfirmed': {
    en: 'Not confirmed yet',
    id: 'Belum dikonfirmasi',
    zh: '尚未确认',
  },
  'cur.base.ownerOnly': {
    en: 'Only the workspace owner can confirm or change the base currency.',
    id: 'Hanya pemilik workspace yang dapat mengonfirmasi atau mengubah mata uang dasar.',
    zh: '只有工作区所有者可以确认或更改本位币。',
  },
  'cur.base.review': {
    en: 'Review existing records',
    id: 'Tinjau catatan yang ada',
    zh: '查看现有记录',
  },
  'cur.base.refresh': { en: 'Refresh preview', id: 'Muat ulang pratinjau', zh: '刷新预览' },
  'cur.base.noRecords': {
    en: 'There are no financial records yet. Choose the base currency; it is locked once records exist.',
    id: 'Belum ada catatan keuangan. Pilih mata uang dasar; mata uang ini terkunci setelah ada catatan.',
    zh: '尚无财务记录。请选择本位币；产生记录后将被锁定。',
  },
  'cur.base.unambiguous': {
    en: 'All amounts without a currency code were recorded after the base currency was last saved as {code}. Confirm to lock it.',
    id: 'Semua jumlah tanpa kode mata uang dicatat setelah mata uang dasar terakhir disimpan sebagai {code}. Konfirmasi untuk menguncinya.',
    zh: '所有未标币种的金额均在本位币最后保存为 {code} 之后记录。确认即可锁定。',
  },
  'cur.base.needsDecision': {
    en: 'Some amounts without a currency code were recorded before the settings were last saved, so PrintStream cannot be sure they are in {code}. Check the totals below and tell PrintStream which currency they are in.',
    id: 'Sebagian jumlah tanpa kode mata uang dicatat sebelum pengaturan terakhir disimpan, sehingga PrintStream tidak bisa memastikan semuanya dalam {code}. Periksa total di bawah dan tentukan mata uangnya.',
    zh: '部分未标币种的金额记录于设置最后保存之前，PrintStream 无法确定它们是否为 {code}。请核对下方合计并告知其币种。',
  },
  'cur.base.isDefault': {
    en: "{code} was never chosen by anyone: it is ETNA's default. Make sure it is really the currency of your amounts.",
    id: '{code} tidak pernah dipilih siapa pun: ini bawaan ETNA. Pastikan memang mata uang jumlah Anda.',
    zh: '{code} 从未被人选择过，只是 ETNA 的默认值。请确认它确实是您金额的币种。',
  },
  'cur.base.nothingRewritten': {
    en: 'Nothing is rewritten: amounts, dates and ledger entries stay exactly as they are. Confirming records which currency they are in and locks it, so a later change can never reinterpret them.',
    id: 'Tidak ada yang ditulis ulang: jumlah, tanggal, dan jurnal tetap persis sama. Konfirmasi mencatat mata uangnya dan menguncinya, sehingga perubahan nanti tidak bisa mengubah artinya.',
    zh: '不会改写任何数据：金额、日期和分录保持不变。确认会记录其币种并锁定，之后的更改不会改变其含义。',
  },
  'cur.base.choose': { en: 'Base currency', id: 'Mata uang dasar', zh: '本位币' },
  'cur.base.amountsAreIn': {
    en: 'These amounts are in',
    id: 'Jumlah ini dalam',
    zh: '这些金额的币种',
  },
  'cur.base.foreignBlock': {
    en: '{count} foreign-currency documents have exchange rates to {code}; they would need review first, so only {code} can be confirmed now.',
    id: '{count} dokumen mata uang asing memiliki kurs ke {code}; dokumen itu perlu ditinjau dulu, jadi saat ini hanya {code} yang bisa dikonfirmasi.',
    zh: '有 {count} 张外币单据的汇率以 {code} 计价，需先核对，因此目前只能确认 {code}。',
  },
  'cur.base.agree': {
    en: 'I confirm the {count} existing amounts without a currency code are in {code}.',
    id: 'Saya mengonfirmasi {count} jumlah tanpa kode mata uang dalam {code}.',
    zh: '我确认现有 {count} 笔未标币种的金额为 {code}。',
  },
  'cur.base.agreeEmpty': {
    en: 'Use {code} as the base currency.',
    id: 'Gunakan {code} sebagai mata uang dasar.',
    zh: '使用 {code} 作为本位币。',
  },
  'cur.base.confirm': { en: 'Confirm {code}', id: 'Konfirmasi {code}', zh: '确认 {code}' },
  'cur.base.confirmedToast': {
    en: 'Base currency confirmed as {code}.',
    id: 'Mata uang dasar dikonfirmasi sebagai {code}.',
    zh: '本位币已确认为 {code}。',
  },
  'cur.base.confirmedAt': {
    en: 'Confirmed {date}. Recorded in the currency audit log.',
    id: 'Dikonfirmasi {date}. Tercatat di log audit mata uang.',
    zh: '确认于 {date}，已记入货币审计日志。',
  },
  'cur.pv.table': { en: 'Records', id: 'Catatan', zh: '记录' },
  'cur.pv.baseRows': { en: 'Without code', id: 'Tanpa kode', zh: '未标币种' },
  'cur.pv.uncertain': { en: 'Not certain', id: 'Belum pasti', zh: '不确定' },
  'cur.pv.sum': { en: 'Total', id: 'Total', zh: '合计' },
  'cur.pv.dates': { en: 'Dates', id: 'Tanggal', zh: '日期' },
  'cur.pv.foreign': { en: 'Foreign currency', id: 'Mata uang asing', zh: '外币' },
  'cur.pv.t.invoices': { en: 'Invoices', id: 'Faktur', zh: '发票' },
  'cur.pv.t.payments': { en: 'Payments', id: 'Pembayaran', zh: '付款' },
  'cur.pv.t.purchaseOrders': { en: 'Purchase orders', id: 'Pesanan pembelian', zh: '采购订单' },
  'cur.pv.t.salesOrders': { en: 'Sales orders', id: 'Pesanan penjualan', zh: '销售订单' },
  'cur.pv.t.cashTransactions': { en: 'Cash book', id: 'Buku kas', zh: '现金日记账' },
  'cur.pv.t.journalEntries': { en: 'Journal entries', id: 'Jurnal', zh: '日记账分录' },
  'cur.pv.t.products': { en: 'Products (prices)', id: 'Produk (harga)', zh: '产品（价格）' },

  // ── Display currency ──
  'cur.display.title': {
    en: 'Display currency (you, this browser)',
    id: 'Mata uang tampilan (Anda, peramban ini)',
    zh: '显示货币（仅本浏览器）',
  },
  'cur.display.description': {
    en: 'Also show dashboard and report totals converted into',
    id: 'Tampilkan juga total dasbor dan laporan yang dikonversi ke',
    zh: '同时将仪表板和报表合计折算显示为',
  },
  'cur.display.note': {
    en: 'Only changes what you see. Converted amounts are marked ≈ with the rate date and source; records and the ledger stay in their own currencies.',
    id: 'Hanya mengubah tampilan Anda. Jumlah hasil konversi ditandai ≈ dengan tanggal dan sumber kurs; catatan dan buku besar tetap dalam mata uangnya sendiri.',
    zh: '仅影响您的显示。折算金额标有 ≈ 及汇率日期和来源；记录与总账保持原币种。',
  },
  'cur.display.converted': { en: '≈ {amount}', id: '≈ {amount}', zh: '≈ {amount}' },
  'cur.display.basis': {
    en: 'converted at {rate} ({date}, {source})',
    id: 'dikonversi dengan kurs {rate} ({date}, {source})',
    zh: '按 {rate} 折算（{date}，{source}）',
  },
  'cur.display.noRate': {
    en: 'No {from} → {to} rate yet: shown in {from}.',
    id: 'Belum ada kurs {from} → {to}: ditampilkan dalam {from}.',
    zh: '尚无 {from} → {to} 汇率：以 {from} 显示。',
  },

  // ── Rates ──
  'cur.rates.title': { en: 'Exchange rates', id: 'Kurs', zh: '汇率' },
  'cur.rates.provider': {
    en: 'Rates can be fetched from {name} ({providers}) by the PrintStream server, or entered by hand. A document uses the rate on or before its date; rates older than {days} days are not used automatically.',
    id: 'Kurs dapat diambil dari {name} ({providers}) oleh server PrintStream, atau diisi manual. Dokumen memakai kurs pada atau sebelum tanggalnya; kurs yang lebih tua dari {days} hari tidak dipakai otomatis.',
    zh: '汇率可由 PrintStream 服务器从 {name}（{providers}）获取，或手动输入。单据使用其日期当天或之前的汇率；超过 {days} 天的汇率不会自动使用。',
  },
  'cur.rates.blend': { en: 'central-bank blend', id: 'gabungan bank sentral', zh: '多家央行综合' },
  'cur.rates.providerOff': {
    en: 'Automatic rates are switched off on this server; enter rates by hand.',
    id: 'Kurs otomatis dimatikan di server ini; isi kurs secara manual.',
    zh: '本服务器已关闭自动汇率，请手动输入。',
  },
  'cur.rates.addTitle': { en: 'Add a rate by hand', id: 'Tambah kurs manual', zh: '手动添加汇率' },
  'cur.rates.currency': { en: '1 unit of', id: '1 unit', zh: '1 单位' },
  'cur.rates.rateIn': { en: 'equals ({base})', id: 'sama dengan ({base})', zh: '等于（{base}）' },
  'cur.rates.date': { en: 'Rate date', id: 'Tanggal kurs', zh: '汇率日期' },
  'cur.rates.note': { en: 'Note', id: 'Catatan', zh: '备注' },
  'cur.rates.notePlaceholder': { en: 'e.g. bank quote', id: 'mis. kurs bank', zh: '如：银行报价' },
  'cur.rates.add': { en: 'Add rate', id: 'Tambah kurs', zh: '添加汇率' },
  'cur.rates.added': { en: 'Rate added.', id: 'Kurs ditambahkan.', zh: '已添加汇率。' },
  'cur.rates.fetchTitle': { en: 'Fetch a rate', id: 'Ambil kurs', zh: '获取汇率' },
  'cur.rates.fetchFrom': { en: 'Currency', id: 'Mata uang', zh: '币种' },
  'cur.rates.fetch': { en: 'Fetch from {name}', id: 'Ambil dari {name}', zh: '从 {name} 获取' },
  'cur.rates.fetched': {
    en: '{fetched} rate(s) received, {stored} new stored.',
    id: '{fetched} kurs diterima, {stored} baru disimpan.',
    zh: '收到 {fetched} 个汇率，新存储 {stored} 个。',
  },
  'cur.rates.none': { en: 'No exchange rates yet.', id: 'Belum ada kurs.', zh: '尚无汇率。' },
  'cur.rates.pair': { en: 'Pair', id: 'Pasangan', zh: '货币对' },
  'cur.rates.rate': { en: 'Rate', id: 'Kurs', zh: '汇率' },
  'cur.rates.source': { en: 'Source', id: 'Sumber', zh: '来源' },
  'cur.rates.recorded': { en: 'Recorded', id: 'Dicatat', zh: '记录时间' },
  'cur.rates.history': {
    en: 'Rates are never edited or deleted: a correction is a new rate, and the latest one recorded for a date is used. Documents keep the rate they were booked with.',
    id: 'Kurs tidak pernah diubah atau dihapus: koreksi adalah kurs baru, dan yang terakhir dicatat untuk suatu tanggal yang dipakai. Dokumen tetap memakai kurs saat dicatat.',
    zh: '汇率不会被修改或删除：更正即新增一条汇率，同一日期以最后记录者为准。单据保留入账时所用汇率。',
  },

  // ── Documents ──
  'cur.baseOption': {
    en: '{code} (base currency)',
    id: '{code} (mata uang dasar)',
    zh: '{code}（本位币）',
  },
  'cur.common': { en: 'Common', id: 'Umum', zh: '常用' },
  'cur.all': { en: 'All currencies', id: 'Semua mata uang', zh: '全部货币' },
  'cur.currency': { en: 'Currency', id: 'Mata uang', zh: '币种' },
  'cur.rateLabel': {
    en: 'Exchange rate {from} → {to}',
    id: 'Kurs {from} → {to}',
    zh: '汇率 {from} → {to}',
  },
  'cur.rateLoading': { en: 'Looking up the rate…', id: 'Mencari kurs…', zh: '正在查询汇率…' },
  'cur.rateFrom': {
    en: 'Rate of {date} · {source}',
    id: 'Kurs tanggal {date} · {source}',
    zh: '{date} 汇率 · {source}',
  },
  'cur.inverse': {
    en: 'from the reverse pair',
    id: 'dari pasangan kebalikan',
    zh: '由反向汇率换算',
  },
  'cur.justFetched': { en: 'just fetched', id: 'baru diambil', zh: '刚获取' },
  'cur.rateMissing': {
    en: 'No {from} → {to} rate for {date}.',
    id: 'Belum ada kurs {from} → {to} untuk {date}.',
    zh: '{date} 没有 {from} → {to} 汇率。',
  },
  'cur.rateStale': {
    en: 'The latest {from} → {to} rate is from {date}, too old to use automatically.',
    id: 'Kurs {from} → {to} terbaru bertanggal {date}, terlalu lama untuk dipakai otomatis.',
    zh: '最新的 {from} → {to} 汇率日期为 {date}，过旧，无法自动使用。',
  },
  'cur.fetchError.forbidden': {
    en: 'Your role cannot fetch rates. Enter the rate, or ask Finance or the owner to add one.',
    id: 'Peran Anda tidak dapat mengambil kurs. Isi kurs, atau minta Keuangan/pemilik menambahkannya.',
    zh: '您的角色无法获取汇率。请手动输入，或请财务/所有者添加。',
  },
  'cur.fetchError.disabled': {
    en: 'Automatic rates are off on this server. Enter the rate.',
    id: 'Kurs otomatis dimatikan di server ini. Isi kursnya.',
    zh: '本服务器已关闭自动汇率，请手动输入。',
  },
  'cur.fetchError.notFound': {
    en: 'The rate provider has no rate for this pair and date. Enter the rate.',
    id: 'Penyedia kurs tidak punya kurs untuk pasangan dan tanggal ini. Isi kursnya.',
    zh: '汇率提供方没有该货币对和日期的汇率，请手动输入。',
  },
  'cur.fetchError.unavailable': {
    en: 'The rate provider could not be reached. Try again, or enter the rate.',
    id: 'Penyedia kurs tidak dapat dihubungi. Coba lagi, atau isi kursnya.',
    zh: '无法连接汇率提供方。请重试或手动输入。',
  },
  'cur.retry': { en: 'Try again', id: 'Coba lagi', zh: '重试' },
  'cur.enterManually': { en: 'Enter a different rate', id: 'Isi kurs lain', zh: '输入其他汇率' },
  'cur.useStored': {
    en: 'Use the stored rate instead',
    id: 'Pakai kurs tersimpan',
    zh: '改用已存汇率',
  },
  'cur.ratePlaceholder': {
    en: '{to} per 1 {from}',
    id: '{to} per 1 {from}',
    zh: '每 1 {from} 兑 {to}',
  },
  'cur.manualNote': {
    en: 'Recorded as a manual rate for {date}.',
    id: 'Dicatat sebagai kurs manual untuk {date}.',
    zh: '记为 {date} 的手动汇率。',
  },
  'cur.atRate': { en: 'at {rate}', id: 'kurs {rate}', zh: '汇率 {rate}' },
  'cur.equivalentTitle': {
    en: 'Base-currency amount stored with the document. Rate {rate} of {date} ({source}).',
    id: 'Jumlah mata uang dasar yang tersimpan pada dokumen. Kurs {rate} tanggal {date} ({source}).',
    zh: '单据保存的本位币金额。汇率 {rate}，日期 {date}（{source}）。',
  },
  'cur.dateUnknown': { en: 'date not recorded', id: 'tanggal tidak tercatat', zh: '未记录日期' },
  'cur.source.manual': { en: 'entered by hand', id: 'diisi manual', zh: '手动输入' },
  'cur.source.rate_table': { en: 'exchange-rate table', id: 'tabel kurs', zh: '汇率表' },
  'cur.source.document': { en: 'document rate', id: 'kurs dokumen', zh: '单据汇率' },
  'cur.source.legacy': {
    en: 'entered before rate sources were recorded',
    id: 'diisi sebelum sumber kurs dicatat',
    zh: '在记录汇率来源之前输入',
  },
  'cur.receiptRate': {
    en: 'Goods are valued at the receipt-date rate.',
    id: 'Barang dinilai dengan kurs tanggal penerimaan.',
    zh: '货物按收货日汇率计价。',
  },
  'cur.invoiceRate': {
    en: 'The invoice uses the rate of its date (today).',
    id: 'Faktur memakai kurs tanggalnya (hari ini).',
    zh: '发票使用开票日（今天）的汇率。',
  },
  'cur.orderRateNote': {
    en: 'Order-date rate, for reference and approvals; stock and revenue use the receipt or invoice date rate.',
    id: 'Kurs tanggal pesanan, untuk referensi dan persetujuan; persediaan dan pendapatan memakai kurs tanggal penerimaan atau faktur.',
    zh: '订单日汇率，仅供参考与审批；库存与收入按收货或开票日汇率计。',
  },
  'cur.inBase': { en: 'in {code}', id: 'dalam {code}', zh: '以 {code} 计' },

  // ── Errors ──
  'cur.err.forbidden': {
    en: 'Your role does not allow this.',
    id: 'Peran Anda tidak mengizinkan ini.',
    zh: '您的角色不允许此操作。',
  },
  'cur.err.invalid': {
    en: 'Check the currency, rate and date.',
    id: 'Periksa mata uang, kurs, dan tanggal.',
    zh: '请检查币种、汇率和日期。',
  },
  'cur.err.failed': {
    en: 'That did not work. Try again.',
    id: 'Gagal. Coba lagi.',
    zh: '操作未成功，请重试。',
  },
  'cur.err.unavailable': {
    en: 'Currency settings are not available (the database may need the latest migration).',
    id: 'Pengaturan mata uang tidak tersedia (database mungkin perlu migrasi terbaru).',
    zh: '货币设置不可用（数据库可能需要最新迁移）。',
  },
  'cur.err.provider_disabled': {
    en: 'Automatic rates are off on this server.',
    id: 'Kurs otomatis dimatikan di server ini.',
    zh: '本服务器已关闭自动汇率。',
  },
  'cur.err.provider_unavailable': {
    en: 'The rate provider could not be reached.',
    id: 'Penyedia kurs tidak dapat dihubungi.',
    zh: '无法连接汇率提供方。',
  },
  'cur.err.provider_notFound': {
    en: 'The rate provider has no rate for that currency and date.',
    id: 'Penyedia kurs tidak punya kurs untuk mata uang dan tanggal itu.',
    zh: '汇率提供方没有该币种和日期的汇率。',
  },
  'cur.err.provider_invalidResponse': {
    en: 'The rate provider sent data PrintStream could not check, so nothing was stored.',
    id: 'Penyedia kurs mengirim data yang tidak dapat diperiksa PrintStream, jadi tidak ada yang disimpan.',
    zh: '汇率提供方返回的数据无法校验，未存储任何内容。',
  },
} satisfies Record<string, Entry>;
