import { test } from 'node:test';
import assert from 'node:assert/strict';

const { importKindOf } = await import('../../src/server/terminal/service.ts');

test('new uploads: CSV files only', () => {
  assert.equal(importKindOf('ritase.csv'), 'csv');
  assert.equal(importKindOf('RITASE.CSV'), 'csv');
  for (const name of ['data.xlsx', 'data.tsv', 'data.txt', 'data.csv.exe', 'csv', 'data.xls'])
    assert.equal(importKindOf(name), null, name);
});
