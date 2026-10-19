import { browserAuth } from '@/lib/auth/browser-auth';
import { RestClient } from './rest-client';
import type { RequestSpec, RestResult } from './spec';

// Requests a page starts in the same moment (a dashboard's ten widgets) go
// to the server together, as one { batch } request: one round trip and one
// session check instead of ten. Large bodies (uploads, imports) go alone.
const BATCH_MAX = 25;
const BATCH_BODY_LIMIT = 64_000;
let queue: { spec: RequestSpec; resolve: (r: RestResult) => void }[] = [];
let scheduled = false;

function postSpec(spec: RequestSpec): Promise<RestResult> {
  if (JSON.stringify(spec).length > BATCH_BODY_LIMIT) return postOne(spec);
  return new Promise((resolve) => {
    queue.push({ spec, resolve });
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 0);
    }
  });
}

function flush() {
  scheduled = false;
  const items = queue;
  queue = [];
  for (let i = 0; i < items.length; i += BATCH_MAX) {
    const chunk = items.slice(i, i + BATCH_MAX);
    if (chunk.length === 1) postOne(chunk[0].spec).then(chunk[0].resolve);
    else postBatch(chunk);
  }
}

const failed = (status: number): RestResult => ({
  data: null,
  error: { message: `Request failed (${status})`, code: '', details: null, hint: null },
  count: null,
  status,
});

async function postBatch(items: { spec: RequestSpec; resolve: (r: RestResult) => void }[]) {
  try {
    const response = await fetch('/api/data', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch: items.map((i) => i.spec) }),
      cache: 'no-store',
    });
    const body = (await response.json().catch(() => null)) as
      | { batch?: RestResult[] }
      | RestResult
      | null;
    if (
      body &&
      'batch' in body &&
      Array.isArray(body.batch) &&
      body.batch.length === items.length
    ) {
      items.forEach((item, k) => item.resolve((body.batch as RestResult[])[k]));
      return;
    }
    // A refusal for the whole batch (signed out, too many requests) answers each one.
    const whole =
      body && typeof body === 'object' && 'data' in body
        ? (body as RestResult)
        : failed(response.status);
    for (const item of items) item.resolve(whole);
  } catch {
    for (const item of items) item.resolve(failed(0));
  }
}

async function postOne(spec: RequestSpec): Promise<RestResult> {
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
