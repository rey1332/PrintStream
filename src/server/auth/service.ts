import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import type { Executor, SqlTx } from '@/server/db/executor';
import { generateSecret, otpauthUri, verifyTotp } from './totp';
import { openSecret, sealSecret } from './secret-box';
import { newPasswordProblem, PASSWORD_MIN_LENGTH } from '@/lib/auth/password-policy';
import { createSlots, SlotsFullError, type Slots } from '@/server/slots';

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const FAILURES_PER_EMAIL = 5;
const FAILURES_PER_EMAIL_AND_IP = 5;
const FAILURES_PER_EMAIL_ANY_IP = 20;
const FAILURES_PER_IP = 30;
// Wrong passwords lock sign-in briefly; wrong two-factor codes (six digits, easier to
// guess again and again) lock it for longer.
const FAILURE_WINDOW = '2 minutes';
const MFA_FAILURE_WINDOW = '15 minutes';
export const MFA_FAILURES = 5;
export const MAX_FACTORS = 10;
const BCRYPT_COST = 12;
const DUMMY_HASH = '$2b$12$6AMSK1sSnJWjtBZiv6DfgO1yC71b5mgb5a0svyQTnoozx15MkwwCW';

export interface AuthDeps {
  executor: Executor;
  mfaKey: Buffer;
  asRole?: 'etna_auth';
  slots?: Slots;
  now?: () => number;
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  email: string;
  aal: 'aal1' | 'aal2';
  nextLevel: 'aal1' | 'aal2';
  expiresAt: string;
  /** Last time this session re-entered a two-factor code (admin actions). */
  reauthenticatedAt: string | null;
  user: {
    id: string;
    email: string;
    email_confirmed_at: string | null;
    created_at: string;
    last_sign_in_at: string | null;
    user_metadata: Record<string, unknown>;
  };
}

export interface FactorInfo {
  id: string;
  friendly_name: string | null;
  factor_type: 'totp';
  status: 'unverified' | 'verified';
  created_at: string;
  updated_at: string;
}

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

async function inTx<T>(deps: AuthDeps, fn: (tx: SqlTx) => Promise<T>): Promise<T> {
  return deps.executor.transaction(async (tx) => {
    if (deps.asRole) await tx.query('SET LOCAL ROLE etna_auth');
    return fn(tx);
  });
}

const nowMs = (deps: AuthDeps) => (deps.now ? deps.now() : Date.now());

export const hashSlots = createSlots(4, 16);

