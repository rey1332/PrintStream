// Session cookies on requests and responses (plain-PostgreSQL backend).

import type { NextRequest, NextResponse } from 'next/server';
import { HINT_COOKIE, SESSION_COOKIE, sessionTag, signHint } from '@/lib/auth/hint';
import type { RequestIdentity } from '@/server/db/execute';
import { getAuthDeps, hintSecret } from '@/server/config';
import { resolveSession, SESSION_MAX_MS, type SessionInfo } from './service';

type CookieReader = { get(name: string): { value: string } | undefined };

export function sessionToken(cookies: CookieReader): string | undefined {
  return cookies.get(SESSION_COOKIE)?.value;
}

// A page starts many requests at once; each looked its session up in the
// database. The answer is kept for a few seconds per server process: a
// sign-out here ends it at once (forgetSession), a session revoked elsewhere
// (another device, an admin) is refused at the latest SESSION_CACHE_MS later.
// The auth routes themselves always ask the database ({ fresh: true }).
const SESSION_CACHE_MS = 5_000;
const SESSION_CACHE_MAX = 5_000;
const sessionCache = new Map<string, { at: number; session: SessionInfo | null }>();

export function forgetSession(token: string | undefined | null): void {
  if (token) sessionCache.delete(token);
}

export async function sessionFromCookies(
  cookies: CookieReader,
  options: { fresh?: boolean } = {}
): Promise<SessionInfo | null> {
  const token = sessionToken(cookies);
  if (!token) return null;
  const now = Date.now();
  const hit = options.fresh ? undefined : sessionCache.get(token);
  if (hit && now - hit.at < SESSION_CACHE_MS) {
    // Never past the session's own end.
    if (!hit.session || new Date(hit.session.expiresAt).getTime() > now) return hit.session;
  }
  const session = await resolveSession(getAuthDeps(), token);
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    for (const [k, v] of sessionCache) if (now - v.at >= SESSION_CACHE_MS) sessionCache.delete(k);
    if (sessionCache.size >= SESSION_CACHE_MAX) sessionCache.clear();
  }
  sessionCache.set(token, { at: now, session });
  return session;
}

export function identityOf(session: SessionInfo): RequestIdentity {
  return {
    userId: session.userId,
    email: session.email,
    aal: session.aal,
    sessionId: session.sessionId,
  };
}

const secure = process.env.NODE_ENV === 'production';

export async function setSessionCookies(
  response: NextResponse,
  token: string,
  session: SessionInfo
): Promise<void> {
  const maxAge = Math.floor(SESSION_MAX_MS / 1000);
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
  await refreshHintCookie(response, token, session);
}

export async function refreshHintCookie(
  response: NextResponse,
  token: string,
  session: SessionInfo
): Promise<void> {
  const exp = Math.floor(new Date(session.expiresAt).getTime() / 1000);
  const value = await signHint(
    { aal: session.aal, next: session.nextLevel, exp, sid: await sessionTag(token) },
    hintSecret()
  );
  response.cookies.set(HINT_COOKIE, value, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_MAX_MS / 1000),
  });
}

export function clearSessionCookies(response: NextResponse): void {
  for (const name of [SESSION_COOKIE, HINT_COOKIE]) {
    response.cookies.set(name, '', {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
  }
}

export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).host === request.headers.get('host');
    } catch {
      return false;
    }
  }
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

export function clientIp(request: NextRequest): string | null {
  if (process.env.TRUST_PROXY === 'cloudflare') {
    const ip = request.headers.get('cf-connecting-ip')?.trim();
    return ip ? ip.slice(0, 64) : null;
  }
  if (process.env.TRUST_PROXY !== '1') return null;
  // The proxy appends the address it saw: the last entry is the one it vouches for.
  const forwarded = request.headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const ip = forwarded?.at(-1) || request.headers.get('x-real-ip')?.trim() || null;
  return ip ? ip.slice(0, 64) : null;
}
