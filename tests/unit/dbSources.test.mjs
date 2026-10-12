import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseDbSource,
  readSql,
  sourceSelect,
  quoteIdent,
  columnTypeOf,
  datasetColumns,
  dbSourceLabel,
  isDbName,
} = await import('../../src/lib/terminal/dbSource.ts');
const { pgFailure, openPg, isoTimestamp } = await import('../../src/server/connectors/postgres.ts');
const { later } = await import('../../src/server/terminal/connectorJobs.ts');

test('names are always quoted, so any name is read as a name', () => {
  assert.equal(quoteIdent('orders'), '"orders"');
  assert.equal(quoteIdent('a"; drop table x; --'), '"a""; drop table x; --"');
  assert.equal(
    sourceSelect({ mode: 'table', schema: 'Sales', table: 'Order "lines"' }),
    'SELECT * FROM "Sales"."Order ""lines"""'
  );
  assert.ok(isDbName('pesanan_penjualan'));
  assert.ok(!isDbName(''));
  assert.ok(!isDbName('x'.repeat(64)));
  assert.ok(!isDbName('a\u0000b'));
});

test('sources are checked; a query loses its closing semicolon', () => {
  assert.deepEqual(
    parseDbSource({ mode: 'table', schema: 'public', table: 't', key: '', changed: null }),
    {
      mode: 'table',
      schema: 'public',
      table: 't',
      key: null,
      changed: null,
    }
  );
  assert.equal(parseDbSource({ mode: 'query', sql: '  select 1 ;  ' }).sql, 'select 1');
  assert.equal(parseDbSource({ mode: 'query', sql: ' ; ' }), null);
  assert.equal(parseDbSource({ mode: 'query', sql: 'x'.repeat(20_001) }), null);
  assert.equal(parseDbSource({ mode: 'table', schema: 'public' }), null);
  assert.equal(parseDbSource({ mode: 'exec', sql: 'select 1' }), null);
  assert.equal(parseDbSource({ mode: 'table', schema: 'public', table: 't', key: 5 }), null);
  assert.equal(
    dbSourceLabel({ mode: 'table', schema: 'public', table: 'orders' }),
    'public.orders'
  );
  assert.equal(dbSourceLabel({ mode: 'query', sql: 'select\n  1' }), 'select 1');
});

test('reads: everything, or rows changed since a value (a parameter, never pasted in)', () => {
  const s = { mode: 'table', schema: 'public', table: 'orders', key: 'id', changed: 'updated_at' };
  assert.equal(
    readSql(s, false),
    'SELECT * FROM (SELECT * FROM "public"."orders") AS src ORDER BY src."updated_at"'
  );
  assert.equal(
    readSql(s, true),
    'SELECT * FROM (SELECT * FROM "public"."orders") AS src WHERE src."updated_at" >= $1 ORDER BY src."updated_at"'
  );
  assert.equal(
    readSql({ mode: 'query', sql: 'select 1 as a' }, true),
    'SELECT * FROM (SELECT * FROM (select 1 as a\n) AS q) AS src'
  );
});

test('PostgreSQL types become dataset types; dataset columns are checked', () => {
  assert.deepEqual([16, 20, 23, 1700, 701, 1082, 1114, 1184, 3802, 25, 2950].map(columnTypeOf), [
    'boolean',
    'integer',
    'integer',
    'decimal',
    'decimal',
    'date',
    'timestamp',
    'timestamp',
    'json',
    'text',
    'text',
  ]);
  const cols = [
    { name: 'id', type: 'integer' },
    { name: 'name', type: 'text' },
    { name: 'updated_at', type: 'timestamp' },
  ];
  assert.deepEqual(datasetColumns(cols, 'id', 'updated_at'), [
    { label: 'id', type: 'integer', key: true },
    { label: 'name', type: 'text' },
    { label: 'updated_at', type: 'timestamp' },
  ]);
  assert.equal(datasetColumns(cols, 'nope', null), null);
  assert.equal(datasetColumns(cols, 'id', 'name'), null, 'a text "changed" column is refused');
  assert.equal(
    datasetColumns([...cols, { name: 'ID', type: 'text' }], null, null),
    null,
    'labels unique ignoring case'
  );
  assert.equal(datasetColumns([{ name: 'x', type: 'blob' }], null, null), null);
  assert.equal(datasetColumns([], null, null), null);
});

test('database errors are reported by kind, without the database’s message', () => {
  const code = (e) => pgFailure(e).code;
  assert.equal(
    code({ code: '28P01', message: 'password authentication failed for user "x"' }),
    'authFailed'
  );
  assert.equal(code({ code: '42P01' }), 'notFoundRemote');
  assert.equal(code({ code: '42501' }), 'remoteForbidden');
  assert.equal(code({ code: '25006' }), 'queryWrites');
  assert.equal(code({ code: '42601' }), 'queryInvalid');
  assert.equal(code({ code: '57014' }), 'timeout');
  assert.equal(code({ code: 'ECONNREFUSED' }), 'remoteDown');
  assert.equal(code({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), 'tlsFailed');
  assert.equal(code({ message: 'The server does not support SSL connections' }), 'tlsUnsupported');
  assert.ok(
    !pgFailure({ code: '22P02', message: 'invalid input syntax: "secret"' }).message.includes(
      'secret'
    )
  );
});

test('the client refuses blocked hosts and unencrypted public servers before connecting', async () => {
  const ctx = (config) => ({ config, secret: { password: 'x' }, privateHosts: [] });
  await assert.rejects(openPg(ctx({ host: '127.0.0.1', database: 'd', username: 'u' })), {
    code: 'hostBlocked',
  });
  await assert.rejects(openPg(ctx({ host: '169.254.169.254', database: 'd', username: 'u' })), {
    code: 'hostBlocked',
  });
  await assert.rejects(openPg(ctx({ host: '10.1.2.3', database: 'd', username: 'u' })), {
    code: 'hostPrivate',
  });
  await assert.rejects(
    openPg(ctx({ host: '8.8.8.8', database: 'd', username: 'u', ssl: 'disable' })),
    { code: 'tlsRequired' }
  );
  await assert.rejects(
    openPg(ctx({ host: '8.8.8.8', database: 'd', username: 'u', ssl: 'verify-ca' })),
    {
      code: 'fieldRequired',
    }
  );
  await assert.rejects(
    openPg(ctx({ host: '8.8.8.8', port: '70000', database: 'd', username: 'u' })),
    {
      code: 'fieldInvalid',
    }
  );
});

test('"changed" values compare as numbers, times or text', () => {
  assert.ok(later('10', '9'));
  assert.ok(later('2026-10-02T00:00:00Z', '2026-10-01T23:00:00Z'));
  assert.ok(!later('2026-10-01', '2026-10-02'));
  assert.ok(later('b', 'a'));
  assert.ok(later('1', null));
  assert.ok(later('9007199254740993', '9007199254740992'), 'big integers stay exact');
});

test('timestamps come out as ISO 8601, whatever pg does globally', () => {
  assert.equal(isoTimestamp('2026-10-01 08:00:00+07'), '2026-10-01T08:00:00+07:00');
  assert.equal(
    isoTimestamp('2026-10-01 08:00:00.123456-03:30'),
    '2026-10-01T08:00:00.123456-03:30'
  );
  assert.equal(isoTimestamp('2026-10-01 08:00:00'), '2026-10-01T08:00:00');
  assert.equal(isoTimestamp('infinity'), 'infinity');
});
