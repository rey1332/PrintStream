import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { withAuth, withAuthRaw } from '@/lib/api-safe';
import { createRouteClient } from '@/server/db/route-client';
import { companyFolder } from '@/server/documents/storage';
import { terminalContext } from '@/server/terminal/context';
import { TerminalError, asUser, isUuid } from '@/server/terminal/session';

// The Owner's export of a company that ETNA is terminating (20261012000040):
// POST { action: 'list' | 'request', workspaceId }, GET ?id= downloads the file.

export const POST = withAuth(async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!isUuid(body?.workspaceId)) return { success: false, error: 'invalid' };
  const db = createRouteClient(request);
  if (body.action === 'list') {
    const { data, error } = await db.rpc('erp_company_exports', {
      p_workspace_id: body.workspaceId,
    });
    return error ? { success: false, error: 'failed' } : { success: true, data: data ?? [] };
  }
  if (body.action === 'request') {
    const { data, error } = await db.rpc('erp_request_company_export', {
      p_workspace_id: body.workspaceId,
    });
    if (error)
      return {
        success: false,
        error: /already being prepared/.test(error.message ?? '') ? 'busy' : 'forbidden',
      };
    return { success: true, data: { id: data } };
  }
  return { success: false, error: 'invalid' };
});

export const GET = withAuthRaw(async ({ request }) => {
  const ctx = await terminalContext(request);
  const id = request.nextUrl.searchParams.get('id');
  if (!ctx || !isUuid(id))
    return NextResponse.json({ success: false, error: 'notFound' }, { status: 404 });
  try {
    const file = await asUser(
      ctx.executor,
      ctx.identity,
      '/company-export/download',
      async (tx) => {
        const { rows } = await tx.query('SELECT * FROM public.erp_company_export_file($1)', [id]);
        return rows[0] as
          | { workspace_id: string; file_key: string; storage_dir: string | null }
          | undefined;
      }
    );
    if (!file || !/^company-export-[0-9a-f-]{36}\.json\.gz$/.test(file.file_key))
      throw new TerminalError('notFound');
    const full = path.join(
      companyFolder(file.workspace_id, file.storage_dir, 'artifacts'),
      file.file_key
    );
    const { size } = await fs.stat(full);
    return new Response(Readable.toWeb(createReadStream(full)) as ReadableStream, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(size),
        'Content-Disposition': `attachment; filename="${file.file_key}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof TerminalError || (error as { code?: string })?.code === 'ENOENT')
      return NextResponse.json({ success: false, error: 'notFound' }, { status: 404 });
    throw error;
  }
});
