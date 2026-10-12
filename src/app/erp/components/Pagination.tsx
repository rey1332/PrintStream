'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';

export const DEFAULT_PAGE_SIZE = 50;

export function usePaged<T>(items: T[], pageSize = DEFAULT_PAGE_SIZE) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  useEffect(() => setPage(0), [items.length]);
  const current = Math.min(page, pageCount - 1);
  const pageItems = useMemo(
    () => items.slice(current * pageSize, (current + 1) * pageSize),
    [items, current, pageSize]
  );
  return {
    items: pageItems,
    offset: current * pageSize,
    props: { page: current, pageCount, total: items.length, pageSize, onPage: setPage },
  };
}

export function useServerPage<T extends { id?: string }>(
  fetchPage: (q: {
    offset: number;
    limit: number;
    search: string;
    onlyId: string | null;
  }) => Promise<{ rows: T[]; total: number }>,
  deps: unknown[],
  pageSize = DEFAULT_PAGE_SIZE,
  opts: { focus?: boolean } = {}
) {
  const focusable = opts.focus ?? true;
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [token, setToken] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    if (!focusable) return;
    try {
      setFocusId(new URLSearchParams(window.location.search).get('focus'));
    } catch {
      setFocusId(null);
    }
  }, [focusable]);

  // A new filter starts at the first page.
  const depsKey = JSON.stringify(deps);
  useEffect(() => setPage(0), [depsKey]);

  // Search after typing stops; a new search starts at the first page.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setPage(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPage({ offset: page * pageSize, limit: pageSize, search: query, onlyId: focusId })
      .then((result) => {
        if (cancelled) return;
        // A page past the end (rows were removed): go back to the last one.
        if (result.rows.length === 0 && page > 0 && result.total > 0) {
          setPage(Math.max(0, Math.ceil(result.total / pageSize) - 1));
          return;
        }
        setRows(result.rows);
        setTotal(result.total);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchPage is rebuilt every render; deps say when it changes
  }, [page, query, focusId, token, pageSize, ...deps]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return {
    items: rows,
    total,
    loading,
    error,
    search,
    setSearch,
    reload: () => setToken((n) => n + 1),
    focusId,
    showAll: () => {
      setFocusId(null);
      setPage(0);
    },
    focusAttrs: (id: string | undefined) =>
      id && id === focusId
        ? { 'data-record-id': id, 'data-focused': 'true' as const }
        : { 'data-record-id': id },
    offset: page * pageSize,
    props: { page, pageCount, total, pageSize, onPage: setPage },
  };
}

interface PaginationProps {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}

export function Pagination({ page, pageCount, total, pageSize, onPage }: PaginationProps) {
  const { t, fmt } = useI18n();
  if (total <= pageSize) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  const btn =
    'inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border text-[0.72rem] text-foreground hover:bg-[var(--surface-3)] disabled:opacity-40 disabled:cursor-not-allowed';
  return (
    <nav
      className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-border"
      aria-label={t('common.pagination')}
    >
      <p className="text-[0.72rem] text-muted-foreground" aria-live="polite">
        {t('common.showingRange', {
          from: fmt.number(from),
          to: fmt.number(to),
          total: fmt.number(total),
        })}
      </p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={btn}
          onClick={() => onPage(page - 1)}
          disabled={page === 0}
          aria-label={t('common.previousPage')}
        >
          <ChevronLeft size={12} />
        </button>
        <span className="text-[0.72rem] text-muted-foreground tabular-nums">
          {t('common.pageOf', { page: fmt.number(page + 1), count: fmt.number(pageCount) })}
        </span>
        <button
          type="button"
          className={btn}
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount - 1}
          aria-label={t('common.nextPage')}
        >
          <ChevronRight size={12} />
        </button>
      </div>
    </nav>
  );
}
