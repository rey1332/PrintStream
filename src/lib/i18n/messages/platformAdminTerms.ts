import type { Entry } from './types';

// The admin panel's Terms & Conditions screens.
export const platformAdminTermsMessages = {
  'padmin.nav.terms': { en: 'Terms', id: 'Syarat', zh: '条款' },
  'padmin.err.placeholder': {
    en: 'Replace the placeholder text before publishing.',
    id: 'Ganti teks placeholder sebelum menerbitkan.',
    zh: '发布前请替换占位文本。',
  },
  'padmin.event.TERMS_DRAFT_SAVED': {
    en: 'Terms draft saved',
    id: 'Draf syarat disimpan',
    zh: '条款草稿已保存',
  },
  'padmin.event.TERMS_DRAFT_DELETED': {
    en: 'Terms draft deleted',
    id: 'Draf syarat dihapus',
    zh: '条款草稿已删除',
  },
  'padmin.event.TERMS_PUBLISHED': {
    en: 'Terms published',
    id: 'Syarat diterbitkan',
    zh: '条款已发布',
  },
  'padmin.event.TERMS_ACCEPTED': {
    en: 'Terms accepted',
    id: 'Syarat disetujui',
    zh: '已接受条款',
  },
  'padmin.event.TERMS_DECLINED': {
    en: 'Terms declined',
    id: 'Syarat ditolak',
    zh: '已拒绝条款',
  },

  'padmin.terms.subtitle': {
    en: 'The newest published version is the one every account must accept before using ETNA. Published versions cannot be changed; publish a new one instead.',
    id: 'Versi terbaru yang diterbitkan adalah yang harus disetujui setiap akun sebelum menggunakan ETNA. Versi yang diterbitkan tidak dapat diubah; terbitkan versi baru.',
    zh: '最新发布的版本是每个账户使用 PrintStream 前必须接受的版本。已发布的版本不能修改，请发布新版本。',
  },
  'padmin.terms.none': {
    en: 'No versions yet. Until one is published, nobody is asked to accept anything.',
    id: 'Belum ada versi. Sampai ada yang diterbitkan, tidak ada yang diminta menyetujui apa pun.',
    zh: '尚无版本。在发布之前，不会要求任何人接受。',
  },
  'padmin.terms.newDraft': { en: 'New draft', id: 'Draf baru', zh: '新建草稿' },
  'padmin.terms.draft': { en: 'Draft', id: 'Draf', zh: '草稿' },
  'padmin.terms.current': { en: 'Current', id: 'Berlaku', zh: '当前' },
  'padmin.terms.previous': { en: 'Previous', id: 'Sebelumnya', zh: '旧版' },
  'padmin.terms.col.version': { en: 'Version', id: 'Versi', zh: '版本' },
  'padmin.terms.col.published': { en: 'Published', id: 'Diterbitkan', zh: '发布' },
  'padmin.terms.col.accepted': { en: 'Accepted by', id: 'Disetujui oleh', zh: '已接受' },
  'padmin.terms.col.acceptedAt': { en: 'Accepted', id: 'Disetujui', zh: '接受时间' },
  'padmin.terms.col.language': { en: 'Language', id: 'Bahasa', zh: '语言' },
  'padmin.terms.col.lastAccepted': {
    en: 'Last accepted version',
    id: 'Versi terakhir yang disetujui',
    zh: '最近接受的版本',
  },
  'padmin.terms.editedAt': {
    en: 'Edited {date}',
    id: 'Diubah {date}',
    zh: '编辑于 {date}',
  },
  'padmin.terms.acceptedOf': {
    en: '{count} of {people} accounts',
    id: '{count} dari {people} akun',
    zh: '{people} 个账户中的 {count} 个',
  },
  'padmin.terms.pendingTitle': {
    en: 'Not yet accepted: {version}',
    id: 'Belum disetujui: {version}',
    zh: '尚未接受：{version}',
  },
  'padmin.terms.allAccepted': {
    en: 'Every account has accepted the current version.',
    id: 'Semua akun telah menyetujui versi yang berlaku.',
    zh: '所有账户都已接受当前版本。',
  },
  'padmin.terms.noneAccepted': {
    en: 'No version accepted yet.',
    id: 'Belum ada versi yang disetujui.',
    zh: '尚未接受任何版本。',
  },
  'padmin.terms.text': { en: 'Text', id: 'Teks', zh: '正文' },
  'padmin.terms.lang.en': { en: 'English', id: 'Inggris', zh: '英文' },
  'padmin.terms.lang.id': { en: 'Indonesian', id: 'Indonesia', zh: '印尼文' },
  'padmin.terms.lang.zh': { en: 'Chinese', id: 'Mandarin', zh: '中文' },
  'padmin.terms.label': {
    en: 'Version name (e.g. date and number)',
    id: 'Nama versi (mis. tanggal dan nomor)',
    zh: '版本名称（例如日期和编号）',
  },
  'padmin.terms.textRequired': {
    en: 'English text (required)',
    id: 'Teks bahasa Inggris (wajib)',
    zh: '英文正文（必填）',
  },
  'padmin.terms.textOptional': {
    en: 'Text in this language (optional; English is shown when empty)',
    id: 'Teks dalam bahasa ini (opsional; bahasa Inggris ditampilkan jika kosong)',
    zh: '此语言的正文（可选；为空时显示英文）',
  },
  'padmin.terms.plainText': {
    en: 'Plain text: paragraphs and line breaks are shown as written. PrintStream does not provide legal text; use the wording approved for your company.',
    id: 'Teks biasa: paragraf dan baris baru ditampilkan seperti ditulis. PrintStream tidak menyediakan teks hukum; gunakan kata-kata yang disetujui untuk perusahaan Anda.',
    zh: '纯文本：段落和换行按原样显示。PrintStream 不提供法律文本，请使用为贵公司审定的措辞。',
  },
  'padmin.terms.fallsBackToEnglish': {
    en: 'No text in this language: readers see the English text.',
    id: 'Tidak ada teks dalam bahasa ini: pembaca melihat teks bahasa Inggris.',
    zh: '此语言没有正文：读者将看到英文正文。',
  },
  'padmin.terms.preview': { en: 'Preview', id: 'Pratinjau', zh: '预览' },
  'padmin.terms.edit': { en: 'Edit', id: 'Ubah', zh: '编辑' },
  'padmin.terms.saveDraft': { en: 'Save draft', id: 'Simpan draf', zh: '保存草稿' },
  'padmin.terms.saved': { en: 'Draft saved.', id: 'Draf disimpan.', zh: '草稿已保存。' },
  'padmin.terms.saveFirst': {
    en: 'Save the draft first.',
    id: 'Simpan draf terlebih dahulu.',
    zh: '请先保存草稿。',
  },
  'padmin.terms.publish': { en: 'Publish', id: 'Terbitkan', zh: '发布' },
  'padmin.terms.publishBody': {
    en: 'Publish “{version}”? It becomes the current version: every account must accept it the next time it uses ETNA. Published text can never be changed.',
    id: 'Terbitkan “{version}”? Versi ini menjadi versi yang berlaku: setiap akun harus menyetujuinya saat menggunakan PrintStream berikutnya. Teks yang diterbitkan tidak pernah dapat diubah.',
    zh: '发布“{version}”？它将成为当前版本：每个账户下次使用 PrintStream 时都必须接受。已发布的文本永远不能修改。',
  },
  'padmin.terms.published': {
    en: 'Published. Every account will be asked to accept it.',
    id: 'Diterbitkan. Setiap akun akan diminta menyetujuinya.',
    zh: '已发布。所有账户都将被要求接受。',
  },
  'padmin.terms.deleteDraft': { en: 'Delete draft', id: 'Hapus draf', zh: '删除草稿' },
  'padmin.terms.deleteBody': {
    en: 'Delete the draft “{version}”? This cannot be undone.',
    id: 'Hapus draf “{version}”? Tindakan ini tidak dapat dibatalkan.',
    zh: '删除草稿“{version}”？此操作无法撤销。',
  },
  'padmin.terms.deleted': { en: 'Draft deleted.', id: 'Draf dihapus.', zh: '草稿已删除。' },
} satisfies Record<string, Entry>;
