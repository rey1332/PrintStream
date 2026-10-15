import { NextResponse, type NextRequest } from 'next/server';
import { HINT_COOKIE, SESSION_COOKIE, readHint } from '@/lib/auth/hint';
import { isPublicPath } from '@/lib/auth/public-paths';

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (isPublicPath(pathname)) {
    return NextResponse.next({ request });
  }

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
    if (pathname.startsWith('/api/auth/') || (await readFor(true)))
      return NextResponse.next({ request });
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const hint = await readFor(false);
  if (!hint) return redirectTo(request, pathname.startsWith('/erp') ? '/erp/login' : '/login');

  // Two-factor: a user with a verified authenticator completes it first.
  if (hint.next === 'aal2' && hint.aal !== 'aal2' && !pathname.startsWith('/mfa')) {
    return redirectTo(
      request,
      `/mfa?next=${encodeURIComponent(pathname + request.nextUrl.search)}`
    );
  }
  return NextResponse.next({ request });
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
    // Everything except static files, images and the sign-in pages.
    '/((?!_next/static|_next/image|favicon.ico|(?:erp/)?login(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
