import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bundleName,
  bundlesToPrune,
  filesUnder,
  listBundles,
  readBundle,
  readHeader,
  safeEntryName,
  writeBundle,
} from '../../scripts/db/offsite-core.mjs';
import { newBackupKeys } from '../../scripts/server/lib/sealed.mjs';

const PASSPHRASE = 'correct horse battery staple';
const keys = newBackupKeys(PASSPHRASE);
const opts = { publicKey: keys.publicKey, privateKeyEncrypted: keys.privateKey, info: { appVersion: '0.1.0' } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'etna-offsite-'));

function sampleFiles() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'documents', 'ws-1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'documents', 'ws-1', 'invoice.pdf'), crypto.randomBytes(200_000));
  fs.writeFileSync(path.join(dir, 'documents', 'empty.txt'), '');
  fs.writeFileSync(path.join(dir, 'database.dump'), crypto.randomBytes(70_000));
  return dir;
}

test('a bundle round-trips: every entry restored byte for byte, with its manifest', async () => {
  const src = sampleFiles();
  const target = path.join(tmp(), bundleName(new Date('2026-10-15T02:30:00')));
  const entries = [
    { name: 'database.dump', file: path.join(src, 'database.dump') },
    ...filesUnder(path.join(src, 'documents'), 'files/documents'),
    { name: 'settings/etna.env', data: 'MFA_ENCRYPTION_KEY=abc\n' },
  ];
  const written = await writeBundle(target, entries, opts);
  assert.equal(written.entries.length, 4);
  assert.equal(written.appVersion, '0.1.0');

  // Nothing readable without the passphrase: no file contents, no settings.
  const raw = fs.readFileSync(target);
  assert.ok(!raw.includes(Buffer.from('MFA_ENCRYPTION_KEY')));
  assert.ok(!raw.includes(fs.readFileSync(path.join(src, 'database.dump')).subarray(0, 64)));
  assert.equal(readHeader(target).header.format, 'etna-offsite-1');

  const out = path.join(tmp(), 'restored');
  const manifest = await readBundle(target, PASSPHRASE, { into: out });
  assert.deepEqual(manifest.entries, written.entries);
  assert.deepEqual(
    fs.readFileSync(path.join(out, 'files', 'documents', 'ws-1', 'invoice.pdf')),
    fs.readFileSync(path.join(src, 'documents', 'ws-1', 'invoice.pdf'))
  );
  assert.equal(fs.readFileSync(path.join(out, 'files', 'documents', 'empty.txt'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(out, 'settings', 'etna.env'), 'utf8'), 'MFA_ENCRYPTION_KEY=abc\n');
  assert.ok(fs.existsSync(path.join(out, 'manifest.json')));
  // Verify only (no folder): same checks.
  assert.equal((await readBundle(target, PASSPHRASE)).entries.length, 4);
});

test('a wrong passphrase, a changed byte or a cut file is refused, and nothing is left behind', async () => {
  const src = sampleFiles();
  const target = path.join(tmp(), 'b.etnabak');
  await writeBundle(target, [{ name: 'database.dump', file: path.join(src, 'database.dump') }], opts);
  await assert.rejects(readBundle(target, 'not the passphrase'), /wrong_passphrase/);

  const header = readHeader(target).offset;
  for (const [label, change] of [
    ['a byte in the middle', (b) => (b[header + 5000] ^= 1)],
    ['the tag', (b) => (b[b.length - 1] ^= 1)],
  ]) {
    const bytes = fs.readFileSync(target);
    change(bytes);
    const bad = path.join(tmp(), 'bad.etnabak');
    fs.writeFileSync(bad, bytes);
    const out = path.join(tmp(), 'out');
    await assert.rejects(readBundle(bad, PASSPHRASE, { into: out }), /damaged/, label);
    assert.ok(!fs.existsSync(out) && !fs.existsSync(`${out}.partial`), `${label}: nothing restored`);
  }
  const cut = path.join(tmp(), 'cut.etnabak');
  fs.writeFileSync(cut, fs.readFileSync(target).subarray(0, header + 1000));
  await assert.rejects(readBundle(cut, PASSPHRASE), /damaged/);
  const notOne = path.join(tmp(), 'x.etnabak');
  fs.writeFileSync(notOne, 'hello');
  await assert.rejects(readBundle(notOne, PASSPHRASE), /not_a_bundle/);
});

test('entry names stay inside the restore folder', () => {
  for (const ok of ['database.dump', 'files/documents/a b/c.pdf']) assert.equal(safeEntryName(ok), true, ok);
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'C:/x', 'a\\b', 'a/./b', 'x\0y'])
    assert.equal(safeEntryName(bad), false, JSON.stringify(bad));
});

test('names, listing and pruning keep the newest bundles', () => {
  const dir = tmp();
  for (const n of ['etna-offsite-20261013-023000.etnabak', 'etna-offsite-20261014-023000.etnabak', 'etna-offsite-20261015-023000.etnabak', 'other.txt'])
    fs.writeFileSync(path.join(dir, n), 'x');
  const listed = listBundles(dir);
  assert.deepEqual(listed.map((b) => b.name), [
    'etna-offsite-20261015-023000.etnabak',
    'etna-offsite-20261014-023000.etnabak',
    'etna-offsite-20261013-023000.etnabak',
  ]);
  assert.deepEqual(bundlesToPrune(listed, 2), ['etna-offsite-20261013-023000.etnabak']);
  assert.deepEqual(bundlesToPrune(listed, 0), bundlesToPrune(listed, 1), 'the newest is always kept');
  assert.equal(bundleName(new Date(2026, 9, 15, 2, 30, 5)), 'etna-offsite-20261015-023005.etnabak');
});
