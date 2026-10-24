import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { messages } from '../../src/lib/i18n/messages/index.ts';
import { TABLES_DIR, TABLE_FILES, buildTables } from '../../scripts/i18n/tables.mjs';
import * as server from '../../src/lib/i18n/source.server.ts';
import { translate } from '../../src/lib/i18n/translate.ts';

test('the browser message tables match the messages (npm run i18n:tables after editing them)', () => {
  for (const [file, text] of Object.entries(buildTables(messages))) {
    const current = fs.readFileSync(path.join(TABLES_DIR, file), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(current === text, `${file} is out of date: run npm run i18n:tables`);
  }
});

test('each table has every key, a missing translation as the English text', () => {
  const keys = Object.keys(messages);
  for (const [column, file] of Object.entries(TABLE_FILES)) {
    const table = JSON.parse(fs.readFileSync(path.join(TABLES_DIR, file), 'utf8'));
    assert.equal(Object.keys(table).length, keys.length, file);
    for (const k of keys) assert.equal(table[k], messages[k][column] || messages[k].en, `${file} ${k}`);
  }
});

test('translate reads every language on the server', () => {
  assert.equal(translate('id', 'common.cancel'), messages['common.cancel'].id);
  assert.equal(translate('zh-CN', 'common.cancel'), messages['common.cancel'].zh);
  assert.equal(translate('en', 'no.such.key'), 'no.such.key');
  assert.equal(server.localeReady('id'), null);
  assert.equal(server.hasText('common.cancel'), true);
});
