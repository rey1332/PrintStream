import type { Entry } from './types';

// Terminal: the jobs list, the overview's health panel and MCP access
// (src/app/terminal/components/Jobs.tsx, Health.tsx, McpAccess.tsx).
export const terminalOpsMessages = {
  // ─── Jobs ──────────────────────────────────────────────────────────────────
  'ps.job.retry': { en: 'Run again', id: 'Jalankan lagi', zh: '重新运行' },
  'ps.job.retryQueued': { en: 'Queued again', id: 'Diantrekan lagi', zh: '已重新排队' },
  'ps.job.retried': { en: 'retry', id: 'ulangan', zh: '重试' },
  'ps.job.showAll': { en: 'Show all {n}', id: 'Tampilkan semua {n}', zh: '显示全部 {n} 个' },
  'ps.job.lastOf': { en: 'last {when}', id: 'terakhir {when}', zh: '最近 {when}' },
  'ps.job.attempts': {
    en: 'tried {n} of {max}',
    id: 'dicoba {n} dari {max}',
    zh: '已尝试 {n}/{max}',
  },
  'ps.job.cancelledByYou': { en: 'Cancelled by you', id: 'Dibatalkan oleh Anda', zh: '由您取消' },
  'ps.job.cancelledBy': {
    en: 'Cancelled by {who}',
    id: 'Dibatalkan oleh {who}',
    zh: '由 {who} 取消',
  },
  'ps.job.cancelledByUser': {
    en: 'Cancelled before it started',
    id: 'Dibatalkan sebelum dimulai',
    zh: '在开始前被取消',
  },
  'ps.job.filter': { en: 'Show jobs', id: 'Tampilkan pekerjaan', zh: '显示任务' },
  'ps.job.filter.all': { en: 'All', id: 'Semua', zh: '全部' },
  'ps.job.filter.problems': {
    en: 'Failed or cancelled',
    id: 'Gagal atau dibatalkan',
    zh: '失败或已取消',
  },
  'ps.job.filter.active': {
    en: 'Waiting or running',
    id: 'Menunggu atau berjalan',
    zh: '等待或运行中',
  },
  'ps.job.filter.succeeded': { en: 'Succeeded', id: 'Berhasil', zh: '成功' },
  'ps.job.kindFilter': { en: 'Kind of job', id: 'Jenis pekerjaan', zh: '任务类型' },
  'ps.job.kindAll': { en: 'All kinds', id: 'Semua jenis', zh: '全部类型' },
  'ps.job.family.ai': { en: 'AI', id: 'AI', zh: 'AI' },
  'ps.job.family.connector': { en: 'Connections', id: 'Koneksi', zh: '连接' },
  'ps.job.family.dataset': { en: 'Datasets', id: 'Dataset', zh: '数据集' },
  'ps.job.family.import': { en: 'Imports', id: 'Impor', zh: '导入' },
  'ps.job.family.pipeline': { en: 'Pipelines', id: 'Pipeline', zh: '管道' },
  'ps.job.family.maintenance': { en: 'Upkeep', id: 'Perawatan', zh: '维护' },
  'ps.job.family.workspace': { en: 'Company', id: 'Perusahaan', zh: '公司' },
  'ps.job.shown': { en: '{n} of {total}', id: '{n} dari {total}', zh: '{total} 中的 {n}' },
  'ps.err.cancelled_by_user': {
    en: 'Cancelled before it started.',
    id: 'Dibatalkan sebelum dimulai.',
    zh: '在开始前被取消。',
  },
  'ps.err.worker_lost': {
    en: 'The background worker stopped while running it.',
    id: 'Proses latar belakang berhenti saat menjalankannya.',
    zh: '后台进程在运行时停止。',
  },
  'ps.err.not_retryable': {
    en: 'This job cannot be run again; start it from where it was made.',
    id: 'Pekerjaan ini tidak bisa dijalankan lagi; mulai dari tempat asalnya.',
    zh: '此任务无法重新运行；请从原处重新开始。',
  },
  'ps.err.too_many_tokens': {
    en: 'At most 10 tokens per Terminal; revoke one first.',
    id: 'Paling banyak 10 token per Terminal; cabut salah satu dulu.',
    zh: '每个 Terminal 最多 10 个令牌；请先撤销一个。',
  },
  'ps.err.name': { en: 'Enter a name.', id: 'Isi nama.', zh: '请输入名称。' },
  'ps.err.days': {
    en: 'A token lasts 1 to 365 days.',
    id: 'Token berlaku 1 sampai 365 hari.',
    zh: '令牌有效期为 1 至 365 天。',
  },

  // ─── Health ────────────────────────────────────────────────────────────────
  'ps.health.title': { en: 'Needs attention', id: 'Perlu perhatian', zh: '需要关注' },
  'ps.health.allGood': {
    en: 'Nothing needs attention: pipelines, schedules and syncs are fine.',
    id: 'Tidak ada yang perlu perhatian: pipeline, jadwal, dan sinkronisasi baik-baik saja.',
    zh: '一切正常：管道、计划和同步均无问题。',
  },
  'ps.health.hint': {
    en: 'Open an item to see it and fix it.',
    id: 'Buka sebuah item untuk melihat dan memperbaikinya.',
    zh: '打开某项以查看并修复。',
  },
  'ps.health.last24h': {
    en: 'Last 24 h: {ok} succeeded, {failed} failed, {cancelled} cancelled',
    id: '24 jam terakhir: {ok} berhasil, {failed} gagal, {cancelled} dibatalkan',
    zh: '最近 24 小时：{ok} 成功，{failed} 失败，{cancelled} 取消',
  },
  'ps.health.workerOnline': {
    en: 'background worker running',
    id: 'proses latar belakang berjalan',
    zh: '后台进程运行中',
  },
  'ps.health.workerIdle': {
    en: 'background worker not running',
    id: 'proses latar belakang tidak berjalan',
    zh: '后台进程未运行',
  },
  'ps.health.workerOffline': {
    en: 'The background worker is not running: waiting jobs ({n}) and schedules do not start',
    id: 'Proses latar belakang tidak berjalan: pekerjaan yang menunggu ({n}) dan jadwal tidak dimulai',
    zh: '后台进程未运行：等待中的任务（{n}）和计划不会启动',
  },
  'ps.health.workerSeen': {
    en: 'Last seen {when}. Start it (etna-worker service, or "worker" in the server manager).',
    id: 'Terakhir terlihat {when}. Jalankan (layanan etna-worker, atau "worker" di pengelola server).',
    zh: '最后一次在 {when}。请启动它（etna-worker 服务，或服务器管理器中的 “worker”）。',
  },
  'ps.health.workerNever': {
    en: 'It has never reported. Start it (etna-worker service, or "worker" in the server manager).',
    id: 'Belum pernah melapor. Jalankan (layanan etna-worker, atau "worker" di pengelola server).',
    zh: '从未报告过。请启动它（etna-worker 服务，或服务器管理器中的 “worker”）。',
  },
  'ps.health.waiting': {
    en: 'Jobs waiting for a turn: {n}',
    id: 'Pekerjaan menunggu giliran: {n}',
    zh: '等待执行的任务：{n}',
  },
  'ps.health.waitingHint': {
    en: 'The worker runs one job per Terminal at a time.',
    id: 'Proses latar belakang menjalankan satu pekerjaan per Terminal sekaligus.',
    zh: '后台进程每个 Terminal 一次只运行一个任务。',
  },
  'ps.health.pipelineFailed': {
    en: 'Last run of "{name}" failed',
    id: 'Jalannya "{name}" yang terakhir gagal',
    zh: '“{name}” 最近一次运行失败',
  },
  'ps.health.scheduleLate': {
    en: '"{name}" should have run already',
    id: '"{name}" seharusnya sudah berjalan',
    zh: '“{name}” 本应已经运行',
  },
  'ps.health.due': { en: 'Due {when}', id: 'Jatuh tempo {when}', zh: '应于 {when}' },
  'ps.health.scheduleStopped': {
    en: 'Schedule of "{name}" was switched off',
    id: 'Jadwal "{name}" dimatikan',
    zh: '“{name}” 的计划已关闭',
  },
  'ps.health.stopped.three_failures': {
    en: 'After three failed runs in a row; fix it and switch the schedule on again.',
    id: 'Setelah tiga kali gagal berturut-turut; perbaiki lalu nyalakan lagi jadwalnya.',
    zh: '连续三次运行失败后关闭；修复后请重新开启计划。',
  },
  'ps.health.syncFailing': {
    en: 'Sync of {object} from {connection} is failing',
    id: 'Sinkronisasi {object} dari {connection} gagal',
    zh: '从 {connection} 同步 {object} 失败',
  },
  'ps.health.syncStopped': {
    en: 'Sync of {object} from {connection} was stopped',
    id: 'Sinkronisasi {object} dari {connection} dihentikan',
    zh: '从 {connection} 同步 {object} 已停止',
  },
  'ps.health.streak': {
    en: '{n} failures in a row',
    id: '{n} kali gagal berturut-turut',
    zh: '连续失败 {n} 次',
  },
  'ps.health.stale': {
    en: '"{name}" has not changed for over a week',
    id: '"{name}" tidak berubah lebih dari seminggu',
    zh: '“{name}” 已超过一周未更新',
  },
  'ps.health.changed': {
    en: 'Last change {when}',
    id: 'Perubahan terakhir {when}',
    zh: '最近更新 {when}',
  },

  // ─── MCP access ────────────────────────────────────────────────────────────
  'ps.mcpAccess.title': {
    en: 'MCP access for AI assistants',
    id: 'Akses MCP untuk asisten AI',
    zh: 'AI 助手的 MCP 访问',
  },
  'ps.mcpAccess.intro': {
    en: 'Let an AI assistant (Claude, Cursor, …) work with this Terminal over MCP, with your own rights: read its pipelines, their runs and its datasets, analyse datasets, check and test-run pipeline ideas. If you allow it, it can also build pipelines: those are drafts, and nothing runs until you review and publish them. Each token is yours and can be revoked at any time.',
    id: 'Izinkan asisten AI (Claude, Cursor, …) bekerja dengan Terminal ini lewat MCP, dengan hak Anda sendiri: membaca pipeline, riwayat jalannya, dan dataset, menganalisis dataset, serta memeriksa dan mencoba ide pipeline. Jika Anda izinkan, ia juga bisa membuat pipeline: semuanya berupa draf, dan tidak ada yang berjalan sampai Anda memeriksa dan memublikasikannya. Setiap token milik Anda dan bisa dicabut kapan saja.',
    zh: '允许 AI 助手（Claude、Cursor 等）通过 MCP 以您本人的权限使用此 Terminal：读取管道、运行记录和数据集，分析数据集，检查并试运行管道方案。若您允许，它还可以构建管道：这些都是草稿，在您审核并发布之前不会运行。每个令牌属于您，可随时撤销。',
  },
  'ps.mcpAccess.endpoint': { en: 'Server URL:', id: 'URL server:', zh: '服务器地址：' },
  'ps.mcpAccess.tools': {
    en: 'Tools: list_pipelines, get_pipeline, list_pipeline_runs, get_pipeline_run, list_datasets, preview_dataset, list_node_types, list_erp_fields, validate_pipeline, test_pipeline, profile_dataset, analyze_dataset, get_terminal_health; with building allowed also create_pipeline, update_pipeline.',
    id: 'Alat: list_pipelines, get_pipeline, list_pipeline_runs, get_pipeline_run, list_datasets, preview_dataset, list_node_types, list_erp_fields, validate_pipeline, test_pipeline, profile_dataset, analyze_dataset, get_terminal_health; bila membuat pipeline diizinkan, juga create_pipeline, update_pipeline.',
    zh: '工具：list_pipelines、get_pipeline、list_pipeline_runs、get_pipeline_run、list_datasets、preview_dataset、list_node_types、list_erp_fields、validate_pipeline、test_pipeline、profile_dataset、analyze_dataset、get_terminal_health；允许构建时另有 create_pipeline、update_pipeline。',
  },
  'ps.mcpAccess.new': { en: 'New access token', id: 'Token akses baru', zh: '新建访问令牌' },
  'ps.mcpAccess.none': {
    en: 'No access tokens yet.',
    id: 'Belum ada token akses.',
    zh: '还没有访问令牌。',
  },
  'ps.mcpAccess.name': { en: 'Name', id: 'Nama', zh: '名称' },
  'ps.mcpAccess.namePlaceholder': {
    en: 'e.g. Claude Desktop on my laptop',
    id: 'mis. Claude Desktop di laptop saya',
    zh: '例如：我笔记本上的 Claude Desktop',
  },
  'ps.mcpAccess.validFor': { en: 'Valid for', id: 'Berlaku selama', zh: '有效期' },
  'ps.mcpAccess.days': { en: '{n} days', id: '{n} hari', zh: '{n} 天' },
  'ps.mcpAccess.rights': {
    en: 'The assistant sees what you see in this Terminal: masked columns stay masked, restricted pipelines stay hidden. Dataset previews are in the data-access log.',
    id: 'Asisten melihat apa yang Anda lihat di Terminal ini: kolom tersamar tetap tersamar, pipeline terbatas tetap tersembunyi. Pratinjau dataset tercatat di log akses data.',
    zh: '助手看到的与您在此 Terminal 中看到的相同：脱敏列保持脱敏，受限管道保持隐藏。数据集预览会记录在数据访问日志中。',
  },
  'ps.mcpAccess.create': { en: 'Create token', id: 'Buat token', zh: '创建令牌' },
  'ps.mcpAccess.createdTitle': { en: 'Token "{name}"', id: 'Token "{name}"', zh: '令牌 “{name}”' },
  'ps.mcpAccess.once': {
    en: 'Copy it now: it is shown only this once. Keep it like a password.',
    id: 'Salin sekarang: token hanya ditampilkan kali ini. Simpan seperti kata sandi.',
    zh: '请立即复制：令牌只显示这一次。请像密码一样保管。',
  },
  'ps.mcpAccess.token': { en: 'Token', id: 'Token', zh: '令牌' },
  'ps.mcpAccess.claudeCode': {
    en: 'Claude Code (terminal)',
    id: 'Claude Code (terminal)',
    zh: 'Claude Code（终端）',
  },
  'ps.mcpAccess.json': {
    en: 'MCP client settings (JSON)',
    id: 'Pengaturan klien MCP (JSON)',
    zh: 'MCP 客户端设置（JSON）',
  },
  'ps.mcpAccess.copy': { en: 'Copy', id: 'Salin', zh: '复制' },
  'ps.mcpAccess.copied': { en: 'Copied', id: 'Disalin', zh: '已复制' },
  'ps.mcpAccess.copyFailed': { en: 'Could not copy', id: 'Tidak bisa menyalin', zh: '无法复制' },
  'ps.mcpAccess.done': { en: 'Done', id: 'Selesai', zh: '完成' },
  'ps.mcpAccess.used': {
    en: 'last used {when} · calls: {n}',
    id: 'terakhir dipakai {when} · panggilan: {n}',
    zh: '最近使用 {when} · {n} 次调用',
  },
  'ps.mcpAccess.neverUsed': { en: 'not used yet', id: 'belum dipakai', zh: '尚未使用' },
  'ps.mcpAccess.expires': { en: 'expires {when}', id: 'berakhir {when}', zh: '{when} 到期' },
  'ps.mcpAccess.revoke': { en: 'Revoke', id: 'Cabut', zh: '撤销' },
  'ps.mcpAccess.revokeConfirm': {
    en: 'Revoke "{name}"? Assistants using it lose access at once.',
    id: 'Cabut "{name}"? Asisten yang memakainya langsung kehilangan akses.',
    zh: '撤销 “{name}”？使用它的助手将立即失去访问权限。',
  },
  'ps.mcpAccess.revoked': { en: 'Token revoked', id: 'Token dicabut', zh: '令牌已撤销' },
  'ps.mcpAccess.ended': {
    en: 'Revoked or expired: {n}',
    id: 'Dicabut atau kedaluwarsa: {n}',
    zh: '已撤销或过期：{n}',
  },
  'ps.mcpAccess.apps': { en: 'Connected apps', id: 'Aplikasi terhubung', zh: '已连接的应用' },
  'ps.mcpAccess.appsHint': {
    en: 'In Claude (Settings → Connectors → Add custom connector) or another MCP client, add {url} and connect: you sign in here and choose this Terminal. No token to copy.',
    id: 'Di Claude (Settings → Connectors → Add custom connector) atau klien MCP lain, tambahkan {url} lalu hubungkan: Anda masuk di sini dan memilih Terminal ini. Tidak perlu menyalin token.',
    zh: '在 Claude（Settings → Connectors → Add custom connector）或其他 MCP 客户端中添加 {url} 并连接：您在此登录并选择此 Terminal，无需复制令牌。',
  },
  'ps.mcpAccess.connected': { en: 'connected {when}', id: 'terhubung {when}', zh: '{when} 连接' },
  'ps.mcpAccess.tokens': {
    en: 'Access tokens (for clients without sign-in)',
    id: 'Token akses (untuk klien tanpa login)',
    zh: '访问令牌（用于无法登录的客户端）',
  },
  'oauth.title': {
    en: 'Connect an app to PrintStream',
    id: 'Hubungkan aplikasi ke PrintStream',
    zh: '将应用连接到 PrintStream',
  },
  'oauth.asks': {
    en: '"{name}" asks to read a PrintStream Terminal for you.',
    id: '"{name}" meminta izin membaca sebuah Terminal PrintStream untuk Anda.',
    zh: '“{name}” 请求代您读取一个 PrintStream Terminal。',
  },
  'oauth.returnsTo': {
    en: 'After you approve, you go back to {host}. Only approve if you started this from there.',
    id: 'Setelah Anda menyetujui, Anda kembali ke {host}. Setujui hanya bila Anda memulainya dari sana.',
    zh: '批准后将返回 {host}。仅当您是从那里发起时才批准。',
  },
  'oauth.canRead': {
    en: "It can read the Terminal's pipelines, their runs and its datasets, analyse datasets and test-run pipeline ideas (a test run writes nothing).",
    id: 'Aplikasi bisa membaca pipeline, riwayat jalannya, dan dataset Terminal itu, menganalisis dataset, dan mencoba ide pipeline (uji coba tidak menulis apa pun).',
    zh: '它可以读取该 Terminal 的管道、运行记录和数据集，分析数据集，并试运行管道方案（试运行不写入任何内容）。',
  },
  'oauth.yourRights': {
    en: 'With your rights: masked columns stay masked, restricted pipelines stay hidden.',
    id: 'Dengan hak Anda: kolom tersamar tetap tersamar, pipeline terbatas tetap tersembunyi.',
    zh: '以您的权限：脱敏列保持脱敏，受限管道保持隐藏。',
  },
  'oauth.cannot': {
    en: 'It cannot publish, run in the background, schedule or delete anything.',
    id: 'Aplikasi tidak bisa memublikasikan, menjalankan di latar belakang, menjadwalkan, atau menghapus apa pun.',
    zh: '它不能发布、在后台运行、设置计划或删除任何内容。',
  },
  'oauth.terminal': { en: 'Terminal', id: 'Terminal', zh: 'Terminal' },
  'oauth.noTerminal': {
    en: 'You have no Terminal where you may view pipelines.',
    id: 'Anda tidak punya Terminal yang pipelinenya boleh Anda lihat.',
    zh: '您没有可查看管道的 Terminal。',
  },
  'oauth.approve': { en: 'Approve', id: 'Setujui', zh: '批准' },
  'oauth.deny': { en: 'Deny', id: 'Tolak', zh: '拒绝' },
  'ps.mcpAccess.canBuild': {
    en: 'Builds pipelines',
    id: 'Membuat pipeline',
    zh: '可构建管道',
  },
  'ps.mcpAccess.allowBuild': {
    en: 'Also let it build pipelines',
    id: 'Izinkan juga membuat pipeline',
    zh: '同时允许构建管道',
  },
  'ps.mcpAccess.allowBuildHint': {
    en: 'It can create pipelines and change the drafts of pipelines you made. Nothing it builds runs until you review and publish it in the editor.',
    id: 'Asisten bisa membuat pipeline dan mengubah draf pipeline buatan Anda. Tidak ada yang dibuatnya berjalan sampai Anda memeriksa dan memublikasikannya di editor.',
    zh: '它可以创建管道，并修改您所建管道的草稿。在您于编辑器中审核并发布之前，它构建的内容不会运行。',
  },
  'oauth.allowBuild': {
    en: 'Also let it build pipelines in this Terminal',
    id: 'Izinkan juga membuat pipeline di Terminal ini',
    zh: '同时允许在此 Terminal 中构建管道',
  },
  'oauth.allowBuildHint': {
    en: 'It can create pipelines and change the drafts of pipelines you made. They stay drafts: nothing runs until you review and publish them.',
    id: 'Aplikasi bisa membuat pipeline dan mengubah draf pipeline buatan Anda. Semuanya tetap draf: tidak ada yang berjalan sampai Anda memeriksa dan memublikasikannya.',
    zh: '它可以创建管道，并修改您所建管道的草稿。它们始终是草稿：在您审核并发布之前不会运行。',
  },
  'wf.mcp.drafted': {
    en: 'Draft by {client}, {when}',
    id: 'Draf oleh {client}, {when}',
    zh: '{client} 的草稿，{when}',
  },
  'wf.mcp.reviewHint': {
    en: 'An AI assistant changed this draft through MCP. Check the steps and test-run it before publishing; only published versions run in the background.',
    id: 'Asisten AI mengubah draf ini lewat MCP. Periksa langkah-langkahnya dan uji coba sebelum memublikasikan; hanya versi terbit yang berjalan di latar belakang.',
    zh: 'AI 助手通过 MCP 修改了此草稿。发布前请检查各步骤并试运行；只有已发布的版本会在后台运行。',
  },
  'oauth.revokeHint': {
    en: 'You can disconnect it any time in Terminal → AI → MCP access.',
    id: 'Anda bisa memutusnya kapan saja di Terminal → AI → Akses MCP.',
    zh: '您可随时在 Terminal → AI → MCP 访问中断开连接。',
  },
  'oauth.err.client': {
    en: 'This sign-in link is not valid: the app is unknown or sends you somewhere it did not register. Start again from the app.',
    id: 'Tautan login ini tidak valid: aplikasinya tidak dikenal atau mengarahkan ke alamat yang tidak didaftarkan. Mulai lagi dari aplikasinya.',
    zh: '此登录链接无效：应用未知，或跳转到未登记的地址。请从应用重新开始。',
  },
  'oauth.err.mfa': {
    en: 'This Terminal needs two-factor sign-in. Turn it on, then try again.',
    id: 'Terminal ini membutuhkan login dua faktor. Aktifkan, lalu coba lagi.',
    zh: '此 Terminal 需要双重验证登录。请开启后重试。',
  },
  'oauth.err.failed': {
    en: 'That did not work. Start again from the app.',
    id: 'Gagal. Mulai lagi dari aplikasinya.',
    zh: '操作失败。请从应用重新开始。',
  },
} satisfies Record<string, Entry>;
