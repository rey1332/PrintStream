import type { AuthDeps } from './auth/service';
import { parseKey } from './auth/secret-box';
import { poolExecutor, type Executor } from './db/executor';

export class ConfigError extends Error {}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(`${name} is not set`);
  return value;
}

// One pool per server process (kept across hot reloads in development).
const cache = globalThis as typeof globalThis & {
  __etnaExecutors?: { app?: Executor; auth?: Executor };
};
cache.__etnaExecutors ??= {};

export function getAppExecutor(): Executor {
  cache.__etnaExecutors!.app ??= poolExecutor(required('DATABASE_URL'), {
    max: 10,
    application_name: 'etna-app',
  });
  return cache.__etnaExecutors!.app;
}

export function getAuthDeps(): AuthDeps {
  cache.__etnaExecutors!.auth ??= poolExecutor(required('AUTH_DATABASE_URL'), {
    max: 5,
    application_name: 'etna-auth',
  });
  return {
    executor: cache.__etnaExecutors!.auth,
    mfaKey: parseKey(process.env.MFA_ENCRYPTION_KEY),
  };
}

export function hintSecret(): string {
  const secret = required('SESSION_HINT_SECRET');
  if (secret.length < 32)
    throw new ConfigError('SESSION_HINT_SECRET must be at least 32 characters');
  return secret;
}
