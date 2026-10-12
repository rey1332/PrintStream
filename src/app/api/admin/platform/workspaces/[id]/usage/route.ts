import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import { INDUSTRIES, MODULES, setWorkspaceModules, workspaceUsage } from '@/server/admin/service';
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

// What the ERP holds, its industry and modules. Every admin role.
export async function GET(request: NextRequest, context: Context) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const { id } = await context.params;
  if (!UUID.test(id)) return adminReply({ success: false, error: 'not_found' }, 404);
  try {
    const usage = await workspaceUsage(getAppExecutor(), admin.session, requestMeta(request), id);
    return adminReply({ success: true, data: usage });
  } catch (error) {
    return adminFailure(error);
  }
}

// { industry, modules: string[], reason }: super admin, fresh two-factor code.
export async function POST(request: NextRequest, context: Context) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const { id } = await context.params;
  if (!UUID.test(id)) return adminReply({ success: false, error: 'not_found' }, 404);
  const body = await readAdminBody(request);
  const industry = text(body.industry, 30);
  const modules = Array.isArray(body.modules)
    ? body.modules.filter((m) => typeof m === 'string')
    : [];
  if (
    !(INDUSTRIES as readonly string[]).includes(industry) ||
    !modules.every((m) => (MODULES as readonly string[]).includes(m as string))
  )
    return adminReply({ success: false, error: 'invalid' }, 400);
  try {
    await setWorkspaceModules(getAppExecutor(), admin.session, requestMeta(request), id, {
      industry,
      modules: modules as string[],
      reason: text(body.reason, 500),
    });
    return adminReply({ success: true });
  } catch (error) {
    return adminFailure(error);
  }
}
