import { NextResponse, type NextRequest } from 'next/server';
import { HINT_COOKIE, SESSION_COOKIE, readHint } from '@/lib/auth/hint';
import { isPublicPath } from '@/lib/auth/public-paths';
import { contentSecurityPolicy, newNonce } from '@/lib/security/csp';
import { imageHosts } from '../image-hosts.config.mjs';

export async function middleware(request: NextRequest) {
  return (await gate(request)) ?? withPolicy(request);
}

/** A redirect or refusal for a request that may not go on, else null. */
async function gate(request: NextRequest): Promise<NextResponse | null> {
  const pathname = request.nextUrl.pathname;
  if (isPublicPath(pathname)) return null;

  // The hint is signed by the server for this session cookie, so a made-up
  // cookie gets no further. Routes still check the session itself.
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const readFor = (ignoreExpiry: boolean) =>
    token
      ? readHint(
          request.cookies.get(HINT_COOKIE)?.value,
          process.env.SESSION_HINT_SECRET ?? '',
          undefined,
          { sessionToken: token, ignoreExpiry }
        )
      : Promise.resolve(null);

  if (pathname.startsWith('/api/')) {
    if (pathname.startsWith('/api/auth/') || (await readFor(true))) return null;
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const hint = await readFor(false);
  if (!hint) {
    if (pathname.startsWith('/erp')) return redirectTo(request, '/erp/login');
    // Back to the page asked for after signing in (the OAuth consent page, a link).
    const back =
      pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
    return redirectTo(request, `/login${back}`);
  }

  // Two-factor: a user with a verified authenticator completes it first.
  if (hint.next === 'aal2' && hint.aal !== 'aal2' && !pathname.startsWith('/mfa')) {
    return redirectTo(
      request,
      `/mfa?next=${encodeURIComponent(pathname + request.nextUrl.search)}`
    );
  }
  return null;
}

/**
 * Pages get this request's Content Security Policy (src/lib/security/csp.ts).
 * Next.js reads the nonce from the request's CSP header and puts it on its
 * scripts; the root layout reads x-nonce for its own.
 */
function withPolicy(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith('/api/')) return NextResponse.next({ request });
  const nonce = newNonce();
  const policy = contentSecurityPolicy(nonce, {
    dev: process.env.NODE_ENV !== 'production',
    imageHosts,
  });
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

const HOST_RE = /^([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(:\d{1,5})?$/;

/**
 * A redirect within the site, on the host the browser opened. Behind a tunnel
 * or reverse proxy (which pass the visitor's Host on) the server's own address,
 * 127.0.0.1:4028, is not the one people use, so it is never put in a link.
 */
function redirectTo(request: NextRequest, path: string) {
  const host = request.headers.get('host') ?? '';
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  const proto =
    forwarded === 'https' || forwarded === 'http'
      ? forwarded
      : request.nextUrl.protocol.replace(':', '');
  const base = HOST_RE.test(host) ? `${proto}://${host}` : request.nextUrl.origin;
  return NextResponse.redirect(new URL(path, base), 307);
}

export const config = {
  matcher: [
    // Everything except static files and images (sign-in pages too: they need the nonce).
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
