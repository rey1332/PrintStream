import type { Entry } from './types';

// The Home page: welcome and the person's ERP widgets (20261012000045).
export const homeWidgetMessages = {
  'home.welcome': {
    en: 'Welcome to PrintStream',
    id: 'Selamat datang di PrintStream',
    zh: '欢迎使用 PrintStream',
  },
  'home.welcomeTo': { en: 'Welcome to', id: 'Selamat datang di', zh: '欢迎使用' },
  'home.subtitle': {
    en: 'PrintStream brings your business data and systems together: your ERPs, datasets and connections in one place.',
    id: 'PrintStream menyatukan data dan sistem bisnis Anda: ERP, dataset, dan koneksi di satu tempat.',
    zh: 'PrintStream 将您的业务数据与系统整合在一起：ERP、数据集和连接集中于一处。',
  },
  'home.addWidget': {
    en: 'Add Widget from ERP',
    id: 'Tambah Widget dari ERP',
    zh: '从 ERP 添加小组件',
  },
  'home.addWidgetDesc': {
    en: 'Put a figure or a list from one of your ERPs on this page.',
    id: 'Tampilkan angka atau daftar dari salah satu ERP Anda di halaman ini.',
    zh: '将您某个 ERP 中的数值或列表放到此页面。',
  },
  'home.emptyWorkspace': {
    en: 'Your workspace is ready. Add an ERP widget to get started.',
    id: 'Ruang kerja Anda siap. Tambahkan widget ERP untuk memulai.',
    zh: '您的工作区已就绪。添加一个 ERP 小组件即可开始。',
  },
  'home.widget.erp': { en: 'ERP', id: 'ERP', zh: 'ERP' },
  'home.widget.type': { en: 'Widget', id: 'Widget', zh: '小组件' },
  'home.widget.type.kpi': { en: 'Figure', id: 'Angka', zh: '数值' },
  'home.widget.type.kpi.desc': {
    en: 'One of the ERP’s dashboard figures',
    id: 'Salah satu angka dasbor ERP',
    zh: 'ERP 仪表板中的一个数值',
  },
  'home.widget.type.list': { en: 'List', id: 'Daftar', zh: '列表' },
  'home.widget.type.list.desc': {
    en: 'A few rows of ERP data, as you choose',
    id: 'Beberapa baris data ERP, sesuai pilihan Anda',
    zh: '按您的选择显示几行 ERP 数据',
  },
  'home.widget.metric': { en: 'Figure', id: 'Angka', zh: '数值' },
  'home.widget.data': { en: 'Data', id: 'Data', zh: '数据' },
  'home.widget.pickData': { en: 'Choose data', id: 'Pilih data', zh: '选择数据' },
  'home.widget.nothingToRead': {
    en: 'Your role in this ERP cannot read lists',
    id: 'Peran Anda di ERP ini tidak bisa membaca daftar',
    zh: '您在此 ERP 中的角色无法读取列表',
  },
  'home.widget.columns': {
    en: 'Columns (at most {max})',
    id: 'Kolom (maks. {max})',
    zh: '列（最多 {max} 个）',
  },
  'home.widget.sort': { en: 'Sort by', id: 'Urutkan menurut', zh: '排序依据' },
  'home.widget.noSort': { en: 'No sorting', id: 'Tanpa urutan', zh: '不排序' },
  'home.widget.order': { en: 'Order', id: 'Arah', zh: '顺序' },
  'home.widget.desc': {
    en: 'Largest / newest first',
    id: 'Terbesar / terbaru dulu',
    zh: '从大到小 / 最新优先',
  },
  'home.widget.asc': {
    en: 'Smallest / oldest first',
    id: 'Terkecil / terlama dulu',
    zh: '从小到大 / 最早优先',
  },
  'home.widget.rows': { en: 'Rows', id: 'Baris', zh: '行数' },
  'home.widget.title': { en: 'Title', id: 'Judul', zh: '标题' },
  'home.widget.add': { en: 'Add widget', id: 'Tambah widget', zh: '添加小组件' },
  'home.widget.noErps': {
    en: 'You do not belong to an ERP yet. Create or join one from Add modules.',
    id: 'Anda belum tergabung di ERP. Buat atau gabung lewat Tambah modul.',
    zh: '您尚未加入任何 ERP。请通过“添加模块”创建或加入。',
  },
  'home.widget.noRows': {
    en: 'Nothing to show yet.',
    id: 'Belum ada yang bisa ditampilkan.',
    zh: '暂无内容。',
  },
  'home.widget.unavailable': {
    en: 'This widget cannot be shown: you may no longer have access to this data.',
    id: 'Widget ini tidak dapat ditampilkan: mungkin Anda tidak lagi punya akses ke data ini.',
    zh: '无法显示此小组件：您可能已无权访问这些数据。',
  },
  'home.widget.noAccess': { en: 'ERP not available', id: 'ERP tidak tersedia', zh: 'ERP 不可用' },
  'home.widget.failed': {
    en: 'The widget could not be saved. Try again.',
    id: 'Widget tidak dapat disimpan. Coba lagi.',
    zh: '无法保存小组件，请重试。',
  },
  'home.widget.limit': {
    en: 'At most 24 widgets. Remove one first.',
    id: 'Maksimal 24 widget. Hapus salah satu dulu.',
    zh: '最多 24 个小组件。请先删除一个。',
  },
  'home.widget.moveUp': { en: 'Move up', id: 'Naikkan', zh: '上移' },
  'home.widget.moveDown': { en: 'Move down', id: 'Turunkan', zh: '下移' },
  'home.widget.remove': { en: 'Remove widget', id: 'Hapus widget', zh: '删除小组件' },
  'home.widget.removeConfirm': {
    en: 'Remove “{title}” from Home?',
    id: 'Hapus “{title}” dari Beranda?',
    zh: '从首页删除“{title}”？',
  },
} satisfies Record<string, Entry>;
