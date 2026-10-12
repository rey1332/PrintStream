import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { withAuthRaw } from '@/lib/api-safe';
import { publicOrigin } from '@/server/admin/request';
import { discoverMcpAuth } from '@/server/connectors/mcpAuth';
import { terminalContext } from '@/server/terminal/context';
import { TerminalError, asUser, isUuid } from '@/server/terminal/session';
import { openJson, sealJson } from '@/server/vault';

// Authorising a REST API or MCP connection with OAuth2 authorisation code:
//   GET ?connectionId=…       → to the provider's consent page (with PKCE)
//   GET ?code=…&state=…       ← back from the provider; the worker turns the code into tokens
// The address to register at the provider is this route's, under ETNA's public
// address. For an MCP server, missing addresses and the client ID are found
// from the server first (MCP authorization: protected resource and
// authorization server metadata, dynamic client registration).
// Only members allowed to manage connections, signed in with two-factor.

const back = (origin: string, result: string) =>
  NextResponse.redirect(`${origin}/terminal?tab=connections&oauth=${result}`, 303);

const base64url = (b: Buffer) => b.toString('base64url');

export const GET = withAuthRaw(async ({ request }) => {
  const ctx = await terminalContext(request);
  const origin = publicOrigin(request);
  if (!ctx) return back(origin, 'forbidden');
  const params = request.nextUrl.searchParams;
  const redirectUri = `${origin}/api/terminal/connectors/oauth`;

  try {
    if (params.get('connectionId')) {
      const id = params.get('connectionId');
      if (!isUuid(id)) return back(origin, 'invalid');
      const c = await asUser(
        ctx.executor,
        ctx.identity,
        '/terminal/connectors/oauth',
        async (tx) => {
          const { rows } = await tx.query(
            `SELECT c.workspace_id, c.kind, c.name, c.config, public.erp_has_permission(c.workspace_id, 'integrations.manage') AS manage
               FROM public.ps_connections c WHERE c.id = $1`,
            [id]
          );
          return rows[0];
        }
      );
      if (
        !c ||
        (c.kind !== 'rest' && c.kind !== 'mcp') ||
        c.config.auth !== 'oauth2_code' ||
        !c.manage ||
        ctx.identity.aal !== 'aal2'
      )
        return back(origin, 'forbidden');
      if (
        c.kind === 'mcp' &&
        (!c.config.authorize_url || !c.config.token_url || !c.config.client_id)
      ) {
        const found = await discoverMcpAuth(String(c.config.mcp_url ?? ''), redirectUri, {
          ...c.config,
        });
        const config = { ...c.config, ...found.config };
        await asUser(ctx.executor, ctx.identity, '/terminal/connectors/oauth', (tx) =>
          tx.query('SELECT public.ps_save_connection($1, $2, $3, $4, $5::jsonb, $6)', [
            c.workspace_id,
            id,
            c.kind,
            c.name,
            JSON.stringify(config),
            found.clientSecret ? sealJson({ client_secret: found.clientSecret }) : null,
          ])
        );
        c.config = config;
      }
      let url: URL;
      try {
        url = new URL(String(c.config.authorize_url ?? ''));
      } catch {
        return back(origin, 'invalid');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return back(origin, 'invalid');
      const verifier = c.config.pkce === 'off' ? null : base64url(randomBytes(32));
      // The verifier travels sealed inside the state, so only ETNA can read it.
      const state = sealJson({
        c: id,
        u: ctx.identity.userId,
        exp: Date.now() + 10 * 60_000,
        v: verifier,
      });
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', String(c.config.client_id ?? ''));
      url.searchParams.set('redirect_uri', redirectUri);
      if (c.config.scope) url.searchParams.set('scope', String(c.config.scope));
      if (c.config.audience) url.searchParams.set('audience', String(c.config.audience));
      if (c.kind === 'mcp') url.searchParams.set('resource', String(c.config.mcp_url ?? ''));
      url.searchParams.set('state', state);
      if (verifier) {
        url.searchParams.set(
          'code_challenge',
          base64url(createHash('sha256').update(verifier).digest())
        );
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return NextResponse.redirect(url.toString(), 303);
    }

    // Back from the provider.
    if (params.get('error')) return back(origin, 'denied');
    const code = params.get('code');
    const raw = params.get('state');
    if (!code || !raw || code.length > 4000) return back(origin, 'invalid');
    let state: { c: string; u: string; exp: number; v: string | null };
    try {
      state = openJson(raw);
    } catch {
      return back(origin, 'invalid');
    }
    // The same person, within ten minutes.
    if (state.u !== ctx.identity.userId || Date.now() > state.exp || !isUuid(state.c))
      return back(origin, 'invalid');
    await asUser(ctx.executor, ctx.identity, '/terminal/connectors/oauth', async (tx) => {
      const { rows } = await tx.query(
        'SELECT workspace_id FROM public.ps_connections WHERE id = $1',
        [state.c]
      );
      if (!rows[0]) throw new TerminalError('notFound');
      await tx.query(`SELECT public.ps_enqueue_job($1, 'connector.oauth', $2::jsonb)`, [
        rows[0].workspace_id,
        JSON.stringify({
          connection_id: state.c,
          code: sealJson({ code, redirect_uri: redirectUri, verifier: state.v ?? null }),
        }),
      ]);
    });
    return back(origin, 'pending');
  } catch (error) {
    if (error instanceof TerminalError)
      return back(origin, error.code === 'mfaRequired' ? 'mfa' : 'failed');
    throw error;
  }
});
