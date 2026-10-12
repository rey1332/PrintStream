'use client';

import React from 'react';
import { CATALOG, getField, type EntityKey, type FieldType } from '@/lib/analytics/catalog';
import {
  columnLabel,
  entityLabel,
  fieldDescription,
  fieldLabel,
  relationLabel,
  typeLabel,
} from '@/lib/analytics/labels';
import type { ColumnLineage } from '@/lib/workflow/types';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';

type T = ReturnType<typeof useI18n>['t'];

function baseName(l: ColumnLineage): string {
  return l.relation ? `${l.relation}.${l.field}` : String(l.field);
}

function defaultName(l: ColumnLineage): string {
  if (l.op === 'count') return 'record_count';
  if (l.op === 'countDistinct') return `distinct_${baseName(l)}`;
  if (l.op) return `${l.op}_${baseName(l)}`;
  return l.bucket ? `${baseName(l)}_${l.bucket}` : baseName(l);
}

function originLabel(l: ColumnLineage, t: T): string {
  if (l.op === 'count') return t('sum.col.record_count');
  const field = l.relation
    ? `${relationLabel(l.relation, t)} · ${fieldLabel(String(l.field), t)}`
    : fieldLabel(String(l.field), t);
  const bucketed = l.bucket
    ? t('sum.bucketed', { field, bucket: t(`sum.bucket.${l.bucket}` as MessageKey) })
    : field;
  return l.op ? t(`sum.op.${l.op}` as MessageKey, { field: bucketed }) : bucketed;
}

export function columnName(name: string, lineage: ColumnLineage | undefined, t: T): string {
  if (name === 'record_count') return t('sum.col.record_count');
  if (!lineage?.field && !lineage?.op) return columnLabel(name, t);
  return name === defaultName(lineage) ? originLabel(lineage, t) : name;
}

export function columnSource(lineage: ColumnLineage | undefined, t: T): string {
  if (!lineage) return '';
  return `${t(`cat.module.${CATALOG[lineage.entity].module}`)} · ${entityLabel(lineage.entity, t)}`;
}

export function columnMeaning(
  lineage: ColumnLineage | undefined,
  t: T,
  repeated?: boolean
): string {
  if (!lineage) return '';
  const parts: string[] = [];
  if (lineage.op === 'count') parts.push(t('sum.meaning.count'));
  else if (lineage.field) {
    const d = fieldDescription(lineage.entity, lineage.field, t);
    if (d) parts.push(d);
    if (lineage.op) parts.push(t('sum.meaning.measure'));
  }
  if (lineage.relation)
    parts.push(t('sum.meaning.related', { relation: relationLabel(lineage.relation, t) }));
  if (repeated) parts.push(t('sum.meaning.repeated'));
  const def = lineage.field ? getField(lineage.entity, lineage.field) : undefined;
  if (def?.currency === 'document') parts.push(t('sum.meaning.documentCurrency'));
  return parts.join(' ');
}

export function ColumnInfoRow({
  name,
  type,
  lineage,
  repeated,
}: {
  name: string;
  type?: FieldType;
  lineage?: ColumnLineage;
  repeated?: boolean;
}) {
  const { t } = useI18n();
  const label = columnName(name, lineage, t);
  const source = columnSource(lineage, t);
  const meaning = columnMeaning(lineage, t, repeated);
  return (
    <li className="py-1 space-y-0.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-foreground" title={name}>
          {label}
        </span>
        <span className="flex-shrink-0 text-[0.6rem]">{type ? typeLabel(type, t) : '—'}</span>
      </div>
      {(source || label !== name) && (
        <p className="text-[0.6rem] truncate" title={`${source} · ${name}`}>
          {source}
          {source && ' · '}
          <code>{name}</code>
        </p>
      )}
      {meaning && <p className="text-[0.6rem] leading-snug">{meaning}</p>}
    </li>
  );
}

export const ENTITY_PAGES: Record<EntityKey, string> = {
  customers: '/erp/customers',
  suppliers: '/erp/suppliers',
  products: '/erp/products',
  salesOrders: '/erp/sales-orders',
  salesOrderItems: '/erp/sales-orders',
  purchaseOrders: '/erp/purchase-orders',
  purchaseOrderItems: '/erp/purchase-orders',
  invoices: '/erp/invoices',
  payments: '/erp/payments',
  transactions: '/erp/cash-flow',
  stockMovements: '/erp/inventory',
  glAccounts: '/erp/accounting',
  journalEntries: '/erp/accounting',
  journalLines: '/erp/accounting',
};
