import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSql, splitStatements, statementAt, toCsv, toTsv } from '../../src/lib/terminal/sqlText.ts';

test('statements split at semicolons outside quotes, comments and dollar quotes', () => {
  const doc = `select 'a;b' as x; -- one; two
select "c;d" from t;
/* not; here /* nested; */ still */ select $$x;y$$, $f$;$f$;
select 4`;
  assert.deepEqual(
    splitStatements(doc).map((s) => s.text),
    [
      `select 'a;b' as x`,
      `-- one; two\nselect "c;d" from t`,
      `/* not; here /* nested; */ still */ select $$x;y$$, $f$;$f$`,
      'select 4',
    ]
  );
  // Places in the document, for running and marking errors.
  const [first] = splitStatements('  select 1 ;');
  assert.deepEqual([first.from, first.to], [2, 10]);
  assert.deepEqual(splitStatements(' ; -- only a comment\n;'), []);
});

test('the statement under the cursor', () => {
  const doc = 'select 1;\nselect 2;\n\nselect 3';
  assert.equal(statementAt(doc, 3).text, 'select 1');
  assert.equal(statementAt(doc, 12).text, 'select 2');
  // Just after a statement's semicolon: still that one.
  assert.equal(statementAt(doc, 19).text, 'select 2');
  assert.equal(statementAt(doc, doc.length).text, 'select 3');
  assert.equal(statementAt('   ', 1), null);
});

test('copying and saving results keeps NULL apart from empty text in CSV', () => {
  assert.equal(
    toTsv(
      ['a', 'b'],
      [
        [1, null],
        ['x\ty', ''],
      ]
    ),
    'a\tb\n1\t\nx y\t'
  );
  assert.equal(
    toCsv(
      ['a', 'b'],
      [
        [null, ''],
        ['he said "hi"', 'a,b'],
      ]
    ),
    'a,b\r\n,""\r\n"he said ""hi""","a,b"'
  );
});

test('format lays a query out: clauses, lists, conditions and joins on their own lines', () => {
  const sql =
    "select id, name, count(*) as n from customers c left join invoices i on i.customer_id = c.id and i.status = 'paid' where c.city = 'Bekasi' and i.total between 1 and 10 group by id, name order by n desc limit 10;";
  assert.equal(
    formatSql(sql),
    [
      'SELECT',
      '  id,',
      '  name,',
      '  count(*) AS n',
      'FROM',
      '  customers c',
      '  LEFT JOIN invoices i ON i.customer_id = c.id',
      "    AND i.status = 'paid'",
      'WHERE',
      "  c.city = 'Bekasi'",
      '  AND i.total BETWEEN 1 AND 10',
      'GROUP BY',
      '  id,',
      '  name',
      'ORDER BY',
      '  n DESC',
      'LIMIT 10;',
    ].join('\n')
  );
  // Formatting what is formatted changes nothing.
  assert.equal(formatSql(formatSql(sql)), formatSql(sql));
});

test('format indents subqueries and keeps window clauses on their line', () => {
  assert.equal(
    formatSql('select * from (select a from t where a > 1) s where s.a::int = 2'),
    ['SELECT', '  *', 'FROM', '  (', '    SELECT', '      a', '    FROM', '      t', '    WHERE', '      a > 1', '  ) s', 'WHERE', '  s.a::int = 2'].join('\n')
  );
  assert.equal(
    formatSql('select sum(total) over (partition by customer_id order by issue_date) from invoices union all select 1'),
    ['SELECT', '  sum(total) OVER (PARTITION BY customer_id ORDER BY issue_date)', 'FROM', '  invoices', 'UNION ALL', 'SELECT', '  1'].join('\n')
  );
});

test('format never changes quoted text, names or comments', () => {
  const sql = String.raw`select E'a\'b  c', 'it''s  x', $f$ keep  this $f$, "Mixed  Case" -- a note, select
from t /* where  here */`;
  const out = formatSql(sql);
  for (const part of [String.raw`E'a\'b  c'`, "'it''s  x'", '$f$ keep  this $f$', '"Mixed  Case"', '-- a note, select', '/* where  here */'])
    assert.ok(out.includes(part), part);
  // The line comment still ends its line.
  assert.match(out, /-- a note, select\nFROM/);
});
