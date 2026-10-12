'use client';

import type { MemberRole, Permission } from './erpRules';

export const WORKSPACES_ENABLED = process.env.NEXT_PUBLIC_ERP_WORKSPACES !== 'off';

export interface ActiveWorkspace {
  id: string;
  name: string;
  role: MemberRole;
  /** Effective permissions (built-in preset or custom role), from the database. */
  permissions: Permission[];
  /** Name of the workspace's custom role, when role is 'custom'. */
  customRoleName: string | null;
  /** Open through an ETNA staff access session until then (20261012000032). */
  staffSessionUntil: string | null;
  ownerId: string;
  isOwner: boolean;
}

let activeWorkspace: ActiveWorkspace | null = null;

export function setActiveWorkspace(workspace: ActiveWorkspace | null) {
  activeWorkspace = workspace;
}

export function getActiveWorkspace(): ActiveWorkspace | null {
  return WORKSPACES_ENABLED ? activeWorkspace : null;
}

export function readScope(userId: string): { column: 'user_id' | 'workspace_id'; value: string } {
  const workspace = getActiveWorkspace();
  return workspace
    ? { column: 'workspace_id', value: workspace.id }
    : { column: 'user_id', value: userId };
}

export function writeOwner(userId: string): { user_id: string; workspace_id?: string } {
  const workspace = getActiveWorkspace();
  return workspace
    ? { user_id: workspace.ownerId, workspace_id: workspace.id }
    : { user_id: userId };
}

export function rpcWorkspaceId(): string | null {
  return getActiveWorkspace()?.id ?? null;
}

export function realtimeFilter(userId: string): string {
  const scope = readScope(userId);
  return `${scope.column}=eq.${scope.value}`;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
