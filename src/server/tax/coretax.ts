// Sales invoices as a Coretax e-Faktur import file (XML, "TaxInvoiceBulk"),
// from the data of erp_tax_faktur_export (db/migrations/20261012000053).
//
// Per line: DPP (TaxBase) is the line amount. Transaction code 04 (the usual
// case under the 12% regime) puts DPP nilai lain = 11/12 × DPP in
// OtherTaxBase and charges 12% on it, which is 11% of the DPP; other codes
// charge the invoice's rate on the DPP. The faktur's PPN must be the PPN the
// invoice booked: a difference of rounding (up to 1 rupiah per line) is taken
// on the largest line, anything more is reported and the file is not made.
//
// Verify the element names, the unit codes (UNIT_CODES below) and the goods /
// services codes against DJP's current Coretax template before the first real
// import (docs/teknis/TAX.md).

export interface FakturBuyer {
  tax_id_type: 'npwp' | 'nik' | 'passport' | 'other' | null;
  tax_id: string;
  nitku: string;
  name: string;
  address: string;
  email: string;
}

export interface FakturLine {
  description: string;
  qty: number | string;
  unit: string;
  price: number | string;
  subtotal: number | string;
  item_code: string;
  item_kind: 'goods' | 'service';
}

export interface FakturInvoice {
  id: string;
  doc_no: string;
  date: string;
  trx_code: string;
  tax_rate: number | string;
  tax_amount: number | string;
  subtotal: number | string;
  buyer: FakturBuyer;
  lines: FakturLine[];
}

export interface FakturExport {
  seller: { npwp: string; nitku: string; name: string };
  invoices: FakturInvoice[];
}

export type FakturProblem =
  | { invoice: string; kind: 'seller_npwp' | 'seller_nitku' | 'buyer_tax_id' | 'no_lines' }
  | { invoice: string; kind: 'vat_mismatch'; booked: number; faktur: number };

/** The app's units as Coretax unit codes (verify against DJP's reference list). */
export const UNIT_CODES: Record<string, string> = {
  ton: 'UM.0001', // metric ton
  kg: 'UM.0003',
  l: 'UM.0007',
  m3: 'UM.0011',
  pcs: 'UM.0021',
  day: 'UM.0026',
  hour: 'UM.0027',
  rit: 'UM.0033', // a truck trip: "other"
};
const OTHER_UNIT = 'UM.0033';

const DOCUMENT: Record<string, string> = {
  nik: 'National ID',
  passport: 'Passport',
  other: 'Other ID',
};

const toCents = (value: number | string) => Math.round(Number(value) * 100);
const money = (cents: number) => (cents / 100).toFixed(2);
const qtyText = (value: number | string) => String(Number(value));

function escapeXml(value: string): string {
  return (
    value
      // Control characters are not allowed in XML 1.0 (tab, LF and CR are).
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}

const tag = (name: string, value: string, indent: string) =>
  value === '' ? `${indent}<${name}/>` : `${indent}<${name}>${escapeXml(value)}</${name}>`;

/** A 16-digit NPWP: the old 15-digit form gets a leading 0. */
export function npwp16(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 16) return digits;
  if (digits.length === 15) return `0${digits}`;
  return null;
}

interface PricedLine {
  line: FakturLine;
  base: number;
  other: number;
  rate: number;
  vat: number;
}

/** The lines with DPP, DPP nilai lain, rate and PPN (in cents), the PPN matched to what was booked. */
export function priceLines(invoice: FakturInvoice): {
  lines: PricedLine[];
  problem: FakturProblem | null;
} {
  const code = invoice.trx_code;
  const invoiceRate = Number(invoice.tax_rate);
  const lines = invoice.lines.map((line) => {
    const base = toCents(line.subtotal);
    if (code === '04') {
      const other = Math.round((base * 11) / 12);
      return { line, base, other, rate: 12, vat: Math.round(other * 0.12) };
    }
    return {
      line,
      base,
      other: base,
      rate: invoiceRate,
      vat: Math.round((base * invoiceRate) / 100),
    };
  });
  const booked = toCents(invoice.tax_amount);
  const faktur = lines.reduce((n, l) => n + l.vat, 0);
  const difference = booked - faktur;
  if (difference !== 0) {
    if (Math.abs(difference) > lines.length || !lines.length)
      return {
        lines,
        problem: {
          invoice: invoice.doc_no || invoice.id,
          kind: 'vat_mismatch',
          booked: booked / 100,
          faktur: faktur / 100,
        },
      };
    const largest = lines.reduce((a, b) => (b.base > a.base ? b : a));
    largest.vat += difference;
  }
  return { lines, problem: null };
}

