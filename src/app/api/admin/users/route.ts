import { NextResponse, type NextRequest } from 'next/server';
import { isSameOrigin, sessionFromCookies } from '@/server/auth/request';
import { isListedAdmin } from '@/server/backup';
import { readLimitedText } from '@/server/http/body';
import { isUserAdmin, runUserAdminScript, userAdminNeedsTwoFactor } from '@/server/userAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const reply = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
// For anyone who is not one of the server's administrators, this does not exist.
const notFound = () => reply({ success: false, error: 'not_found' }, 404);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(request: NextRequest) {
  const session = await sessionFromCookies(request.cookies);
  if (!session || !isListedAdmin(session.email)) return notFound();
  if (!isUserAdmin(session))
    return reply({
      success: true,
      data: { admin: false, needsTwoFactor: userAdminNeedsTwoFactor(session) },
    });
  const result = await runUserAdminScript({ action: 'list' });
  if (result.error === 'not_configured')
    return reply({ success: true, data: { admin: true, configured: false, users: [] } });
  if (!result.ok) return reply({ success: false, error: 'failed' }, 500);
  return reply({ success: true, data: { admin: true, configured: true, users: result.users } });
}

export async function POST(request: NextRequest) {
  const session = await sessionFromCookies(request.cookies);
  if (!session || !isListedAdmin(session.email)) return notFound();
  if (!isSameOrigin(request)) return reply({ success: false, error: 'forbidden' }, 403);
  if (!session || !isUserAdmin(session))
    return reply({ success: false, error: 'forbidden' }, session ? 403 : 401);

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse((await readLimitedText(request, 10_000)) || '{}');
  } catch {
    body = {};
  }

  if (body.action !== 'create') return reply({ success: false, error: 'invalid' }, 400);
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  if (!EMAIL.test(email) || email.length > 254)
    return reply({ success: false, error: 'invalid_email' }, 400);

  const result = await runUserAdminScript({ action: 'create', email, name });
  if (!result.ok) {
    const error =
      result.error === 'exists' || result.error === 'not_configured' ? result.error : 'failed';
    console.info(`[users] admin=${session.userId} create failed (${error})`);
    return reply({ success: false, error }, error === 'exists' ? 409 : 500);
  }
  // The address and the temporary password are not logged.
  console.info(`[users] admin=${session.userId} created an account`);
  return reply({
    success: true,
    data: { email: result.email, temporaryPassword: result.temporaryPassword },
  });
}
