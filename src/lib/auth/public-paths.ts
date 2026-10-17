// Pages and routes anyone may open (src/middleware.ts).
// /api/mcp authenticates every request with its own bearer token (no cookies).
const PUBLIC_PATHS = [
  '/login',
  '/erp/login',
  '/reset-password',
  '/terms',
  '/api/health',
  '/api/mcp',
];

/** The path itself or a page below it ('/terms/2'), not one that only starts alike ('/termsx'). */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
