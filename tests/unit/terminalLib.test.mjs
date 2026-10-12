import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRun, scheduleProblem } from '../../src/lib/terminal/schedule.ts';
import {
  CsvParser,
  analyzeRows,
  coerce,
  decodeBytes,
  detectDelimiter,
  inferType,
  parseCsv,
  parseNumber,
} from '../../src/lib/terminal/tabular.ts';

const JKT = 'Asia/Jakarta';
const at = (iso) => new Date(iso);

test('schedules: daily, weekly, monthly and cron in the schedule time zone', () => {
  // 02:00 in Jakarta is 19:00 UTC the day before.
  assert.equal(nextRun({ kind: 'daily', spec: { at: '02:00' }, timezone: JKT }, at('2026-10-09T10:00:00Z')).toISOString(), '2026-10-09T19:00:00.000Z');
  assert.equal(nextRun({ kind: 'daily', spec: { at: '02:00' }, timezone: JKT }, at('2026-10-09T19:00:00Z')).toISOString(), '2026-10-10T19:00:00.000Z');
  // 2026-10-09 is a Friday; Mondays at 07:30 local.
  assert.equal(nextRun({ kind: 'weekly', spec: { days: [1], at: '07:30' }, timezone: JKT }, at('2026-10-09T00:00:00Z')).toISOString(), '2026-10-12T00:30:00.000Z');
  // The 31st in a 30-day month runs on the 30th.
  assert.equal(nextRun({ kind: 'monthly', spec: { day: 31, at: '00:00' }, timezone: 'UTC' }, at('2026-11-01T00:00:00Z')).toISOString(), '2026-11-30T00:00:00.000Z');
  assert.equal(nextRun({ kind: 'cron', spec: { expr: '15 */6 * * 1-5' }, timezone: 'UTC' }, at('2026-10-09T13:00:00Z')).toISOString(), '2026-10-09T18:15:00.000Z');
  assert.equal(nextRun({ kind: 'interval', spec: { minutes: 30 }, timezone: JKT }, at('2026-10-09T10:07:30Z')).toISOString(), '2026-10-09T10:37:00.000Z');
});

test('schedules: problems are named; too frequent is refused', () => {
  assert.equal(scheduleProblem({ kind: 'interval', spec: { minutes: 1 }, timezone: JKT }), 'interval');
  assert.equal(scheduleProblem({ kind: 'daily', spec: { at: '25:00' }, timezone: JKT }), 'time');
  assert.equal(scheduleProblem({ kind: 'weekly', spec: { days: [], at: '01:00' }, timezone: JKT }), 'days');
  assert.equal(scheduleProblem({ kind: 'cron', spec: { expr: '* * * * *' }, timezone: JKT }), 'cron');
  assert.equal(scheduleProblem({ kind: 'cron', spec: { expr: '0 0 31 2' }, timezone: JKT }), 'cron');
  assert.equal(scheduleProblem({ kind: 'daily', spec: { at: '01:00' }, timezone: 'Mars/Olympus' }), 'timezone');
  assert.equal(scheduleProblem({ kind: 'cron', spec: { expr: '*/5 * * * *' }, timezone: JKT }), null);
});

test('CSV: quotes, doubled quotes, line breaks inside quotes, any chunking', () => {
  const text = 'a,b,c\r\n"x, y","say ""hi""","line\nbreak"\n1,,3';
  const whole = parseCsv(text, ',');
  assert.deepEqual(whole, [['a', 'b', 'c'], ['x, y', 'say "hi"', 'line\nbreak'], ['1', '', '3']]);
  for (let size = 1; size <= 7; size += 1) {
    const p = new CsvParser(',');
    const rows = [];
    for (let i = 0; i < text.length; i += size) rows.push(...p.push(text.slice(i, i + size)));
    rows.push(...p.end());
    assert.deepEqual(rows, whole, `chunks of ${size}`);
  }
  assert.throws(() => parseCsv('"open', ','), /unclosed_quote/);
});

test('detection: delimiter, encoding, decimal mark, header and types', () => {
  assert.equal(detectDelimiter('kode;tonase;tanggal\nA1;12,5;09/10/2026\nA2;8;10/10/2026'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2'), '\t');
  assert.equal(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])).text, 'a');
  assert.equal(decodeBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9])).encoding, 'windows-1252');
  const rows = parseCsv('Kode;Tonase;Tanggal;NIK;Aktif\nA1;1.234,5;09/10/2026;0321010101;ya\nA2;8;10/10/2026;0321010102;tidak', ';');
  const a = analyzeRows(rows);
  assert.equal(a.header, true);
  assert.equal(a.decimal, ',');
  assert.deepEqual(a.columns.map((c) => c.type), ['text', 'decimal', 'date', 'text', 'boolean']);
  assert.equal(a.preview.length, 2);
  assert.equal(parseNumber('Rp 1.250.000', ','), 1250000);
  assert.equal(parseNumber('(1,234.50)', '.'), -1234.5);
  assert.equal(parseNumber('1.2.3', '.'), null);
  assert.equal(inferType(['1', '2', '3'], '.'), 'integer');
});

test('coercion: typed values or a reason', () => {
  assert.deepEqual(coerce('12,5', 'decimal', ','), { ok: true, value: 12.5 });
  assert.deepEqual(coerce('abc', 'decimal', '.'), { ok: false, reason: 'bad_number' });
  assert.deepEqual(coerce('31/02/2026', 'date', '.'), { ok: false, reason: 'bad_date' });
  assert.deepEqual(coerce('2026-10-09 08:30', 'timestamp', '.'), { ok: true, value: '2026-10-09T08:30:00+07:00' });
  assert.deepEqual(coerce('', 'integer', '.'), { ok: true, value: null });
  assert.deepEqual(coerce(3.5, 'integer', '.'), { ok: false, reason: 'bad_integer' });
  assert.deepEqual(coerce('{"a":1}', 'json', '.'), { ok: true, value: { a: 1 } });
});
