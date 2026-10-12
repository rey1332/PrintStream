import type { NextRequest } from 'next/server';
import { QueryExecutionError } from '@/lib/analytics/server';
import { identityOf, sessionFromCookies } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import { beginAsUser, getCatalog } from '@/server/db/execute';
import type { BuiltSql } from './summary-sql';

export async function selectAsUser(
  request: NextRequest,
  built: BuiltSql,
  path: string
): Promise<Record<string, unknown>[]> {
  const session = await sessionFromCookies(request.cookies);
  if (!session) throw new QueryExecutionError('forbidden');
  const executor = getAppExecutor();
  const catalog = await getCatalog(executor);
  try {
    return await executor.transaction(async (tx) => {
      await beginAsUser(tx, identityOf(session), path, 'GET', catalog);
      return (await tx.query(built.sql, built.params)).rows;
    });
  } catch (error) {
    // Only the code is logged: messages can carry values.
    const code = (error as { code?: string })?.code;
    console.error('[analytics summary]', code || 'error');
    throw new QueryExecutionError(
      code === '57014' ? 'timeout' : code === '42501' ? 'forbidden' : 'queryFailed'
    );
  }
}
