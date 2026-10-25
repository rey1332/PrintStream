'use client';

// Data Output: a query's rows in a grid. Only the rows in view are drawn
// (fixed row height), so thousands of rows scroll smoothly. Cells, rows and
// columns can be selected (click, Shift+click, arrows) and copied as
// tab-separated text (Ctrl+C), as spreadsheets paste it. NULL is shown as
// [null], apart from an empty text. The rows can be searched and sorted by a
// column (in the browser, on the rows the run kept); a cell's whole value
// opens on double-click or Enter, JSON laid out.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Copy, Search, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { toTsv } from '@/lib/terminal/sqlText';

const ROW_H = 24;
const HEAD_H = 40;
const NUM_W = 52;
const OVERSCAN = 12;

interface Range {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}
const norm = (s: Range) => ({
  top: Math.min(s.r1, s.r2),
  bottom: Math.max(s.r1, s.r2),
  left: Math.min(s.c1, s.c2),
  right: Math.max(s.c1, s.c2),
});

const display = (v: unknown) => (typeof v === 'string' ? v : String(v));
const NUMERIC = /^(smallint|integer|bigint|numeric|real|double precision|decimal|money)/;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Ascending order of two cells; NULL last either way (the caller flips the rest). */
function compare(a: unknown, b: unknown, numeric: boolean): number {
  if (numeric) {
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  }
  return collator.compare(display(a), display(b));
}

