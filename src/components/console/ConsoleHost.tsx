'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { usePathname } from 'next/navigation';
import { TerminalSquare } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useUiMode } from '@/lib/ui/UiModeProvider';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { DevConsole } from '@/components/ui/DevConsole';
import {
  ACTIVE_WORKSPACE_KEY,
  readActiveWorkspaceId,
  WORKSPACE_CHANGED_EVENT,
} from '@/lib/console/bridge';
import { shouldToggleConsole } from '@/lib/console/shortcut';

// Sign-in and second-step pages never show the console.
const HIDDEN_PREFIXES = ['/login', '/erp/login', '/mfa'];

interface ConsoleState {
  available: boolean;
  open: boolean;
  toggle: () => void;
}

const ConsoleContext = createContext<ConsoleState>({
  available: false,
  open: false,
  toggle: () => {},
});

export function ConsoleProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname() ?? '/';
  const [allowed, setAllowed] = useState(false);
  const [open, setOpen] = useState(false);
  const request = useRef(0);

  const hidden =
    !user ||
    HIDDEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  const available = allowed && !hidden;

  const checkAccess = useCallback(async () => {
    const id = ++request.current;
    let next = false;
    try {
      const workspace = readActiveWorkspaceId();
      const response = await fetch(
        `/api/console${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`,
        { cache: 'no-store' }
      );
      const body = await response.json().catch(() => null);
      next = response.ok && body?.success === true && body.data?.allowed === true;
    } catch {
      next = false;
    }
    if (id !== request.current) return; // a newer check superseded this one
    setAllowed(next);
    if (!next) setOpen(false);
  }, []);

  // Re-check for a new user, and when the ERP workspace changes (this tab or another).
  useEffect(() => {
    if (hidden) {
      request.current += 1;
      setAllowed(false);
      setOpen(false);
      return;
    }
    void checkAccess();
    const recheck = () => void checkAccess();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === ACTIVE_WORKSPACE_KEY) recheck();
    };
    window.addEventListener(WORKSPACE_CHANGED_EVENT, recheck);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(WORKSPACE_CHANGED_EVENT, recheck);
      window.removeEventListener('storage', onStorage);
    };
  }, [hidden, user?.id, checkAccess]);

  // Backtick toggles the console — not while typing in a field.
  useEffect(() => {
    if (!available) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !shouldToggleConsole(event)) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [available]);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const state = useMemo(
    () => ({ available, open: open && available, toggle }),
    [available, open, toggle]
  );

  return (
    <ConsoleContext.Provider value={state}>
      {children}
      {available && <DevConsole open={open} onClose={close} />}
    </ConsoleContext.Provider>
  );
}

export function ConsoleButton({ className }: { className?: string }) {
  const { available, open, toggle } = useContext(ConsoleContext);
  const { isDesktop } = useUiMode();
  const { t } = useI18n();
  if (!available || isDesktop) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t('console.open')}
      aria-pressed={open}
      title={t('console.open')}
      className={
        className ??
        'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:bg-surface-3 hover:text-foreground'
      }
    >
      <TerminalSquare size={16} aria-hidden />
    </button>
  );
}
