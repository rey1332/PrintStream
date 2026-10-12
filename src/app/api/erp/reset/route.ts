import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, identityOf, isSameOrigin, sessionFromCookies } from '@/server/auth/request';
import { readLimitedText } from '@/server/http/body';
import { getAppExecutor, getAuthDeps } from '@/server/config';
import { resetWorkspace } from '@/server/reset';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATUS = {
  invalid: 400,
  wrong_password: 401,
  rate_limited: 429,
  forbidden: 403,
  failed: 500,
} as const;

export async function POST(request: NextRequest) {
  const reply = (body: unknown, status = 200) =>
    NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!isSameOrigin(request)) return reply({ success: false, error: 'forbidden' }, 403);
  const session = await sessionFromCookies(request.cookies);
  if (!session) return reply({ success: false, error: 'forbidden' }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse((await readLimitedText(request, 10_000)) || '{}');
  } catch {
    body = {};
  }

  const result = await resetWorkspace(
    { auth: getAuthDeps(), executor: getAppExecutor() },
    session,
    identityOf(session),
    {
      scope: body.scope,
      workspaceId: body.workspaceId,
      password: body.password,
      ip: clientIp(request),
    }
  );
  return result.ok
    ? reply({ success: true, data: { removed: result.removed } })
    : reply({ success: false, error: result.error }, STATUS[result.error]);
}
