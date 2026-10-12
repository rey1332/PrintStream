import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import { cancelAnnouncement, listAnnouncements, saveAnnouncement } from '@/server/admin/service';
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

const LEVELS = ['info', 'warning', 'maintenance'];

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

export async function GET(request: NextRequest) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  try {
    const rows = await listAnnouncements(getAppExecutor(), admin.session, requestMeta(request));
    return adminReply({ success: true, data: { announcements: rows } });
  } catch (error) {
    return adminFailure(error);
  }
}

// { action: 'create', message, level, workspaceId?, startsAt?, endsAt? } | { action: 'cancel', id }
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const body = await readAdminBody(request);
  const executor = getAppExecutor();
  const meta = requestMeta(request);
  try {
    if (body.action === 'cancel') {
      if (typeof body.id !== 'string' || !UUID.test(body.id))
        return adminReply({ success: false, error: 'invalid' }, 400);
      await cancelAnnouncement(executor, admin.session, meta, body.id);
      return adminReply({ success: true });
    }
    if (body.action !== 'create') return adminReply({ success: false, error: 'invalid' }, 400);
    const message = text(body.message, 500);
    const level = text(body.level, 20) || 'info';
    const workspaceId =
      typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : null;
    if (!message || !LEVELS.includes(level) || (workspaceId !== null && !UUID.test(workspaceId)))
      return adminReply({ success: false, error: 'invalid' }, 400);
    const id = await saveAnnouncement(executor, admin.session, meta, {
      message,
      level,
      workspace_id: workspaceId,
      starts_at: isoOrNull(body.startsAt),
      ends_at: isoOrNull(body.endsAt),
    });
    return adminReply({ success: true, data: { id } });
  } catch (error) {
    return adminFailure(error);
  }
}
