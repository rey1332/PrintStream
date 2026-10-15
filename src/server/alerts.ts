// Error alerts by e-mail (docs/OPERATIONS.md, "Error alerts").
//
// The server already logs every failure as one redacted line: a tag and a
// code, e.g. `[db] 57P01` or `[auth] login ECONNREFUSED`. installConsoleAlerts()
// copies those lines (console.error) into an AlertQueue, which e-mails a
// digest to ETNA_ALERT_EMAILS (else ETNA_ADMIN_EMAILS) through ETNA's SMTP
// settings:
//
//   * the first e-mail a minute after the first error (a burst is one e-mail),
//     then at most one every 15 minutes, listing each kind with a count;
//   * only the tag and codes travel, never messages or values (a database
//     message can quote data), at most 160 characters per kind;
//   * failures to send mail are not alerted again (no loop).
//
// Each process (app, worker) has its own queue. Off when no recipient or no
// SMTP_HOST is set, and in development.

export interface AlertMail {
  to: string;
  subject: string;
  text: string;
}

export interface AlertOptions {
  recipients: string[];
  send: (mail: AlertMail) => Promise<unknown>;
  /** Where these errors come from, e.g. "app on erp-01". */
  source: string;
  /** Wait after the first error, so a burst becomes one e-mail. */
  delayMs?: number;
  /** At most one e-mail per this long. */
  intervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

interface Pending {
  count: number;
  first: number;
  last: number;
  samples: Set<string>;
}

const MAX_KINDS = 30;
const MAX_SAMPLES = 3;

export class AlertQueue {
  private readonly options: Required<Omit<AlertOptions, 'recipients' | 'send' | 'source'>> &
    Pick<AlertOptions, 'recipients' | 'send' | 'source'>;
  private pending = new Map<string, Pending>();
  private dropped = 0;
  private timer: unknown = null;
  private lastSent = -Infinity;

  constructor(options: AlertOptions) {
    this.options = {
      delayMs: 60_000,
      intervalMs: 15 * 60_000,
      now: Date.now,
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return t;
      },
      ...options,
    };
  }

  get enabled(): boolean {
    return this.options.recipients.length > 0;
  }

  /** One error of `kind` (a log tag such as "db"), with a short redacted detail. */
  report(kind: string, detail = ''): void {
    if (!this.enabled) return;
    const now = this.options.now();
    const key = kind.slice(0, 40) || 'error';
    let entry = this.pending.get(key);
    if (!entry) {
      if (this.pending.size >= MAX_KINDS) {
        this.dropped += 1;
        this.schedule(now);
        return;
      }
      entry = { count: 0, first: now, last: now, samples: new Set() };
      this.pending.set(key, entry);
    }
    entry.count += 1;
    entry.last = now;
    const sample = detail.slice(0, 160);
    if (sample && entry.samples.size < MAX_SAMPLES) entry.samples.add(sample);
    this.schedule(now);
  }

  private schedule(now: number): void {
    if (this.timer !== null) return;
    const at = Math.max(now + this.options.delayMs, this.lastSent + this.options.intervalMs);
    this.timer = this.options.setTimer(() => void this.flush(), at - now);
  }

  /** Sends what has been collected (normally called by the timer). */
  async flush(): Promise<void> {
    this.timer = null;
    if (this.pending.size === 0 && this.dropped === 0) return;
    const now = this.options.now();
    if (now < this.lastSent + this.options.intervalMs) {
      this.schedule(now);
      return;
    }
    const entries = [...this.pending.entries()];
    const dropped = this.dropped;
    this.pending = new Map();
    this.dropped = 0;
    this.lastSent = now;

    const total = entries.reduce((n, [, e]) => n + e.count, 0) + dropped;
    const time = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const lines = entries.map(([kind, e]) => {
      const head = `[${kind}] ${e.count} time${e.count === 1 ? '' : 's'}, ${time(e.first)} to ${time(e.last)}`;
      return [head, ...[...e.samples].map((s) => `    ${s}`)].join('\n');
    });
    if (dropped) lines.push(`(and ${dropped} more of other kinds)`);
    const text = [
      `ETNA (${this.options.source}) logged ${total} error${total === 1 ? '' : 's'}:`,
      '',
      ...lines,
      '',
      'The server log has the full lines (Linux: journalctl -u etna -u etna-worker;',
      'Windows: <ETNA_DATA_ROOT>\\logs\\server-<date>.log). The next report comes',
      `at the earliest in ${Math.round(this.options.intervalMs / 60_000)} minutes.`,
    ].join('\n');
    const subject = `ETNA: ${total} error${total === 1 ? '' : 's'} on ${this.options.source}`;
    for (const to of this.options.recipients) {
      try {
        await this.options.send({ to, subject, text });
      } catch {
        // Sending failed: the mailer logs why (and that line is not alerted).
      }
    }
  }
}

// "[tag] …", also after a "[2026-10-15T10:00:00.000Z] " timestamp (the worker's lines).
const TAG = /^(?:\[\d{4}-\d\d-\d\dT[^\]]{1,30}\]\s*)?\[([^\]\s][^\]]{0,39})\]/;
// Tags that are never alerted: the mailer's own failures (no loop).
const QUIET = new Set(['mail']);

/** The tag and a redacted detail of a console.error call: strings and numbers as written, objects only by their code. */
export function describeLog(args: unknown[]): { kind: string; detail: string } | null {
  const [first, ...rest] = args;
  const head = typeof first === 'string' ? first : '';
  const tag = TAG.exec(head);
  const kind = tag ? tag[1].trim() : 'error';
  if (QUIET.has(kind)) return null;
  const parts: string[] = [];
  const restOfHead = tag ? head.slice(tag[0].length).trim() : head;
  if (restOfHead) parts.push(restOfHead);
  for (const value of rest) {
    if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
    else if (value && typeof value === 'object') {
      const code = (value as { code?: unknown }).code;
      if (typeof code === 'string' || typeof code === 'number') parts.push(String(code));
    }
  }
  return { kind, detail: parts.join(' ').replace(/\s+/g, ' ').slice(0, 160) };
}

const installed = Symbol.for('etna.consoleAlerts');

/** Copies console.error lines into the queue (once per process). */
export function installConsoleAlerts(queue: AlertQueue): void {
  const g = globalThis as Record<symbol, unknown>;
  if (!queue.enabled || g[installed]) return;
  g[installed] = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    try {
      const line = describeLog(args);
      if (line) queue.report(line.kind, line.detail);
    } catch {
      // An alert must never break logging.
    }
  };
}

/** Alert recipients from the environment: ETNA_ALERT_EMAILS, else ETNA_ADMIN_EMAILS. */
export function alertRecipients(env: Record<string, string | undefined> = process.env): string[] {
  const list = env.ETNA_ALERT_EMAILS?.trim()
    ? env.ETNA_ALERT_EMAILS
    : (env.ETNA_ADMIN_EMAILS ?? '');
  return list
    .split(',')
    .map((e) => e.trim())
    .filter((e) => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(e));
}
