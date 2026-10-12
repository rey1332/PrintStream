'use client';

// The PrintStream wordmark in ASCII, drawn in the app's monospace font, set
// tight and bold so it reads as one solid mark. It ripples like water: moving
// the mouse sends rings out from the cursor, a click sends a shock wave, and a
// first wave sweeps across when the page opens. Characters on a crest are
// lifted outwards, glow, grow and flicker into other glyphs, then settle.
// Nothing moves for people who ask for reduced motion, and screen readers get
// the word "PrintStream".

import React, { useEffect, useRef, useState } from 'react';

// Letters of the wordmark, seven rows each (P r i n t S t r e a m).
const GLYPHS: string[][] = [
  ['mmmmmm  ', '##""""#m', '##    ##', '######" ', '##      ', '##      ', '""      '],
  ['       ', '       ', '##m####', '##"    ', '##     ', '##     ', '""     '],
  ['   ##   ', '   ""   ', ' ####   ', '   ##   ', '   ##   ', 'mmm##mmm', '""""""""'],
  ['        ', '        ', '##m###m ', '##"  ## ', '##   ## ', '##   ## ', '""   "" '],
  ['        ', '  ##    ', '####### ', '  ##    ', '  ##    ', '  ##mmm ', '   """" '],
  ['  mmmm   ', ' m#""""# ', ' ##m     ', '  "####m ', '      "##', ' #mmmmm#"', '  """""  '],
  ['        ', '  ##    ', '####### ', '  ##    ', '  ##    ', '  ##mmm ', '   """" '],
  ['       ', '       ', '##m####', '##"    ', '##     ', '##     ', '""     '],
  ['         ', '         ', ' m####m  ', '##mmmm## ', '##"""""" ', '"##mmmm# ', '  """""  '],
  ['         ', '         ', ' m#####m ', ' " mmm## ', 'm##"""## ', '##mmm### ', ' """" "" '],
  ['        ', '        ', '####m##m', '## ## ##', '## ## ##', '## ## ##', '"" "" ""'],
];

/**
 * The wordmark's rows (letters side by side, one space between), all the
 * same length, so a centered parent cannot shift one row against another.
 */
const RAW_ROWS: string[] = Array.from({ length: 7 }, (_, row) =>
  GLYPHS.map((g) => g[row])
    .join(' ')
    .replace(/\s+$/, '')
);
const COLS = Math.max(...RAW_ROWS.map((r) => r.length));
export const ASCII_LOGO: string[] = RAW_ROWS.map((r) => r.padEnd(COLS, ' '));
const SCRAMBLE = '#m"@%*+=~:░▒▓';
// A monospace character is about 0.6em wide. "dense": characters closer
// (0.5em, rows 0.82em) and bold, for large sizes; "normal": the font's own
// spacing, which stays readable when the logo is small.
const SPACING = {
  dense: { cell: 0.5, line: 0.82, weight: 700 },
  normal: { cell: 0.6, line: 1.05, weight: 600 },
} as const;

interface Cell {
  el: HTMLSpanElement;
  ch: string;
  x: number;
  y: number;
  dx: number;
  dy: number;
  glow: number;
  scrambled: boolean;
}

interface Wave {
  x: number;
  y: number;
  born: number;
  strength: number;
}

