import type { Entry } from './types';

// A TERMINAL on its own linked to ERPs; pipeline nodes that read or add to them.
export const terminalErpLinkMessages = {
  'terminal.erps': { en: 'Linked ERPs', id: 'ERP terhubung', zh: '已关联的 ERP' },
  'terminal.erpsIntro': {
    en: 'Pipelines of this TERMINAL may read these ERPs and add to their customers, suppliers and products, always with the rights of the person running them. Linking needs managing this TERMINAL’s connections and being the ERP’s Owner or an Admin, both with two-factor.',
    id: 'Pipeline TERMINAL ini boleh membaca ERP berikut dan menambah pelanggan, pemasok, dan produknya, selalu dengan hak akses orang yang menjalankannya. Menghubungkan perlu hak mengelola koneksi TERMINAL ini dan menjadi Pemilik atau Admin ERP itu, keduanya dengan verifikasi dua langkah.',
    zh: '此 TERMINAL 的管道可读取这些 ERP，并向其客户、供应商和产品添加数据，始终使用运行者本人的权限。关联需要能管理此 TERMINAL 的连接，并且是该 ERP 的所有者或管理员，均需双重验证。',
  },
  'terminal.erpsNone': {
    en: 'Not linked to any ERP. Pipelines work with datasets and connections only.',
    id: 'Belum terhubung ke ERP mana pun. Pipeline hanya memakai dataset dan koneksi.',
    zh: '尚未关联任何 ERP。管道仅使用数据集和连接。',
  },
  'terminal.erpsNotMember': {
    en: 'you are not a member: runs by you cannot read it',
    id: 'Anda bukan anggota: proses oleh Anda tidak bisa membacanya',
    zh: '您不是成员：您运行时无法读取',
  },
  'terminal.erpsPick': {
    en: 'Choose an ERP you manage',
    id: 'Pilih ERP yang Anda kelola',
    zh: '选择您管理的 ERP',
  },
  'terminal.erpsNoneToLink': {
    en: 'No other ERP where you are Owner or Admin',
    id: 'Tidak ada ERP lain tempat Anda Pemilik atau Admin',
    zh: '没有其他您担任所有者或管理员的 ERP',
  },
  'terminal.erpsLink': { en: 'Link', id: 'Hubungkan', zh: '关联' },
  'terminal.erpsRemove': { en: 'Unlink', id: 'Putuskan', zh: '取消关联' },
  'terminal.erpsRemoveConfirm': {
    en: 'Unlink “{name}”? Pipelines that read or add to it will stop working until changed.',
    id: 'Putuskan “{name}”? Pipeline yang membaca atau menambah ke ERP itu akan berhenti bekerja sampai diubah.',
    zh: '取消关联“{name}”？读取或写入它的管道将停止工作，直到修改。',
  },
  'ps.err.not_terminal': {
    en: 'Only a TERMINAL on its own is linked to ERPs.',
    id: 'Hanya TERMINAL tersendiri yang bisa dihubungkan ke ERP.',
    zh: '只有独立的 TERMINAL 可以关联 ERP。',
  },

  'wf.field.erpId': { en: 'ERP', id: 'ERP', zh: 'ERP' },
  'wf.erp.own': { en: 'This workspace', id: 'Workspace ini', zh: '本工作区' },
  'wf.erp.unlinked': {
    en: '(no longer linked)',
    id: '(sudah tidak terhubung)',
    zh: '（已取消关联）',
  },
  'wf.erp.notMember': {
    en: 'You are not a member of this ERP: your runs cannot read it.',
    id: 'Anda bukan anggota ERP ini: proses Anda tidak bisa membacanya.',
    zh: '您不是此 ERP 的成员：您运行时无法读取。',
  },
  'wf.erp.noLinks': {
    en: 'Link ERPs from the TERMINAL screen (Linked ERPs) to read them here.',
    id: 'Hubungkan ERP dari layar TERMINAL (ERP terhubung) untuk membacanya di sini.',
    zh: '请在 TERMINAL 页面（已关联的 ERP）中关联 ERP 后在此读取。',
  },
  'wf.node.out.erpList': {
    en: 'Add to ERP list',
    id: 'Tambah ke daftar ERP',
    zh: '添加到 ERP 列表',
  },
  'wf.desc.out.erpList': {
    en: 'Add the rows to an ERP’s customers, suppliers or products (background runs only)',
    id: 'Tambahkan baris ke pelanggan, pemasok, atau produk ERP (hanya saat dijalankan di latar belakang)',
    zh: '将行添加到 ERP 的客户、供应商或产品（仅后台运行）',
  },
  'wf.field.list': { en: 'List', id: 'Daftar', zh: '列表' },
  'wf.field.erpMode': {
    en: 'Rows already in the list',
    id: 'Baris yang sudah ada',
    zh: '列表中已有的行',
  },
  'wf.opt.customers': { en: 'customers', id: 'pelanggan', zh: '客户' },
  'wf.opt.suppliers': { en: 'suppliers', id: 'pemasok', zh: '供应商' },
  'wf.opt.products': { en: 'products', id: 'produk', zh: '产品' },
  'wf.opt.add_new': {
    en: 'skip them (add new ones only)',
    id: 'lewati (hanya tambah yang baru)',
    zh: '跳过（仅添加新行）',
  },
  'wf.opt.add_or_update': { en: 'update them', id: 'perbarui', zh: '更新' },
  'wf.hint.out.erpList.list': {
    en: 'Columns are matched to the list’s fields by name: name (required), email, phone, address, city, credit_limit; for products sku, category, unit, purchase_price, selling_price, min_stock, max_stock, density. A row is already in the list when its name (products: SKU) is.',
    id: 'Kolom dicocokkan ke field daftar berdasarkan nama: name (wajib), email, phone, address, city, credit_limit; untuk produk sku, category, unit, purchase_price, selling_price, min_stock, max_stock, density. Baris dianggap sudah ada jika namanya (produk: SKU) sudah ada.',
    zh: '列按名称对应列表字段：name（必填）、email、phone、address、city、credit_limit；产品另有 sku、category、unit、purchase_price、selling_price、min_stock、max_stock、density。名称（产品为 SKU）相同即视为已存在。',
  },
  'wf.err.erpNotLinked': {
    en: 'This TERMINAL is not linked to that ERP (TERMINAL → Linked ERPs).',
    id: 'TERMINAL ini tidak terhubung ke ERP tersebut (TERMINAL → ERP terhubung).',
    zh: '此 TERMINAL 未关联该 ERP（TERMINAL → 已关联的 ERP）。',
  },
  'wf.err.erpNameColumn': {
    en: 'The rows need a “name” column to be added to an ERP list.',
    id: 'Baris perlu kolom “name” untuk ditambahkan ke daftar ERP.',
    zh: '添加到 ERP 列表的行需要 “name” 列。',
  },
  'wf.err.erpTooMany': {
    en: 'At most {max} rows are added to an ERP list in one run.',
    id: 'Paling banyak {max} baris ditambahkan ke daftar ERP dalam satu proses.',
    zh: '每次运行最多向 ERP 列表添加 {max} 行。',
  },
  'wf.err.erpForbidden': {
    en: 'You are not allowed to change this list in that ERP.',
    id: 'Anda tidak diizinkan mengubah daftar ini di ERP tersebut.',
    zh: '您无权在该 ERP 中修改此列表。',
  },
  'wf.warn.wouldWriteErp': {
    en: '{rows} rows would be added to the ERP list when the pipeline runs in the background.',
    id: '{rows} baris akan ditambahkan ke daftar ERP saat pipeline dijalankan di latar belakang.',
    zh: '管道在后台运行时将向 ERP 列表添加 {rows} 行。',
  },
  'wf.warn.writtenErp': {
    en: 'ERP list: {added} added, {updated} updated, {skipped} already there, {rejected} refused.',
    id: 'Daftar ERP: {added} ditambahkan, {updated} diperbarui, {skipped} sudah ada, {rejected} ditolak.',
    zh: 'ERP 列表：新增 {added}，更新 {updated}，已存在 {skipped}，拒绝 {rejected}。',
  },
} satisfies Record<string, Entry>;
