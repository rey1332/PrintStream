type AuthEvent =
  | 'INITIAL_SESSION'
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'MFA_CHALLENGE_VERIFIED';

export interface BrowserUser {
  id: string;
  email: string;
  email_confirmed_at: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  user_metadata: Record<string, unknown>;
}

export interface BrowserFactor {
  id: string;
  friendly_name: string | null;
  factor_type: 'totp';
  status: 'unverified' | 'verified';
  created_at: string;
  updated_at: string;
}

export interface BrowserSession {
  expires_at: number;
  user: BrowserUser;
}

interface AuthErrorShape {
  name: 'AuthApiError';
  message: string;
  status: number;
  code: string;
}

interface SessionPayload {
  user: BrowserUser | null;
  session: BrowserSession | null;
  aal: { currentLevel: 'aal1' | 'aal2' | null; nextLevel: 'aal1' | 'aal2' | null };
}

type Listener = (event: AuthEvent, session: BrowserSession | null) => void;

async function call<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<{ data: T | null; error: AuthErrorShape | null }> {
  try {
    const response = await fetch(`/api/auth/${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const e = payload?.error ?? {};
      return {
        data: null,
        error: {
          name: 'AuthApiError',
          message: e.message || 'Request failed',
          status: response.status,
          code: e.code || 'unexpected_failure',
        },
      };
    }
    return { data: payload as T, error: null };
  } catch {
    return {
      data: null,
      error: { name: 'AuthApiError', message: 'Network error', status: 0, code: 'network_error' },
    };
  }
}

class BrowserAuth {
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;

  constructor() {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      // Keep other tabs in step with sign-in / sign-out.
      this.channel = new BroadcastChannel('etna-auth');
      this.channel.onmessage = async (message) => {
        const event = message.data as AuthEvent;
        const { data } = await this.getSession();
        this.emit(event, data.session, false);
      };
    }
  }

  private emit(event: AuthEvent, session: BrowserSession | null, broadcast = true) {
    this.sessionAnswer = null;
    for (const listener of this.listeners) listener(event, session);
    if (broadcast && (event === 'SIGNED_IN' || event === 'SIGNED_OUT'))
      this.channel?.postMessage(event);
  }

  // Several parts of a page ask at the same moment: one request answers them all.
  private sessionInFlight: Promise<{
    data: SessionPayload | null;
    error: AuthErrorShape | null;
  }> | null = null;
  // The answer is reused for a moment (pages ask right after one another);
  // signing in or out forgets it (emit).
  private sessionAnswer: {
    at: number;
    value: Awaited<ReturnType<BrowserAuth['currentSession']>>;
  } | null = null;
  private currentSession(): Promise<{ data: SessionPayload | null; error: AuthErrorShape | null }> {
    const answer = this.sessionAnswer;
    if (answer && Date.now() - answer.at < 2_000) return Promise.resolve(answer.value);
    this.sessionInFlight ??= call<SessionPayload>('session', 'GET')
      .then((value) => {
        if (!value.error) this.sessionAnswer = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.sessionInFlight = null;
      });
    return this.sessionInFlight;
  }

  /** The whole session answer (shared computer, server admin…), from the same request. */
  async sessionPayload(): Promise<Record<string, unknown> | null> {
    const { data } = await this.currentSession();
    return (data as Record<string, unknown> | null) ?? null;
  }

  async getSession(): Promise<{
    data: { session: BrowserSession | null };
    error: AuthErrorShape | null;
  }> {
    const { data, error } = await this.currentSession();
    return { data: { session: data?.session ?? null }, error };
  }

  async getUser(): Promise<{ data: { user: BrowserUser | null }; error: AuthErrorShape | null }> {
    const { data, error } = await this.currentSession();
    if (error) return { data: { user: null }, error };
    if (!data?.user)
      return {
        data: { user: null },
        error: {
          name: 'AuthApiError',
          message: 'Auth session missing!',
          status: 401,
          code: 'session_missing',
        },
      };
    return { data: { user: data.user }, error: null };
  }

  onAuthStateChange(listener: Listener) {
    this.listeners.add(listener);
    void this.getSession().then(({ data }) => {
      if (this.listeners.has(listener)) listener('INITIAL_SESSION', data.session);
    });
    return {
      data: {
        subscription: {
          unsubscribe: () => {
            this.listeners.delete(listener);
          },
        },
      },
    };
  }

  /** `shared`: "This is a shared computer" (signed out after a short idle time). */
  async signInWithPassword(credentials: { email: string; password: string; shared?: boolean }) {
    const { data, error } = await call<SessionPayload>('login', 'POST', credentials);
    if (error || !data) return { data: { user: null, session: null }, error };
    this.emit('SIGNED_IN', data.session);
    return { data: { user: data.user, session: data.session }, error: null };
  }

  async signOut() {
    const { error } = await call('logout', 'POST', {});
    this.emit('SIGNED_OUT', null);
    return { error };
  }

  async refreshSession() {
    const { data, error } = await call<SessionPayload>('refresh', 'POST', {});
    if (data?.session) this.emit('TOKEN_REFRESHED', data.session);
    return { data: { user: data?.user ?? null, session: data?.session ?? null }, error };
  }

  async verifyPassword(password: string) {
    return call<{ ok: true }>('verify-password', 'POST', { password });
  }

  async changePassword(params: { currentPassword: string; newPassword: string }) {
    const { data, error } = await call<SessionPayload>('change-password', 'POST', params);
    if (!error && data?.session) this.emit('TOKEN_REFRESHED', data.session);
    return { error };
  }

  async exchangeCodeForSession(_code: string) {
    return {
      data: { session: null, user: null },
      error: {
        name: 'AuthApiError' as const,
        message: 'Email links are not used',
        status: 400,
        code: 'not_supported',
      },
    };
  }

  readonly mfa = {
    listFactors: async () => {
      const { data, error } = await call<{ all: BrowserFactor[]; totp: BrowserFactor[] }>(
        'factors',
        'GET'
      );
      return { data: data ?? { all: [], totp: [] }, error };
    },
    enroll: async (params: { factorType: 'totp'; friendlyName?: string }) =>
      call<{
        id: string;
        type: 'totp';
        friendly_name: string | null;
        totp: { qr_code: string; secret: string; uri: string };
      }>('enroll', 'POST', { friendlyName: params.friendlyName ?? null }),
    challengeAndVerify: async (params: { factorId: string; code: string }) => {
      const { data, error } = await call<SessionPayload>('verify', 'POST', params);
      if (!error && data?.session) this.emit('MFA_CHALLENGE_VERIFIED', data.session);
      return { data, error };
    },
    unenroll: async (params: { factorId: string }) =>
      call<{ id: string }>('unenroll', 'POST', params),
    getAuthenticatorAssuranceLevel: async () => {
      const { data, error } = await call<SessionPayload>('session', 'GET');
      return {
        data: data
          ? {
              currentLevel: data.aal.currentLevel,
              nextLevel: data.aal.nextLevel,
              currentAuthenticationMethods: [],
            }
          : null,
        error,
      };
    },
  };
}

let instance: BrowserAuth | null = null;

export function browserAuth(): BrowserAuth {
  instance ??= new BrowserAuth();
  return instance;
}
