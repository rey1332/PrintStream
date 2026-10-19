'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A size in percent of a container that a divider changes: dragged with the
 * pointer, or with the arrow keys when focused. Remembered per name.
 */
export function useSplit(name: string, initial: number, min: number, max: number) {
  const key = `ps.wb.split.${name}`;
  const [size, setSize] = useState(initial);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(key));
      if (v >= min && v <= max) setSize(v);
    } catch {
      // Storage can be unavailable; the default size is used.
    }
  }, [key, min, max]);
  const set = useCallback(
    (v: number) => {
      const next = Math.min(max, Math.max(min, v));
      setSize(next);
      try {
        localStorage.setItem(key, String(Math.round(next * 10) / 10));
      } catch {
        // Not remembered, still applied.
      }
    },
    [key, min, max]
  );
  return [size, set] as const;
}

/**
 * The divider between two panes. `direction` "vertical": a vertical bar that
 * moves left and right (width); "horizontal": moves up and down (height).
 * `invert`: the size belongs to the pane after the divider.
 */
export function Splitter({
  direction,
  size,
  onSize,
  label,
  invert = false,
}: {
  direction: 'vertical' | 'horizontal';
  size: number;
  onSize: (percent: number) => void;
  label: string;
  invert?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const start = (e: React.PointerEvent) => {
    const container = ref.current?.parentElement;
    if (!container) return;
    e.preventDefault();
    const box = container.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const share =
        direction === 'vertical'
          ? ((ev.clientX - box.left) / box.width) * 100
          : ((ev.clientY - box.top) / box.height) * 100;
      onSize(invert ? 100 - share : share);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = direction === 'vertical' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };
  const key = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    const grow = direction === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    const shrink = direction === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    if (e.key === grow) onSize(size + (invert ? -step : step));
    else if (e.key === shrink) onSize(size + (invert ? step : -step));
    else return;
    e.preventDefault();
  };
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={direction}
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={key}
      className={`shrink-0 bg-[var(--wb-border)] hover:bg-[var(--wb-accent)] focus-visible:bg-[var(--wb-accent)] outline-none ${
        direction === 'vertical' ? 'w-[3px] cursor-col-resize' : 'h-[3px] cursor-row-resize'
      }`}
    />
  );
}