export function AsciiLogo({
  className = '',
  maxFontPx = 11,
  label = 'PrintStream',
  spacing = 'dense',
}: {
  className?: string;
  /** Largest character size; smaller containers get smaller characters. */
  maxFontPx?: number;
  spacing?: keyof typeof SPACING;
  label?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const [fontPx, setFontPx] = useState(maxFontPx);
  const { cell, line, weight } = SPACING[spacing];

  // As large as fits the container.
  useEffect(() => {
    const box = wrap.current;
    if (!box) return;
    const fit = () =>
      setFontPx(Math.max(3, Math.min(maxFontPx, box.clientWidth / (COLS * (cell + 0.01)))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [maxFontPx, cell]);

  useEffect(() => {
    const host = pre.current;
    if (!host) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const cells: Cell[] = [...host.querySelectorAll<HTMLSpanElement>('span[data-c]')].map((el) => ({
      el,
      ch: el.textContent ?? '',
      x: el.offsetLeft + el.offsetWidth / 2,
      y: el.offsetTop + el.offsetHeight / 2,
      dx: 0,
      dy: 0,
      glow: 0,
      scrambled: false,
    }));
    const width = host.offsetWidth;
    const height = host.offsetHeight;
    // Rings travel at about a third of the logo's width a second, a few characters thick.
    const speed = Math.max(width / 2.6, fontPx * 40);
    const band = fontPx * 2.6;
    const lift = fontPx * 0.9;
    const near = fontPx * 7;
    const waves: Wave[] = [];
    let mouse: { x: number; y: number } | null = null;
    let last: { x: number; y: number; t: number } | null = null;
    let frame = 0;

    const emit = (x: number, y: number, strength: number) => {
      waves.push({ x, y, born: performance.now(), strength });
      if (waves.length > 8) waves.shift();
    };

    const tick = (now: number) => {
      frame = 0;
      for (let i = waves.length - 1; i >= 0; i--) {
        const age = (now - waves[i].born) / 1000;
        if (age * speed - band > Math.hypot(width, height) + band || age > 4) waves.splice(i, 1);
      }
      let moving = waves.length > 0 || mouse !== null;
      for (const c of cells) {
        let tx = 0;
        let ty = 0;
        let energy = 0;
        for (const w of waves) {
          const vx = c.x - w.x;
          const vy = c.y - w.y;
          const d = Math.hypot(vx, vy) || 0.01;
          const age = (now - w.born) / 1000;
          const off = d - age * speed;
          if (Math.abs(off) > band) continue;
          // One crest and a smaller trough behind it, fading as the ring grows.
          const phase = (off / band) * Math.PI;
          const amp = w.strength * Math.exp(-age * 0.9) * Math.cos(phase / 2) * Math.cos(phase);
          tx += (vx / d) * amp * lift;
          ty += (vy / d) * amp * lift - Math.max(0, amp) * lift * 0.35;
          energy += Math.max(0, amp);
        }
        if (mouse) {
          // The cursor itself pushes the characters around it aside.
          const vx = c.x - mouse.x;
          const vy = c.y - mouse.y;
          const d = Math.hypot(vx, vy);
          if (d < near && d > 0.01) {
            const f = (1 - d / near) ** 2;
            tx += (vx / d) * f * lift * 0.8;
            ty += (vy / d) * f * lift * 0.8;
            energy += f * 0.6;
          }
        }
        c.dx += (tx - c.dx) * 0.3;
        c.dy += (ty - c.dy) * 0.3;
        c.glow += (Math.min(1.4, energy) - c.glow) * 0.35;
        if (c.glow > 0.45 && Math.random() < 0.18) {
          c.el.textContent = SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)];
          c.scrambled = true;
        } else if (c.scrambled && c.glow < 0.3 && Math.random() < 0.35) {
          c.el.textContent = c.ch;
          c.scrambled = false;
        }
        const still = Math.abs(c.dx) < 0.05 && Math.abs(c.dy) < 0.05 && c.glow < 0.02;
        if (still) {
          c.dx = 0;
          c.dy = 0;
          c.glow = 0;
          if (c.scrambled) {
            c.el.textContent = c.ch;
            c.scrambled = false;
          }
          if (c.el.style.transform) {
            c.el.style.transform = '';
            c.el.style.textShadow = '';
          }
        } else {
          moving = true;
          const g = Math.min(1, c.glow);
          c.el.style.transform = `translate(${c.dx.toFixed(2)}px, ${c.dy.toFixed(2)}px) scale(${(1 + g * 0.35).toFixed(3)})`;
          // Crests glow in the text's own colour (the brand is monochrome).
          c.el.style.textShadow =
            g > 0.15 ? `0 0 ${(g * fontPx * 0.9).toFixed(1)}px currentColor` : '';
        }
      }
      if (moving) frame = requestAnimationFrame(tick);
    };
    const kick = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const local = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent) => {
      mouse = local(e);
      const now = performance.now();
      // A new ring every so often while the cursor travels.
      if (
        !last ||
        (now - last.t > 140 && Math.hypot(mouse.x - last.x, mouse.y - last.y) > fontPx * 2)
      ) {
        emit(mouse.x, mouse.y, 0.75);
        last = { ...mouse, t: now };
      }
      kick();
    };
    const onDown = (e: PointerEvent) => {
      const p = local(e);
      emit(p.x, p.y, 1.8);
      kick();
    };
    const onLeave = () => {
      mouse = null;
      last = null;
      kick();
    };
    // The whole area around the logo reacts, not only the characters.
    const area: HTMLElement = wrap.current ?? host;
    area.addEventListener('pointermove', onMove);
    area.addEventListener('pointerdown', onDown);
    area.addEventListener('pointerleave', onLeave);
    // A first wave sweeps across from the left when the logo appears.
    const intro = window.setTimeout(() => {
      emit(-fontPx * 4, height / 2, 1.1);
      kick();
    }, 250);
    return () => {
      window.clearTimeout(intro);
      area.removeEventListener('pointermove', onMove);
      area.removeEventListener('pointerdown', onDown);
      area.removeEventListener('pointerleave', onLeave);
      if (frame) cancelAnimationFrame(frame);
      for (const c of cells) {
        c.el.style.transform = '';
        c.el.style.textShadow = '';
        c.el.textContent = c.ch;
      }
    };
  }, [fontPx]);

  return (
    <div ref={wrap} className={`w-full select-none ${className}`} role="img" aria-label={label}>
      <pre
        ref={pre}
        aria-hidden
        className="relative m-0 inline-block text-left font-mono whitespace-pre"
        style={{
          fontSize: `${fontPx}px`,
          lineHeight: line,
          letterSpacing: `${cell - 0.6}em`,
          fontWeight: weight,
        }}
      >
        {ASCII_LOGO.map((row, r) => (
          <div key={r}>
            {[...row].map((ch, c) =>
              ch === ' ' ? (
                ' '
              ) : (
                <span key={c} data-c="" className="inline-block will-change-transform">
                  {ch}
                </span>
              )
            )}
          </div>
        ))}
      </pre>
    </div>
  );
}
