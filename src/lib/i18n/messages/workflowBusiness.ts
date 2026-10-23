import type { Entry } from './types';

// Terminal pipeline nodes for business analysis (src/lib/workflow/analyticsNodes.ts).
export const workflowBusinessMessages = {
  'wf.node.an.pareto': { en: 'Pareto (ABC)', id: 'Pareto (ABC)', zh: '帕累托（ABC）' },
  'wf.desc.an.pareto': {
    en: 'Rank items by value, their share and running share, and class A, B or C',
    id: 'Urutkan item menurut nilai, porsi dan porsi kumulatifnya, lalu kelas A, B atau C',
    zh: '按数值排序项目，计算占比与累计占比，并分为 A、B、C 类',
  },
  'wf.node.an.rfm': { en: 'RFM Segments', id: 'Segmen RFM', zh: 'RFM 分群' },
  'wf.desc.an.rfm': {
    en: 'Recency, frequency and value of each customer, scored 1–5, with a segment',
    id: 'Kebaruan, frekuensi dan nilai tiap pelanggan, skor 1–5, beserta segmennya',
    zh: '每位客户的最近购买、频次与金额，评分 1–5，并给出分群',
  },
  'wf.node.an.aging': { en: 'Aging', id: 'Umur Piutang/Utang', zh: '账龄' },
  'wf.desc.an.aging': {
    en: 'Days overdue and aging bucket (current, 1–30, 31–60, 61–90, over 90), per row or per party',
    id: 'Hari lewat jatuh tempo dan kelompok umur (belum jatuh tempo, 1–30, 31–60, 61–90, lebih dari 90), per baris atau per pihak',
    zh: '逾期天数与账龄区间（未到期、1–30、31–60、61–90、90 以上），按行或按往来方',
  },
  'wf.node.an.cohort': { en: 'Cohort Retention', id: 'Retensi Kohort', zh: '同期群留存' },
  'wf.desc.an.cohort': {
    en: 'Customers grouped by their first period, and how many come back in later periods',
    id: 'Pelanggan dikelompokkan menurut periode pertamanya, dan berapa yang kembali di periode berikutnya',
    zh: '按首次购买期分组客户，并统计之后各期回购人数',
  },
  'wf.node.an.periodCompare': {
    en: 'Compare Periods',
    id: 'Bandingkan Periode',
    zh: '期间对比',
  },
  'wf.desc.an.periodCompare': {
    en: 'Totals per period with change vs the previous period and last year, moving average and running total',
    id: 'Total per periode dengan perubahan dibanding periode sebelumnya dan tahun lalu, rata-rata bergerak dan total berjalan',
    zh: '按期汇总，含环比、同比变化、移动平均与累计值',
  },
  'wf.node.an.correlation': { en: 'Correlation', id: 'Korelasi', zh: '相关性' },
  'wf.desc.an.correlation': {
    en: 'How strongly numeric columns move together (Pearson), pair by pair',
    id: 'Seberapa kuat kolom angka bergerak bersama (Pearson), per pasangan',
    zh: '数值列两两之间的联动强度（皮尔逊）',
  },
  'wf.node.an.quantiles': { en: 'Quantiles', id: 'Kuantil', zh: '分位数' },
  'wf.desc.an.quantiles': {
    en: 'Put each row in a quantile (e.g. quartile 1–4) of a column, with its percentile',
    id: 'Masukkan tiap baris ke kuantil (misalnya kuartil 1–4) sebuah kolom, beserta persentilnya',
    zh: '按某列把每行分入分位组（如四分位 1–4），并给出百分位',
  },

  'wf.field.itemColumn': { en: 'Item column', id: 'Kolom item', zh: '项目列' },
  'wf.field.aThreshold': { en: 'Class A up to (%)', id: 'Kelas A sampai (%)', zh: 'A 类上限（%）' },
  'wf.field.bThreshold': { en: 'Class B up to (%)', id: 'Kelas B sampai (%)', zh: 'B 类上限（%）' },
  'wf.field.customerColumn': { en: 'Customer column', id: 'Kolom pelanggan', zh: '客户列' },
  'wf.field.dateColumn': { en: 'Date column', id: 'Kolom tanggal', zh: '日期列' },
  'wf.field.amountColumn': { en: 'Amount column', id: 'Kolom nilai', zh: '金额列' },
  'wf.field.asOf': { en: 'As of (date)', id: 'Per tanggal', zh: '截至日期' },
  'wf.field.termsDays': { en: 'Payment terms (days)', id: 'Termin (hari)', zh: '账期（天）' },
  'wf.field.partyColumn': {
    en: 'Per party (optional)',
    id: 'Per pihak (opsional)',
    zh: '按往来方（可选）',
  },
  'wf.field.cohortPeriod': { en: 'Cohort period', id: 'Periode kohort', zh: '同期群周期' },
  'wf.field.period': { en: 'Period', id: 'Periode', zh: '周期' },
  'wf.field.movingWindow': {
    en: 'Moving average over (periods)',
    id: 'Rata-rata bergerak (periode)',
    zh: '移动平均（期数）',
  },
  'wf.field.buckets': { en: 'Number of groups', id: 'Jumlah kelompok', zh: '分组数' },

  'wf.hint.an.pareto.aThreshold': {
    en: 'The usual 80/15/5: A items make up the first 80% of the total, B the next 15%.',
    id: 'Umumnya 80/15/5: item A membentuk 80% pertama total, B 15% berikutnya.',
    zh: '常用 80/15/5：A 类占总额前 80%，B 类其后 15%。',
  },
  'wf.hint.an.rfm.asOf': {
    en: 'YYYY-MM-DD. Empty: the newest date in the data. Each row is one order.',
    id: 'YYYY-MM-DD. Kosong: tanggal terbaru di data. Satu baris = satu order.',
    zh: 'YYYY-MM-DD。留空：数据中的最新日期。每行代表一笔订单。',
  },
  'wf.hint.an.aging.dateColumn': {
    en: 'The due date (terms 0), or the invoice date with the payment terms below.',
    id: 'Tanggal jatuh tempo (termin 0), atau tanggal invoice dengan termin di bawah.',
    zh: '到期日（账期填 0），或开票日期加下方账期。',
  },
  'wf.hint.an.aging.partyColumn': {
    en: 'Empty: every row gets its days overdue and bucket. A customer or supplier column: one row per party with the amounts per bucket.',
    id: 'Kosong: setiap baris mendapat hari lewat jatuh tempo dan kelompoknya. Kolom pelanggan atau pemasok: satu baris per pihak dengan nilai per kelompok umur.',
    zh: '留空：每行给出逾期天数与区间。选择客户或供应商列：每个往来方一行，按区间汇总金额。',
  },
  'wf.hint.an.aging.asOf': {
    en: 'YYYY-MM-DD. Empty: today.',
    id: 'YYYY-MM-DD. Kosong: hari ini.',
    zh: 'YYYY-MM-DD。留空：今天。',
  },
  'wf.hint.an.periodCompare.valueColumn': {
    en: 'Optional when counting rows. Months without rows count as 0 (sum and count).',
    id: 'Boleh kosong untuk menghitung baris. Bulan tanpa baris dihitung 0 (sum dan count).',
    zh: '计数时可留空。没有数据的期间按 0 计（求和与计数）。',
  },
  'wf.hint.an.correlation.columns': {
    en: 'Empty: every numeric column. Close to 1 or −1 is a strong link; it does not prove one causes the other.',
    id: 'Kosong: semua kolom angka. Mendekati 1 atau −1 berarti hubungan kuat; bukan bukti sebab-akibat.',
    zh: '留空：所有数值列。接近 1 或 −1 表示强相关；但不代表因果关系。',
  },
  'wf.hint.an.quantiles.buckets': {
    en: '4 = quartiles, 5 = quintiles, 10 = deciles. Group 1 holds the smallest values.',
    id: '4 = kuartil, 5 = kuintil, 10 = desil. Kelompok 1 berisi nilai terkecil.',
    zh: '4 = 四分位，5 = 五分位，10 = 十分位。第 1 组为最小值。',
  },
  'wf.hint.an.outliers.partitionBy': {
    en: 'Optional: compare each value only with its own group (for example per customer or per product).',
    id: 'Opsional: bandingkan tiap nilai hanya dengan kelompoknya sendiri (misalnya per pelanggan atau per produk).',
    zh: '可选：每个值只与其所在组比较（如按客户或按产品）。',
  },

  'wf.opt.daily': { en: 'Daily', id: 'Harian', zh: '按日' },
  'wf.opt.weekly': {
    en: 'Weekly (from Monday)',
    id: 'Mingguan (mulai Senin)',
    zh: '按周（周一起）',
  },
  'wf.opt.monthly': { en: 'Monthly', id: 'Bulanan', zh: '按月' },
  'wf.opt.quarterly': { en: 'Quarterly', id: 'Kuartalan', zh: '按季度' },
  'wf.opt.yearly': { en: 'Yearly', id: 'Tahunan', zh: '按年' },

  'wf.err.badAsOf': {
    en: '“{value}” is not a date: write it as YYYY-MM-DD, or leave it empty.',
    id: '“{value}” bukan tanggal: tulis sebagai YYYY-MM-DD, atau kosongkan.',
    zh: '“{value}”不是日期：请写成 YYYY-MM-DD，或留空。',
  },
  'wf.err.tooManyPeriods': {
    en: 'More than {max} periods: choose a longer period or filter the dates first.',
    id: 'Lebih dari {max} periode: pilih periode yang lebih panjang atau filter tanggalnya dulu.',
    zh: '期间超过 {max} 个：请选择更长的周期或先筛选日期。',
  },
  'wf.err.needTwoNumeric': {
    en: 'Correlation needs at least two numeric columns.',
    id: 'Korelasi butuh minimal dua kolom angka.',
    zh: '相关性至少需要两个数值列。',
  },
  'wf.err.tooManyColumns': {
    en: 'At most {max} columns at once: list the ones to compare.',
    id: 'Paling banyak {max} kolom sekaligus: sebutkan kolom yang mau dibandingkan.',
    zh: '一次最多 {max} 列：请列出要比较的列。',
  },
} satisfies Record<string, Entry>;
