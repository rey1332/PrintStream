import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import {
  backupList,
  backupStatus,
  databaseLatency,
  databaseSize,
  diskSpace,
} from '@/server/admin/system';
import { runBackupJob } from '@/server/backup';
import { mailConfigured, mailSender, sendMail } from '@/server/mail/mailer';
import { authorizeOperation } from '@/server/admin/service';
import { readAdminBody, text } from '@/server/admin/body';
import {
  adminFailure,
  adminFromRequest,
  adminNotFound,
  adminReply,
  requestMeta,
} from '@/server/admin/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The app's own view of its health. Every admin role. ?detail=1 adds the
// backup list, database size and disk space (the System page).
export async function GET(request: NextRequest) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const executor = getAppExecutor();
  const detail = request.nextUrl.searchParams.get('detail') === '1';
  const [database, backups, size, disk, list] = await Promise.all([
    databaseLatency(executor),
    backupStatus().catch(() => null),
    detail ? databaseSize(executor) : Promise.resolve(null),
    detail ? diskSpace() : Promise.resolve(null),
    detail ? backupList().catch(() => null) : Promise.resolve(null),
  ]);
  return adminReply({
    success: true,
    data: {
      database: { ...database, sizeBytes: size },
      backups,
      app: { uptimeSeconds: Math.round(process.uptime()), node: process.version },
      ...(detail
        ? {
            disk,
            backupList: list,
            email: { configured: mailConfigured(), sender: mailSender() },
          }
        : {}),
    },
  });
}

// { action: 'backup' } (super admin) | { action: 'test_email', to } (any role).
// Both need a two-factor code from the last 10 minutes and are logged.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const body = await readAdminBody(request);
  const executor = getAppExecutor();
  const meta = requestMeta(request);
  try {
    if (body.action === 'backup') {
      await authorizeOperation(executor, admin.session, meta, 'BACKUP_STARTED');
      const result = await runBackupJob(['backup']);
      if (result.error === 'busy') return adminReply({ success: false, error: 'busy' }, 409);
      console.info(`[backup] admin=${admin.session.userId} ${result.ok ? 'done' : 'failed'}`);
      return result.ok
        ? adminReply({ success: true })
        : adminReply({ success: false, error: 'failed' }, 500);
    }
    if (body.action === 'test_email') {
      const to = text(body.to, 254);
      if (!EMAIL.test(to)) return adminReply({ success: false, error: 'invalid' }, 400);
      if (!mailConfigured()) return adminReply({ success: false, error: 'mail_off' }, 400);
      await authorizeOperation(executor, admin.session, meta, 'EMAIL_TEST_SENT', { email: to });
      const sent = await sendMail({
        to,
        subject: 'ETNA: e-mail uji / test e-mail',
        text: 'E-mail dari ETNA berfungsi.\n\nE-mail from ETNA works.',
      });
      return sent.ok
        ? adminReply({ success: true })
        : adminReply({ success: false, error: 'mail_failed', detail: sent.error }, 502);
    }
    return adminReply({ success: false, error: 'invalid' }, 400);
  } catch (error) {
    return adminFailure(error);
  }
}
