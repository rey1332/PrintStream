import type { NextRequest } from 'next/server';
import { readLimitedText } from '@/server/http/body';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A JSON object body (10 KB unless said otherwise); anything else reads as {}. */
export async function readAdminBody(
  request: NextRequest,
  maxBytes = 10_000
): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse((await readLimitedText(request, maxBytes)) || '{}');
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export const text = (value: unknown, max: number) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/** ?q=&filter=&offset=&limit= for the account and workspace lists. */
export function listParams<F extends string>(request: NextRequest, filters: readonly F[]) {
  const params = request.nextUrl.searchParams;
  const filter = params.get('filter') ?? '';
  const offset = Number(params.get('offset') ?? 0);
  const limit = Number(params.get('limit') ?? 50);
  return {
    query: params.get('q')?.trim().slice(0, 320) || null,
    filter: (filters as readonly string[]).includes(filter) ? (filter as F) : filters[0],
    offset: Number.isInteger(offset) && offset >= 0 ? Math.min(offset, 1_000_000) : 0,
    limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
  };
}
