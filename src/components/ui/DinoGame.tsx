'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface DinoGameProps {
  onClose: () => void;
}

const W = 640;
const H = 240;
const GROUND_Y = H - 30;
const DINO_X = 50;
const DINO_W = 24;
const DINO_H = 28;
const GRAVITY = 0.7;
const JUMP_V = -11;
const BASE_SPEED = 4;
const SPEED_INCREMENT = 0.001;

interface Obstacle {
  x: number;
  w: number;
  h: number;
}

function getInitialPosition() {
  if (typeof window === 'undefined') return { x: 100, y: 100 };
  const w = W;
  const h = H + 60;
  return {
    x: Math.max(16, (window.innerWidth - w) / 2),
    y: Math.max(16, (window.innerHeight - h) / 2),
  };
}

export function DinoGame({ onClose }: DinoGameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'ready' | 'playing' | 'over'>('ready');
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const [position, setPosition] = useState(getInitialPosition);
  const [dragMode, setDragMode] = useState(false);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, startX: 0, startY: 0 });

  const dinoY = useRef(GROUND_Y - DINO_H);
  const dinoVY = useRef(0);
  const obstacles = useRef<Obstacle[]>([]);
  const speed = useRef(BASE_SPEED);
  const frameCount = useRef(0);
  const scoreRef = useRef(0);
  const stateRef = useRef(state);
  const highScoreRef = useRef(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    highScoreRef.current = highScore;
  }, [highScore]);

  useEffect(() => {
    try {
      const hs = Number(localStorage.getItem('etna-dino-hs') || '0');
      setHighScore(hs);
    } catch {
      // Start with a zero high score if browser storage is unavailable.
    }
  }, []);

  const jump = useCallback(() => {
    if (stateRef.current === 'ready') {
      setState('playing');
      stateRef.current = 'playing';
      dinoVY.current = JUMP_V;
      return;
    }
    if (stateRef.current === 'over') {
      dinoY.current = GROUND_Y - DINO_H;
      dinoVY.current = 0;
      obstacles.current = [];
      speed.current = BASE_SPEED;
      frameCount.current = 0;
      scoreRef.current = 0;
      setScore(0);
      setState('playing');
      stateRef.current = 'playing';
      return;
    }
    const feetY = GROUND_Y - DINO_H;
    if (dinoY.current >= feetY - 1) {
      dinoVY.current = JUMP_V;
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp') {
        e.preventDefault();
        jump();
      }
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [jump, onClose]);

  // Game loop — runs once when canvas is mounted
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    const draw = () => {
      // Background
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, W, H);

      // Ground line
      ctx.strokeStyle = '#3f3f46';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y + 1);
      ctx.lineTo(W, GROUND_Y + 1);
      ctx.stroke();

      // Moving ground dashes
      const dashOffset = (frameCount.current * speed.current) % 40;
      ctx.strokeStyle = '#27272a';
      ctx.lineWidth = 1;
      for (let x = -dashOffset; x < W; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, GROUND_Y + 8);
        ctx.lineTo(x + 20, GROUND_Y + 8);
        ctx.stroke();
      }

      // Dino body
      const dy = dinoY.current;
      ctx.fillStyle = '#e4e4e7';
      ctx.fillRect(DINO_X, dy + 6, DINO_W, DINO_H - 6);
      ctx.fillRect(DINO_X + DINO_W - 8, dy, 14, 12);
      // Eye
      ctx.fillStyle = '#09090b';
      ctx.fillRect(DINO_X + DINO_W + 2, dy + 3, 3, 3);
      // Legs
      ctx.fillStyle = '#e4e4e7';
      const legFrame = Math.floor(frameCount.current / 6) % 2;
      ctx.fillRect(DINO_X + 4, dy + DINO_H, 5, legFrame ? 5 : 3);
      ctx.fillRect(DINO_X + 14, dy + DINO_H, 5, legFrame ? 3 : 5);

      // Obstacles (cactus)
      ctx.fillStyle = '#22c55e';
      for (const o of obstacles.current) {
        ctx.fillRect(o.x, GROUND_Y - o.h, o.w, o.h);
        ctx.fillRect(o.x - 3, GROUND_Y - o.h + 8, 3, o.h / 2);
        ctx.fillRect(o.x + o.w, GROUND_Y - o.h + 12, 3, Math.max(4, o.h / 2 - 4));
      }

      // Score
      ctx.font = 'bold 12px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#71717a';
      ctx.fillText(`HI ${String(highScoreRef.current).padStart(5, '0')}`, W - 100, 22);
      ctx.fillStyle = '#e4e4e7';
      ctx.fillText(String(scoreRef.current).padStart(5, '0'), W - 30, 22);

      // Overlays
      if (stateRef.current === 'ready') {
        ctx.fillStyle = 'rgba(9,9,11,0.75)';
        ctx.fillRect(0, 0, W, H);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#e4e4e7';
        ctx.font = 'bold 14px ui-monospace, monospace';
        ctx.fillText('PRESS SPACE OR CLICK TO START', W / 2, H / 2 - 8);
        ctx.font = '11px ui-monospace, monospace';
        ctx.fillStyle = '#71717a';
        ctx.fillText('you found the easter egg · esc to close', W / 2, H / 2 + 16);
      }
      if (stateRef.current === 'over') {
        ctx.fillStyle = 'rgba(9,9,11,0.75)';
        ctx.fillRect(0, 0, W, H);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 18px ui-monospace, monospace';
        ctx.fillText('GAME OVER', W / 2, H / 2 - 16);
        ctx.fillStyle = '#e4e4e7';
        ctx.font = '12px ui-monospace, monospace';
        ctx.fillText(`Score: ${scoreRef.current}`, W / 2, H / 2 + 8);
        ctx.font = '11px ui-monospace, monospace';
        ctx.fillStyle = '#a1a1aa';
        ctx.fillText('Press SPACE or click to play again', W / 2, H / 2 + 32);
      }
    };

    const tick = () => {
      if (stateRef.current === 'playing') {
        frameCount.current += 1;
        scoreRef.current = Math.floor(frameCount.current / 6);
        setScore(scoreRef.current);
        speed.current = BASE_SPEED + scoreRef.current * SPEED_INCREMENT;

        dinoVY.current += GRAVITY;
        dinoY.current += dinoVY.current;
        const feet = GROUND_Y - DINO_H;
        if (dinoY.current >= feet) {
          dinoY.current = feet;
          dinoVY.current = 0;
        }

        const spawnInterval = Math.max(55, 110 - Math.floor(scoreRef.current / 5));
        if (frameCount.current % spawnInterval === 0) {
          const w = 12 + Math.floor(Math.random() * 12);
          const h = 20 + Math.floor(Math.random() * 20);
          obstacles.current.push({ x: W + 10, w, h });
        }

        for (const o of obstacles.current) o.x -= speed.current;
        obstacles.current = obstacles.current.filter((o) => o.x + o.w > -20);

        for (const o of obstacles.current) {
          const overlap =
            DINO_X + DINO_W > o.x + 2 &&
            DINO_X < o.x + o.w - 2 &&
            dinoY.current + DINO_H > GROUND_Y - o.h;
          if (overlap) {
            setState('over');
            stateRef.current = 'over';
            const hs = Math.max(highScoreRef.current, scoreRef.current);
            setHighScore(hs);
            try {
              localStorage.setItem('etna-dino-hs', String(hs));
            } catch {
              // Keep the high score in memory for the current session.
            }
            break;
          }
        }
      }

      draw();
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Drag
  useEffect(() => {
    if (!dragMode) return;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'move';
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStartRef.current.mouseX;
      const dy = e.clientY - dragStartRef.current.mouseY;
      setPosition({
        x: Math.max(0, Math.min(window.innerWidth - 100, dragStartRef.current.startX + dx)),
        y: Math.max(0, Math.min(window.innerHeight - 40, dragStartRef.current.startY + dy)),
      });
    };
    const onUp = () => setDragMode(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [dragMode]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragMode(true);
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: position.x,
      startY: position.y,
    };
  };

  return (
    <div
      className="fixed z-[10000] flex flex-col rounded-lg font-mono overflow-hidden"
      style={{
        left: position.x,
        top: position.y,
        width: W,
        backgroundColor: '#09090b',
        color: '#e4e4e7',
        border: '1px solid #27272a',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.9)',
      }}
    >
      <div
        onMouseDown={startDrag}
        className="flex justify-between items-center px-3 py-1.5 cursor-move select-none shrink-0"
        style={{ backgroundColor: '#18181b', borderBottom: '1px solid #27272a' }}
      >
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onClose}
              className="w-3 h-3 rounded-full bg-red-500/80 hover:bg-red-500 transition-colors"
              title="Close"
            />
            <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
            <div className="w-3 h-3 rounded-full bg-green-500/60" />
          </div>
          <span className="text-[11px] font-bold tracking-wider ml-2" style={{ color: '#a1a1aa' }}>
            ETNA · Dino Run
          </span>
        </div>
        <span className="text-[10px]" style={{ color: '#52525b' }}>
          space to jump · esc to close
        </span>
      </div>

      <canvas
        ref={canvasRef}
        onClick={jump}
        style={{
          width: W,
          height: H,
          display: 'block',
          cursor: 'pointer',
          backgroundColor: '#09090b',
        }}
      />

      <div
        className="px-3 py-1 text-[10px] flex justify-between shrink-0"
        style={{ borderTop: '1px solid #27272a', color: '#52525b' }}
      >
        <span>You found it: the ETNA easter egg.</span>
        <span>
          score {String(score).padStart(5, '0')} · hi {String(highScore).padStart(5, '0')}
        </span>
      </div>
    </div>
  );
}
