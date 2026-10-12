import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import { changeUser, createResetLink, userDetail } from '@/server/admin/service';
import { emailLink } from '@/server/admin/mailLink';
import { readAdminBody, text, UUID } from '@/server/admin/body';
import {
  adminFailure,
  adminFromRequest,
  adminNotFound,
  adminReply,
  publicOrigin,
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
    const detail = await userDetail(getAppExecutor(), admin.session, requestMeta(request), id);
    return adminReply({ success: true, data: detail });
  } catch (error) {
    return adminFailure(error);
  }
}

// { action: 'disable', reason } | { action: 'enable' }
// | { action: 'end_sessions', sessionId? } | { action: 'reset_mfa', verification }
// | { action: 'reset_link' }: answers { url, expires_at }, shown to the admin once.
// | { action: 'close', reason, confirmEmail }: shuts the account for good (super admin).
export async function POST(request: NextRequest, context: Context) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const { id } = await context.params;
  if (!UUID.test(id)) return adminReply({ success: false, error: 'not_found' }, 404);

  const body = await readAdminBody(request);
  const executor = getAppExecutor();
  const meta = requestMeta(request);
  try {
    switch (body.action) {
      case 'reset_link': {
        const link = await createResetLink(
          executor,
          admin.session,
          meta,
          publicOrigin(request),
          id
        );
        let emailed = null;
        if (body.sendEmail === true) {
          const detail = await userDetail(executor, admin.session, meta, id);
          const user = detail.user as { email?: unknown } | undefined;
          const email = typeof user?.email === 'string' ? user.email : '';
          emailed = email
            ? await emailLink(executor, admin.session, meta, {
                userId: id,
                email,
                kind: 'reset',
                url: link.url,
                expiresAt: link.expires_at,
              })
            : 'failed';
        }
        return adminReply({ success: true, data: { ...link, emailed } });
      }
      case 'disable':
        await changeUser(executor, admin.session, meta, id, {
          action: 'disable',
          reason: text(body.reason, 500),
        });
        break;
      case 'enable':
        await changeUser(executor, admin.session, meta, id, { action: 'enable' });
        break;
      case 'end_sessions': {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
        if (sessionId !== null && !UUID.test(sessionId))
          return adminReply({ success: false, error: 'invalid' }, 400);
        await changeUser(executor, admin.session, meta, id, { action: 'end_sessions', sessionId });
        break;
      }
      case 'reset_mfa':
        await changeUser(executor, admin.session, meta, id, {
          action: 'reset_mfa',
          verification: text(body.verification, 500),
        });
        break;
      case 'close':
        await changeUser(executor, admin.session, meta, id, {
          action: 'close',
          reason: text(body.reason, 500),
          confirmEmail: text(body.confirmEmail, 320),
        });
        break;
      default:
        return adminReply({ success: false, error: 'invalid' }, 400);
    }
    return adminReply({ success: true });
  } catch (error) {
    return adminFailure(error);
  }
}
