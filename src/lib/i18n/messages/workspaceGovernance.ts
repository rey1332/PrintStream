import type { Entry } from './types';

// ERP → Settings: storage, retention and data access; governance banners.
export const workspaceGovernanceMessages = {
  'gs.storage': { en: 'Storage', id: 'Penyimpanan', zh: '存储' },
  'gs.storageSubtitle': {
    en: 'What this company stores in PrintStream, and its quota set by ETNA.',
    id: 'Apa yang disimpan perusahaan ini di PrintStream, dan kuota yang ditetapkan ETNA.',
    zh: '此公司在 PrintStream 中存储的内容，以及 ETNA 设定的配额。',
  },
  'gs.usedOf': {
    en: '{used} of {quota} used',
    id: '{used} dari {quota} terpakai',
    zh: '已用 {used} / {quota}',
  },
  'gs.usedNoLimit': {
    en: '{used} used · no limit',
    id: '{used} terpakai · tanpa batas',
    zh: '已用 {used} · 无限制',
  },
  'gs.breakdown': {
    en: 'Datasets {datasets} · files {files} · ERP records about {erp} · largest upload {upload}',
    id: 'Dataset {datasets} · file {files} · catatan ERP sekitar {erp} · unggahan terbesar {upload}',
    zh: '数据集 {datasets} · 文件 {files} · ERP 记录约 {erp} · 最大上传 {upload}',
  },
  'gs.requestPlaceholder': {
    en: 'How much more room do you need, and why?',
    id: 'Berapa tambahan ruang yang dibutuhkan, dan untuk apa?',
    zh: '您还需要多少空间？用途是什么？',
  },
  'gs.requestMore': {
    en: 'Ask ETNA for more',
    id: 'Minta tambahan ke ETNA',
    zh: '向 ETNA 申请更多',
  },
  'gs.requestSent': {
    en: 'Request sent to ETNA.',
    id: 'Permintaan dikirim ke ETNA.',
    zh: '已向 ETNA 发送申请。',
  },
  'gs.requestFailed': {
    en: 'The request could not be sent (one request per day).',
    id: 'Permintaan tidak dapat dikirim (satu permintaan per hari).',
    zh: '无法发送申请（每天限一次）。',
  },
  'gs.retention': { en: 'Retention', id: 'Retensi', zh: '保留期' },
  'gs.retentionSubtitle': {
    en: "How long this company's logs are kept, within the limits ETNA sets.",
    id: 'Berapa lama log perusahaan ini disimpan, dalam batas yang ditetapkan ETNA.',
    zh: '此公司日志的保留时长，在 ETNA 设定的范围内。',
  },
  'gs.days': { en: '{n} days', id: '{n} hari', zh: '{n} 天' },
  'gs.range': { en: '{min}–{max}', id: '{min}–{max}', zh: '{min}–{max}' },
  'gs.chooseDays': { en: 'Days to keep', id: 'Hari disimpan', zh: '保留天数' },
  'gs.saveFailed': { en: 'Not saved.', id: 'Tidak tersimpan.', zh: '未保存。' },
  'gs.onHold': {
    en: 'This company is on legal hold: nothing is purged until ETNA releases it.',
    id: 'Perusahaan ini dalam legal hold: tidak ada yang dihapus sampai ETNA melepasnya.',
    zh: '此公司处于法律保留状态：在 ETNA 解除前不会清除任何内容。',
  },
  'gs.accessSubtitle': {
    en: "Who read or changed this company's data recently, including ETNA staff.",
    id: 'Siapa yang baru-baru ini membaca atau mengubah data perusahaan ini, termasuk staf ETNA.',
    zh: '最近读取或更改此公司数据的人员，包括 ETNA 员工。',
  },
  'gs.staffBanner': {
    en: "You are in {name} as ETNA staff until {until}, with the Owner's rights. Everything you do is recorded and visible to the company.",
    id: 'Anda berada di {name} sebagai staf ETNA sampai {until}, dengan hak Pemilik. Semua tindakan dicatat dan terlihat oleh perusahaan.',
    zh: '您以 ETNA 员工身份进入 {name}，至 {until}，拥有所有者权限。您的所有操作都会被记录并对该公司可见。',
  },
  'gs.terminationBanner': {
    en: 'The PrintStream service for this company is ending. Download your export before {date}; after that the data is deleted.',
    id: 'Layanan PrintStream untuk perusahaan ini akan berakhir. Unduh ekspor Anda sebelum {date}; setelah itu data dihapus.',
    zh: '此公司的 PrintStream 服务即将终止。请在 {date} 前下载导出数据；之后数据将被删除。',
  },
  'gs.terminationDone': {
    en: 'The PrintStream service for this company has ended.',
    id: 'Layanan PrintStream untuk perusahaan ini telah berakhir.',
    zh: '此公司的 PrintStream 服务已终止。',
  },
  'gs.exportIntro': {
    en: 'Before the export period ends, download everything this company stored: every ERP list and every dataset, in one compressed JSON file. Passwords and other secrets are left out.',
    id: 'Sebelum masa ekspor berakhir, unduh semua yang disimpan perusahaan ini: setiap daftar ERP dan setiap dataset, dalam satu file JSON terkompresi. Kata sandi dan rahasia lain tidak disertakan.',
    zh: '在导出期结束前，下载本公司存储的所有内容：每个 ERP 列表和每个数据集，打包为一个压缩的 JSON 文件。密码和其他机密不包含在内。',
  },
  'gs.exportPrepare': { en: 'Prepare the export', id: 'Siapkan ekspor', zh: '准备导出' },
  'gs.exportAgain': { en: 'Prepare a new export', id: 'Siapkan ekspor baru', zh: '重新准备导出' },
  'gs.exportPreparing': {
    en: 'Preparing the export… this page updates by itself.',
    id: 'Menyiapkan ekspor… halaman ini diperbarui sendiri.',
    zh: '正在准备导出… 本页会自动更新。',
  },
  'gs.exportDownload': {
    en: 'Download the export of {date} ({size})',
    id: 'Unduh ekspor {date} ({size})',
    zh: '下载 {date} 的导出（{size}）',
  },
  'gs.exportBusy': {
    en: 'An export is already being prepared.',
    id: 'Ekspor sedang disiapkan.',
    zh: '已有导出正在准备中。',
  },
  'gs.exportFailed': {
    en: 'The export could not be prepared. Try again, or contact ETNA.',
    id: 'Ekspor tidak bisa disiapkan. Coba lagi, atau hubungi ETNA.',
    zh: '无法准备导出。请重试或联系 ETNA。',
  },
} satisfies Record<string, Entry>;
