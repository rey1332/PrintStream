import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import {
  GRANTABLE_WORKSPACE_ROLES,
  changeWorkspace,
  changeWorkspaceAccess,
  workspaceDetail,
} from '@/server/admin/service';
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

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const { id } = await context.params;
  if (!UUID.test(id)) return adminReply({ success: false, error: 'not_found' }, 404);
  try {
    const detail = await workspaceDetail(getAppExecutor(), admin.session, requestMeta(request), id);
    return adminReply({ success: true, data: detail });
  } catch (error) {
    return adminFailure(error);
  }
}

// { action: 'suspend', reason, disableMembers } | { action: 'reactivate', enableMembers }
// | { action: 'grant', email, role, reason } | { action: 'remove', userId, reason }
// | { action: 'transfer', userId, reason }: that member becomes the Owner (super admin)
export async function POST(request: NextRequest, context: Context) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const { id } = await context.params;
  if (!UUID.test(id)) return adminReply({ success: false, error: 'not_found' }, 404);

  const body = await readAdminBody(request);
  try {
    const executor = getAppExecutor();
    const meta = requestMeta(request);
    if (body.action === 'transfer') {
      if (typeof body.userId !== 'string' || !UUID.test(body.userId))
        return adminReply({ success: false, error: 'invalid' }, 400);
      const result = await changeWorkspaceAccess(executor, admin.session, meta, id, {
        action: 'transfer',
        userId: body.userId,
        reason: text(body.reason, 500),
      });
      return adminReply({ success: true, data: { result } });
    }
    if (body.action === 'grant' || body.action === 'remove') {
      const role = GRANTABLE_WORKSPACE_ROLES.find((r) => r === body.role);
      const userId = typeof body.userId === 'string' && UUID.test(body.userId) ? body.userId : null;
      if (body.action === 'grant' ? !role : !userId)
        return adminReply({ success: false, error: 'invalid' }, 400);
      const result = await changeWorkspaceAccess(
        executor,
        admin.session,
        meta,
        id,
        body.action === 'grant'
          ? {
              action: 'grant',
              email: text(body.email, 254),
              role: role!,
              reason: text(body.reason, 500),
            }
          : { action: 'remove', userId: userId!, reason: text(body.reason, 500) }
      );
      return adminReply({ success: true, data: { result } });
    }
    let changed: number;
    if (body.action === 'suspend') {
      changed = await changeWorkspace(executor, admin.session, meta, id, {
        action: 'suspend',
        reason: text(body.reason, 500),
        disableMembers: body.disableMembers === true,
      });
    } else if (body.action === 'reactivate') {
      changed = await changeWorkspace(executor, admin.session, meta, id, {
        action: 'reactivate',
        enableMembers: body.enableMembers === true,
      });
    } else {
      return adminReply({ success: false, error: 'invalid' }, 400);
    }
    return adminReply({ success: true, data: { members: changed } });
  } catch (error) {
    return adminFailure(error);
  }
}
