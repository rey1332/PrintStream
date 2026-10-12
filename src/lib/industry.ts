import type { MessageKey } from '@/lib/i18n/messages';
import type { UnitCode } from '@/lib/units';

// Industry templates and optional modules per ERP
// (db/migrations/20261012000023_erp_industry_modules.sql).

export const INDUSTRIES = ['general', 'quarry', 'trading', 'manufacturing'] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const MODULES = ['weighbridge', 'production', 'equipment'] as const;
export type ModuleCode = (typeof MODULES)[number];

/** The modules an industry starts with (as erp__industry_modules). */
export const INDUSTRY_MODULES: Record<Industry, readonly ModuleCode[]> = {
  general: [],
  quarry: ['weighbridge', 'production', 'equipment'],
  trading: [],
  manufacturing: ['production', 'equipment'],
};

/** Unit a new product starts with. */
export const INDUSTRY_DEFAULT_UNIT: Record<Industry, UnitCode> = {
  general: 'pcs',
  quarry: 'm3',
  trading: 'pcs',
  manufacturing: 'pcs',
};

export const INDUSTRY_LABEL: Record<Industry, MessageKey> = {
  general: 'industry.general',
  quarry: 'industry.quarry',
  trading: 'industry.trading',
  manufacturing: 'industry.manufacturing',
};

export const INDUSTRY_HELP: Record<Industry, MessageKey> = {
  general: 'industry.general.help',
  quarry: 'industry.quarry.help',
  trading: 'industry.trading.help',
  manufacturing: 'industry.manufacturing.help',
};

export const MODULE_LABEL: Record<ModuleCode, MessageKey> = {
  weighbridge: 'module.weighbridge',
  production: 'module.production',
  equipment: 'module.equipment',
};

export const MODULE_HELP: Record<ModuleCode, MessageKey> = {
  weighbridge: 'module.weighbridge.help',
  production: 'module.production.help',
  equipment: 'module.equipment.help',
};

export function isIndustry(value: unknown): value is Industry {
  return typeof value === 'string' && (INDUSTRIES as readonly string[]).includes(value);
}

export function isModule(value: unknown): value is ModuleCode {
  return typeof value === 'string' && (MODULES as readonly string[]).includes(value);
}

export function parseModules(value: unknown): ModuleCode[] {
  return Array.isArray(value) ? value.filter(isModule) : [];
}
