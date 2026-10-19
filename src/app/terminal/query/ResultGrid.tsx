'use client';

// Data Output: a query's rows in a grid. Only the rows in view are drawn
// (fixed row height), so thousands of rows scroll smoothly. Cells, rows and
// columns can be selected (click, Shift+click, arrows) and copied as
// tab-separated text (Ctrl+C), as spreadsheets paste it. NULL is shown as
// [null], apart from an empty text.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

export function ResultGrid({
  columns,
  rows,
  onCopied,
}: {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  onCopied: (cells: number) => void;
}) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);
  const [sel, setSel] = useState<Range | null>(null);

  // Widths from the header and the first rows; dragged wider or narrower.
  const initialWidths = useMemo(
    () =>
      columns.map((c, i) => {
        let chars = Math.max(c.name.length, c.type.length);
        for (const r of rows.slice(0, 50))
          chars = Math.max(chars, r[i] === null ? 6 : Math.min(display(r[i]).length, 60));
        return Math.min(420, Math.max(72, chars * 7.4 + 22));
      }),
    [columns, rows]
  );
  const [widths, setWidths] = useState(initialWidths);
  useEffect(() => setWidths(initialWidths), [initialWidths]);
  useEffect(() => setSel(null), [rows]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const total = NUM_W + widths.reduce((a, b) => a + b, 0);

  const copy = useCallback(async () => {
    if (!sel) return;
    const s = norm(sel);
    const picked = rows.slice(s.top, s.bottom + 1).map((r) => r.slice(s.left, s.right + 1));
    // Whole rows: with the column names, as pgAdmin's "copy with headers".
    const whole = s.left === 0 && s.right === columns.length - 1;
    const text = toTsv(whole ? columns.map((c) => c.name) : null, picked);
    try {
      await navigator.clipboard.writeText(text);
      onCopied(picked.length * (s.right - s.left + 1));
    } catch {
      // The browser refused the clipboard: nothing copied, nothing said copied.
    }
  }, [sel, rows, columns, onCopied]);

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      void copy();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (rows.length && columns.length)
        setSel({ r1: 0, c1: 0, r2: rows.length - 1, c2: columns.length - 1 });
      return;
    }
    if (!sel) return;
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    const r = Math.min(rows.length - 1, Math.max(0, sel.r2 + m[0]));
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

  const s = sel ? norm(sel) : null;
  const inSel = (r: number, c: number) =>
    !!s && r >= s.top && r <= s.bottom && c >= s.left && c <= s.right;

  return (
    <div
      ref={box}
      tabIndex={0}
      role="grid"
      aria-rowcount={rows.length}
      aria-colcount={columns.length}
      aria-label={t('ps.qt.dataOutput')}
      onKeyDown={onKey}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="relative h-full overflow-auto outline-none text-[12px] font-mono text-[var(--wb-text)] bg-[var(--wb-editor)]"
    >
      <div style={{ width: total, height: HEAD_H + rows.length * ROW_H }} className="relative">
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
              rows.length && columns.length && pick(e, 0, 0, rows.length - 1, columns.length - 1)
            }
          />
          {columns.map((c, i) => (
            <div
              key={i}
              role="columnheader"
              className="relative shrink-0 px-2 py-1 border-r border-[var(--wb-border)] cursor-pointer select-none"
              style={{ width: widths[i] }}
              onClick={(e) => rows.length && pick(e, 0, i, rows.length - 1, i)}
              title={`${c.name} (${c.type})`}
            >
              <div className="truncate font-sans font-semibold text-[12px]">{c.name}</div>
              <div className="truncate font-sans text-[11px] text-[var(--wb-muted)]">{c.type}</div>
              <span
                aria-hidden
                onPointerDown={resize(i)}
                className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--wb-accent)]"
              />
            </div>
          ))}
        </div>
        {/* Rows in view */}
        {rows.slice(first, last).map((row, k) => {
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
  );
}
