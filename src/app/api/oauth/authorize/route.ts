import type { NextRequest } from 'next/server';
import { withAuth } from '@/lib/api-safe';
import { terminalContext } from '@/server/terminal/context';
import { asUser, isUuid } from '@/server/terminal/session';
import {
  SCOPE,
  issuerOf,
  newSecret,
  resourceOf,
  sha256Hex,
  validChallenge,
} from '@/server/mcp/oauth';

// The consent page's server side (/oauth/authorize), as the signed-in member:
//   { action: 'describe', ...the authorization request } → the client and the
//     Terminals the member may give it;
//   { action: 'approve', workspaceId, ... } → where to send the browser, with
//     a one-time code; { action: 'deny', ... } → the same, with access_denied.
// Nothing is sent to a redirect address the client did not register.

interface AuthRequest {
  client_id?: unknown;
  redirect_uri?: unknown;
  response_type?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
  state?: unknown;
  scope?: unknown;
  resource?: unknown;
}

const str = (v: unknown, max = 500) => (typeof v === 'string' && v.length <= max ? v : '');

function withParams(uri: string, params: Record<string, string>) {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  return url.toString();
}

export const POST = withAuth(async ({ request }) => {
  const ctx = await terminalContext(request as NextRequest);
  if (!ctx) return { success: false, error: 'forbidden' };
  const body = ((await request.json().catch(() => null)) ?? {}) as AuthRequest & {
    action?: unknown;
    workspaceId?: unknown;
  };
  const issuer = issuerOf(request as NextRequest);
  const clientId = str(body.client_id, 80);
  const redirect = str(body.redirect_uri);
  const state = str(body.state);

  const found = await asUser(ctx.executor, ctx.identity, '/oauth/authorize', async (tx) => {
    const client = (
      await tx.query('SELECT * FROM public.ps_oauth_client_get($1, $2)', [clientId, redirect])
    ).rows[0];
    const terminals = (
      await tx.query(
        `SELECT s.workspace_id AS id, s.name FROM public.ps_my_spaces() s
          WHERE s.terminal_on AND public.erp_has_permission(s.workspace_id, 'pipelines.view')
          ORDER BY lower(s.name)`
      )
    ).rows as { id: string; name: string }[];
    // No Terminal shown, but some exist and this session lacks two-factor:
    // most likely the role needs it there.
    const [{ spaces, aal }] = (
      await tx.query(
        `SELECT (SELECT count(*)::int FROM public.ps_my_spaces() s WHERE s.terminal_on) AS spaces,
                public.erp_session_aal() AS aal`
      )
    ).rows;
    const needsMfa = terminals.length === 0 && spaces > 0 && aal !== 'aal2' ? 1 : 0;
    return { client, terminals, needsMfa };
  });
  if (!found.client || !found.client.redirect_ok)
    return { success: false, error: 'invalid_client' };

  // From here on the redirect address is the client's own: errors go back to it.
  const back = (params: Record<string, string>) => ({
    success: true,
    data: { redirect: withParams(redirect, { ...params, state, iss: issuer }) },
  });
  if (body.response_type !== 'code') return back({ error: 'unsupported_response_type' });
  if (body.code_challenge_method !== 'S256' || !validChallenge(body.code_challenge))
    return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
  const scope = str(body.scope);
  if (scope && !scope.split(' ').every((s) => s === SCOPE)) return back({ error: 'invalid_scope' });
  const resource = str(body.resource);
  if (resource && resource.replace(/\/$/, '') !== resourceOf(issuer))
    return back({ error: 'invalid_target' });

  if (body.action === 'describe') {
    let host = '';
    try {
      host = new URL(redirect).host;
    } catch {
      // A registered address always parses.
    }
    return {
      success: true,
      data: {
        client: { name: found.client.name, redirectHost: host },
        terminals: found.terminals,
        needsMfa: found.needsMfa > 0,
      },
    };
  }
  if (body.action === 'deny') return back({ error: 'access_denied' });
  if (body.action !== 'approve') return { success: false, error: 'invalid' };

  const workspaceId = body.workspaceId;
  if (!isUuid(workspaceId) || !found.terminals.some((t) => t.id === workspaceId))
    return { success: false, error: 'forbidden' };
  const code = newSecret('psmco_');
  try {
    await asUser(ctx.executor, ctx.identity, '/oauth/authorize', (tx) =>
      tx.query('SELECT public.ps_oauth_approve($1, $2, $3, $4, $5)', [
        clientId,
        redirect,
        body.code_challenge,
        workspaceId,
        sha256Hex(code),
      ])
    );
  } catch (error) {
    const code = (error as { code?: string })?.code;
    return { success: false, error: code === 'mfaRequired' ? 'mfaRequired' : 'forbidden' };
  }
  return back({ code });
});
