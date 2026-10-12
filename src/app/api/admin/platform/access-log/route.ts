import type { NextRequest } from 'next/server';
import { getAppExecutor } from '@/server/config';
import { dataAccessLog } from '@/server/admin/governance';
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

const ACTOR_KINDS = ['user', 'staff', 'schedule', 'system', 'admin'];

// The data-access log: ?workspace=&user=&kind=&before=&limit=
export async function GET(request: NextRequest) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const p = request.nextUrl.searchParams;
  const uuid = (v: string | null) => (v && UUID.test(v) ? v : null);
  const before = p.get('before');
  const limit = Number(p.get('limit') ?? 100);
  try {
    const rows = await dataAccessLog(
      { executor: getAppExecutor(), session: admin.session, meta: requestMeta(request) },
      {
        workspaceId: uuid(p.get('workspace')),
        actorId: uuid(p.get('user')),
        actorKind: ACTOR_KINDS.includes(p.get('kind') ?? '') ? p.get('kind') : null,
        before: before && !Number.isNaN(Date.parse(before)) ? new Date(before).toISOString() : null,
        limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100,
      }
    );
    return adminReply({ success: true, data: { entries: rows } });
  } catch (error) {
    return adminFailure(error);
  }
}
