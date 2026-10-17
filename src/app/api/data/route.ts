import { NextResponse, type NextRequest } from 'next/server';
import { validateSpec, type RestResult } from '@/lib/db/spec';
import { ConfigError, getAppExecutor } from '@/server/config';
import { executeSpec, type RequestIdentity } from '@/server/db/execute';
import { identityOf, isSameOrigin, sessionFromCookies } from '@/server/auth/request';
import { BodyTooLargeError, readLimitedText } from '@/server/http/body';
import { keyedSlots, SlotsFullError } from '@/server/slots';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BODY = 2_100_000;
const REQUESTS_PER_MINUTE = 1200;
const windows = new Map<string, { count: number; resetAt: number }>();
const perUser = keyedSlots(3, 100);
const MAX_BATCH = 25;

const isBatch = (body: unknown): body is { batch: unknown[] } =>
  !!body && typeof body === 'object' && Array.isArray((body as { batch?: unknown }).batch);

/**
 * Requests per minute for the signed-in user, counted in the database
 * (api_rate_limit_hit: every app server, across restarts); in memory only when
 * the database cannot count (an old schema).
 */
async function allow(identity: RequestIdentity): Promise<boolean> {
  const counted = await executeSpec(getAppExecutor(), identity, {
    kind: 'rpc',
    fn: 'api_rate_limit_hit',
    args: { p_bucket: 'data', p_limit: REQUESTS_PER_MINUTE, p_window_seconds: 60 },
    filters: [],
    order: [],
  });
  if (counted.error) return allowInMemory(identity.userId);
  return counted.data === true;
}

function allowInMemory(userId: string): boolean {
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
    if (!(await allow(identityOf(session))))
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
    // { batch: [spec, …] }: what a page asks for at once, in one request
    // (src/lib/db/browser-client.ts). Each spec runs in its own transaction,
    // in order, and answers on its own: one failing does not fail the others.
    if (isBatch(body)) {
      const specs = body.batch;
      if (specs.length === 0 || specs.length > MAX_BATCH)
        return reply(failure(`A batch has 1 to ${MAX_BATCH} requests`, 'PGRST100', 400), 400);
      try {
        const results = await perUser.run(session.userId, async () => {
          const out: RestResult[] = [];
          for (const item of specs) {
            const v = validateSpec(item);
            out.push(
              v.ok
                ? await executeSpec(getAppExecutor(), identityOf(session), v.spec)
                : failure(v.error, 'PGRST100', 400)
            );
          }
          return out;
        });
        return NextResponse.json({ batch: results }, { headers: { 'Cache-Control': 'no-store' } });
      } catch (error) {
        if (error instanceof SlotsFullError)
          return reply(failure('Too many requests', 'rate_limited', 429), 429);
        throw error;
      }
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
