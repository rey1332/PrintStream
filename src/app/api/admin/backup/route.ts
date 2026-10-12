import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, isSameOrigin, sessionFromCookies } from '@/server/auth/request';
import { getAuthDeps } from '@/server/config';
import {
  backupNeedsTwoFactor,
  checkRestore,
  isBackupAdmin,
  runBackupJob,
  runBackupScript,
} from '@/server/backup';
import { isListedAdmin } from '@/server/backup';
import { readLimitedText } from '@/server/http/body';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const reply = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
// For anyone who is not one of the server's administrators, this does not exist.
const notFound = () => reply({ success: false, error: 'not_found' }, 404);

export async function GET(request: NextRequest) {
  const session = await sessionFromCookies(request.cookies);
  if (!session || !isListedAdmin(session.email)) return notFound();
  if (!isBackupAdmin(session))
    return reply({
      success: true,
      data: { admin: false, needsTwoFactor: backupNeedsTwoFactor(session) },
    });
  const result = await runBackupScript(['list']);
  if (!result.ok) return reply({ success: false, error: 'failed' }, 500);
  return reply({
    success: true,
    data: { admin: true, configured: result.configured, dir: result.dir, backups: result.backups },
  });
}

export async function POST(request: NextRequest) {
  const session = await sessionFromCookies(request.cookies);
  if (!session || !isListedAdmin(session.email)) return notFound();
  if (!isSameOrigin(request)) return reply({ success: false, error: 'forbidden' }, 403);
  if (!session || !isBackupAdmin(session))
    return reply({ success: false, error: 'forbidden' }, session ? 403 : 401);

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse((await readLimitedText(request, 10_000)) || '{}');
  } catch {
    body = {};
  }

  if (body.action === 'backup') {
    const result = await runBackupJob(['backup']);
    if (result.error === 'busy') return reply({ success: false, error: 'busy' }, 409);
    console.info(`[backup] user=${session.userId} ${result.ok ? 'done' : 'failed'}`);
    return result.ok
      ? reply({ success: true, data: { backup: result.backup } })
      : reply({ success: false, error: 'failed', detail: result.error }, 500);
  }

  if (body.action === 'restore') {
    const check = await checkRestore(getAuthDeps(), session, {
      name: body.name,
      password: body.password,
      confirm: body.confirm,
      ip: clientIp(request),
    });
    if (check !== 'ok') {
      const status = check === 'invalid' ? 400 : check === 'rate_limited' ? 429 : 401;
      return reply({ success: false, error: check }, status);
    }
    console.info(`[backup] user=${session.userId} restore=${String(body.name)}`);
    const result = await runBackupJob(['restore', String(body.name)]);
    if (result.error === 'busy') return reply({ success: false, error: 'busy' }, 409);
    return result.ok
      ? reply({
          success: true,
          data: { restored: result.restored, safetyBackup: result.safetyBackup },
        })
      : reply({ success: false, error: 'failed', detail: result.error }, 500);
  }

  return reply({ success: false, error: 'invalid' }, 400);
}
