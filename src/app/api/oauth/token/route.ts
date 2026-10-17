import { NextResponse, type NextRequest } from 'next/server';
import { clientIp } from '@/server/auth/request';
import { requestAllowed } from '@/server/auth/service';
import { getAuthDeps } from '@/server/config';
import { readLimitedText } from '@/server/http/body';
import {
  ACCESS_TOKEN_SECONDS,
  CLIENT_ID_RE,
  SCOPE,
  newSecret,
  s256,
  sha256Hex,
  validVerifier,
} from '@/server/mcp/oauth';

// The OAuth token endpoint for MCP clients (RFC 6749 with PKCE, OAuth 2.1):
// grant_type=authorization_code (code, redirect_uri, code_verifier) or
// grant_type=refresh_token. Answers access tokens of an hour and refresh
// tokens that rotate. Form-encoded or JSON bodies.

export const dynamic = 'force-dynamic';

const reply = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
const fail = (error: string, description: string, status = 400) =>
  reply({ error, error_description: description }, status);

async function readBody(request: NextRequest): Promise<Record<string, string>> {
  const text = await readLimitedText(request, 16_000);
  if ((request.headers.get('content-type') ?? '').includes('application/json')) {
    const json = JSON.parse(text || '{}');
    return Object.fromEntries(
      Object.entries(json).filter(([, v]) => typeof v === 'string')
    ) as Record<string, string>;
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** client_id and secret from the body or HTTP Basic (client_secret_basic). */
function clientOf(request: NextRequest, body: Record<string, string>) {
  const header = request.headers.get('authorization') ?? '';
  if (header.startsWith('Basic ')) {
    try {
      const [id, secret] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
      return { id: decodeURIComponent(id ?? ''), secret: decodeURIComponent(secret ?? '') };
    } catch {
      return { id: '', secret: '' };
    }
  }
  return { id: body.client_id ?? '', secret: body.client_secret ?? '' };
}

export async function POST(request: NextRequest) {
  const auth = getAuthDeps();
  if (!(await requestAllowed(auth, 'oauth_token', clientIp(request) ?? 'unknown', 60, 60)))
    return fail('slow_down', 'Too many requests; try again in a minute.', 429);

  let body: Record<string, string>;
  try {
    body = await readBody(request);
  } catch {
    return fail('invalid_request', 'The body could not be read.');
  }
  const client = clientOf(request, body);
  if (!CLIENT_ID_RE.test(client.id)) return fail('invalid_client', 'Unknown client.', 401);
  const secretHash = client.secret ? sha256Hex(client.secret) : null;
  const access = newSecret('psmcp_');
  const refresh = newSecret('psmcr_');

  let error: string | null;
  if (body.grant_type === 'authorization_code') {
    if (!body.code || !body.redirect_uri || !validVerifier(body.code_verifier))
      return fail('invalid_request', 'code, redirect_uri and code_verifier (PKCE) are required.');
    error = await auth.executor.transaction(
      async (tx) =>
        (
          await tx.query('SELECT auth.oauth_exchange_code($1, $2, $3, $4, $5, $6, $7, $8) AS e', [
            sha256Hex(body.code),
            client.id,
            secretHash,
            body.redirect_uri,
            s256(body.code_verifier),
            sha256Hex(access),
            access.slice(0, 12),
            sha256Hex(refresh),
          ])
        ).rows[0].e
    );
  } else if (body.grant_type === 'refresh_token') {
    if (!body.refresh_token) return fail('invalid_request', 'refresh_token is required.');
    error = await auth.executor.transaction(
      async (tx) =>
        (
          await tx.query('SELECT auth.oauth_refresh($1, $2, $3, $4, $5, $6) AS e', [
            sha256Hex(body.refresh_token),
            client.id,
            secretHash,
            sha256Hex(access),
            access.slice(0, 12),
            sha256Hex(refresh),
          ])
        ).rows[0].e
    );
  } else {
    return fail('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }

  if (error === 'invalid_client')
    return fail('invalid_client', 'Unknown client or wrong secret.', 401);
  if (error)
    return fail(
      'invalid_grant',
      'The code or refresh token is not valid (used, expired or revoked).'
    );
  return reply({
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refresh,
    scope: SCOPE,
  });
}
