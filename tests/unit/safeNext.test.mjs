import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from '../../src/lib/auth/safe-next.ts';

const fromQuery = (query) => safeNext(new URLSearchParams(query).get('next'));

test('paths on this site are kept', () => {
  assert.equal(fromQuery('next=/erp/sales-orders?focus=abc'), '/erp/sales-orders?focus=abc');
  assert.equal(fromQuery('next=/erp/settings%23security'), '/erp/settings#security');
});

test('anything that would leave the site goes to /erp', () => {
  for (const query of [
    'next=https://evil.example',
    'next=//evil.example',
    'next=/%5Cevil.example', // "/\evil.example": browsers read \ as /
    'next=/%09/evil.example', // a tab is dropped, leaving "//evil.example"
    'next=/%0A/evil.example',
    'next=%20/evil.example',
    'next=javascript:alert(1)',
    'next=',
    '',
  ]) {
    assert.equal(fromQuery(query), '/erp', query);
  }
});

test('the two-factor page itself is not a destination', () => {
  assert.equal(fromQuery('next=/mfa'), '/erp');
  assert.equal(fromQuery('next=/mfa?next=/erp'), '/erp');
});

test('sign-in redirects stay on the host the browser opened (behind a tunnel too)', async () => {
  const { NextRequest } = await import('next/server');
  const { middleware } = await import('../../src/middleware.ts');
  const at = async (url, headers) => (await middleware(new NextRequest(url, { headers }))).headers.get('location');
  assert.equal(
    await at('http://localhost:4028/terminal', { host: 'printstream.example.id', 'x-forwarded-proto': 'https' }),
    'https://printstream.example.id/login'
  );
  assert.equal(
    await at('http://localhost:4028/erp/customers', { host: 'printstream.example.id', 'x-forwarded-proto': 'https' }),
    'https://printstream.example.id/erp/login'
  );
  // A malformed Host is never used.
  assert.equal(new URL(await at('http://localhost:4028/', { host: 'evil.example/x' })).host, 'localhost:4028');
});
