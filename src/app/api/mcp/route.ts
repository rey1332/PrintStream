import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { clientIp } from '@/server/auth/request';
import { requestAllowed } from '@/server/auth/service';
import { getAppExecutor, getAuthDeps } from '@/server/config';
import { readLimitedText } from '@/server/http/body';
import {
  INTERNAL_ERROR,
  PARSE_ERROR,
  handleMessage,
  type JsonRpcResponse,
} from '@/server/mcp/protocol';
import { MCP_TOOLS, type McpContext } from '@/server/mcp/tools';

// MCP for AI assistants (Streamable HTTP): POST /api/mcp with
//   Authorization: Bearer psmcp_…   (a Terminal → AI → MCP access token)
// and one JSON-RPC message. Read-only tools over the token's Terminal, as
// the member who made the token (docs/TERMINAL.md, "MCP access"). No cookies:
// the token is the only credential, so browsers' cross-site requests carry
// nothing; requests from a web page of another origin are refused anyway.

export const dynamic = 'force-dynamic';

const TOKEN_RE = /^psmcp_[A-Za-z0-9_-]{32,64}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

const json = (body: JsonRpcResponse | Record<string, unknown>, status = 200, headers = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });

function unauthorized(message: string) {
  return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message } }, 401, {
    'WWW-Authenticate': 'Bearer realm="printstream-mcp"',
  });
}

/** A browser page of another site may not use the endpoint (DNS rebinding included). */
function foreignOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.get('host');
  } catch {
    return true;
  }
}

export async function POST(request: NextRequest) {
  if (foreignOrigin(request))
    return json(
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed' } },
      403
    );

  const auth = getAuthDeps();
  const ip = clientIp(request) ?? 'unknown';
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!TOKEN_RE.test(token)) {
    if (!(await requestAllowed(auth, 'mcp_bad', ip, 30, 60)))
      return json(
        { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many requests' } },
        429
      );
    return unauthorized('An MCP access token is required (Authorization: Bearer psmcp_…).');
  }

  const hash = createHash('sha256').update(token).digest('hex');
  const found = await auth.executor.transaction(
    async (tx) => (await tx.query('SELECT * FROM auth.mcp_token_use($1)', [hash])).rows[0]
  );
  if (!found) {
    if (!(await requestAllowed(auth, 'mcp_bad', ip, 30, 60)))
      return json(
        { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many requests' } },
        429
      );
    return unauthorized('The access token is not valid (revoked, expired, or the member left).');
  }
  if (!(await requestAllowed(auth, 'mcp', found.token_id, 120, 60)))
    return json(
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many requests' } },
      429,
      {
        'Retry-After': '60',
      }
    );

  let message: unknown;
  try {
    message = JSON.parse((await readLimitedText(request, 64_000)) || 'null');
  } catch {
    return json(
      { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } },
      400
    );
  }
  if (Array.isArray(message))
    return json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Send one message per request' },
      },
      400
    );

  const ctx: McpContext = {
    executor: getAppExecutor(),
    identity: { userId: found.user_id, email: found.email ?? '', aal: found.aal },
    workspaceId: found.workspace_id,
  };
  try {
    const response = await handleMessage(message, ctx, MCP_TOOLS);
    if (!response) return new NextResponse(null, { status: 202, headers: NO_STORE });
    return json(response);
  } catch (error) {
    console.error('[mcp]', (error as { code?: string })?.code || 'error');
    const id = (message as { id?: string | number })?.id ?? null;
    return json({ jsonrpc: '2.0', id, error: { code: INTERNAL_ERROR, message: 'Internal error' } });
  }
}

// No server-sent event stream: the client then uses POST only (MCP spec).
export function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST', ...NO_STORE } });
}

// Nothing to end: there are no sessions.
export function DELETE() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST', ...NO_STORE } });
}