async function withHashSlot<T>(deps: AuthDeps, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await (deps.slots ?? hashSlots).run(fn);
  } catch (error) {
    if (error instanceof SlotsFullError) return undefined;
    throw error;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

async function lockAccount(tx: SqlTx, kind: 'login' | 'mfa', key: string): Promise<void> {
  await tx.query('select pg_advisory_xact_lock(hashtext($1))', [
    `etna:${kind}:${key.toLowerCase()}`,
  ]);
}

async function passwordLocked(tx: SqlTx, email: string, ip: string | null): Promise<boolean> {
  await lockAccount(tx, 'login', email);
  const { rows } = await tx.query(
    `select count(*) filter (where lower(email) = lower($1))::int as by_email,
            count(*) filter (where lower(email) = lower($1) and $2::text is not null and ip = $2)::int as by_email_ip,
            count(*) filter (where $2::text is not null and ip = $2)::int as by_ip
       from auth.login_attempts
      where not succeeded and attempted_at > now() - $3::interval`,
    [email, ip, FAILURE_WINDOW]
  );
  const f = rows[0];
  if (!ip) return f.by_email >= FAILURES_PER_EMAIL;
  return (
    f.by_email_ip >= FAILURES_PER_EMAIL_AND_IP ||
    f.by_email >= FAILURES_PER_EMAIL_ANY_IP ||
    f.by_ip >= FAILURES_PER_IP
  );
}

async function recordAttempt(
  tx: SqlTx,
  email: string,
  ip: string | null,
  succeeded: boolean
): Promise<string> {
  const { rows } = await tx.query(
    'insert into auth.login_attempts (email, ip, succeeded) values ($1, $2, $3) returning id',
    [email.slice(0, 320), ip, succeeded]
  );
  if (Math.random() < 0.01)
    await tx.query(
      `delete from auth.login_attempts where attempted_at < now() - interval '30 days'`
    );
  return String(rows[0].id);
}

/**
 * Counts one request for `key` (e.g. a client address) in a fixed window of
 * `windowSeconds`, in the database (auth.request_limits), so the limit holds
 * across restarts and app servers. True while the count is within `limit`.
 */
export async function requestAllowed(
  deps: AuthDeps,
  bucket: string,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  return inTx(deps, async (tx) => {
    const { rows } = await tx.query(
      `insert into auth.request_limits (bucket, key, window_start)
       values ($1, $2, to_timestamp(floor(extract(epoch from clock_timestamp()) / $3) * $3))
       on conflict (bucket, key, window_start) do update set hits = auth.request_limits.hits + 1
       returning hits`,
      [bucket.slice(0, 64), key.slice(0, 128) || 'unknown', windowSeconds]
    );
    if (Math.random() < 0.01)
      await tx.query(
        `delete from auth.request_limits where window_start < now() - interval '1 day'`
      );
    return Number(rows[0].hits) <= limit;
  });
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

type AuthEvent =
  | 'LOGIN_SUCCEEDED'
  | 'LOGIN_FAILED'
  | 'LOGIN_RATE_LIMITED'
  | 'LOGOUT'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_CHANGE_FAILED'
  | 'PASSWORD_CHECK_FAILED'
  | 'PASSWORD_RESET_COMPLETED'
  | 'PASSWORD_RESET_FAILED'
  | 'MFA_FACTOR_ADDED'
  | 'MFA_FACTOR_REMOVED'
  | 'MFA_CHALLENGE_SUCCEEDED'
  | 'MFA_CHALLENGE_FAILED'
  | 'MFA_RATE_LIMITED'
  | 'ADMIN_REAUTHENTICATED'
  | 'ADMIN_REAUTH_FAILED'
  | 'TERMS_DECLINED';

// One row in the security log (etna_platform.security_events), written in the
// same transaction as what it describes. Never passwords, codes or tokens.
async function logEvent(
  tx: SqlTx,
  event: AuthEvent,
  user: { id: string | null; email: string },
  sessionId: string | null,
  meta: RequestMeta,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const outcome = /FAILED|RATE_LIMITED/.test(event) ? 'failure' : 'success';
  await tx.query('select etna_platform.log_auth_event($1, $2, $3, $4, $5, $6, $7, $8)', [
    event,
    outcome,
    user.id,
    user.email.slice(0, 320) || null,
    sessionId,
    meta.ip?.slice(0, 64) ?? null,
    meta.userAgent?.slice(0, 400) ?? null,
    JSON.stringify(metadata),
  ]);
}

const sessionUser = (session: SessionInfo) => ({ id: session.userId, email: session.email });

// What was typed as the e-mail of a failed sign-in, only if it looks like one:
// people sometimes type their password into the e-mail field.
const typedAccount = (email: string) => ({
  id: null,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
});

export type SignInResult =
  | { ok: true; token: string; session: SessionInfo }
  | { ok: false; reason: 'invalid' | 'rate_limited' };

export async function signIn(
  deps: AuthDeps,
  input: { email: string; password: string; ip: string | null; userAgent: string | null }
): Promise<SignInResult> {
  const email = input.email.trim();
  if (!email || !input.password || email.length > 320 || input.password.length > 1024)
    return { ok: false, reason: 'invalid' };

  const meta = { ip: input.ip, userAgent: input.userAgent };
  const outcome = await withHashSlot(deps, async () => {
    const pending = await inTx(deps, async (tx) => {
      if (await passwordLocked(tx, email, input.ip)) {
        await logEvent(tx, 'LOGIN_RATE_LIMITED', typedAccount(email), null, meta);
        return null;
      }
      const { rows } = await tx.query(
        `select id, email, encrypted_password, coalesce(banned_until > now(), false) as banned from auth.users where lower(email) = lower($1)`,
        [email]
      );
      const attemptId = await recordAttempt(tx, email, input.ip, false);
      return { user: rows[0] as Record<string, unknown> | undefined, attemptId };
    });
    if (!pending) return { kind: 'rate_limited' as const };

    const { user, attemptId } = pending;
    const hash = (user?.encrypted_password as string | undefined) || DUMMY_HASH;
    const valid = await bcrypt.compare(input.password, hash);
    // Compared in SQL: "infinity" and far-future dates are not JS-safe.
    if (!user || !valid || user.banned === true) {
      const reason = !user ? 'unknown_account' : !valid ? 'wrong_password' : 'disabled';
      const account = user
        ? { id: String(user.id), email: String(user.email) }
        : typedAccount(email);
      await inTx(deps, (tx) => logEvent(tx, 'LOGIN_FAILED', account, null, meta, { reason }));
      return { kind: 'invalid' as const };
    }

    const token = newToken();
    const opened = await inTx(deps, async (tx) => {
      const account = { id: String(user.id), email: String(user.email) };
      // Still the same password and not blocked since it was read.
      const { rows } = await tx.query(
        `update auth.users set last_sign_in_at = now()
          where id = $1 and encrypted_password = $2 and not coalesce(banned_until > now(), false)
          returning id`,
        [user.id, hash]
      );
      if (!rows[0]) {
        await logEvent(tx, 'LOGIN_FAILED', account, null, meta, { reason: 'changed' });
        return false;
      }
      await tx.query('delete from auth.login_attempts where id = $1', [attemptId]);
      await recordAttempt(tx, email, input.ip, true);
      const expires = new Date(nowMs(deps) + SESSION_MAX_MS).toISOString();
      const { rows: opened } = await tx.query(
        `insert into auth.sessions (user_id, token_hash, aal, expires_at, ip, user_agent) values ($1, $2, 'aal1', $3, $4, $5) returning id`,
        [user.id, hashToken(token), expires, input.ip, input.userAgent?.slice(0, 400) ?? null]
      );
      await logEvent(tx, 'LOGIN_SUCCEEDED', account, String(opened[0].id), meta);
      return true;
    });
    return opened ? { kind: 'ok' as const, token } : { kind: 'invalid' as const };
  });

  if (!outcome) return { ok: false, reason: 'rate_limited' };
  if (outcome.kind !== 'ok') return { ok: false, reason: outcome.kind };
  const session = await resolveSession(deps, outcome.token);
  if (!session) return { ok: false, reason: 'invalid' };
  return { ok: true, token: outcome.token, session };
}

export async function resolveSession(
  deps: AuthDeps,
  token: string | undefined | null
): Promise<SessionInfo | null> {
  if (!token || token.length > 200) return null;
  return inTx(deps, async (tx) => {
    const { rows } = await tx.query(
      `select s.id as session_id, s.aal, s.expires_at, s.last_seen_at, s.reauthenticated_at,
              u.id as user_id, u.email, u.email_confirmed_at, u.created_at, u.last_sign_in_at, u.raw_user_meta_data, coalesce(u.banned_until > now(), false) as banned,
              exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified') as has_factor
         from auth.sessions s
         join auth.users u on u.id = s.user_id
        where s.token_hash = $1 and s.revoked_at is null`,
      [hashToken(token)]
    );
    const row = rows[0];
    if (!row) return null;
    const now = nowMs(deps);
    const lastSeen = new Date(row.last_seen_at).getTime();
    if (new Date(row.expires_at).getTime() <= now || lastSeen + SESSION_IDLE_MS <= now) return null;
    if (row.banned === true) return null;
    if (now - lastSeen > TOUCH_INTERVAL_MS) {
      await tx.query('update auth.sessions set last_seen_at = now() where id = $1', [
        row.session_id,
      ]);
    }
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      email: row.email,
      aal: row.aal,
      nextLevel: row.has_factor ? 'aal2' : 'aal1',
      expiresAt: new Date(
        Math.min(new Date(row.expires_at).getTime(), now + SESSION_IDLE_MS)
      ).toISOString(),
      reauthenticatedAt: row.reauthenticated_at
        ? new Date(row.reauthenticated_at).toISOString()
        : null,
      user: {
        id: row.user_id,
        email: row.email,
        email_confirmed_at: row.email_confirmed_at
          ? new Date(row.email_confirmed_at).toISOString()
          : null,
        created_at: new Date(row.created_at).toISOString(),
        last_sign_in_at: row.last_sign_in_at ? new Date(row.last_sign_in_at).toISOString() : null,
        user_metadata: row.raw_user_meta_data ?? {},
      },
    } satisfies SessionInfo;
  });
}

export async function signOut(
  deps: AuthDeps,
  token: string | undefined | null,
  meta: RequestMeta = {}
): Promise<void> {
  if (!token) return;
  await inTx(deps, async (tx) => {
    const { rows } = await tx.query(
      `update auth.sessions s set revoked_at = now()
         from auth.users u
        where s.token_hash = $1 and s.revoked_at is null and u.id = s.user_id
        returning s.id, u.id as user_id, u.email`,
      [hashToken(token)]
    );
    if (rows[0])
      await logEvent(
        tx,
        'LOGOUT',
        { id: String(rows[0].user_id), email: rows[0].email },
        String(rows[0].id),
        meta
      );
  });
}

export async function revokeAllSessions(deps: AuthDeps, userId: string): Promise<number> {
  return inTx(deps, async (tx) => {
    const { rows } = await tx.query(
      'update auth.sessions set revoked_at = now() where user_id = $1 and revoked_at is null returning 1',
      [userId]
    );
    return rows.length;
  });
}

export async function verifyPassword(
  deps: AuthDeps,
  session: SessionInfo,
  password: string,
  ip: string | null,
  userAgent: string | null = null
): Promise<boolean | 'rate_limited'> {
  const checked = await withHashSlot(deps, () =>
    verifyPasswordInTx(deps, session, password, { ip, userAgent })
  );
  return checked ?? 'rate_limited';
}

function verifyPasswordInTx(
  deps: AuthDeps,
  session: SessionInfo,
  password: string,
  meta: { ip: string | null; userAgent: string | null }
): Promise<boolean | 'rate_limited'> {
  const { ip } = meta;
  return inTx(deps, async (tx) => {
    if (await passwordLocked(tx, session.email, ip)) return 'rate_limited' as const;
    const { rows } = await tx.query('select encrypted_password from auth.users where id = $1', [
      session.userId,
    ]);
    const ok = await bcrypt.compare(
      password.slice(0, 1024),
      rows[0]?.encrypted_password || DUMMY_HASH
    );
    await recordAttempt(tx, session.email, ip, ok);
    if (!ok)
      await logEvent(tx, 'PASSWORD_CHECK_FAILED', sessionUser(session), session.sessionId, meta);
    return ok;
  });
}

export type ChangePasswordResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'invalid' | 'rate_limited' | 'same_password' };

