import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDelimiter,
  parseAmount,
  parseCsv,
  parseDate,
  parseStatement,
} from '../../src/lib/finance/bankCsv.ts';

// Shaped like the banks' exports; account numbers and names are made up.
const BCA = [
  'No. rekening : 1234567890',
  'Nama : PT BATU JAYA',
  'Periode : 01/10/2026 - 31/10/2026',
  'Kode Mata Uang : Rp',
  '',
  'Tanggal Transaksi,Keterangan,Cabang,Jumlah,,Saldo',
  `'01/10,TRSF E-BANKING CR 0110/FTSCY/WS95051 7500000.00 PT PEMBELI,'0000,"7,500,000.00",CR,"17,500,000.00"`,
  `'02/10,TRSF E-BANKING DB 0210/FTSCY/WS95051 2000000.00 PT SOLAR,'0000,"2,000,000.00",DB,"15,500,000.00"`,
  `'31/10,BIAYA ADM,'0998,"15,000.00",DB,"15,485,000.00"`,
  `PEND,SETORAN TUNAI,'0000,"500,000.00",CR,`,
  '',
  'Saldo Awal,"10,000,000.00"',
  'Mutasi Debet,"2,015,000.00"',
  'Mutasi Kredit,"7,500,000.00"',
  'Saldo Akhir,"15,485,000.00"',
].join('\r\n');

const MANDIRI = [
  'Account No,Date,Val. Date,Transaction Code,Description,Description,Reference No.,Debit,Credit,',
  '1230001234567,01/10/26,01/10/26,7300,SA Incoming,DARI PT PEMBELI,REF001,.00,"7,500,000.00",',
  '1230001234567,02/10/26,02/10/26,8890,Transfer,KE PT SOLAR,REF002,"2,000,000.00",.00,',
].join('\n');

const BRI = [
  'TGL_TRAN;DESK_TRAN;MUTASI_DEBET;MUTASI_KREDIT;SALDO_AKHIR_MUTASI',
  '01/10/2026 10:21:05;TRF DARI PT PEMBELI;0,00;7.500.000,00;17.500.000,00',
  '02/10/2026 14:02:44;TRF KE PT SOLAR;2.000.000,00;0,00;15.500.000,00',
].join('\n');

const BNI = [
  'Post Date,Value Date,Branch,Journal No.,Description,Debit,Credit,',
  '01-Oct-26,01-Oct-26,0259,123456,TRANSFER DARI PT PEMBELI,0,"7,500,000.00",',
  '02-Oct-26,02-Oct-26,0259,123457,TRANSFER KE PT SOLAR,"2,000,000.00",0,',
].join('\n');

const BNI_ID = [
  'Tanggal Transaksi,Uraian Transaksi,Tipe,Nominal,Saldo',
  '01 Okt 2026,TRANSFER DARI PT PEMBELI,K,"7.500.000,00","17.500.000,00"',
  '02 Okt 2026,TRANSFER KE PT SOLAR,D,"2.000.000,00","15.500.000,00"',
].join('\n');

const simple = (r) => r.lines.map((l) => [l.date, l.amount]);

test('amounts in Indonesian and English formats, with signs and DB / CR marks', () => {
  assert.equal(parseAmount('1.500.000,00'), 1_500_000);
  assert.equal(parseAmount('1,500,000.00'), 1_500_000);
  assert.equal(parseAmount('1.500.000'), 1_500_000);
  assert.equal(parseAmount('1500.5'), 1500.5);
  assert.equal(parseAmount('1,500'), 1500);
  assert.equal(parseAmount('Rp 15.000,50'), 15000.5);
  assert.equal(parseAmount('(2.000)'), -2000);
  assert.equal(parseAmount('2,000.00-'), -2000);
  assert.equal(parseAmount('-2.000,00'), -2000);
  assert.equal(parseAmount('15,000.00 DB'), -15000);
  assert.equal(parseAmount('15,000.00 CR'), 15000);
  assert.equal(parseAmount('.00'), 0);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount('12-34'), null);
});

test("dates in the banks' formats", () => {
  assert.equal(parseDate('31/10/2026'), '2026-10-31');
  assert.equal(parseDate('31-10-26'), '2026-10-31');
  assert.equal(parseDate('2026-10-31'), '2026-10-31');
  assert.equal(parseDate('31 Okt 2026'), '2026-10-31');
  assert.equal(parseDate('01-Oct-26'), '2026-10-01');
  assert.equal(parseDate('01 Agt 2026'), '2026-08-01');
  assert.equal(parseDate('01/10/2026 10:21:05'), '2026-10-01');
  assert.equal(parseDate("'31/10", 'dmy', 2026), '2026-10-31');
  assert.equal(parseDate('10/31/2026', 'mdy'), '2026-10-31');
  assert.equal(parseDate('20261031'), '2026-10-31');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('31/10'), null);
  assert.equal(parseDate('kemarin'), null);
});

