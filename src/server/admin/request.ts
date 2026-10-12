// Admin panel requests: who is asking, and answers that do not reveal the
// panel to anyone else. Signed-in users without a platform admin role get the
// same 404 as for a page that does not exist.

import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, sessionFromCookies } from '@/server/auth/request';
import type { SessionInfo } from '@/server/auth/service';
import { getAppExecutor } from '@/server/config';
import {
  AdminError,
  adminErrorStatus,
  adminRoleOf,
  type AdminRole,
  type RequestMeta,
} from './service';

export interface AdminContext {
  session: SessionInfo;
  role: AdminRole;
}

type CookieReader = { get(name: string): { value: string } | undefined };

export async function adminFromCookies(cookies: CookieReader): Promise<AdminContext | null> {
  const session = await sessionFromCookies(cookies);
  if (!session) return null;
  const role = await adminRoleOf(getAppExecutor(), session);
  return role ? { session, role } : null;
}

export const adminFromRequest = (request: NextRequest) => adminFromCookies(request.cookies);

export const requestMeta = (request: NextRequest): RequestMeta => ({
  ip: clientIp(request),
  userAgent: request.headers.get('user-agent'),
});

/**
 * The address people open ETNA at, for links an admin hands out:
 * ETNA_PUBLIC_URL when set (recommended behind a tunnel or proxy), else the
 * address this request came in on.
 */
export function publicOrigin(request: NextRequest): string {
  const configured = process.env.ETNA_PUBLIC_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Falls back to the request's own address.
    }
  }
  return request.nextUrl.origin;
}

export function adminReply(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export const adminNotFound = () => adminReply({ success: false, error: 'not_found' }, 404);

export function adminFailure(error: unknown): NextResponse {
  const code = error instanceof AdminError ? error.code : 'failed';
  if (!(error instanceof AdminError))
    console.error('[admin]', (error as { code?: string })?.code || 'error');
  return adminReply({ success: false, error: code }, adminErrorStatus(code));
}
