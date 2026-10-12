import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import { accountLimit, setAccountLimit } from '@/server/admin/service';
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

// How many ERPs the account may belong to, and how many it does.
export async function GET(request: NextRequest, context: Context) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const { id } = await context.params;
  if (!UUID.test(id)) return adminReply({ success: false, error: 'not_found' }, 404);
  try {
    const limit = await accountLimit(getAppExecutor(), admin.session, requestMeta(request), id);
    return adminReply({ success: true, data: limit });
  } catch (error) {
    return adminFailure(error);
  }
}

// { limit: number | null, reason }: null = the default. Super admin, fresh code.
export async function POST(request: NextRequest, context: Context) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const { id } = await context.params;
  if (!UUID.test(id)) return adminReply({ success: false, error: 'not_found' }, 404);
  const body = await readAdminBody(request);
  const limit = body.limit === null ? null : Number(body.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100))
    return adminReply({ success: false, error: 'invalid' }, 400);
  try {
    await setAccountLimit(
      getAppExecutor(),
      admin.session,
      requestMeta(request),
      id,
      limit,
      text(body.reason, 500)
    );
    return adminReply({ success: true });
  } catch (error) {
    return adminFailure(error);
  }
}
