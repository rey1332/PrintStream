import type { NextRequest } from 'next/server';
import { getAppExecutor } from '@/server/config';
import { pendingTerms } from '@/server/admin/service';
import { listParams } from '@/server/admin/body';
import {
  adminFailure,
  adminFromRequest,
  adminNotFound,
  adminReply,
  requestMeta,
} from '@/server/admin/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Accounts that have not accepted the current version: ?offset=&limit=
export async function GET(request: NextRequest) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const { offset, limit } = listParams(request, ['all'] as const);
  try {
    const page = await pendingTerms(getAppExecutor(), admin.session, requestMeta(request), {
      offset,
      limit,
    });
    return adminReply({ success: true, data: page });
  } catch (error) {
    return adminFailure(error);
  }
}
