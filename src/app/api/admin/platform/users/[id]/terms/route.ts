import type { NextRequest } from 'next/server';
import { getAppExecutor } from '@/server/config';
import { userTerms } from '@/server/admin/service';
import { UUID } from '@/server/admin/body';
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

// Which Terms & Conditions versions this account accepted, when and how.
export async function GET(request: NextRequest, context: Context) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const { id } = await context.params;
  if (!UUID.test(id)) return adminReply({ success: false, error: 'not_found' }, 404);
  try {
    const accepted = await userTerms(getAppExecutor(), admin.session, requestMeta(request), id);
    return adminReply({ success: true, data: { accepted } });
  } catch (error) {
    return adminFailure(error);
  }
}
