// An ERP's lists as the Query Tool's tables (db/migrations/20261025084448_terminal_query_erp.sql):
// the analytics catalog's entities (src/lib/analytics/catalog.ts) under
// snake_case names (salesOrders → sales_orders), with the catalog's fields
// only, so what a query can name is what the ERP's reports may show.

import { CATALOG, ENTITY_KEYS, type EntityKey, type FieldType } from '@/lib/analytics/catalog';

/** The table name of an entity in a query. */
export const erpTableName = (key: EntityKey) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The Query Tool's column types (as a dataset's, src/server/terminal/sqlSandboxThread.mjs). */
const TYPES: Record<FieldType, string> = {
  id: 'uuid',
  text: 'text',
  integer: 'integer',
  number: 'decimal',
  money: 'decimal',
  date: 'date',
  datetime: 'timestamp',
  enum: 'text',
  boolean: 'boolean',
};

export interface ErpTable {
  entity: EntityKey;
  name: string;
  columns: { name: string; type: string }[];
}

export const erpTable = (entity: EntityKey): ErpTable => ({
  entity,
  name: erpTableName(entity),
  columns: CATALOG[entity].fields.map((f) => ({ name: f.key, type: TYPES[f.type] })),
});

export const ERP_TABLES: readonly ErpTable[] = ENTITY_KEYS.map(erpTable);

/** The target id of an ERP in the connection selector. */
export const ERP_TARGET_PREFIX = 'erp:';
export const erpTargetId = (erpId: string) => `${ERP_TARGET_PREFIX}${erpId}`;
export const erpOfTarget = (target: string) =>
  target.startsWith(ERP_TARGET_PREFIX) ? target.slice(ERP_TARGET_PREFIX.length) : null;
