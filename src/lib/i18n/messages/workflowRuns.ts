import type { Entry } from './types';

// Workflow versions, server runs, run history, graph checks and the nodes added in Phase 2.
export const workflowRunMessages = {
  // ── Node errors (shown in the viewer's language even for server runs) ──
  'wf.err.unexpected': {
    en: 'This step failed unexpectedly.',
    id: 'Langkah ini gagal secara tak terduga.',
    zh: '此步骤意外失败。',
  },
  'wf.err.unknownColumn': {
    en: 'Column "{column}" is not in the input.',
    id: 'Kolom "{column}" tidak ada di input.',
    zh: '输入中没有列“{column}”。',
  },
  'wf.err.invalidOption': {
    en: 'Option "{value}" is not supported.',
    id: 'Opsi "{value}" tidak didukung.',
    zh: '不支持选项“{value}”。',
  },
  'wf.err.missingConfig': {
    en: 'Set "{field}" for this step.',
    id: 'Isi "{field}" untuk langkah ini.',
    zh: '请为此步骤设置“{field}”。',
  },
  'wf.err.duplicateColumn': {
    en: 'Two output columns would have the same name.',
    id: 'Dua kolom output akan memiliki nama yang sama.',
    zh: '两个输出列将同名。',
  },
  'wf.err.timeout': {
    en: 'Not run: the time limit for a run was reached.',
    id: 'Tidak dijalankan: batas waktu run tercapai.',
    zh: '未运行：已达到运行时限。',
  },
  'wf.err.cancelled': {
    en: 'Not run: the run was cancelled.',
    id: 'Tidak dijalankan: run dibatalkan.',
    zh: '未运行：运行已取消。',
  },
  'wf.err.upstreamFailed': {
    en: 'Not run: an earlier step failed.',
    id: 'Tidak dijalankan: langkah sebelumnya gagal.',
    zh: '未运行：前一步骤失败。',
  },

  // ── Graph checks ──
  'wf.issue.tooLarge': {
    en: 'A workflow can have at most {nodes} steps and {edges} connections.',
    id: 'Alur kerja maksimal {nodes} langkah dan {edges} koneksi.',
    zh: '工作流最多 {nodes} 个步骤和 {edges} 条连接。',
  },
  'wf.issue.tooManyInputs': {
    en: 'This step accepts at most {max} input(s).',
    id: 'Langkah ini menerima paling banyak {max} input.',
    zh: '此步骤最多接受 {max} 个输入。',
  },
  'wf.issue.notNumeric': {
    en: '"{column}" is not a number field; non-numeric values are ignored.',
    id: '"{column}" bukan kolom angka; nilai non-angka diabaikan.',
    zh: '“{column}”不是数字字段；非数字值将被忽略。',
  },
  'wf.issue.danglingEdge': {
    en: 'A connection points to a step that no longer exists.',
    id: 'Ada koneksi ke langkah yang sudah tidak ada.',
    zh: '有连接指向已不存在的步骤。',
  },
  'wf.issue.badHandle': {
    en: 'Connect from the "match" or "otherwise" output.',
    id: 'Hubungkan dari output "cocok" atau "lainnya".',
    zh: '请从“匹配”或“否则”输出连接。',
  },
  'wf.issue.count': {
    en: '{count} problem(s) to fix before running',
    id: '{count} masalah perlu diperbaiki sebelum menjalankan',
    zh: '运行前需修复 {count} 个问题',
  },
  'wf.issue.none': { en: 'Ready to run', id: 'Siap dijalankan', zh: '可以运行' },
  'wf.issue.invalidConnection': {
    en: 'That connection is not allowed (loop, full input or same step).',
    id: 'Koneksi itu tidak diizinkan (berulang, input penuh, atau langkah yang sama).',
    zh: '不允许该连接（循环、输入已满或同一步骤）。',
  },

  // ── New nodes ──
  'wf.node.tf.select': { en: 'Select & Rename', id: 'Pilih & Ganti Nama', zh: '选择并重命名' },
  'wf.desc.tf.select': {
    en: 'Keep some columns and rename them',
    id: 'Pertahankan sebagian kolom dan ganti namanya',
    zh: '保留部分列并重命名',
  },
  'wf.node.tf.calc': { en: 'Calculated Field', id: 'Kolom Terhitung', zh: '计算字段' },
  'wf.desc.tf.calc': {
    en: 'New column from a formula over other columns',
    id: 'Kolom baru dari rumus atas kolom lain',
    zh: '基于其他列的公式生成新列',
  },
  'wf.node.tf.validate': { en: 'Validate Data', id: 'Validasi Data', zh: '数据校验' },
  'wf.desc.tf.validate': {
    en: 'Check required values, types and duplicate keys',
    id: 'Periksa nilai wajib, tipe, dan kunci ganda',
    zh: '检查必填值、类型和重复键',
  },
  'wf.node.tf.branch': { en: 'Branch', id: 'Cabang', zh: '分支' },
  'wf.desc.tf.branch': {
    en: 'Split rows into matching and other rows',
    id: 'Pisahkan baris yang cocok dan lainnya',
    zh: '将行拆分为匹配行与其他行',
  },
  'wf.node.out.dataset': { en: 'Output Dataset', id: 'Dataset Output', zh: '输出数据集' },
  'wf.desc.out.dataset': {
    en: 'Name the result of this workflow',
    id: 'Beri nama hasil alur kerja ini',
    zh: '为此工作流的结果命名',
  },
  'wf.handle.match': { en: 'match', id: 'cocok', zh: '匹配' },
  'wf.handle.else': { en: 'otherwise', id: 'lainnya', zh: '否则' },
  'wf.field.columns': {
    en: 'Columns to keep (comma-separated, empty = all)',
    id: 'Kolom yang dipertahankan (pisahkan koma, kosong = semua)',
    zh: '要保留的列（逗号分隔，留空 = 全部）',
  },
  'wf.field.rename': {
    en: 'Rename (old:new, …)',
    id: 'Ganti nama (lama:baru, …)',
    zh: '重命名（旧:新, …）',
  },
  'wf.field.requiredColumns': { en: 'Required columns', id: 'Kolom wajib', zh: '必填列' },
  'wf.field.numericColumns': { en: 'Must be numbers', id: 'Harus angka', zh: '必须为数字' },
  'wf.field.dateColumns': { en: 'Must be dates', id: 'Harus tanggal', zh: '必须为日期' },
  'wf.field.uniqueKey': { en: 'Unique key column', id: 'Kolom kunci unik', zh: '唯一键列' },
  'wf.field.action': { en: 'Rows with problems', id: 'Baris bermasalah', zh: '有问题的行' },
  'wf.field.name': { en: 'Dataset name', id: 'Nama dataset', zh: '数据集名称' },
  'wf.opt.report': { en: 'keep and report', id: 'pertahankan dan laporkan', zh: '保留并报告' },
  'wf.opt.exclude': { en: 'exclude from output', id: 'keluarkan dari output', zh: '从输出中排除' },
  'wf.calc.hint': {
    en: 'Use column names, e.g. total - amount_paid. Names with dots go in brackets: [customer.balance].',
    id: 'Gunakan nama kolom, mis. total - amount_paid. Nama bertitik ditulis dalam kurung siku: [customer.balance].',
    zh: '使用列名，例如 total - amount_paid。含点的名称放在方括号中：[customer.balance]。',
  },
  'wf.inputFields': { en: 'Input fields', id: 'Kolom input', zh: '输入字段' },
  'wf.fieldsCount': { en: '{count} fields', id: '{count} kolom', zh: '{count} 个字段' },
  'wf.pickColumn': { en: 'Choose a column', id: 'Pilih kolom', zh: '选择列' },

  // ── Data quality ──
  'wf.dq.title': { en: 'Data quality', id: 'Kualitas data', zh: '数据质量' },
  'wf.dq.checked': { en: 'Rows checked', id: 'Baris diperiksa', zh: '已检查行' },
  'wf.dq.invalidRows': { en: 'Rows with problems', id: 'Baris bermasalah', zh: '有问题的行' },
  'wf.dq.missingRequired': {
    en: 'Missing required values',
    id: 'Nilai wajib kosong',
    zh: '缺少必填值',
  },
  'wf.dq.invalidType': { en: 'Invalid types', id: 'Tipe tidak valid', zh: '类型无效' },
  'wf.dq.duplicateKeys': { en: 'Duplicate keys', id: 'Kunci ganda', zh: '重复键' },
  'wf.dq.failedRelationships': { en: 'Failed relationships', id: 'Relasi gagal', zh: '关联失败' },
  'wf.dq.affected': {
    en: 'Affected rows (first {count})',
    id: 'Baris terdampak ({count} pertama)',
    zh: '受影响的行（前 {count} 行）',
  },
  'wf.dq.problem.missing': { en: 'missing', id: 'kosong', zh: '缺失' },
  'wf.dq.problem.type': { en: 'wrong type', id: 'tipe salah', zh: '类型错误' },
  'wf.dq.problem.duplicate': { en: 'duplicate', id: 'ganda', zh: '重复' },
  'wf.dq.row': { en: 'Row {row}', id: 'Baris {row}', zh: '第 {row} 行' },
  'wf.displayTruncated': {
    en: 'Showing {shown} of {total} rows here.',
    id: 'Menampilkan {shown} dari {total} baris di sini.',
    zh: '此处显示 {total} 行中的 {shown} 行。',
  },

  // ── Versions ──
  'wf.ver.draft': { en: 'Draft', id: 'Draf', zh: '草稿' },
  'wf.ver.unsavedChanges': {
    en: 'Unsaved changes',
    id: 'Perubahan belum disimpan',
    zh: '有未保存的更改',
  },
  'wf.ver.savedDraft': { en: 'Draft saved', id: 'Draf tersimpan', zh: '草稿已保存' },
  'wf.ver.notPublished': { en: 'Not published', id: 'Belum dipublikasikan', zh: '未发布' },
  'wf.ver.published': {
    en: 'Published v{version}',
    id: 'Terbit v{version}',
    zh: '已发布 v{version}',
  },
  'wf.ver.differs': {
    en: 'Draft differs from published v{version}',
    id: 'Draf berbeda dari terbitan v{version}',
    zh: '草稿与已发布的 v{version} 不同',
  },
  'wf.ver.matches': {
    en: 'Draft matches published v{version}',
    id: 'Draf sama dengan terbitan v{version}',
    zh: '草稿与已发布的 v{version} 一致',
  },
  'wf.ver.saveVersion': { en: 'Save version', id: 'Simpan versi', zh: '保存版本' },
  'wf.ver.publish': { en: 'Publish', id: 'Terbitkan', zh: '发布' },
  'wf.ver.versions': { en: 'Versions', id: 'Versi', zh: '版本' },
  'wf.ver.none': {
    en: 'No saved versions yet.',
    id: 'Belum ada versi tersimpan.',
    zh: '尚无保存的版本。',
  },
  'wf.ver.note': {
    en: 'Version note (optional)',
    id: 'Catatan versi (opsional)',
    zh: '版本说明（可选）',
  },
  'wf.ver.saveTitle': { en: 'Save a version', id: 'Simpan versi', zh: '保存版本' },
  'wf.ver.saveBody': {
    en: 'Saves the current draft as a numbered version that cannot be changed later.',
    id: 'Menyimpan draf saat ini sebagai versi bernomor yang tidak dapat diubah.',
    zh: '将当前草稿保存为不可更改的编号版本。',
  },
  'wf.ver.publishToo': {
    en: 'Also publish this version',
    id: 'Sekaligus terbitkan versi ini',
    zh: '同时发布此版本',
  },
  'wf.ver.savedVersion': {
    en: 'Saved version {version}',
    id: 'Versi {version} tersimpan',
    zh: '已保存版本 {version}',
  },
  'wf.ver.publishedVersion': {
    en: 'Published version {version}',
    id: 'Versi {version} diterbitkan',
    zh: '已发布版本 {version}',
  },
  'wf.ver.restore': { en: 'Open in draft', id: 'Buka di draf', zh: '在草稿中打开' },
  'wf.ver.restoreConfirm': {
    en: 'Replace the current draft with version {version}? Unsaved changes will be lost.',
    id: 'Ganti draf saat ini dengan versi {version}? Perubahan yang belum disimpan akan hilang.',
    zh: '用版本 {version} 替换当前草稿？未保存的更改将丢失。',
  },
  'wf.ver.publishThis': { en: 'Publish this version', id: 'Terbitkan versi ini', zh: '发布此版本' },
  'wf.ver.current': { en: 'published', id: 'terbit', zh: '已发布' },
  'wf.ver.runPublished': {
    en: 'Run published version',
    id: 'Jalankan versi terbit',
    zh: '运行已发布版本',
  },
  'wf.ver.readOnly': {
    en: 'Shared with your workspace · view and run only',
    id: 'Dibagikan ke workspace Anda · hanya lihat dan jalankan',
    zh: '已共享至您的工作区 · 仅可查看和运行',
  },
  'wf.ver.duplicated': {
    en: 'Created a copy you can edit',
    id: 'Salinan yang dapat Anda edit telah dibuat',
    zh: '已创建可编辑的副本',
  },
  'wf.ver.copyName': { en: '{name} (copy)', id: '{name} (salinan)', zh: '{name}（副本）' },
  'wf.ver.leaveConfirm': {
    en: 'You have unsaved changes. Leave without saving?',
    id: 'Ada perubahan yang belum disimpan. Keluar tanpa menyimpan?',
    zh: '有未保存的更改。确定不保存就离开吗？',
  },
  'wf.ver.conflict': {
    en: 'This workflow was changed elsewhere. Reload to see the latest version before saving.',
    id: 'Alur kerja ini diubah di tempat lain. Muat ulang untuk melihat versi terbaru sebelum menyimpan.',
    zh: '此工作流已在别处更改。请重新加载查看最新版本后再保存。',
  },
  'wf.ver.migrationRequired': {
    en: 'The database update for workflow versions has not been applied yet.',
    id: 'Pembaruan database untuk versi alur kerja belum diterapkan.',
    zh: '尚未应用工作流版本的数据库更新。',
  },

  // ── Runs ──
  'wf.run.onServer': {
    en: 'Running on the server…',
    id: 'Berjalan di server…',
    zh: '正在服务器上运行…',
  },
  'wf.run.cancel': { en: 'Cancel run', id: 'Batalkan run', zh: '取消运行' },
  'wf.run.cancelling': {
    en: 'Cancelling after the current step…',
    id: 'Membatalkan setelah langkah saat ini…',
    zh: '将在当前步骤后取消…',
  },
  'wf.run.fixFirst': {
    en: 'Fix the highlighted problems before running.',
    id: 'Perbaiki masalah yang ditandai sebelum menjalankan.',
    zh: '运行前请修复标出的问题。',
  },
  'wf.run.succeeded': {
    en: 'Run finished in {ms} ms',
    id: 'Run selesai dalam {ms} md',
    zh: '运行完成，用时 {ms} 毫秒',
  },
  'wf.run.failed': { en: 'Run failed', id: 'Run gagal', zh: '运行失败' },
  'wf.run.cancelled': { en: 'Run cancelled', id: 'Run dibatalkan', zh: '运行已取消' },
  'wf.run.timedOut': {
    en: 'Run stopped at the time limit; later steps were not run.',
    id: 'Run berhenti karena batas waktu; langkah berikutnya tidak dijalankan.',
    zh: '运行因时限停止；后续步骤未运行。',
  },
  'wf.run.tooMany': {
    en: 'You already have 3 runs in progress. Wait for one to finish.',
    id: 'Anda sudah memiliki 3 run berjalan. Tunggu salah satunya selesai.',
    zh: '您已有 3 个运行在进行中，请等待其中一个完成。',
  },
  'wf.run.alreadyRecorded': {
    en: 'This run was already started.',
    id: 'Run ini sudah dimulai.',
    zh: '此运行已开始。',
  },
  'wf.run.preview': {
    en: 'Preview only: runs read data and never change ERP records.',
    id: 'Hanya pratinjau: run membaca data dan tidak pernah mengubah rekaman ERP.',
    zh: '仅预览：运行只读取数据，不会更改 ERP 记录。',
  },
  'wf.run.history': { en: 'Run history', id: 'Riwayat run', zh: '运行历史' },
  'wf.run.noHistory': { en: 'No runs yet.', id: 'Belum ada run.', zh: '暂无运行记录。' },
  'wf.run.kind.draft': { en: 'Draft', id: 'Draf', zh: '草稿' },
  'wf.run.kind.published': {
    en: 'Published v{version}',
    id: 'Terbit v{version}',
    zh: '已发布 v{version}',
  },
  'wf.run.kind.version': { en: 'Version {version}', id: 'Versi {version}', zh: '版本 {version}' },
  'wf.run.by.you': { en: 'you', id: 'Anda', zh: '您' },
  'wf.run.by.member': { en: 'a workspace member', id: 'anggota workspace', zh: '工作区成员' },
  'wf.run.meta': {
    en: '{kind} · by {who} · {rows} output rows',
    id: '{kind} · oleh {who} · {rows} baris output',
    zh: '{kind} · 由{who}运行 · {rows} 行输出',
  },
  'wf.run.status.queued': { en: 'Queued', id: 'Antre', zh: '排队中' },
  'wf.run.status.running': { en: 'Running', id: 'Berjalan', zh: '运行中' },
  'wf.run.status.success': { en: 'Succeeded', id: 'Berhasil', zh: '成功' },
  'wf.run.status.failed': { en: 'Failed', id: 'Gagal', zh: '失败' },
  'wf.run.status.cancelled': { en: 'Cancelled', id: 'Dibatalkan', zh: '已取消' },
  'wf.run.code.invalidGraph': {
    en: 'The workflow had configuration problems.',
    id: 'Alur kerja memiliki masalah konfigurasi.',
    zh: '工作流存在配置问题。',
  },
  'wf.run.code.nodeFailed': {
    en: 'A step failed.',
    id: 'Sebuah langkah gagal.',
    zh: '某个步骤失败。',
  },
  'wf.run.code.timeout': {
    en: 'Stopped at the time limit.',
    id: 'Berhenti karena batas waktu.',
    zh: '因时限停止。',
  },
  'wf.run.code.cancelled': { en: 'Cancelled.', id: 'Dibatalkan.', zh: '已取消。' },
  'wf.run.code.abandoned': {
    en: 'The server stopped before the run finished.',
    id: 'Server berhenti sebelum run selesai.',
    zh: '服务器在运行完成前停止。',
  },
  'wf.run.dq': {
    en: 'Data quality: {invalid} of {checked} rows with problems',
    id: 'Kualitas data: {invalid} dari {checked} baris bermasalah',
    zh: '数据质量：{checked} 行中 {invalid} 行有问题',
  },
} satisfies Record<string, Entry>;
