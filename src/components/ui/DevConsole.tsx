'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useAuth } from '@/contexts/AuthContext';
import { useUiMode } from '@/lib/ui/UiModeProvider';
import { consoleLogger } from '@/lib/console-logger';
import { useConsolePage, readActiveWorkspaceId } from '@/lib/console/bridge';
import { CONSOLE_ROOT_ATTRIBUTE } from '@/lib/console/shortcut';
import {
  processChat,
  createChatContext,
  type ChatContext,
  type ChatMetrics,
} from './devConsoleChat';
import { DinoGame } from './DinoGame'; // 🦖 easter egg
import { safeCalc } from './safeCalc';

interface DevConsoleProps {
  open: boolean;
  onClose: () => void;
}

async function serverCommand(
  command: 'ver' | 'whoami' | 'delete',
  target?: string
): Promise<{ lines?: string[]; error?: string }> {
  try {
    const response = await fetch('/api/console', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, target, workspaceId: readActiveWorkspaceId() }),
      cache: 'no-store',
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.success && Array.isArray(body.data?.lines))
      return { lines: body.data.lines.map(String) };
    return { error: typeof body?.error === 'string' ? body.error : 'The console request failed.' };
  } catch {
    return { error: 'Network error.' };
  }
}

const HELP_TEXT = [
  'PrintStream Developer Console',
  '='.repeat(58),
  '',
  'CHAT',
  '  Type plain English. Examples:',
  '    "delete all transactions"',
  '    "go to reports"',
  '    "show me my revenue"',
  '    "what is a cash balance?"',
  '    "help me"   ·   "thanks"   ·   "hi"',
  '',
  'CALCULATOR',
  '  calc <expr>              Evaluate expression',
  '  <expr>                   Shorthand (e.g. 2+2)',
  '  uuid                     Generate UUID v4',
  '  rand <min> <max>         Random integer',
  '  b64 <text>               Base64 encode',
  '  unb64 <text>             Base64 decode',
  '',
  'NAVIGATION',
  '  r_reload                 Reload page',
  '  r_dash                   Main dashboard',
  '  r_erp                    ERP dashboard',
  '  r_settings               ERP settings',
  '  r_reports                ERP reports',
  '  r_logout                 Sign out',
  '',
  'APPLICATION',
  '  ver                      App version',
  '  stat                     Show KPI metrics (dashboards)',
  '  export                   Copy metrics as JSON',
  '  theme [dark|light]       Toggle or set theme',
  '  test                     Check the connection',
  '  r_quit                   Close the window',
  '',
  'REFERENCE',
  '  help / ?                 This reference',
  '  man <cmd>                Manual for a specific command',
  '  log                      Command history',
  '  clear                    Clear console',
  '  whoami                   Your name and console role',
  '  time                     Current date/time',
  '  echo <text>              Echo text',
  '',
  'DATA OPERATIONS  (type CONFIRM to execute)',
  '  d_ts      transactions',
  '  d_sp      suppliers',
  '  d_inv     products / inventory',
  '  d_cust    customers',
  '  d_pay     payments',
  '  d_po      purchase orders',
  '  d_so      sales orders',
  '  d_invcs   invoices',
  '  d_aud     audit logs',
  '  d_all     ALL ERP data',
  '='.repeat(58),
];

