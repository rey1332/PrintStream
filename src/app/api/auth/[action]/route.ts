import { NextResponse, type NextRequest } from 'next/server';
import { isListedAdmin } from '@/server/backup';
import { ConfigError, getAuthDeps } from '@/server/config';
import {
  AuthError,
  changePassword,
  checkPasswordLink,
  completePasswordLink,
  enrollFactor,
  listFactors,
  resolveSession,
  signIn,
  signOut,
  acceptTerms,
  currentTerms,
  declineTerms,
  termsStatus,
  unenrollFactor,
  verifyFactor,
  verifyPassword,
  type SessionInfo,
} from '@/server/auth/service';
import {
  clearSessionCookies,
  clientIp,
  isSameOrigin,
  refreshHintCookie,
  sessionFromCookies,
  sessionToken,
  setSessionCookies,
} from '@/server/auth/request';
import { readLimitedText } from '@/server/http/body';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SIGN_UP_ACTIONS = new Set([
  'signup',
  'sign-up',
  'register',
  'registration',
  'create-user',
  'create-account',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function fail(status: number, message: string, code: string): NextResponse {
  return json({ error: { message, code } }, status);
}

function sessionBody(session: SessionInfo | null) {
  if (!session) return { user: null, session: null, aal: { currentLevel: null, nextLevel: null } };
  return {
    user: session.user,
    session: {
      expires_at: Math.floor(new Date(session.expiresAt).getTime() / 1000),
      user: session.user,
    },
    aal: { currentLevel: session.aal, nextLevel: session.nextLevel },
    // Only for the server's administrators: nobody else learns these tools exist.
    ...(isListedAdmin(session.email) ? { serverAdmin: true } : {}),
  };
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    // Larger bodies are cut off while they arrive (and read as empty).
    const text = await readLimitedText(request, 10_000);
    const value = JSON.parse(text || '{}');
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const str = (value: unknown, max = 500) => (typeof value === 'string' ? value.slice(0, max) : '');

// Password-link checks per client address (all unknown addresses share one
// budget). Tokens are 256-bit, so this only keeps the security log readable.
const LINK_ATTEMPTS = 60;
const LINK_WINDOW_MS = 15 * 60_000;
const linkAttempts = new Map<string, { count: number; resetAt: number }>();

function allowLinkAttempt(ip: string | null): boolean {
  const now = Date.now();
  const key = ip ?? 'unknown';
  const entry = linkAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    linkAttempts.set(key, { count: 1, resetAt: now + LINK_WINDOW_MS });
    if (linkAttempts.size > 10_000)
      for (const [k, v] of linkAttempts) if (now > v.resetAt) linkAttempts.delete(k);
    return true;
  }
  entry.count += 1;
  return entry.count <= LINK_ATTEMPTS;
}

async function handle(request: NextRequest, action: string): Promise<NextResponse> {
  if (SIGN_UP_ACTIONS.has(action.toLowerCase())) {
    return fail(
      403,
      'Sign-up is disabled. Ask your administrator for an account.',
      'signup_disabled'
    );
  }

  const deps = getAuthDeps();

  if (request.method === 'GET') {
    const session = await sessionFromCookies(request.cookies);
    if (action === 'session') return json(sessionBody(session));
    // The current Terms & Conditions (anyone may read them) and, when signed
    // in, whether this account still has to accept them.
    // Status only, for the check on every page (no text).
    if (action === 'terms-status') {
      return json({ status: session ? await termsStatus(deps, session) : null });
    }
    if (action === 'terms') {
      const [terms, status] = await Promise.all([
        currentTerms(deps),
        session ? termsStatus(deps, session) : Promise.resolve(null),
      ]);
      return json({ terms, status });
    }
    if (action === 'factors') {
      if (!session) return fail(401, 'Not signed in', 'no_session');
      const all = await listFactors(deps, session);
      return json({ all, totp: all.filter((f) => f.status === 'verified') });
    }
    return fail(404, 'Not found', 'not_found');
  }

  if (!isSameOrigin(request)) return fail(403, 'Cross-site request refused', 'bad_origin');
  const body = await readJson(request);
  // For the security log (etna_platform.security_events).
  const meta = { ip: clientIp(request), userAgent: request.headers.get('user-agent') };

  if (action === 'login') {
    const result = await signIn(deps, {
      email: str(body.email, 320),
      password: str(body.password, 1024),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    if (!result.ok) {
      return result.reason === 'rate_limited'
        ? fail(
            429,
            'Too many sign-in attempts. Please wait 2 minutes and try again.',
            'over_request_rate_limit'
          )
        : fail(400, 'Invalid login credentials', 'invalid_credentials');
    }
    const response = json(sessionBody(result.session));
    await setSessionCookies(response, result.token, result.session);
    return response;
  }

  // One-time password links (no session needed). The token travels in the
  // body only, never in a URL the server sees.
  if (action === 'password-link' || action === 'set-password') {
    if (!allowLinkAttempt(meta.ip)) {
      return fail(
        429,
        'Too many attempts. Please wait 15 minutes and try again.',
        'over_request_rate_limit'
      );
    }
    const token = str(body.token, 100);
    if (action === 'password-link') {
      const link = await checkPasswordLink(deps, token);
      return json(link ? { valid: true, ...link } : { valid: false });
    }
    const result = await completePasswordLink(
      deps,
      { token, newPassword: str(body.password, 1024) },
      meta
    );
    if (!result.ok) {
      return result.reason === 'rate_limited'
        ? fail(429, 'Too many requests. Please try again.', 'over_request_rate_limit')
        : fail(400, 'This link is not valid any more', 'invalid_link');
    }
    return json({ ok: true, email: result.email });
  }

  if (action === 'logout') {
    await signOut(deps, sessionToken(request.cookies), meta);
    const response = json({ ok: true });
    clearSessionCookies(response);
    return response;
  }

  const session = await sessionFromCookies(request.cookies);
  if (!session) {
    const response = fail(401, 'Not signed in', 'no_session');
    clearSessionCookies(response);
    return response;
  }

  switch (action) {
    case 'terms-accept': {
      const versionId = str(body.versionId, 64);
      const workspaceId = str(body.workspaceId, 64);
      if (!UUID.test(versionId)) return fail(400, 'Invalid version', 'validation_failed');
      const acceptedAt = await acceptTerms(
        deps,
        session,
        {
          versionId,
          locale: str(body.locale, 5),
          workspaceId: UUID.test(workspaceId) ? workspaceId : null,
        },
        meta
      );
      return json({ ok: true, acceptedAt });
    }
    case 'terms-decline': {
      const versionId = str(body.versionId, 64);
      await declineTerms(deps, session, UUID.test(versionId) ? versionId : null, meta);
      await signOut(deps, sessionToken(request.cookies), meta);
      const response = json({ ok: true });
      clearSessionCookies(response);
      return response;
    }
    case 'refresh': {
      const response = json(sessionBody(session));
      await refreshHintCookie(response, session);
      return response;
    }
    case 'verify-password': {
      const ok = await verifyPassword(
        deps,
        session,
        str(body.password, 1024),
        meta.ip,
        meta.userAgent
      );
      if (ok === 'rate_limited')
        return fail(
          429,
          'Too many attempts. Please wait 2 minutes and try again.',
          'over_request_rate_limit'
        );
      return ok
        ? json({ ok: true })
        : fail(400, 'Invalid login credentials', 'invalid_credentials');
    }
    case 'change-password': {
      const result = await changePassword(deps, session, {
        currentPassword: str(body.currentPassword, 1024),
        newPassword: str(body.newPassword, 1024),
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      if (!result.ok) {
        if (result.reason === 'rate_limited')
          return fail(
            429,
            'Too many attempts. Please wait 2 minutes and try again.',
            'over_request_rate_limit'
          );
        if (result.reason === 'same_password')
          return fail(
            422,
            'New password should be different from the old password.',
            'same_password'
          );
        return fail(400, 'Current password is incorrect', 'invalid_credentials');
      }
      const renewed = await resolveSession(deps, result.token);
      if (!renewed) return fail(401, 'Not signed in', 'no_session');
      const response = json(sessionBody(renewed));
      await setSessionCookies(response, result.token, renewed);
      return response;
    }
    case 'enroll': {
      const factor = await enrollFactor(deps, session, str(body.friendlyName, 60) || null);
      return json({
        id: factor.id,
        type: 'totp',
        friendly_name: str(body.friendlyName, 60) || null,
        totp: { qr_code: factor.qr_code, secret: factor.secret, uri: factor.uri },
      });
    }
    case 'verify': {
      const factorId = str(body.factorId, 64);
      const code = str(body.code, 12);
      if (!UUID.test(factorId)) return fail(400, 'Invalid factor', 'validation_failed');
      const { token } = await verifyFactor(deps, session, factorId, code, meta);
      const upgraded = await resolveSession(deps, token);
      if (!upgraded) return fail(401, 'Not signed in', 'no_session');
      const response = json(sessionBody(upgraded));
      await setSessionCookies(response, token, upgraded);
      return response;
    }
    case 'unenroll': {
      const factorId = str(body.factorId, 64);
      if (!UUID.test(factorId)) return fail(400, 'Invalid factor', 'validation_failed');
      await unenrollFactor(deps, session, factorId, meta);
      const updated = await resolveSession(deps, sessionToken(request.cookies));
      const response = json({ id: factorId });
      if (updated) await refreshHintCookie(response, updated);
      return response;
    }
    default:
      return fail(404, 'Not found', 'not_found');
  }
}

async function route(
  request: NextRequest,
  context: { params: Promise<{ action: string }> }
): Promise<NextResponse> {
  const { action } = await context.params;
  try {
    return await handle(request, action);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.status, error.message, error.code);
    // Log the kind of failure only — never bodies, passwords or tokens.
    console.error(
      '[auth]',
      action,
      error instanceof ConfigError ? error.message : (error as { code?: string }).code || 'error'
    );
    return fail(500, 'Authentication service error', 'unexpected_failure');
  }
}

export const GET = route;
export const POST = route;
