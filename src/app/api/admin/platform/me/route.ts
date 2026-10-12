import type { NextRequest } from 'next/server';
import { ADMIN_REAUTH_MINUTES } from '@/server/auth/service';
import { adminFromRequest, adminNotFound, adminReply } from '@/server/admin/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The signed-in admin's role and session state, for the admin panel.
export async function GET(request: NextRequest) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const { session, role } = admin;
  const reauthUntil = session.reauthenticatedAt
    ? new Date(
        new Date(session.reauthenticatedAt).getTime() + ADMIN_REAUTH_MINUTES * 60_000
      ).toISOString()
    : null;
  return adminReply({
    success: true,
    data: {
      email: session.email,
      role,
      twoFactor: session.aal === 'aal2',
      reauthUntil: reauthUntil && reauthUntil > new Date().toISOString() ? reauthUntil : null,
    },
  });
}
