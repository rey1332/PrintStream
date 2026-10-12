import type { Entry } from './types';

// Two-factor authentication, workspace security settings and related notices.
export const securityMessages = {
  // ── Sign-in second step ──
  'mfa.title': { en: 'Two-factor verification', id: 'Verifikasi dua langkah', zh: '两步验证' },
  'mfa.prompt': {
    en: 'Enter the 6-digit code from your authenticator app.',
    id: 'Masukkan kode 6 digit dari aplikasi autentikator Anda.',
    zh: '请输入身份验证器应用中的 6 位数代码。',
  },
  'mfa.code': { en: 'Verification code', id: 'Kode verifikasi', zh: '验证码' },
  'mfa.verify': { en: 'Verify', id: 'Verifikasi', zh: '验证' },
  'mfa.verifying': { en: 'Verifying…', id: 'Memverifikasi…', zh: '正在验证…' },
  'mfa.invalidCode': {
    en: 'That code is not valid. Check the time on your device and try again.',
    id: 'Kode tidak valid. Periksa jam di perangkat Anda lalu coba lagi.',
    zh: '代码无效。请检查设备时间后重试。',
  },
  'mfa.noFactor': {
    en: 'No authenticator is set up for this account.',
    id: 'Belum ada autentikator untuk akun ini.',
    zh: '此账户未设置身份验证器。',
  },
  'mfa.signOut': { en: 'Sign out', id: 'Keluar', zh: '退出登录' },
  'mfa.required': {
    en: 'Two-factor verification is required to continue.',
    id: 'Verifikasi dua langkah diperlukan untuk melanjutkan.',
    zh: '需要完成两步验证才能继续。',
  },

  // ── Settings: change password ──
  'password.title': { en: 'Change password', id: 'Ubah kata sandi', zh: '修改密码' },
  'password.desc': {
    en: 'Choose a new password for signing in. Other devices will be signed out; this one stays signed in.',
    id: 'Pilih kata sandi baru untuk masuk. Perangkat lain akan dikeluarkan; perangkat ini tetap masuk.',
    zh: '为登录设置新密码。其他设备将退出登录，本设备保持登录。',
  },
  'password.current': { en: 'Current password', id: 'Kata sandi saat ini', zh: '当前密码' },
  'password.new': { en: 'New password', id: 'Kata sandi baru', zh: '新密码' },
  'password.confirm': {
    en: 'Confirm new password',
    id: 'Konfirmasi kata sandi baru',
    zh: '确认新密码',
  },
  'password.rules': {
    en: 'At least {min} characters. A longer passphrase is stronger.',
    id: 'Minimal {min} karakter. Frasa sandi yang lebih panjang lebih kuat.',
    zh: '至少 {min} 个字符。较长的密码短语更安全。',
  },
  'password.submit': { en: 'Change password', id: 'Ubah kata sandi', zh: '修改密码' },
  'password.saving': { en: 'Changing…', id: 'Mengubah…', zh: '正在修改…' },
  'password.changed': {
    en: 'Your password was changed. Use the new password the next time you sign in.',
    id: 'Kata sandi Anda telah diubah. Gunakan kata sandi baru saat masuk berikutnya.',
    zh: '密码已修改。下次登录请使用新密码。',
  },
  'password.err.currentRequired': {
    en: 'Enter your current password.',
    id: 'Masukkan kata sandi saat ini.',
    zh: '请输入当前密码。',
  },
  'password.err.currentWrong': {
    en: 'The current password is not correct.',
    id: 'Kata sandi saat ini salah.',
    zh: '当前密码不正确。',
  },
  'password.err.tooShort': {
    en: 'The new password must be at least {min} characters.',
    id: 'Kata sandi baru minimal {min} karakter.',
    zh: '新密码至少需要 {min} 个字符。',
  },
  'password.err.tooLong': {
    en: 'The new password is too long. Use at most {max} characters (fewer for accented letters or symbols).',
    id: 'Kata sandi baru terlalu panjang. Gunakan paling banyak {max} karakter (lebih sedikit untuk huruf beraksen atau simbol).',
    zh: '新密码过长。最多 {max} 个字符（含重音字母或符号时更少）。',
  },
  'password.err.same': {
    en: 'The new password must be different from the current one.',
    id: 'Kata sandi baru harus berbeda dari yang sekarang.',
    zh: '新密码不能与当前密码相同。',
  },
  'password.err.mismatch': {
    en: 'The new passwords do not match.',
    id: 'Kata sandi baru tidak cocok.',
    zh: '两次输入的新密码不一致。',
  },
  'password.err.rateLimited': {
    en: 'Too many attempts. Please wait a few minutes and try again.',
    id: 'Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.',
    zh: '尝试次数过多。请等待几分钟后重试。',
  },
  'password.err.failed': {
    en: 'Your password could not be changed. Try again.',
    id: 'Kata sandi tidak dapat diubah. Coba lagi.',
    zh: '无法修改密码，请重试。',
  },

  // ── Settings: two-factor ──
  'mfa.settings.title': {
    en: 'Two-factor authentication',
    id: 'Autentikasi dua langkah',
    zh: '两步验证',
  },
  'mfa.settings.desc': {
    en: 'Protect your account with a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) in addition to your password.',
    id: 'Lindungi akun Anda dengan kode dari aplikasi autentikator (Google Authenticator, Microsoft Authenticator, 1Password…) selain kata sandi.',
    zh: '除密码外，使用身份验证器应用（Google Authenticator、Microsoft Authenticator、1Password 等）的代码保护您的账户。',
  },
  'mfa.settings.on': { en: 'On', id: 'Aktif', zh: '已开启' },
  'mfa.settings.off': { en: 'Off', id: 'Nonaktif', zh: '未开启' },
  'mfa.settings.enable': {
    en: 'Turn on two-factor',
    id: 'Aktifkan dua langkah',
    zh: '开启两步验证',
  },
  'mfa.settings.disable': { en: 'Turn off', id: 'Nonaktifkan', zh: '关闭' },
  'mfa.settings.disableConfirm': {
    en: 'Turn off two-factor authentication? Workspaces that require it will stop giving you access.',
    id: 'Nonaktifkan autentikasi dua langkah? Workspace yang mewajibkannya akan berhenti memberi Anda akses.',
    zh: '确定关闭两步验证？要求两步验证的工作区将不再允许您访问。',
  },
  'mfa.settings.scan': {
    en: 'Scan this QR code with your authenticator app, then enter the 6-digit code it shows.',
    id: 'Pindai kode QR ini dengan aplikasi autentikator, lalu masukkan kode 6 digit yang muncul.',
    zh: '用身份验证器应用扫描此二维码，然后输入显示的 6 位数代码。',
  },
  'mfa.settings.secret': {
    en: 'Or enter this key manually:',
    id: 'Atau masukkan kunci ini secara manual:',
    zh: '或手动输入此密钥：',
  },
  'mfa.settings.qrAlt': {
    en: 'QR code for your authenticator app',
    id: 'Kode QR untuk aplikasi autentikator',
    zh: '身份验证器应用二维码',
  },
  'mfa.settings.confirm': {
    en: 'Confirm and turn on',
    id: 'Konfirmasi dan aktifkan',
    zh: '确认并开启',
  },
  'mfa.settings.cancel': { en: 'Cancel', id: 'Batal', zh: '取消' },
  'mfa.settings.enabled': {
    en: 'Two-factor authentication is on.',
    id: 'Autentikasi dua langkah sudah aktif.',
    zh: '两步验证已开启。',
  },
  'mfa.settings.disabled': {
    en: 'Two-factor authentication is off.',
    id: 'Autentikasi dua langkah dinonaktifkan.',
    zh: '两步验证已关闭。',
  },
  'mfa.settings.failed': {
    en: 'Could not change two-factor settings. Try again.',
    id: 'Tidak dapat mengubah pengaturan dua langkah. Coba lagi.',
    zh: '无法更改两步验证设置，请重试。',
  },
  'mfa.settings.needsVerify': {
    en: 'Verify with your authenticator code first (sign out and in again).',
    id: 'Verifikasi dengan kode autentikator terlebih dahulu (keluar lalu masuk lagi).',
    zh: '请先用验证器代码完成验证（退出后重新登录）。',
  },

  'mfa.settings.devices': {
    en: 'Authenticator devices',
    id: 'Perangkat autentikator',
    zh: '身份验证器设备',
  },
  'mfa.settings.deviceAddedOn': {
    en: 'Added {date}',
    id: 'Ditambahkan {date}',
    zh: '添加于 {date}',
  },
  'mfa.settings.remove': { en: 'Remove', id: 'Hapus', zh: '移除' },
  'mfa.settings.removeConfirm': {
    en: 'Remove "{name}"? Codes from that device will stop working.',
    id: 'Hapus "{name}"? Kode dari perangkat itu tidak akan berlaku lagi.',
    zh: '移除“{name}”？该设备上的代码将失效。',
  },
  'mfa.settings.addDevice': {
    en: 'Add another device',
    id: 'Tambah perangkat lain',
    zh: '添加其他设备',
  },
  'mfa.settings.addDeviceDesc': {
    en: 'A second device (for example a spare phone or a password manager) keeps you signed in if one is lost.',
    id: 'Perangkat kedua (misalnya HP cadangan atau password manager) menjaga Anda tetap bisa masuk jika salah satunya hilang.',
    zh: '第二台设备（例如备用手机或密码管理器）可在一台设备丢失时保证您仍能登录。',
  },
  'mfa.settings.deviceName': { en: 'Device name', id: 'Nama perangkat', zh: '设备名称' },
  'mfa.settings.deviceNamePlaceholder': {
    en: 'e.g. Work phone',
    id: 'mis. HP kantor',
    zh: '例如：工作手机',
  },
  'mfa.settings.maxDevices': {
    en: 'You have reached the limit of 10 devices.',
    id: 'Anda sudah mencapai batas 10 perangkat.',
    zh: '已达到 10 台设备的上限。',
  },
  'mfa.settings.deviceAdded': {
    en: 'Device added.',
    id: 'Perangkat ditambahkan.',
    zh: '设备已添加。',
  },
  'mfa.settings.deviceRemoved': {
    en: 'Device removed.',
    id: 'Perangkat dihapus.',
    zh: '设备已移除。',
  },
  'mfa.settings.nameTaken': {
    en: 'You already have a device with that name.',
    id: 'Anda sudah punya perangkat dengan nama itu.',
    zh: '已有同名设备。',
  },
  'mfa.settings.recovered': {
    en: 'Two-factor was turned off with a recovery code. Set it up again now.',
    id: 'Dua langkah dimatikan dengan kode pemulihan. Aktifkan lagi sekarang.',
    zh: '已使用恢复码关闭两步验证。请立即重新设置。',
  },

  // ── Recovery codes ──
  'mfa.recovery.title': { en: 'Recovery codes', id: 'Kode pemulihan', zh: '恢复码' },
  'mfa.recovery.desc': {
    en: 'If you lose your authenticator, sign in with your password and enter one of these codes. Each code works once and turns two-factor off so you can set it up again.',
    id: 'Jika autentikator hilang, masuk dengan kata sandi lalu masukkan salah satu kode ini. Setiap kode hanya berlaku sekali dan mematikan dua langkah agar Anda bisa memasangnya lagi.',
    zh: '如果丢失身份验证器，请用密码登录并输入其中一个恢复码。每个恢复码只能使用一次，使用后会关闭两步验证，以便您重新设置。',
  },
  'mfa.recovery.remaining': {
    en: '{count} of 10 codes left',
    id: 'Sisa {count} dari 10 kode',
    zh: '剩余 {count}/10 个恢复码',
  },
  'mfa.recovery.low': {
    en: 'Few codes left. Generate new ones.',
    id: 'Kode hampir habis. Buat kode baru.',
    zh: '恢复码即将用完，请生成新的恢复码。',
  },
  'mfa.recovery.none': {
    en: 'No recovery codes yet. Generate them now.',
    id: 'Belum ada kode pemulihan. Buat sekarang.',
    zh: '尚无恢复码，请立即生成。',
  },
  'mfa.recovery.generate': { en: 'Generate new codes', id: 'Buat kode baru', zh: '生成新恢复码' },
  'mfa.recovery.generateConfirm': {
    en: 'Generate new recovery codes? Your current codes will stop working.',
    id: 'Buat kode pemulihan baru? Kode yang sekarang tidak akan berlaku lagi.',
    zh: '生成新的恢复码？当前的恢复码将失效。',
  },
  'mfa.recovery.saveNow': {
    en: 'Save these codes somewhere safe (a password manager or printed). They will not be shown again.',
    id: 'Simpan kode ini di tempat aman (password manager atau dicetak). Kode tidak akan ditampilkan lagi.',
    zh: '请将这些恢复码保存在安全的地方（密码管理器或打印出来）。它们不会再次显示。',
  },
  'mfa.recovery.copy': { en: 'Copy', id: 'Salin', zh: '复制' },
  'mfa.recovery.copied': { en: 'Copied', id: 'Disalin', zh: '已复制' },
  'mfa.recovery.download': { en: 'Download .txt', id: 'Unduh .txt', zh: '下载 .txt' },
  'mfa.recovery.done': { en: 'I have saved them', id: 'Sudah saya simpan', zh: '我已保存' },
  'mfa.recovery.fileHeader': {
    en: 'PrintStream two-factor recovery codes for {email}. Each code works once.',
    id: 'Kode pemulihan dua langkah PrintStream untuk {email}. Setiap kode berlaku sekali.',
    zh: 'PrintStream 两步验证恢复码（{email}）。每个恢复码只能使用一次。',
  },

  // ── Sign-in with a recovery code ──
  'mfa.device': { en: 'Device', id: 'Perangkat', zh: '设备' },
  'mfa.useRecovery': {
    en: 'Lost your authenticator? Use a recovery code',
    id: 'Autentikator hilang? Pakai kode pemulihan',
    zh: '丢失身份验证器？使用恢复码',
  },
  'mfa.useAuthenticator': {
    en: 'Use an authenticator code instead',
    id: 'Pakai kode autentikator',
    zh: '改用身份验证器代码',
  },
  'mfa.recoveryPrompt': {
    en: 'Enter one of the recovery codes you saved when you turned on two-factor. This removes your authenticator devices; set two-factor up again right after.',
    id: 'Masukkan salah satu kode pemulihan yang Anda simpan saat mengaktifkan dua langkah. Ini menghapus perangkat autentikator Anda; segera aktifkan dua langkah lagi setelahnya.',
    zh: '请输入开启两步验证时保存的恢复码之一。这会移除您的身份验证器设备；之后请立即重新设置两步验证。',
  },
  'mfa.recoveryCode': { en: 'Recovery code', id: 'Kode pemulihan', zh: '恢复码' },
  'mfa.recoveryPlaceholder': { en: 'XXXXX-XXXXX', id: 'XXXXX-XXXXX', zh: 'XXXXX-XXXXX' },
  'mfa.recoveryUse': { en: 'Use recovery code', id: 'Pakai kode pemulihan', zh: '使用恢复码' },
  'mfa.recoveryInvalid': {
    en: 'That recovery code is not valid or was already used.',
    id: 'Kode pemulihan tidak valid atau sudah dipakai.',
    zh: '恢复码无效或已被使用。',
  },
  'mfa.recoveryLocked': {
    en: 'Too many attempts. Wait 15 minutes and try again.',
    id: 'Terlalu banyak percobaan. Tunggu 15 menit lalu coba lagi.',
    zh: '尝试次数过多。请等待 15 分钟后重试。',
  },
  'mfa.recoveryFailed': {
    en: 'Could not check the code. Try again.',
    id: 'Tidak dapat memeriksa kode. Coba lagi.',
    zh: '无法验证恢复码，请重试。',
  },
  'mfa.recoveryNoCodes': {
    en: 'No recovery codes? Ask your ETNA administrator to reset two-factor for your account.',
    id: 'Tidak punya kode pemulihan? Minta administrator ETNA mereset dua langkah untuk akun Anda.',
    zh: '没有恢复码？请联系 ETNA 管理员为您的账户重置两步验证。',
  },

  // ── Workspace security ──
  'ws.security.title': { en: 'Security', id: 'Keamanan', zh: '安全' },
  'ws.security.requireMfa': {
    en: 'Require two-factor for all members',
    id: 'Wajibkan dua langkah untuk semua anggota',
    zh: '要求所有成员开启两步验证',
  },
  'ws.security.requireMfaDesc': {
    en: "Members without two-factor keep their membership but cannot see or change this workspace's data until they turn it on.",
    id: 'Anggota tanpa dua langkah tetap menjadi anggota, tetapi tidak dapat melihat atau mengubah data workspace ini sampai mengaktifkannya.',
    zh: '未开启两步验证的成员仍保留成员身份，但在开启之前无法查看或更改此工作区的数据。',
  },
  'ws.security.ownerOnly': {
    en: 'Only the owner can change this.',
    id: 'Hanya pemilik yang dapat mengubah ini.',
    zh: '只有所有者可以更改此设置。',
  },
  'ws.security.needOwnMfa': {
    en: 'Turn on two-factor for your own account first (Settings).',
    id: 'Aktifkan dua langkah untuk akun Anda sendiri terlebih dahulu (Pengaturan).',
    zh: '请先为您自己的账户开启两步验证（设置）。',
  },
  'ws.security.missing': {
    en: '{count} member(s) do not have two-factor yet and will lose access.',
    id: '{count} anggota belum memiliki dua langkah dan akan kehilangan akses.',
    zh: '{count} 名成员尚未开启两步验证，将失去访问权限。',
  },
  'ws.security.blocked': {
    en: 'This workspace requires two-factor authentication. Turn it on in Settings to see its data.',
    id: 'Workspace ini mewajibkan autentikasi dua langkah. Aktifkan di Pengaturan untuk melihat datanya.',
    zh: '此工作区要求两步验证。请在设置中开启以查看其数据。',
  },
  'ws.security.memberMfaOn': { en: '2FA', id: '2FA', zh: '2FA' },
  'ws.security.memberMfaOff': { en: 'No 2FA', id: 'Tanpa 2FA', zh: '无 2FA' },
  'ws.rename': { en: 'Rename', id: 'Ganti nama', zh: '重命名' },
  'ws.renameLabel': { en: 'Workspace name', id: 'Nama workspace', zh: '工作区名称' },
  'ws.renameSave': { en: 'Save name', id: 'Simpan nama', zh: '保存名称' },
  'ws.renamed': { en: 'Workspace renamed', id: 'Nama workspace diubah', zh: '工作区已重命名' },
  'audit.workspace.renamed': {
    en: 'Workspace renamed',
    id: 'Nama workspace diubah',
    zh: '工作区已重命名',
  },
  'audit.workspace.mfa_required': {
    en: 'Two-factor required',
    id: 'Dua langkah diwajibkan',
    zh: '要求两步验证',
  },
  'audit.member.mfa_recovered': {
    en: 'Two-factor reset with a recovery code',
    id: 'Dua langkah direset dengan kode pemulihan',
    zh: '已使用恢复码重置两步验证',
  },
  'audit.workspace.mfa_optional': {
    en: 'Two-factor optional',
    id: 'Dua langkah opsional',
    zh: '两步验证改为可选',
  },
  'server.mfaRequired': {
    en: 'Two-factor verification is required. Sign in again and enter your code.',
    id: 'Verifikasi dua langkah diperlukan. Masuk lagi dan masukkan kode Anda.',
    zh: '需要两步验证。请重新登录并输入代码。',
  },
  'server.ownMfaFirst': {
    en: 'Turn on two-factor authentication for your own account first.',
    id: 'Aktifkan autentikasi dua langkah untuk akun Anda sendiri terlebih dahulu.',
    zh: '请先为您自己的账户开启两步验证。',
  },
} satisfies Record<string, Entry>;