export async function changePassword(
  deps: AuthDeps,
  session: SessionInfo,
  input: {
    currentPassword: string;
    newPassword: string;
    ip: string | null;
    userAgent?: string | null;
  }
): Promise<ChangePasswordResult> {
  requireStepUp(session);
  const problem = newPasswordProblem(input.newPassword);
  if (problem) {
    throw new AuthError(
      problem === 'too_short'
        ? `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
        : 'Password is too long',
      'weak_password',
      422
    );
  }
  const token = newToken();
  const changed = await withHashSlot(deps, () => changePasswordInTx(deps, session, input, token));
  return changed ?? { ok: false, reason: 'rate_limited' };
}

function changePasswordInTx(
  deps: AuthDeps,
  session: SessionInfo,
  input: {
    currentPassword: string;
    newPassword: string;
    ip: string | null;
    userAgent?: string | null;
  },
  token: string
): Promise<ChangePasswordResult> {
  const meta = { ip: input.ip, userAgent: input.userAgent };
  return inTx(deps, async (tx) => {
    const fail = async (reason: 'invalid' | 'rate_limited' | 'same_password') => {
      await logEvent(tx, 'PASSWORD_CHANGE_FAILED', sessionUser(session), session.sessionId, meta, {
        reason,
      });
      return { ok: false, reason } as const;
    };
    if (await passwordLocked(tx, session.email, input.ip)) return fail('rate_limited');
    const { rows } = await tx.query(
      'select encrypted_password from auth.users where id = $1 for update',
      [session.userId]
    );
    const valid = await bcrypt.compare(
      input.currentPassword.slice(0, 1024),
      rows[0]?.encrypted_password || DUMMY_HASH
    );
    await recordAttempt(tx, session.email, input.ip, valid);
    if (!valid) return fail('invalid');
    if (input.newPassword === input.currentPassword) return fail('same_password');
    await tx.query(
      'update auth.users set encrypted_password = $2, updated_at = now() where id = $1',
      [session.userId, await hashPassword(input.newPassword)]
    );
    const { rows: ended } = await tx.query(
      'update auth.sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null returning 1',
      [session.userId, session.sessionId]
    );
    // Reset links an admin made earlier stop working.
    await tx.query('select etna_platform.password_links_revoke($1)', [session.userId]);
    await logEvent(tx, 'PASSWORD_CHANGED', sessionUser(session), session.sessionId, meta, {
      other_sessions_ended: ended.length,
    });
    await tx.query('update auth.sessions set token_hash = $2, last_seen_at = now() where id = $1', [
      session.sessionId,
      hashToken(token),
    ]);
    return { ok: true, token } as const;
  });
}

// ─── Password links (made by an admin: reset, or invite for a new account) ───

/** SHA-256 (hex) of a link token: the only form the database ever sees. */
export const linkTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** A new random link token (256 bits, base64url). */
export const newLinkToken = () => randomBytes(32).toString('base64url');

const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface PasswordLinkInfo {
  email: string;
  purpose: 'reset' | 'invite';
}

export async function checkPasswordLink(
  deps: AuthDeps,
  token: string
): Promise<PasswordLinkInfo | null> {
  if (!LINK_TOKEN.test(token)) return null;
  return inTx(deps, async (tx) => {
    const { rows } = await tx.query('select etna_platform.password_link_check($1) as link', [
      linkTokenHash(token),
    ]);
    const link = rows[0]?.link as { email: string; purpose: 'reset' | 'invite' } | null;
    return link ? { email: link.email, purpose: link.purpose } : null;
  });
}

export type PasswordLinkResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'invalid' | 'rate_limited' };

// Sets the new password from a one-time link. Ends every session of the
// account and clears its failed sign-ins; two-factor stays as it was.
export async function completePasswordLink(
  deps: AuthDeps,
  input: { token: string; newPassword: string },
  meta: RequestMeta = {}
): Promise<PasswordLinkResult> {
  const problem = newPasswordProblem(input.newPassword);
  if (problem) {
    throw new AuthError(
      problem === 'too_short'
        ? `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
        : 'Password is too long',
      'weak_password',
      422
    );
  }
  const failed = () =>
    inTx(deps, (tx) =>
      logEvent(tx, 'PASSWORD_RESET_FAILED', { id: null, email: '' }, null, meta)
    ).then(() => ({ ok: false, reason: 'invalid' }) as const);
  if (!LINK_TOKEN.test(input.token)) return failed();

  const outcome = await withHashSlot(deps, async () => {
    const hash = await hashPassword(input.newPassword);
    return inTx(deps, async (tx) => {
      const { rows } = await tx.query('select etna_platform.password_link_use($1) as link', [
        linkTokenHash(input.token),
      ]);
      const link = rows[0]?.link as { user_id: string; email: string; purpose: string } | null;
      if (!link) return null;
      await tx.query(
        'update auth.users set encrypted_password = $2, updated_at = now() where id = $1',
        [link.user_id, hash]
      );
      const { rows: ended } = await tx.query(
        'update auth.sessions set revoked_at = now() where user_id = $1 and revoked_at is null returning 1',
        [link.user_id]
      );
      await tx.query(
        'delete from auth.login_attempts where lower(email) = lower($1) and not succeeded',
        [link.email]
      );
      await logEvent(
        tx,
        'PASSWORD_RESET_COMPLETED',
        { id: link.user_id, email: link.email },
        null,
        meta,
        { purpose: link.purpose, sessions_ended: ended.length }
      );
      return { email: link.email };
    });
  });
  if (outcome === undefined) return { ok: false, reason: 'rate_limited' };
  if (outcome === null) return failed();
  return { ok: true, email: outcome.email };
}

