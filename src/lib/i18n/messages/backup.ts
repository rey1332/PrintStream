import type { Entry } from './types';

// Settings → Database backups.
export const backupMessages = {
  'backup.title': { en: 'Database backups', id: 'Backup database', zh: '数据库备份' },
  'backup.subtitle': {
    en: 'The whole database: every account and every ERP. Only administrators see this.',
    id: 'Seluruh database: semua akun dan semua ERP. Hanya admin yang melihat bagian ini.',
    zh: '整个数据库：所有账户和所有 ERP。仅管理员可见。',
  },
  'backup.now': { en: 'Back up now', id: 'Backup sekarang', zh: '立即备份' },
  'backup.done': { en: 'Backed up: {name}', id: 'Backup selesai: {name}', zh: '备份完成：{name}' },
  'backup.folder': { en: 'Folder', id: 'Folder', zh: '文件夹' },
  'backup.auto': {
    en: 'PrintStream backs up once a day while it is open and keeps the newest 7.',
    id: 'PrintStream backup otomatis sekali sehari selama terbuka dan menyimpan 7 terbaru.',
    zh: 'PrintStream 运行期间每天自动备份一次，保留最新 7 个。',
  },
  'backup.none': { en: 'No backups yet.', id: 'Belum ada backup.', zh: '尚无备份。' },
  'backup.notSetUp': {
    en: 'Backups are not set up yet. Run this once in a terminal in the ETNA folder; it asks for the database owner’s password and keeps it in Windows’ PostgreSQL password file, not in ETNA:',
    id: 'Backup belum diatur. Jalankan sekali di terminal pada folder ETNA; perintah ini meminta password pemilik database dan menyimpannya di file password PostgreSQL milik Windows, bukan di ETNA:',
    zh: '尚未设置备份。请在 ETNA 文件夹的终端中运行一次；它会询问数据库所有者的密码，并保存在 Windows 的 PostgreSQL 密码文件中，而不是 ETNA 中：',
  },
  'backup.kind.manual': { en: 'Manual', id: 'Manual', zh: '手动' },
  'backup.kind.auto': { en: 'Daily', id: 'Harian', zh: '每日' },
  'backup.kind.before-restore': {
    en: 'Before a restore',
    id: 'Sebelum restore',
    zh: '恢复前',
  },
  'backup.restore': { en: 'Restore', id: 'Pulihkan', zh: '恢复' },
  'backup.restoring': { en: 'Restoring…', id: 'Memulihkan…', zh: '正在恢复…' },
  'backup.restoreTitle': {
    en: 'Restore this backup?',
    id: 'Pulihkan backup ini?',
    zh: '恢复此备份？',
  },
  'backup.restoreBody': {
    en: 'Everything in the database — all accounts, ERPs and documents — goes back to {date}. Changes made since then are lost. The current state is backed up first. Everyone may need to sign in again.',
    id: 'Seluruh isi database — semua akun, ERP, dan dokumen — kembali ke kondisi {date}. Perubahan sejak saat itu hilang. Kondisi saat ini dibackup dulu. Semua orang mungkin perlu login ulang.',
    zh: '数据库中的所有内容（所有账户、ERP 和单据）将恢复到 {date} 的状态，此后的更改将丢失。会先备份当前状态。所有人可能需要重新登录。',
  },
  'backup.typeRestore': {
    en: 'Type RESTORE to confirm',
    id: 'Ketik RESTORE untuk konfirmasi',
    zh: '输入 RESTORE 以确认',
  },
  'backup.restored': {
    en: 'Restored {name}. Reloading…',
    id: '{name} berhasil dipulihkan. Memuat ulang…',
    zh: '已恢复 {name}，正在重新加载…',
  },
  'backup.err.failed': {
    en: 'The backup tool failed. See storage/logs/etna.log.',
    id: 'Alat backup gagal. Lihat storage/logs/etna.log.',
    zh: '备份工具失败。请查看 storage/logs/etna.log。',
  },
  'backup.err.confirm': {
    en: 'Type RESTORE exactly.',
    id: 'Ketik RESTORE persis.',
    zh: '请准确输入 RESTORE。',
  },
  'backup.err.busy': {
    en: 'A backup or restore is already running. Wait until it finishes.',
    id: 'Backup atau restore lain sedang berjalan. Tunggu sampai selesai.',
    zh: '已有备份或恢复正在进行，请等待其完成。',
  },
  'backup.err.forbidden': {
    en: 'Only administrators can do this.',
    id: 'Hanya admin yang bisa melakukan ini.',
    zh: '只有管理员可以执行此操作。',
  },
  'backup.needsTwoFactor': {
    en: 'Backups cover the whole database, so they need two-step verification. Turn on Two-factor verification in Settings; once your code is verified, backups are available.',
    id: 'Backup mencakup seluruh database, jadi wajib verifikasi dua langkah. Aktifkan Verifikasi dua langkah di Pengaturan; setelah kodenya terverifikasi, backup bisa dipakai.',
    zh: '备份涵盖整个数据库，因此需要两步验证。请在设置中开启两步验证；验证码通过后即可使用备份。',
  },
} satisfies Record<string, Entry>;
