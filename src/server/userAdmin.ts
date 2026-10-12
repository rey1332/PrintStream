import { spawn } from 'node:child_process';
import path from 'node:path';
import { isBackupAdmin, backupNeedsTwoFactor } from '@/server/backup';

// The people in ETNA_ADMIN_EMAILS (two-factor verified) manage accounts, the
// same list that manages backups. The app's own database roles cannot create
// accounts, so the work is done by scripts/admin/users-api.mjs as the owner.
export const isUserAdmin = isBackupAdmin;
export const userAdminNeedsTwoFactor = backupNeedsTwoFactor;

const SCRIPT = path.join(process.cwd(), 'scripts', 'admin', 'users-api.mjs');
const TIMEOUT_MS = 30_000;

export interface AccountRow {
  email: string;
  full_name: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  locked: boolean;
  devices_2fa: number;
  active_sessions: number;
}

export function runUserAdminScript(
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    const done = (result: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve(result);
    };
    child.on('error', () => done({ ok: false, error: 'failed' }));
    child.on('close', () => {
      const last = stdout.trim().split(/\r?\n/).pop() ?? '';
      try {
        done(JSON.parse(last));
      } catch {
        done({ ok: false, error: 'failed' });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
