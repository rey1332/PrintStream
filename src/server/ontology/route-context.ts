import type { NextRequest } from 'next/server';
import { identityOf, sessionFromCookies } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import { OntologyError, type OntologyContext } from './service';

export async function ontologyContext(
  request: NextRequest,
  path: string
): Promise<OntologyContext> {
  const session = await sessionFromCookies(request.cookies);
  if (!session) throw new OntologyError('forbidden');
  return {
    executor: getAppExecutor(),
    identity: identityOf(session),
    workspacesEnabled: process.env.NEXT_PUBLIC_ERP_WORKSPACES !== 'off',
    path,
  };
}
