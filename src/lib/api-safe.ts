import { NextRequest, NextResponse } from 'next/server';
import { createRouteClient } from '@/server/db/route-client';
import { isSameOrigin } from '@/server/auth/request';
import { BodyTooLargeError, MAX_JSON_BODY, withLimitedBody } from '@/server/http/body';
import { MAX_DOCUMENT_BYTES } from '@/lib/workspaces/limits';

type RouteClient = ReturnType<typeof createRouteClient>;

interface SafeApiContext {
  userId: string;
  request: NextRequest;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const MAX_UPLOAD_BODY = MAX_DOCUMENT_BYTES + 64 * 1024;

const API_LIMIT_PER_MINUTE = 120;

// Fallback limiter for a database without api_rate_limit_hit() (one process only).
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

async function allowRequest(db: RouteClient, userId: string): Promise<boolean> {
  const { data, error } = await db.rpc('api_rate_limit_hit', {
    p_bucket: 'api',
    p_limit: API_LIMIT_PER_MINUTE,
    p_window_seconds: 60,
  });
  if (error) return checkRateLimit(userId);
  return data === true;
}

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const key = userId;
  const limit = rateLimitStore.get(key);

  if (!limit || now > limit.resetTime) {
    rateLimitStore.set(key, { count: 1, resetTime: now + 60000 }); // 60s window
    return true;
  }

  if (limit.count < API_LIMIT_PER_MINUTE) {
    limit.count++;
    return true;
  }

  return false;
}

async function verifiedUserId(db: RouteClient): Promise<string | null> {
  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error) return null;
  return user?.id ?? null;
}

export async function getAuthUserId(request: NextRequest): Promise<string | null> {
  return verifiedUserId(createRouteClient(request));
}

export function withAuth(handler: (ctx: SafeApiContext) => Promise<ApiResponse<any>>) {
  return async (request: NextRequest): Promise<NextResponse> => {
    if (!SAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
      return NextResponse.json(
        { success: false, error: 'Cross-site request refused' },
        { status: 403 }
      );
    }
    try {
      // One client per request for the session check and the rate limit.
      const db = createRouteClient(request);
      const userId = await verifiedUserId(db);
      if (!userId) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }

      // Check rate limit
      if (!(await allowRequest(db, userId))) {
        return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 });
      }

      // Bodies are read with a size limit before the handler sees them.
      let limited = request;
      if (!SAFE_METHODS.has(request.method)) {
        const upload = (request.headers.get('content-type') ?? '').startsWith(
          'multipart/form-data'
        );
        try {
          limited = await withLimitedBody(request, upload ? MAX_UPLOAD_BODY : MAX_JSON_BODY);
        } catch (err) {
          if (err instanceof BodyTooLargeError)
            return NextResponse.json({ success: false, error: 'tooLarge' }, { status: 413 });
          throw err;
        }
      }

      // Call handler
      const result = await handler({ userId, request: limited });
      return NextResponse.json(result);
    } catch (err: any) {
      // Log the kind of failure only: messages can carry request data.
      console.error('[API Error]', err?.code || err?.name || 'error');

      // Sanitize error: never expose schema/database details
      const message =
        err?.code === 'PGRST116'
          ? 'Access denied'
          : err?.message?.includes('relation')
            ? 'Resource not found'
            : err?.message?.includes('column')
              ? 'Invalid field'
              : 'Internal error';

      return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
  };
}

/**
 * As withAuth, for handlers that stream the request body or answer with a
 * file: the body is not read or limited here (the handler enforces its own
 * limit), and the handler returns the Response itself.
 */
export function withAuthRaw(handler: (ctx: SafeApiContext) => Promise<Response>) {
  return async (request: NextRequest): Promise<Response> => {
    if (!SAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
      return NextResponse.json(
        { success: false, error: 'Cross-site request refused' },
        { status: 403 }
      );
    }
    try {
      const db = createRouteClient(request);
      const userId = await verifiedUserId(db);
      if (!userId)
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      if (!(await allowRequest(db, userId)))
        return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 });
      return await handler({ userId, request });
    } catch (err: any) {
      console.error('[API Error]', err?.code || err?.name || 'error');
      return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
    }
  };
}
