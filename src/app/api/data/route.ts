import { NextResponse, type NextRequest } from 'next/server';
import { validateSpec, type RestResult } from '@/lib/db/spec';
import { ConfigError, getAppExecutor } from '@/server/config';
import { executeSpec } from '@/server/db/execute';
import { identityOf, isSameOrigin, sessionFromCookies } from '@/server/auth/request';
import { BodyTooLargeError, readLimitedText } from '@/server/http/body';
import { keyedSlots, SlotsFullError } from '@/server/slots';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BODY = 2_100_000;
const REQUESTS_PER_MINUTE = 1200;
const windows = new Map<string, { count: number; resetAt: number }>();
const perUser = keyedSlots(3, 100);

function allow(userId: string): boolean {
  const now = Date.now();
  const entry = windows.get(userId);
  if (!entry || now > entry.resetAt) {
    windows.set(userId, { count: 1, resetAt: now + 60_000 });
    if (windows.size > 10_000) for (const [k, v] of windows) if (now > v.resetAt) windows.delete(k);
    return true;
  }
  entry.count += 1;
  return entry.count <= REQUESTS_PER_MINUTE;
}

function reply(result: RestResult, httpStatus = 200): NextResponse {
  return NextResponse.json(result, {
    status: httpStatus,
    headers: { 'Cache-Control': 'no-store' },
  });
}

const failure = (message: string, code: string, status: number): RestResult => ({
  data: null,
  error: { message, code, details: null, hint: null },
  count: null,
  status,
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOrigin(request))
    return reply(failure('Cross-site request refused', 'bad_origin', 403), 403);

  try {
    const session = await sessionFromCookies(request.cookies);
    if (!session) return reply(failure('JWT expired', 'PGRST301', 401), 401);
    if (!allow(session.userId))
      return reply(failure('Too many requests', 'rate_limited', 429), 429);

    let text: string;
    try {
      text = await readLimitedText(request, MAX_BODY);
    } catch (error) {
      if (error instanceof BodyTooLargeError)
        return reply(failure('Request is too large', 'PGRST102', 413), 413);
      throw error;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return reply(failure('Invalid JSON', 'PGRST102', 400), 400);
    }
    const validation = validateSpec(body);
    if (!validation.ok) return reply(failure(validation.error, 'PGRST100', 400), 400);

    // Errors from the database travel back in the body, as PostgREST's did.
    const spec = validation.spec;
    try {
      return reply(
        await perUser.run(session.userId, () =>
          executeSpec(getAppExecutor(), identityOf(session), spec)
        )
      );
    } catch (error) {
      if (error instanceof SlotsFullError)
        return reply(failure('Too many requests', 'rate_limited', 429), 429);
      throw error;
    }
  } catch (error) {
    console.error(
      '[data]',
      error instanceof ConfigError ? error.message : (error as { code?: string }).code || 'error'
    );
    return reply(failure('The request could not be completed', 'PGRST000', 500), 500);
  }
}
