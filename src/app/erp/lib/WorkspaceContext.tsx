'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/data/client';
import { useAuth } from '@/contexts/AuthContext';
import {
  can as hasPermission,
  isMemberRole,
  isWorkspaceRole,
  permissionsOf,
  type Capability,
  type MemberRole,
  type WorkspaceRole,
} from './erpRules';
import { WORKSPACES_ENABLED, setActiveWorkspace, type ActiveWorkspace } from './workspace';
import { accountingService } from './accountingService';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { ACTIVE_WORKSPACE_KEY, WORKSPACE_CHANGED_EVENT } from '@/lib/console/bridge';
import { isIndustry, parseModules, type Industry, type ModuleCode } from '@/lib/industry';
import { terminalSpaceIds } from '@/lib/workspaces/terminalSpaces';

export interface WorkspaceSummary extends ActiveWorkspace {
  isPersonal: boolean;
  ownerEmail: string;
  /** Suspended by ETNA: its data cannot be opened until it is reactivated. */
  suspended: boolean;
  /** This ERP needs a two-factor session that the current one is not (20261012000022). */
  needsTwoFactor: 'role' | 'erp' | null;
  /** Industry template and optional modules (20261012000023). */
  industry: Industry;
  modules: ModuleCode[];
  /** Built-in roles this member may give (custom roles are checked by the database). */
  grantableRoles: WorkspaceRole[];
}

interface WorkspaceContextValue {
  enabled: boolean;
  ready: boolean;
  unavailableReason: 'disabled' | 'unavailable' | null;
  workspaces: WorkspaceSummary[];
  active: WorkspaceSummary | null;
  role: MemberRole;
  can: (capability: Capability) => boolean;
  /** Is this optional module switched on in the active ERP? */
  hasModule: (module: ModuleCode) => boolean;
  hr: HrAccess;
  hrReady: boolean;
  refreshHr: () => void;
  selectWorkspace: (id: string) => void;
  refresh: () => Promise<void>;
}

export interface HrAccess {
  canManage: boolean;
  canRecord: boolean;
  canConfigure: boolean;
  attendanceRoles: WorkspaceRole[];
}

const NO_HR: HrAccess = {
  canManage: false,
  canRecord: false,
  canConfigure: false,
  attendanceRoles: [],
};

async function loadHrAccess(workspaceId: string | null): Promise<HrAccess> {
  const { data, error } = await createClient().rpc('erp_hr_access', {
    p_workspace_id: workspaceId,
  });
  // Missing function = HR migration not applied: no HR menus.
  if (error || !data) return NO_HR;
  return {
    canManage: data.can_manage === true,
    canRecord: data.can_record === true,
    canConfigure: data.can_configure === true,
    attendanceRoles: Array.isArray(data.attendance_roles)
      ? data.attendance_roles.filter(isWorkspaceRole)
      : [],
  };
}

const STORAGE_KEY = ACTIVE_WORKSPACE_KEY;

function readStoredWorkspace(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeWorkspace(id: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage can be unavailable (private mode); the choice just isn't remembered.
  }
  // The app-wide console re-checks its access for the new workspace.
  window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT));
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * The active workspace, its rights and modules. In the ERP: the ERPs the
 * person belongs to (not Terminals on their own), the choice remembered for
 * the ERP. With `workspaceId` (the Terminal screen): exactly that workspace,
 * an ERP or a Terminal, without changing the ERP's choice.
 */
