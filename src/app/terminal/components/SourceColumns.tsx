'use client';

import React from 'react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { RestColumn } from '@/lib/terminal/restSource';
import { COLUMN_TYPES, type ColumnType } from '@/lib/terminal/tabular';

/** The first rows a source gave, as read (at most 12 columns shown). */
export function SamplePreview({
  columns,
  sample,
}: {
  columns: RestColumn[];
  sample: Record<string, unknown>[];
}) {
  if (!sample.length) return null;
  const shown = columns.slice(0, 12);
  return (
    <div className="max-h-48 overflow-auto rounded-lg border border-border">
      <table className="text-[0.7rem]">
        <thead className="text-muted-foreground">
          <tr>
            {shown.map((c) => (
              <th key={c.name} className="px-2 py-1 text-left font-medium whitespace-nowrap">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sample.map((r, i) => (
            <tr key={i} className="border-t border-border">
              {shown.map((c) => (
                <td key={c.name} className="px-2 py-1 max-w-[12rem] truncate text-foreground">
                  {r[c.name] == null ? '' : String(r[c.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A source's columns with the dataset type of each, which the user may change. */
export function ColumnTypesTable({
  columns,
  onType,
}: {
  columns: RestColumn[];
  onType: (index: number, type: ColumnType) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="max-h-56 overflow-auto rounded-lg border border-border">
      <table className="w-full text-[0.72rem]">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">{t('ps.dbs.column')}</th>
            <th className="px-2 py-1 text-left font-medium">{t('ps.dbs.datasetType')}</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c, i) => (
            <tr key={c.name} className="border-t border-border">
              <td className="px-2 py-1 font-mono text-foreground">
                {c.name}
                {c.from === 'schema' && (
                  <span className="ml-1 text-muted-foreground">({t('ps.rest.fromSchema')})</span>
                )}
              </td>
              <td className="px-2 py-1">
                <select
                  className="bg-transparent text-foreground"
                  aria-label={t('ps.dbs.datasetType')}
                  value={c.type}
                  onChange={(e) => onType(i, e.target.value as ColumnType)}
                  style={{ colorScheme: 'light dark' }}
                >
                  {COLUMN_TYPES.map((ty) => (
                    <option key={ty} value={ty}>
                      {t(`ps.type.${ty}` as any)}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
