#!/usr/bin/env node
// The browser's message tables: one file per language (src/lib/i18n/tables),
// made from the messages in src/lib/i18n/messages. A page loads only the
// table of its language (src/lib/i18n/source.client.ts) instead of every
// string in three languages. A missing translation is the English text.
//
//   npm run i18n:tables            writes the tables (after editing messages)
//   npm run i18n:tables -- --check  fails when they are out of date (npm test does this too)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TABLES_DIR = path.join(ROOT, 'src', 'lib', 'i18n', 'tables');
// The table's file name, by the message's column.
export const TABLE_FILES = { en: 'en.json', id: 'id.json', zh: 'zh-CN.json' };

/** One file's text: sorted keys, one per line, so a change is a one-line diff. */
export function tableText(messages, column) {
  const keys = Object.keys(messages).sort();
  const lines = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(messages[k][column] || messages[k].en)}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

export function buildTables(messages) {
  return Object.fromEntries(Object.entries(TABLE_FILES).map(([column, file]) => [file, tableText(messages, column)]));
}

async function main() {
  const { messages } = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'i18n', 'messages', 'index.ts')).href);
  const tables = buildTables(messages);
  const check = process.argv.includes('--check');
  const stale = [];
  for (const [file, text] of Object.entries(tables)) {
    const target = path.join(TABLES_DIR, file);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
    if (current === text) continue;
    stale.push(file);
    if (!check) {
      fs.mkdirSync(TABLES_DIR, { recursive: true });
      fs.writeFileSync(target, text);
    }
  }
  if (check && stale.length) {
    console.error(`Out of date: ${stale.join(', ')}. Run: npm run i18n:tables`);
    process.exit(1);
  }
  console.log(check ? 'The message tables are up to date.' : stale.length ? `Wrote ${stale.join(', ')}.` : 'Nothing changed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
