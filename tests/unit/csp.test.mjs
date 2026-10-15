import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { contentSecurityPolicy, newNonce } from '../../src/lib/security/csp.ts';

const directive = (policy, name) =>
  policy
    .split('; ')
    .find((d) => d.startsWith(`${name} `))
    ?.slice(name.length + 1);

test('scripts run only with the nonce: no unsafe-inline, eval only in development', () => {
  const policy = contentSecurityPolicy('abc123==');
  const scripts = directive(policy, 'script-src');
  assert.equal(scripts, "'self' 'nonce-abc123==' 'strict-dynamic'");
  assert.ok(!policy.includes("'unsafe-eval'"));
  assert.match(directive(contentSecurityPolicy('n', { dev: true }), 'script-src'), /'unsafe-eval'/);
  assert.equal(directive(policy, 'connect-src'), "'self'");
  assert.equal(directive(contentSecurityPolicy('n', { dev: true }), 'connect-src'), "'self' ws:");
  for (const [name, value] of [
    ['frame-ancestors', "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
  ])
    assert.equal(directive(policy, name), value, name);
});

test('image hosts are allowed by origin', () => {
  const policy = contentSecurityPolicy('n', { imageHosts: [{ protocol: 'https', hostname: 'cdn.example.com' }] });
  assert.equal(directive(policy, 'img-src'), "'self' data: blob: https://cdn.example.com");
});

test('a new 128-bit nonce for every request', () => {
  const nonces = new Set(Array.from({ length: 200 }, newNonce));
  assert.equal(nonces.size, 200);
  for (const n of nonces) assert.equal(Buffer.from(n, 'base64').length, 16);
});

test('no fixed CSP in next.config.mjs (it would combine with the per-request one and block every script)', () => {
  const config = fs.readFileSync(new URL('../../next.config.mjs', import.meta.url), 'utf8');
  assert.ok(!/key:\s*'Content-Security-Policy'/.test(config));
  const middleware = fs.readFileSync(new URL('../../src/middleware.ts', import.meta.url), 'utf8');
  assert.match(middleware, /contentSecurityPolicy\(nonce/);
});
