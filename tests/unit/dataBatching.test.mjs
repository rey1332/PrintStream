import { test } from 'node:test';
import assert from 'node:assert/strict';

// The browser data client sends what a page asks for at once as one
// { batch } request (src/lib/db/browser-client.ts).
const calls = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push(body);
  if (body.batch) {
    if (body.batch.some((s) => s.fn === 'refuse_all'))
      return new Response(
        JSON.stringify({
          data: null,
          error: { message: 'JWT expired', code: 'PGRST301' },
          count: null,
          status: 401,
        }),
        { status: 401 }
      );
    return new Response(
      JSON.stringify({
        batch: body.batch.map((s) => ({
          data: s.fn ?? s.table,
          error: null,
          count: null,
          status: 200,
        })),
      })
    );
  }
  return new Response(
    JSON.stringify({ data: body.fn ?? body.table, error: null, count: null, status: 200 })
  );
};

const { createBrowserDataClient } = await import('../../src/lib/db/browser-client.ts');
const db = createBrowserDataClient();

test('requests started together go as one batch, each gets its own answer', async () => {
  calls.length = 0;
  const [a, b, c] = await Promise.all([
    db.rpc('one'),
    db.rpc('two'),
    db.from('erp_customers').select('*'),
  ]);
  assert.deepEqual([a.data, b.data, c.data], ['one', 'two', 'erp_customers']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].batch.length, 3);
});

test('a request on its own is sent as before; large bodies never wait for a batch', async () => {
  calls.length = 0;
  assert.equal((await db.rpc('alone')).data, 'alone');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].batch, undefined);
  calls.length = 0;
  const big = 'x'.repeat(70_000);
  await Promise.all([db.rpc('upload', { p: big }), db.rpc('small')]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => !c.batch));
});

test('a refusal of the whole batch (signed out) answers every request with it', async () => {
  const [a, b] = await Promise.all([db.rpc('refuse_all'), db.rpc('other')]);
  assert.equal(a.error.code, 'PGRST301');
  assert.equal(b.error.code, 'PGRST301');
});
