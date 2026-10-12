// Session cookies on requests and responses (plain-PostgreSQL backend).

import type { NextRequest, NextResponse } from 'next/server';
import { HINT_COOKIE, SESSION_COOKIE, signHint } from '@/lib/auth/hint';
import type { RequestIdentity } from '@/server/db/execute';
import { getAuthDeps, hintSecret } from '@/server/config';
import { resolveSession, SESSION_MAX_MS, type SessionInfo } from './service';

type CookieReader = { get(name: string): { value: string } | undefined };

export function sessionToken(cookies: CookieReader): string | undefined {
  return cookies.get(SESSION_COOKIE)?.value;
}

export async function sessionFromCookies(cookies: CookieReader): Promise<SessionInfo | null> {
  return resolveSession(getAuthDeps(), sessionToken(cookies));
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
  await refreshHintCookie(response, session);
}

export async function refreshHintCookie(
  response: NextResponse,
  session: SessionInfo
): Promise<void> {
  const exp = Math.floor(new Date(session.expiresAt).getTime() / 1000);
  const value = await signHint({ aal: session.aal, next: session.nextLevel, exp }, hintSecret());
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
