import type { NextRequest } from 'next/server';
import { getAppExecutor } from '@/server/config';
import { listSecurityEvents } from '@/server/admin/service';
import {
  adminFailure,
  adminFromRequest,
  adminNotFound,
  adminReply,
  requestMeta,
} from '@/server/admin/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EVENT_TYPE = /^[A-Z][A-Z0-9_]{2,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuidOrNull = (value: string | null) => (value && UUID.test(value) ? value : null);

function isoOrNull(value: string | null): string | null {
  if (!value) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

// The security log, newest first:
// ?before=<id>&limit=&type=&q=&outcome=&from=&to=&user=<uuid>&workspace=<uuid>
export async function GET(request: NextRequest) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();

  const params = request.nextUrl.searchParams;
  const before = params.get('before');
  const type = params.get('type');
  const outcome = params.get('outcome');
  const limit = Number(params.get('limit') ?? 50);
  try {
    const events = await listSecurityEvents(getAppExecutor(), admin.session, requestMeta(request), {
      beforeId: before && /^\d{1,19}$/.test(before) ? before : null,
      limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
      eventType: type && EVENT_TYPE.test(type) ? type : null,
      query: params.get('q')?.trim().slice(0, 320) || null,
      outcome: outcome === 'success' || outcome === 'failure' ? outcome : null,
      from: isoOrNull(params.get('from')),
      to: isoOrNull(params.get('to')),
      userId: uuidOrNull(params.get('user')),
      workspaceId: uuidOrNull(params.get('workspace')),
    });
    return adminReply({ success: true, data: { events } });
  } catch (error) {
    return adminFailure(error);
  }
}
