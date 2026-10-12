import type { Entry } from './types';

// Pay terms (monthly / daily) and Indonesian payroll rules (20261012000027).
export const payrollIdMessages = {
  'hr.err.terms': {
    en: 'Check the pay terms.',
    id: 'Periksa ketentuan gaji.',
    zh: '请检查薪酬条款。',
  },
  'hr.err.settings': {
    en: 'Check the payroll settings.',
    id: 'Periksa pengaturan penggajian.',
    zh: '请检查工资设置。',
  },

  'hr.terms.open': { en: 'Pay terms', id: 'Ketentuan gaji', zh: '薪酬条款' },
  'hr.terms.title': {
    en: 'Pay terms of {name}',
    id: 'Ketentuan gaji {name}',
    zh: '{name} 的薪酬条款',
  },
  'hr.terms.payType': { en: 'Paid', id: 'Dibayar', zh: '计薪方式' },
  'hr.terms.hourly': { en: 'Per hour (attendance)', id: 'Per jam (absensi)', zh: '按小时（考勤）' },
  'hr.terms.daily': { en: 'Per day worked', id: 'Per hari kerja', zh: '按出勤天数' },
  'hr.terms.monthly': { en: 'Monthly salary', id: 'Gaji bulanan', zh: '月薪' },
  'hr.terms.salary': { en: 'Monthly salary (gaji pokok)', id: 'Gaji pokok', zh: '月基本工资' },
  'hr.terms.fixedAllowance': {
    en: 'Fixed allowance (tunjangan tetap)',
    id: 'Tunjangan tetap',
    zh: '固定津贴',
  },
  'hr.terms.dailyRate': { en: 'Daily rate', id: 'Upah harian', zh: '日薪' },
  'hr.terms.joinDate': { en: 'Joined on', id: 'Tanggal masuk', zh: '入职日期' },
  'hr.terms.monthlyHint': {
    en: 'Paid once per calendar month (the month of the run’s last day), prorated in the month the employee joined, less unpaid leave.',
    id: 'Dibayar sekali per bulan kalender (bulan tanggal akhir periode), prorata pada bulan masuk, dikurangi cuti tidak dibayar.',
    zh: '每个自然月发放一次（以发薪期末日所在月份计），入职当月按比例，扣除无薪假。',
  },
  'hr.terms.tax': { en: 'Tax and BPJS', id: 'Pajak dan BPJS', zh: '税务与 BPJS' },
  'hr.terms.ptkp': { en: 'PTKP status', id: 'Status PTKP', zh: 'PTKP 状态' },
  'hr.terms.npwp': { en: 'NPWP / NIK', id: 'NPWP / NIK', zh: 'NPWP / NIK' },
  'hr.terms.bpjsTk': {
    en: 'BPJS Ketenagakerjaan (JHT, JKK, JKM)',
    id: 'BPJS Ketenagakerjaan (JHT, JKK, JKM)',
    zh: 'BPJS 就业保险（JHT、JKK、JKM）',
  },
  'hr.terms.bpjsJp': {
    en: 'Jaminan Pensiun (JP)',
    id: 'Jaminan Pensiun (JP)',
    zh: '养老保障（JP）',
  },
  'hr.terms.bpjsKes': { en: 'BPJS Kesehatan', id: 'BPJS Kesehatan', zh: 'BPJS 健康保险' },
  'hr.terms.idOff': {
    en: 'Tax and BPJS are calculated only when Payroll → Settings uses the Indonesian rules.',
    id: 'Pajak dan BPJS hanya dihitung bila Penggajian → Pengaturan memakai aturan Indonesia.',
    zh: '仅当“工资 → 设置”使用印尼规则时才计算税和 BPJS。',
  },
  'hr.terms.saved': { en: 'Pay terms saved', id: 'Ketentuan gaji disimpan', zh: '薪酬条款已保存' },

  'hr.idset.title': { en: 'Payroll rules', id: 'Aturan penggajian', zh: '工资规则' },
  'hr.idset.basic': {
    en: 'Basic: pay items only (allowances, deductions, company contributions)',
    id: 'Dasar: hanya item gaji (tunjangan, potongan, iuran perusahaan)',
    zh: '基础：仅薪酬项目（津贴、扣款、公司缴费）',
  },
  'hr.idset.id': {
    en: 'Indonesia: PPh 21 (TER), BPJS, statutory overtime and THR',
    id: 'Indonesia: PPh 21 (TER), BPJS, lembur sesuai aturan, dan THR',
    zh: '印尼：PPh 21（TER）、BPJS、法定加班费和 THR',
  },
  'hr.idset.jkk': { en: 'JKK rate (%)', id: 'Tarif JKK (%)', zh: 'JKK 费率（%）' },
  'hr.idset.jkkHint': {
    en: 'By risk group: 0.24, 0.54, 0.89, 1.27 or 1.74. A quarry is usually 1.74 — use the rate on your BPJS registration.',
    id: 'Menurut kelompok risiko: 0,24; 0,54; 0,89; 1,27; atau 1,74. Quarry biasanya 1,74 — pakai tarif pada pendaftaran BPJS Anda.',
    zh: '按风险等级：0.24、0.54、0.89、1.27 或 1.74。采石场通常为 1.74，请以 BPJS 登记费率为准。',
  },
  'hr.idset.jkm': { en: 'JKM rate (%)', id: 'Tarif JKM (%)', zh: 'JKM 费率（%）' },
  'hr.idset.jpCap': { en: 'JP wage cap', id: 'Batas upah JP', zh: 'JP 工资上限' },
  'hr.idset.jpCapHint': {
    en: 'Set by BPJS every March (Rp 11,086,300 from March 2026).',
    id: 'Ditetapkan BPJS setiap Maret (Rp 11.086.300 sejak Maret 2026).',
    zh: '由 BPJS 每年三月调整（2026 年 3 月起为 Rp 11,086,300）。',
  },
  'hr.idset.kesCap': {
    en: 'BPJS Kesehatan wage cap',
    id: 'Batas upah BPJS Kesehatan',
    zh: 'BPJS 健康保险工资上限',
  },
  'hr.idset.kesFloor': {
    en: 'BPJS Kesehatan wage floor (UMK, optional)',
    id: 'Batas bawah upah BPJS Kesehatan (UMK, opsional)',
    zh: 'BPJS 健康保险工资下限（UMK，可选）',
  },
  'hr.idset.saved': {
    en: 'Payroll rules saved',
    id: 'Aturan penggajian disimpan',
    zh: '工资规则已保存',
  },
  'hr.idset.note': {
    en: 'PPh 21 uses the TER rates of PP 58/2023 each month and recalculates the year in December. Check the first runs with your tax adviser; record each employee’s PTKP status and NPWP/NIK under Employees → Pay terms.',
    id: 'PPh 21 memakai tarif TER PP 58/2023 setiap bulan dan dihitung ulang setahun pada Desember. Periksa penggajian pertama dengan konsultan pajak; isi status PTKP dan NPWP/NIK tiap karyawan di Karyawan → Ketentuan gaji.',
    zh: 'PPh 21 每月按 PP 58/2023 的 TER 税率计算，并在十二月进行全年重算。请与税务顾问核对最初几次发薪；在“员工 → 薪酬条款”中填写每位员工的 PTKP 状态和 NPWP/NIK。',
  },
  'hr.pay.thr': { en: 'Include THR', id: 'Sertakan THR', zh: '包含 THR' },
  'hr.pay.thrHint': {
    en: 'Once a year: monthly wage × months of service / 12 (at least one month).',
    id: 'Sekali setahun: upah sebulan × masa kerja (bulan) / 12 (minimal satu bulan).',
    zh: '每年一次：月工资 × 服务月数 / 12（至少一个月）。',
  },
  'hr.pay.thrTotal': { en: 'THR', id: 'THR', zh: 'THR' },
  'hr.pay.pph21': { en: 'PPh 21', id: 'PPh 21', zh: 'PPh 21' },
  'hr.pay.bpjs': { en: 'BPJS (both shares)', id: 'BPJS (kedua porsi)', zh: 'BPJS（双方）' },
} satisfies Record<string, Entry>;