// ─── Terms & Conditions ──────────────────────────────────────────────────────

export interface TermsVersion {
  id: string;
  label: string;
  content: { en: string; id?: string; zh?: string };
  published_at: string;
}

export interface TermsStatus {
  /** A version is published and this account has not accepted it. */
  required: boolean;
  versionId: string | null;
  acceptedAt: string | null;
}

/** The current version, or null while none is published. */
export function currentTerms(deps: AuthDeps): Promise<TermsVersion | null> {
  return inTx(deps, async (tx) => {
    const { rows } = await tx.query('select etna_platform.terms_current() as terms');
    return (rows[0]?.terms as TermsVersion | null) ?? null;
  });
}

export function termsStatus(deps: AuthDeps, session: SessionInfo): Promise<TermsStatus> {
  return inTx(deps, async (tx) => {
    const { rows } = await tx.query('select etna_platform.terms_status($1) as status', [
      session.userId,
    ]);
    const status = rows[0]?.status ?? {};
    return {
      required: status.required === true,
      versionId: status.version_id ?? null,
      acceptedAt: status.accepted_at ?? null,
    };
  });
}

// Accepted after signing in, and after two-factor when the account has it.
// The version must be the current one: a version published while the page
// was open has to be read first (AuthError 'terms_changed').
export async function acceptTerms(
  deps: AuthDeps,
  session: SessionInfo,
  input: { versionId: string; locale: string; workspaceId: string | null },
  meta: RequestMeta = {}
): Promise<string> {
  requireStepUp(session);
  try {
    return await inTx(deps, async (tx) => {
      const { rows } = await tx.query(
        'select etna_platform.terms_accept($1, $2, $3, $4, $5, $6, $7) as accepted_at',
        [
          session.userId,
          input.versionId,
          input.locale,
          input.workspaceId,
          session.sessionId,
          meta.ip?.slice(0, 64) ?? null,
          meta.userAgent?.slice(0, 400) ?? null,
        ]
      );
      return new Date(rows[0].accepted_at).toISOString();
    });
  } catch (error) {
    if ((error as { hint?: string }).hint === 'stale')
      throw new AuthError('A newer version was published', 'terms_changed', 409);
    throw error;
  }
}

