import type { Entry } from './types';

// Terms & Conditions: the page every account accepts on (/terms), and their
// administration in the admin panel. ETNA ships no legal text; admins publish it.
export const termsMessages = {
  'terms.title': { en: 'Terms & Conditions', id: 'Syarat & Ketentuan', zh: '条款与条件' },
  'terms.version': {
    en: 'Version {version}, published {date}',
    id: 'Versi {version}, diterbitkan {date}',
    zh: '版本 {version}，发布于 {date}',
  },
  'terms.none': {
    en: 'No Terms & Conditions have been published yet.',
    id: 'Belum ada Syarat & Ketentuan yang diterbitkan.',
    zh: '尚未发布条款与条件。',
  },
  'terms.mustAccept': {
    en: 'Please read the Terms & Conditions. You can use PrintStream after you accept them.',
    id: 'Silakan baca Syarat & Ketentuan. Anda dapat menggunakan PrintStream setelah menyetujuinya.',
    zh: '请阅读条款与条件。接受后即可使用 PrintStream。',
  },
  'terms.englishOnly': {
    en: 'This version is not available in your language; it is shown in English.',
    id: 'Versi ini tidak tersedia dalam bahasa Anda; ditampilkan dalam bahasa Inggris.',
    zh: '此版本没有您的语言版本，以英文显示。',
  },
  'terms.agree': {
    en: 'I have read and accept the Terms & Conditions (version {version}).',
    id: 'Saya telah membaca dan menyetujui Syarat & Ketentuan (versi {version}).',
    zh: '我已阅读并接受条款与条件（版本 {version}）。',
  },
  'terms.accept': { en: 'Accept and continue', id: 'Setujui dan lanjutkan', zh: '接受并继续' },
  'terms.decline': { en: 'Decline and sign out', id: 'Tolak dan keluar', zh: '拒绝并退出' },
  'terms.declineConfirm': {
    en: 'Without accepting, you cannot use ETNA. Sign out now?',
    id: 'Tanpa menyetujui, Anda tidak dapat menggunakan ETNA. Keluar sekarang?',
    zh: '不接受将无法使用 PrintStream。现在退出吗？',
  },
  'terms.acceptedOn': {
    en: 'You accepted this version on {date}.',
    id: 'Anda menyetujui versi ini pada {date}.',
    zh: '您已于 {date} 接受此版本。',
  },
  'terms.continue': { en: 'Continue', id: 'Lanjutkan', zh: '继续' },
  'terms.changed': {
    en: 'A newer version was just published. Please read it.',
    id: 'Versi yang lebih baru baru saja diterbitkan. Silakan baca.',
    zh: '刚刚发布了新版本，请阅读。',
  },
  'terms.failed': {
    en: 'Your acceptance could not be saved. Please try again.',
    id: 'Persetujuan Anda tidak dapat disimpan. Silakan coba lagi.',
    zh: '无法保存您的接受记录，请重试。',
  },
} satisfies Record<string, Entry>;
