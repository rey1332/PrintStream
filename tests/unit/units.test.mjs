import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertQty, parseQty, roundQty, unitsFor } from '../../src/lib/units.ts';
import { remainingQty } from '../../src/app/erp/lib/erpRules.ts';

test('quantities round to three decimals and accept a decimal comma', () => {
  assert.equal(roundQty(12.3755), 12.376);
  assert.equal(roundQty(0.1 + 0.2), 0.3);
  assert.equal(parseQty('12,5'), 12.5);
  assert.equal(parseQty(' 7.0004 '), 7);
  assert.equal(parseQty('0'), null);
  assert.equal(parseQty('abc'), null);
  assert.equal(remainingQty(0.3, 0.1), 0.2);
  assert.equal(remainingQty(2, 5), 0);
});

test('conversion: within mass and volume, across them only with a density', () => {
  assert.equal(convertQty(2.5, 'ton', 'kg'), 2500);
  assert.equal(convertQty(750, 'l', 'm3'), 0.75);
  assert.equal(convertQty(3, 'ton', 'm3', 1.5), 2);
  assert.equal(convertQty(2, 'm3', 'kg', 1.5), 3000);
  assert.equal(convertQty(3, 'ton', 'm3'), null);
  assert.equal(convertQty(1, 'rit', 'm3', 1.5), null);
  assert.equal(convertQty(4, 'pcs', 'pcs'), 4);
});

test('a product in m³ can be entered in m³ and liters, plus ton and kg with a density', () => {
  assert.deepEqual(unitsFor('m3'), ['m3', 'l']);
  assert.deepEqual(unitsFor('m3', 1.45), ['m3', 'l', 'ton', 'kg']);
  assert.deepEqual(unitsFor('rit'), ['rit']);
});
