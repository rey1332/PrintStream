import { NextResponse } from 'next/server';
import { getAppExecutor } from '@/server/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIMEOUT_MS = 3000;
const CACHE_MS = 5000;

let last: { at: number; check: Promise<boolean> } | null = null;

function cachedReachable(): Promise<boolean> {
  const now = Date.now();
  if (!last || now - last.at > CACHE_MS)
    last = { at: now, check: databaseReachable().catch(() => false) };
  return last.check;
}

async function databaseReachable(): Promise<boolean> {
  const check = getAppExecutor().transaction((tx) => tx.query('select 1 as ok'));
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
  );
  const result = await Promise.race([check, timeout]);
  return result.rows[0]?.ok === 1;
}

export async function GET() {
  const started = Date.now();
  const reachable = await cachedReachable();
  return NextResponse.json(
    {
      status: reachable ? 'ok' : 'degraded',
      checks: { app: 'ok', database: reachable ? 'ok' : 'unreachable' },
      durationMs: Date.now() - started,
    },
    { status: reachable ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
  );
}