/** Declining is recorded; the caller then signs the session out. */
export function declineTerms(
  deps: AuthDeps,
  session: SessionInfo,
  versionId: string | null,
  meta: RequestMeta = {}
): Promise<void> {
  return inTx(deps, (tx) =>
    logEvent(tx, 'TERMS_DECLINED', sessionUser(session), session.sessionId, meta, {
      version_id: versionId,
    })
  );
}

// ─── Two-factor ──────────────────────────────────────────────────────────────

const FACTOR_COLUMNS = 'id, friendly_name, factor_type, status, created_at, updated_at';

function factorRow(row: Record<string, unknown>): FactorInfo {
  return {
    id: String(row.id),
    friendly_name: (row.friendly_name as string | null) ?? null,
    factor_type: 'totp',
    status: row.status as FactorInfo['status'],
    created_at: new Date(row.created_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  };
}

export async function listFactors(deps: AuthDeps, session: SessionInfo): Promise<FactorInfo[]> {
  return inTx(deps, async (tx) => {
    const { rows } = await tx.query(
      `select ${FACTOR_COLUMNS} from auth.mfa_factors where user_id = $1 order by created_at, id`,
      [session.userId]
    );
    return rows.map(factorRow);
  });
}

function requireStepUp(session: SessionInfo) {
  if (session.nextLevel === 'aal2' && session.aal !== 'aal2') {
    throw new AuthError('AAL2 required to change authenticators', 'insufficient_aal', 403);
  }
}

export async function enrollFactor(
  deps: AuthDeps,
  session: SessionInfo,
  friendlyName: string | null
): Promise<{ id: string; qr_code: string; secret: string; uri: string }> {
  requireStepUp(session);
  const name = friendlyName?.trim().slice(0, 60) || null;
  const secret = generateSecret();
  const uri = otpauthUri(secret, session.email);
  const id = await inTx(deps, async (tx) => {
    const { rows: count } = await tx.query(
      'select count(*)::int as n from auth.mfa_factors where user_id = $1',
      [session.userId]
    );
    if (count[0].n >= MAX_FACTORS)
      throw new AuthError(
        'Maximum number of enrolled factors reached',
        'too_many_enrolled_mfa_factors',
        422
      );
    try {
      const { rows } = await tx.query(
        `insert into auth.mfa_factors (user_id, friendly_name, status, secret_enc) values ($1, $2, 'unverified', $3) returning id`,
        [session.userId, name, sealSecret(secret, deps.mfaKey)]
      );
      return String(rows[0].id);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new AuthError(
          'A factor with the friendly name already exists',
          'mfa_factor_name_conflict',
          422
        );
      }
      throw error;
    }
  });
  const qr_code = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
  return { id, qr_code, secret, uri };
}

