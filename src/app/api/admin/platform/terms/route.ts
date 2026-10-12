import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import { listTerms, saveTermsDraft, type TermsContent } from '@/server/admin/service';
import { readAdminBody, text, UUID } from '@/server/admin/body';
import {
  adminFailure,
  adminFromRequest,
  adminNotFound,
  adminReply,
  requestMeta,
} from '@/server/admin/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_TEXT = 200_000;

export async function GET(request: NextRequest) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  try {
    const versions = await listTerms(getAppExecutor(), admin.session, requestMeta(request));
    return adminReply({ success: true, data: { versions } });
  } catch (error) {
    return adminFailure(error);
  }
}

// Save a draft: { id?, label, content: { en, id?, zh? } }. The database checks
// the rest (super admin, fresh code, English required, drafts only).
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  // Up to three texts of MAX_TEXT characters (Chinese takes 3 bytes each).
  const body = await readAdminBody(request, 2_000_000);
  const id = typeof body.id === 'string' && UUID.test(body.id) ? body.id : null;
  const raw = (typeof body.content === 'object' && body.content) || {};
  const pick = (lang: 'en' | 'id' | 'zh') => {
    const value = (raw as Record<string, unknown>)[lang];
    return typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
  };
  const content: TermsContent = { en: pick('en') };
  if (pick('id').trim()) content.id = pick('id');
  if (pick('zh').trim()) content.zh = pick('zh');
  try {
    const saved = await saveTermsDraft(getAppExecutor(), admin.session, requestMeta(request), {
      id,
      label: text(body.label, 60),
      content,
    });
    return adminReply({ success: true, data: { id: saved } });
  } catch (error) {
    return adminFailure(error);
  }
}
