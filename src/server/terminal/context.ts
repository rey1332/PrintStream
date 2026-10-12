import type { NextRequest } from 'next/server';
import { identityOf, sessionFromCookies } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import type { TerminalContext } from './service';

/** The signed-in user's TERMINAL context for an API route, or null. */
export async function terminalContext(request: NextRequest): Promise<TerminalContext | null> {
  const session = await sessionFromCookies(request.cookies);
  return session ? { executor: getAppExecutor(), identity: identityOf(session) } : null;
}
