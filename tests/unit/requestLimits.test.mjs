import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlots, keyedSlots, SlotsFullError } from '../../src/server/slots.ts';
import { BodyTooLargeError, readLimitedBytes, readLimitedText } from '../../src/server/http/body.ts';
import { clientIp } from '../../src/server/auth/request.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('slots: at most `size` run at once, a short queue waits, the rest are turned away', async () => {
  const slots = createSlots(2, 1);
  let running = 0;
  let peak = 0;
  const releases = [];
  const job = () =>
    slots.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => releases.push(r));
      running -= 1;
      return 'done';
    });
  const a = job();
  const b = job();
  const c = job(); // waits
  await tick();
  assert.deepEqual(slots.load, { active: 2, waiting: 1 });
  await assert.rejects(job(), SlotsFullError, 'beyond the queue');
  releases.shift()();
  await tick();
  assert.deepEqual(slots.load, { active: 2, waiting: 0 }, 'the waiting one took the freed slot');
  while (releases.length) releases.shift()();
  assert.deepEqual(await Promise.all([a, b, c]), ['done', 'done', 'done']);
  assert.equal(peak, 2);
  assert.deepEqual(slots.load, { active: 0, waiting: 0 });
});

test('slots: a failing job frees its slot', async () => {
  const slots = createSlots(1, 0);
  await assert.rejects(slots.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await slots.run(async () => 7), 7);
});

test('keyed slots: one key cannot use another key\'s slots, idle keys are dropped', async () => {
  const perUser = keyedSlots(1, 0);
  let release;
  const busy = perUser.run('alice', () => new Promise((r) => (release = r)));
  await tick();
  await assert.rejects(perUser.run('alice', async () => 1), SlotsFullError);
  assert.equal(await perUser.run('bob', async () => 2), 2, 'bob is not slowed down by alice');
  release('ok');
  assert.equal(await busy, 'ok');
  assert.equal(perUser.size, 0);
});

const chunked = (parts) =>
  new Request('http://localhost/api', {
    method: 'POST',
    body: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    }),
    duplex: 'half',
  });

test('bodies: a chunked body without Content-Length is cut off at the limit', async () => {
  const request = chunked(['x'.repeat(600), 'y'.repeat(600)]);
  assert.equal(request.headers.get('content-length'), null);
  await assert.rejects(readLimitedBytes(request, 1000), BodyTooLargeError);
  assert.equal(await readLimitedText(chunked(['{"a":', '1}']), 1000), '{"a":1}');
});

test('bodies: a declared Content-Length above the limit is refused before reading', async () => {
  const request = new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-length': '5000000' },
    body: 'small',
  });
  await assert.rejects(readLimitedBytes(request, 1000), BodyTooLargeError);
});

test('client IP: Cloudflare Tunnel uses CF-Connecting-IP; no setting trusts no header', () => {
  const request = new Request('http://localhost/', {
    headers: { 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '198.51.100.1' },
  });
  const saved = process.env.TRUST_PROXY;
  try {
    process.env.TRUST_PROXY = 'cloudflare';
    assert.equal(clientIp(request), '203.0.113.5');
    process.env.TRUST_PROXY = '1';
    assert.equal(clientIp(request), '198.51.100.1');
    delete process.env.TRUST_PROXY;
    assert.equal(clientIp(request), null);
  } finally {
    if (saved === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = saved;
  }
});
