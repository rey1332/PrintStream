import type { NextRequest } from 'next/server';
import { withAuth } from '@/lib/api-safe';
import { identityOf, sessionFromCookies } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import { MAX_DOCUMENT_BYTES } from '@/lib/workspaces/limits';
import {
  DocumentError,
  deleteDocument,
  listDocuments,
  uploadDocument,
  type DocumentsContext,
} from '@/server/documents/service';

// Room for the multipart envelope around the largest allowed file.
const MAX_BODY_BYTES = MAX_DOCUMENT_BYTES + 64 * 1024;

async function contextOf(request: NextRequest): Promise<DocumentsContext | null> {
  const session = await sessionFromCookies(request.cookies);
  if (!session) return null;
  return {
    executor: getAppExecutor(),
    identity: identityOf(session),
    workspacesEnabled: process.env.NEXT_PUBLIC_ERP_WORKSPACES !== 'off',
  };
}

export const POST = withAuth(async ({ request }) => {
  const ctx = await contextOf(request);
  if (!ctx) return { success: false, error: 'forbidden' };
  try {
    if ((request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
      const length = Number(request.headers.get('content-length') ?? '0');
      if (!Number.isFinite(length) || length > MAX_BODY_BYTES)
        return { success: false, error: 'tooLarge' };
      const form = await request.formData().catch(() => null);
      const file = form?.get('file');
      if (!form || !(file instanceof File)) return { success: false, error: 'invalid' };
      if (file.size > MAX_DOCUMENT_BYTES) return { success: false, error: 'tooLarge' };
      const bytes = new Uint8Array(await file.arrayBuffer());
      return {
        success: true,
        data: await uploadDocument(ctx, form.get('workspaceId'), file.name, bytes),
      };
    }

    const body = await request.json().catch(() => null);
    switch (body?.action) {
      case 'list':
        return { success: true, data: await listDocuments(ctx, body.workspaceId) };
      case 'delete':
        await deleteDocument(ctx, body.id);
        return { success: true };
      default:
        return { success: false, error: 'invalid' };
    }
  } catch (error) {
    if (error instanceof DocumentError) return { success: false, error: error.code };
    throw error;
  }
});