const MAN_PAGES: Record<string, string[]> = {
  help: ['help / ?', '  Displays the full command reference.', '  Usage: help'],
  clear: ['clear', '  Clears console history and resets chat context.', '  Usage: clear'],
  whoami: ['whoami', '  Shows your name and console role.', '  Usage: whoami'],
  ver: ['ver', '  Shows the PrintStream version.', '  Usage: ver'],
  test: ['test', '  Checks that the app and your session respond.', '  Usage: test'],
  r_quit: ['r_quit', '  Closes the window (desktop app).', '  Usage: r_quit'],
  time: ['time / date', '  Shows the current local date and time.', '  Usage: time'],
  echo: ['echo <text>', '  Echoes text back to the console.', '  Usage: echo hello world'],
  log: ['log', '  Prints all commands executed in this session.', '  Usage: log'],
  stat: ['stat', '  Displays a live KPI snapshot.', '  Usage: stat'],
  export: ['export', '  Copies current KPI metrics to clipboard as JSON.', '  Usage: export'],
  theme: [
    'theme [dark|light]',
    '  Toggles or explicitly sets the UI theme.',
    '  Usage: theme dark',
  ],
  calc: [
    'calc <expression>',
    '  Safely evaluates a math expression.',
    '  Supported: + - * / % ^ ( ) sqrt sin cos tan log ln abs round floor ceil pi e',
    '  Usage: calc 15 * 2000',
  ],
  uuid: ['uuid', '  Generates a random UUID v4.', '  Usage: uuid'],
  rand: [
    'rand <min> <max>',
    '  Random integer between min and max (inclusive).',
    '  Usage: rand 1 100',
  ],
  b64: ['b64 <text>', '  Encodes text as Base64.', '  Usage: b64 hello'],
  unb64: ['unb64 <text>', '  Decodes Base64 text.', '  Usage: unb64 aGVsbG8='],
  ask: [
    'ask <question>',
    '  Forces chatbot mode with a question.',
    '  Usage: ask how do I delete transactions?',
  ],
  r_reload: ['r_reload', '  Reloads the current page.', '  Usage: r_reload'],
  r_dash: ['r_dash', '  Navigates to the main dashboard.', '  Usage: r_dash'],
  r_erp: ['r_erp', '  Navigates to the ERP dashboard.', '  Usage: r_erp'],
  r_settings: ['r_settings', '  Navigates to ERP settings.', '  Usage: r_settings'],
  r_reports: ['r_reports', '  Navigates to ERP reports.', '  Usage: r_reports'],
  r_logout: ['r_logout', '  Signs out and redirects to login.', '  Usage: r_logout'],
};

// d_* data commands (labels only; the server maps them to tables and runs them).
const DESTRUCTIVE_LABEL: Record<string, string> = {
  d_ts: 'transactions',
  d_sp: 'suppliers',
  d_inv: 'inventory/products',
  d_cust: 'customers',
  d_pay: 'payments',
  d_po: 'purchase orders',
  d_so: 'sales orders',
  d_invcs: 'invoices',
  d_aud: 'audit logs',
  d_all: 'ALL ERP DATA',
};
const isDataCommand = (cmd: string) => Object.hasOwn(DESTRUCTIVE_LABEL, cmd);

const ALL_COMMANDS = [
  ...Object.keys(DESTRUCTIVE_LABEL),
  ...Object.keys(MAN_PAGES),
  'r_erp',
  'r_showcase',
];

const COLOR_BG = '#09090b';
const COLOR_TITLEBAR = '#18181b';
const COLOR_BORDER = '#27272a';

