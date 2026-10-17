// Outgoing HTTP for Terminal connectors. Every request:
//
//  * goes only to public addresses, unless ETNA allows the host or network
//    (etna_platform.settings.connector_private_hosts, e.g. an SAP B1 server in
//    the company's own network, or for one company only a host:port its
//    tunnel arrives at, 20261012000046); loopback, link-local (cloud
//    metadata) and unspecified addresses are always refused;
//  * connects to the address that was checked (the name is not resolved
//    again, so DNS cannot be switched between the check and the request);
//  * uses HTTPS (plain HTTP only to allowed internal hosts), optionally with a
//    pinned certificate (SHA-256 fingerprint) for self-signed servers and a
//    client certificate (mutual TLS);
//  * sends the caller's headers to the first origin only: a redirect to
//    another origin goes without them (no API key or token leaks there);
//  * is limited: 30 s, 50 MB answers, 5 requests a second per connection,
//    three retries on 429/502/503/504 and network errors, at most 3 redirects
//    (each checked again).

import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { PeerCertificate } from 'node:tls';
import { TerminalError } from '@/server/terminal/session';

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  url: string;
  text(): string;
  json<T = any>(): T;
}

export interface GuardOptions {
  /** Hosts and networks ETNA allows although they are internal (names, IPs, CIDR). */
  privateHosts?: string[];
  /** SHA-256 certificate fingerprint to accept instead of a public CA (AA:BB:…). */
  fingerprint256?: string | null;
  /** Requests per second (default 5). */
  rate?: number;
  /** Mutual TLS: the client certificate and its private key (PEM). */
  clientCert?: string | null;
  clientKey?: string | null;
  /**
   * Loopback addresses allowed as host:port ("localhost:11434"): a local AI
   * server on ETNA's own machine, listed by a super admin (20261012000049).
   */
  localEndpoints?: string[];
  /** Headers added only to requests to this origin (a tunnel's access token). */
  originHeaders?: { origin: string; headers: Record<string, string> } | null;
}

const ALWAYS_BLOCKED = new net.BlockList();
for (const [net4, bits] of [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  ALWAYS_BLOCKED.addSubnet(net4, bits, 'ipv4');
for (const [net6, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fe80::', 10],
  ['fec0::', 10], // site-local (deprecated, internal)
  ['ff00::', 8],
  ['100::', 64], // discard
  ['2001::', 32], // Teredo: tunnels to an IPv4 address
  ['2002::', 16], // 6to4: tunnels to an IPv4 address
  ['64:ff9b:1::', 48], // local-use NAT64
] as const)
  ALWAYS_BLOCKED.addSubnet(net6, bits, 'ipv6');

const PRIVATE = new net.BlockList();
for (const [net4, bits] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['198.18.0.0', 15],
] as const)
  PRIVATE.addSubnet(net4, bits, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

const family = (ip: string) => (net.isIPv6(ip) ? 'ipv6' : 'ipv4');

/** The eight 16-bit groups of an IPv6 address (null when it is not one). */
function ipv6Groups(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let text = ip.replace(/%.*$/, '');
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const part = (s: string | undefined) => (s ? s.split(':').map((g) => parseInt(g, 16)) : []);
  const left = part(head);
  const right = part(tail);
  return tail === undefined
    ? left
    : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}

/**
 * IPv6 addresses that carry an IPv4 address are checked as that IPv4 address:
 * IPv4-mapped (::ffff:10.0.0.1), IPv4-compatible (::10.0.0.1) and NAT64
 * (64:ff9b::10.0.0.1), so none of them reaches an internal IPv4 host.
 */
function plain(ip: string): string {
  const g = ipv6Groups(ip);
  if (!g) return ip;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const embedded =
    (zeros(0, 5) && (g[5] === 0xffff || (g[5] === 0 && (g[6] !== 0 || g[7] > 1)))) ||
    (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6));
  if (!embedded) return ip;
  return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
}

/**
 * An allowed entry: a name, an address, a network (CIDR), or any of the first
 * two with a port ("erp.local:443", "10.0.0.5:5432", "[fd00::5]:443"), which
 * then allows that port only.
 */
export function parseAllowEntry(
  entry: string
): { host: string; bits: number | null; port: number | null } | null {
  const m = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/i.exec(entry) ?? /^([^:/\s]+):(\d{1,5})$/.exec(entry);
  if (m) {
    const port = Number(m[2]);
    return port >= 1 && port <= 65535 ? { host: m[1].toLowerCase(), bits: null, port } : null;
  }
  const [addr, bits] = entry.split('/');
  if (bits !== undefined) {
    const n = Number(bits);
    const max = net.isIPv6(addr) ? 128 : 32;
    return net.isIP(addr) && Number.isInteger(n) && n >= 0 && n <= max
      ? { host: addr.toLowerCase(), bits: n, port: null }
      : null;
  }
  return entry && !/\s/.test(entry) ? { host: entry.toLowerCase(), bits: null, port: null } : null;
}

function allowedList(privateHosts: string[]) {
  const entries = privateHosts.map(parseAllowEntry).filter((e) => e !== null);
  return (host: string, ip: string, port: number | null) =>
    entries.some((e) => {
      if (e.port !== null && e.port !== port) return false;
      if (!net.isIP(e.host)) return e.host === host;
      const list = new net.BlockList();
      if (e.bits !== null) list.addSubnet(e.host, e.bits, family(e.host));
      else list.addAddress(plain(e.host), family(plain(e.host)));
      return list.check(ip, family(ip));
    });
}

const defaultPort = (url: URL) =>
  url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

export interface Target {
  address: string;
  family: 4 | 6;
  /** An internal address ETNA allows (plain HTTP and TLS-less databases only there). */
  internal: boolean;
}

/** The address to connect to, or why not. */
export async function checkTarget(
  url: URL,
  privateHosts: string[] = [],
  localEndpoints: string[] = []
): Promise<Target> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TerminalError('urlScheme');
  if (url.username || url.password) throw new TerminalError('urlCredentials');
  const target = await checkHost(url.hostname, privateHosts, defaultPort(url), localEndpoints);
  if (url.protocol === 'http:' && !target.internal) throw new TerminalError('httpsRequired');
  return target;
}

