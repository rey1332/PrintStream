// A generic REST API as a Terminal connection (20261012000046). The
// connection holds the base address and the sign-in; each sync reads one
// endpoint (src/lib/terminal/restSource.ts): GET, or POST with a JSON body
// ("POST as query"), page by page in one of the pagination styles, and its
// records become dataset rows (nested objects spread into "a.b" columns).
//
// Sign-in, all through the network guard (src/server/connectors/http.ts):
//  * static secrets: an API key (header or query), a bearer token, Basic, and
//    extra headers (plain or secret);
//  * OAuth2 client credentials: tokens fetched and renewed here;
//  * OAuth2 authorisation code: consent in the provider's page
//    (/api/terminal/connectors/oauth, PKCE), tokens renewed here and revoked
//    on request;
//  * signed requests: an HMAC over a template of the request, or a provider's
//    own rules (Mekari); and a client certificate (mutual TLS) with any of them.
//
// Limits: those of the guard (30 s a request, 3 retries, 5 requests a second,
// 50 MB an answer), at most 10,000 pages and 2 hours a run. A next page's
// address must stay on the connection's origin, and a cursor, address or page
// seen before stops the run (an API that ignores its paging parameters would
// otherwise be read forever).

import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  columnsFromSample,
  flattenRecord,
  getPath,
  linkNext,
  openApiOperations,
  parseHeaderLines,
  saysNoMore,
  setPath,
  type RestColumn,
  type RestOperation,
  type RestSource,
} from '@/lib/terminal/restSource';
import { TerminalError } from '@/server/terminal/session';
import type { HttpResponse } from './http';
import { mekariHeaders } from './jurnal';
import { MAX_PAGES, failure, type Adapter, type ConnectorContext, type Row } from './types';

/** Longest run: two hours. */
export const REST_RUN_MS = 2 * 3600_000;
const OPENAPI_BYTES = 10 * 1024 * 1024;

/** The connection's base address (without a trailing slash). */
export function baseUrl(ctx: ConnectorContext): URL {
  const raw = String(ctx.config.base_url ?? '').trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TerminalError('fieldInvalid', { field: 'base_url' });
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

/** An endpoint below the base address, with its query parameters. */
export function endpointUrl(base: URL, path: string, query: [string, string][] = []): URL {
  const url = new URL(base.toString());
  url.pathname = `${base.pathname}${path}`.replace(/\/{2,}/g, '/');
  for (const [k, v] of query) url.searchParams.append(k, v);
  return url;
}

// ─── OAuth2 ──────────────────────────────────────────────────────────────────

async function tokenRequest(ctx: ConnectorContext, form: Record<string, string>) {
  // An MCP server's tokens name the server they are for (RFC 8707).
  if (ctx.config.mcp_url) form.resource = String(ctx.config.mcp_url);
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const id = String(ctx.config.client_id ?? '');
  const secret = ctx.secret.client_secret ? String(ctx.secret.client_secret) : '';
  if (ctx.config.client_auth === 'in_body' || !secret) {
    form.client_id = id;
    if (secret) form.client_secret = secret;
  } else
    headers.Authorization = `Basic ${Buffer.from(
      `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`
    ).toString('base64')}`;
  const res = await ctx.http.request(String(ctx.config.token_url ?? ''), {
    method: 'POST',
    headers,
    body: new URLSearchParams(form).toString(),
  });
  if (res.status !== 200)
    throw res.status === 400 || res.status === 401 ? new TerminalError('authFailed') : failure(res);
  const json = res.json();
  if (!json?.access_token) throw new TerminalError('authFailed');
  return {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : null,
    expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000,
  };
}

const scopeOf = (ctx: ConnectorContext) => {
  const extra: Record<string, string> = {};
  if (ctx.config.scope) extra.scope = String(ctx.config.scope);
  if (ctx.config.audience) extra.audience = String(ctx.config.audience);
  return extra;
};

async function keep(ctx: ConnectorContext, tokens: Record<string, unknown>) {
  ctx.secret = { ...ctx.secret, ...tokens };
  await ctx.saveSecret(ctx.secret);
}

/** A valid access token: kept, renewed, or (client credentials) fetched. */
async function accessToken(ctx: ConnectorContext, force = false): Promise<string> {
  const fresh = Number(ctx.secret.expires_at ?? 0) > Date.now() + 60_000;
  if (!force && ctx.secret.access_token && fresh) return String(ctx.secret.access_token);
  if (ctx.config.auth === 'oauth2_client') {
    const t = await tokenRequest(ctx, { grant_type: 'client_credentials', ...scopeOf(ctx) });
    await keep(ctx, { access_token: t.access_token, expires_at: t.expires_at });
    return t.access_token;
  }
  // Authorisation code: renewed with the refresh token, or authorised again.
  if (!ctx.secret.refresh_token) throw new TerminalError('needsAuth');
  const t = await tokenRequest(ctx, {
    grant_type: 'refresh_token',
    refresh_token: String(ctx.secret.refresh_token),
  }).catch((e) => {
    throw e instanceof TerminalError && e.code === 'authFailed'
      ? new TerminalError('needsAuth')
      : e;
  });
  await keep(ctx, { ...t, refresh_token: t.refresh_token ?? ctx.secret.refresh_token });
  return t.access_token;
}

/** After consent: the authorisation code becomes tokens. */
export async function restExchangeCode(
  ctx: ConnectorContext,
  code: string,
  redirectUri: string,
  verifier: string | null
) {
  const t = await tokenRequest(ctx, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    ...(verifier ? { code_verifier: verifier } : {}),
  });
  await keep(ctx, t);
}