export function WorkspaceProvider({
  children,
  workspaceId,
}: {
  children: React.ReactNode;
  workspaceId?: string;
}) {
  const { user } = useAuth();
  const userId: string | undefined = user?.id;
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(!WORKSPACES_ENABLED);
  const [unavailableReason, setUnavailableReason] = useState<'disabled' | 'unavailable' | null>(
    WORKSPACES_ENABLED ? null : 'disabled'
  );

  const refresh = useCallback(async () => {
    if (!WORKSPACES_ENABLED || !userId) return;
    const { data, error } = await createClient().rpc('erp_my_workspaces');
    if (error) {
      // Missing function = migration not applied yet; fall back to legacy mode.
      setUnavailableReason('unavailable');
      setWorkspaces([]);
      setActiveWorkspace(null);
      setReady(true);
      return;
    }
    // Missing function = suspension not installed yet: nothing is suspended.
    const { data: suspendedIds } = await createClient().rpc('erp_my_suspended_workspaces');
    const suspended = new Set<string>(
      Array.isArray(suspendedIds) ? suspendedIds.map((r: any) => String(r.workspace_id)) : []
    );
    // Missing function = role rule not installed yet: only the ERP-wide switch applies.
    const { data: mfaRows } = await createClient().rpc('erp_my_mfa_required_workspaces');
    const needsTwoFactor = new Map<string, 'role' | 'erp'>(
      Array.isArray(mfaRows)
        ? mfaRows.map((r: any) => [String(r.workspace_id), r.by_role ? 'role' : 'erp'])
        : []
    );
    // Missing function = modules not installed yet: General, no modules.
    const { data: moduleRows } = await createClient().rpc('erp_my_workspace_modules');
    const modules = new Map<string, { industry: Industry; modules: ModuleCode[] }>(
      Array.isArray(moduleRows)
        ? moduleRows.map((r: any) => [
            String(r.workspace_id),
            {
              industry: isIndustry(r.industry) ? r.industry : 'general',
              modules: parseModules(r.modules),
            },
          ])
        : []
    );
    // Missing function = custom roles not installed yet: built-in presets apply.
    const { data: accessRows } = await createClient().rpc('erp_my_workspace_access');
    const access = new Map<string, any>(
      Array.isArray(accessRows) ? accessRows.map((r: any) => [String(r.workspace_id), r]) : []
    );
    const terminalOnly = workspaceId ? new Set<string>() : await terminalSpaceIds();
    const rows: WorkspaceSummary[] = (data || [])
      .filter(
        (row: any) =>
          isMemberRole(row.role) &&
          (workspaceId ? row.workspace_id === workspaceId : !terminalOnly.has(row.workspace_id))
      )
      .map((row: any) => ({
        id: row.workspace_id,
        name: row.name,
        role: row.role,
        permissions: permissionsOf(row.role, access.get(row.workspace_id)?.permissions ?? null),
        customRoleName: access.get(row.workspace_id)?.custom_role_name ?? null,
        staffSessionUntil: access.get(row.workspace_id)?.staff_session_until ?? null,
        grantableRoles: Array.isArray(access.get(row.workspace_id)?.grantable_roles)
          ? access.get(row.workspace_id).grantable_roles.filter(isWorkspaceRole)
          : [],
        ownerId: row.owner_id,
        isOwner: !!row.is_owner,
        isPersonal: !!row.is_personal,
        ownerEmail: row.owner_email || '',
        suspended: suspended.has(row.workspace_id),
        needsTwoFactor: needsTwoFactor.get(row.workspace_id) ?? null,
        industry: modules.get(row.workspace_id)?.industry ?? 'general',
        modules: modules.get(row.workspace_id)?.modules ?? [],
      }));
    setUnavailableReason(null);
    setWorkspaces(rows);
    setActiveId((current) => {
      if (workspaceId) return rows.some((w) => w.id === workspaceId) ? workspaceId : null;
      const preferred = current ?? readStoredWorkspace();
      const chosen =
        rows.find((w) => w.id === preferred) ??
        rows.find((w) => w.isOwner && w.isPersonal) ??
        rows[0];
      return chosen?.id ?? null;
    });
    setReady(true);
  }, [userId, workspaceId]);

  useEffect(() => () => setActiveWorkspace(null), []);

  useEffect(() => {
    if (!userId) {
      setWorkspaces([]);
      setActiveId(null);
      setActiveWorkspace(null);
      return;
    }
    void refresh();
  }, [userId, refresh]);

  const active = useMemo(
    () => (unavailableReason ? null : (workspaces.find((w) => w.id === activeId) ?? null)),
    [workspaces, activeId, unavailableReason]
  );

  // Keep the service-layer scope in sync before children render with it.
  setActiveWorkspace(active);

  // Amounts everywhere are shown in the active workspace's base currency.
  const { setCurrency } = useI18n();
  const scopeKey =
    WORKSPACES_ENABLED && !unavailableReason ? (ready ? (active?.id ?? 'none') : null) : 'personal';
  useEffect(() => {
    if (!userId || scopeKey === null || scopeKey === 'none') return;
    let cancelled = false;
    accountingService
      .settings()
      .then((s) => {
        if (!cancelled) setCurrency(s.baseCurrency);
      })
      .catch(() => undefined); // Ledger not installed yet: keep the current notation.
    return () => {
      cancelled = true;
    };
  }, [userId, scopeKey, setCurrency]);

  // HR access depends on the workspace's settings, not only on the role.
  const [hr, setHr] = useState<HrAccess>(NO_HR);
  const [hrReady, setHrReady] = useState(false);
  const [hrVersion, setHrVersion] = useState(0);
  const hrWorkspaceId = active?.id ?? null;
  useEffect(() => {
    if (!userId || scopeKey === null) return;
    if (scopeKey === 'none') {
      setHr(NO_HR);
      setHrReady(true);
      return;
    }
    let cancelled = false;
    setHrReady(false);
    loadHrAccess(hrWorkspaceId)
      .then((access) => {
        if (!cancelled) setHr(access);
      })
      .catch(() => {
        if (!cancelled) setHr(NO_HR);
      })
      .finally(() => {
        if (!cancelled) setHrReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, scopeKey, hrWorkspaceId, hrVersion]);
  const refreshHr = useCallback(() => setHrVersion((v) => v + 1), []);

  const selectWorkspace = useCallback(
    (id: string) => {
      // The Terminal screen chooses its workspace itself.
      if (workspaceId) return;
      storeWorkspace(id);
      setActiveId(id);
    },
    [workspaceId]
  );

  const value = useMemo<WorkspaceContextValue>(() => {
    // Legacy mode: the signed-in user owns everything they can see.
    const role: MemberRole = active?.role ?? 'owner';
    const permissions = active ? active.permissions : permissionsOf('owner');
    return {
      enabled: WORKSPACES_ENABLED && !unavailableReason,
      ready,
      unavailableReason,
      workspaces,
      active,
      role,
      can: (capability: Capability) =>
        capability === 'hr.manage'
          ? hr.canManage
          : capability === 'hr.record'
            ? hr.canRecord
            : hasPermission(permissions, capability),
      hasModule: (module: ModuleCode) => !!active?.modules.includes(module),
      hr,
      hrReady,
      refreshHr,
      selectWorkspace,
      refresh,
    };
  }, [
    active,
    ready,
    unavailableReason,
    workspaces,
    selectWorkspace,
    refresh,
    hr,
    hrReady,
    refreshHr,
  ]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return context;
}
