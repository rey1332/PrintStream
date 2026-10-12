import type { Entry } from './types';

// Industry templates and modules per ERP (src/lib/industry.ts).
export const industryMessages = {
  'industry.label': { en: 'Industry', id: 'Industri', zh: '行业' },
  'industry.general': { en: 'General', id: 'Umum', zh: '通用' },
  'industry.quarry': { en: 'Quarry & mining', id: 'Tambang & quarry', zh: '采石与矿业' },
  'industry.trading': {
    en: 'Trading / distribution',
    id: 'Perdagangan / distribusi',
    zh: '贸易/分销',
  },
  'industry.manufacturing': { en: 'Manufacturing', id: 'Manufaktur', zh: '制造业' },
  'industry.general.help': {
    en: 'Sales, purchasing, stock, invoices, accounting and HR.',
    id: 'Penjualan, pembelian, stok, faktur, akuntansi, dan SDM.',
    zh: '销售、采购、库存、发票、会计和人事。',
  },
  'industry.quarry.help': {
    en: 'General, plus weighbridge, production and stockpiles, equipment and fuel. New products start in m³.',
    id: 'Umum, ditambah jembatan timbang, produksi dan stockpile, alat berat dan BBM. Produk baru memakai m³.',
    zh: '通用功能，另加地磅、生产与料堆、设备与燃油。新产品默认以立方米计。',
  },
  'industry.trading.help': {
    en: 'General: purchasing, warehouses, deliveries and invoicing, without production or equipment.',
    id: 'Umum: pembelian, gudang, pengiriman, dan penagihan, tanpa produksi atau alat berat.',
    zh: '通用：采购、仓库、发货和开票，不含生产或设备。',
  },
  'industry.manufacturing.help': {
    en: 'General, plus production (materials into finished goods) and equipment maintenance.',
    id: 'Umum, ditambah produksi (bahan menjadi barang jadi) dan perawatan mesin.',
    zh: '通用功能，另加生产（原料制成成品）和设备维护。',
  },

  'module.weighbridge': { en: 'Weighbridge', id: 'Jembatan timbang', zh: '地磅' },
  'module.production': { en: 'Production', id: 'Produksi', zh: '生产' },
  'module.equipment': { en: 'Equipment & fuel', id: 'Alat berat & BBM', zh: '设备与燃油' },
  'module.weighbridge.help': {
    en: 'Trucks, weigh tickets (gross, tare, net), credit limits and invoicing from tickets.',
    id: 'Truk, tiket timbang (bruto, tara, neto), batas kredit, dan penagihan dari tiket.',
    zh: '车辆、过磅单（毛重、皮重、净重）、信用额度和按过磅单开票。',
  },
  'module.production.help': {
    en: 'Daily production per product and stockpile, with a production report.',
    id: 'Produksi harian per produk dan stockpile, dengan laporan produksi.',
    zh: '按产品和料堆记录每日产量，并提供生产报表。',
  },
  'module.equipment.help': {
    en: 'Machines and vehicles, hour meters, fuel issued, maintenance due.',
    id: 'Alat dan kendaraan, hour meter, BBM yang dikeluarkan, jadwal servis.',
    zh: '机器和车辆、小时表、燃油发放、到期保养。',
  },

  'industry.settings.title': {
    en: 'Industry and modules',
    id: 'Industri dan modul',
    zh: '行业与模块',
  },
  'industry.settings.subtitle': {
    en: 'Choose what this ERP is used for. Modules that are off are hidden; nothing recorded is deleted.',
    id: 'Pilih untuk apa ERP ini dipakai. Modul yang mati disembunyikan; data yang tercatat tidak dihapus.',
    zh: '选择此 ERP 的用途。关闭的模块会被隐藏，已记录的数据不会删除。',
  },
  'industry.settings.modules': { en: 'Modules', id: 'Modul', zh: '模块' },
  'industry.settings.readOnly': {
    en: 'Only the Owner or an Admin can change this.',
    id: 'Hanya Pemilik atau Admin yang dapat mengubah ini.',
    zh: '只有所有者或管理员可以更改。',
  },
  'industry.settings.failed': {
    en: 'The industry and modules could not be saved.',
    id: 'Industri dan modul tidak dapat disimpan.',
    zh: '无法保存行业与模块。',
  },
  'industry.moduleOff': {
    en: 'This module is switched off for this ERP. The Owner or an Admin can switch it on in Settings → Industry and modules.',
    id: 'Modul ini dimatikan untuk ERP ini. Pemilik atau Admin dapat menyalakannya di Pengaturan → Industri dan modul.',
    zh: '此 ERP 已关闭该模块。所有者或管理员可在“设置 → 行业与模块”中开启。',
  },
} satisfies Record<string, Entry>;
