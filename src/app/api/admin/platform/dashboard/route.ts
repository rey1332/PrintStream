import type { NextRequest } from 'next/server';
import { getAppExecutor } from '@/server/config';
import { DASHBOARD_HOURS, dashboard, type DashboardHours } from '@/server/admin/service';
import { migrationStatus } from '@/server/admin/system';
import {
  adminFailure,
  adminFromRequest,
  adminNotFound,
  adminReply,
  requestMeta,
} from '@/server/admin/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ?hours=24|168|720&tz=Asia/Jakarta
export async function GET(request: NextRequest) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const params = request.nextUrl.searchParams;
  const asked = Number(params.get('hours') ?? 24);
  const hours = (
    (DASHBOARD_HOURS as readonly number[]).includes(asked) ? asked : 24
  ) as DashboardHours;
  const timeZone = (params.get('tz') ?? 'UTC').slice(0, 64);
  try {
    const data = await dashboard(
      getAppExecutor(),
      admin.session,
      requestMeta(request),
      hours,
      timeZone
    );
    const database = (data.database ?? {}) as Record<string, unknown>;
    const migrations = await migrationStatus(database.migrations);
    return adminReply({ success: true, data: { ...data, database: { ...database, migrations } } });
  } catch (error) {
    return adminFailure(error);
  }
}
