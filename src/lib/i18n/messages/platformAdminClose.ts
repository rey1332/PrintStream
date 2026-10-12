import type { Entry } from './types';

// Admin panel: closing accounts, transferring ERP ownership, the account list.
export const platformAdminCloseMessages = {
  'padmin.users.filter.closed': { en: 'Closed', id: 'Ditutup', zh: '已关闭' },
  'padmin.users.closed': { en: 'Closed', id: 'Ditutup', zh: '已关闭' },
  'padmin.users.col.actions': { en: 'Actions', id: 'Aksi', zh: '操作' },
  'padmin.users.actionsFor': {
    en: 'Actions for {email}',
    id: 'Aksi untuk {email}',
    zh: '{email} 的操作',
  },
  'padmin.users.sortLabel': { en: 'Sort', id: 'Urutkan', zh: '排序' },
  'padmin.users.sort.created_desc': { en: 'Newest first', id: 'Terbaru dulu', zh: '最新优先' },
  'padmin.users.sort.created_asc': { en: 'Oldest first', id: 'Terlama dulu', zh: '最早优先' },
  'padmin.users.sort.last_sign_in_desc': {
    en: 'Last signed in',
    id: 'Terakhir masuk',
    zh: '最近登录',
  },
  'padmin.users.sort.email_asc': { en: 'E-mail A–Z', id: 'E-mail A–Z', zh: '邮箱 A–Z' },
  'padmin.users.moreErps': { en: '+{count} more', id: '+{count} lainnya', zh: '另有 {count} 个' },
  'padmin.users.noErps': { en: 'None', id: 'Tidak ada', zh: '无' },

  'padmin.users.close': { en: 'Close account', id: 'Tutup akun', zh: '关闭账户' },
  'padmin.users.closeBody': {
    en: '{email} is signed out, can never sign in again and leaves every ERP. Its name and e-mail are replaced, so the address can be used for a new account. Transactions, documents and audit trails stay. This cannot be undone.',
    id: '{email} dikeluarkan, tidak bisa masuk lagi selamanya, dan keluar dari semua ERP. Nama dan e-mailnya diganti, sehingga alamat itu bisa dipakai untuk akun baru. Transaksi, dokumen, dan jejak audit tetap ada. Tindakan ini tidak bisa dibatalkan.',
    zh: '{email} 将被登出，永远无法再次登录，并退出所有 ERP。其姓名和邮箱将被替换，该地址可用于新账户。交易、文档和审计记录将保留。此操作无法撤销。',
  },
  'padmin.users.closeConfirm': {
    en: 'Type {email} to confirm',
    id: 'Ketik {email} untuk konfirmasi',
    zh: '输入 {email} 以确认',
  },
  'padmin.users.closedDone': { en: 'Account closed.', id: 'Akun ditutup.', zh: '账户已关闭。' },
  'padmin.users.closedAt': { en: 'Closed', id: 'Ditutup', zh: '关闭时间' },
  'padmin.users.closedBy': { en: 'Closed by', id: 'Ditutup oleh', zh: '关闭人' },
  'padmin.users.closedReason': { en: 'Reason', id: 'Alasan', zh: '原因' },
  'padmin.users.closedHint': {
    en: 'This account is closed. Its records stay in the ERPs; nothing more can be done to it.',
    id: 'Akun ini sudah ditutup. Datanya tetap ada di ERP; tidak ada tindakan lain yang bisa dilakukan.',
    zh: '此账户已关闭。其记录保留在 ERP 中，无法再对其执行任何操作。',
  },

  'padmin.access.makeOwner': { en: 'Make Owner', id: 'Jadikan Pemilik', zh: '设为所有者' },
  'padmin.access.makeOwnerBody': {
    en: '{email} becomes the Owner of {name}. The current Owner, if any, becomes Admin. The ERP shows the change in its activity.',
    id: '{email} menjadi Pemilik {name}. Pemilik sekarang, jika ada, menjadi Admin. Perubahan ini terlihat di aktivitas ERP.',
    zh: '{email} 将成为 {name} 的所有者。当前所有者（如有）将变为管理员。该变更会显示在 ERP 的活动记录中。',
  },
  'padmin.access.ownerChanged': {
    en: 'Ownership transferred.',
    id: 'Kepemilikan dipindahkan.',
    zh: '所有权已转移。',
  },

  'padmin.err.closed': {
    en: 'This account is closed.',
    id: 'Akun ini sudah ditutup.',
    zh: '此账户已关闭。',
  },
  'padmin.err.confirm': {
    en: 'The e-mail address typed does not match the account.',
    id: 'Alamat e-mail yang diketik tidak cocok dengan akun.',
    zh: '输入的邮箱与该账户不符。',
  },
  'padmin.err.is_admin': {
    en: 'This account is an admin. Revoke its admin role first.',
    id: 'Akun ini adalah admin. Cabut peran adminnya terlebih dahulu.',
    zh: '此账户是管理员。请先撤销其管理员角色。',
  },
  'padmin.err.owns_workspace': {
    en: 'This account owns ERPs that other people use. Transfer the ownership first (on the ERP’s page), or remove the other members of its personal ERP.',
    id: 'Akun ini memiliki ERP yang dipakai orang lain. Pindahkan kepemilikannya dulu (di halaman ERP), atau keluarkan anggota lain dari ERP pribadinya.',
    zh: '此账户拥有其他人正在使用的 ERP。请先在 ERP 页面转移所有权，或移除其个人 ERP 的其他成员。',
  },
  'padmin.err.personal': {
    en: 'A personal ERP cannot be transferred.',
    id: 'ERP pribadi tidak bisa dipindahkan.',
    zh: '个人 ERP 无法转移。',
  },
  'padmin.err.not_member': {
    en: 'The new Owner must be a member of this ERP first.',
    id: 'Pemilik baru harus menjadi anggota ERP ini terlebih dahulu.',
    zh: '新所有者必须先成为此 ERP 的成员。',
  },

  'padmin.event.ACCOUNT_CLOSED': { en: 'Account closed', id: 'Akun ditutup', zh: '账户已关闭' },
  'padmin.event.WORKSPACE_OWNER_CHANGED': {
    en: 'ERP ownership transferred',
    id: 'Kepemilikan ERP dipindahkan',
    zh: 'ERP 所有权已转移',
  },
} satisfies Record<string, Entry>;
