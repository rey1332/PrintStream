import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import { changeTerms, getTerms } from '@/server/admin/service';
import { readAdminBody, UUID } from '@/server/admin/body';
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
    const terms = await getTerms(getAppExecutor(), admin.session, requestMeta(request), id);
    return adminReply({ success: true, data: terms });
  } catch (error) {
    return adminFailure(error);
  }
}

// { action: 'publish' } makes a draft the current version; { action: 'delete' }
// removes a draft. Published versions cannot be changed or deleted.
export async function POST(request: NextRequest, context: Context) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const { id } = await context.params;
  if (!UUID.test(id)) return adminReply({ success: false, error: 'not_found' }, 404);
  const body = await readAdminBody(request);
  if (body.action !== 'publish' && body.action !== 'delete')
    return adminReply({ success: false, error: 'invalid' }, 400);
  try {
    await changeTerms(getAppExecutor(), admin.session, requestMeta(request), id, body.action);
    return adminReply({ success: true });
  } catch (error) {
    return adminFailure(error);
  }
}
