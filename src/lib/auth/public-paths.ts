// Pages and routes anyone may open (src/middleware.ts).
// /api/mcp authenticates every request with its own bearer token (no cookies);
// MCP clients discover and get those tokens through the OAuth endpoints
// (the consent page, /oauth/authorize, needs a signed-in member).
const PUBLIC_PATHS = [
  '/login',
  '/erp/login',
  '/reset-password',
  '/terms',
  '/api/health',
  '/api/mcp',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/api/oauth/register',
  '/api/oauth/token',
];

/** The path itself or a page below it ('/terms/2'), not one that only starts alike ('/termsx'). */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
