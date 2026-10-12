// MCP authorization discovery (the MCP specification's OAuth flow), for an
// MCP connection whose authorisation addresses or client ID were left empty:
//  1. the server's protected resource metadata (RFC 9728) names its
//     authorization server (else the server's own origin is tried);
//  2. that server's metadata (RFC 8414, or OpenID configuration) gives the
//     authorisation, token, registration and revocation addresses;
//  3. without a client ID, PrintStream registers itself (RFC 7591) as a
//     public client with ETNA's callback address.
// Every request goes through the network guard (public addresses only).

import { TerminalError } from '@/server/terminal/session';
import { GuardedHttp } from './http';

const isHttpsUrl = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 500) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

/** Well-known addresses for an issuer, path-aware (RFC 8414 section 3.1) then plain. */
function wellKnown(issuer: URL, name: string): string[] {
  const path = issuer.pathname.replace(/\/+$/, '');
  const out = [`${issuer.origin}/.well-known/${name}${path}`];
  if (path) out.push(`${issuer.origin}${path}/.well-known/${name}`);
  out.push(`${issuer.origin}/.well-known/${name}`);
  return [...new Set(out)];
}

async function firstJson(http: GuardedHttp, urls: string[]): Promise<any | null> {
  for (const u of urls) {
    const res = await http.request(u, { maxBytes: 512 * 1024 }).catch(() => null);
    if (res && res.status === 200) {
      try {
        return res.json();
      } catch {
        // Not JSON: try the next address.
      }
    }
  }
  return null;
}

export async function discoverMcpAuth(
  mcpUrl: string,
  redirectUri: string,
  config: Record<string, any>,
  http: GuardedHttp = new GuardedHttp({ privateHosts: [] })
): Promise<{ config: Record<string, string>; clientSecret: string | null }> {
  let server: URL;
  try {
    server = new URL(mcpUrl);
  } catch {
    throw new TerminalError('fieldInvalid', { field: 'mcp_url' });
  }
  const resource = await firstJson(http, wellKnown(server, 'oauth-protected-resource'));
  const issuerRaw = Array.isArray(resource?.authorization_servers)
    ? resource.authorization_servers.find(isHttpsUrl)
    : null;
  const issuer = new URL(issuerRaw ?? server.origin);
  const meta =
    (await firstJson(http, wellKnown(issuer, 'oauth-authorization-server'))) ??
    (await firstJson(http, wellKnown(issuer, 'openid-configuration')));
  const patch: Record<string, string> = {};
  const pick = (key: string, value: unknown) => {
    if (!config[key] && isHttpsUrl(value)) patch[key] = value;
  };
  pick('authorize_url', meta?.authorization_endpoint);
  pick('token_url', meta?.token_endpoint);
  pick('revoke_url', meta?.revocation_endpoint);
  if (!config.scope && Array.isArray(resource?.scopes_supported))
    patch.scope = resource.scopes_supported
      .filter((s: unknown) => typeof s === 'string' && /^[\x21-\x7e]{1,100}$/.test(s))
      .slice(0, 20)
      .join(' ');
  if (!(config.authorize_url || patch.authorize_url) || !(config.token_url || patch.token_url))
    throw new TerminalError('mcpAuthDiscovery');

  let clientSecret: string | null = null;
  if (!config.client_id) {
    if (!isHttpsUrl(meta?.registration_endpoint)) throw new TerminalError('mcpAuthDiscovery');
    const res = await http.request(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'PrintStream',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    if (res.status !== 200 && res.status !== 201) throw new TerminalError('mcpAuthDiscovery');
    const reg = res.json();
    if (typeof reg?.client_id !== 'string' || !reg.client_id || reg.client_id.length > 500)
      throw new TerminalError('mcpAuthDiscovery');
    patch.client_id = reg.client_id;
    if (typeof reg.client_secret === 'string' && reg.client_secret.length <= 4000)
      clientSecret = reg.client_secret;
    patch.client_auth =
      reg.token_endpoint_auth_method === 'client_secret_post' ? 'in_body' : 'in_header';
  }
  return { config: patch, clientSecret };
}
