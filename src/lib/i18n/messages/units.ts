import type { Entry } from './types';

// Units of measure (src/lib/units.ts) and the quantity fields that use them.
export const unitMessages = {
  'unit.m3': { en: 'm³', id: 'm³', zh: '立方米' },
  'unit.l': { en: 'liter', id: 'liter', zh: '升' },
  'unit.ton': { en: 'ton', id: 'ton', zh: '吨' },
  'unit.kg': { en: 'kg', id: 'kg', zh: '千克' },
  'unit.rit': { en: 'truckload', id: 'rit', zh: '车次' },
  'unit.pcs': { en: 'pcs', id: 'pcs', zh: '件' },
  'unit.hour': { en: 'hour', id: 'jam', zh: '小时' },
  'unit.day': { en: 'day', id: 'hari', zh: '天' },
  'unit.label': { en: 'Unit', id: 'Satuan', zh: '单位' },
  'unit.density': {
    en: 'Density (ton per m³)',
    id: 'Densitas (ton per m³)',
    zh: '密度（吨/立方米）',
  },
  'unit.densityHelp': {
    en: 'Optional. Lets quantities in tons be converted to m³ and back (e.g. split stone ≈ 1.5).',
    id: 'Opsional. Agar jumlah dalam ton bisa dikonversi ke m³ dan sebaliknya (mis. batu split ≈ 1,5).',
    zh: '可选。用于吨与立方米之间的换算（例如碎石约 1.5）。',
  },
  'unit.converted': {
    en: '= {qty} {unit}',
    id: '= {qty} {unit}',
    zh: '= {qty} {unit}',
  },
  'unit.noConversion': {
    en: 'Cannot convert to {unit}: set the product’s density first.',
    id: 'Tidak dapat dikonversi ke {unit}: isi densitas produk terlebih dahulu.',
    zh: '无法换算为{unit}：请先设置产品密度。',
  },
} satisfies Record<string, Entry>;