/** A host name or address (any protocol): the address to connect to, or why not. */
export async function checkHost(
  hostname: string,
  privateHosts: string[] = [],
  port: number | null = null,
  localEndpoints: string[] = []
): Promise<Target> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allowed = allowedList(privateHosts);
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIPv6(host) ? 6 : 4 }]
    : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new TerminalError('hostUnknown');
  let internal = false;
  for (const a of addresses) {
    const ip = plain(a.address);
    if (ALWAYS_BLOCKED.check(ip, family(ip))) {
      // Only loopback, and only at a host:port ETNA lists for local AI servers.
      const loopback = ip === '::1' || /^127\./.test(ip);
      const name = net.isIPv6(host) ? `[${host}]` : host;
      if (loopback && port !== null && localEndpoints.includes(`${name}:${port}`)) {
        internal = true;
        continue;
      }
      throw new TerminalError('hostBlocked');
    }
    if (PRIVATE.check(ip, family(ip))) {
      if (!allowed(host, ip, port)) throw new TerminalError('hostPrivate');
      internal = true;
    }
  }
  const first = addresses[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4, internal };
}

class RateLimit {
  private next = 0;
  private readonly perSecond: number;
  constructor(perSecond: number) {
    this.perSecond = perSecond;
  }
  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + 1000 / this.perSecond;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = new Set([429, 502, 503, 504]);

/** An HTTP client for one connection, with the guard above. */
export class GuardedHttp {
  private readonly limit: RateLimit;
  private readonly guard: GuardOptions;
  constructor(guard: GuardOptions = {}) {
    this.guard = guard;
    this.limit = new RateLimit(guard.rate ?? 5);
  }

  async request(rawUrl: string, options: HttpOptions = {}): Promise<HttpResponse> {
    let url = new URL(rawUrl);
    const origin = url.origin;
    let method = options.method ?? 'GET';
    let body = options.body;
    for (let redirects = 0; ; redirects += 1) {
      const res = await this.withRetries(url, {
        ...options,
        method,
        body,
        // Headers (keys, tokens, signatures) only for the origin they were made for.
        headers: url.origin === origin ? options.headers : undefined,
      });
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        if (redirects >= 3) throw new TerminalError('tooManyRedirects');
        url = new URL(String(res.headers.location), url);
        if (
          res.status === 303 ||
          ((res.status === 301 || res.status === 302) && method === 'POST')
        ) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      return res;
    }
  }

  private async withRetries(url: URL, options: HttpOptions): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt += 1) {
      await this.limit.wait();
      try {
        const res = await this.once(url, options);
        if (!RETRY_STATUS.has(res.status) || attempt >= 3) return res;
        const after = Number(res.headers['retry-after']);
        await sleep(
          Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt
        );
      } catch (error) {
        if (error instanceof TerminalError || attempt >= 3) throw error;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  private async once(url: URL, options: HttpOptions): Promise<HttpResponse> {
    const target = await checkTarget(
      url,
      this.guard.privateHosts ?? [],
      this.guard.localEndpoints ?? []
    );
    const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
    const pin = this.guard.fingerprint256?.toUpperCase() ?? null;
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise<HttpResponse>((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method: options.method ?? 'GET',
          headers: {
            'User-Agent': 'PrintStream-Terminal/1',
            Accept: 'application/json',
            ...options.headers,
            ...(this.guard.originHeaders?.origin === url.origin
              ? this.guard.originHeaders.headers
              : {}),
          },
          timeout: options.timeoutMs ?? 30_000,
          // Connect to the checked address only.
          lookup: (
            _host: string,
            _opts: unknown,
            cb: (err: Error | null, address: string, family: number) => void
          ) => cb(null, target.address, target.family),
          ...(url.protocol === 'https:'
            ? {
                servername: net.isIP(url.hostname) ? undefined : url.hostname,
                ...(this.guard.clientCert && this.guard.clientKey
                  ? { cert: this.guard.clientCert, key: this.guard.clientKey }
                  : {}),
                // A pinned certificate replaces the CA check; it is compared
                // below, before anything is sent.
                ...(pin ? { rejectUnauthorized: false } : {}),
              }
            : {}),
        } as https.RequestOptions,
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy();
              reject(new TerminalError('responseTooLarge'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body,
              url: url.toString(),
              text: () => body.toString('utf8'),
              json: () => {
                try {
                  return JSON.parse(body.toString('utf8'));
                } catch {
                  throw new TerminalError('badResponse');
                }
              },
            });
          });
          res.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new TerminalError('timeout')));
      req.on('error', (e) =>
        reject(e instanceof TerminalError ? e : Object.assign(new Error('network'), { cause: e }))
      );
      const send = () => {
        if (options.body) req.write(options.body);
        req.end();
      };
      if (pin && url.protocol === 'https:') {
        // Nothing (not even the headers) goes out before the certificate matches.
        req.once('socket', (socket) =>
          socket.once('secureConnect', () => {
            const cert = (
              socket as import('node:tls').TLSSocket
            ).getPeerCertificate() as PeerCertificate;
            if (cert?.fingerprint256?.toUpperCase() === pin) send();
            else req.destroy(new TerminalError('certificateMismatch'));
          })
        );
      } else send();
    });
  }
}
