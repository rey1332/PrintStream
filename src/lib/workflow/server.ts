// Helpers for the workflow API routes. Server code only.

import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { createRouteClient } from '@/server/db/route-client';
import { stableStringify } from './graph';

export const dbFor = createRouteClient;

export function workflowIdFrom(request: NextRequest): string {
  return request.nextUrl.pathname.split('/').filter(Boolean)[3] ?? '';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

export function isMigrationMissing(
  error: { code?: string; message?: string } | null | undefined
): boolean {
  if (!error) return false;
  return ['42703', '42P01', '42883', 'PGRST202', 'PGRST204', 'PGRST200'].includes(
    String(error.code)
  );
}

export function graphHash(graph: unknown): string {
  return createHash('sha256').update(stableStringify(graph)).digest('hex');
}
