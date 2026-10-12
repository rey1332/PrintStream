import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import {
  cancelTermination,
  confirmTermination,
  endStaffAccess,
  legalHolds,
  releaseLegalHold,
  setLegalHold,
  setWorkspaceQuota,
  staffSessions,
  startStaffAccess,
  terminateWorkspace,
  workspaceStorage,
  workspaceTermination,
} from '@/server/admin/governance';
import { readAdminBody, text, UUID } from '@/server/admin/body';
import {
  adminFailure,
  adminFromRequest,
  adminNotFound,
  adminReply,
  requestMeta,
} from '@/server/admin/request';
import { mailConfigured, noticeMail, sendMail } from '@/server/mail/mailer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** Bytes from a number of GB (decimals allowed); null for empty. */
function gbToBytes(value: unknown): number | null | 'invalid' {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return 'invalid';
  return Math.round(n * GB);
}

function mbToBytes(value: unknown): number | null | 'invalid' {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 10_240) return 'invalid';
  return n * MB;
}

const dateOrNull = (value: unknown) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

async function notify(to: string | null | undefined, message: ReturnType<typeof noticeMail>) {
  if (!to || !mailConfigured()) return 'off';
  const sent = await sendMail({ to, ...message });
  return sent.ok ? 'sent' : 'failed';
}

// Storage, staff access, legal holds and termination of one company.
export async function GET(request: NextRequest, context: Context) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const { id } = await context.params;
  if (!UUID.test(id)) return adminReply({ success: false, error: 'not_found' }, 404);
  const ctx = { executor: getAppExecutor(), session: admin.session, meta: requestMeta(request) };
  try {
    const [storage, termination, sessions, holds] = await Promise.all([
      workspaceStorage(ctx, id),
      workspaceTermination(ctx, id),
      staffSessions(ctx, id),
      legalHolds(ctx, id),
    ]);
    return adminReply({ success: true, data: { storage, termination, sessions, holds } });
  } catch (error) {
    return adminFailure(error);
  }
}

// { action: 'start_staff', reason, ticket, hours } | { action: 'end_staff', sessionId }
// | { action: 'set_quota', quotaGb, unlimited, maxUploadMb, reason }
// | { action: 'set_hold', reason, until } | { action: 'release_hold', holdId, reason }
// | { action: 'terminate', reason, graceDays } | { action: 'cancel_termination', reason }
// | { action: 'confirm_termination', confirmName }
export async function POST(request: NextRequest, context: Context) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const { id } = await context.params;
  if (!UUID.test(id)) return adminReply({ success: false, error: 'not_found' }, 404);
  const body = await readAdminBody(request);
  const ctx = { executor: getAppExecutor(), session: admin.session, meta: requestMeta(request) };
  try {
    switch (body.action) {
      case 'start_staff': {
        const hours = Number(body.hours);
        if (!Number.isInteger(hours)) return adminReply({ success: false, error: 'invalid' }, 400);
        const r = await startStaffAccess(ctx, id, {
          reason: text(body.reason, 500),
          ticket: text(body.ticket, 100),
          hours,
        });
        const until = new Date(r.ends_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const emailed = await notify(
          r.owner_email,
          noticeMail(
            {
              id: `Akses staf ETNA ke ${r.workspace_name}`,
              en: `ETNA staff access to ${r.workspace_name}`,
            },
            {
              id: [
                `${r.admin_email ?? 'Staf ETNA'} membuka ${r.workspace_name} sebagai staf ETNA sampai ${until} WIB.`,
                `Alasan: ${text(body.reason, 500)} (referensi ${text(body.ticket, 100)}).`,
                'Setiap tindakan dicatat dan terlihat di aktivitas ruang kerja.',
              ],
              en: [
                `${r.admin_email ?? 'ETNA staff'} opened ${r.workspace_name} as ETNA staff until ${until} (Jakarta time).`,
                `Reason: ${text(body.reason, 500)} (reference ${text(body.ticket, 100)}).`,
                'Every action is recorded and shown in the workspace activity.',
              ],
            }
          )
        );
        return adminReply({ success: true, data: { ...r, emailed } });
      }
      case 'end_staff': {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        if (!UUID.test(sessionId)) return adminReply({ success: false, error: 'invalid' }, 400);
        await endStaffAccess(ctx, sessionId);
        return adminReply({ success: true });
      }
      case 'set_quota': {
        const quotaBytes = gbToBytes(body.quotaGb);
        const maxUploadBytes = mbToBytes(body.maxUploadMb);
        if (quotaBytes === 'invalid' || maxUploadBytes === 'invalid')
          return adminReply({ success: false, error: 'invalid' }, 400);
        await setWorkspaceQuota(ctx, id, {
          quotaBytes,
          unlimited: body.unlimited === true,
          maxUploadBytes,
          reason: text(body.reason, 500),
        });
        return adminReply({ success: true });
      }
      case 'set_hold': {
        const holdId = await setLegalHold(ctx, id, text(body.reason, 500), dateOrNull(body.until));
        return adminReply({ success: true, data: { id: holdId } });
      }
      case 'release_hold': {
        const holdId = typeof body.holdId === 'string' ? body.holdId : '';
        if (!UUID.test(holdId)) return adminReply({ success: false, error: 'invalid' }, 400);
        await releaseLegalHold(ctx, holdId, text(body.reason, 500));
        return adminReply({ success: true });
      }
      case 'terminate': {
        const graceDays = Number(body.graceDays ?? 30);
        if (!Number.isInteger(graceDays))
          return adminReply({ success: false, error: 'invalid' }, 400);
        const r = await terminateWorkspace(ctx, id, text(body.reason, 500), graceDays);
        const until = new Date(r.export_until).toLocaleDateString('id-ID', {
          timeZone: 'Asia/Jakarta',
        });
        const emailed = await notify(
          r.owner_email,
          noticeMail(
            {
              id: `Layanan PrintStream untuk ${r.workspace_name} diakhiri`,
              en: `PrintStream service for ${r.workspace_name} is ending`,
            },
            {
              id: [
                `Layanan untuk ${r.workspace_name} diakhiri. Ruang kerja ditangguhkan.`,
                `Sebagai Pemilik, Anda dapat mengunduh ekspor lengkap data sampai ${until}. Setelah itu data dihapus.`,
              ],
              en: [
                `Service for ${r.workspace_name} is ending. The workspace is suspended.`,
                `As its Owner you can download a full export of the data until ${until}. After that the data is deleted.`,
              ],
            }
          )
        );
        return adminReply({ success: true, data: { ...r, emailed } });
      }
      case 'cancel_termination':
        await cancelTermination(ctx, id, text(body.reason, 500));
        return adminReply({ success: true });
      case 'confirm_termination':
        await confirmTermination(ctx, id, text(body.confirmName, 120));
        return adminReply({ success: true });
      default:
        return adminReply({ success: false, error: 'invalid' }, 400);
    }
  } catch (error) {
    return adminFailure(error);
  }
}