/** JSON laid out when the value is an object or array as text; otherwise the value. */
function pretty(v: unknown): { text: string; json: boolean } {
  const s = display(v);
  if (/^\s*[[{]/.test(s)) {
    try {
      return { text: JSON.stringify(JSON.parse(s), null, 2), json: true };
    } catch {
      // Not JSON after all: shown as it is.
    }
  }
  return { text: s, json: false };
}

type Sort = { col: number; dir: 'asc' | 'desc' } | null;

export function ResultGrid({
  columns,
  rows,
  onCopied,
}: {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  onCopied: (cells: number) => void;
}) {
  const { t, fmt } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);
  const [sel, setSel] = useState<Range | null>(null);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>(null);
  const [cell, setCell] = useState<{ r: number; c: number } | null>(null);

  // Widths from the header and the first rows; dragged wider or narrower.
  const initialWidths = useMemo(
    () =>
      columns.map((c, i) => {
        let chars = Math.max(c.name.length + 2, c.type.length);
        for (const r of rows.slice(0, 50))
          chars = Math.max(chars, r[i] === null ? 6 : Math.min(display(r[i]).length, 60));
        return Math.min(420, Math.max(72, chars * 7.4 + 22));
      }),
    [columns, rows]
  );
  const [widths, setWidths] = useState(initialWidths);
  useEffect(() => setWidths(initialWidths), [initialWidths]);
  useEffect(() => {
    setFilter('');
    setSort(null);
    setCell(null);
  }, [rows]);

  // The rows shown: those with the search text in a cell, in the chosen order.
  const view = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let out = needle
      ? rows.filter((r) =>
          r.some((v) => v !== null && v !== undefined && display(v).toLowerCase().includes(needle))
        )
      : rows;
    if (sort) {
      const numeric = NUMERIC.test(columns[sort.col]?.type ?? '');
      const flip = sort.dir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => {
        const x = a[sort.col];
        const y = b[sort.col];
        const xn = x === null || x === undefined;
        const yn = y === null || y === undefined;
        if (xn || yn) return xn === yn ? 0 : xn ? 1 : -1;
        return flip * compare(x, y, numeric);
      });
    }
    return out;
  }, [rows, columns, filter, sort]);
  useEffect(() => setSel(null), [view]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(view.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const total = NUM_W + widths.reduce((a, b) => a + b, 0);

  const copy = useCallback(async () => {
    if (!sel) return;
    const s = norm(sel);
    const picked = view.slice(s.top, s.bottom + 1).map((r) => r.slice(s.left, s.right + 1));
    // Whole rows: with the column names, as pgAdmin's "copy with headers".
    const whole = s.left === 0 && s.right === columns.length - 1;
    const text = toTsv(whole ? columns.map((c) => c.name) : null, picked);
    try {
      await navigator.clipboard.writeText(text);
      onCopied(picked.length * (s.right - s.left + 1));
    } catch {
      // The browser refused the clipboard: nothing copied, nothing said copied.
    }
  }, [sel, view, columns, onCopied]);

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      void copy();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (view.length && columns.length)
        setSel({ r1: 0, c1: 0, r2: view.length - 1, c2: columns.length - 1 });
      return;
    }
    if (!sel) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      setCell({ r: sel.r2, c: sel.c2 });
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    const r = Math.min(view.length - 1, Math.max(0, sel.r2 + m[0]));
    const c = Math.min(columns.length - 1, Math.max(0, sel.c2 + m[1]));
    setSel(e.shiftKey ? { ...sel, r2: r, c2: c } : { r1: r, c1: c, r2: r, c2: c });
    const el = box.current;
    if (el) {
      const y = r * ROW_H;
      if (y < el.scrollTop) el.scrollTop = y;
      else if (y + ROW_H > el.scrollTop + el.clientHeight - HEAD_H)
        el.scrollTop = y + ROW_H - el.clientHeight + HEAD_H;
    }
  };

  const pick = (e: React.MouseEvent, r: number, c: number, r2 = r, c2 = c) => {
    setSel(e.shiftKey && sel ? { ...sel, r2, c2 } : { r1: r, c1: c, r2, c2 });
    box.current?.focus();
  };

  const resize = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths[i];
    const move = (ev: PointerEvent) =>
      setWidths((ws) => ws.map((w, k) => (k === i ? Math.max(48, w0 + ev.clientX - x0) : w)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Ascending, descending, then the run's own order.
  const cycleSort = (col: number) =>
    setSort((s) =>
      !s || s.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null
    );

  const s = sel ? norm(sel) : null;
  const inSel = (r: number, c: number) =>
    !!s && r >= s.top && r <= s.bottom && c >= s.left && c <= s.right;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[28px] shrink-0 items-center gap-2 border-b border-[var(--wb-border)] bg-[var(--wb-toolbar)] px-2">
        <Search size={12} aria-hidden className="shrink-0 text-[var(--wb-text-2)]" />
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('ps.qt.gridFilter')}
          aria-label={t('ps.qt.gridFilter')}
          className="h-[20px] min-w-0 max-w-[260px] flex-1 rounded-[2px] border border-[var(--wb-border)] bg-[var(--wb-editor)] px-1.5 text-[12px] text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-muted)] focus:border-[var(--wb-accent)]"
        />
        {(filter.trim() || sort) && (
          <span className="truncate text-[11px] text-[var(--wb-text-2)]">
            {filter.trim() &&
              t('ps.qt.gridShown', { n: fmt.number(view.length), total: fmt.number(rows.length) })}
            {sort &&
              `${filter.trim() ? ' · ' : ''}${t(sort.dir === 'asc' ? 'ps.qt.gridSortedAsc' : 'ps.qt.gridSortedDesc', { col: columns[sort.col]?.name ?? '' })}`}
          </span>
        )}
        {sort && (
          <button
            type="button"
            onClick={() => setSort(null)}
            className="shrink-0 text-[11px] text-[var(--wb-accent)] hover:underline"
          >
            {t('ps.qt.gridUnsort')}
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={box}
          tabIndex={0}
          role="grid"
          aria-rowcount={view.length}
          aria-colcount={columns.length}
          aria-label={t('ps.qt.dataOutput')}
          onKeyDown={onKey}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          className="relative h-full overflow-auto outline-none text-[12px] font-mono text-[var(--wb-text)] bg-[var(--wb-editor)]"
        >
          <div style={{ width: total, height: HEAD_H + view.length * ROW_H }} className="relative">
            {/* Header */}
            <div
              className="sticky top-0 z-10 flex bg-[var(--wb-toolbar)] border-b border-[var(--wb-border)]"
              style={{ height: HEAD_H, width: total }}
              role="row"
            >
              <div
                className="sticky left-0 z-10 shrink-0 bg-[var(--wb-toolbar)] border-r border-[var(--wb-border)]"
                style={{ width: NUM_W }}
                role="columnheader"
                aria-label={t('ps.qt.rowNumber')}
                onClick={(e) =>
                  view.length &&
                  columns.length &&
                  pick(e, 0, 0, view.length - 1, columns.length - 1)
                }
              />
              {columns.map((c, i) => {
                const sorted = sort?.col === i ? sort.dir : null;
                const SortIcon =
                  sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown;
                return (
                  <div
                    key={i}
                    role="columnheader"
                    aria-sort={
                      sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
                    }
                    className="group/h relative shrink-0 cursor-pointer select-none border-r border-[var(--wb-border)] py-1 pl-2 pr-5"
                    style={{ width: widths[i] }}
                    onClick={(e) => view.length && pick(e, 0, i, view.length - 1, i)}
                    title={`${c.name} (${c.type})`}
                  >
                    <div className="truncate font-sans font-semibold text-[12px]">{c.name}</div>
                    <div className="truncate font-sans text-[11px] text-[var(--wb-muted)]">
                      {c.type}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        cycleSort(i);
                      }}
                      aria-label={t('ps.qt.gridSort', { col: c.name })}
                      title={t('ps.qt.gridSort', { col: c.name })}
                      className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-[2px] p-0.5 hover:bg-[var(--wb-hover)] ${
                        sorted
                          ? 'text-[var(--wb-accent)]'
                          : 'text-[var(--wb-muted)] opacity-0 group-hover/h:opacity-100 focus-visible:opacity-100'
                      }`}
                    >
                      <SortIcon size={12} />
                    </button>
                    <span
                      aria-hidden
                      onPointerDown={resize(i)}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--wb-accent)]"
                    />
                  </div>
                );
              })}
            </div>
            {/* Rows in view */}
            {view.slice(first, last).map((row, k) => {
              const r = first + k;
              return (
                <div
                  key={r}
                  role="row"
                  aria-rowindex={r + 2}
                  className="absolute left-0 flex border-b border-[var(--wb-border)]/50"
                  style={{ top: HEAD_H + r * ROW_H, height: ROW_H, width: total }}
                >
                  <div
                    className="sticky left-0 shrink-0 px-2 text-right text-[11px] leading-[24px] text-[var(--wb-muted)] bg-[var(--wb-toolbar)] border-r border-[var(--wb-border)] cursor-pointer select-none"
                    style={{ width: NUM_W }}
                    onClick={(e) => pick(e, r, 0, r, columns.length - 1)}
                  >
                    {r + 1}
                  </div>
                  {row.map((v, c) => {
                    const nil = v === null || v === undefined;
                    const text = nil ? '' : display(v);
                    return (
                      <div
                        key={c}
                        role="gridcell"
                        aria-selected={inSel(r, c)}
                        onMouseDown={(e) => pick(e, r, c)}
                        onDoubleClick={() => {
                          // The browser's own word selection is not the grid's.
                          window.getSelection()?.removeAllRanges();
                          setCell({ r, c });
                        }}
                        title={nil ? 'NULL' : text.length > 40 ? text.slice(0, 2000) : undefined}
                        className={`shrink-0 px-2 leading-[24px] truncate border-r border-[var(--wb-border)]/50 ${
                          NUMERIC.test(columns[c]?.type ?? '') ? 'text-right tabular-nums' : ''
                        } ${inSel(r, c) ? 'bg-[var(--wb-selection)]' : ''}`}
                        style={{ width: widths[c] }}
                      >
                        {nil ? <span className="italic text-[var(--wb-null)]">[null]</span> : text}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        {view.length === 0 && rows.length > 0 && (
          <p className="absolute left-2 top-[48px] text-[11px] text-[var(--wb-muted)]">
            {t('ps.qt.gridNoMatch')}
          </p>
        )}
        {cell && view[cell.r] && (
          <CellViewer
            column={columns[cell.c]}
            value={view[cell.r][cell.c]}
            row={cell.r + 1}
            onClose={() => {
              setCell(null);
              box.current?.focus();
            }}
          />
        )}
      </div>
    </div>
  );
}

/** A cell's whole value beside the grid, JSON laid out, with a copy button. */
function CellViewer({
  column,
  value,
  row,
  onClose,
}: {
  column: { name: string; type: string } | undefined;
  value: unknown;
  row: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const nil = value === null || value === undefined;
  const { text, json } = nil ? { text: '', json: false } : pretty(value);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-label={t('ps.qt.cellTitle', { col: column?.name ?? '', row })}
      className="absolute inset-y-0 right-0 z-20 flex w-[min(460px,100%)] flex-col border-l border-[var(--wb-border)] bg-[var(--wb-panel)] shadow-lg outline-none"
    >
      <div className="flex h-[28px] shrink-0 items-center gap-2 border-b border-[var(--wb-border)] px-2 text-[12px]">
        <span className="min-w-0 truncate font-semibold">
          {t('ps.qt.cellTitle', { col: column?.name ?? '', row })}
        </span>
        <span className="shrink-0 text-[11px] text-[var(--wb-muted)]">{column?.type}</span>
        {json && !/^jsonb?$/.test(column?.type ?? '') && (
          <span className="shrink-0 text-[11px] text-[var(--wb-muted)]">JSON</span>
        )}
        <button
          type="button"
          disabled={nil}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(nil ? '' : display(value));
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              // The browser refused the clipboard.
            }
          }}
          className="ml-auto inline-flex h-6 items-center gap-1 rounded-[2px] px-1.5 text-[11px] text-[var(--wb-text-2)] hover:bg-[var(--wb-hover)] disabled:opacity-40"
        >
          <Copy size={12} /> {copied ? t('ps.qt.cellCopied') : t('ps.qt.cellCopy')}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
          className="inline-flex h-6 w-6 items-center justify-center rounded-[2px] text-[var(--wb-text-2)] hover:bg-[var(--wb-hover)]"
        >
          <X size={13} />
        </button>
      </div>
      {nil ? (
        <p className="p-2 font-mono text-[12px] italic text-[var(--wb-null)]">[null]</p>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[12px] text-[var(--wb-text)]">
          {text}
        </pre>
      )}
    </div>
  );
}
