import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicPath } from '../../src/lib/auth/public-paths.ts';

test('public pages and the pages below them open without a session', () => {
  for (const p of ['/login', '/erp/login', '/reset-password', '/terms', '/terms/2', '/api/health'])
    assert.equal(isPublicPath(p), true, p);
});

test('paths that only start like a public page are not public', () => {
  for (const p of ['/termsx', '/login-admin', '/loginx', '/api/healthz', '/api/health-admin', '/erp/loginx', '/erp', '/'])
    assert.equal(isPublicPath(p), false, p);
});
