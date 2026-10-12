import { spawn } from 'node:child_process';
import path from 'node:path';
import { verifyPassword, type AuthDeps, type SessionInfo } from '@/server/auth/service';

export interface BackupFile {
  name: string;
  size: number;
  createdAt: string;
  label: string;
}

export function backupAdmins(env: Record<string, string | undefined> = process.env): string[] {
  return (env.ETNA_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Listed in ETNA_ADMIN_EMAILS (whether or not signed in with two-factor yet). */
export function isListedAdmin(
  email: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  return backupAdmins(env).includes(email.toLowerCase());
}

export function isBackupAdmin(
  session: Pick<SessionInfo, 'email' | 'aal' | 'nextLevel'>,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (session.aal !== 'aal2') return false;
  return backupAdmins(env).includes(session.email.toLowerCase());
}

export function backupNeedsTwoFactor(
  session: Pick<SessionInfo, 'email' | 'aal' | 'nextLevel'>,
  env: Record<string, string | undefined> = process.env
): boolean {
  return session.aal !== 'aal2' && backupAdmins(env).includes(session.email.toLowerCase());
}

const SCRIPT = path.join(process.cwd(), 'scripts', 'db', 'backup.mjs');
const TIMEOUT_MS = 30 * 60_000;

export function runBackupScript(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args, '--json'], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    const done = (result: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve(result);
    };
    child.on('error', () => done({ ok: false, error: 'The backup tool could not be started.' }));
    child.on('close', () => {
      const last = stdout.trim().split(/\r?\n/).pop() ?? '';
      try {
        done(JSON.parse(last));
      } catch {
        done({ ok: false, error: 'The backup tool did not answer.' });
      }
    });
  });
}

let running: Promise<Record<string, unknown>> | null = null;

/** Backups and restores one at a time: a second click gets { error: 'busy' }. */
export async function runBackupJob(args: string[]): Promise<Record<string, unknown>> {
  if (running) return { ok: false, error: 'busy' };
  running = runBackupScript(args);
  try {
    return await running;
  } finally {
    running = null;
  }
}

export type RestoreCheck = 'ok' | 'wrong_password' | 'rate_limited' | 'invalid';

export async function checkRestore(
  auth: AuthDeps,
  session: SessionInfo,
  input: { name: unknown; password: unknown; confirm: unknown; ip: string | null }
): Promise<RestoreCheck> {
  if (typeof input.name !== 'string' || !/^etna-\d{8}-\d{6}(-[a-z-]+)?\.dump$/.test(input.name))
    return 'invalid';
  if (input.confirm !== 'RESTORE') return 'invalid';
  if (typeof input.password !== 'string' || !input.password) return 'wrong_password';
  const checked = await verifyPassword(auth, session, input.password, input.ip);
  if (checked === 'rate_limited') return 'rate_limited';
  return checked ? 'ok' : 'wrong_password';
}
