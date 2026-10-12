import { NextResponse, type NextRequest } from 'next/server';
import { identityOf, sessionFromCookies } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import { DocumentError, readDocument } from '@/server/documents/service';

const STATUS: Record<string, number> = {
  forbidden: 403,
  notFound: 404,
  missing: 410,
  timeout: 504,
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await sessionFromCookies(request.cookies);
  if (!session) return NextResponse.json({ success: false, error: 'forbidden' }, { status: 401 });
  const { id } = await params;
  try {
    const file = await readDocument(
      {
        executor: getAppExecutor(),
        identity: identityOf(session),
        workspacesEnabled: process.env.NEXT_PUBLIC_ERP_WORKSPACES !== 'off',
      },
      id
    );
    const asciiName = file.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return new NextResponse(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        'Content-Type': file.contentType,
        'Content-Length': String(file.bytes.byteLength),
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof DocumentError) {
      return NextResponse.json(
        { success: false, error: error.code },
        { status: STATUS[error.code] ?? 400 }
      );
    }
    console.error('[documents] download failed');
    return NextResponse.json({ success: false, error: 'failed' }, { status: 500 });
  }
}
