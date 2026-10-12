import type { Entry } from './types';

// Admin panel, phase 4: the dashboard (/admin), access changes and granting
// access to workspaces.
export const platformAdminDashboardMessages = {
  'padmin.dash.title': { en: 'Dashboard', id: 'Dasbor', zh: '仪表板' },
  'padmin.dash.subtitle': {
    en: 'You are signed in as {role}. Figures come from what PrintStream already records; nothing extra is collected.',
    id: 'Anda masuk sebagai {role}. Angka berasal dari catatan yang sudah ada di PrintStream; tidak ada data tambahan yang dikumpulkan.',
    zh: '您以{role}身份登录。数据来自 PrintStream 已有的记录，不额外收集任何信息。',
  },
  'padmin.dash.period': { en: 'Period', id: 'Periode', zh: '时间段' },
  'padmin.dash.period.24h': { en: '24 hours', id: '24 jam', zh: '24 小时' },
  'padmin.dash.period.7d': { en: '7 days', id: '7 hari', zh: '7 天' },
  'padmin.dash.period.30d': { en: '30 days', id: '30 hari', zh: '30 天' },
  'padmin.dash.grantAdmin': {
    en: 'Grant admin access',
    id: 'Beri akses admin',
    zh: '授予管理员权限',
  },
  'padmin.dash.grantAdminBody': {
    en: 'Gives an existing account a role in this admin panel, or changes the role it has. They need two-factor turned on to open it. Recorded in the security log.',
    id: 'Memberi akun yang sudah ada peran di panel admin ini, atau mengubah perannya. Mereka perlu mengaktifkan dua langkah untuk membukanya. Dicatat di log keamanan.',
    zh: '为现有账户授予本管理面板的角色，或更改其角色。对方需启用两步验证才能打开。会记录在安全日志中。',
  },
  'padmin.dash.grant': { en: 'Grant', id: 'Berikan', zh: '授予' },

  'padmin.dash.accounts': { en: 'Accounts', id: 'Akun', zh: '账户' },
  'padmin.dash.activeAccounts': {
    en: 'Signed in during the period',
    id: 'Masuk selama periode',
    zh: '期间内登录过',
  },
  'padmin.dash.new': { en: 'New', id: 'Baru', zh: '新增' },
  'padmin.dash.activeWorkspaces': {
    en: 'With changes during the period',
    id: 'Ada perubahan selama periode',
    zh: '期间内有变更',
  },
  'padmin.dash.signIns': { en: 'Successful sign-ins', id: 'Berhasil masuk', zh: '成功登录' },
  'padmin.dash.failedSignIns': {
    en: 'Failed sign-ins',
    id: 'Gagal masuk',
    zh: '登录失败',
  },
  'padmin.dash.failedCodes': {
    en: 'Wrong two-factor codes',
    id: 'Kode dua langkah salah',
    zh: '两步验证码错误',
  },
  'padmin.dash.rateLimited': {
    en: 'Blocked (too many attempts)',
    id: 'Diblokir (terlalu banyak percobaan)',
    zh: '已阻止（尝试次数过多）',
  },
  'padmin.dash.failedLinks': {
    en: 'Password links that did not work',
    id: 'Tautan kata sandi yang tidak berfungsi',
    zh: '无效的密码链接',
  },
  'padmin.dash.termsPending': {
    en: 'Terms not yet accepted',
    id: 'Syarat belum disetujui',
    zh: '尚未接受条款',
  },
  'padmin.dash.termsCurrent': { en: 'Current version', id: 'Versi berlaku', zh: '当前版本' },
  'padmin.dash.termsPendingActive': {
    en: 'Of these, enabled accounts',
    id: 'Di antaranya, akun aktif',
    zh: '其中已启用的账户',
  },
  'padmin.dash.termsNone': {
    en: 'No version published yet.',
    id: 'Belum ada versi yang diterbitkan.',
    zh: '尚未发布任何版本。',
  },

  'padmin.dash.chartSignIns': {
    en: 'Sign-ins and failures',
    id: 'Proses masuk dan kegagalan',
    zh: '登录与失败',
  },
  'padmin.dash.chartNewAccounts': { en: 'New accounts', id: 'Akun baru', zh: '新账户' },
  'padmin.dash.seriesSignIns': { en: 'Signed in', id: 'Berhasil masuk', zh: '成功登录' },
  'padmin.dash.seriesFailed': {
    en: 'Failed (password or code)',
    id: 'Gagal (kata sandi atau kode)',
    zh: '失败（密码或验证码）',
  },
  'padmin.dash.seriesNewAccounts': { en: 'New accounts', id: 'Akun baru', zh: '新账户' },

  'padmin.dash.failingAccounts': {
    en: 'Most failed attempts, by account',
    id: 'Percobaan gagal terbanyak, per akun',
    zh: '失败次数最多的账户',
  },
  'padmin.dash.failingIps': {
    en: 'Most failed attempts, by IP address',
    id: 'Percobaan gagal terbanyak, per alamat IP',
    zh: '失败次数最多的 IP 地址',
  },
  'padmin.dash.noFailures': {
    en: 'No failed attempts in this period.',
    id: 'Tidak ada percobaan gagal dalam periode ini.',
    zh: '此期间没有失败的尝试。',
  },
  'padmin.dash.noIps': {
    en: 'No IP addresses were recorded. They are recorded only when TRUST_PROXY is set (docs/CONFIGURATION.md).',
    id: 'Tidak ada alamat IP yang tercatat. Alamat IP hanya dicatat jika TRUST_PROXY diatur (docs/CONFIGURATION.md).',
    zh: '未记录 IP 地址。仅在设置 TRUST_PROXY 时才会记录（见 docs/CONFIGURATION.md）。',
  },
  'padmin.dash.failures': { en: 'Failures', id: 'Gagal', zh: '失败次数' },
  'padmin.dash.lastAttempt': { en: 'Last attempt', id: 'Percobaan terakhir', zh: '最近一次尝试' },
  'padmin.dash.unknownAccount': {
    en: 'no such account',
    id: 'akun tidak ada',
    zh: '账户不存在',
  },

  'padmin.dash.accessChanges': {
    en: 'Latest access changes',
    id: 'Perubahan akses terbaru',
    zh: '最近的权限变更',
  },
  'padmin.dash.adminActions': {
    en: 'Latest admin actions',
    id: 'Tindakan admin terbaru',
    zh: '最近的管理员操作',
  },
  'padmin.dash.inPeriod': {
    en: '{count} in this period',
    id: '{count} dalam periode ini',
    zh: '此期间 {count} 条',
  },

  'padmin.dash.system': { en: 'System status', id: 'Status sistem', zh: '系统状态' },
  'padmin.dash.database': { en: 'Database', id: 'Basis data', zh: '数据库' },
  'padmin.dash.databaseOk': {
    en: 'Answering ({ms} ms)',
    id: 'Merespons ({ms} md)',
    zh: '正常响应（{ms} 毫秒）',
  },
  'padmin.dash.databaseDown': {
    en: 'Not answering',
    id: 'Tidak merespons',
    zh: '无响应',
  },
  'padmin.dash.databaseVersion': {
    en: 'Version and size',
    id: 'Versi dan ukuran',
    zh: '版本与大小',
  },
  'padmin.dash.migrations': {
    en: 'Database updates',
    id: 'Pembaruan basis data',
    zh: '数据库更新',
  },
  'padmin.dash.migrationsApplied': {
    en: '{count} applied',
    id: '{count} diterapkan',
    zh: '已应用 {count} 个',
  },
  'padmin.dash.migrationsCurrent': {
    en: 'Up to date ({count} applied)',
    id: 'Terbaru ({count} diterapkan)',
    zh: '已是最新（已应用 {count} 个）',
  },
  'padmin.dash.migrationsPending': {
    en: '{count} not applied',
    id: '{count} belum diterapkan',
    zh: '{count} 个未应用',
  },
  'padmin.dash.migrationsHelp': {
    en: 'This version of PrintStream has database updates that are not applied yet. Run npm run db:migrate as the schema owner (docs/OPERATIONS.md).',
    id: 'Versi PrintStream ini memiliki pembaruan basis data yang belum diterapkan. Jalankan npm run db:migrate sebagai pemilik skema (docs/OPERATIONS.md).',
    zh: '此版本的 PrintStream 有尚未应用的数据库更新。请以架构所有者身份运行 npm run db:migrate（见 docs/OPERATIONS.md）。',
  },
  'padmin.dash.backups': { en: 'Backups', id: 'Cadangan', zh: '备份' },
  'padmin.dash.backupsUnknown': {
    en: 'Could not be checked',
    id: 'Tidak dapat diperiksa',
    zh: '无法检查',
  },
  'padmin.dash.backupsOff': {
    en: 'Not set up',
    id: 'Belum diatur',
    zh: '未设置',
  },
  'padmin.dash.backupsNone': {
    en: 'Set up, none made yet',
    id: 'Sudah diatur, belum ada cadangan',
    zh: '已设置，尚无备份',
  },
  'padmin.dash.backupLatest': {
    en: 'Last {when} ({count} kept)',
    id: 'Terakhir {when} ({count} disimpan)',
    zh: '最近一次 {when}（保留 {count} 个）',
  },
  'padmin.dash.logSize': {
    en: '{count} entries since {since}',
    id: '{count} entri sejak {since}',
    zh: '自 {since} 起共 {count} 条',
  },
  'padmin.dash.retention': {
    en: 'Security log kept',
    id: 'Log keamanan disimpan',
    zh: '安全日志保留期',
  },
  'padmin.dash.retentionForever': { en: 'Forever', id: 'Selamanya', zh: '永久' },
  'padmin.dash.retentionDays': {
    en: '{count} days',
    id: '{count} hari',
    zh: '{count} 天',
  },
  'padmin.dash.app': { en: 'App server', id: 'Server aplikasi', zh: '应用服务器' },
  'padmin.dash.uptime': {
    en: 'Running for {hours} h (Node {node})',
    id: 'Berjalan {hours} jam (Node {node})',
    zh: '已运行 {hours} 小时（Node {node}）',
  },
  'padmin.dash.noErrorLog': {
    en: 'PrintStream does not store application errors in the database; they are in the server output (npm start).',
    id: 'PrintStream tidak menyimpan galat aplikasi di basis data; galat ada di keluaran server (npm start).',
    zh: 'PrintStream 不在数据库中存储应用错误；错误见服务器输出（npm start）。',
  },

  'padmin.access.grant': {
    en: 'Grant workspace access',
    id: 'Beri akses ruang kerja',
    zh: '授予工作区权限',
  },
  'padmin.access.grantBody': {
    en: 'Adds an existing account to a client’s workspace with a role, or changes its role there. You cannot give yourself access: another super admin must. The Owner’s access cannot be changed.',
    id: 'Menambahkan akun yang sudah ada ke ruang kerja klien dengan suatu peran, atau mengubah perannya di sana. Anda tidak dapat memberi akses kepada diri sendiri: super admin lain harus melakukannya. Akses Pemilik tidak dapat diubah.',
    zh: '将现有账户以某个角色加入客户的工作区，或更改其在该工作区的角色。您不能给自己授权，必须由另一位超级管理员操作。所有者的权限不能更改。',
  },
  'padmin.access.visible': {
    en: 'The client sees this change, made by your account, in its workspace activity. It is also recorded in the security log.',
    id: 'Klien melihat perubahan ini, dilakukan oleh akun Anda, di aktivitas ruang kerjanya. Perubahan juga dicatat di log keamanan.',
    zh: '客户会在其工作区动态中看到此变更（由您的账户执行）。该变更也会记录在安全日志中。',
  },
  'padmin.access.workspace': { en: 'Workspace', id: 'Ruang kerja', zh: '工作区' },
  'padmin.access.findWorkspace': {
    en: 'Find the workspace',
    id: 'Cari ruang kerja',
    zh: '查找工作区',
  },
  'padmin.access.pickOther': {
    en: 'Choose another workspace',
    id: 'Pilih ruang kerja lain',
    zh: '选择其他工作区',
  },
  'padmin.access.noMatch': {
    en: 'No matching workspace.',
    id: 'Tidak ada ruang kerja yang cocok.',
    zh: '没有匹配的工作区。',
  },
  'padmin.access.account': {
    en: 'Account e-mail',
    id: 'E-mail akun',
    zh: '账户电子邮件',
  },
  'padmin.access.changeRole': { en: 'Change role', id: 'Ubah peran', zh: '更改角色' },
  'padmin.access.added': {
    en: '{email} now has access to {name}.',
    id: '{email} sekarang memiliki akses ke {name}.',
    zh: '{email} 现在可以访问 {name}。',
  },
  'padmin.access.changed': {
    en: 'The role of {email} in {name} was changed.',
    id: 'Peran {email} di {name} telah diubah.',
    zh: '{email} 在 {name} 中的角色已更改。',
  },
  'padmin.access.unchanged': {
    en: '{email} already has this role in {name}.',
    id: '{email} sudah memiliki peran ini di {name}.',
    zh: '{email} 在 {name} 中已是此角色。',
  },
  'padmin.access.remove': { en: 'Remove access', id: 'Cabut akses', zh: '移除权限' },
  'padmin.access.removeBody': {
    en: 'Remove the access of {email} to {name}? Their account stays; they can be added again later.',
    id: 'Cabut akses {email} ke {name}? Akunnya tetap ada; dapat ditambahkan lagi nanti.',
    zh: '移除 {email} 对 {name} 的访问权限？其账户保留，之后可再次添加。',
  },
  'padmin.access.removed': { en: 'Access removed.', id: 'Akses dicabut.', zh: '权限已移除。' },

  'padmin.err.owner': {
    en: 'The Owner’s access cannot be changed.',
    id: 'Akses Pemilik tidak dapat diubah.',
    zh: '所有者的权限不能更改。',
  },
  'padmin.err.workspace_limit': {
    en: 'This account already belongs to the maximum number of ERPs.',
    id: 'Akun ini sudah tergabung dalam jumlah maksimum ERP.',
    zh: '此账户所属的 ERP 已达上限。',
  },

  'padmin.event.WORKSPACE_MEMBER_ADDED': {
    en: 'Workspace member added',
    id: 'Anggota ruang kerja ditambahkan',
    zh: '已添加工作区成员',
  },
  'padmin.event.WORKSPACE_ROLE_CHANGED': {
    en: 'Workspace role changed',
    id: 'Peran ruang kerja diubah',
    zh: '工作区角色已更改',
  },
  'padmin.event.WORKSPACE_MEMBER_REMOVED': {
    en: 'Workspace member removed',
    id: 'Anggota ruang kerja dikeluarkan',
    zh: '已移除工作区成员',
  },
  'padmin.event.WORKSPACE_MEMBER_LEFT': {
    en: 'Left a workspace',
    id: 'Keluar dari ruang kerja',
    zh: '已离开工作区',
  },
  'padmin.event.ERP_RESET': { en: 'ERP reset', id: 'ERP diatur ulang', zh: 'ERP 已重置' },
  'padmin.event.ERP_EMPTIED': { en: 'ERP emptied', id: 'ERP dikosongkan', zh: 'ERP 已清空' },
  'padmin.event.ERP_DELETED': { en: 'ERP deleted', id: 'ERP dihapus', zh: 'ERP 已删除' },
} satisfies Record<string, Entry>;
