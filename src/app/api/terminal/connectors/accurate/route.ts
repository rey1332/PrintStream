import { NextResponse } from 'next/server';
import { withAuthRaw } from '@/lib/api-safe';
import { publicOrigin } from '@/server/admin/request';
import { ACCURATE_ACCOUNT, ACCURATE_SCOPES } from '@/server/connectors/accurate';
import { terminalContext } from '@/server/terminal/context';
import { TerminalError, asUser, isUuid } from '@/server/terminal/session';
import { openJson, sealJson } from '@/server/vault';

// Authorising an Accurate Online connection (OAuth):
//   GET ?connectionId=…       → to Accurate's consent page
//   GET ?code=…&state=…       ← back from Accurate; the worker turns the code into tokens
// Only members allowed to manage connections, signed in with two-factor.

const back = (origin: string, result: string) =>
  NextResponse.redirect(`${origin}/terminal?tab=connections&oauth=${result}`, 303);

export const GET = withAuthRaw(async ({ request }) => {
  const ctx = await terminalContext(request);
  const origin = publicOrigin(request);
  if (!ctx) return back(origin, 'forbidden');
  const params = request.nextUrl.searchParams;
  const redirectUri = `${origin}/api/terminal/connectors/accurate`;

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
            `SELECT c.workspace_id, c.kind, c.config, public.erp_has_permission(c.workspace_id, 'integrations.manage') AS manage
             FROM public.ps_connections c WHERE c.id = $1`,
            [id]
          );
          return rows[0];
        }
      );
      if (!c || c.kind !== 'accurate' || !c.manage || ctx.identity.aal !== 'aal2')
        return back(origin, 'forbidden');
      const state = sealJson({ c: id, u: ctx.identity.userId, exp: Date.now() + 10 * 60_000 });
      const url = new URL(`${ACCURATE_ACCOUNT}/oauth/authorize`);
      url.searchParams.set('client_id', String(c.config.client_id ?? ''));
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', ACCURATE_SCOPES);
      url.searchParams.set('state', state);
      return NextResponse.redirect(url.toString(), 303);
    }

    // Back from Accurate.
    if (params.get('error')) return back(origin, 'denied');
    const code = params.get('code');
    const raw = params.get('state');
    if (!code || !raw || code.length > 2000) return back(origin, 'invalid');
    let state: { c: string; u: string; exp: number };
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
          code: sealJson({ code, redirect_uri: redirectUri }),
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
