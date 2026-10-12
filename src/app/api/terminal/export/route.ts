import { NextResponse } from 'next/server';
import { withAuthRaw } from '@/lib/api-safe';
import { TerminalError } from '@/server/terminal/session';
import { exportDataset } from '@/server/terminal/service';
import { terminalContext } from '@/server/terminal/context';

// A dataset as CSV: POST /api/terminal/export { id }. Two-factor sessions with
// 'datasets.export' only; every export is in the data-access log.
export const POST = withAuthRaw(async ({ request }) => {
  const ctx = await terminalContext(request);
  if (!ctx) return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 });
  const body = await request.json().catch(() => null);
  try {
    const { name, csv } = await exportDataset(ctx, body?.id);
    const file = `${name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'dataset'}.csv`;
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof TerminalError)
      return NextResponse.json({ success: false, error: error.code }, { status: 400 });
    throw error;
  }
});
