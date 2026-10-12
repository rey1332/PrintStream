import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NextRequest } from 'next/server.js';
import { safeCalc } from '../../src/components/ui/safeCalc.ts';
import { withAuth } from '../../src/lib/api-safe.ts';

test('console calculator: same arithmetic as before', () => {
  const value = (e) => safeCalc(e).value;
  assert.equal(value('2+2'), 4);
  assert.equal(value('4*3'), 12);
  assert.equal(value('15 * 2000'), 30000);
  assert.equal(value('2^10'), 1024);
  assert.equal(value('2^3^2'), 512, 'power is right-associative');
  assert.equal(value('-2^2'), -4);
  assert.equal(value('(1+2)*3 % 4'), 1);
  assert.equal(value('sqrt(16)+abs(-3)'), 7);
  assert.equal(value('max(1, 5, 3) - min(4,2)'), 3);
  assert.equal(value('round(pi*100)/100'), 3.14);
  assert.equal(value('ln(e)*1'), 1);
  assert.equal(value('log(1000)'), 3);
  assert.equal(value('floor(7/2)+ceil(0.1)'), 4);
  assert.equal(value('.5*4'), 2);
});

test('console calculator: invalid maths is reported, plain text goes to chat', () => {
  assert.deepEqual(safeCalc('1/0'), { ok: true, error: 'Not a finite number' });
  assert.equal(safeCalc('(1+2').ok, true);
  assert.ok(safeCalc('(1+2').error);
  assert.equal(safeCalc('sqrt(1,2)+1').error, 'Invalid expression');
  assert.deepEqual(safeCalc('show me my revenue'), { ok: false });
  assert.deepEqual(safeCalc('delete transactions'), { ok: false });
  assert.deepEqual(safeCalc(''), { ok: false });
});

test('console calculator: code is never executed', () => {
  globalThis.__pwned = false;
  for (const attack of [
    'constructor(1)+1',
    'alert(1)+1',
    'this.__pwned=1',
    '(1).constructor.constructor("globalThis.__pwned=true")()',
    'Math.constructor(1)+1',
    'toString(1)+1',
    '__proto__(1)+1',
    `${'('.repeat(400)}1${')'.repeat(400)}`,
  ]) {
    const result = safeCalc(attack);
    assert.equal(result.value, undefined, attack);
  }
  assert.equal(globalThis.__pwned, false);
  const source = fs.readFileSync(new URL('../../src/components/ui/DevConsole.tsx', import.meta.url), 'utf8')
    + fs.readFileSync(new URL('../../src/components/ui/safeCalc.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /new Function|\beval\s*\(/, 'no eval in the console');
});

test('state-changing API routes refuse cross-site requests before touching the session or database', async () => {
  let called = false;
  const handler = withAuth(async () => {
    called = true;
    return { success: true };
  });
  for (const [method, headers] of [
    ['POST', { origin: 'https://evil.example', host: 'etna.example' }],
    ['PATCH', { origin: 'https://evil.example', host: 'etna.example' }],
    ['DELETE', { 'sec-fetch-site': 'cross-site', host: 'etna.example' }],
    ['POST', { host: 'etna.example' }],
    ['POST', { origin: 'null', host: 'etna.example' }],
  ]) {
    const response = await handler(new NextRequest('https://etna.example/api/erp/workflows', { method, headers }));
    assert.equal(response.status, 403, `${method} ${JSON.stringify(headers)}`);
    assert.deepEqual(await response.json(), { success: false, error: 'Cross-site request refused' });
  }
  assert.equal(called, false);
});
