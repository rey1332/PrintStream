import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertAmount } from '../../src/lib/currency/client.ts';
import { formatMoney } from '../../src/lib/i18n/format.ts';

test('conversion is exact decimal arithmetic, rounded half away from zero to the currency', () => {
  assert.equal(convertAmount(33.33, '12001.337', 2), 400004.56);         // 400004.56221
  assert.equal(convertAmount(100, '0.000061538462', 2), 0.01);
  assert.equal(convertAmount(1000000, '0.000061538462', 2), 61.54);
  assert.equal(convertAmount('0.005', '1', 2), 0.01);                    // half up
  assert.equal(convertAmount(-0.005, '1', 2), -0.01);                    // half away from zero
  assert.equal(convertAmount(1234.5, '1', 0), 1235);                     // JPY-style
  assert.equal(convertAmount(10, '0.1234567', 3), 1.235);               // 3-decimal currency
  // 0.1 + 0.2 style float errors never appear.
  assert.equal(convertAmount(0.1, '3', 2), 0.3);
  assert.equal(convertAmount(1.005, '1', 2), 1.01);
  // Same input, same output.
  assert.equal(convertAmount(98765.43, '16250.5', 2), convertAmount(98765.43, '16250.5', 2));
  assert.equal(convertAmount(1, 'abc', 2), null);
  assert.equal(convertAmount(1, '1e3', 2), null);
});

// Intl separates code and number with a no-break space.
const money = (...args) => formatMoney(...args).replace(/\u00a0/g, ' ');

test('money shows a code wherever the symbol could mean another currency', () => {
  assert.equal(money('en', 1500, undefined, 'USD'), 'USD 1,500.00');
  assert.equal(money('en', 1500, undefined, 'JPY'), 'JPY 1,500');
  assert.equal(money('en', 1500, undefined, 'EUR'), '€1,500.00');
  assert.equal(money('id', 1500, undefined, 'IDR'), 'Rp 1.500');
  assert.equal(money('id', 1500, undefined, 'USD'), 'US$1.500,00');
  assert.match(money('en', 1500, undefined, 'AUD'), /^A\$/);
});
