import type { Entry } from './types';

// Settings → User accounts (administrators only).
export const userAdminMessages = {
  'users.title': { en: 'User accounts', id: 'Akun pengguna', zh: '用户账户' },
  'users.subtitle': {
    en: 'Create sign-in accounts. There is no self sign-up. Only administrators see this.',
    id: 'Buat akun masuk. Tidak ada pendaftaran mandiri. Hanya admin yang melihat bagian ini.',
    zh: '创建登录账户。不提供自助注册。仅管理员可见。',
  },
  'users.needsTwoFactor': {
    en: 'Managing accounts needs two-factor verification. Turn on two-factor above and verify a code first.',
    id: 'Mengelola akun memerlukan verifikasi dua langkah. Aktifkan dua langkah di atas dan verifikasi kode terlebih dahulu.',
    zh: '管理账户需要两步验证。请先在上方启用两步验证并验证一个验证码。',
  },
  'users.notSetUp': {
    en: 'Account management is not set up yet. Run this once in a terminal in the ETNA folder, then restart ETNA:',
    id: 'Pengelolaan akun belum diatur. Jalankan sekali di terminal pada folder ETNA, lalu mulai ulang ETNA:',
    zh: '尚未设置账户管理。请在 ETNA 文件夹的终端中运行一次，然后重启 ETNA：',
  },
  'users.create': { en: 'Create account', id: 'Buat akun', zh: '创建账户' },
  'users.email': { en: 'E-mail address', id: 'Alamat e-mail', zh: '电子邮件地址' },
  'users.name': { en: 'Full name (optional)', id: 'Nama lengkap (opsional)', zh: '姓名（可选）' },
  'users.created': {
    en: 'Account created for {email}.',
    id: 'Akun dibuat untuk {email}.',
    zh: '已为 {email} 创建账户。',
  },
  'users.tempPassword': {
    en: 'Temporary password. It is shown only once; pass it on through a safe channel. The person changes it under Settings → Change password.',
    id: 'Password sementara. Hanya tampil sekali; berikan lewat jalur yang aman. Orang tersebut menggantinya di Pengaturan → Ubah kata sandi.',
    zh: '临时密码。仅显示一次，请通过安全渠道转交。对方应在“设置 → 修改密码”中更改。',
  },
  'users.copy': { en: 'Copy', id: 'Salin', zh: '复制' },
  'users.copied': { en: 'Copied', id: 'Tersalin', zh: '已复制' },
  'users.dismiss': { en: 'Done, hide it', id: 'Selesai, sembunyikan', zh: '完成，隐藏' },
  'users.list': { en: 'Accounts', id: 'Akun', zh: '账户' },
  'users.none': { en: 'No accounts yet.', id: 'Belum ada akun.', zh: '暂无账户。' },
  'users.col.account': { en: 'Account', id: 'Akun', zh: '账户' },
  'users.col.lastSignIn': { en: 'Last sign-in', id: 'Masuk terakhir', zh: '上次登录' },
  'users.col.twoFactor': { en: '2FA', id: '2FA', zh: '两步验证' },
  'users.never': { en: 'Never', id: 'Belum pernah', zh: '从未' },
  'users.locked': { en: 'Locked', id: 'Terkunci', zh: '已锁定' },
  'users.err.invalidEmail': {
    en: 'Enter a valid e-mail address.',
    id: 'Masukkan alamat e-mail yang valid.',
    zh: '请输入有效的电子邮件地址。',
  },
  'users.err.exists': {
    en: 'An account with this e-mail address already exists.',
    id: 'Akun dengan alamat e-mail ini sudah ada.',
    zh: '该电子邮件地址的账户已存在。',
  },
  'users.err.forbidden': {
    en: 'Only administrators with two-factor verification can do this.',
    id: 'Hanya admin dengan verifikasi dua langkah yang dapat melakukan ini.',
    zh: '只有已通过两步验证的管理员才能执行此操作。',
  },
  'users.err.failed': {
    en: 'The account could not be created. Check the PrintStream log.',
    id: 'Akun tidak dapat dibuat. Periksa log ETNA.',
    zh: '无法创建账户。请查看 PrintStream 日志。',
  },
} satisfies Record<string, Entry>;
