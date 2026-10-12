import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import {
  USER_SORTS,
  createUser,
  listUsers,
  type UserFilter,
  type UserSort,
} from '@/server/admin/service';
import { emailLink } from '@/server/admin/mailLink';
import { listParams, readAdminBody, text } from '@/server/admin/body';
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

const FILTERS: readonly UserFilter[] = ['all', 'disabled', 'closed', 'no_mfa', 'admins'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Accounts: ?q=&filter=all|disabled|closed|no_mfa|admins&sort=created_desc|created_asc|last_sign_in_desc|email_asc&offset=&limit=
export async function GET(request: NextRequest) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const sort = request.nextUrl.searchParams.get('sort');
  try {
    const page = await listUsers(getAppExecutor(), admin.session, requestMeta(request), {
      ...listParams(request, FILTERS),
      sort: USER_SORTS.find((s): s is UserSort => s === sort) ?? 'created_desc',
    });
    return adminReply({ success: true, data: page });
  } catch (error) {
    return adminFailure(error);
  }
}

// { email, name, sendEmail? }: a new account without a password, and its
// invite link (shown to the admin once; also e-mailed when asked and set up).
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const body = await readAdminBody(request);
  const email = text(body.email, 300);
  if (!EMAIL.test(email) || email.length > 254)
    return adminReply({ success: false, error: 'invalid' }, 400);
  const executor = getAppExecutor();
  const meta = requestMeta(request);
  try {
    const link = await createUser(executor, admin.session, meta, publicOrigin(request), {
      email,
      name: text(body.name, 120),
    });
    const emailed =
      body.sendEmail === true && link.user_id
        ? await emailLink(executor, admin.session, meta, {
            userId: link.user_id,
            email,
            kind: 'invite',
            url: link.url,
            expiresAt: link.expires_at,
          })
        : null;
    return adminReply({ success: true, data: { ...link, emailed } });
  } catch (error) {
    return adminFailure(error);
  }
}
