import { browserAuth } from '@/lib/auth/browser-auth';
import { RestClient } from './rest-client';
import type { RequestSpec, RestResult } from './spec';

async function postSpec(spec: RequestSpec): Promise<RestResult> {
  const response = await fetch('/api/data', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => null)) as RestResult | null;
  if (body && typeof body === 'object' && 'data' in body) return body;
  return {
    data: null,
    error: { message: `Request failed (${response.status})`, code: '', details: null, hint: null },
    count: null,
    status: response.status,
  };
}

export const POLL_INTERVAL_MS = 30_000;

type ChangeHandler = () => void;

class PollingChannel {
  private handlers: ChangeHandler[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') this.fire();
  };

  on(event: string, _filter: unknown, handler: ChangeHandler) {
    if (event === 'postgres_changes') this.handlers.push(handler);
    return this;
  }

  private fire() {
    for (const handler of this.handlers) handler();
  }

  subscribe(callback?: (status: 'SUBSCRIBED' | 'CLOSED') => void) {
    if (typeof window !== 'undefined' && !this.timer) {
      this.timer = setInterval(() => {
        if (document.visibilityState === 'visible') this.fire();
      }, POLL_INTERVAL_MS);
      document.addEventListener('visibilitychange', this.onVisible);
    }
    callback?.('SUBSCRIBED');
    return this;
  }

  unsubscribe() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', this.onVisible);
    return Promise.resolve('ok' as const);
  }
}

export function createBrowserDataClient() {
  const rest = new RestClient(postSpec);
  return {
    from: (table: string) => rest.from(table),
    rpc: (
      fn: string,
      args?: Record<string, unknown>,
      options?: { count?: 'exact'; head?: boolean }
    ) => rest.rpc(fn, args, options),
    auth: browserAuth(),
    channel: (_name: string) => new PollingChannel(),
    removeChannel: (channel: PollingChannel) => channel.unsubscribe(),
  };
}
