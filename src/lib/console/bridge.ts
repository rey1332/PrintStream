'use client';

import { useEffect, useSyncExternalStore } from 'react';

export interface ConsoleMetrics {
  totalRevenue: number;
  totalExpenses: number;
  cashBalance: number;
  inventoryValue: number;
  accountsReceivable: number;
  accountsPayable: number;
}

export interface ConsolePageContext {
  metrics?: ConsoleMetrics;
  onDataChange?: () => void;
}

let current: ConsolePageContext = {};
const listeners = new Set<() => void>();

function set(next: ConsolePageContext) {
  current = next;
  for (const listener of listeners) listener();
}

export function useConsolePageContext(context: ConsolePageContext): void {
  const { metrics, onDataChange } = context;
  useEffect(() => {
    const mine = { metrics, onDataChange };
    set(mine);
    return () => {
      if (current === mine) set({});
    };
  }, [metrics, onDataChange]);
}

export function useConsolePage(): ConsolePageContext {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current
  );
}

export const ACTIVE_WORKSPACE_KEY = 'etna.erp.activeWorkspace';
export const WORKSPACE_CHANGED_EVENT = 'etna:workspace-changed';

export function readActiveWorkspaceId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_WORKSPACE_KEY);
  } catch {
    return null;
  }
}
