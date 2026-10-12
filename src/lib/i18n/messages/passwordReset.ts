import type { Entry } from './types';

// /reset-password (one-time links from an administrator) and the notice for
// an ERP that ETNA suspended.
export const passwordResetMessages = {
  'reset.title': { en: 'Choose a new password', id: 'Pilih kata sandi baru', zh: '设置新密码' },
  'reset.titleInvite': {
    en: 'Welcome to ETNA',
    id: 'Selamat datang di ETNA',
    zh: '欢迎使用 ETNA',
  },
  'reset.for': {
    en: 'For the account {email}.',
    id: 'Untuk akun {email}.',
    zh: '账户：{email}。',
  },
  'reset.newPassword': { en: 'New password', id: 'Kata sandi baru', zh: '新密码' },
  'reset.repeat': {
    en: 'New password again',
    id: 'Ulangi kata sandi baru',
    zh: '再次输入新密码',
  },
  'reset.rules': {
    en: 'At least {min} characters. Afterwards you sign in with it; two-factor stays as it was.',
    id: 'Minimal {min} karakter. Setelah itu Anda masuk dengannya; dua langkah tetap seperti sebelumnya.',
    zh: '至少 {min} 个字符。之后请使用新密码登录；两步验证设置保持不变。',
  },
  'reset.show': { en: 'Show password', id: 'Tampilkan kata sandi', zh: '显示密码' },
  'reset.hide': { en: 'Hide password', id: 'Sembunyikan kata sandi', zh: '隐藏密码' },
  'reset.save': { en: 'Save password', id: 'Simpan kata sandi', zh: '保存密码' },
  'reset.done': {
    en: 'The password for {email} is set. You are signed out everywhere else.',
    id: 'Kata sandi untuk {email} sudah diatur. Anda dikeluarkan dari semua perangkat lain.',
    zh: '{email} 的密码已设置。您已在其他所有设备上退出。',
  },
  'reset.signIn': { en: 'Sign in', id: 'Masuk', zh: '登录' },
  'reset.invalid': {
    en: 'This link does not work any more.',
    id: 'Tautan ini sudah tidak berlaku.',
    zh: '此链接已失效。',
  },
  'reset.invalidHint': {
    en: 'Links work once and only for a limited time; a newer link cancels older ones. Ask your ETNA administrator for a new one.',
    id: 'Tautan hanya berlaku sekali dan untuk waktu terbatas; tautan yang lebih baru membatalkan yang lama. Mintalah tautan baru kepada administrator ETNA Anda.',
    zh: '链接只能使用一次且有时间限制；新链接会使旧链接失效。请向您的 ETNA 管理员索取新链接。',
  },
  'reset.err.short': {
    en: 'Use at least {min} characters.',
    id: 'Gunakan minimal {min} karakter.',
    zh: '请至少使用 {min} 个字符。',
  },
  'reset.err.long': {
    en: 'That password is too long.',
    id: 'Kata sandi itu terlalu panjang.',
    zh: '密码过长。',
  },
  'reset.err.mismatch': {
    en: 'The two passwords are not the same.',
    id: 'Kedua kata sandi tidak sama.',
    zh: '两次输入的密码不一致。',
  },
  'reset.err.rateLimited': {
    en: 'Too many attempts. Please wait 15 minutes and try again.',
    id: 'Terlalu banyak percobaan. Silakan tunggu 15 menit lalu coba lagi.',
    zh: '尝试次数过多。请等待 15 分钟后重试。',
  },
  'reset.err.failed': {
    en: 'The password could not be saved. Please try again.',
    id: 'Kata sandi tidak dapat disimpan. Silakan coba lagi.',
    zh: '无法保存密码，请重试。',
  },

  'erp.twoFactor.title': {
    en: '“{name}” needs two-factor sign-in',
    id: '“{name}” memerlukan masuk dua langkah',
    zh: '“{name}”需要两步验证登录',
  },
  'erp.twoFactor.role': {
    en: 'Owners, Admins and Finance of an ERP that others use must sign in with two-factor. Turn it on in Settings (Two-factor authentication), then sign out and in again with your code.',
    id: 'Pemilik, Admin, dan Keuangan pada ERP yang dipakai orang lain wajib masuk dengan dua langkah. Aktifkan di Pengaturan (Autentikasi dua langkah), lalu keluar dan masuk lagi dengan kode Anda.',
    zh: '多人使用的 ERP 中，所有者、管理员和财务必须使用两步验证登录。请在“设置”（两步验证）中开启，然后退出并使用验证码重新登录。',
  },
  'erp.twoFactor.erp': {
    en: 'The Owner of this ERP requires two-factor sign-in for every member. Turn it on in Settings (Two-factor authentication), then sign out and in again with your code.',
    id: 'Pemilik ERP ini mewajibkan masuk dua langkah untuk semua anggota. Aktifkan di Pengaturan (Autentikasi dua langkah), lalu keluar dan masuk lagi dengan kode Anda.',
    zh: '此 ERP 的所有者要求所有成员使用两步验证登录。请在“设置”（两步验证）中开启，然后退出并使用验证码重新登录。',
  },
  'erp.twoFactor.open': { en: 'Open Settings', id: 'Buka Pengaturan', zh: '打开设置' },
  'erp.suspended.title': {
    en: '“{name}” is suspended',
    id: '“{name}” ditangguhkan',
    zh: '“{name}”已被暂停',
  },
  'erp.suspended.body': {
    en: 'ETNA has suspended this ERP, so its data cannot be opened right now. Contact ETNA support. You can still switch to another ERP from the menu and change your own account in Settings.',
    id: 'ETNA telah menangguhkan ERP ini, sehingga datanya tidak dapat dibuka saat ini. Hubungi dukungan ETNA. Anda tetap dapat beralih ke ERP lain dari menu dan mengubah akun Anda sendiri di Pengaturan.',
    zh: 'ETNA 已暂停此 ERP，目前无法打开其数据。请联系 ETNA 支持。您仍可以从菜单切换到其他 ERP，并在“设置”中修改自己的账户。',
  },
} satisfies Record<string, Entry>;
