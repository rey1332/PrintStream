import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRates, parseRates, providerLabel, providerStatus } from '../../src/server/currency/frankfurter.ts';

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

const respond = (status, body) => async (url, init) => {
  respond.last = { url: String(url), init };
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

test('asks for one base, the quotes and the date; stores the published digits and date', async () => {
  const rows = await fetchRates('EUR', ['IDR', 'USD'], '2026-09-27', respond(200, [
    { date: '2026-09-26', base: 'EUR', quote: 'EUR', rate: 1 },
    { date: '2026-09-26', base: 'EUR', quote: 'IDR', rate: 17234.56 },
    { date: '2026-09-26', base: 'EUR', quote: 'USD', rate: 1.0891 },
  ]));
  assert.equal(respond.last.url, 'https://api.frankfurter.dev/v2/rates?base=EUR&quotes=IDR%2CUSD&date=2026-09-27');
  // A Sunday request comes back with Friday's date: that is the effective date kept.
  assert.deepEqual(rows, [
    { from: 'EUR', to: 'IDR', rate: '17234.56', date: '2026-09-26' },
    { from: 'EUR', to: 'USD', rate: '1.0891', date: '2026-09-26' },
  ]);
});

test('provider list, URL and switch come from the server settings', async () => {
  process.env.FRANKFURTER_PROVIDERS = 'ecb, x;y';
  process.env.FRANKFURTER_URL = 'https://rates.example.test/v2/';
  await fetchRates('USD', ['IDR'], '2026-09-01', respond(200, [{ date: '2026-09-01', base: 'USD', quote: 'IDR', rate: 16250 }]));
  assert.equal(respond.last.url, 'https://rates.example.test/v2/rates?base=USD&quotes=IDR&date=2026-09-01&providers=ECB');
  assert.equal(providerLabel(), 'Frankfurter (ECB)');
  process.env.EXCHANGE_RATE_PROVIDER = 'off';
  assert.equal(providerStatus().enabled, false);
  await assert.rejects(fetchRates('USD', ['IDR'], '2026-09-01', respond(200, [])), (e) => e.code === 'disabled');
});

test('bad or missing data is never stored as a rate', async () => {
  assert.throws(() => parseRates({ rates: {} }, 'EUR', ['IDR']), (e) => e.code === 'invalidResponse');
  assert.throws(() => parseRates([{ date: '2026-09-26', base: 'EUR', quote: 'IDR', rate: 0 }], 'EUR', ['IDR']), (e) => e.code === 'invalidResponse');
  assert.throws(() => parseRates([{ date: '2026-09-26', base: 'USD', quote: 'IDR', rate: 1 }], 'EUR', ['IDR']), (e) => e.code === 'invalidResponse');
  assert.throws(() => parseRates([{ date: 'yesterday', base: 'EUR', quote: 'IDR', rate: 1 }], 'EUR', ['IDR']), (e) => e.code === 'invalidResponse');
  assert.deepEqual(parseRates([{ date: '2026-09-26', base: 'EUR', quote: 'GBP', rate: 0.86 }], 'EUR', ['IDR']), [], 'unrequested quotes are ignored');
  await assert.rejects(fetchRates('EUR', ['IDR'], '2026-09-26', respond(200, [])), (e) => e.code === 'notFound');
  await assert.rejects(fetchRates('EUR', ['IDR'], '2026-09-26', respond(422, { message: 'x' })), (e) => e.code === 'notFound');
  await assert.rejects(fetchRates('EUR', ['IDR'], '2026-09-26', respond(503, {})), (e) => e.code === 'unavailable');
  await assert.rejects(fetchRates('EUR', ['IDR'], '2026-09-26', async () => { throw new Error('ECONNREFUSED'); }), (e) => e.code === 'unavailable');
  await assert.rejects(fetchRates('eur', ['IDR'], '2026-09-26', respond(200, [])), (e) => e.code === 'invalidResponse');
});
