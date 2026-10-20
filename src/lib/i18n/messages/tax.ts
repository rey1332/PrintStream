import type { Entry } from './types';

// Indonesian tax (/erp/tax, src/app/erp/lib/taxService.ts, docs/teknis/TAX.md).
export const taxMessages = {
  'erp.nav.tax': { en: 'Tax', id: 'Pajak', zh: '税务' },
  'tax.item.goods': { en: 'Goods (A)', id: 'Barang (A)', zh: '商品 (A)' },
  'tax.item.service': { en: 'Service (B)', id: 'Jasa (B)', zh: '服务 (B)' },
  'tax.item.help': {
    en: 'For e-Faktur lines. Leave 000000 unless Coretax asks for a specific code.',
    id: 'Untuk baris e-Faktur. Biarkan 000000 kecuali Coretax meminta kode tertentu.',
    zh: '用于电子发票明细。除非 Coretax 要求特定代码，否则保留 000000。',
  },
  'company.nitku': {
    en: 'NITKU (e-Faktur, 22 digits)',
    id: 'NITKU (e-Faktur, 22 digit)',
    zh: 'NITKU（电子发票，22 位）',
  },
  'acc.src.supplier_bill': { en: 'Supplier bill', id: 'Tagihan pemasok', zh: '供应商账单' },
  'acc.src.supplier_bill_void': {
    en: 'Supplier bill voided',
    id: 'Tagihan pemasok dibatalkan',
    zh: '供应商账单作废',
  },

  'tax.title': { en: 'Tax', id: 'Pajak', zh: '税务' },
  'tax.subtitle': {
    en: 'e-Faktur for Coretax, supplier bills with PPh 23, and the monthly tax summary.',
    id: 'e-Faktur untuk Coretax, tagihan pemasok dengan PPh 23, dan ringkasan pajak bulanan.',
    zh: 'Coretax 电子发票、含 PPh 23 的供应商账单及每月税务汇总。',
  },
  'tax.month': { en: 'Month', id: 'Bulan', zh: '月份' },
  'tax.tab.faktur': { en: 'e-Faktur', id: 'e-Faktur', zh: '电子发票' },
  'tax.tab.bills': { en: 'Supplier bills', id: 'Tagihan pemasok', zh: '供应商账单' },
  'tax.tab.summary': { en: 'Summary', id: 'Ringkasan', zh: '汇总' },

  'tax.col.invoice': { en: 'Invoice', id: 'Faktur penjualan', zh: '发票' },
  'tax.col.customer': { en: 'Customer', id: 'Pelanggan', zh: '客户' },
  'tax.col.supplier': { en: 'Supplier', id: 'Pemasok', zh: '供应商' },
  'tax.col.bill': { en: 'Bill', id: 'Tagihan', zh: '账单' },
  'tax.col.dpp': { en: 'DPP', id: 'DPP', zh: '税基 (DPP)' },
  'tax.col.ppn': { en: 'PPN', id: 'PPN', zh: '增值税 (PPN)' },
  'tax.col.pph23': { en: 'PPh 23', id: 'PPh 23', zh: 'PPh 23' },
  'tax.col.open': { en: 'To pay', id: 'Sisa bayar', zh: '待付' },
  'tax.col.code': { en: 'Code', id: 'Kode', zh: '代码' },
  'tax.col.faktur': { en: 'Faktur', id: 'Faktur', zh: '发票号' },
  'tax.col.bupot': { en: 'Bukti potong', id: 'Bukti potong', zh: '扣缴凭证' },

  'tax.status.none': { en: 'not exported', id: 'belum diekspor', zh: '未导出' },
  'tax.status.exported': {
    en: 'exported, waiting for Coretax',
    id: 'sudah diekspor, menunggu Coretax',
    zh: '已导出，等待 Coretax',
  },
  'tax.status.approved': { en: 'approved', id: 'disetujui', zh: '已批准' },

  'tax.trx.01': {
    en: 'to buyers that are not collectors (full DPP)',
    id: 'kepada pihak yang bukan pemungut PPN (DPP penuh)',
    zh: '向非代收方（全额税基）',
  },
  'tax.trx.02': {
    en: 'to government collectors',
    id: 'kepada pemungut PPN instansi pemerintah',
    zh: '向政府代收方',
  },
  'tax.trx.03': {
    en: 'to other collectors (BUMN)',
    id: 'kepada pemungut PPN selain instansi pemerintah',
    zh: '向其他代收方',
  },
  'tax.trx.04': {
    en: 'DPP nilai lain (11/12 at 12%)',
    id: 'DPP nilai lain (11/12 dengan tarif 12%)',
    zh: '其他税基 (12% 税率下 11/12)',
  },
  'tax.trx.05': { en: 'deemed rate (besaran tertentu)', id: 'besaran tertentu', zh: '特定比率' },
  'tax.trx.06': {
    en: 'to foreign tourists',
    id: 'kepada orang pribadi pemegang paspor luar negeri',
    zh: '向外国游客',
  },
  'tax.trx.07': {
    en: 'facility: PPN not collected',
    id: 'penyerahan yang PPN-nya tidak dipungut',
    zh: '优惠：不征收增值税',
  },
  'tax.trx.08': {
    en: 'facility: PPN exempt',
    id: 'penyerahan yang dibebaskan dari pengenaan PPN',
    zh: '优惠：免征增值税',
  },
  'tax.trx.09': {
    en: 'sale of assets (Pasal 16D)',
    id: 'penyerahan aktiva (Pasal 16D)',
    zh: '资产转让 (第 16D 条)',
  },
  'tax.trx.10': { en: 'other deliveries', id: 'penyerahan lainnya', zh: '其他交付' },

  'tax.faktur.totals': {
    en: '{count} taxed invoices · DPP {dpp} · PPN {ppn}',
    id: '{count} faktur kena pajak · DPP {dpp} · PPN {ppn}',
    zh: '{count} 张应税发票 · 税基 {dpp} · 增值税 {ppn}',
  },
  'tax.faktur.export': {
    en: 'Coretax XML ({count})',
    id: 'XML Coretax ({count})',
    zh: 'Coretax XML ({count})',
  },
  'tax.faktur.exported': {
    en: '{count} invoices in the Coretax file. Import it in Coretax, then enter the approved faktur numbers here.',
    id: '{count} faktur masuk file Coretax. Impor di Coretax, lalu isi nomor faktur yang disetujui di sini.',
    zh: '{count} 张发票已写入 Coretax 文件。请在 Coretax 中导入，然后在此填写已批准的发票号码。',
  },
  'tax.faktur.empty': {
    en: 'No taxed invoices this month.',
    id: 'Tidak ada faktur kena pajak bulan ini.',
    zh: '本月没有应税发票。',
  },
  'tax.faktur.choose': {
    en: 'Include {invoice} in the file',
    id: 'Masukkan {invoice} ke file',
    zh: '将 {invoice} 加入文件',
  },
  'tax.faktur.edit': {
    en: 'Code and faktur number',
    id: 'Kode dan nomor faktur',
    zh: '代码与发票号码',
  },
  'tax.faktur.title': {
    en: 'Faktur for {invoice}',
    id: 'Faktur untuk {invoice}',
    zh: '{invoice} 的发票',
  },
  'tax.faktur.trxCode': { en: 'Transaction code', id: 'Kode transaksi', zh: '交易代码' },
  'tax.faktur.trxCodeHint': {
    en: 'Automatic: 04 for 11% (DPP nilai lain), 01 for other rates. Fixed once the faktur is approved.',
    id: 'Otomatis: 04 untuk 11% (DPP nilai lain), 01 untuk tarif lain. Tidak bisa diubah setelah faktur disetujui.',
    zh: '自动：11% 为 04（其他税基），其他税率为 01。发票批准后不可更改。',
  },
  'tax.faktur.number': {
    en: 'Faktur number from Coretax',
    id: 'Nomor faktur dari Coretax',
    zh: 'Coretax 发票号码',
  },
  'tax.faktur.numberHint': {
    en: '17 digits, after Coretax approved the faktur. Empty: not approved yet.',
    id: '17 digit, setelah Coretax menyetujui faktur. Kosong: belum disetujui.',
    zh: 'Coretax 批准后的 17 位号码。为空表示尚未批准。',
  },
  'tax.faktur.date': { en: 'Faktur date', id: 'Tanggal faktur', zh: '发票日期' },
  'tax.faktur.howTo': {
    en: 'Choose the invoices, download the XML, import it in Coretax (e-Faktur → Pajak Keluaran → Impor), then record each approved number. Invoices with missing data cannot be chosen until it is filled in.',
    id: 'Pilih faktur, unduh XML, impor di Coretax (e-Faktur → Pajak Keluaran → Impor), lalu catat setiap nomor yang disetujui. Faktur yang datanya belum lengkap baru bisa dipilih setelah dilengkapi.',
    zh: '选择发票，下载 XML，在 Coretax 中导入（e-Faktur → Pajak Keluaran → Impor），然后记录每个已批准的号码。数据不全的发票需补全后才能选择。',
  },
  'tax.missing.sellerNpwp': {
    en: 'Your NPWP is missing (Settings → Company profile)',
    id: 'NPWP perusahaan belum diisi (Pengaturan → Profil perusahaan)',
    zh: '缺少本公司 NPWP（设置 → 公司资料）',
  },
  'tax.missing.sellerNitku': {
    en: 'Your NITKU is missing (Settings → Company profile)',
    id: 'NITKU perusahaan belum diisi (Pengaturan → Profil perusahaan)',
    zh: '缺少本公司 NITKU（设置 → 公司资料）',
  },
  'tax.missing.customer': {
    en: 'No customer record',
    id: 'Tidak ada data pelanggan',
    zh: '无客户记录',
  },
  'tax.missing.customerTaxId': {
    en: 'The customer has no NPWP or NIK',
    id: 'Pelanggan belum punya NPWP atau NIK',
    zh: '客户没有 NPWP 或 NIK',
  },
  'tax.missing.customerNitku': {
    en: 'The customer has no NITKU',
    id: 'Pelanggan belum punya NITKU',
    zh: '客户没有 NITKU',
  },
  'tax.missing.lines': {
    en: 'The invoice has no lines',
    id: 'Faktur tidak punya baris',
    zh: '发票没有明细',
  },
  'tax.missing.currency': {
    en: 'Foreign currency: make this faktur in Coretax by hand',
    id: 'Mata uang asing: buat faktur ini manual di Coretax',
    zh: '外币：请在 Coretax 中手动开具此发票',
  },
  'tax.problem.seller_npwp': {
    en: '{invoice}: your NPWP is not 16 digits',
    id: '{invoice}: NPWP perusahaan bukan 16 digit',
    zh: '{invoice}：本公司 NPWP 不是 16 位',
  },
  'tax.problem.seller_nitku': {
    en: '{invoice}: your NITKU is not 22 digits',
    id: '{invoice}: NITKU perusahaan bukan 22 digit',
    zh: '{invoice}：本公司 NITKU 不是 22 位',
  },
  'tax.problem.buyer_tax_id': {
    en: '{invoice}: the customer has no valid NPWP or NIK',
    id: '{invoice}: pelanggan tidak punya NPWP atau NIK yang valid',
    zh: '{invoice}：客户没有有效的 NPWP 或 NIK',
  },
  'tax.problem.no_lines': {
    en: '{invoice}: no invoice lines',
    id: '{invoice}: tidak ada baris faktur',
    zh: '{invoice}：没有发票明细',
  },
  'tax.problem.vat': {
    en: '{invoice}: the invoice booked PPN {booked}, the faktur would show {faktur}. Check the transaction code and the rate.',
    id: '{invoice}: faktur penjualan mencatat PPN {booked}, e-Faktur akan menunjukkan {faktur}. Periksa kode transaksi dan tarif.',
    zh: '{invoice}：发票记账增值税为 {booked}，电子发票将显示 {faktur}。请检查交易代码和税率。',
  },

  'tax.withheld.title': {
    en: 'PPh 23 withheld by the customer',
    id: 'PPh 23 dipotong pelanggan',
    zh: '客户代扣的 PPh 23',
  },
  'tax.withheld.intro': {
    en: 'The customer paid {invoice} less the PPh 23 they withheld and gave you a bukti potong. Usually 2% of the DPP ({dpp}). The amount settles the invoice like a payment and is booked as prepaid PPh 23.',
    id: 'Pelanggan membayar {invoice} dikurangi PPh 23 yang mereka potong dan memberi bukti potong. Biasanya 2% dari DPP ({dpp}). Jumlah ini melunasi faktur seperti pembayaran dan dicatat sebagai PPh 23 dibayar di muka.',
    zh: '客户支付 {invoice} 时扣除了 PPh 23 并提供了扣缴凭证。通常为税基 ({dpp}) 的 2%。该金额像付款一样冲减发票，并记为预缴 PPh 23。',
  },
  'tax.withheld.amount': { en: 'PPh 23 withheld', id: 'PPh 23 yang dipotong', zh: '代扣 PPh 23' },
  'tax.withheld.date': { en: 'Date', id: 'Tanggal', zh: '日期' },
  'tax.withheld.bupot': { en: 'Bukti potong number', id: 'Nomor bukti potong', zh: '扣缴凭证号码' },
  'tax.withheld.bupotHint': {
    en: 'From the customer’s e-Bupot. Credited against your annual income tax.',
    id: 'Dari e-Bupot pelanggan. Menjadi kredit pajak penghasilan tahunan Anda.',
    zh: '来自客户的 e-Bupot，可抵扣您的年度所得税。',
  },
  'tax.withheld.saved': {
    en: 'PPh 23 recorded on the invoice.',
    id: 'PPh 23 dicatat pada faktur.',
    zh: '已在发票上记录 PPh 23。',
  },

  'tax.bills.totals': {
    en: 'PPN masukan {ppn} · PPh 23 withheld {pph} · still to pay {open}',
    id: 'PPN masukan {ppn} · PPh 23 dipotong {pph} · sisa bayar {open}',
    zh: '进项增值税 {ppn} · 代扣 PPh 23 {pph} · 待付 {open}',
  },
  'tax.bills.pph23Csv': {
    en: 'PPh 23 list (CSV)',
    id: 'Daftar PPh 23 (CSV)',
    zh: 'PPh 23 清单 (CSV)',
  },
  'tax.bills.empty': {
    en: 'No supplier bills this month.',
    id: 'Tidak ada tagihan pemasok bulan ini.',
    zh: '本月没有供应商账单。',
  },
  'tax.bills.noTaxId': {
    en: 'No NPWP / NIK on record: complete the supplier before the bukti potong',
    id: 'NPWP / NIK belum ada: lengkapi data pemasok sebelum membuat bukti potong',
    zh: '无 NPWP / NIK：开具扣缴凭证前请补全供应商资料',
  },
  'tax.bills.paid': { en: 'paid', id: 'lunas', zh: '已付' },
  'tax.bills.bupotMissing': { en: 'not issued yet', id: 'belum dibuat', zh: '尚未开具' },
  'tax.bills.voided': { en: 'Void: {reason}', id: 'Batal: {reason}', zh: '作废：{reason}' },
  'tax.bills.void': { en: 'Void bill', id: 'Batalkan tagihan', zh: '作废账单' },
  'tax.bills.voidHelp': {
    en: 'The bill from {supplier} and its journal entry are reversed. Only for unpaid bills without a bukti potong.',
    id: 'Tagihan dari {supplier} dan jurnalnya dibalik. Hanya untuk tagihan yang belum dibayar dan belum ada bukti potong.',
    zh: '{supplier} 的账单及其分录将被冲回。仅适用于未付款且未开具扣缴凭证的账单。',
  },

  'tax.bill.new': { en: 'New supplier bill', id: 'Tagihan pemasok baru', zh: '新建供应商账单' },
  'tax.bill.supplier': { en: 'Supplier', id: 'Pemasok', zh: '供应商' },
  'tax.bill.otherSupplier': {
    en: 'Not in the supplier list…',
    id: 'Tidak ada di daftar pemasok…',
    zh: '不在供应商列表中…',
  },
  'tax.bill.supplierName': { en: 'Supplier name', id: 'Nama pemasok', zh: '供应商名称' },
  'tax.bill.billNo': {
    en: 'Supplier’s invoice number',
    id: 'Nomor tagihan pemasok',
    zh: '供应商发票号',
  },
  'tax.bill.description': { en: 'What it is for', id: 'Keperluan', zh: '用途' },
  'tax.bill.date': { en: 'Bill date', id: 'Tanggal tagihan', zh: '账单日期' },
  'tax.bill.due': { en: 'Due date', id: 'Jatuh tempo', zh: '到期日' },
  'tax.bill.account': { en: 'Expense account', id: 'Akun beban', zh: '费用科目' },
  'tax.bill.accountHint': {
    en: 'Rental, repair, fuel, … ; an asset account for things you keep (fixed assets).',
    id: 'Sewa, perbaikan, BBM, … ; akun aset untuk barang yang disimpan (aset tetap).',
    zh: '租赁、维修、燃油……；长期持有的物品请用资产科目（固定资产）。',
  },
  'tax.bill.defaultAccount': { en: 'Operating expenses', id: 'Beban operasional', zh: '营业费用' },
  'tax.bill.dpp': {
    en: 'Amount before tax (DPP)',
    id: 'Jumlah sebelum pajak (DPP)',
    zh: '税前金额 (DPP)',
  },
  'tax.bill.ppn': { en: 'PPN masukan', id: 'PPN masukan', zh: '进项增值税' },
  'tax.bill.ppnHint': {
    en: 'As on the supplier’s faktur; 0 if they are not PKP.',
    id: 'Sesuai faktur pemasok; 0 jika pemasok bukan PKP.',
    zh: '按供应商发票填写；如供应商非 PKP 则为 0。',
  },
  'tax.bill.faktur': {
    en: 'Supplier’s faktur number',
    id: 'Nomor faktur pemasok',
    zh: '供应商发票号码',
  },
  'tax.bill.fakturDate': { en: 'Faktur date', id: 'Tanggal faktur', zh: '发票日期' },
  'tax.bill.pph23Rate': {
    en: 'PPh 23 to withhold',
    id: 'PPh 23 yang dipotong',
    zh: '应代扣 PPh 23',
  },
  'tax.bill.pph23RateHint': {
    en: '2% for rentals and services; withheld from what you pay and paid to the tax office by the 15th of next month.',
    id: '2% untuk sewa dan jasa; dipotong dari pembayaran dan disetor paling lambat tanggal 15 bulan berikutnya.',
    zh: '租赁和服务为 2%；从付款中扣除，并于次月 15 日前缴纳。',
  },
  'tax.bill.noNpwpHint': {
    en: 'This supplier has no NPWP on record: the rate is twice as high (4%) unless they give one.',
    id: 'Pemasok ini belum punya NPWP: tarifnya dua kali lipat (4%) kecuali mereka memberikan NPWP.',
    zh: '该供应商无 NPWP：除非提供，否则税率加倍 (4%)。',
  },
  'tax.bill.noPph23': { en: 'No PPh 23', id: 'Tanpa PPh 23', zh: '无 PPh 23' },
  'tax.bill.objectCode': { en: 'Tax object code', id: 'Kode objek pajak', zh: '课税对象代码' },
  'tax.bill.pph23': { en: 'PPh 23', id: 'PPh 23', zh: 'PPh 23' },
  'tax.bill.payable': { en: 'To pay the supplier', id: 'Dibayar ke pemasok', zh: '应付供应商' },
  'tax.bill.expense': { en: 'Expense', id: 'Beban', zh: '费用' },
  'tax.bill.save': { en: 'Record bill', id: 'Catat tagihan', zh: '记录账单' },
  'tax.obj.rental': {
    en: 'Rental of assets (equipment, vehicles)',
    id: 'Sewa harta (alat berat, kendaraan)',
    zh: '资产租赁（设备、车辆）',
  },
  'tax.obj.services': { en: 'Other services', id: 'Jasa lain', zh: '其他服务' },
  'tax.obj.transport': { en: 'Transport services', id: 'Jasa angkutan', zh: '运输服务' },

  'tax.pay.title': { en: 'Pay {supplier}', id: 'Bayar {supplier}', zh: '支付 {supplier}' },
  'tax.pay.open': {
    en: 'Still to pay: {amount}',
    id: 'Sisa bayar: {amount}',
    zh: '待付：{amount}',
  },
  'tax.pay.amount': { en: 'Amount', id: 'Jumlah', zh: '金额' },
  'tax.pay.date': { en: 'Payment date', id: 'Tanggal bayar', zh: '付款日期' },
  'tax.pay.method': { en: 'Method', id: 'Cara bayar', zh: '方式' },
  'tax.pay.save': { en: 'Record payment', id: 'Catat pembayaran', zh: '记录付款' },

  'tax.bupot.action': { en: 'Bukti potong', id: 'Bukti potong', zh: '扣缴凭证' },
  'tax.bupot.title': {
    en: 'Bukti potong for {supplier}',
    id: 'Bukti potong untuk {supplier}',
    zh: '{supplier} 的扣缴凭证',
  },
  'tax.bupot.intro': {
    en: 'Issue the bukti potong in Coretax (e-Bupot Unifikasi), then record its number here so the bill shows as done.',
    id: 'Buat bukti potong di Coretax (e-Bupot Unifikasi), lalu catat nomornya di sini agar tagihan tercatat selesai.',
    zh: '请在 Coretax（e-Bupot Unifikasi）中开具扣缴凭证，然后在此记录号码。',
  },
  'tax.bupot.number': { en: 'Bukti potong number', id: 'Nomor bukti potong', zh: '扣缴凭证号码' },
  'tax.bupot.numberHint': {
    en: 'Empty to clear it.',
    id: 'Kosongkan untuk menghapus.',
    zh: '留空以清除。',
  },
  'tax.bupot.date': { en: 'Date', id: 'Tanggal', zh: '日期' },

  'tax.sum.ppnOut': { en: 'PPN keluaran', id: 'PPN keluaran', zh: '销项增值税' },
  'tax.sum.ppnIn': { en: 'PPN masukan', id: 'PPN masukan', zh: '进项增值税' },
  'tax.sum.ppnNet': { en: 'PPN to pay', id: 'PPN kurang bayar', zh: '应缴增值税' },
  'tax.sum.pph21': { en: 'PPh 21', id: 'PPh 21', zh: 'PPh 21' },
  'tax.sum.pph23': { en: 'PPh 23 withheld', id: 'PPh 23 dipotong', zh: '代扣 PPh 23' },
  'tax.sum.pph23Prepaid': {
    en: 'PPh 23 withheld from you',
    id: 'PPh 23 dipotong pihak lain',
    zh: '被代扣 PPh 23',
  },
  'tax.sum.open': { en: 'Still open', id: 'Belum selesai', zh: '未完成' },
  'tax.sum.openFaktur': {
    en: '{count} invoices without an approved faktur',
    id: '{count} faktur penjualan belum disetujui',
    zh: '{count} 张发票未获批准',
  },
  'tax.sum.openBupot': {
    en: '{count} bills without a bukti potong',
    id: '{count} tagihan belum ada bukti potong',
    zh: '{count} 张账单未开扣缴凭证',
  },
  'tax.sum.note': {
    en: 'From the ledger: PPN keluaran and masukan booked in the month, PPh 21 from payroll, PPh 23 from supplier bills and from customers. A negative PPN means more input than output tax (lebih bayar). Check against Coretax before you file.',
    id: 'Dari buku besar: PPN keluaran dan masukan yang dicatat bulan itu, PPh 21 dari penggajian, PPh 23 dari tagihan pemasok dan dari pelanggan. PPN negatif berarti lebih bayar. Cocokkan dengan Coretax sebelum lapor.',
    zh: '来自总账：当月记录的销项和进项增值税、工资中的 PPh 21、供应商账单及客户的 PPh 23。增值税为负表示多缴 (lebih bayar)。申报前请与 Coretax 核对。',
  },

  'tax.party.title': { en: 'Tax data', id: 'Data pajak', zh: '税务资料' },
  'tax.party.idType': { en: 'Tax ID', id: 'Identitas pajak', zh: '税务证件' },
  'tax.party.none': { en: 'None', id: 'Tidak ada', zh: '无' },
  'tax.party.passport': { en: 'Passport', id: 'Paspor', zh: '护照' },
  'tax.party.other': { en: 'Other ID', id: 'Identitas lain', zh: '其他证件' },
  'tax.party.number': { en: 'Number', id: 'Nomor', zh: '号码' },
  'tax.party.nitkuHint': {
    en: '22 digits: the NPWP and 6 digits for the place of business (000000 for the head office).',
    id: '22 digit: NPWP dan 6 digit tempat kegiatan usaha (000000 untuk kantor pusat).',
    zh: '22 位：NPWP 加 6 位营业地点代码（总部为 000000）。',
  },
  'tax.party.name': {
    en: 'Name for tax documents',
    id: 'Nama di dokumen pajak',
    zh: '税务文件上的名称',
  },
  'tax.party.address': {
    en: 'Address for tax documents',
    id: 'Alamat di dokumen pajak',
    zh: '税务文件上的地址',
  },
  'tax.party.pkp': {
    en: 'VAT-registered business (PKP)',
    id: 'Pengusaha Kena Pajak (PKP)',
    zh: '增值税登记企业 (PKP)',
  },

  'tax.err.failed': {
    en: 'That did not work. Try again.',
    id: 'Tidak berhasil. Coba lagi.',
    zh: '操作失败，请重试。',
  },
  'tax.err.taxData': {
    en: 'Check the tax data: NPWP and NIK have 16 digits, NITKU 22.',
    id: 'Periksa data pajak: NPWP dan NIK 16 digit, NITKU 22 digit.',
    zh: '请检查税务资料：NPWP 和 NIK 为 16 位，NITKU 为 22 位。',
  },
  'tax.err.npwp': {
    en: 'An NPWP has 16 digits.',
    id: 'NPWP terdiri dari 16 digit.',
    zh: 'NPWP 为 16 位。',
  },
  'tax.err.nik': {
    en: 'A NIK has 16 digits.',
    id: 'NIK terdiri dari 16 digit.',
    zh: 'NIK 为 16 位。',
  },
  'tax.err.nitku': {
    en: 'A NITKU has 22 digits.',
    id: 'NITKU terdiri dari 22 digit.',
    zh: 'NITKU 为 22 位。',
  },
  'tax.err.otherId': {
    en: 'Enter the ID number.',
    id: 'Isi nomor identitas.',
    zh: '请填写证件号码。',
  },
  'tax.err.fakturNumber': {
    en: 'A faktur number has 17 digits.',
    id: 'Nomor faktur terdiri dari 17 digit.',
    zh: '发票号码为 17 位。',
  },
  'tax.err.fakturTaken': {
    en: 'Another invoice already has this faktur number.',
    id: 'Nomor faktur ini sudah dipakai faktur lain.',
    zh: '该发票号码已被其他发票使用。',
  },
  'tax.err.approved': {
    en: 'The faktur is approved: its transaction code cannot change.',
    id: 'Faktur sudah disetujui: kode transaksinya tidak bisa diubah.',
    zh: '发票已批准，交易代码不可更改。',
  },
  'tax.err.invoices': {
    en: 'Only taxed, not voided invoices have a faktur.',
    id: 'Hanya faktur kena pajak yang tidak batal yang punya e-Faktur.',
    zh: '只有未作废的应税发票才有电子发票。',
  },
  'tax.err.problems': {
    en: 'The Coretax file was not made:',
    id: 'File Coretax tidak dibuat:',
    zh: '未生成 Coretax 文件：',
  },
  'tax.err.twoFactor': {
    en: 'Tax exports need two-factor. Turn it on under Settings → Security, then sign in again with your code.',
    id: 'Ekspor pajak butuh verifikasi dua langkah. Aktifkan di Pengaturan → Keamanan, lalu masuk lagi dengan kode Anda.',
    zh: '税务导出需要双重验证。请在 设置 → 安全 中开启，然后使用验证码重新登录。',
  },
  'tax.err.fakturRequired': {
    en: 'PPN masukan needs the supplier’s faktur number (17 digits).',
    id: 'PPN masukan memerlukan nomor faktur pemasok (17 digit).',
    zh: '进项增值税需要供应商的发票号码（17 位）。',
  },
  'tax.err.objectCode': {
    en: 'Enter the tax object code (NN-NNN-NN).',
    id: 'Isi kode objek pajak (NN-NNN-NN).',
    zh: '请填写课税对象代码 (NN-NNN-NN)。',
  },
  'tax.err.required': {
    en: 'Enter the supplier, the date and what the bill is for.',
    id: 'Isi pemasok, tanggal, dan keperluan tagihan.',
    zh: '请填写供应商、日期和账单用途。',
  },
  'tax.err.due': {
    en: 'The due date is before the bill date.',
    id: 'Jatuh tempo sebelum tanggal tagihan.',
    zh: '到期日早于账单日期。',
  },
  'tax.err.amounts': {
    en: 'Enter the amount before tax; taxes cannot be negative.',
    id: 'Isi jumlah sebelum pajak; pajak tidak boleh negatif.',
    zh: '请填写税前金额；税额不能为负。',
  },
  'tax.err.amount': {
    en: 'The amount is more than what is still open.',
    id: 'Jumlah melebihi sisa yang belum dibayar.',
    zh: '金额超过未结金额。',
  },
  'tax.err.paid': {
    en: 'Void its payments first.',
    id: 'Batalkan dulu pembayarannya.',
    zh: '请先作废其付款。',
  },
  'tax.err.bupotIssued': {
    en: 'A bukti potong was issued for this bill: cancel it in e-Bupot first.',
    id: 'Bukti potong sudah dibuat untuk tagihan ini: batalkan dulu di e-Bupot.',
    zh: '该账单已开具扣缴凭证：请先在 e-Bupot 中撤销。',
  },
  'tax.err.bupotRequired': {
    en: 'Enter the bukti potong number.',
    id: 'Isi nomor bukti potong.',
    zh: '请填写扣缴凭证号码。',
  },
  'tax.err.noPph23': {
    en: 'This bill has no PPh 23.',
    id: 'Tagihan ini tanpa PPh 23.',
    zh: '该账单无 PPh 23。',
  },
  'tax.err.void': {
    en: 'This document is void.',
    id: 'Dokumen ini sudah batal.',
    zh: '该单据已作废。',
  },
  'tax.err.account': {
    en: 'Choose an active expense or asset account.',
    id: 'Pilih akun beban atau aset yang aktif.',
    zh: '请选择有效的费用或资产科目。',
  },
  'tax.err.currency': {
    en: 'PPh 23 is recorded on invoices in the base currency.',
    id: 'PPh 23 dicatat pada faktur dalam mata uang dasar.',
    zh: 'PPh 23 只能记录在本位币发票上。',
  },
  'tax.err.check': {
    en: 'Check the bill: amounts, faktur number (17 digits) and tax object code (NN-NNN-NN).',
    id: 'Periksa tagihan: jumlah, nomor faktur (17 digit), dan kode objek pajak (NN-NNN-NN).',
    zh: '请检查账单：金额、发票号码（17 位）和课税对象代码 (NN-NNN-NN)。',
  },
  'tax.err.ownerOnly': {
    en: 'Only the Owner or an Admin can void a bill.',
    id: 'Hanya Pemilik atau Admin yang bisa membatalkan tagihan.',
    zh: '只有所有者或管理员可以作废账单。',
  },
} satisfies Record<string, Entry>;
