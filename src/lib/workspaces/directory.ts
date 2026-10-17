'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/data/client';
import { useAuth } from '@/contexts/AuthContext';
import { isWorkspaceRole, type WorkspaceRole } from '@/app/erp/lib/erpRules';
import {
  ACTIVE_WORKSPACE_KEY,
  WORKSPACE_CHANGED_EVENT,
  readActiveWorkspaceId,
} from '@/lib/console/bridge';
import { MAX_ERPS_PER_ACCOUNT } from './limits';

export interface ErpSummary {
  id: string;
  name: string;
  role: WorkspaceRole;
  isOwner: boolean;
  isPersonal: boolean;
  ownerEmail: string;
  /** PrintStream Terminal is added to this ERP (Dashboard → Add modules). */
  terminal: boolean;
  /** The caller may add or remove Terminal here (Owner or Admin). */
  canManageTerminal: boolean;
}

export interface ErpQuota {
  used: number;
  limit: number;
  canJoin: boolean;
}

export function rememberActiveWorkspace(id: string) {
  try {
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
  } catch {
    // Storage can be unavailable (private mode); the choice just isn't remembered.
  }
  window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT));
}

export function useErpDirectory() {
  const { user } = useAuth();
  const userId: string | undefined = user?.id;
  const [erps, setErps] = useState<ErpSummary[]>([]);
  const [quota, setQuota] = useState<ErpQuota | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async (): Promise<ErpSummary[]> => {
    if (!userId) return [];
    const db = createClient();
    const [list, limits, terminals, spaces] = await Promise.all([
      db.rpc('erp_my_workspaces'),
      db.rpc('erp_my_workspace_quota'),
      db.rpc('erp_my_terminals'),
      db.rpc('ps_my_spaces'),
    ]);
    // Terminals on their own are not ERPs (older database: there are none).
    const terminalOnly = new Set<string>(
      spaces.error || !Array.isArray(spaces.data)
        ? []
        : spaces.data.filter((r: any) => r.kind === 'terminal').map((r: any) => r.workspace_id)
    );
    if (list.error) {
      setFailed(true);
      setReady(true);
      return [];
    }
    const rows: ErpSummary[] = (list.data || [])
      .filter((row: any) => isWorkspaceRole(row.role) && !terminalOnly.has(row.workspace_id))
      .map((row: any) => {
        // Without the function (older database) Terminal shows as not added.
        const term = terminals.error
          ? null
          : (terminals.data || []).find((x: any) => x.workspace_id === row.workspace_id);
        return {
          id: row.workspace_id,
          name: row.name,
          role: row.role,
          isOwner: !!row.is_owner,
          isPersonal: !!row.is_personal,
          ownerEmail: row.owner_email || '',
          terminal: term?.enabled === true,
          canManageTerminal: term?.can_manage === true,
        };
      });
    // Without the quota function (older database) the app's copy of the limit applies.
    const q =
      limits.error || !limits.data
        ? {
            used: rows.length,
            limit: MAX_ERPS_PER_ACCOUNT,
            canJoin: rows.length < MAX_ERPS_PER_ACCOUNT,
          }
        : {
            used: Number(limits.data.used),
            limit: Number(limits.data.limit),
            canJoin: limits.data.can_join === true,
          };
    const stored = readActiveWorkspaceId();
    setErps(rows);
    setQuota(q);
    setActiveId(
      rows.find((w) => w.id === stored)?.id ??
        rows.find((w) => w.isOwner && w.isPersonal)?.id ??
        rows[0]?.id ??
        null
    );
    setFailed(false);
    setReady(true);
    return rows;
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setErps([]);
      setQuota(null);
      setActiveId(null);
      setReady(false);
      return;
    }
    void refresh();
  }, [userId, refresh]);

  // Another tab or the ERP chose a different ERP.
  useEffect(() => {
    const sync = () => {
      const stored = readActiveWorkspaceId();
      setActiveId((current) => (stored && erps.some((w) => w.id === stored) ? stored : current));
    };
    window.addEventListener(WORKSPACE_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(WORKSPACE_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [erps]);

  const select = useCallback((id: string) => {
    rememberActiveWorkspace(id);
    setActiveId(id);
  }, []);

  return { ready, failed, erps, quota, activeId, refresh, select };
}

export type ErpDirectory = ReturnType<typeof useErpDirectory>;
