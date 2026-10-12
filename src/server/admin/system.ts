// System status for the admin dashboard: what the app itself can see about
// the database, migrations and backups. Nothing here is stored.

import { readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { Executor } from '@/server/db/executor';
import { runBackupScript } from '@/server/backup';

const TIMEOUT_MS = 3000;

/** Whether the database answers, and how fast (ms). */
export async function databaseLatency(
  executor: Executor
): Promise<{ ok: boolean; ms: number | null }> {
  const started = performance.now();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
  );
  try {
    const result = await Promise.race([
      executor.transaction((tx) => tx.query('select 1 as ok')),
      timeout,
    ]);
    if (result.rows[0]?.ok !== 1) return { ok: false, ms: null };
    return { ok: true, ms: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, ms: null };
  }
}

export interface MigrationStatus {
  applied: number;
  latest: string | null;
  /** Files in db/migrations not applied yet; null when the folder is not deployed. */
  pending: string[] | null;
}

/**
 * Compares the migrations applied to the database (names as the runner records
 * them, e.g. "migrations/20261012000014_platform_admin_dashboard.sql") with the
 * files this version of the app ships.
 */
export async function migrationStatus(appliedNames: unknown): Promise<MigrationStatus> {
  const applied = Array.isArray(appliedNames)
    ? appliedNames.filter((n): n is string => typeof n === 'string')
    : [];
  const done = new Set(applied.map((n) => path.posix.basename(n)));
  const latest = [...done].sort().pop() ?? null;
  let pending: string[] | null = null;
  try {
    const files = await readdir(path.join(process.cwd(), 'db', 'migrations'));
    pending = files.filter((f) => f.endsWith('.sql') && !done.has(f)).sort();
  } catch {
    pending = null;
  }
  return { applied: done.size, latest, pending };
}

export interface BackupStatus {
  configured: boolean;
  count: number;
  latest: string | null;
}

/** The newest backup (scripts/db/backup.mjs list); never the folder or file names. */
export async function backupStatus(): Promise<BackupStatus | null> {
  const result = await runBackupScript(['list']);
  if (!result.ok) return null;
  const backups = Array.isArray(result.backups)
    ? (result.backups as { createdAt?: unknown }[])
    : [];
  const times = backups
    .map((b) => (typeof b.createdAt === 'string' ? b.createdAt : null))
    .filter((t): t is string => t !== null)
    .sort();
  return {
    configured: result.configured === true,
    count: backups.length,
    latest: times.pop() ?? null,
  };
}

/** Size of the database in bytes, or null. */
export async function databaseSize(executor: Executor): Promise<number | null> {
  try {
    const { rows } = await executor.transaction((tx) =>
      tx.query('select pg_database_size(current_database())::text as bytes')
    );
    return Number(rows[0]?.bytes ?? NaN) || null;
  } catch {
    return null;
  }
}

/** Free and total space of the disk that holds the backups (else the app). */
export async function diskSpace(
  env: Record<string, string | undefined> = process.env
): Promise<{ free: number; total: number } | null> {
  const candidates = [
    env.ETNA_BACKUP_DIR
      ? path.resolve(env.ETNA_BACKUP_DIR)
      : env.ETNA_DATA_ROOT
        ? path.join(path.resolve(env.ETNA_DATA_ROOT), 'backups')
        : path.join(process.cwd(), 'storage', 'backups'),
    process.cwd(),
  ];
  for (const dir of candidates) {
    try {
      const s = await statfs(dir);
      return {
        free: Number(s.bavail) * Number(s.bsize),
        total: Number(s.blocks) * Number(s.bsize),
      };
    } catch {
      // Try the next folder.
    }
  }
  return null;
}

export interface BackupListEntry {
  createdAt: string;
  size: number;
  label: string;
}

/** The backups (date, size, label; never their path), newest first. */
export async function backupList(): Promise<{
  configured: boolean;
  backups: BackupListEntry[];
} | null> {
  const result = await runBackupScript(['list']);
  if (!result.ok) return null;
  const backups = (Array.isArray(result.backups) ? result.backups : [])
    .map((b: { createdAt?: unknown; size?: unknown; label?: unknown }) => ({
      createdAt: typeof b.createdAt === 'string' ? b.createdAt : '',
      size: Number(b.size) || 0,
      label: typeof b.label === 'string' ? b.label : '',
    }))
    .filter((b) => b.createdAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50);
  return { configured: result.configured === true, backups };
}
