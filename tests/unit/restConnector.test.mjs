import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';

process.env.MFA_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const {
  parseRestSource,
  flattenRecord,
  inferType,
  columnsFromSample,
  linkNext,
  openApiOperations,
  guessPagination,
  parseHeaderLines,
  headerLinesOk,
  isEndpointPath,
} = await import('../../src/lib/terminal/restSource.ts');
const { fieldShown, CONNECTORS } = await import('../../src/lib/terminal/connectors.ts');
const { readRest, describeRest, hmacHeaders, fill, rest, restExchangeCode, restRevoke } =
  await import('../../src/server/connectors/rest.ts');
const { checkTarget, parseAllowEntry } = await import('../../src/server/connectors/http.ts');

// A fake API: handlers by method + path; records every request.
function fakeHttp(handlers) {
  const calls = [];
  return {
    calls,
    async request(url, options = {}) {
      const u = new URL(url);
      calls.push({ url: u, options });
      const key = `${options.method ?? 'GET'} ${u.pathname}`;
      const handler = handlers[key];
      if (!handler) throw new Error(`unexpected ${key}`);
      const out = await handler(u, options, calls);
      const body = Buffer.from(
        typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {})
      );
      return {
        status: out.status ?? 200,
        headers: out.headers ?? {},
        body,
        url,
        text: () => body.toString(),
        json: () => JSON.parse(body.toString()),
      };
    },
  };
}

function ctxOf(http, config, secret = {}) {
  const saved = { secret: null };
  const ctx = {
    http,
    privateHosts: [],
    config: { base_url: 'https://api.example.com/v1', auth: 'none', ...config },
    secret,
    saveSecret: async (s) => {
      saved.secret = s;
    },
    saveConfig: async () => {},
    beat: async () => {},
  };
  return { ctx, saved };
}

async function collect(gen) {
  const out = [];
  for await (const page of gen) out.push(...page);
  return out;
}

const src = (extra = {}) =>
  parseRestSource({
    mode: 'rest',
    method: 'GET',
    path: '/items',
    query: [],
    records: 'data',
    ...extra,
  });

test('REST sources are checked before they are kept', () => {
  assert.ok(src());
  assert.equal(src({ path: '//evil.com/x' }), null);
  assert.equal(src({ path: '/a/../b' }), null);
  assert.equal(src({ path: 'items' }), null);
  assert.equal(src({ path: '/a?b=1' }), null);
  assert.equal(src({ method: 'DELETE' }), null);
  assert.equal(src({ body: '{}' }), null, 'a body only with POST');
  assert.ok(src({ method: 'POST', body: '{"filter":{"active":true}}' }));
  assert.equal(src({ method: 'POST', body: '[1]' }), null);
  assert.equal(src({ method: 'POST', body: 'nope' }), null);
  assert.equal(src({ records: 'a..b' }), null);
  assert.equal(src({ pagination: { style: 'page' } }), null, 'page needs its parameter');
  assert.ok(src({ pagination: { style: 'page', page_param: 'page' } }));
  assert.equal(src({ pagination: { style: 'offset', offset_param: 'o', size_param: 'l' } }), null);
  assert.equal(
    src({ pagination: { style: 'cursor', cursor_param: 'c', cursor_path: 'x y' } }),
    null
  );
  assert.ok(
    src({
      pagination: { style: 'cursor', cursor_param: 'starting_after', cursor_path: '$last.id' },
    })
  );
  assert.equal(
    src({ pagination: { style: 'page', page_param: 'p', params_in: 'body' } }),
    null,
    'paging in the body only with POST'
  );
  assert.equal(src({ query: [['a b', '1']] }), null);
  assert.equal(src({ key: 'x'.repeat(64) }), null);
  assert.equal(isEndpointPath('/v1/customers.json'), true);
});

