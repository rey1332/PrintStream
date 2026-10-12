import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// PrintStream is the product, ETNA the company (decision R-01). User-facing
// texts never call the product "ETNA ERP" or by its old taglines; internal
// identifiers (etna_* roles, ETNA_* settings, ETNA-XXXXX codes) are not texts.
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const OLD = [/ETNA ERP\b/, /Enterprise Analytics Platform/, /ETNA Developer Console/, /\bETNA Console\b/, /Data Integrated ERP/];

test('UI texts and page metadata use the PrintStream name', () => {
  const files = [
    ...fs.readdirSync(path.join(root, 'src/lib/i18n/messages')).map((f) => path.join('src/lib/i18n/messages', f)),
    'src/app/layout.tsx',
    'src/components/ui/DevConsole.tsx',
    'src/components/ui/devConsoleChat.ts',
    'src/server/mail/mailer.ts',
  ];
  const hits = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const pattern of OLD) if (pattern.test(text)) hits.push(`${rel}: ${pattern}`);
  }
  assert.deepEqual(hits, []);
  assert.match(fs.readFileSync(path.join(root, 'src/app/layout.tsx'), 'utf8'), /title: 'PrintStream'/);
});

test('the company stays ETNA where it acts as the company', () => {
  const messages = fs.readFileSync(path.join(root, 'src/lib/i18n/messages/governanceShared.ts'), 'utf8');
  assert.match(messages, /ETNA staff/);
  const common = fs.readFileSync(path.join(root, 'src/lib/i18n/messages/common.ts'), 'utf8');
  assert.match(common, /PrintStream · by ETNA/);
});
