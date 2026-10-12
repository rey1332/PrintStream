import { NextResponse } from 'next/server';
import { withAuthRaw } from '@/lib/api-safe';
import { TerminalError } from '@/server/terminal/session';
import { uploadImport } from '@/server/terminal/service';
import { terminalContext } from '@/server/terminal/context';

// An import file, sent as the raw request body (not multipart) so it can be
// streamed to disk: POST /api/terminal/upload?workspaceId=…&name=…
export const POST = withAuthRaw(async ({ request }) => {
  const ctx = await terminalContext(request);
  if (!ctx) return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 });
  const url = request.nextUrl;
  const length = Number(request.headers.get('content-length') ?? '');
  if (!request.body) return NextResponse.json({ success: false, error: 'empty' });
  try {
    const data = await uploadImport(ctx, {
      workspaceId: url.searchParams.get('workspaceId'),
      fileName: url.searchParams.get('name') ?? '',
      length,
      body: request.body,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof TerminalError)
      return NextResponse.json({ success: false, error: error.code, vars: error.vars });
    throw error;
  }
});
