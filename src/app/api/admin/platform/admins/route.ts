import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import { readLimitedText } from '@/server/http/body';
import { isAdminRole, listAdmins, revokeAdmin, setAdminRole } from '@/server/admin/service';
import {
  adminFailure,
  adminFromRequest,
  adminNotFound,
  adminReply,
  requestMeta,
} from '@/server/admin/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(request: NextRequest) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  try {
    const admins = await listAdmins(getAppExecutor(), admin.session, requestMeta(request));
    return adminReply({ success: true, data: { admins } });
  } catch (error) {
    return adminFailure(error);
  }
}

// { action: 'set', email, role } or { action: 'revoke', email }. Super admins
// only, after re-authentication — both checked by the database as well.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse((await readLimitedText(request, 10_000)) || '{}');
  } catch {
    body = {};
  }
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!EMAIL.test(email) || email.length > 254)
    return adminReply({ success: false, error: 'invalid' }, 400);

  try {
    const executor = getAppExecutor();
    const meta = requestMeta(request);
    if (body.action === 'set' && isAdminRole(body.role)) {
      await setAdminRole(executor, admin.session, meta, email, body.role);
    } else if (body.action === 'revoke') {
      await revokeAdmin(executor, admin.session, meta, email);
    } else {
      return adminReply({ success: false, error: 'invalid' }, 400);
    }
    return adminReply({ success: true });
  } catch (error) {
    return adminFailure(error);
  }
}
