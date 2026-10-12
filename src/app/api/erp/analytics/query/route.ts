import { withAuth } from '@/lib/api-safe';
import { createRouteClient } from '@/server/db/route-client';
import { validateQuery } from '@/lib/analytics/query';
import { QueryExecutionError, executeQuery, resolveScope } from '@/lib/analytics/server';

const TIME_BUDGET_MS = 7000;

export const POST = withAuth(async ({ userId, request }) => {
  const deadline = Date.now() + TIME_BUDGET_MS;
  const body = await request.json().catch(() => null);
  const validation = validateQuery(body?.spec);
  if (!validation.ok)
    return { success: false, error: 'invalidQuery', data: { errors: validation.errors } };

  const db = createRouteClient(request);
  try {
    const scope = await resolveScope(db, userId, body?.workspaceId, validation.spec);
    return { success: true, data: await executeQuery(db, validation.spec, scope, deadline) };
  } catch (error) {
    if (error instanceof QueryExecutionError)
      return { success: false, error: error.code === 'timeout' ? 'queryFailed' : error.code };
    throw error;
  }
});
