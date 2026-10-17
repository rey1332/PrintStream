import { NextResponse, type NextRequest } from 'next/server';
import { authorizationServerMetadata, issuerOf } from '@/server/mcp/oauth';

// RFC 8414: the sign-in endpoints for MCP clients (src/server/mcp/oauth.ts).

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return NextResponse.json(authorizationServerMetadata(issuerOf(request)), {
    headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' },
  });
}
