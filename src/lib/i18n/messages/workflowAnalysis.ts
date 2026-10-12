import type { Entry } from './types';

export const workflowAnalysisMessages = {
  // ── Node ──
  'wf.node.src.erpSummary': { en: 'ERP Summary', id: 'Ringkasan ERP', zh: 'ERP 汇总' },
  'wf.desc.src.erpSummary': {
    en: 'Group and total ERP records in the database, over every matching record',
    id: 'Kelompokkan dan jumlahkan rekaman ERP di database, atas semua rekaman yang cocok',
    zh: '在数据库中对所有匹配的 ERP 记录分组并汇总',
  },

  // ── Summary panel ──
  'sum.panel.database': {
    en: 'Totals are calculated by the database over every matching record in this workspace, with your permissions. Nothing is changed.',
    id: 'Total dihitung oleh database atas semua rekaman yang cocok di workspace ini, dengan izin Anda. Tidak ada yang diubah.',
    zh: '合计由数据库按您的权限，对此工作区中所有匹配记录计算。不会修改任何数据。',
  },
  'sum.panel.groupBy': { en: 'Group by', id: 'Kelompokkan menurut', zh: '分组依据' },
  'sum.panel.groupHelp': {
    en: 'Each result row is one combination of these values. Without groups you get one row for all records.',
    id: 'Setiap baris hasil adalah satu kombinasi nilai ini. Tanpa pengelompokan, Anda mendapat satu baris untuk semua rekaman.',
    zh: '每个结果行对应这些值的一种组合。不分组时，所有记录汇总为一行。',
  },
  'sum.panel.remove': { en: 'Remove', id: 'Hapus', zh: '移除' },
  'sum.panel.bucket': { en: 'Date grouping', id: 'Pengelompokan tanggal', zh: '日期分组' },
  'sum.panel.addGroup': { en: 'Add group', id: 'Tambah kelompok', zh: '添加分组' },
  'sum.panel.measures': { en: 'Totals', id: 'Total', zh: '合计' },
  'sum.panel.measureHelp': {
    en: "Sums and averages use each record's own amounts once. A related record's amounts (e.g. a customer's balance) would repeat on every row, so they can only be counted or compared (min/max). \"Records\" is always included.",
    id: 'Jumlah dan rata-rata memakai nominal milik setiap rekaman satu kali. Nominal rekaman terkait (mis. saldo pelanggan) akan berulang di setiap baris, jadi hanya bisa dihitung atau dibandingkan (min/maks). "Rekaman" selalu disertakan.',
    zh: '求和与平均只计入每条记录自身的金额一次。关联记录的金额（如客户余额）会在每行重复，因此只能计数或比较（最小/最大）。始终包含“记录数”。',
  },
  'sum.panel.operation': { en: 'Calculation', id: 'Perhitungan', zh: '计算方式' },
  'sum.panel.field': { en: 'Field', id: 'Kolom', zh: '字段' },
  'sum.panel.addMeasure': { en: 'Add total', id: 'Tambah total', zh: '添加合计' },
  'sum.panel.currencyHelp': {
    en: 'Amounts in the document currency are only added up within one currency: group by Currency, or use the base-currency amount. Rows that would mix currencies are left empty.',
    id: 'Nominal dalam mata uang dokumen hanya dijumlahkan dalam satu mata uang: kelompokkan menurut Mata uang, atau gunakan nominal mata uang dasar. Baris yang mencampur mata uang dibiarkan kosong.',
    zh: '单据币种金额只在同一币种内相加：请按币种分组，或使用本位币金额。混合币种的行将留空。',
  },
  'sum.panel.includeInactive': {
    en: 'Include voided and cancelled records',
    id: 'Sertakan rekaman yang dibatalkan',
    zh: '包含已作废和已取消的记录',
  },
  'sum.panel.inactiveHelp': {
    en: 'Off by default, so totals match what is still in effect.',
    id: 'Mati secara default, agar total sesuai dengan yang masih berlaku.',
    zh: '默认关闭，使合计与仍然有效的记录一致。',
  },
  'sum.panel.sortGroups': { en: 'By group values', id: 'Menurut nilai kelompok', zh: '按分组值' },
  'sum.panel.limit': {
    en: 'Maximum rows (1–{max})',
    id: 'Baris maksimum (1–{max})',
    zh: '最大行数（1–{max}）',
  },
  'sum.panel.columns': {
    en: 'What each result row contains',
    id: 'Isi setiap baris hasil',
    zh: '每个结果行包含的内容',
  },

  'sum.opName.count': { en: 'Number of records', id: 'Jumlah rekaman', zh: '记录数' },
  'sum.opName.countDistinct': {
    en: 'Number of different values',
    id: 'Jumlah nilai berbeda',
    zh: '不同值的数量',
  },
  'sum.opName.sum': { en: 'Sum', id: 'Jumlah', zh: '求和' },
  'sum.opName.avg': { en: 'Average', id: 'Rata-rata', zh: '平均值' },
  'sum.opName.min': { en: 'Minimum', id: 'Minimum', zh: '最小值' },
  'sum.opName.max': { en: 'Maximum', id: 'Maksimum', zh: '最大值' },
  'sum.op.countDistinct': { en: 'Different {field}', id: '{field} berbeda', zh: '不同的{field}' },
  'sum.op.sum': { en: 'Sum of {field}', id: 'Jumlah {field}', zh: '{field}合计' },
  'sum.op.avg': { en: 'Average {field}', id: 'Rata-rata {field}', zh: '{field}平均值' },
  'sum.op.min': { en: 'Lowest {field}', id: '{field} terendah', zh: '最低{field}' },
  'sum.op.max': { en: 'Highest {field}', id: '{field} tertinggi', zh: '最高{field}' },
  'sum.op.count': { en: 'Records', id: 'Rekaman', zh: '记录数' },
  'sum.col.record_count': { en: 'Records', id: 'Rekaman', zh: '记录数' },
  'sum.bucketed': { en: '{field} ({bucket})', id: '{field} ({bucket})', zh: '{field}（{bucket}）' },
  'sum.bucket.exact': { en: 'Exact date', id: 'Tanggal persis', zh: '精确日期' },
  'sum.bucket.day': { en: 'day', id: 'hari', zh: '日' },
  'sum.bucket.month': { en: 'month', id: 'bulan', zh: '月' },
  'sum.bucket.quarter': { en: 'quarter', id: 'kuartal', zh: '季度' },
  'sum.bucket.year': { en: 'year', id: 'tahun', zh: '年' },

  'sum.meaning.count': {
    en: 'How many records this row covers; open the row to list them.',
    id: 'Berapa rekaman yang dicakup baris ini; buka baris untuk melihatnya.',
    zh: '该行涵盖的记录数；打开该行可列出这些记录。',
  },
  'sum.meaning.measure': {
    en: 'Calculated over the records of the row.',
    id: 'Dihitung atas rekaman pada baris tersebut.',
    zh: '按该行的记录计算。',
  },
  'sum.meaning.related': {
    en: 'Read through the linked {relation} (each record has at most one).',
    id: 'Dibaca melalui {relation} yang ditautkan (setiap rekaman paling banyak satu).',
    zh: '通过关联的{relation}读取（每条记录最多一个）。',
  },
  'sum.meaning.repeated': {
    en: 'Repeats on every row of the same parent record: can be counted or compared, not summed.',
    id: 'Berulang di setiap baris dengan induk yang sama: bisa dihitung atau dibandingkan, tidak dijumlahkan.',
    zh: '在同一上级记录的每一行重复：可计数或比较，不可求和。',
  },
  'sum.meaning.documentCurrency': {
    en: "In the document's own currency.",
    id: 'Dalam mata uang dokumen itu sendiri.',
    zh: '以单据自身币种计。',
  },

  // ── Summary errors and notices ──
  'sum.err.tooManyGroups': {
    en: 'Group by at most 3 fields.',
    id: 'Kelompokkan menurut paling banyak 3 kolom.',
    zh: '最多按 3 个字段分组。',
  },
  'sum.err.tooManyMeasures': {
    en: 'Use at most 8 totals.',
    id: 'Gunakan paling banyak 8 total.',
    zh: '最多 8 个合计。',
  },
  'sum.err.invalidGroupField': {
    en: '"{detail}" cannot be a group (amounts and values calculated when read cannot).',
    id: '"{detail}" tidak bisa menjadi kelompok (nominal dan nilai yang dihitung saat dibaca tidak bisa).',
    zh: '“{detail}”不能作为分组（金额和读取时计算的值不可分组）。',
  },
  'sum.err.invalidBucket': {
    en: 'Only dates can be grouped by day, month, quarter or year ("{detail}").',
    id: 'Hanya tanggal yang bisa dikelompokkan per hari, bulan, kuartal, atau tahun ("{detail}").',
    zh: '只有日期可按日、月、季度或年分组（“{detail}”）。',
  },
  'sum.err.currencyGroupRequired': {
    en: '"{detail}" is in each order\'s own currency: group by the order currency to total it.',
    id: '"{detail}" memakai mata uang tiap pesanan: kelompokkan menurut mata uang pesanan untuk menjumlahkannya.',
    zh: '“{detail}”使用各订单自身的币种：请按订单币种分组后再合计。',
  },
  'sum.err.invalidMeasure': {
    en: 'The calculation "{detail}" is not possible for this field.',
    id: 'Perhitungan "{detail}" tidak dapat dilakukan untuk kolom ini.',
    zh: '此字段无法进行“{detail}”计算。',
  },
  'sum.err.repeatedMeasure': {
    en: '"{detail}" belongs to a related record and repeats on each row; adding it up would count it several times. Start from that entity instead.',
    id: '"{detail}" milik rekaman terkait dan berulang di setiap baris; menjumlahkannya akan menghitungnya berkali-kali. Mulailah dari entitas tersebut.',
    zh: '“{detail}”属于关联记录，会在每行重复；求和会多次计算。请改为从该实体开始。',
  },
  'sum.err.duplicateColumn': {
    en: 'Two totals would produce the same column. Remove one.',
    id: 'Dua total akan menghasilkan kolom yang sama. Hapus salah satunya.',
    zh: '两个合计会生成相同的列，请删除一个。',
  },
  'sum.err.invalidLimit': {
    en: 'Maximum rows must be between 1 and {max}.',
    id: 'Baris maksimum harus antara 1 dan {max}.',
    zh: '最大行数须在 1 到 {max} 之间。',
  },
  'sum.notice.truncated': {
    en: 'Only the first {count} groups are shown; totals built on this table would be partial.',
    id: 'Hanya {count} kelompok pertama yang ditampilkan; total yang dibangun dari tabel ini akan parsial.',
    zh: '仅显示前 {count} 个分组；基于此表的合计将不完整。',
  },
  'sum.notice.mixedCurrency': {
    en: '{count} row(s) mix currencies; their document-currency totals are left empty. Group by Currency or use the base amount.',
    id: '{count} baris mencampur mata uang; total mata uang dokumennya dibiarkan kosong. Kelompokkan menurut Mata uang atau gunakan nominal dasar.',
    zh: '{count} 行混合了币种，其单据币种合计留空。请按币种分组或使用本位币金额。',
  },
  'sum.partial': {
    en: 'Partial: not all records were read',
    id: 'Parsial: tidak semua rekaman terbaca',
    zh: '不完整：未读取全部记录',
  },
  'sum.coverage': {
    en: 'covers {count} records',
    id: 'mencakup {count} rekaman',
    zh: '涵盖 {count} 条记录',
  },

  'wf.err.repeatedValues': {
    en: '"{column}" repeats a parent record\'s value on each row; summing or averaging it would count it several times. Aggregate on the parent\'s own data instead.',
    id: '"{column}" mengulang nilai rekaman induk di setiap baris; menjumlahkan atau merata-ratakannya akan menghitungnya berkali-kali. Agregasikan dari data induknya.',
    zh: '“{column}”在每行重复上级记录的值；求和或平均会多次计算。请改用上级记录自身的数据汇总。',
  },
  'wf.err.joinKeyMismatch': {
    en: '"{left}" and "{right}" identify different kinds of records or have different types, so they cannot be joined.',
    id: '"{left}" dan "{right}" mengidentifikasi jenis rekaman berbeda atau berbeda tipe, jadi tidak bisa digabungkan.',
    zh: '“{left}”与“{right}”标识不同类型的记录或类型不同，无法连接。',
  },
  'wf.err.summaryUnavailable': {
    en: 'Summaries run on the server; run the workflow again.',
    id: 'Ringkasan dijalankan di server; jalankan alur kerja lagi.',
    zh: '汇总在服务器上运行；请重新运行工作流。',
  },
  'wf.notice.partialTotals': {
    en: 'Totals cover only the {count} rows that were read, not every matching record. Use an ERP Summary step for complete totals.',
    id: 'Total hanya mencakup {count} baris yang terbaca, bukan semua rekaman yang cocok. Gunakan langkah Ringkasan ERP untuk total lengkap.',
    zh: '合计仅涵盖已读取的 {count} 行，而非所有匹配记录。如需完整合计，请使用 ERP 汇总步骤。',
  },
  'wf.notice.mixedCurrency': {
    en: '{count} group(s) of "{column}" mix currencies and were left empty.',
    id: '{count} kelompok "{column}" mencampur mata uang dan dibiarkan kosong.',
    zh: '“{column}”有 {count} 个分组混合币种，已留空。',
  },
  'wf.notice.currencyUnchecked': {
    en: '"{column}" is in each document\'s own currency, but the currency is not among the columns: include Currency to be sure amounts are not mixed.',
    id: '"{column}" dalam mata uang masing-masing dokumen, tetapi mata uangnya tidak ada di kolom: sertakan Mata uang untuk memastikan nominal tidak tercampur.',
    zh: '“{column}”以各单据自身币种计，但列中没有币种：请加入币种以确保金额未混合。',
  },

  // ── Drill-down ──
  'sum.drill.title': {
    en: 'Records behind this row',
    id: 'Rekaman di balik baris ini',
    zh: '该行对应的记录',
  },
  'sum.drill.hint': {
    en: 'Select a row to see the records it counts.',
    id: 'Pilih baris untuk melihat rekaman yang dihitungnya.',
    zh: '选择一行以查看其统计的记录。',
  },
  'sum.drill.shown': {
    en: '{shown} of {total} records',
    id: '{shown} dari {total} rekaman',
    zh: '{total} 条记录中的 {shown} 条',
  },
  'sum.drill.openModule': { en: 'Open {entity}', id: 'Buka {entity}', zh: '打开{entity}' },
  'sum.drill.none': {
    en: 'No records match any more (the data changed since the run).',
    id: 'Tidak ada rekaman yang cocok lagi (data berubah sejak dijalankan).',
    zh: '已无匹配记录（运行后数据已变化）。',
  },
  'sum.drill.note': {
    en: 'Read now with your permissions; the data may have changed since the run.',
    id: 'Dibaca sekarang dengan izin Anda; data mungkin berubah sejak dijalankan.',
    zh: '按您的权限即时读取；运行后数据可能已变化。',
  },
  'sum.drill.more': { en: 'Load more', id: 'Muat lagi', zh: '加载更多' },
  'sum.drill.unavailable': {
    en: 'The records for this row cannot be listed. Save and run the workflow again.',
    id: 'Rekaman untuk baris ini tidak dapat ditampilkan. Simpan dan jalankan alur kerja lagi.',
    zh: '无法列出该行的记录。请保存并重新运行工作流。',
  },
  'sum.drill.allRecords': { en: 'All records', id: 'Semua rekaman', zh: '全部记录' },

  // ── Touch editing ──
  'wf.palette.hint': {
    en: 'Drag onto the canvas, or click to add.',
    id: 'Seret ke kanvas, atau klik untuk menambah.',
    zh: '拖到画布上，或点击添加。',
  },
  'wf.palette.tapHint': {
    en: 'Tap a step to add it.',
    id: 'Ketuk langkah untuk menambahkannya.',
    zh: '点按步骤即可添加。',
  },
  'wf.palette.add': { en: 'Add step', id: 'Tambah langkah', zh: '添加步骤' },
  'wf.palette.emptyTouch': {
    en: 'Tap "Add step" to start',
    id: 'Ketuk "Tambah langkah" untuk mulai',
    zh: '点按“添加步骤”开始',
  },

  // ── Run details ──
  'wf.run.trigger': {
    en: 'Started: {trigger}',
    id: 'Dimulai: {trigger}',
    zh: '触发方式：{trigger}',
  },
  'wf.run.trigger.manual': { en: 'manually', id: 'manual', zh: '手动' },
  'wf.run.trigger.other': { en: 'automatically', id: 'otomatis', zh: '自动' },
  'wf.run.ended': { en: 'ended {time}', id: 'selesai {time}', zh: '结束于 {time}' },
  'wf.run.steps': { en: 'Steps ({count})', id: 'Langkah ({count})', zh: '步骤（{count}）' },
  'wf.run.removedStep': {
    en: 'Step no longer in the workflow',
    id: 'Langkah sudah tidak ada di alur kerja',
    zh: '该步骤已不在工作流中',
  },
  'wf.run.skipped': { en: 'not run', id: 'tidak dijalankan', zh: '未运行' },
  'wf.run.trigger.auto_refresh': { en: 'auto-refresh', id: 'auto-refresh', zh: '自动刷新' },
  'wf.run.showAuto': {
    en: 'Show auto-refresh runs',
    id: 'Tampilkan run auto-refresh',
    zh: '显示自动刷新运行',
  },

  // ── Auto-refresh ──
  'wf.auto.label': {
    en: 'Auto-refresh 1 min',
    id: 'Auto-refresh 1 menit',
    zh: '每 1 分钟自动刷新',
  },
  'wf.auto.hint': {
    en: 'Runs this workflow again on the server every minute while this page is open and visible, with your permissions. Each run is recorded in the history as auto-refresh.',
    id: 'Menjalankan ulang alur kerja ini di server setiap menit selama halaman ini terbuka dan terlihat, dengan izin Anda. Setiap run dicatat di riwayat sebagai auto-refresh.',
    zh: '在此页面打开且可见时，每分钟按您的权限在服务器上重新运行此工作流。每次运行都会以“自动刷新”记录在历史中。',
  },
  'wf.auto.status': {
    en: 'Auto-refresh every minute · updated {time} · next in {seconds} s',
    id: 'Auto-refresh tiap menit · diperbarui {time} · berikutnya {seconds} dtk',
    zh: '每分钟自动刷新 · 更新于 {time} · {seconds} 秒后刷新',
  },
  'wf.auto.starting': {
    en: 'Auto-refresh every minute · starting…',
    id: 'Auto-refresh tiap menit · memulai…',
    zh: '每分钟自动刷新 · 正在开始…',
  },
  'wf.auto.refreshing': {
    en: 'Auto-refresh · reading the latest ERP data…',
    id: 'Auto-refresh · membaca data ERP terbaru…',
    zh: '自动刷新 · 正在读取最新 ERP 数据…',
  },
  'wf.auto.hidden': {
    en: 'Auto-refresh paused while this tab is in the background.',
    id: 'Auto-refresh dijeda selama tab ini di latar belakang.',
    zh: '此标签页在后台时自动刷新已暂停。',
  },
  'wf.auto.pausedUnsaved': {
    en: 'Auto-refresh paused: save your changes (it runs the saved workflow).',
    id: 'Auto-refresh dijeda: simpan perubahan Anda (yang dijalankan adalah alur kerja tersimpan).',
    zh: '自动刷新已暂停：请保存更改（它运行已保存的工作流）。',
  },
  'wf.auto.pausedIssues': {
    en: 'Auto-refresh paused: fix the problems in the workflow first.',
    id: 'Auto-refresh dijeda: perbaiki dulu masalah di alur kerja.',
    zh: '自动刷新已暂停：请先修复工作流中的问题。',
  },
  'wf.auto.stopped': {
    en: 'Auto-refresh stopped after 3 failed runs. Check the steps and turn it on again.',
    id: 'Auto-refresh dihentikan setelah 3 run gagal. Periksa langkah-langkahnya lalu nyalakan lagi.',
    zh: '连续 3 次运行失败，自动刷新已停止。请检查步骤后重新开启。',
  },
  'wf.auto.tooSoon': {
    en: 'This workflow was auto-refreshed less than a minute ago (open in another tab?).',
    id: 'Alur kerja ini sudah di-auto-refresh kurang dari semenit lalu (terbuka di tab lain?).',
    zh: '此工作流不到一分钟前已自动刷新（是否在其他标签页中打开？）。',
  },
} satisfies Record<string, Entry>;
