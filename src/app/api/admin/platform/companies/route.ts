import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import { createCompany, INDUSTRIES } from '@/server/admin/service';
import { emailLink } from '@/server/admin/mailLink';
import { readAdminBody, text } from '@/server/admin/body';
import {
  adminFailure,
  adminFromRequest,
  adminNotFound,
  adminReply,
  publicOrigin,
  requestMeta,
} from '@/server/admin/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// { name, industry, ownerEmail, ownerName, reason, sendEmail }: a new ERP for
// a client with its Owner. A new Owner account gets an invitation link (shown
// once, and e-mailed when sendEmail and e-mail is set up).
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const body = await readAdminBody(request);
  const name = text(body.name, 120);
  const industry = text(body.industry, 30);
  const ownerEmail = text(body.ownerEmail, 300);
  if (
    !name ||
    !(INDUSTRIES as readonly string[]).includes(industry) ||
    !EMAIL.test(ownerEmail) ||
    ownerEmail.length > 254
  )
    return adminReply({ success: false, error: 'invalid' }, 400);
  const executor = getAppExecutor();
  const meta = requestMeta(request);
  try {
    const company = await createCompany(executor, admin.session, meta, publicOrigin(request), {
      name,
      industry,
      ownerEmail,
      ownerName: text(body.ownerName, 120),
      reason: text(body.reason, 500),
    });
    const emailed =
      company.url && company.expires_at && body.sendEmail === true
        ? await emailLink(executor, admin.session, meta, {
            userId: company.user_id,
            email: ownerEmail,
            kind: 'company',
            url: company.url,
            expiresAt: company.expires_at,
            company: name,
          })
        : null;
    return adminReply({
      success: true,
      data: {
        ...company,
        ...(company.url ? { purpose: 'invite' } : {}),
        emailed,
      },
    });
  } catch (error) {
    return adminFailure(error);
  }
}