type CodeCheck =
  | { outcome: 'ok'; step: number; wasVerified: boolean }
  | { outcome: 'invalid' | 'rate_limited' };

// Checks a code from one of the account's authenticators, inside the caller's
// transaction: one check at a time per account, counted against the lockout
// before the code is looked at, and never the same time step twice.
async function checkCode(
  tx: SqlTx,
  deps: AuthDeps,
  session: SessionInfo,
  factorId: string,
  code: string,
  options: { verifiedOnly: boolean }
): Promise<CodeCheck> {
  await lockAccount(tx, 'mfa', session.userId);
  const { rows: recent } = await tx.query(
    `select count(*)::int as n from auth.mfa_attempts
      where user_id = $1 and not succeeded and attempted_at > now() - $2::interval`,
    [session.userId, MFA_FAILURE_WINDOW]
  );
  if (recent[0].n >= MFA_FAILURES) return { outcome: 'rate_limited' };

  const record = async (succeeded: boolean) => {
    await tx.query('insert into auth.mfa_attempts (user_id, succeeded) values ($1, $2)', [
      session.userId,
      succeeded,
    ]);
    if (Math.random() < 0.01)
      await tx.query(
        `delete from auth.mfa_attempts where attempted_at < now() - interval '30 days'`
      );
  };

  const { rows } = await tx.query(
    'select id, status, secret_enc, last_used_step from auth.mfa_factors where id = $1 and user_id = $2 for update',
    [factorId, session.userId]
  );
  const factor = rows[0];
  let secret: string | null = null;
  if (factor?.secret_enc && (!options.verifiedOnly || factor.status === 'verified')) {
    try {
      secret = openSecret(factor.secret_enc, deps.mfaKey);
    } catch {
      secret = null;
    }
  }
  const step =
    secret === null
      ? null
      : verifyTotp(secret, code, {
          lastUsedStep: factor.last_used_step === null ? null : Number(factor.last_used_step),
          nowMs: nowMs(deps),
        });
  if (step === null) {
    await record(false);
    return { outcome: 'invalid' };
  }
  await record(true);
  await tx.query(
    `update auth.mfa_factors set status = 'verified', last_used_step = $2, updated_at = now() where id = $1`,
    [factorId, step]
  );
  return { outcome: 'ok', step, wasVerified: factor.status === 'verified' };
}

