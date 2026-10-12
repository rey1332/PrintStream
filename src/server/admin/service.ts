// Platform administration (the internal admin panel at /admin).
//
// Every call runs as the signed-in admin (role `authenticated`, their claims
// including the session id) and goes through the etna_platform functions,
// which check the admin role, the two-factor session and — for changes — a
// fresh re-authentication themselves, and write the security log. This module
// never touches auth.* or the log directly.
// See db/migrations/20261012000011_platform_admin_security_log.sql.

import { linkTokenHash, newLinkToken, type SessionInfo } from '@/server/auth/service';
import { identityOf } from '@/server/auth/request';
import { beginAsUser, getCatalog } from '@/server/db/execute';
import type { Executor, SqlTx } from '@/server/db/executor';

export const ADMIN_ROLES = ['super_admin', 'support', 'auditor', 'security_officer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const isAdminRole = (value: unknown): value is AdminRole =>
  typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export type AdminErrorCode =
  | 'not_allowed'
  | 'mfa_required'
  | 'reauth_required'
  | 'self'
  | 'not_found'
  | 'invalid'
  | 'exists'
  | 'already'
  | 'placeholder'
  | 'owner'
  | 'workspace_limit'
  | 'closed'
  | 'confirm'
  | 'is_admin'
  | 'owns_workspace'
  | 'personal'
  | 'not_member'
  | 'too_early'
  | 'legal_hold'
  | 'not_confirmed'
  | 'blocked'
  | 'failed';

export class AdminError extends Error {
  readonly code: AdminErrorCode;
  constructor(code: AdminErrorCode) {
    super(code);
    this.code = code;
  }
}

export const adminErrorStatus = (code: AdminErrorCode): number =>
  code === 'not_allowed' || code === 'mfa_required' || code === 'reauth_required'
    ? 403
    : code === 'not_found'
      ? 404
      : code === 'exists' || code === 'already' || code === 'closed'
        ? 409
        : code === 'failed'
          ? 500
          : 400;

function toAdminError(error: unknown): AdminError {
  const e = error as { code?: string; hint?: string };
  if (e?.code === '42501') {
    if (e.hint === 'reauth_required') return new AdminError('reauth_required');
    if (e.hint === 'mfa_required') return new AdminError('mfa_required');
    return new AdminError('not_allowed');
  }
  if (e?.code === 'P0002') return new AdminError('not_found');
  if (e?.code === 'P0001' && e.hint === 'self') return new AdminError('self');
  if (e?.code === 'P0001' && e.hint === 'already') return new AdminError('already');
  if (e?.code === 'P0001' && e.hint === 'placeholder') return new AdminError('placeholder');
  if (e?.code === 'P0001' && e.hint === 'owner') return new AdminError('owner');
  if (e?.code === 'P0001' && e.hint === 'workspace_limit') return new AdminError('workspace_limit');
  const hinted = [
    'closed',
    'confirm',
    'is_admin',
    'owns_workspace',
    'personal',
    'not_member',
    'too_early',
    'legal_hold',
    'not_confirmed',
    'blocked',
  ] as const;
  const hint = hinted.find((h) => h === e?.hint);
  if (e?.code === 'P0001' && hint) return new AdminError(hint);
  if (e?.code === '23505') return new AdminError('exists');
  if (e?.code === '22023' || e?.code?.startsWith('22') || e?.code === '23514')
    return new AdminError('invalid');
  console.error('[admin]', e?.code || 'error');
  return new AdminError('failed');
}

export async function asAdmin<T>(
  executor: Executor,
  session: SessionInfo,
  path: string,
  meta: RequestMeta,
  fn: (tx: SqlTx) => Promise<T>
): Promise<T> {
  try {
    const catalog = await getCatalog(executor);
    return await executor.transaction(async (tx) => {
      await beginAsUser(tx, identityOf(session), path, 'POST', catalog);
      // The address and browser of this request, for the security log.
      await tx.query(
        `select set_config('request.ip', $1, true), set_config('request.user_agent', $2, true)`,
        [meta.ip?.slice(0, 64) ?? '', meta.userAgent?.slice(0, 400) ?? '']
      );
      return fn(tx);
    });
  } catch (error) {
    throw toAdminError(error);
  }
}

const NO_META: RequestMeta = { ip: null, userAgent: null };

/** The session's platform admin role, or null (also when it cannot be read). */
export async function adminRoleOf(
  executor: Executor,
  session: SessionInfo
): Promise<AdminRole | null> {
  try {
    const role = await asAdmin(executor, session, '/admin', NO_META, async (tx) => {
      const { rows } = await tx.query('select etna_platform.my_admin_role() as role');
      return rows[0]?.role as unknown;
    });
    return isAdminRole(role) ? role : null;
  } catch {
    return null;
  }
}

export interface AdminAccount {
  user_id: string;
  email: string;
  full_name: string;
  role: AdminRole;
  granted_at: string;
  granted_by_email: string | null;
  mfa_enrolled: boolean;
  last_sign_in_at: string | null;
}

export function listAdmins(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta
): Promise<AdminAccount[]> {
  return asAdmin(executor, session, '/admin/admins', meta, async (tx) => {
    const { rows } = await tx.query('select * from etna_platform.admin_list_admins()');
    return rows as AdminAccount[];
  });
}

export function setAdminRole(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  email: string,
  role: AdminRole
): Promise<void> {
  return asAdmin(executor, session, '/admin/admins', meta, async (tx) => {
    await tx.query('select etna_platform.admin_set_role($1, $2)', [email, role]);
  });
}

export function revokeAdmin(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  email: string
): Promise<void> {
  return asAdmin(executor, session, '/admin/admins', meta, async (tx) => {
    await tx.query('select etna_platform.admin_revoke_role($1)', [email]);
  });
}

export interface SecurityEvent {
  id: string;
  occurred_at: string;
  event_type: string;
  outcome: 'success' | 'failure';
  actor_kind: 'user' | 'admin' | 'cli' | 'system';
  actor_user_id: string | null;
  actor_email: string | null;
  target_user_id: string | null;
  target_email: string | null;
  workspace_id: string | null;
  session_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

export interface EventFilters {
  beforeId: string | null;
  limit: number;
  eventType: string | null;
  query: string | null;
  outcome: 'success' | 'failure' | null;
  from: string | null;
  to: string | null;
  userId: string | null;
  workspaceId: string | null;
}

export function listSecurityEvents(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  filters: EventFilters
): Promise<SecurityEvent[]> {
  return asAdmin(executor, session, '/admin/security-log', meta, async (tx) => {
    const { rows } = await tx.query(
      'select * from etna_platform.admin_security_events($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        filters.beforeId,
        filters.limit,
        filters.eventType,
        filters.query,
        filters.outcome,
        filters.from,
        filters.to,
        filters.userId,
        filters.workspaceId,
      ]
    );
    // BIGINT ids travel as strings (exact beyond 2^53).
    return rows.map((row) => ({ ...row, id: String(row.id) })) as SecurityEvent[];
  });
}

// ─── Accounts ────────────────────────────────────────────────────────────────

export type UserFilter = 'all' | 'disabled' | 'closed' | 'no_mfa' | 'admins';
export const USER_SORTS = [
  'created_desc',
  'created_asc',
  'last_sign_in_desc',
  'email_asc',
] as const;
export type UserSort = (typeof USER_SORTS)[number];

export interface UserMembership {
  workspace_id: string;
  name: string;
  role: string;
}

export interface UserRow {
  user_id: string;
  email: string;
  full_name: string;
  created_at: string;
  last_sign_in_at: string | null;
  disabled: boolean;
  closed: boolean;
  mfa_enrolled: boolean;
  active_sessions: number;
  workspaces: number;
  memberships: UserMembership[];
  admin_role: AdminRole | null;
}

export interface Page<T> {
  rows: T[];
  total: number;
}

export interface ListQuery<F> {
  query: string | null;
  filter: F;
  limit: number;
  offset: number;
}

export function listUsers(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  list: ListQuery<UserFilter> & { sort?: UserSort }
): Promise<Page<UserRow>> {
  return asAdmin(executor, session, '/admin/users', meta, async (tx) => {
    const { rows } = await tx.query(
      'select * from etna_platform.admin_list_users($1, $2, $3, $4, $5)',
      [list.query, list.filter, list.limit, list.offset, list.sort ?? 'created_desc']
    );
    return {
      rows: rows.map(({ total: _total, ...row }) => row) as UserRow[],
      total: rows.length ? Number(rows[0].total) : 0,
    };
  });
}

export function userDetail(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  userId: string
): Promise<Record<string, unknown>> {
  return asAdmin(executor, session, '/admin/users', meta, async (tx) => {
    const { rows } = await tx.query(
      'select etna_platform.admin_user_detail($1) as detail, etna_platform.admin_user_closure($1) as closure',
      [userId]
    );
    return { ...(rows[0].detail as Record<string, unknown>), closure: rows[0].closure ?? null };
  });
}

export type UserAction =
  | { action: 'disable'; reason: string }
  | { action: 'enable' }
  | { action: 'end_sessions'; sessionId: string | null }
  | { action: 'reset_mfa'; verification: string }
  | { action: 'close'; reason: string; confirmEmail: string };

export function changeUser(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  userId: string,
  change: UserAction
): Promise<void> {
  return asAdmin(executor, session, '/admin/users', meta, async (tx) => {
    switch (change.action) {
      case 'disable':
        await tx.query('select etna_platform.admin_disable_user($1, $2)', [userId, change.reason]);
        break;
      case 'enable':
        await tx.query('select etna_platform.admin_enable_user($1)', [userId]);
        break;
      case 'end_sessions':
        await tx.query('select etna_platform.admin_end_sessions($1, $2)', [
          userId,
          change.sessionId,
        ]);
        break;
      case 'reset_mfa':
        await tx.query('select etna_platform.admin_reset_mfa($1, $2)', [
          userId,
          change.verification,
        ]);
        break;
      // Not a deletion: the account is shut for good and its details replaced;
      // its records stay (see 20261012000029_platform_admin_close_account.sql).
      case 'close':
        await tx.query('select etna_platform.admin_close_account($1, $2, $3)', [
          userId,
          change.reason,
          change.confirmEmail,
        ]);
        break;
    }
  });
}

export interface IssuedLink {
  url: string;
  purpose: 'reset' | 'invite';
  expires_at: string;
  user_id?: string;
}

// The token exists only here and in the answer to the admin; the database
// keeps its SHA-256. It goes after "#" so it never reaches a server log.
function linkFor(origin: string, token: string): string {
  return `${origin}/reset-password#token=${token}`;
}

export function createResetLink(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  origin: string,
  userId: string
): Promise<IssuedLink> {
  const token = newLinkToken();
  return asAdmin(executor, session, '/admin/users', meta, async (tx) => {
    const { rows } = await tx.query(
      'select etna_platform.admin_create_reset_link($1, $2) as link',
      [userId, linkTokenHash(token)]
    );
    return { url: linkFor(origin, token), purpose: 'reset', expires_at: rows[0].link.expires_at };
  });
}

export function createUser(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  origin: string,
  input: { email: string; name: string }
): Promise<IssuedLink> {
  const token = newLinkToken();
  return asAdmin(executor, session, '/admin/users', meta, async (tx) => {
    const { rows } = await tx.query('select etna_platform.admin_create_user($1, $2, $3) as link', [
      input.email,
      input.name,
      linkTokenHash(token),
    ]);
    const link = rows[0].link;
    return {
      url: linkFor(origin, token),
      purpose: 'invite',
      expires_at: link.expires_at,
      user_id: link.user_id,
    };
  });
}

// ─── Workspaces ──────────────────────────────────────────────────────────────

export type WorkspaceFilter = 'all' | 'suspended' | 'shared' | 'personal';

export interface WorkspaceRow {
  workspace_id: string;
  name: string;
  owner_email: string | null;
  is_personal: boolean;
  members: number;
  created_at: string;
  last_activity: string | null;
  suspended: boolean;
}

export function listWorkspaces(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  list: ListQuery<WorkspaceFilter>
): Promise<Page<WorkspaceRow>> {
  return asAdmin(executor, session, '/admin/workspaces', meta, async (tx) => {
    const { rows } = await tx.query(
      'select * from etna_platform.admin_list_workspaces($1, $2, $3, $4)',
      [list.query, list.filter, list.limit, list.offset]
    );
    return {
      rows: rows.map(({ total: _total, ...row }) => row) as WorkspaceRow[],
      total: rows.length ? Number(rows[0].total) : 0,
    };
  });
}

export function workspaceDetail(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  workspaceId: string
): Promise<Record<string, unknown>> {
  return asAdmin(executor, session, '/admin/workspaces', meta, async (tx) => {
    const { rows } = await tx.query('select etna_platform.admin_workspace_detail($1) as detail', [
      workspaceId,
    ]);
    return rows[0].detail as Record<string, unknown>;
  });
}

export type WorkspaceAction =
  | { action: 'suspend'; reason: string; disableMembers: boolean }
  | { action: 'reactivate'; enableMembers: boolean };

export const GRANTABLE_WORKSPACE_ROLES = ['admin', 'finance', 'sales', 'inventory'] as const;
export type GrantableWorkspaceRole = (typeof GRANTABLE_WORKSPACE_ROLES)[number];

export type WorkspaceAccess =
  | { action: 'grant'; email: string; role: GrantableWorkspaceRole; reason: string }
  | { action: 'remove'; userId: string; reason: string }
  | { action: 'transfer'; userId: string; reason: string };

/** Grants, changes or ends an account's access, or makes a member Owner; returns 'added' | 'changed' | 'unchanged' | 'removed' | 'transferred'. */
export function changeWorkspaceAccess(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  workspaceId: string,
  change: WorkspaceAccess
): Promise<string> {
  return asAdmin(executor, session, '/admin/workspaces', meta, async (tx) => {
    if (change.action === 'transfer') {
      await tx.query('select etna_platform.admin_transfer_ownership($1, $2, $3)', [
        workspaceId,
        change.userId,
        change.reason,
      ]);
      return 'transferred';
    }
    if (change.action === 'remove') {
      await tx.query('select etna_platform.admin_workspace_remove($1, $2, $3)', [
        workspaceId,
        change.userId,
        change.reason,
      ]);
      return 'removed';
    }
    const { rows } = await tx.query(
      'select etna_platform.admin_workspace_grant($1, $2, $3, $4) as result',
      [workspaceId, change.email, change.role, change.reason]
    );
    return String(rows[0].result);
  });
}

export function changeWorkspace(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  workspaceId: string,
  change: WorkspaceAction
): Promise<number> {
  return asAdmin(executor, session, '/admin/workspaces', meta, async (tx) => {
    const { rows } =
      change.action === 'suspend'
        ? await tx.query('select etna_platform.admin_suspend_workspace($1, $2, $3) as n', [
            workspaceId,
            change.reason,
            change.disableMembers,
          ])
        : await tx.query('select etna_platform.admin_reactivate_workspace($1, $2) as n', [
            workspaceId,
            change.enableMembers,
          ]);
    return Number(rows[0].n);
  });
}

// ─── Terms & Conditions ──────────────────────────────────────────────────────

export interface TermsContent {
  en: string;
  id?: string;
  zh?: string;
}

export interface TermsRow {
  id: string;
  label: string;
  status: 'draft' | 'current' | 'previous';
  created_at: string;
  updated_at: string;
  published_at: string | null;
  published_by_email: string | null;
  acceptances: number;
}

export function listTerms(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta
): Promise<TermsRow[]> {
  return asAdmin(executor, session, '/admin/terms', meta, async (tx) => {
    const { rows } = await tx.query('select * from etna_platform.admin_terms_list()');
    return rows.map((row) => ({ ...row, acceptances: Number(row.acceptances) })) as TermsRow[];
  });
}

export function getTerms(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  id: string
): Promise<Record<string, unknown>> {
  return asAdmin(executor, session, '/admin/terms', meta, async (tx) => {
    const { rows } = await tx.query('select etna_platform.admin_terms_get($1) as terms', [id]);
    return rows[0].terms as Record<string, unknown>;
  });
}

/** Saves a draft (id null = new); returns its id. */
export function saveTermsDraft(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  draft: { id: string | null; label: string; content: TermsContent }
): Promise<string> {
  return asAdmin(executor, session, '/admin/terms', meta, async (tx) => {
    const { rows } = await tx.query(
      'select etna_platform.admin_terms_save($1, $2, $3::jsonb) as id',
      [draft.id, draft.label, JSON.stringify(draft.content)]
    );
    return String(rows[0].id);
  });
}

export function changeTerms(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  id: string,
  action: 'publish' | 'delete'
): Promise<void> {
  return asAdmin(executor, session, '/admin/terms', meta, async (tx) => {
    await tx.query(
      action === 'publish'
        ? 'select etna_platform.admin_terms_publish($1)'
        : 'select etna_platform.admin_terms_delete($1)',
      [id]
    );
  });
}

export interface PendingRow {
  user_id: string;
  email: string;
  full_name: string;
  disabled: boolean;
  last_sign_in_at: string | null;
  last_accepted: string | null;
}

export function pendingTerms(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  list: { limit: number; offset: number }
): Promise<Page<PendingRow>> {
  return asAdmin(executor, session, '/admin/terms', meta, async (tx) => {
    const { rows } = await tx.query('select * from etna_platform.admin_terms_pending($1, $2)', [
      list.limit,
      list.offset,
    ]);
    return {
      rows: rows.map(({ total: _total, ...row }) => row) as PendingRow[],
      total: rows.length ? Number(rows[0].total) : 0,
    };
  });
}

export function userTerms(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  userId: string
): Promise<Record<string, unknown>[]> {
  return asAdmin(executor, session, '/admin/users', meta, async (tx) => {
    const { rows } = await tx.query('select * from etna_platform.admin_user_terms($1)', [userId]);
    return rows;
  });
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export const DASHBOARD_HOURS = [24, 168, 720] as const;
export type DashboardHours = (typeof DASHBOARD_HOURS)[number];

/** The /admin numbers for the last 24 hours, 7 or 30 days (etna_platform.admin_dashboard). */
export function dashboard(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  hours: DashboardHours,
  timeZone: string
): Promise<Record<string, unknown>> {
  return asAdmin(executor, session, '/admin', meta, async (tx) => {
    const { rows } = await tx.query('select etna_platform.admin_dashboard($1, $2) as d', [
      hours,
      timeZone,
    ]);
    return rows[0].d as Record<string, unknown>;
  });
}

// ─── Companies, ERP usage, limits, announcements, operations ────────────────
// See db/migrations/20261012000028_platform_admin_operations.sql.

export const INDUSTRIES = ['general', 'quarry', 'trading', 'manufacturing'] as const;
export const MODULES = ['weighbridge', 'production', 'equipment'] as const;

export interface CreatedCompany {
  workspace_id: string;
  user_id: string;
  new_user: boolean;
  url?: string;
  expires_at?: string;
}

/** A new ERP for a client with its Owner; a new Owner account gets an invitation link. */
export function createCompany(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  origin: string,
  input: { name: string; industry: string; ownerEmail: string; ownerName: string; reason: string }
): Promise<CreatedCompany> {
  const token = newLinkToken();
  return asAdmin(executor, session, '/admin/workspaces', meta, async (tx) => {
    const { rows } = await tx.query(
      'select etna_platform.admin_create_company($1, $2, $3, $4, $5, $6) as r',
      [
        input.name,
        input.industry,
        input.ownerEmail,
        input.ownerName,
        linkTokenHash(token),
        input.reason,
      ]
    );
    const r = rows[0].r;
    return {
      workspace_id: r.workspace_id,
      user_id: r.user_id,
      new_user: r.new_user === true,
      ...(r.new_user ? { url: linkFor(origin, token), expires_at: r.expires_at } : {}),
    };
  });
}

export function workspaceUsage(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  workspaceId: string
): Promise<Record<string, unknown>> {
  return asAdmin(executor, session, '/admin/workspaces', meta, async (tx) => {
    const { rows } = await tx.query('select etna_platform.admin_workspace_usage($1) as u', [
      workspaceId,
    ]);
    return rows[0].u as Record<string, unknown>;
  });
}

export function setWorkspaceModules(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  workspaceId: string,
  change: { industry: string; modules: string[]; reason: string }
): Promise<void> {
  return asAdmin(executor, session, '/admin/workspaces', meta, async (tx) => {
    await tx.query('select etna_platform.admin_set_workspace_modules($1, $2, $3, $4)', [
      workspaceId,
      change.industry,
      change.modules,
      change.reason,
    ]);
  });
}

export function accountLimit(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  userId: string
): Promise<Record<string, unknown>> {
  return asAdmin(executor, session, '/admin/users', meta, async (tx) => {
    const { rows } = await tx.query('select etna_platform.admin_account_limit($1) as l', [userId]);
    return rows[0].l as Record<string, unknown>;
  });
}

export function setAccountLimit(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  userId: string,
  limit: number | null,
  reason: string
): Promise<void> {
  return asAdmin(executor, session, '/admin/users', meta, async (tx) => {
    await tx.query('select etna_platform.admin_set_account_limit($1, $2, $3)', [
      userId,
      limit,
      reason,
    ]);
  });
}

export interface AnnouncementRow {
  id: string;
  message: string;
  level: 'info' | 'warning' | 'maintenance';
  workspace_id: string | null;
  workspace_name: string | null;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
  created_by_email: string | null;
  cancelled_at: string | null;
  state: 'active' | 'scheduled' | 'ended' | 'cancelled';
}

export function listAnnouncements(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta
): Promise<AnnouncementRow[]> {
  return asAdmin(executor, session, '/admin/announcements', meta, async (tx) => {
    const { rows } = await tx.query('select * from etna_platform.admin_announcements()');
    return rows as AnnouncementRow[];
  });
}

export function saveAnnouncement(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  input: {
    message: string;
    level: string;
    workspace_id: string | null;
    starts_at: string | null;
    ends_at: string | null;
  }
): Promise<string> {
  return asAdmin(executor, session, '/admin/announcements', meta, async (tx) => {
    const { rows } = await tx.query('select etna_platform.admin_save_announcement($1) as id', [
      JSON.stringify(input),
    ]);
    return String(rows[0].id);
  });
}

export function cancelAnnouncement(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  id: string
): Promise<void> {
  return asAdmin(executor, session, '/admin/announcements', meta, async (tx) => {
    await tx.query('select etna_platform.admin_cancel_announcement($1)', [id]);
  });
}

export type AdminOperation =
  | 'BACKUP_STARTED'
  | 'EMAIL_TEST_SENT'
  | 'ADMIN_EXPORT'
  | 'INVITE_EMAILED';

/**
 * Checks the caller may do an operation the server performs itself (and, for
 * most, that a two-factor code was entered in the last 10 minutes), and logs
 * it. Throws an AdminError otherwise.
 */
export function authorizeOperation(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  operation: AdminOperation,
  metadata: Record<string, unknown> = {}
): Promise<AdminRole> {
  return asAdmin(executor, session, '/admin/system', meta, async (tx) => {
    const { rows } = await tx.query('select etna_platform.admin_authorize($1, $2) as role', [
      operation,
      JSON.stringify(metadata),
    ]);
    return rows[0].role as AdminRole;
  });
}

const EXPORT_LIMIT = 50_000;

/** Every account matching the list filter (at most 50,000), for a CSV export. */
export async function exportUsers(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  list: Omit<ListQuery<UserFilter>, 'limit' | 'offset'> & { sort?: UserSort }
): Promise<UserRow[]> {
  const all: UserRow[] = [];
  for (let offset = 0; offset < EXPORT_LIMIT; offset += 200) {
    const page = await listUsers(executor, session, meta, { ...list, limit: 200, offset });
    all.push(...page.rows);
    if (page.rows.length < 200) break;
  }
  return all;
}

export async function exportWorkspaces(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  list: Omit<ListQuery<WorkspaceFilter>, 'limit' | 'offset'>
): Promise<WorkspaceRow[]> {
  const all: WorkspaceRow[] = [];
  for (let offset = 0; offset < EXPORT_LIMIT; offset += 200) {
    const page = await listWorkspaces(executor, session, meta, { ...list, limit: 200, offset });
    all.push(...page.rows);
    if (page.rows.length < 200) break;
  }
  return all;
}

/** Security events matching the filters, newest first (at most 50,000). */
export async function exportSecurityEvents(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  filters: Omit<EventFilters, 'beforeId' | 'limit'>
): Promise<SecurityEvent[]> {
  const all: SecurityEvent[] = [];
  let beforeId: string | null = null;
  while (all.length < EXPORT_LIMIT) {
    const page = await listSecurityEvents(executor, session, meta, {
      ...filters,
      beforeId,
      limit: 200,
    });
    all.push(...page);
    if (page.length < 200) break;
    beforeId = page[page.length - 1].id;
  }
  return all;
}
