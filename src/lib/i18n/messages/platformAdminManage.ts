import type { Entry } from './types';

// Admin panel: accounts and workspaces (phase 2).
export const platformAdminManageMessages = {
  'padmin.nav.users': { en: 'Accounts', id: 'Akun', zh: '账户' },
  'padmin.nav.workspaces': { en: 'Workspaces', id: 'Ruang kerja', zh: '工作区' },

  'padmin.err.exists': {
    en: 'An account with this e-mail address already exists.',
    id: 'Akun dengan alamat e-mail ini sudah ada.',
    zh: '使用此电子邮件地址的账户已存在。',
  },
  'padmin.err.already': {
    en: 'This is already done.',
    id: 'Ini sudah dilakukan.',
    zh: '此操作已完成。',
  },

  'padmin.event.ADMIN_PASSWORD_RESET_INITIATED': {
    en: 'Password link created by an admin',
    id: 'Tautan kata sandi dibuat oleh admin',
    zh: '管理员创建了密码链接',
  },
  'padmin.event.PASSWORD_RESET_COMPLETED': {
    en: 'Password set from a link',
    id: 'Kata sandi diatur dari tautan',
    zh: '已通过链接设置密码',
  },
  'padmin.event.PASSWORD_RESET_FAILED': {
    en: 'Password link not valid',
    id: 'Tautan kata sandi tidak valid',
    zh: '密码链接无效',
  },
  'padmin.event.WORKSPACE_SUSPENDED': {
    en: 'Workspace suspended',
    id: 'Ruang kerja ditangguhkan',
    zh: '工作区已暂停',
  },
  'padmin.event.WORKSPACE_REACTIVATED': {
    en: 'Workspace reactivated',
    id: 'Ruang kerja diaktifkan kembali',
    zh: '工作区已恢复',
  },

  'padmin.link.reset': { en: 'Password reset', id: 'Atur ulang kata sandi', zh: '重置密码' },
  'padmin.link.invite': { en: 'Invitation', id: 'Undangan', zh: '邀请' },
  'padmin.link.resetReady': {
    en: 'Password reset link',
    id: 'Tautan atur ulang kata sandi',
    zh: '密码重置链接',
  },
  'padmin.link.inviteReady': {
    en: 'Account created. Invitation link:',
    id: 'Akun dibuat. Tautan undangan:',
    zh: '账户已创建。邀请链接：',
  },
  'padmin.link.once': {
    en: 'Shown only once. Send it to the person through a channel you trust. It works once, until {when}.',
    id: 'Hanya ditampilkan sekali. Kirimkan kepada orangnya melalui saluran yang Anda percaya. Berlaku sekali, sampai {when}.',
    zh: '仅显示一次。请通过您信任的渠道发送给对方。只能使用一次，有效期至 {when}。',
  },
  'padmin.link.expires': { en: 'Valid until', id: 'Berlaku sampai', zh: '有效期至' },
  'padmin.link.used': { en: 'Used', id: 'Dipakai', zh: '已使用' },
  'padmin.link.cancelled': { en: 'Cancelled', id: 'Dibatalkan', zh: '已取消' },
  'padmin.link.expired': { en: 'Expired', id: 'Kedaluwarsa', zh: '已过期' },
  'padmin.link.open': { en: 'Open', id: 'Terbuka', zh: '未使用' },

  'padmin.pager.range': {
    en: '{from}–{to} of {total}',
    id: '{from}–{to} dari {total}',
    zh: '第 {from}–{to} 条，共 {total} 条',
  },
  'padmin.pager.previous': { en: 'Previous', id: 'Sebelumnya', zh: '上一页' },
  'padmin.pager.next': { en: 'Next', id: 'Berikutnya', zh: '下一页' },

  'padmin.users.subtitle': {
    en: 'Every sign-in account. Open one to see its sessions, workspaces and security history.',
    id: 'Semua akun masuk. Buka salah satu untuk melihat sesi, ruang kerja, dan riwayat keamanannya.',
    zh: '所有登录账户。打开账户可查看其会话、工作区和安全记录。',
  },
  'padmin.users.search': {
    en: 'E-mail address or name',
    id: 'Alamat e-mail atau nama',
    zh: '电子邮件地址或姓名',
  },
  'padmin.users.filterLabel': { en: 'Show', id: 'Tampilkan', zh: '显示' },
  'padmin.users.filter.all': { en: 'All accounts', id: 'Semua akun', zh: '全部账户' },
  'padmin.users.filter.disabled': { en: 'Disabled', id: 'Dinonaktifkan', zh: '已停用' },
  'padmin.users.filter.noMfa': {
    en: 'Without two-factor',
    id: 'Tanpa dua langkah',
    zh: '未启用两步验证',
  },
  'padmin.users.filter.admins': { en: 'Admins', id: 'Admin', zh: '管理员' },
  'padmin.users.col.status': { en: 'Status', id: 'Status', zh: '状态' },
  'padmin.users.col.sessions': { en: 'Sessions', id: 'Sesi', zh: '会话' },
  'padmin.users.col.erps': { en: 'ERPs', id: 'ERP', zh: 'ERP' },
  'padmin.users.active': { en: 'Active', id: 'Aktif', zh: '正常' },
  'padmin.users.disabled': { en: 'Disabled', id: 'Dinonaktifkan', zh: '已停用' },
  'padmin.users.off': { en: 'Off', id: 'Nonaktif', zh: '未启用' },
  'padmin.users.noPassword': {
    en: 'No password yet',
    id: 'Belum ada kata sandi',
    zh: '尚未设置密码',
  },
  'padmin.users.new': { en: 'New account', id: 'Akun baru', zh: '新建账户' },
  'padmin.users.createInvite': {
    en: 'Create and get invite link',
    id: 'Buat dan dapatkan tautan undangan',
    zh: '创建并获取邀请链接',
  },
  'padmin.users.inviteHint': {
    en: 'The account has no password until the person opens the invite link (valid 72 hours) and chooses one. Nobody else ever sees it.',
    id: 'Akun tidak memiliki kata sandi sampai orangnya membuka tautan undangan (berlaku 72 jam) dan memilihnya. Tidak ada orang lain yang melihatnya.',
    zh: '在对方打开邀请链接（72 小时内有效）并设置密码之前，该账户没有密码。其他人永远看不到该密码。',
  },
  'padmin.users.profile': { en: 'Account', id: 'Akun', zh: '账户' },
  'padmin.users.created': { en: 'Created', id: 'Dibuat', zh: '创建时间' },
  'padmin.users.devices': {
    en: 'On ({count} devices)',
    id: 'Aktif ({count} perangkat)',
    zh: '已启用（{count} 台设备）',
  },
  'padmin.users.recoveryCodes': {
    en: 'Recovery codes left',
    id: 'Sisa kode pemulihan',
    zh: '剩余恢复码',
  },
  'padmin.users.workspaces': { en: 'Workspaces', id: 'Ruang kerja', zh: '工作区' },
  'padmin.users.sessions': {
    en: 'Signed-in sessions',
    id: 'Sesi yang masuk',
    zh: '登录会话',
  },
  'padmin.users.noSessions': {
    en: 'Not signed in anywhere.',
    id: 'Tidak masuk di mana pun.',
    zh: '当前没有登录会话。',
  },
  'padmin.users.started': { en: 'Signed in', id: 'Masuk', zh: '登录时间' },
  'padmin.users.lastSeen': { en: 'Last active', id: 'Terakhir aktif', zh: '最近活动' },
  'padmin.users.links': { en: 'Password links', id: 'Tautan kata sandi', zh: '密码链接' },
  'padmin.users.linkKind': { en: 'Kind', id: 'Jenis', zh: '类型' },

  'padmin.users.disable': { en: 'Disable account', id: 'Nonaktifkan akun', zh: '停用账户' },
  'padmin.users.disableBody': {
    en: '{email} will be signed out everywhere and cannot sign in until the account is enabled again. Open password links are cancelled.',
    id: '{email} akan dikeluarkan dari semua perangkat dan tidak dapat masuk sampai akun diaktifkan kembali. Tautan kata sandi yang terbuka dibatalkan.',
    zh: '{email} 将在所有设备上退出，并且在重新启用之前无法登录。未使用的密码链接将被取消。',
  },
  'padmin.users.reason': {
    en: 'Reason (kept in the security log)',
    id: 'Alasan (disimpan di log keamanan)',
    zh: '原因（记录在安全日志中）',
  },
  'padmin.users.disabledDone': {
    en: 'Account disabled.',
    id: 'Akun dinonaktifkan.',
    zh: '账户已停用。',
  },
  'padmin.users.enable': { en: 'Enable account', id: 'Aktifkan akun', zh: '启用账户' },
  'padmin.users.enableBody': {
    en: '{email} can sign in again.',
    id: '{email} dapat masuk kembali.',
    zh: '{email} 将可以再次登录。',
  },
  'padmin.users.enabled': { en: 'Account enabled.', id: 'Akun diaktifkan.', zh: '账户已启用。' },
  'padmin.users.endSessions': {
    en: 'Sign out everywhere',
    id: 'Keluarkan dari semua perangkat',
    zh: '在所有设备上退出',
  },
  'padmin.users.endSessionsBody': {
    en: 'Every session of {email} ends now. The account stays enabled; the person can sign in again.',
    id: 'Semua sesi {email} berakhir sekarang. Akun tetap aktif; orangnya dapat masuk kembali.',
    zh: '{email} 的所有会话将立即结束。账户仍然有效，对方可以重新登录。',
  },
  'padmin.users.endSession': { en: 'End', id: 'Akhiri', zh: '结束' },
  'padmin.users.endSessionBody': {
    en: 'This session ends now. The person can sign in again.',
    id: 'Sesi ini berakhir sekarang. Orangnya dapat masuk kembali.',
    zh: '此会话将立即结束。对方可以重新登录。',
  },
  'padmin.users.sessionsEnded': { en: 'Signed out.', id: 'Dikeluarkan.', zh: '已退出。' },
  'padmin.users.resetLink': {
    en: 'Create password reset link',
    id: 'Buat tautan atur ulang kata sandi',
    zh: '创建密码重置链接',
  },
  'padmin.users.resetMfa': {
    en: 'Reset two-factor',
    id: 'Atur ulang dua langkah',
    zh: '重置两步验证',
  },
  'padmin.users.resetMfaBody': {
    en: 'Removes every authenticator and recovery code of {email} and signs them out. Only do this after confirming who the person is outside PrintStream (call, video, in person).',
    id: 'Menghapus semua autentikator dan kode pemulihan {email} serta mengeluarkannya. Lakukan hanya setelah memastikan identitas orangnya di luar PrintStream (telepon, video, tatap muka).',
    zh: '将删除 {email} 的所有身份验证器和恢复码并使其退出。请仅在通过 PrintStream 以外的方式（电话、视频、当面）确认对方身份后操作。',
  },
  'padmin.users.verification': {
    en: 'How you confirmed who they are',
    id: 'Bagaimana Anda memastikan identitasnya',
    zh: '您如何确认了对方身份',
  },
  'padmin.users.mfaReset': {
    en: 'Two-factor reset.',
    id: 'Dua langkah diatur ulang.',
    zh: '两步验证已重置。',
  },

  'padmin.ws.subtitle': {
    en: 'Every ERP, including each account’s own. Suspending one closes its data to all members.',
    id: 'Semua ERP, termasuk milik setiap akun. Menangguhkan satu ERP menutup datanya bagi semua anggota.',
    zh: '所有 ERP，包括每个账户自己的 ERP。暂停后，所有成员都无法访问其数据。',
  },
  'padmin.ws.search': {
    en: 'Name or owner e-mail',
    id: 'Nama atau e-mail pemilik',
    zh: '名称或所有者电子邮件',
  },
  'padmin.ws.filter.all': { en: 'All workspaces', id: 'Semua ruang kerja', zh: '全部工作区' },
  'padmin.ws.filter.suspended': { en: 'Suspended', id: 'Ditangguhkan', zh: '已暂停' },
  'padmin.ws.filter.shared': {
    en: 'Created ERPs',
    id: 'ERP yang dibuat',
    zh: '创建的 ERP',
  },
  'padmin.ws.filter.personal': {
    en: 'Own (personal) ERPs',
    id: 'ERP pribadi',
    zh: '个人 ERP',
  },
  'padmin.ws.col.name': { en: 'Workspace', id: 'Ruang kerja', zh: '工作区' },
  'padmin.ws.col.owner': { en: 'Owner', id: 'Pemilik', zh: '所有者' },
  'padmin.ws.col.members': { en: 'Members', id: 'Anggota', zh: '成员' },
  'padmin.ws.col.lastActivity': {
    en: 'Last change',
    id: 'Perubahan terakhir',
    zh: '最近更改',
  },
  'padmin.ws.personal': { en: 'Own ERP', id: 'ERP pribadi', zh: '个人 ERP' },
  'padmin.ws.shared': { en: 'Created ERP', id: 'ERP yang dibuat', zh: '创建的 ERP' },
  'padmin.ws.suspended': { en: 'Suspended', id: 'Ditangguhkan', zh: '已暂停' },
  'padmin.ws.left': { en: 'Left', id: 'Keluar', zh: '已离开' },
  'padmin.ws.members': { en: 'Members', id: 'Anggota', zh: '成员' },
  'padmin.ws.joined': { en: 'Joined', id: 'Bergabung', zh: '加入时间' },
  'padmin.ws.requireMfa': {
    en: 'Two-factor required',
    id: 'Wajib dua langkah',
    zh: '要求两步验证',
  },
  'padmin.ws.history': {
    en: 'Suspension history',
    id: 'Riwayat penangguhan',
    zh: '暂停记录',
  },
  'padmin.ws.suspendedBy': {
    en: 'Suspended {when} by {who}',
    id: 'Ditangguhkan {when} oleh {who}',
    zh: '{when} 由 {who} 暂停',
  },
  'padmin.ws.liftedBy': {
    en: 'Reactivated {when} by {who}',
    id: 'Diaktifkan kembali {when} oleh {who}',
    zh: '{when} 由 {who} 恢复',
  },
  'padmin.ws.membersDisabled': {
    en: 'Accounts disabled with it: {count}',
    id: 'Akun yang ikut dinonaktifkan: {count}',
    zh: '随之停用的账户：{count}',
  },
  'padmin.ws.suspend': {
    en: 'Suspend workspace',
    id: 'Tangguhkan ruang kerja',
    zh: '暂停工作区',
  },
  'padmin.ws.suspendBody': {
    en: 'Nobody can open or change the data of “{name}” until it is reactivated. Its members keep their accounts and other ERPs.',
    id: 'Tidak ada yang dapat membuka atau mengubah data “{name}” sampai diaktifkan kembali. Anggotanya tetap memiliki akun dan ERP lainnya.',
    zh: '在恢复之前，任何人都无法打开或更改“{name}”的数据。其成员仍保留账户和其他 ERP。',
  },
  'padmin.ws.disableMembers': {
    en: 'Also disable the accounts of all its members (not admins, not you) and sign them out',
    id: 'Juga nonaktifkan akun semua anggotanya (bukan admin, bukan Anda) dan keluarkan mereka',
    zh: '同时停用其所有成员的账户（管理员和您除外）并使其退出',
  },
  'padmin.ws.suspendedDone': {
    en: 'Workspace suspended. Accounts disabled: {count}.',
    id: 'Ruang kerja ditangguhkan. Akun dinonaktifkan: {count}.',
    zh: '工作区已暂停。已停用账户：{count}。',
  },
  'padmin.ws.reactivate': {
    en: 'Reactivate workspace',
    id: 'Aktifkan kembali ruang kerja',
    zh: '恢复工作区',
  },
  'padmin.ws.reactivateBody': {
    en: 'Members can open “{name}” again.',
    id: 'Anggota dapat membuka “{name}” kembali.',
    zh: '成员将可以再次打开“{name}”。',
  },
  'padmin.ws.enableMembers': {
    en: 'Also enable the {count} accounts disabled when it was suspended',
    id: 'Juga aktifkan kembali {count} akun yang dinonaktifkan saat ditangguhkan',
    zh: '同时启用暂停时停用的 {count} 个账户',
  },
  'padmin.ws.reactivatedDone': {
    en: 'Workspace reactivated. Accounts enabled: {count}.',
    id: 'Ruang kerja diaktifkan kembali. Akun diaktifkan: {count}.',
    zh: '工作区已恢复。已启用账户：{count}。',
  },
} satisfies Record<string, Entry>;