function throwCodeFailure(outcome: 'invalid' | 'rate_limited'): never {
  if (outcome === 'rate_limited') {
    throw new AuthError(
      'Too many incorrect codes. Please wait 15 minutes and try again.',
      'over_request_rate_limit',
      429
    );
  }
  throw new AuthError('Invalid TOTP code entered', 'mfa_verification_failed', 422);
}

export async function verifyFactor(
  deps: AuthDeps,
  session: SessionInfo,
  factorId: string,
  code: string,
  meta: RequestMeta = {}
): Promise<{ token: string }> {
  const token = newToken();
  const outcome = await inTx(deps, async (tx) => {
    const checked = await checkCode(tx, deps, session, factorId, code, { verifiedOnly: false });
    const user = sessionUser(session);
    if (checked.outcome !== 'ok') {
      await logEvent(
        tx,
        checked.outcome === 'rate_limited' ? 'MFA_RATE_LIMITED' : 'MFA_CHALLENGE_FAILED',
        user,
        session.sessionId,
        meta
      );
      return checked.outcome;
    }
    await tx.query(
      `update auth.sessions set aal = 'aal2', token_hash = $2, last_seen_at = now() where id = $1`,
      [session.sessionId, hashToken(token)]
    );
    // The first code from a new device completes its enrollment.
    await logEvent(
      tx,
      checked.wasVerified ? 'MFA_CHALLENGE_SUCCEEDED' : 'MFA_FACTOR_ADDED',
      user,
      session.sessionId,
      meta,
      { factor_id: factorId }
    );
    return 'ok' as const;
  });
  if (outcome !== 'ok') throwCodeFailure(outcome);
  return { token };
}

