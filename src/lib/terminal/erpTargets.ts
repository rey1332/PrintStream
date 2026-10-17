// ERP lists an import may add to (Terminal imports, decision R-27): master
// data only. Balances, stock and costs come from the ERP's own documents and
// are never imported. Shared by the import wizard and the worker.

import type { ColumnType } from './tabular';

export type ErpTarget = 'customers' | 'suppliers' | 'products';

export interface ErpTargetField {
  key: string;
  type: ColumnType;
  required?: boolean;
  /** Longest text the ERP screens accept. */
  max?: number;
}

export const ERP_TARGETS: Record<ErpTarget, { table: string; fields: ErpTargetField[] }> = {
  customers: {
    table: 'erp_customers',
    fields: [
      { key: 'name', type: 'text', required: true, max: 200 },
      { key: 'email', type: 'text', max: 200 },
      { key: 'phone', type: 'text', max: 50 },
      { key: 'address', type: 'text', max: 500 },
      { key: 'city', type: 'text', max: 100 },
      { key: 'credit_limit', type: 'decimal' },
    ],
  },
  suppliers: {
    table: 'erp_suppliers',
    fields: [
      { key: 'name', type: 'text', required: true, max: 200 },
      { key: 'email', type: 'text', max: 200 },
      { key: 'phone', type: 'text', max: 50 },
      { key: 'address', type: 'text', max: 500 },
      { key: 'city', type: 'text', max: 100 },
    ],
  },
  products: {
    table: 'erp_products',
    fields: [
      { key: 'name', type: 'text', required: true, max: 200 },
      { key: 'sku', type: 'text', max: 100 },
      { key: 'category', type: 'text', max: 100 },
      { key: 'unit', type: 'text', max: 30 },
      { key: 'purchase_price', type: 'decimal' },
      { key: 'selling_price', type: 'decimal' },
      { key: 'min_stock', type: 'decimal' },
      { key: 'max_stock', type: 'decimal' },
      { key: 'density', type: 'decimal' },
    ],
  },
};

export const isErpTarget = (value: unknown): value is ErpTarget =>
  typeof value === 'string' && Object.hasOwn(ERP_TARGETS, value);
