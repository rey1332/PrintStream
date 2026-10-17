// OAuth 2.1 for the MCP endpoint (db/migrations/20261012000056_mcp_oauth.sql):
// the discovery documents (RFC 9728 protected resource, RFC 8414
// authorization server), dynamic client registration (RFC 7591), PKCE
// (S256 only) and the redirect addresses a client may register.

import { createHash, randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';

export const SCOPE = 'mcp:read';
export const ACCESS_TOKEN_SECONDS = 3600;

// Claude's connectors (claude.ai, Claude Desktop, the apps) come back here.
const DEFAULT_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

const HOST_RE = /^([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(:\d{1,5})?$/;

/**
 * The address clients reach this server at: ETNA_PUBLIC_URL when set, else
 * the Host the request came with (a tunnel or proxy passes the visitor's on),
 * https when the proxy says so.
 */
export function issuerOf(request: NextRequest): string {
  const configured = process.env.ETNA_PUBLIC_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Falls back to the request's own address.
    }
  }
  const host = request.headers.get('host') ?? '';
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  const proto =
    forwarded === 'https' || forwarded === 'http'
      ? forwarded
      : request.nextUrl.protocol.replace(':', '');
  return HOST_RE.test(host) ? `${proto}://${host}` : request.nextUrl.origin;
}

export const resourceOf = (issuer: string) => `${issuer}/api/mcp`;

export function protectedResourceMetadata(issuer: string) {
  return {
    resource: resourceOf(issuer),
    authorization_servers: [issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'PrintStream Terminal',
  };
}

export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  };
}

/** Extra allowed redirect addresses (exact, or a prefix ending in "/"): ETNA_MCP_OAUTH_REDIRECTS. */
function configuredRedirects(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ETNA_MCP_OAUTH_REDIRECTS ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Whether a client may register this redirect address: Claude's callback,
 * a loopback address of the machine the client runs on (Claude Code, local
 * MCP clients: any port and path), or one the server's settings add.
 */
export function redirectAllowed(uri: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof uri !== 'string' || uri.length > 500) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    return true;
  const allowed = [...DEFAULT_REDIRECTS, ...configuredRedirects(env)];
  return allowed.some((a) => (a.endsWith('/') ? uri.startsWith(a) : uri === a));
}

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
export const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
export const newSecret = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
export const validVerifier = (v: unknown): v is string =>
  typeof v === 'string' && VERIFIER_RE.test(v);
export const validChallenge = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
export const CLIENT_ID_RE = /^mcpc_[A-Za-z0-9_-]{20,64}$/;
