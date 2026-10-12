import { withAuth } from '@/lib/api-safe';
import { createRouteClient } from '@/server/db/route-client';
import { resolveConsoleAccess } from '@/server/console/access';
import {
  isServerCommand,
  runConsoleCommand,
  type ConsoleCommandDb,
} from '@/server/console/commands';
import { APP_VERSION } from '@/server/app-version';

const NOT_AVAILABLE = 'The console is only available to Owners and Finance members.';

export const GET = withAuth(async ({ request }) => {
  const db = createRouteClient(request);
  const access = await resolveConsoleAccess(db, request.nextUrl.searchParams.get('workspace'));
  return {
    success: true,
    data: access.allowed ? { allowed: true, role: access.role } : { allowed: false },
  };
});

export const POST = withAuth(async ({ userId, request }) => {
  const body = await request.json().catch(() => null);
  const command = body?.command;
  if (!isServerCommand(command)) return { success: false, error: 'Unknown command.' };

  const db = createRouteClient(request);
  const access = await resolveConsoleAccess(db, body?.workspaceId);
  if (!access.allowed) return { success: false, error: NOT_AVAILABLE };

  const { data } = await db.auth.getUser();
  const fullName = data.user?.user_metadata?.full_name;
  const displayName =
    typeof fullName === 'string' && fullName.trim()
      ? fullName.trim().slice(0, 80)
      : 'Signed-in user';

  const result = await runConsoleCommand(command, body?.target, {
    db: db as unknown as ConsoleCommandDb,
    userId,
    displayName,
    access,
    version: APP_VERSION,
  });
  return result.ok
    ? { success: true, data: { lines: result.lines } }
    : { success: false, error: result.error };
});