/** Revokes the tokens at the provider (RFC 7009, when it has an address for it) and forgets them. */
export async function restRevoke(ctx: ConnectorContext) {
  const token = ctx.secret.refresh_token ?? ctx.secret.access_token;
  if (ctx.config.revoke_url && token) {
    const form: Record<string, string> = {
      token: String(token),
      token_type_hint: ctx.secret.refresh_token ? 'refresh_token' : 'access_token',
      client_id: String(ctx.config.client_id ?? ''),
    };
    if (ctx.secret.client_secret) form.client_secret = String(ctx.secret.client_secret);
    const res = await ctx.http.request(String(ctx.config.revoke_url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    if (res.status >= 500) throw failure(res);
  }
  const rest = { ...ctx.secret };
  delete rest.access_token;
  delete rest.refresh_token;
  delete rest.expires_at;
  ctx.secret = rest;
  await ctx.saveSecret(rest);
}

// ─── Signing ─────────────────────────────────────────────────────────────────

/** A template with {placeholders} filled ("\n" written out means a line break). */
export function fill(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\\n/g, '\n')
    .replace(/\{([a-z0-9_]+)\}/g, (all, name) => (Object.hasOwn(vars, name) ? vars[name] : all));
}

/** The headers of a custom HMAC signature (exported for tests). */
export function hmacHeaders(
  config: Record<string, any>,
  secret: string,
  req: { method: string; url: URL; body: string },
  now = new Date(),
  nonce = randomBytes(16).toString('hex')
): Record<string, string> {
  const vars: Record<string, string> = {
    method: req.method,
    path: `${req.url.pathname}${req.url.search}`,
    path_only: req.url.pathname,
    query: req.url.search.replace(/^\?/, ''),
    host: req.url.host,
    body: req.body,
    body_sha256: createHash('sha256').update(req.body).digest('hex'),
    body_md5: createHash('md5').update(req.body).digest('hex'),
    timestamp: String(Math.floor(now.getTime() / 1000)),
    timestamp_ms: String(now.getTime()),
    date: now.toUTCString(),
    iso: now.toISOString(),
    nonce,
    key_id: String(config.hmac_key_id ?? ''),
  };
  const algorithm = ['sha256', 'sha512', 'sha1'].includes(config.hmac_algorithm)
    ? config.hmac_algorithm
    : 'sha256';
  vars.signature = createHmac(algorithm, secret)
    .update(fill(String(config.hmac_string ?? ''), vars))
    .digest(config.hmac_encoding === 'base64' ? 'base64' : 'hex');
  return Object.fromEntries(
    parseHeaderLines(String(config.hmac_headers ?? '')).map(([k, v]) => [k, fill(v, vars)])
  );
}

/** Headers (and query parameters) that sign one request in. */
async function signIn(
  ctx: ConnectorContext,
  req: { method: string; url: URL; body: string },
  force: boolean
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [k, v] of parseHeaderLines(ctx.config.headers)) headers[k] = v;
  for (const [k, v] of parseHeaderLines(ctx.secret.secret_headers)) headers[k] = v;
  switch (ctx.config.auth) {
    case 'api_key':
      if (ctx.config.api_key_in === 'query')
        req.url.searchParams.set(String(ctx.config.api_key_name), String(ctx.secret.api_key ?? ''));
      else headers[String(ctx.config.api_key_name)] = String(ctx.secret.api_key ?? '');
      break;
    case 'bearer':
      headers.Authorization = `Bearer ${ctx.secret.token ?? ''}`;
      break;
    case 'basic':
      headers.Authorization = `Basic ${Buffer.from(
        `${ctx.config.username ?? ''}:${ctx.secret.password ?? ''}`
      ).toString('base64')}`;
      break;
    case 'oauth2_client':
    case 'oauth2_code':
      headers.Authorization = `Bearer ${await accessToken(ctx, force)}`;
      break;
    case 'hmac':
      Object.assign(
        headers,
        ctx.config.hmac_scheme === 'mekari'
          ? mekariHeaders(
              String(ctx.config.hmac_key_id ?? ''),
              String(ctx.secret.hmac_secret ?? ''),
              req.method,
              `${req.url.pathname}${req.url.search}`
            )
          : hmacHeaders(ctx.config, String(ctx.secret.hmac_secret ?? ''), req)
      );
      break;
  }
  return headers;
}