test('records are flattened and typed', () => {
  assert.deepEqual(flattenRecord({ id: 1, a: { b: { c: { d: 1 } } }, tags: ['x'] }), {
    id: 1,
    'a.b.c': '{"d":1}',
    tags: '["x"]',
  });
  assert.deepEqual(flattenRecord(5), { value: 5 });
  assert.equal(inferType([1, 2, null]), 'integer');
  assert.equal(inferType([1, 2.5]), 'decimal');
  assert.equal(inferType(['2026-01-02', '2026-01-03T10:00:00Z']), 'timestamp');
  assert.equal(inferType(['2026-01-02']), 'date');
  assert.equal(inferType([true, 'x']), 'text');
  assert.equal(inferType([]), 'text');
  const cols = columnsFromSample([
    { id: 1, customer: { name: 'A' } },
    { id: 2, extra: true },
  ]);
  assert.deepEqual(
    cols.map((c) => [c.name, c.type]),
    [
      ['id', 'integer'],
      ['customer.name', 'text'],
      ['extra', 'boolean'],
    ]
  );
});

test('Link headers and header lines', () => {
  assert.equal(
    linkNext(
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"'
    ),
    'https://api.github.com/x?page=2'
  );
  assert.equal(linkNext('<https://a/x?page=1>; rel="prev"'), null);
  assert.deepEqual(parseHeaderLines('Accept: application/json\nbad line\nX-A:  b '), [
    ['Accept', 'application/json'],
    ['X-A', 'b'],
  ]);
  assert.equal(headerLinesOk('A: 1\n\nB: 2'), true);
  assert.equal(headerLinesOk('A 1'), false);
});

test('REST form fields depend on the sign-in', () => {
  const fields = CONNECTORS.rest.fields;
  const shown = (values) => fields.filter((f) => fieldShown(f, values)).map((f) => f.key);
  assert.ok(shown({ auth: 'bearer' }).includes('token'));
  assert.ok(!shown({ auth: 'bearer' }).includes('api_key'));
  const hmac = shown({ auth: 'hmac', hmac_scheme: 'custom' });
  assert.ok(hmac.includes('hmac_string') && hmac.includes('hmac_headers'));
  assert.ok(!shown({ auth: 'hmac', hmac_scheme: 'mekari' }).includes('hmac_string'));
  assert.equal(shown({ auth: 'oauth2_code' }).filter((k) => k === 'client_secret').length, 1);
});

