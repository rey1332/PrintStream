type RestResultLike = { data: unknown; error: { code?: string } | null; count?: number | null };
interface QueryLike extends PromiseLike<RestResultLike> {
  eq(column: string, value: unknown): QueryLike;
}
export interface ConsoleDb {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RestResultLike>;
  from(table: string): {
    select(columns: string, options?: { count?: 'exact'; head?: boolean }): QueryLike;
  };
}

export type ConsoleRole = 'owner' | 'finance';
export type ConsoleAccess =
  | { allowed: true; role: ConsoleRole; workspaceId: string }
  | { allowed: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function consoleAllowed(role: unknown, activeMembers: number): role is ConsoleRole {
  if (role === 'finance') return true;
  if (role === 'owner') return activeMembers >= 2;
  return false;
}

interface MembershipRow {
  workspace_id: string;
  role: string;
  is_owner: boolean;
  is_personal: boolean;
}

export async function resolveConsoleAccess(
  db: ConsoleDb,
  requestedWorkspaceId: unknown
): Promise<ConsoleAccess> {
  const { data, error } = await db.rpc('erp_my_workspaces');
  if (error || !Array.isArray(data)) return { allowed: false };
  const rows = data as MembershipRow[];
  const requested =
    typeof requestedWorkspaceId === 'string' && UUID.test(requestedWorkspaceId)
      ? rows.find((row) => row.workspace_id === requestedWorkspaceId)
      : undefined;
  const workspace = requested ?? rows.find((row) => row.is_owner && row.is_personal) ?? rows[0];
  if (!workspace) return { allowed: false };

  let activeMembers = 0;
  if (workspace.role === 'owner') {
    const counted = await db
      .from('erp_workspace_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('workspace_id', workspace.workspace_id)
      .eq('status', 'active');
    activeMembers = counted.error ? 0 : Number(counted.count ?? 0);
  }
  return consoleAllowed(workspace.role, activeMembers)
    ? { allowed: true, role: workspace.role, workspaceId: workspace.workspace_id }
    : { allowed: false };
}
