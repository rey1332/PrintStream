import type { NextRequest } from 'next/server';
import { RestClient } from '@/lib/db/rest-client';
import { getAppExecutor } from '@/server/config';
import { identityOf, sessionFromCookies } from '@/server/auth/request';
import type { SessionInfo } from '@/server/auth/service';
import { executeSpec } from './execute';

export function createRouteClient(request: NextRequest) {
  let session: Promise<SessionInfo | null> | null = null;
  const currentSession = () => (session ??= sessionFromCookies(request.cookies));
  const rest = new RestClient(async (spec) => {
    const s = await currentSession();
    return executeSpec(getAppExecutor(), s ? identityOf(s) : null, spec);
  });
  return {
    from: (table: string) => rest.from(table),
    rpc: (
      fn: string,
      args?: Record<string, unknown>,
      options?: { count?: 'exact'; head?: boolean }
    ) => rest.rpc(fn, args, options),
    auth: {
      async getUser() {
        const s = await currentSession();
        return s
          ? { data: { user: s.user }, error: null }
          : {
              data: { user: null },
              error: { name: 'AuthApiError', message: 'Auth session missing!', status: 401 },
            };
      },
    },
  };
}
