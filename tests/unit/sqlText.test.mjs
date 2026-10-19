import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitStatements, statementAt, toCsv, toTsv } from '../../src/lib/terminal/sqlText.ts';

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