// Admin panel: re-enter a code from an already verified authenticator. Marks
// this session as re-authenticated; sensitive admin actions accept that for
// ADMIN_REAUTH_MINUTES (checked again by the database).
export const ADMIN_REAUTH_MINUTES = 10;

export async function reauthenticate(
  deps: AuthDeps,
  session: SessionInfo,
  factorId: string,
  code: string,
  meta: RequestMeta = {}
): Promise<void> {
  if (session.aal !== 'aal2')
    throw new AuthError('AAL2 required to re-authenticate', 'insufficient_aal', 403);
  const outcome = await inTx(deps, async (tx) => {
    const checked = await checkCode(tx, deps, session, factorId, code, { verifiedOnly: true });
    const user = sessionUser(session);
    if (checked.outcome !== 'ok') {
      await logEvent(
        tx,
        checked.outcome === 'rate_limited' ? 'MFA_RATE_LIMITED' : 'ADMIN_REAUTH_FAILED',
        user,
        session.sessionId,
        meta
      );
      return checked.outcome;
    }
    await tx.query(
      'update auth.sessions set reauthenticated_at = now(), last_seen_at = now() where id = $1',
      [session.sessionId]
    );
    await logEvent(tx, 'ADMIN_REAUTHENTICATED', user, session.sessionId, meta, {
      factor_id: factorId,
    });
    return 'ok' as const;
  });
  if (outcome !== 'ok') throwCodeFailure(outcome);
}

export async function unenrollFactor(
  deps: AuthDeps,
  session: SessionInfo,
  factorId: string,
  meta: RequestMeta = {}
): Promise<void> {
  await inTx(deps, async (tx) => {
    const { rows } = await tx.query(
      'select status from auth.mfa_factors where id = $1 and user_id = $2',
      [factorId, session.userId]
    );
    if (!rows[0]) throw new AuthError('Factor not found', 'mfa_factor_not_found', 404);
    // Removing a half-finished enrollment is always allowed; a verified device needs aal2.
    if (rows[0].status === 'verified') requireStepUp(session);
    await tx.query('delete from auth.mfa_factors where id = $1 and user_id = $2', [
      factorId,
      session.userId,
    ]);
    if (rows[0].status === 'verified')
      await logEvent(tx, 'MFA_FACTOR_REMOVED', sessionUser(session), session.sessionId, meta, {
        factor_id: factorId,
      });
  });
}