test('OpenAPI descriptions list endpoints, records, paging and columns', () => {
  const doc = {
    openapi: '3.0.0',
    paths: {
      '/customers': {
        get: {
          summary: 'List customers',
          parameters: [
            { name: 'page', in: 'query' },
            { name: 'per_page', in: 'query' },
          ],
          responses: {
            200: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: { type: 'array', items: { $ref: '#/components/schemas/Customer' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/customers/{id}': { delete: {} },
    },
    components: {
      schemas: {
        Customer: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            created: { type: 'string', format: 'date-time' },
            address: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      },
    },
  };
  const ops = openApiOperations(doc);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].records, 'data');
  assert.deepEqual(ops[0].pagination, {
    style: 'page',
    page_param: 'page',
    first_page: 1,
    size_param: 'per_page',
    size: 100,
  });
  assert.deepEqual(
    ops[0].columns.map((c) => `${c.name}:${c.type}`),
    ['id:integer', 'name:text', 'created:timestamp', 'address.city:text']
  );
  assert.equal(guessPagination(['starting_after', 'limit']).cursor_path, '$last.id');
  assert.equal(guessPagination(['offset', 'limit']).style, 'offset');
  assert.deepEqual(openApiOperations({ nope: 1 }), []);
});

test('page numbers: read until a shorter page, paging in the query', async () => {
  const http = fakeHttp({
    'GET /v1/items': (u) => {
      const page = Number(u.searchParams.get('page'));
      const n = page < 3 ? 2 : 1;
      return { body: { data: Array.from({ length: n }, (_, i) => ({ id: `${page}-${i}` })) } };
    },
  });
  const { ctx } = ctxOf(http, {});
  const rows = await collect(
    readRest(
      ctx,
      src({ query: [['active', '1']], pagination: { style: 'page', page_param: 'page' } }),
      null
    )
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ['1-0', '1-1', '2-0', '2-1', '3-0']
  );
  assert.equal(http.calls[0].url.searchParams.get('active'), '1');
});

test('offset paging counts what came back; has_more stops it', async () => {
  const http = fakeHttp({
    'GET /v1/items': (u) => {
      const off = Number(u.searchParams.get('offset'));
      // The API gives 3 although 5 were asked for.
      return { body: { data: [off, off + 1, off + 2].map((id) => ({ id })), more: off < 6 } };
    },
  });
  const { ctx } = ctxOf(http, {});
  const rows = await collect(
    readRest(
      ctx,
      src({
        pagination: {
          style: 'offset',
          offset_param: 'offset',
          size_param: 'limit',
          size: 5,
          has_more_path: 'more',
        },
      }),
      null
    )
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    [0, 1, 2, 3, 4, 5, 6, 7, 8]
  );
  assert.equal(http.calls[1].url.searchParams.get('offset'), '3');
});

test('cursors from the last record, and in a POST body', async () => {
  const http = fakeHttp({
    'POST /v1/query': (_u, o) => {
      const body = JSON.parse(o.body);
      assert.equal(body.filter.kind, 'a');
      const after = body.paging?.after ?? 0;
      return { body: { results: after >= 4 ? [] : [{ id: after + 1 }, { id: after + 2 }] } };
    },
  });
  const { ctx } = ctxOf(http, {});
  const rows = await collect(
    readRest(
      ctx,
      parseRestSource({
        mode: 'rest',
        method: 'POST',
        path: '/query',
        body: '{"filter":{"kind":"a"}}',
        records: 'results',
        pagination: {
          style: 'cursor',
          cursor_param: 'paging.after',
          cursor_path: '$last.id',
          params_in: 'body',
        },
      }),
      null
    )
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 2, 3, 4]
  );
  assert.equal(http.calls[0].options.headers['Content-Type'], 'application/json');
});

test('next addresses must stay on the API; repeated pages stop the run', async () => {
  const outside = fakeHttp({
    'GET /v1/items': () => ({
      body: { data: [{ id: 1 }], next: 'https://evil.example.net/v1/items?p=2' },
    }),
  });
  await assert.rejects(
    collect(
      readRest(
        ctxOf(outside, {}).ctx,
        src({ pagination: { style: 'next_url', next_path: 'next' } }),
        null
      )
    ),
    /nextUrlOutside/
  );
  const ignores = fakeHttp({ 'GET /v1/items': () => ({ body: { data: [{ id: 1 }, { id: 2 }] } }) });
  await assert.rejects(
    collect(
      readRest(
        ctxOf(ignores, {}).ctx,
        src({ pagination: { style: 'page', page_param: 'p' } }),
        null
      )
    ),
    /paginationLoop/
  );
  const sameCursor = fakeHttp({
    'GET /v1/items': (u) => ({
      body: { data: [{ id: u.searchParams.get('c') ?? 'x' }], next: 'abc' },
    }),
  });
  await assert.rejects(
    collect(
      readRest(
        ctxOf(sameCursor, {}).ctx,
        src({ pagination: { style: 'cursor', cursor_param: 'c', cursor_path: 'next' } }),
        null
      )
    ),
    /paginationLoop/
  );
  const linked = fakeHttp({
    'GET /v1/items': (u) =>
      u.searchParams.get('page') === '2'
        ? { body: { data: [{ id: 2 }] } }
        : { body: { data: [{ id: 1 }] }, headers: { link: '</v1/items?page=2>; rel="next"' } },
  });
  const rows = await collect(
    readRest(ctxOf(linked, {}).ctx, src({ pagination: { style: 'link' } }), null)
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 2]
  );
  await assert.rejects(
    collect(readRest(ctxOf(linked, {}).ctx, src({ records: 'nothing' }), null)),
    /recordsNotFound/
  );
  await assert.rejects(
    collect(readRest(ctxOf(linked, {}).ctx, src(), null, Date.now() - 1)),
    /runTooLong/
  );
});

test('incremental reads send the "changed since" parameter', async () => {
  const http = fakeHttp({ 'GET /v1/items': () => ({ body: { data: [{ id: 1 }] } }) });
  await collect(
    readRest(ctxOf(http, {}).ctx, src({ since_param: 'updated_since' }), '2026-01-01T00:00:00Z')
  );
  assert.equal(http.calls[0].url.searchParams.get('updated_since'), '2026-01-01T00:00:00Z');
});

test('static sign-ins: API key in a header or the query, bearer, basic, extra headers', async () => {
  const seen = [];
  const http = fakeHttp({
    'GET /v1/items': (u, o) => {
      seen.push({ u, h: o.headers });
      return { body: { data: [] } };
    },
  });
  const run = (config, secret) => collect(readRest(ctxOf(http, config, secret).ctx, src(), null));
  await run(
    { auth: 'api_key', api_key_in: 'header', api_key_name: 'X-Key', headers: 'Accept: text/json' },
    { api_key: 'k1', secret_headers: 'X-Tenant: 9' }
  );
  assert.equal(seen[0].h['X-Key'], 'k1');
  assert.equal(seen[0].h.Accept, 'text/json');
  assert.equal(seen[0].h['X-Tenant'], '9');
  await run({ auth: 'api_key', api_key_in: 'query', api_key_name: 'key' }, { api_key: 'k2' });
  assert.equal(seen[1].u.searchParams.get('key'), 'k2');
  await run({ auth: 'bearer' }, { token: 't' });
  assert.equal(seen[2].h.Authorization, 'Bearer t');
  await run({ auth: 'basic', username: 'u' }, { password: 'p' });
  assert.equal(seen[3].h.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
});

test('OAuth2 client credentials: fetched, kept, renewed after a 401', async () => {
  let tokens = 0;
  let rejectOnce = true;
  const http = fakeHttp({
    'POST /oauth/token': (_u, o) => {
      tokens += 1;
      const form = new URLSearchParams(o.body);
      assert.equal(form.get('grant_type'), 'client_credentials');
      assert.equal(form.get('scope'), 'read');
      assert.equal(o.headers.Authorization, `Basic ${Buffer.from('cid:cs').toString('base64')}`);
      return { body: { access_token: `tok${tokens}`, expires_in: 3600 } };
    },
    'GET /v1/items': (_u, o) => {
      if (rejectOnce) {
        rejectOnce = false;
        return { status: 401 };
      }
      assert.equal(o.headers.Authorization, 'Bearer tok2');
      return { body: { data: [{ id: 1 }] } };
    },
  });
  const { ctx, saved } = ctxOf(
    http,
    {
      auth: 'oauth2_client',
      token_url: 'https://auth.example.com/oauth/token',
      client_id: 'cid',
      scope: 'read',
      client_auth: 'in_header',
    },
    { client_secret: 'cs' }
  );
  const rows = await collect(readRest(ctx, src(), null));
  assert.equal(rows.length, 1);
  assert.equal(tokens, 2);
  assert.equal(saved.secret.access_token, 'tok2');
  assert.equal(saved.secret.client_secret, 'cs');
});

test('OAuth2 authorisation code: exchange with PKCE, renewal, revocation', async () => {
  const http = fakeHttp({
    'POST /token': (_u, o) => {
      const form = new URLSearchParams(o.body);
      if (form.get('grant_type') === 'authorization_code') {
        assert.equal(form.get('code_verifier'), 'ver');
        assert.equal(form.get('client_id'), 'cid', 'no secret: the client ID goes in the body');
        return { body: { access_token: 'a1', refresh_token: 'r1', expires_in: 1 } };
      }
      assert.equal(form.get('refresh_token'), 'r1');
      return { body: { access_token: 'a2', expires_in: 3600 } };
    },
    'POST /revoke': (_u, o) => {
      assert.equal(new URLSearchParams(o.body).get('token'), 'r1');
      return { status: 200, body: {} };
    },
    'GET /v1/me': (_u, o) => {
      assert.equal(o.headers.Authorization, 'Bearer a2');
      return { status: 200, body: {} };
    },
  });
  const config = {
    auth: 'oauth2_code',
    token_url: 'https://auth.example.com/token',
    revoke_url: 'https://auth.example.com/revoke',
    client_id: 'cid',
    test_path: '/me',
  };
  const { ctx, saved } = ctxOf(http, config, {});
  await assert.rejects(rest.test(ctx), /needsAuth/);
  await restExchangeCode(ctx, 'code', 'https://etna/api/terminal/connectors/oauth', 'ver');
  assert.equal(saved.secret.refresh_token, 'r1');
  // The token expires within a minute, so it is renewed first.
  assert.deepEqual(await rest.test(ctx), { status: 200 });
  assert.equal(saved.secret.refresh_token, 'r1', 'the refresh token is kept');
  await restRevoke(ctx);
  assert.equal(saved.secret.access_token, undefined);
  assert.equal(saved.secret.refresh_token, undefined);
});

test('HMAC: a template over the request, and Mekari rules', async () => {
  const now = new Date('2026-10-11T00:00:00Z');
  const url = new URL('https://api.example.com/v1/items?a=1');
  const headers = hmacHeaders(
    {
      hmac_key_id: 'kid',
      hmac_algorithm: 'sha256',
      hmac_encoding: 'hex',
      hmac_string: '{method}\\n{path}\\n{timestamp}\\n{body_sha256}',
      hmac_headers: 'X-Signature: {key_id}:{signature}\nX-Timestamp: {timestamp}',
    },
    'sek',
    { method: 'GET', url, body: '' },
    now,
    'n'
  );
  const ts = String(now.getTime() / 1000);
  const expected = createHmac('sha256', 'sek')
    .update(`GET\n/v1/items?a=1\n${ts}\n${createHash('sha256').update('').digest('hex')}`)
    .digest('hex');
  assert.equal(headers['X-Signature'], `kid:${expected}`);
  assert.equal(headers['X-Timestamp'], ts);
  assert.equal(fill('{a}-{b}', { a: '1' }), '1-{b}');

  const http = fakeHttp({
    'GET /v1/items': (_u, o) => {
      assert.match(o.headers.Authorization, /^hmac username="kid", algorithm="hmac-sha256"/);
      return { body: { data: [] } };
    },
  });
  await collect(
    readRest(
      ctxOf(http, { auth: 'hmac', hmac_scheme: 'mekari', hmac_key_id: 'kid' }, { hmac_secret: 's' })
        .ctx,
      src(),
      null
    )
  );
});

test('describing an endpoint: columns from the page and the OpenAPI description, a key', async () => {
  const http = fakeHttp({
    'GET /v1/items': () => ({ body: { data: [{ id: 1, name: 'A', note: null }] } }),
    'GET /v1/openapi.json': () => ({
      body: {
        openapi: '3.0.0',
        paths: {
          '/items': {
            get: {
              responses: {
                200: {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          data: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                id: { type: 'integer' },
                                note: { type: 'number' },
                                updated_at: { type: 'string', format: 'date-time' },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  });
  const { ctx } = ctxOf(http, { openapi_url: 'https://api.example.com/v1/openapi.json' });
  const d = await describeRest(ctx, src());
  assert.equal(d.count, 1);
  assert.equal(d.key, 'id');
  assert.deepEqual(
    d.columns.map((c) => `${c.name}:${c.type}:${c.from}`),
    ['id:integer:sample', 'name:text:sample', 'note:decimal:sample', 'updated_at:timestamp:schema']
  );
  assert.equal(http.calls.length, 2, 'one page only, then the description');
});

test('the test call: signed in, any answer below 500 except 401/403', async () => {
  const http = fakeHttp({ 'GET /v1': () => ({ status: 404 }) });
  assert.deepEqual(await rest.test(ctxOf(http, {}).ctx), { status: 404 });
  const denied = fakeHttp({ 'GET /v1': () => ({ status: 403 }) });
  await assert.rejects(rest.test(ctxOf(denied, {}).ctx), /authFailed/);
});

test('allowed internal entries can be limited to one port (tunnels)', async () => {
  assert.deepEqual(parseAllowEntry('10.0.0.5:5432'), { host: '10.0.0.5', bits: null, port: 5432 });
  assert.deepEqual(parseAllowEntry('[fd00::5]:443'), { host: 'fd00::5', bits: null, port: 443 });
  assert.deepEqual(parseAllowEntry('10.0.0.0/8'), { host: '10.0.0.0', bits: 8, port: null });
  assert.equal(parseAllowEntry('10.0.0.0/99'), null);
  assert.equal(
    (await checkTarget(new URL('https://10.0.0.5:5432/'), ['10.0.0.5:5432'])).internal,
    true
  );
  await assert.rejects(
    checkTarget(new URL('https://10.0.0.5:5433/'), ['10.0.0.5:5432']),
    /hostPrivate/
  );
  await assert.rejects(checkTarget(new URL('https://10.0.0.5/'), ['10.0.0.5:5432']), /hostPrivate/);
  await assert.rejects(
    checkTarget(new URL('https://127.0.0.1:8080/'), ['127.0.0.1:8080']),
    /hostBlocked/
  );
});
