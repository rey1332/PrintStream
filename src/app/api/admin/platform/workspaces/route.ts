import type { NextRequest } from 'next/server';
import { getAppExecutor } from '@/server/config';
import { listWorkspaces, type WorkspaceFilter } from '@/server/admin/service';
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

const FILTERS: readonly WorkspaceFilter[] = ['all', 'suspended', 'shared', 'personal'];

// Workspaces (ERPs): ?q=&filter=all|suspended|shared|personal&offset=&limit=
export async function GET(request: NextRequest) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  try {
    const page = await listWorkspaces(
      getAppExecutor(),
      admin.session,
      requestMeta(request),
      listParams(request, FILTERS)
    );
    return adminReply({ success: true, data: page });
  } catch (error) {
    return adminFailure(error);
  }
}
