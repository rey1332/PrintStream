// Where the internal admin panel is opened (docs/teknis/ADMIN.md, "Address").
// Its pages live under src/app/admin; with ETNA_ADMIN_PATH set, the
// middleware serves them only under that address and /admin is an ordinary
// 404 for everyone, platform admins included. Read by the middleware and the
// admin layout; the panel's links get it from the layout (useAdminPath).

/** The folder the panel's pages are in. */
export const ADMIN_ROUTE = '/admin';

// Top-level routes and Next.js paths an address may not hide behind.
const RESERVED = new Set([
  'admin',
  'api',
  'erp',
  'login',
  'mfa',
  'oauth',
  'pipelines',
  'reset-password',
  'terminal',
  'terms',
  '_next',
  '.well-known',
  'favicon.ico',
]);

export const ADMIN_PATH_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;

/**
 * The panel's address: '/admin' without ETNA_ADMIN_PATH, '/<value>' with a
 * valid one, null when the value is not valid (8–64 lower-case letters,
 * digits and dashes, not one of the app's own routes). An invalid value
 * closes the panel rather than leaving it at /admin.
 */
export function adminBase(value: string | undefined = process.env.ETNA_ADMIN_PATH): string | null {
  const v = (value ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!v) return ADMIN_ROUTE;
  return ADMIN_PATH_RE.test(v) && !RESERVED.has(v) ? `/${v}` : null;
}

/** The path as the router matches it: decoded, single slashes, no trailing slash. */
export function normalPath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    // left as it came; the router does not match it either
  }
  p = p.replace(/\/{2,}/g, '/');
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

const under = (path: string, base: string) =>
  path.toLowerCase() === base || path.toLowerCase().startsWith(`${base}/`);

/**
 * What the middleware does with a path: 'hide' (the panel's own folder while
 * it has another address, or any panel path while it is closed), a rewrite to
 * the panel's page for its address, or nothing.
 */
export function routeAdmin(
  pathname: string,
  base: string | null = adminBase()
): { action: 'hide' } | { action: 'rewrite'; to: string } | null {
  const p = normalPath(pathname);
  if (base === ADMIN_ROUTE) return null;
  if (under(p, ADMIN_ROUTE)) return { action: 'hide' };
  if (base && under(p, base)) return { action: 'rewrite', to: ADMIN_ROUTE + p.slice(base.length) };
  return null;
}
