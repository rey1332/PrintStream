import { NextResponse, type NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import {
  USER_SORTS,
  authorizeOperation,
  exportSecurityEvents,
  exportUsers,
  exportWorkspaces,
  type UserFilter,
  type UserSort,
  type WorkspaceFilter,
} from '@/server/admin/service';
import { toCsv } from '@/server/admin/csv';
import { readAdminBody, text, UUID } from '@/server/admin/body';
import {
  adminFailure,
  adminFromRequest,
  adminNotFound,
  adminReply,
  requestMeta,
} from '@/server/admin/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const USER_FILTERS: readonly UserFilter[] = ['all', 'disabled', 'closed', 'no_mfa', 'admins'];
const WORKSPACE_FILTERS: readonly WorkspaceFilter[] = ['all', 'suspended', 'shared', 'personal'];
const EVENT_TYPE = /^[A-Z][A-Z0-9_]{2,63}$/;

const pick = <T extends string>(value: unknown, allowed: readonly T[]): T =>
  (allowed as readonly unknown[]).includes(value) ? (value as T) : allowed[0];
const uuidOrNull = (value: unknown) =>
  typeof value === 'string' && UUID.test(value) ? value : null;
function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

// { kind: 'users' | 'workspaces' | 'security-log', ...the list's filters }:
// a CSV file. Every admin role, with a two-factor code entered in the last
// 10 minutes; each export is in the security log.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const body = await readAdminBody(request);
  const kind = body.kind;
  if (kind !== 'users' && kind !== 'workspaces' && kind !== 'security-log')
    return adminReply({ success: false, error: 'invalid' }, 400);
  const executor = getAppExecutor();
  const meta = requestMeta(request);
  const query = text(body.q, 320) || null;
  try {
    await authorizeOperation(executor, admin.session, meta, 'ADMIN_EXPORT', { kind });
    let csv: string;
    if (kind === 'users') {
      const rows = await exportUsers(executor, admin.session, meta, {
        query,
        filter: pick(body.filter, USER_FILTERS),
        sort: USER_SORTS.find((s): s is UserSort => s === body.sort) ?? 'created_desc',
      });
      csv = toCsv(
        [
          'email',
          'name',
          'created_at',
          'last_sign_in_at',
          'disabled',
          'closed',
          'two_factor',
          'active_sessions',
          'erps',
          'erp_roles',
          'admin_role',
        ],
        rows.map((r) => [
          r.email,
          r.full_name,
          r.created_at,
          r.last_sign_in_at,
          r.disabled,
          r.closed,
          r.mfa_enrolled,
          r.active_sessions,
          r.workspaces,
          r.memberships.map((m) => `${m.name} (${m.role})`).join('; '),
          r.admin_role,
        ])
      );
    } else if (kind === 'workspaces') {
      const rows = await exportWorkspaces(executor, admin.session, meta, {
        query,
        filter: pick(body.filter, WORKSPACE_FILTERS),
      });
      csv = toCsv(
        ['name', 'owner_email', 'personal', 'members', 'created_at', 'last_activity', 'suspended'],
        rows.map((r) => [
          r.name,
          r.owner_email,
          r.is_personal,
          r.members,
          r.created_at,
          r.last_activity,
          r.suspended,
        ])
      );
    } else {
      const type = typeof body.type === 'string' && EVENT_TYPE.test(body.type) ? body.type : null;
      const rows = await exportSecurityEvents(executor, admin.session, meta, {
        eventType: type,
        query,
        outcome: body.outcome === 'success' || body.outcome === 'failure' ? body.outcome : null,
        from: isoOrNull(body.from),
        to: isoOrNull(body.to),
        userId: uuidOrNull(body.user),
        workspaceId: uuidOrNull(body.workspace),
      });
      csv = toCsv(
        [
          'id',
          'occurred_at',
          'event_type',
          'outcome',
          'actor_kind',
          'actor_email',
          'target_email',
          'workspace_id',
          'ip',
          'user_agent',
          'metadata',
        ],
        rows.map((r) => [
          r.id,
          r.occurred_at,
          r.event_type,
          r.outcome,
          r.actor_kind,
          r.actor_email,
          r.target_email,
          r.workspace_id,
          r.ip,
          r.user_agent,
          r.metadata,
        ])
      );
    }
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="etna-${kind}-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return adminFailure(error);
  }
}
