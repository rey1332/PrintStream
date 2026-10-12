import type { Entry } from './types';

// HR: employees, attendance, attendance history and overtime.
export const hrMessages = {
  // ── Navigation ──
  'erp.nav.hr': { en: 'Human resources', id: 'SDM', zh: '人力资源' },
  'erp.nav.employees': { en: 'Employees', id: 'Karyawan', zh: '员工' },
  'erp.nav.attendance': { en: 'Attendance', id: 'Absensi', zh: '考勤' },
  'erp.nav.attendanceHistory': {
    en: 'History & overtime',
    id: 'Riwayat & lembur',
    zh: '记录与加班',
  },
  'erp.nav.payroll': { en: 'Payroll', id: 'Penggajian', zh: '工资发放' },

  // ── Payroll ──
  'hr.pay.subtitle': {
    en: 'Post the unpaid attendance of a period to the books as one journal entry.',
    id: 'Bukukan absensi yang belum dibayar dalam satu periode sebagai satu jurnal.',
    zh: '将某期间未支付的考勤作为一笔分录过账。',
  },
  'hr.pay.newRun': { en: 'New payroll run', id: 'Penggajian baru', zh: '新的工资发放' },
  'hr.pay.payDate': { en: 'Pay date', id: 'Tanggal bayar', zh: '支付日期' },
  'hr.pay.creditTo': { en: 'Paid from', id: 'Dibayar dari', zh: '支付方式' },
  'hr.pay.cash': {
    en: 'Cash and bank (paid now)',
    id: 'Kas & bank (dibayar sekarang)',
    zh: '现金和银行（立即支付）',
  },
  'hr.pay.payable': {
    en: 'Wages payable (pay later)',
    id: 'Utang gaji (dibayar nanti)',
    zh: '应付工资（稍后支付）',
  },
  'hr.pay.employees': { en: 'Employees', id: 'Karyawan', zh: '员工' },
  'hr.pay.records': {
    en: '{n} unpaid attendance records',
    id: '{n} absensi belum dibayar',
    zh: '{n} 条未支付考勤',
  },
  'hr.pay.alreadyPaid': { en: '{n} already paid', id: '{n} sudah dibayar', zh: '{n} 条已支付' },
  'hr.pay.stillIn': {
    en: '{n} not clocked out yet (left out)',
    id: '{n} belum absen pulang (tidak ikut)',
    zh: '{n} 条尚未签退（不计入）',
  },
  'hr.pay.post': { en: 'Post to the books', id: 'Bukukan ke jurnal', zh: '过账' },
  'hr.pay.posted': { en: 'Payroll posted', id: 'Gaji dibukukan', zh: '工资已过账' },
  'hr.pay.confirmTitle': { en: 'Post this payroll?', id: 'Bukukan gaji ini?', zh: '过账此工资？' },
  'hr.pay.confirmCash': {
    en: 'Net pay of {total} is paid from cash and bank on {date}. Wages, overtime, allowances and employer contributions are booked as expenses; deductions are owed until paid on.',
    id: 'Gaji bersih {total} dibayar dari kas & bank pada {date}. Gaji, lembur, tunjangan, dan iuran perusahaan dibukukan sebagai beban; potongan menjadi utang sampai disetorkan.',
    zh: '实发工资 {total} 将于 {date} 从现金和银行支付。工资、加班、津贴和雇主缴费计入费用；扣款在缴纳前记为负债。',
  },
  'hr.pay.confirmPayable': {
    en: 'Net pay of {total} is owed as wages payable from {date}. Wages, overtime, allowances and employer contributions are booked as expenses; deductions are owed until paid on.',
    id: 'Gaji bersih {total} menjadi utang gaji sejak {date}. Gaji, lembur, tunjangan, dan iuran perusahaan dibukukan sebagai beban; potongan menjadi utang sampai disetorkan.',
    zh: '实发工资 {total} 自 {date} 起记为应付工资。工资、加班、津贴和雇主缴费计入费用；扣款在缴纳前记为负债。',
  },
  'hr.pay.runs': { en: 'Payroll runs', id: 'Riwayat penggajian', zh: '工资发放记录' },
  'hr.pay.empty': {
    en: 'No payroll posted yet.',
    id: 'Belum ada gaji yang dibukukan.',
    zh: '尚无工资过账。',
  },
  'hr.pay.period': { en: 'Period', id: 'Periode', zh: '期间' },
  'hr.pay.recordsCol': { en: 'Records', id: 'Absensi', zh: '记录' },
  'hr.pay.entry': { en: 'Journal', id: 'Jurnal', zh: '分录' },
  'hr.pay.statusPosted': { en: 'Posted', id: 'Dibukukan', zh: '已过账' },
  'hr.pay.statusReversed': { en: 'Reversed', id: 'Dibatalkan', zh: '已冲销' },
  'hr.pay.reverse': { en: 'Reverse', id: 'Batalkan', zh: '冲销' },
  'hr.pay.reverseTitle': {
    en: 'Reverse this payroll run?',
    id: 'Batalkan penggajian ini?',
    zh: '冲销此工资发放？',
  },
  'hr.pay.reverseBody': {
    en: 'A reversing journal entry for {total} is posted. Its attendance becomes unpaid again and can be corrected.',
    id: 'Jurnal pembalik sebesar {total} akan dibukukan. Absensinya kembali belum dibayar dan bisa dikoreksi.',
    zh: '将过账一笔 {total} 的冲销分录。相关考勤恢复为未支付，可再次更正。',
  },
  'hr.pay.reversed': { en: 'Payroll reversed', id: 'Penggajian dibatalkan', zh: '工资已冲销' },

  // ── Shared ──
  'hr.duration': { en: '{h}h {m}m', id: '{h}j {m}m', zh: '{h}小时{m}分' },
  'hr.hoursValue': { en: '{hours} h', id: '{hours} jam', zh: '{hours} 小时' },

  // ── Employees ──
  'hr.emp.count': {
    en: '{count} active employees',
    id: '{count} karyawan aktif',
    zh: '{count} 名在职员工',
  },
  'hr.emp.add': { en: 'Add employee', id: 'Tambah karyawan', zh: '添加员工' },
  'hr.emp.addTitle': { en: 'New employee', id: 'Karyawan baru', zh: '新员工' },
  'hr.emp.editTitle': { en: 'Edit employee', id: 'Ubah karyawan', zh: '编辑员工' },
  'hr.emp.searchPlaceholder': { en: 'Search employees…', id: 'Cari karyawan…', zh: '搜索员工…' },
  'hr.emp.showInactive': { en: 'Show inactive', id: 'Tampilkan yang nonaktif', zh: '显示已停用' },
  'hr.emp.empty': { en: 'No employees yet', id: 'Belum ada karyawan', zh: '暂无员工' },
  'hr.emp.emptyHint': {
    en: 'Add employees with their hourly and overtime rates to start taking attendance.',
    id: 'Tambahkan karyawan beserta tarif per jam dan tarif lemburnya untuk mulai mencatat absensi.',
    zh: '添加员工及其小时工资和加班费率，即可开始考勤。',
  },
  'hr.emp.name': { en: 'Name', id: 'Nama', zh: '姓名' },
  'hr.emp.code': { en: 'Employee ID', id: 'ID karyawan', zh: '员工编号' },
  'hr.emp.position': { en: 'Position', id: 'Jabatan', zh: '职位' },
  'hr.emp.phone': { en: 'Phone', id: 'Telepon', zh: '电话' },
  'hr.emp.hourlyRate': { en: 'Hourly rate', id: 'Tarif per jam', zh: '小时工资' },
  'hr.emp.overtimeRate': {
    en: 'Overtime rate (per hour)',
    id: 'Tarif lembur (per jam)',
    zh: '加班费率（每小时）',
  },
  'hr.emp.normalHours': {
    en: 'Normal hours per day',
    id: 'Jam kerja normal per hari',
    zh: '每日标准工时',
  },
  'hr.emp.normalHoursHint': {
    en: 'Time worked beyond this in a day counts as overtime.',
    id: 'Waktu kerja melebihi jam ini dalam sehari dihitung lembur.',
    zh: '当天超出此时长的工作计为加班。',
  },
  'hr.emp.active': { en: 'Active', id: 'Aktif', zh: '在职' },
  'hr.emp.inactive': { en: 'Inactive', id: 'Nonaktif', zh: '已停用' },
  'hr.emp.deactivate': { en: 'Deactivate', id: 'Nonaktifkan', zh: '停用' },
  'hr.emp.reactivate': { en: 'Reactivate', id: 'Aktifkan lagi', zh: '重新启用' },
  'hr.emp.added': { en: '{name} added', id: '{name} ditambahkan', zh: '已添加 {name}' },
  'hr.emp.updated': { en: '{name} updated', id: '{name} diperbarui', zh: '已更新 {name}' },
  'hr.emp.deleted': { en: 'Employee deleted', id: 'Karyawan dihapus', zh: '员工已删除' },
  'hr.emp.confirmDelete': {
    en: 'Delete {name}? This cannot be undone.',
    id: 'Hapus {name}? Tindakan ini tidak bisa dibatalkan.',
    zh: '删除 {name}？此操作无法撤销。',
  },
  'hr.emp.confirmDeactivate': {
    en: '{name} has attendance records, so they are kept and the employee is deactivated instead. Continue?',
    id: '{name} sudah punya catatan absensi, jadi datanya disimpan dan karyawan dinonaktifkan. Lanjutkan?',
    zh: '{name} 已有考勤记录，因此将保留记录并停用该员工。继续吗？',
  },

  // ── Who records attendance ──
  'hr.access.title': {
    en: 'Who can record attendance',
    id: 'Siapa yang boleh mencatat absensi',
    zh: '谁可以记录考勤',
  },
  'hr.access.help': {
    en: 'Owner and Admin always can. Choose which other roles may clock employees in and out in this ERP.',
    id: 'Owner dan Admin selalu bisa. Pilih role lain yang boleh mencatat masuk/pulang karyawan di ERP ini.',
    zh: '所有者和管理员始终可以。请选择在此 ERP 中还可以为员工打卡的其他角色。',
  },
  'hr.access.payNote': {
    en: 'These roles see hours only, never rates or pay.',
    id: 'Role ini hanya melihat jam kerja, tidak melihat tarif atau upah.',
    zh: '这些角色只能看到工时，看不到费率或工资。',
  },
  'hr.access.saved': {
    en: 'Attendance access saved',
    id: 'Akses absensi disimpan',
    zh: '考勤权限已保存',
  },

  // ── Attendance board ──
  'hr.att.total': { en: 'Employees', id: 'Karyawan', zh: '员工' },
  'hr.att.working': { en: 'At work', id: 'Sedang bekerja', zh: '在岗' },
  'hr.att.done': { en: 'Clocked out', id: 'Sudah pulang', zh: '已下班' },
  'hr.att.empty': {
    en: 'No active employees yet.',
    id: 'Belum ada karyawan aktif.',
    zh: '暂无在职员工。',
  },
  'hr.att.notIn': { en: 'Not clocked in', id: 'Belum masuk', zh: '未打卡' },
  'hr.att.workingSince': { en: 'In since {time}', id: 'Masuk sejak {time}', zh: '{time} 上班' },
  'hr.att.overtime': {
    en: '(overtime {duration})',
    id: '(lembur {duration})',
    zh: '（加班 {duration}）',
  },
  'hr.att.in': { en: 'Clock in', id: 'Masuk', zh: '上班打卡' },
  'hr.att.out': { en: 'Clock out', id: 'Pulang', zh: '下班打卡' },
  'hr.att.finished': { en: 'Done for today', id: 'Selesai hari ini', zh: '今日已完成' },
  'hr.att.clockedIn': {
    en: '{name} clocked in',
    id: '{name} sudah masuk',
    zh: '{name} 已上班打卡',
  },
  'hr.att.clockedOut': {
    en: '{name} clocked out',
    id: '{name} sudah pulang',
    zh: '{name} 已下班打卡',
  },

  // ── History ──
  'hr.hist.subtitle': {
    en: 'Attendance and overtime hours per day.',
    id: 'Absensi dan jam lembur per hari.',
    zh: '每日考勤和加班工时。',
  },
  'hr.hist.subtitlePay': {
    en: 'Attendance, overtime and pay per day. Pay uses the rates at clock-in.',
    id: 'Absensi, lembur, dan upah per hari. Upah memakai tarif saat karyawan masuk.',
    zh: '每日考勤、加班和工资。工资按上班打卡时的费率计算。',
  },
  'hr.hist.from': { en: 'From', id: 'Dari', zh: '从' },
  'hr.hist.to': { en: 'To', id: 'Sampai', zh: '至' },
  'hr.hist.employee': { en: 'Employee', id: 'Karyawan', zh: '员工' },
  'hr.hist.empty': {
    en: 'No attendance in this period.',
    id: 'Tidak ada absensi pada periode ini.',
    zh: '此期间没有考勤记录。',
  },
  'hr.hist.summary': { en: 'Overtime summary', id: 'Rekap lembur', zh: '加班汇总' },
  'hr.hist.log': { en: 'Attendance log', id: 'Catatan absensi', zh: '考勤记录' },
  'hr.hist.date': { en: 'Date', id: 'Tanggal', zh: '日期' },
  'hr.hist.in': { en: 'Clock in', id: 'Masuk', zh: '上班' },
  'hr.hist.out': { en: 'Clock out', id: 'Pulang', zh: '下班' },
  'hr.hist.days': { en: 'Days', id: 'Hari', zh: '天数' },
  'hr.hist.worked': { en: 'Worked', id: 'Jam kerja', zh: '工时' },
  'hr.hist.overtime': { en: 'Overtime', id: 'Lembur', zh: '加班' },
  'hr.hist.workedHours': { en: 'Worked (hours)', id: 'Jam kerja (jam)', zh: '工时（小时）' },
  'hr.hist.overtimeHours': { en: 'Overtime (hours)', id: 'Lembur (jam)', zh: '加班（小时）' },
  'hr.hist.regularPay': { en: 'Regular pay', id: 'Upah normal', zh: '正常工资' },
  'hr.hist.overtimePay': { en: 'Overtime pay', id: 'Upah lembur', zh: '加班费' },
  'hr.hist.totalPay': { en: 'Total pay', id: 'Total upah', zh: '工资合计' },
  'hr.hist.total': { en: 'Total', id: 'Total', zh: '合计' },
  'hr.hist.note': { en: 'Note', id: 'Catatan', zh: '备注' },
  'hr.hist.correction': { en: 'Correction reason', id: 'Alasan koreksi', zh: '更正原因' },
  'hr.hist.correctedBadge': { en: 'Corrected', id: 'Dikoreksi', zh: '已更正' },
  'hr.hist.stillIn': { en: 'Still in', id: 'Belum pulang', zh: '未下班' },
  'hr.hist.correct': { en: 'Correct times', id: 'Koreksi jam', zh: '更正时间' },
  'hr.hist.correctTitle': {
    en: 'Correct attendance: {name}',
    id: 'Koreksi absensi: {name}',
    zh: '更正考勤：{name}',
  },
  'hr.hist.outHint': {
    en: 'Leave empty if the employee is still at work.',
    id: 'Kosongkan jika karyawan masih bekerja.',
    zh: '如果员工仍在上班，请留空。',
  },
  'hr.hist.reason': {
    en: 'Reason (at least 5 characters)',
    id: 'Alasan (minimal 5 karakter)',
    zh: '原因（至少 5 个字符）',
  },
  'hr.hist.corrected': { en: 'Attendance corrected', id: 'Absensi dikoreksi', zh: '考勤已更正' },

  // ── Errors ──
  'hr.err.duplicateCode': {
    en: 'Another employee already has this ID.',
    id: 'Karyawan lain sudah memakai ID ini.',
    zh: '其他员工已使用此编号。',
  },
  'hr.err.name': {
    en: "Enter the employee's name.",
    id: 'Isi nama karyawan.',
    zh: '请输入员工姓名。',
  },
  'hr.err.negativeRate': {
    en: 'Rates cannot be negative.',
    id: 'Tarif tidak boleh negatif.',
    zh: '费率不能为负数。',
  },
  'hr.err.normalHours': {
    en: 'Normal hours must be more than 0 and at most 24.',
    id: 'Jam kerja normal harus lebih dari 0 dan paling banyak 24.',
    zh: '标准工时必须大于 0 且不超过 24。',
  },
  'hr.err.alreadyIn': {
    en: 'This employee is already clocked in.',
    id: 'Karyawan ini sudah masuk.',
    zh: '该员工已上班打卡。',
  },
  'hr.err.alreadyToday': {
    en: 'This employee already has attendance for today. An owner or admin can correct it.',
    id: 'Karyawan ini sudah punya absensi hari ini. Owner atau admin bisa mengoreksinya.',
    zh: '该员工今天已有考勤记录。所有者或管理员可以更正。',
  },
  'hr.err.notIn': {
    en: 'This employee is not clocked in.',
    id: 'Karyawan ini belum masuk.',
    zh: '该员工尚未上班打卡。',
  },
  'hr.err.tooLong': {
    en: 'Clocked in more than 24 hours ago. Ask an owner or admin to correct it.',
    id: 'Masuk lebih dari 24 jam lalu. Minta owner atau admin mengoreksinya.',
    zh: '上班打卡已超过 24 小时，请让所有者或管理员更正。',
  },
  'hr.err.inactive': {
    en: 'This employee is inactive.',
    id: 'Karyawan ini nonaktif.',
    zh: '该员工已停用。',
  },
  'hr.err.hasAttendance': {
    en: 'This employee has attendance records. Deactivate them instead.',
    id: 'Karyawan ini punya catatan absensi. Nonaktifkan saja.',
    zh: '该员工有考勤记录，请改为停用。',
  },
  'hr.err.reason': {
    en: 'Give a reason of at least 5 characters.',
    id: 'Isi alasan minimal 5 karakter.',
    zh: '请填写至少 5 个字符的原因。',
  },
  'hr.err.times': {
    en: 'Clock-out must be after clock-in and within 24 hours.',
    id: 'Jam pulang harus setelah jam masuk dan maksimal 24 jam.',
    zh: '下班时间必须晚于上班时间且在 24 小时内。',
  },
  'hr.err.future': {
    en: 'Times cannot be in the future.',
    id: 'Waktu tidak boleh di masa depan.',
    zh: '时间不能是将来。',
  },
  'hr.err.period': {
    en: 'Choose a period of at most one year.',
    id: 'Pilih periode maksimal satu tahun.',
    zh: '请选择不超过一年的期间。',
  },
  'hr.err.paid': {
    en: 'This was already paid in a payroll run; reverse the run first.',
    id: 'Ini sudah dibayar dalam penggajian; batalkan penggajiannya dulu.',
    zh: '这已在工资发放中支付；请先冲销该次发放。',
  },
  'hr.err.nothingToPay': {
    en: 'There is no unpaid, finished attendance in this period.',
    id: 'Tidak ada absensi selesai yang belum dibayar pada periode ini.',
    zh: '此期间没有未支付的已完成考勤。',
  },
  'hr.err.zeroPay': {
    en: 'The attendance in this period has no pay (rates are 0).',
    id: 'Absensi pada periode ini tidak punya upah (tarif 0).',
    zh: '此期间的考勤没有工资（费率为 0）。',
  },
  'hr.err.alreadyReversed': {
    en: 'This payroll run was already reversed.',
    id: 'Proses gaji ini sudah dibatalkan.',
    zh: '该次工资发放已冲销。',
  },
  'hr.err.booksClosed': {
    en: 'The books are closed for that date; choose a later pay date.',
    id: 'Buku sudah ditutup untuk tanggal itu; pilih tanggal bayar yang lebih baru.',
    zh: '该日期账簿已关闭，请选择较晚的支付日期。',
  },
  'hr.err.forbidden': {
    en: 'You are not allowed to do that in this ERP.',
    id: 'Anda tidak diizinkan melakukan itu di ERP ini.',
    zh: '您无权在此 ERP 中执行此操作。',
  },
  'hr.err.failed': {
    en: 'Something went wrong. Please try again.',
    id: 'Terjadi kesalahan. Silakan coba lagi.',
    zh: '出现问题，请重试。',
  },

  // ── Workspace audit trail ──
  'audit.hr.attendance_roles_changed': {
    en: 'Attendance access changed',
    id: 'Akses absensi diubah',
    zh: '考勤权限已更改',
  },
  'audit.hr.employee_rates_changed': {
    en: 'Employee rates changed',
    id: 'Tarif karyawan diubah',
    zh: '员工费率已更改',
  },
  'audit.hr.employee_deleted': { en: 'Employee deleted', id: 'Karyawan dihapus', zh: '员工已删除' },
  'audit.hr.attendance_corrected': {
    en: 'Attendance corrected',
    id: 'Absensi dikoreksi',
    zh: '考勤已更正',
  },
  'audit.hr.payroll_posted': { en: 'Payroll posted', id: 'Gaji dibukukan', zh: '工资已过账' },
  'audit.hr.payroll_reversed': {
    en: 'Payroll reversed',
    id: 'Penggajian dibatalkan',
    zh: '工资已冲销',
  },
  'audit.workspace.reset': { en: 'ERP reset', id: 'ERP direset', zh: 'ERP 已重置' },
  'audit.erp.deleted': {
    en: 'Created ERP deleted',
    id: 'ERP buatan dihapus',
    zh: '已删除创建的 ERP',
  },
} satisfies Record<string, Entry>;
