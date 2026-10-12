import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { AuthError, reauthenticate } from '@/server/auth/service';
import { getAuthDeps } from '@/server/config';
import { readLimitedText } from '@/server/http/body';
import {
  adminFailure,
  adminFromRequest,
  adminNotFound,
  adminReply,
  requestMeta,
} from '@/server/admin/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Re-enter a two-factor code before a sensitive admin action.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse((await readLimitedText(request, 10_000)) || '{}');
  } catch {
    body = {};
  }
  const factorId = typeof body.factorId === 'string' ? body.factorId : '';
  const code = typeof body.code === 'string' ? body.code.trim().slice(0, 12) : '';
  if (!UUID.test(factorId) || !/^\d{6}$/.test(code))
    return adminReply({ success: false, error: 'invalid' }, 400);

  try {
    await reauthenticate(getAuthDeps(), admin.session, factorId, code, requestMeta(request));
    return adminReply({ success: true });
  } catch (error) {
    if (error instanceof AuthError) {
      const code =
        error.code === 'over_request_rate_limit'
          ? 'rate_limited'
          : error.code === 'insufficient_aal'
            ? 'mfa_required'
            : 'wrong_code';
      return adminReply({ success: false, error: code }, error.status);
    }
    return adminFailure(error);
  }
}