export function DevConsole({ open, onClose }: DevConsoleProps) {
  const router = useRouter();
  const { signOut } = useAuth();
  const { setTheme } = useTheme();
  const { isDesktop } = useUiMode();
  const { metrics, onDataChange } = useConsolePage();

  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ w: 820, h: 300 });
  const [minimized, setMinimized] = useState(false);
  const [dragMode, setDragMode] = useState<'none' | 'move' | 'resize'>('none');
  const [dinoOpen, setDinoOpen] = useState(false); // 🦖 easter egg

  const inputRef = useRef<HTMLInputElement>(null);
  const historyIndexRef = useRef<number>(-1);
  const historyCommandsRef = useRef<string[]>([]);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, startX: 0, startY: 0, startW: 0, startH: 0 });
  const posInitRef = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const chatCtxRef = useRef<ChatContext>(createChatContext());

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const log = useCallback((line: string) => {
    setHistory((prev) => {
      const next = [...prev, line];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  const logLines = useCallback((lines: string[]) => {
    setHistory((prev) => {
      const next = [...prev, ...lines];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  useEffect(() => {
    const c = chatCtxRef.current as any;
    if (!Array.isArray(c?.recentTopics) || typeof c?.turn !== 'number') {
      chatCtxRef.current = createChatContext();
    }
  }, []);

  useEffect(() => {
    if (posInitRef.current) return;
    try {
      const saved = localStorage.getItem('etna-devconsole-pos');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.position && parsed.size) {
          setPosition(parsed.position);
          setSize(parsed.size);
          posInitRef.current = true;
          return;
        }
      }
    } catch {
      // Use the default console dimensions when no saved layout is available.
    }
    const w = Math.min(900, Math.max(500, window.innerWidth - 300));
    const h = 320;
    setSize({ w, h });
    setPosition({
      x: Math.max(16, (window.innerWidth - w) / 2),
      y: Math.max(16, window.innerHeight - h - 24),
    });
    posInitRef.current = true;
  }, []);

  useEffect(() => {
    if (!position || !posInitRef.current) return;
    try {
      localStorage.setItem('etna-devconsole-pos', JSON.stringify({ position, size }));
    } catch {
      // Storage can be disabled; the console still works for this session.
    }
  }, [position, size]);

  // Backtick toggling lives in ConsoleHost (app-wide); Escape still closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !dinoOpen) {
        onClose();
        (document.activeElement as HTMLElement)?.blur();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, dinoOpen, onClose]);

  // App events (dashboard loads, realtime status…) from the old Realtime Console.
  useEffect(() => {
    for (const entry of consoleLogger.getLogs()) log(`[${entry.timestamp}] ${entry.message}`);
    return consoleLogger.subscribe((entry) => log(`[${entry.timestamp}] ${entry.message}`));
  }, [log]);

  useEffect(() => {
    if (open && !dinoOpen) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open, dinoOpen]);

  useEffect(() => {
    if (dragMode === 'none') return;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = dragMode === 'move' ? 'move' : 'nwse-resize';

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStartRef.current.mouseX;
      const dy = e.clientY - dragStartRef.current.mouseY;
      if (dragMode === 'move') {
        setPosition({
          x: Math.max(0, Math.min(window.innerWidth - 80, dragStartRef.current.startX + dx)),
          y: Math.max(0, Math.min(window.innerHeight - 40, dragStartRef.current.startY + dy)),
        });
      } else {
        setSize({
          w: Math.max(360, Math.min(window.innerWidth, dragStartRef.current.startW + dx)),
          h: Math.max(140, Math.min(window.innerHeight, dragStartRef.current.startH + dy)),
        });
      }
    };
    const onUp = () => setDragMode('none');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [dragMode]);

  const startDrag = (e: React.MouseEvent, mode: 'move' | 'resize') => {
    if (!position) return;
    e.preventDefault();
    setDragMode(mode);
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: position.x,
      startY: position.y,
      startW: size.w,
      startH: size.h,
    };
  };

  const resetPosition = () => {
    if (typeof window === 'undefined') return;
    const w = Math.min(900, Math.max(500, window.innerWidth - 300));
    const h = 320;
    setSize({ w, h });
    setPosition({
      x: Math.max(16, (window.innerWidth - w) / 2),
      y: Math.max(16, window.innerHeight - h - 24),
    });
  };

  const performDelete = useCallback(
    async (cmd: string) => {
      if (!isDataCommand(cmd)) return;
      log('  Executing...');
      const result = await serverCommand('delete', cmd);
      if (result.error) {
        log(`  [ERR] ${result.error}`);
        return;
      }
      logLines((result.lines ?? []).map((line) => `  ${line}`));
      onDataChange?.();
    },
    [log, logLines, onDataChange]
  );

  const printServer = useCallback(
    async (command: 'ver' | 'whoami') => {
      const result = await serverCommand(command);
      if (result.error) log(`  [ERR] ${result.error}`);
      else logLines((result.lines ?? []).map((line) => `  ${line}`));
    },
    [log, logLines]
  );

  const executeCommand = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      log(`> ${trimmed}`);
      historyCommandsRef.current.push(trimmed);
      historyIndexRef.current = historyCommandsRef.current.length;

      if (pendingRef.current) {
        if (trimmed.toUpperCase() === 'CONFIRM') {
          const cmd = pendingRef.current;
          setPending(null);
          await performDelete(cmd);
          return;
        } else {
          setPending(null);
          log('  Command cancelled.');
        }
      }

      const parts = trimmed.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const argStr = parts.slice(1).join(' ');

      // 🦖 EASTER EGG
      if (cmd === 'etnas') {
        setDinoOpen(true);
        log('  [OK] Easter egg unlocked.');
        log('  A wild dinosaur appears. Have fun!');
        log('  (hint: press space or click inside the game to jump)');
        return;
      }

      if (isDataCommand(cmd)) {
        setPending(cmd);
        log(`  [WARN] This will delete all ${DESTRUCTIVE_LABEL[cmd]}.`);
        log('  [WARN] This action is IRREVERSIBLE. Type CONFIRM to proceed.');
        return;
      }

      switch (cmd) {
        case 'help':
        case '?':
          logLines(HELP_TEXT);
          return;
        case 'clear':
          setHistory([]);
          chatCtxRef.current = createChatContext();
          log('  [OK] Console cleared.');
          return;
        case 'whoami':
        case 'ver':
        case 'version':
          await printServer(cmd === 'whoami' ? 'whoami' : 'ver');
          return;
        case 'test': {
          // App and session reachability only; no versions, hosts or errors.
          try {
            const health = await fetch('/api/health', { cache: 'no-store' });
            const session = await fetch('/api/auth/session', { cache: 'no-store' })
              .then((r) => r.json())
              .catch(() => null);
            log(
              health.ok
                ? '  [OK] App and database respond.'
                : '  [ERR] The database is not responding.'
            );
            log(session?.user ? '  [OK] Session active.' : '  [ERR] Not signed in.');
          } catch {
            log('  [ERR] Network error.');
          }
          return;
        }
        case 'r_quit':
          log('  [OK] Closing...');
          setTimeout(() => window.close(), 300);
          return;
        case 'time':
        case 'date':
          log(`  ${new Date().toLocaleString()}`);
          return;
        case 'echo':
          log(`  ${argStr || '(empty)'}`);
          return;
        case 'log':
          if (historyCommandsRef.current.length === 0) log('  (no history)');
          else
            historyCommandsRef.current.forEach((c, i) =>
              log(`  ${String(i + 1).padStart(3, ' ')}. ${c}`)
            );
          return;
        case 'man': {
          if (!argStr) {
            log('  Usage: man <command>');
            return;
          }
          const key = argStr.split(/\s+/)[0].toLowerCase();
          const page = Object.hasOwn(MAN_PAGES, key) ? MAN_PAGES[key] : undefined;
          if (page) logLines(page);
          else if (isDataCommand(key)) {
            logLines([
              `${key}`,
              `  Deletes all ${DESTRUCTIVE_LABEL[key]}.`,
              `  Requires CONFIRM when executed.`,
            ]);
          } else log(`  No manual entry for "${key}".`);
          return;
        }
        case 'calc': {
          if (!argStr) {
            log('  Usage: calc <expression>');
            return;
          }
          const r = safeCalc(argStr);
          if (!r.ok) {
            log('  [ERR] Invalid expression.');
            return;
          }
          if (r.error) {
            log(`  [ERR] ${r.error}`);
            return;
          }
          log(`  = ${r.value}`);
          return;
        }
        case 'uuid': {
          const bytes = crypto.getRandomValues(new Uint8Array(16));
          bytes[6] = (bytes[6] & 0x0f) | 0x40;
          bytes[8] = (bytes[8] & 0x3f) | 0x80;
          const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
          log(
            `  ${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
          );
          return;
        }
        case 'rand': {
          const nums = argStr
            .split(/\s+/)
            .map(Number)
            .filter((n) => !isNaN(n));
          if (nums.length < 2) {
            log('  Usage: rand <min> <max>');
            return;
          }
          const [a, b] = nums;
          const lo = Math.ceil(Math.min(a, b));
          const hi = Math.floor(Math.max(a, b));
          log(`  ${Math.floor(Math.random() * (hi - lo + 1)) + lo}`);
          return;
        }
        case 'b64': {
          if (!argStr) {
            log('  Usage: b64 <text>');
            return;
          }
          try {
            log(
              `  ${typeof window !== 'undefined' ? btoa(unescape(encodeURIComponent(argStr))) : argStr}`
            );
          } catch {
            log('  [ERR] Encode failed.');
          }
          return;
        }
        case 'unb64': {
          if (!argStr) {
            log('  Usage: unb64 <text>');
            return;
          }
          try {
            log(
              `  ${typeof window !== 'undefined' ? decodeURIComponent(escape(atob(argStr))) : argStr}`
            );
          } catch {
            log('  [ERR] Invalid base64.');
          }
          return;
        }
        case 'stat': {
          const r = processChat('status', chatCtxRef.current, metrics as ChatMetrics);
          logLines(r.reply);
          chatCtxRef.current = r.ctx;
          return;
        }
        case 'export':
          if (!metrics) {
            log('  (no metrics available)');
            return;
          }
          try {
            const json = JSON.stringify(metrics, null, 2);
            await navigator.clipboard.writeText(json);
            log('  [OK] Metrics copied to clipboard:');
            logLines(json.split('\n').map((l) => '  ' + l));
          } catch {
            log('  [ERR] Failed to copy to clipboard.');
            logLines(
              JSON.stringify(metrics, null, 2)
                .split('\n')
                .map((l) => '  ' + l)
            );
          }
          return;
        case 'theme': {
          const target = argStr.toLowerCase();
          if (target === 'dark') {
            setTheme('dark');
            log('  [OK] Theme set to dark.');
          } else if (target === 'light') {
            setTheme('light');
            log('  [OK] Theme set to light.');
          } else {
            setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
            log('  [OK] Theme toggled.');
          }
          return;
        }
        case 'ask': {
          if (!argStr) {
            log('  Usage: ask <question>');
            return;
          }
          const r = processChat(argStr, chatCtxRef.current, metrics as ChatMetrics | undefined);
          chatCtxRef.current = r.ctx;
          logLines(r.reply.length ? r.reply : ['  No response. Type "help" for options.']);
          return;
        }
        case 'r_reload':
          log('  [OK] Reloading...');
          setTimeout(() => window.location.reload(), 100);
          return;
        case 'r_dash':
          log('  [OK] Navigating to /');
          router.push('/');
          return;
        case 'r_erp':
        case 'r_showcase':
          log('  [OK] Navigating to /erp');
          router.push('/erp');
          return;
        case 'r_settings':
          log('  [OK] Navigating to /erp/settings');
          router.push('/erp/settings');
          return;
        case 'r_reports':
          log('  [OK] Navigating to /erp/reports');
          router.push('/erp/reports');
          return;
        case 'r_logout':
          log('  [OK] Signing out...');
          try {
            await signOut();
            router.replace('/erp/login');
          } catch {
            log('  [ERR] Sign out failed.');
          }
          return;

        default: {
          const calc = safeCalc(trimmed);
          if (calc.ok && !calc.error && calc.value !== undefined) {
            log(`= ${calc.value}`);
            return;
          }
          const result = processChat(
            trimmed,
            chatCtxRef.current,
            metrics as ChatMetrics | undefined
          );
          chatCtxRef.current = result.ctx;
          if (result.reply.length) {
            logLines(result.reply);
            return;
          }
          log(`  Unknown: ${trimmed}`);
          log(`  Type "help" or ask in plain English.`);
          return;
        }
      }
    },
    [log, logLines, metrics, router, setTheme, signOut, performDelete, printServer]
  );

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const val = e.currentTarget.value.trim();
      if (!val) return;
      const matches = ALL_COMMANDS.filter((c) => c.startsWith(val));
      if (matches.length === 1) setInput(matches[0] + ' ');
      else if (matches.length > 1)
        log(`  Possible: ${matches.slice(0, 10).join(', ')}${matches.length > 10 ? ', …' : ''}`);
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const hist = historyCommandsRef.current;
      if (!hist.length) return;
      let idx = historyIndexRef.current - 1;
      if (idx < 0) idx = hist.length - 1;
      historyIndexRef.current = idx;
      setInput(hist[idx] || '');
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const hist = historyCommandsRef.current;
      if (!hist.length) return;
      let idx = historyIndexRef.current + 1;
      if (idx >= hist.length) idx = hist.length - 1;
      historyIndexRef.current = idx;
      setInput(hist[idx] || '');
    }
  };

  const sheet = !isDesktop;
  const frameStyle: React.CSSProperties = sheet
    ? {
        left: 0,
        right: 0,
        bottom: 0,
        height: minimized ? 'auto' : 'min(70dvh, 520px)',
        maxHeight: 'calc(100dvh - env(safe-area-inset-top) - 8px)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        borderRadius: '12px 12px 0 0',
      }
    : position
      ? (() => {
          const width = Math.min(size.w, window.innerWidth);
          const height = Math.min(size.h, window.innerHeight);
          return {
            left: Math.max(0, Math.min(position.x, window.innerWidth - Math.min(width, 80))),
            top: Math.max(0, Math.min(position.y, window.innerHeight - 40)),
            width,
            height: minimized ? 'auto' : height,
            borderRadius: 8,
          };
        })()
      : {};

  return (
    <>
      {open && (sheet || position) && (
        <div
          {...{ [CONSOLE_ROOT_ATTRIBUTE]: '' }}
          role="dialog"
          aria-label="PrintStream console"
          className="fixed z-[9999] flex flex-col font-mono overflow-hidden"
          style={{
            ...frameStyle,
            backgroundColor: COLOR_BG,
            color: '#e4e4e7',
            border: `1px solid ${COLOR_BORDER}`,
            boxShadow: '0 25px 50px -12px rgba(0,0,0,0.85)',
            opacity: 1,
          }}
        >
          {sheet ? (
            <div
              className="flex justify-between items-center pl-3 pr-1 shrink-0"
              style={{ backgroundColor: COLOR_TITLEBAR, borderBottom: `1px solid ${COLOR_BORDER}` }}
            >
              <span className="text-[12px] font-bold tracking-wider" style={{ color: '#a1a1aa' }}>
                PrintStream Console
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close console"
                className="flex h-11 w-11 items-center justify-center text-[20px] leading-none"
                style={{ color: '#a1a1aa' }}
              >
                ×
              </button>
            </div>
          ) : (
            <div
              onMouseDown={(e) => startDrag(e, 'move')}
              onDoubleClick={resetPosition}
              className="flex justify-between items-center px-3 py-1.5 cursor-move select-none shrink-0"
              style={{ backgroundColor: COLOR_TITLEBAR, borderBottom: `1px solid ${COLOR_BORDER}` }}
              title="Drag to move · Double-click to reset"
            >
              <div className="flex items-center gap-2">
                <div className="flex gap-1.5">
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={onClose}
                    className="w-3 h-3 rounded-full bg-red-500/80 hover:bg-red-500 transition-colors"
                    title="Close"
                    aria-label="Close console"
                  />
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => setMinimized((m) => !m)}
                    className="w-3 h-3 rounded-full bg-yellow-500/80 hover:bg-yellow-500 transition-colors"
                    title={minimized ? 'Restore' : 'Minimize'}
                  />
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={resetPosition}
                    className="w-3 h-3 rounded-full bg-green-500/80 hover:bg-green-500 transition-colors"
                    title="Reset position"
                  />
                </div>
                <span
                  className="text-[11px] font-bold tracking-wider ml-2"
                  style={{ color: '#a1a1aa' }}
                >
                  PrintStream Developer Console
                </span>
              </div>
              <span className="text-[10px] hidden sm:block" style={{ color: '#52525b' }}>
                ` toggle · ESC close
              </span>
            </div>
          )}

          {!minimized && (
            <>
              <div
                className="flex-1 overflow-y-auto text-[12.5px] leading-relaxed py-1.5 px-3 whitespace-pre-wrap break-words"
                style={{ color: '#e4e4e7', backgroundColor: COLOR_BG }}
              >
                {history.map((line, idx) => (
                  <div key={idx}>{line}</div>
                ))}
              </div>
              <div
                className="flex items-center px-3 py-1.5 shrink-0"
                style={{ backgroundColor: COLOR_BG, borderTop: `1px solid ${COLOR_BORDER}` }}
              >
                <span className="mr-2 text-sm" style={{ color: '#71717a' }}>
                  $
                </span>
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      executeCommand(input);
                      setInput('');
                    } else if (e.key === 'Escape') {
                      onClose();
                      (document.activeElement as HTMLElement)?.blur();
                    } else {
                      handleInputKeyDown(e);
                    }
                  }}
                  aria-label="Console command"
                  enterKeyHint="send"
                  autoCapitalize="off"
                  autoCorrect="off"
                  placeholder={
                    sheet
                      ? 'try: ver · help · calc 2+2'
                      : 'try: "show revenue" · "delete transactions" · calc 2+2'
                  }
                  // 16px on phones so iOS does not zoom the page on focus.
                  className={`flex-1 min-w-0 bg-transparent border-none outline-none font-mono py-1 ${sheet ? 'text-[16px] py-2' : 'text-[13px]'}`}
                  style={{ color: '#ffffff' }}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              {!sheet && (
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    startDrag(e, 'resize');
                  }}
                  className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize z-10"
                  title="Resize"
                  style={{
                    background:
                      'linear-gradient(135deg, transparent 55%, rgba(255,255,255,0.35) 55%, rgba(255,255,255,0.35) 65%, transparent 65%, transparent 75%, rgba(255,255,255,0.35) 75%, rgba(255,255,255,0.35) 85%, transparent 85%)',
                  }}
                />
              )}
            </>
          )}
        </div>
      )}

      {dinoOpen && <DinoGame onClose={() => setDinoOpen(false)} />}
    </>
  );
}
