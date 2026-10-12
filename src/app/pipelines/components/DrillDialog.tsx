'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Loader2, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { entityLabel, fieldLabel, typeLabel } from '@/lib/analytics/labels';
import { isNumericType } from '@/lib/analytics/catalog';
import { drillSummary, type DrillPage } from '@/lib/workflow/storage';
import { ENTITY_PAGES } from './columnInfo';

interface Props {
  workflowId: string;
  nodeId: string;
  target: { target: 'draft' | 'published' | 'version'; versionId?: string };
  group: Record<string, unknown>;
  title: string;
  expected: number | null;
  onClose: () => void;
}

export default function DrillDialog({
  workflowId,
  nodeId,
  target,
  group,
  title,
  expected,
  onClose,
}: Props) {
  const { t, fmt } = useI18n();
  const [pages, setPages] = useState<DrillPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError('');
      try {
        const page = await drillSummary(workflowId, nodeId, group, offset, target);
        setPages((p) => (offset === 0 ? [page] : [...p, page]));
      } catch (e) {
        setError(e instanceof Error ? e.message : t('sum.drill.unavailable'));
      } finally {
        setLoading(false);
      }
    },
    [workflowId, nodeId, group, target, t]
  );

  useEffect(() => {
    void load(0);
  }, [load]);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const first = pages[0];
  const last = pages[pages.length - 1];
  const rows = pages.flatMap((p) => p.rows);
  const cell = (v: unknown, type: string) =>
    v === null || v === undefined || v === ''
      ? '—'
      : isNumericType(type as any)
        ? fmt.number(Number(v), { maximumFractionDigits: 2 })
        : String(v);

  return (
    <div
      className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="drill-title"
        className="flex max-h-[85vh] w-full max-w-5xl flex-col rounded-lg border border-border bg-card shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p id="drill-title" className="text-[0.8rem] font-semibold text-foreground">
              {t('sum.drill.title')}
            </p>
            <p className="truncate text-[0.68rem] text-muted-foreground" title={title}>
              {title}
            </p>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11"
            aria-label={t('wf.close')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-[var(--surface-2)] px-4 py-2 text-[0.66rem] text-muted-foreground">
          {first && <span>{entityLabel(first.entity, t)}</span>}
          <span>
            {t('sum.drill.shown', {
              shown: fmt.number(rows.length),
              total: expected == null ? '—' : fmt.number(expected),
            })}
          </span>
          {first && (
            <span>{t('cat.notice.fetchedAt', { time: fmt.dateTime(first.fetchedAt) })}</span>
          )}
          {first && (
            <Link
              href={ENTITY_PAGES[first.entity]}
              className="ml-auto inline-flex items-center gap-1 text-foreground underline underline-offset-2"
            >
              {t('sum.drill.openModule', { entity: entityLabel(first.entity, t) })}{' '}
              <ExternalLink size={11} />
            </Link>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <p className="p-4 text-[0.72rem] text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : first ? (
            <table className="w-full text-[0.68rem]">
              <thead className="sticky top-0 bg-[var(--surface-3)]">
                <tr>
                  {first.columns.map((c) => (
                    <th
                      key={c.name}
                      className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-muted-foreground"
                      title={`${c.name} · ${typeLabel(c.type, t)}`}
                    >
                      {fieldLabel(c.name, t)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={String(r.id ?? i)} className="border-t border-border">
                    {first.columns.map((c) => (
                      <td
                        key={c.name}
                        className={`max-w-[220px] truncate px-2 py-1 text-foreground ${isNumericType(c.type) ? 'text-right tabular-nums' : ''}`}
                        title={String(r[c.name] ?? '')}
                      >
                        {cell(r[c.name], c.type)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {!loading && !error && first && rows.length === 0 && (
            <p className="p-4 text-center text-[0.72rem] text-muted-foreground">
              {t('sum.drill.none')}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2">
          <p className="text-[0.62rem] text-muted-foreground">{t('sum.drill.note')}</p>
          {loading ? (
            <Loader2 size={14} className="animate-spin text-muted-foreground" />
          ) : last?.hasMore ? (
            <button
              onClick={() => load(last.offset + last.rows.length)}
              className="rounded-md border border-border px-3 py-1.5 text-[0.72rem] text-foreground hover:bg-[var(--surface-3)]"
            >
              {t('sum.drill.more')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
