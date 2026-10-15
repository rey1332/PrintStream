import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCoretaxXml, npwp16, priceLines } from '../../src/server/tax/coretax.ts';

const seller = { npwp: '0012345678901000', nitku: '0012345678901000000000', name: 'PT Batu Jaya' };
const buyer = {
  tax_id_type: 'npwp',
  tax_id: '0098765432109000',
  nitku: '0098765432109000000000',
  name: 'PT Pembeli & Sons <Bogor>',
  address: 'Jl. Raya 1, Bogor',
  email: 'pajak@pembeli.co.id',
};
const line = (subtotal, extra = {}) => ({
  description: 'Batu split 1/2',
  qty: 10,
  unit: 'm3',
  price: subtotal / 10,
  subtotal,
  item_code: '000000',
  item_kind: 'goods',
  ...extra,
});
const invoice = (extra = {}) => ({
  id: 'inv-1',
  doc_no: 'INV/2026/0001',
  date: '2026-10-15',
  trx_code: '04',
  tax_rate: 11,
  tax_amount: 110000,
  subtotal: 1000000,
  buyer,
  lines: [line(1000000)],
  ...extra,
});
const value = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map((m) => m[1]);

test('code 04: DPP nilai lain 11/12 at 12% is 11% of the DPP, as the invoice booked', () => {
  const { xml, problems } = buildCoretaxXml({ seller, invoices: [invoice()] });
  assert.deepEqual(problems, []);
  assert.deepEqual(value(xml, 'TaxBase'), ['1000000.00']);
  assert.deepEqual(value(xml, 'OtherTaxBase'), ['916666.67']);
  assert.deepEqual(value(xml, 'VATRate'), ['12']);
  assert.deepEqual(value(xml, 'VAT'), ['110000.00']);
  assert.deepEqual(value(xml, 'TrxCode'), ['04']);
  assert.deepEqual(value(xml, 'TIN'), ['0012345678901000']);
  assert.deepEqual(value(xml, 'SellerIDTKU'), ['0012345678901000000000']);
  assert.deepEqual(value(xml, 'BuyerTin'), ['0098765432109000']);
  assert.deepEqual(value(xml, 'BuyerDocument'), ['TIN']);
  assert.deepEqual(value(xml, 'Unit'), ['UM.0011']);
  assert.deepEqual(value(xml, 'Opt'), ['A']);
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<TaxInvoiceBulk /);
});

test('names and addresses are escaped; the XML stays well-formed', () => {
  const { xml } = buildCoretaxXml({ seller, invoices: [invoice()] });
  assert.deepEqual(value(xml, 'BuyerName'), ['PT Pembeli &amp; Sons &lt;Bogor&gt;']);
  // Every element that opens also closes, in order.
  const stack = [];
  for (const [, close, name, self] of xml.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) {
    if (self) continue;
    if (close) assert.equal(stack.pop(), name);
    else stack.push(name);
  }
  assert.deepEqual(stack, []);
});

test('rounding: a cent per line is taken on the largest line so the PPN matches the booking', () => {
  // Three lines of 10.05 at code 01 / 11%: 1.11 each (3.33), but the invoice booked
  // round(30.15 × 11%) = 3.32 on its total.
  const inv = invoice({
    trx_code: '01',
    tax_amount: 3.32,
    lines: [line(10.05), line(10.05), line(10.05)],
  });
  const { lines, problem } = priceLines(inv);
  assert.equal(problem, null);
  assert.equal(lines.reduce((n, l) => n + l.vat, 0), 332);
  assert.deepEqual(lines.map((l) => l.vat), [110, 111, 111]);
  // A real mismatch (wrong code for the rate) is refused, not "fixed".
  const wrong = buildCoretaxXml({ seller, invoices: [invoice({ trx_code: '01', tax_rate: 12, tax_amount: 110000 })] });
  assert.equal(wrong.xml, null);
  assert.deepEqual(wrong.problems, [{ invoice: 'INV/2026/0001', kind: 'vat_mismatch', booked: 110000, faktur: 120000 }]);
});

test('buyers without NPWP: NIK as National ID with its IDTKU; missing data is reported', () => {
  const nik = buildCoretaxXml({
    seller,
    invoices: [invoice({ buyer: { ...buyer, tax_id_type: 'nik', tax_id: '3201012345670001', nitku: '' } })],
  });
  assert.deepEqual(value(nik.xml, 'BuyerTin'), ['0000000000000000']);
  assert.deepEqual(value(nik.xml, 'BuyerDocument'), ['National ID']);
  assert.deepEqual(value(nik.xml, 'BuyerDocumentNumber'), ['3201012345670001']);
  assert.deepEqual(value(nik.xml, 'BuyerIDTKU'), ['3201012345670001000000']);

  const none = buildCoretaxXml({ seller, invoices: [invoice({ buyer: { ...buyer, tax_id_type: null, tax_id: '' } })] });
  assert.deepEqual(none.problems, [{ invoice: 'INV/2026/0001', kind: 'buyer_tax_id' }]);
  const noSeller = buildCoretaxXml({ seller: { ...seller, nitku: '' }, invoices: [invoice()] });
  assert.deepEqual(noSeller.problems.map((p) => p.kind), ['seller_nitku']);
  const noLines = buildCoretaxXml({ seller, invoices: [invoice({ lines: [] })] });
  assert.deepEqual(noLines.problems.map((p) => p.kind), ['no_lines']);
});

test('services are B; unknown units and codes fall back; old 15-digit NPWP gets a leading 0', () => {
  const { xml } = buildCoretaxXml({
    seller: { ...seller, npwp: '01.234.567.8-901.000' },
    invoices: [invoice({ lines: [line(1000000, { item_kind: 'service', unit: 'rit', item_code: 'abc' })] })],
  });
  assert.deepEqual(value(xml, 'Opt'), ['B']);
  assert.deepEqual(value(xml, 'Unit'), ['UM.0033']);
  assert.deepEqual(value(xml, 'Code'), ['000000']);
  assert.deepEqual(value(xml, 'TIN'), ['0012345678901000']);
  assert.equal(npwp16('12345'), null);
});