/**
 * One signed request. A 401 with OAuth gets one more try with a renewed
 * token; other answers that are not a success become TerminalErrors (except
 * those `accept` lets through).
 */
export async function restRequest(
  ctx: ConnectorContext,
  method: 'GET' | 'POST' | 'DELETE',
  url: URL,
  body: string | null,
  accept: (status: number) => boolean = (s) => s >= 200 && s < 300,
  extra: Record<string, string> = {}
): Promise<HttpResponse> {
  const oauth = ctx.config.auth === 'oauth2_client' || ctx.config.auth === 'oauth2_code';
  for (let attempt = 0; ; attempt += 1) {
    const signed = new URL(url.toString());
    const headers = await signIn(ctx, { method, url: signed, body: body ?? '' }, attempt > 0);
    const res = await ctx.http.request(signed.toString(), {
      method,
      headers: {
        ...(body === null ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
        // Protocol headers (MCP's) win over configured ones.
        ...extra,
      },
      body: body ?? undefined,
    });
    if (res.status === 401 && oauth && attempt === 0) continue;
    if (res.status === 401 && ctx.config.auth === 'oauth2_code')
      throw new TerminalError('needsAuth');
    if (!accept(res.status)) throw failure(res);
    return res;
  }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

const pageHash = (records: unknown[]) =>
  createHash('sha256').update(JSON.stringify(records)).digest('hex');

/**
 * The endpoint's records in pages (flattened). With `since` and the source's
 * "changed since" parameter, only records changed since the last run.
 */
export async function* readRest(
  ctx: ConnectorContext,
  source: RestSource,
  since: string | null,
  deadline = Date.now() + REST_RUN_MS
): AsyncGenerator<Row[]> {
  const base = baseUrl(ctx);
  const p = source.pagination;
  let page = p.first_page ?? 1;
  let offset = 0;
  // Kept as the API gave it (a number stays a number in a JSON body).
  let cursor: unknown = null;
  let next: URL | null = null;
  let largest = 0;
  let lastHash = '';
  const seen = new Set<string>();

  for (let n = 0; n < MAX_PAGES; n += 1) {
    if (Date.now() > deadline) throw new TerminalError('runTooLong');
    let url: URL;
    const bodyObj: Record<string, any> | null =
      source.method === 'POST' ? (source.body ? JSON.parse(source.body) : {}) : null;
    if (next) url = next;
    else {
      url = endpointUrl(base, source.path, source.query);
      const params: [string, unknown][] = [];
      if (since !== null && source.since_param) params.push([source.since_param, since]);
      if (p.style === 'page') params.push([p.page_param!, page]);
      if (p.style === 'offset') params.push([p.offset_param!, offset]);
      if (p.style === 'cursor' && cursor !== null) params.push([p.cursor_param!, cursor]);
      if (p.size_param && p.size) params.push([p.size_param, p.size]);
      for (const [k, v] of params) {
        if (p.params_in === 'body' && bodyObj) setPath(bodyObj, k, v);
        else url.searchParams.set(k, String(v));
      }
    }
    const res = await restRequest(
      ctx,
      source.method,
      url,
      bodyObj ? JSON.stringify(bodyObj) : null
    );
    const json = res.status === 204 || res.body.length === 0 ? null : res.json();
    const found = getPath(json, source.records);
    if (found === undefined || found === null) {
      if (n === 0 && json !== null) throw new TerminalError('recordsNotFound');
      return;
    }
    const records: unknown[] = Array.isArray(found)
      ? found
      : typeof found === 'object'
        ? [found]
        : [];
    if (!records.length) return;
    const hash = pageHash(records);
    if (hash === lastHash) throw new TerminalError('paginationLoop');
    lastHash = hash;
    yield records.map(flattenRecord);
    await ctx.beat();

    if (p.has_more_path && saysNoMore(getPath(json, p.has_more_path) ?? null)) return;
    // Without a "has more" field, a page shorter than the longest one so far is the last.
    const short = !p.has_more_path && largest > 0 && records.length < largest;
    largest = Math.max(largest, records.length);
    switch (p.style) {
      case 'none':
        return;
      case 'page':
        if (short) return;
        page += 1;
        break;
      case 'offset':
        if (short) return;
        // By what came back: an API that gives fewer than asked skips nothing.
        offset += records.length;
        break;
      case 'cursor': {
        const v = p.cursor_path!.startsWith('$last.')
          ? getPath(records[records.length - 1], p.cursor_path!.slice(6))
          : getPath(json, p.cursor_path!);
        if (v === undefined || v === null || v === '' || v === false) return;
        const value = String(v);
        if (seen.has(value)) throw new TerminalError('paginationLoop');
        seen.add(value);
        cursor = v;
        break;
      }
      case 'next_url':
      case 'link': {
        const v = p.style === 'link' ? linkNext(res.headers.link) : getPath(json, p.next_path!);
        if (typeof v !== 'string' || !v) return;
        let target: URL;
        try {
          target = new URL(v, url);
        } catch {
          throw new TerminalError('badResponse');
        }
        // Next pages stay on the connection's own origin (and pass the guard again).
        if (target.origin !== base.origin) throw new TerminalError('nextUrlOutside');
        if (seen.has(target.toString())) throw new TerminalError('paginationLoop');
        seen.add(target.toString());
        next = target;
        break;
      }
    }
  }
  throw new TerminalError('tooManyPages');
}

/** The endpoints an OpenAPI description (JSON) lists, when the connection has one. */
export async function listOperations(
  ctx: ConnectorContext
): Promise<{ operations: RestOperation[]; openapi: boolean }> {
  const raw = String(ctx.config.openapi_url ?? '').trim();
  if (!raw) return { operations: [], openapi: false };
  const url = new URL(raw);
  // Signed in when it lives with the API.
  const res =
    url.origin === baseUrl(ctx).origin
      ? await restRequest(ctx, 'GET', url, null)
      : await ctx.http.request(url.toString(), { maxBytes: OPENAPI_BYTES });
  if (res.status !== 200) throw failure(res);
  let doc: unknown;
  try {
    doc = JSON.parse(res.text());
  } catch {
    throw new TerminalError('openapiInvalid');
  }
  const operations = openApiOperations(doc);
  if (!operations.length && !(doc as any)?.paths) throw new TerminalError('openapiInvalid');
  return { operations, openapi: true };
}

/** "/customers/{id}" matches "/customers/42". */
const pathMatches = (template: string, path: string) =>
  new RegExp(
    `^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]*\\?\}/g, '[^/]+')}$`
  ).test(path);

/**
 * The first page of an endpoint: its columns (from the records, and from the
 * OpenAPI description for fields the sample does not show), a few rows to
 * look at, and a key to suggest.
 */
export async function describeRest(ctx: ConnectorContext, source: RestSource) {
  const reader = readRest(ctx, source, null, Date.now() + 120_000);
  const first = await reader.next();
  await reader.return(undefined);
  const rows: Row[] = first.done ? [] : first.value;
  let columns: RestColumn[] = columnsFromSample(rows);
  if (ctx.config.openapi_url) {
    const op = (await listOperations(ctx).catch(() => null))?.operations.find(
      (o) => o.method === source.method && pathMatches(o.path, source.path)
    );
    if (op) {
      const known = new Map(columns.map((c) => [c.name, c]));
      for (const c of op.columns) {
        const seen = known.get(c.name);
        if (!seen) columns.push(c);
        // A field that was empty in every sampled record takes the description's type.
        else if (rows.every((r) => r[c.name] === null || r[c.name] === undefined))
          seen.type = c.type;
      }
      columns = columns.slice(0, 200);
    }
  }
  const sample = rows
    .slice(0, 5)
    .map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : v])
      )
    );
  const key = ['id', 'uuid', 'key', 'code'].find((k) => columns.some((c) => c.name === k)) ?? null;
  return { columns, sample, count: rows.length, key };
}

export const rest: Adapter = {
  async test(ctx) {
    const url = ctx.config.test_path
      ? endpointUrl(baseUrl(ctx), String(ctx.config.test_path), [])
      : baseUrl(ctx);
    // Signed in (tokens fetched); the address itself may well answer 404.
    const res = await restRequest(ctx, 'GET', url, null, (s) => s < 500 && s !== 401 && s !== 403);
    return { status: res.status };
  },
  // eslint-disable-next-line require-yield
  async *read() {
    // An API is read by endpoint (readRest), not by ERP list.
    throw new TerminalError('invalid');
  },
};