/** The Coretax XML, or the problems that keep it from being made. */
export function buildCoretaxXml(data: FakturExport): {
  xml: string | null;
  problems: FakturProblem[];
} {
  const problems: FakturProblem[] = [];
  const seller = npwp16(data.seller.npwp);
  const sellerIdtku = data.seller.nitku.replace(/\D/g, '');
  const body: string[] = [];
  for (const invoice of data.invoices) {
    const ref = invoice.doc_no || invoice.id;
    if (!seller) problems.push({ invoice: ref, kind: 'seller_npwp' });
    if (sellerIdtku.length !== 22) problems.push({ invoice: ref, kind: 'seller_nitku' });
    if (!invoice.lines.length) {
      problems.push({ invoice: ref, kind: 'no_lines' });
      continue;
    }
    const b = invoice.buyer;
    let buyerTin = '0000000000000000';
    let documentType = 'TIN';
    let documentNumber = '-';
    let buyerIdtku = '000000';
    if (b.tax_id_type === 'npwp') {
      const tin = npwp16(b.tax_id);
      if (!tin) {
        problems.push({ invoice: ref, kind: 'buyer_tax_id' });
        continue;
      }
      buyerTin = tin;
      buyerIdtku = b.nitku.replace(/\D/g, '') || `${tin}000000`;
    } else if (b.tax_id_type && b.tax_id) {
      documentType = DOCUMENT[b.tax_id_type];
      documentNumber = b.tax_id;
      buyerIdtku = b.tax_id_type === 'nik' ? `${b.tax_id}000000` : '000000';
    } else {
      problems.push({ invoice: ref, kind: 'buyer_tax_id' });
      continue;
    }
    const priced = priceLines(invoice);
    if (priced.problem) {
      problems.push(priced.problem);
      continue;
    }
    const goods = priced.lines.map((l) =>
      [
        '        <GoodService>',
        tag('Opt', l.line.item_kind === 'service' ? 'B' : 'A', '          '),
        tag('Code', /^\d{6}$/.test(l.line.item_code) ? l.line.item_code : '000000', '          '),
        tag('Name', l.line.description, '          '),
        tag('Unit', UNIT_CODES[l.line.unit] ?? OTHER_UNIT, '          '),
        tag('Price', money(toCents(l.line.price)), '          '),
        tag('Qty', qtyText(l.line.qty), '          '),
        tag('TotalDiscount', '0.00', '          '),
        tag('TaxBase', money(l.base), '          '),
        tag('OtherTaxBase', money(l.other), '          '),
        tag('VATRate', String(l.rate), '          '),
        tag('VAT', money(l.vat), '          '),
        tag('STLGRate', '0', '          '),
        tag('STLG', '0.00', '          '),
        '        </GoodService>',
      ].join('\n')
    );
    body.push(
      [
        '    <TaxInvoice>',
        tag('TaxInvoiceDate', invoice.date, '      '),
        tag('TaxInvoiceOpt', 'Normal', '      '),
        tag('TrxCode', invoice.trx_code, '      '),
        tag('AddInfo', '', '      '),
        tag('CustomDoc', '', '      '),
        tag('RefDesc', invoice.doc_no, '      '),
        tag('FacilityStamp', '', '      '),
        tag('SellerIDTKU', sellerIdtku, '      '),
        tag('BuyerTin', buyerTin, '      '),
        tag('BuyerDocument', documentType, '      '),
        tag('BuyerCountry', 'IDN', '      '),
        tag('BuyerDocumentNumber', documentNumber, '      '),
        tag('BuyerName', b.name, '      '),
        // Spelled as in DJP's template.
        tag('BuyerAdress', b.address, '      '),
        tag('BuyerEmail', b.email, '      '),
        tag('BuyerIDTKU', buyerIdtku, '      '),
        '      <ListOfGoodService>',
        ...goods,
        '      </ListOfGoodService>',
        '    </TaxInvoice>',
      ].join('\n')
    );
  }
  if (problems.length) return { xml: null, problems };
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TaxInvoiceBulk xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="TaxInvoice.xsd">',
    tag('TIN', seller ?? '', '  '),
    '  <ListOfTaxInvoice>',
    ...body,
    '  </ListOfTaxInvoice>',
    '</TaxInvoiceBulk>',
    '',
  ].join('\n');
  return { xml, problems: [] };
}
