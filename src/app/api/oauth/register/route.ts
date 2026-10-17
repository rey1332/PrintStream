import { NextResponse, type NextRequest } from 'next/server';
import { clientIp } from '@/server/auth/request';
import { requestAllowed } from '@/server/auth/service';
import { getAuthDeps } from '@/server/config';
import { readLimitedText } from '@/server/http/body';
import { newSecret, redirectAllowed, sha256Hex } from '@/server/mcp/oauth';

// Dynamic client registration (RFC 7591) for MCP clients: POST JSON
// { client_name, redirect_uris, token_endpoint_auth_method? } → client_id
// (and a client_secret for confidential clients). Registering grants
// nothing: a member still signs in and approves on /oauth/authorize.

export const dynamic = 'force-dynamic';

const reply = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: string, description: string, status = 400) =>
  reply({ error, error_description: description }, status);

export async function POST(request: NextRequest) {
  const auth = getAuthDeps();
  if (!(await requestAllowed(auth, 'oauth_register', clientIp(request) ?? 'unknown', 10, 3600)))
    return fail('slow_down', 'Too many registrations; try again later.', 429);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await readLimitedText(request, 16_000)) || '{}');
  } catch {
    return fail('invalid_client_metadata', 'The body is not JSON.');
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length || uris.length > 5 || !uris.every((u) => typeof u === 'string'))
    return fail('invalid_redirect_uri', 'Give one to five redirect_uris.');
  const refused = (uris as string[]).find((u) => !redirectAllowed(u));
  if (refused)
    return fail(
      'invalid_redirect_uri',
      `This server does not send sign-ins to ${refused}. Its administrator can allow it (ETNA_MCP_OAUTH_REDIRECTS).`
    );
  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code'];
  if (!grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token'))
    return fail(
      'invalid_client_metadata',
      'Only authorization_code and refresh_token are supported.'
    );
  const method =
    typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method))
    return fail('invalid_client_metadata', 'Unsupported token_endpoint_auth_method.');
  const name =
    typeof body.client_name === 'string' && body.client_name.trim()
      ? body.client_name.trim().slice(0, 100)
      : 'MCP client';

  const clientId = newSecret('mcpc_');
  const secret = method === 'none' ? null : newSecret('mcps_');
  await auth.executor.transaction((tx) =>
    tx.query('SELECT auth.oauth_register($1, $2, $3, $4)', [
      clientId,
      name,
      uris,
      secret ? sha256Hex(secret) : null,
    ])
  );
  return reply(
    {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
    },
    201
  );
}