test('CSV: quotes, delimiters, line breaks in fields', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2'), '\t');
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\n"x\ny",2,3'), [
    ['a', 'b, c', 'say "hi"'],
    ['x\ny', '2', '3'],
  ]);
});

test('BCA: the year from the period, DB / CR in the unnamed column, the footer balances, pending lines', () => {
  const r = parseStatement(BCA);
  assert.equal(r.format, 'bca');
  assert.deepEqual(simple(r), [
    ['2026-10-01', 7_500_000],
    ['2026-10-02', -2_000_000],
    ['2026-10-31', -15_000],
  ]);
  assert.equal(r.lines[0].balance, 17_500_000);
  assert.match(r.lines[0].description, /PT PEMBELI/);
  assert.equal(r.opening, 10_000_000);
  assert.equal(r.closing, 15_485_000);
  assert.deepEqual(
    r.problems.map((p) => p.kind),
    ['pending']
  );
});

test('BCA across the new year: December lines in a January statement', () => {
  const text = BCA.replace('01/10/2026 - 31/10/2026', '15/12/2026 - 15/01/2027')
    .replace("'01/10,", "'20/12,")
    .replace("'02/10,", "'03/01,")
    .replace("'31/10,", "'15/01,");
  assert.deepEqual(
    simple(parseStatement(text)).map(([d]) => d),
    ['2026-12-20', '2027-01-03', '2027-01-15']
  );
});

test('Mandiri, BRI and BNI layouts', () => {
  const m = parseStatement(MANDIRI);
  assert.equal(m.format, 'mandiri');
  assert.deepEqual(simple(m), [
    ['2026-10-01', 7_500_000],
    ['2026-10-02', -2_000_000],
  ]);
  // Both description columns, and the reference.
  assert.equal(m.lines[0].description, 'SA Incoming DARI PT PEMBELI');
  assert.equal(m.lines[0].reference, 'REF001');

  const b = parseStatement(BRI);
  assert.equal(b.format, 'bri');
  assert.deepEqual(simple(b), [
    ['2026-10-01', 7_500_000],
    ['2026-10-02', -2_000_000],
  ]);
  assert.equal(b.lines[1].balance, 15_500_000);

  const n = parseStatement(BNI);
  assert.equal(n.format, 'bni');
  assert.deepEqual(simple(n), [
    ['2026-10-01', 7_500_000],
    ['2026-10-02', -2_000_000],
  ]);
  assert.equal(n.lines[1].reference, '123457');

  const ni = parseStatement(BNI_ID);
  assert.equal(ni.format, 'bni');
  assert.deepEqual(simple(ni), [
    ['2026-10-01', 7_500_000],
    ['2026-10-02', -2_000_000],
  ]);
});

test('any CSV: found by its column names, or mapped by hand', () => {
  const plain =
    'Date,Memo,Amount,Balance\n2026-10-01,Interest,1250.50,1250.50\n2026-10-02,Fee,-6500,-5249.50\n';
  const r = parseStatement(plain);
  assert.equal(r.format, 'custom');
  assert.deepEqual(simple(r), [
    ['2026-10-01', 1250.5],
    ['2026-10-02', -6500],
  ]);

  // Columns the parser does not know, chosen by hand.
  const odd = 'When,What,How much\n01/10/2026,Setoran,"1.000.000"\nxx/10/2026,Rusak,5\n';
  const none = parseStatement(odd);
  assert.equal(none.map, null);
  assert.equal(none.lines.length, 0);
  const mapped = parseStatement(odd, {
    map: {
      date: 0,
      description: [1],
      reference: null,
      amount: 2,
      dc: null,
      debit: null,
      credit: null,
      balance: null,
    },
  });
  assert.equal(mapped.headerRow, -1);
  // Without a header row the names row is read as data; it is text, so skipped.
  assert.deepEqual(simple(mapped), [['2026-10-01', 1_000_000]]);
  assert.deepEqual(
    mapped.problems.map((p) => [p.row, p.kind]),
    [[3, 'date']]
  );
  // With the header row named, only the bad line is a problem.
  const withHeader = parseStatement(odd, { headerRow: 0, map: mapped.map });
  assert.deepEqual(withHeader.headers, ['When', 'What', 'How much']);
  assert.deepEqual(
    withHeader.problems.map((p) => [p.row, p.kind]),
    [[3, 'date']]
  );
});
