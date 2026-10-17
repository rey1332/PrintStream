'use client';

// The Terminals the signed-in person can open (20261012000043): Terminals on
// their own (kind 'terminal') and ERPs with Terminal added. The Terminal
// screen remembers its own choice, apart from the ERP's.

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/data/client';
import { useAuth } from '@/contexts/AuthContext';

export interface TerminalSpace {
  id: string;
  name: string;
  /** 'terminal': a Terminal on its own; 'erp': an ERP with Terminal added. */
  kind: 'terminal' | 'erp';
  role: string;
  isOwner: boolean;
  /** Owner or Admin: may rename, invite, remove (and, for an ERP, remove Terminal). */
  canManage: boolean;
}

const ACTIVE_KEY = 'etna.terminal.activeSpace';
const CHANGED_EVENT = 'etna:terminal-space-changed';

function readActive(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function rememberTerminalSpace(id: string) {
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // Not remembered (private mode).
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

/** Ids of the caller's Terminals (kind 'terminal'), for leaving them out of ERP lists. */
export async function terminalSpaceIds(): Promise<Set<string>> {
  const { data, error } = await createClient().rpc('ps_my_spaces');
  // Older database: there are no Terminals on their own.
  if (error || !Array.isArray(data)) return new Set();
  return new Set(
    data.filter((r: any) => r.kind === 'terminal').map((r: any) => String(r.workspace_id))
  );
}

export function useTerminalSpaces() {
  const { user } = useAuth();
  const userId: string | undefined = user?.id;
  const [spaces, setSpaces] = useState<TerminalSpace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async (): Promise<TerminalSpace[]> => {
    if (!userId) return [];
    const { data, error } = await createClient().rpc('ps_my_spaces');
    const rows: TerminalSpace[] =
      error || !Array.isArray(data)
        ? []
        : data
            .filter((r: any) => r.kind === 'terminal' || r.terminal_on === true)
            .map((r: any) => ({
              id: String(r.workspace_id),
              name: String(r.name ?? ''),
              kind: r.kind === 'terminal' ? 'terminal' : 'erp',
              role: String(r.role ?? ''),
              isOwner: r.is_owner === true,
              canManage: r.can_manage === true,
            }));
    const stored = readActive();
    setSpaces(rows);
    setActiveId(rows.find((s) => s.id === stored)?.id ?? rows[0]?.id ?? null);
    setReady(true);
    return rows;
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setSpaces([]);
      setActiveId(null);
      setReady(false);
      return;
    }
    void refresh();
  }, [userId, refresh]);

  // Chosen in another tab, or in the sidebar while the screen is open.
  useEffect(() => {
    const sync = () => {
      const stored = readActive();
      // A Terminal created elsewhere (the sidebar, Add modules): load the list again.
      if (stored && !spaces.some((s) => s.id === stored)) void refresh();
      else setActiveId((current) => stored ?? current);
    };
    window.addEventListener(CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [spaces, refresh]);

  const select = useCallback((id: string) => {
    rememberTerminalSpace(id);
    setActiveId(id);
  }, []);

  return { ready, spaces, activeId, refresh, select };
}

export type TerminalSpaces = ReturnType<typeof useTerminalSpaces>;
