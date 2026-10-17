import { NextResponse, type NextRequest } from 'next/server';
import { issuerOf, protectedResourceMetadata } from '@/server/mcp/oauth';

// RFC 9728: where MCP clients learn how to sign in for /api/mcp (also asked
// for at /.well-known/oauth-protected-resource/api/mcp).

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return NextResponse.json(protectedResourceMetadata(issuerOf(request)), {
    headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' },
  });
}
