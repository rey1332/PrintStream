import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv, updateEnv, safeValue } from '../../scripts/server/lib/envfile.mjs';
import { paths, rootProblem, versionFolder } from '../../scripts/server/lib/layout.mjs';
import { newBackupKeys, passphraseOpens, seal, unseal } from '../../scripts/server/lib/sealed.mjs';
import { backupsToPrune, fullBackupName, listFullBackups, migrationGap } from '../../scripts/server/lib/archive.mjs';
import { backupTaskXml, serverTaskXml } from '../../scripts/server/lib/sys.mjs';
import { TEXTS, setLanguage, t } from '../../scripts/server/lib/text.mjs';
import { clusterPort, configureCluster, listenAddresses } from '../../scripts/server/lib/postgres.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const serverDir = path.resolve(here, '../../scripts/server');

test('env files: values are read as written, updates keep comments and never duplicate keys', () => {
  const text = '# ETNA\r\nA=1\r\nURL=postgres://u:p=q@h:5432/db?sslmode=verify-full&x=y\r\nB=2\r\nA=3\r\n';
  assert.deepEqual(parseEnv(text), { A: '3', URL: 'postgres://u:p=q@h:5432/db?sslmode=verify-full&x=y', B: '2' });
  const updated = updateEnv(text, { A: 'new', B: null, C: 'c' });
  assert.equal(updated, '# ETNA\r\nA=new\r\nURL=postgres://u:p=q@h:5432/db?sslmode=verify-full&x=y\r\nC=c\r\n');
  assert.equal(safeValue('a\nB=1'), false);
  assert.equal(safeValue('base64+/=='), true);
});

test('data root: a real folder on a drive, never a drive, Windows or Program Files', () => {
  assert.equal(rootProblem('D:\\ETNA'), null);
  assert.equal(rootProblem('D:\\Company Data\\ETNA'), null);
  assert.equal(rootProblem('D:\\'), 'root_is_drive');
  assert.equal(rootProblem('ETNA'), 'root_not_absolute');
  assert.equal(rootProblem('\\\\server\\share\\ETNA'), 'root_not_absolute');
  assert.equal(rootProblem('C:\\Program Files\\ETNA'), 'root_system_folder');
  assert.equal(rootProblem('C:\\Windows\\ETNA'), 'root_system_folder');
  assert.equal(rootProblem('D:\\ET%NA%'), 'root_bad_chars');
  const p = paths('D:\\ETNA', 'E:\\ETNA-backups');
  assert.equal(p.pgData, path.join('D:\\ETNA', 'postgres', 'data'));
  assert.equal(p.fullBackups, path.join('E:\\ETNA-backups', 'full'));
  assert.equal(paths('D:\\ETNA').backups, path.join('D:\\ETNA', 'backups'));
  assert.equal(versionFolder({ version: '0.1.0', builtAt: '2026-10-08T09:30:12.345Z' }), 'etna-0.1.0-2026-10-08T0930');
});

test('backup secrets: sealed with the public key, opened only with the passphrase', () => {
  assert.throws(() => newBackupKeys('short'), /at least 12/);
  const keys = newBackupKeys('correct horse battery');
  const secret = 'MFA_ENCRYPTION_KEY=abc\r\nSESSION_HINT_SECRET=def\r\n';
  const sealed = seal(secret, keys.publicKey);
  assert.ok(!sealed.includes('abc'));
  assert.equal(unseal(sealed, keys.privateKey, 'correct horse battery'), secret);
  assert.throws(() => unseal(sealed, keys.privateKey, 'wrong passphrase!'), /wrong_passphrase/);
  const tampered = JSON.parse(sealed);
  tampered.data = Buffer.from('x'.repeat(40)).toString('base64');
  assert.throws(() => unseal(JSON.stringify(tampered), keys.privateKey, 'correct horse battery'), /damaged/);
  assert.equal(passphraseOpens(keys.privateKey, 'correct horse battery'), true);
  assert.equal(passphraseOpens(keys.privateKey, 'nope nope nope'), false);
  assert.match(keys.privateKey, /ENCRYPTED PRIVATE KEY/);
});

test('full backups: names, listing, pruning per kind, and migration gaps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etna-full-'));
  try {
    const names = [
      fullBackupName(new Date(2026, 9, 1, 2, 0, 0), 'auto'),
      fullBackupName(new Date(2026, 9, 2, 2, 0, 0), 'auto'),
      fullBackupName(new Date(2026, 9, 3, 2, 0, 0), 'auto'),
      fullBackupName(new Date(2026, 9, 3, 9, 0, 0)),
      fullBackupName(new Date(2026, 9, 3, 10, 0, 0), 'before-update'),
    ];
    assert.equal(names[3], 'etna-full-20261003-090000.tar.gz');
    for (const n of [...names, 'other.tar.gz', 'etna-20261003-090000.dump']) fs.writeFileSync(path.join(dir, n), 'x');
    const list = listFullBackups(dir);
    assert.deepEqual(list.map((b) => b.label), ['before-update', 'manual', 'auto', 'auto', 'auto']);
    assert.deepEqual(backupsToPrune(list, 2), [names[0]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(migrationGap(['m/1', 'm/2', 'm/3'], ['m/1', 'm/2']), ['m/3']);
  assert.deepEqual(migrationGap(['m/1'], ['m/1', 'm/2']), []);
});

test('scheduled tasks: paths are escaped, the server task has no time limit, times are checked', () => {
  const xml = serverTaskXml({ node: 'C:\\Program Files\\nodejs\\node.exe', runner: 'D:\\R&D\\app\\current\\scripts\\server\\run.mjs', root: 'D:\\R&D', workDir: 'D:\\R&D\\app\\current' });
  assert.match(xml, /<Command>C:\\Program Files\\nodejs\\node.exe<\/Command>/);
  assert.match(xml, /R&amp;D/);
  assert.ok(!/R&D/.test(xml));
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<BootTrigger>/);
  assert.match(xml, /<LogonType>Password<\/LogonType>/);
  const backup = backupTaskXml({ node: 'n.exe', manager: 'm.mjs', root: 'D:\\ETNA', workDir: 'D:\\ETNA', time: '02:30' });
  assert.match(backup, /T02:30:00/);
  assert.match(backup, /backup --auto --root &quot;D:\\ETNA&quot;/);
  assert.throws(() => backupTaskXml({ node: 'n', manager: 'm', root: 'r', workDir: 'w', time: '25:00' }), /HH:MM/);
});

test('texts: both languages have the same keys, and every key the manager uses exists', () => {
  const en = Object.keys(TEXTS.en).sort();
  const id = Object.keys(TEXTS.id).sort();
  assert.deepEqual(id, en);
  const source = fs.readFileSync(path.join(serverDir, 'manager.mjs'), 'utf8');
  const used = new Set([...source.matchAll(/\bt\('([a-z][\w.-]*)'/g)].map((m) => m[1]));
  for (const m of source.matchAll(/'(menu\.[a-z]+)'/g)) used.add(m[1]);
  const health = fs.readFileSync(path.join(serverDir, 'lib', 'health.mjs'), 'utf8');
  for (const m of health.matchAll(/\b(ok|warn|fail)\(G\d, '([\w.]+)'/g)) {
    used.add(m[2]);
    if (m[1] !== 'ok') {
      used.add(`${m[2]}.problem`);
      used.add(`${m[2]}.fix`);
    }
  }
  const layout = fs.readFileSync(path.join(serverDir, 'lib', 'layout.mjs'), 'utf8');
  for (const m of layout.matchAll(/'(root_[a-z_]+)'/g)) used.add(m[1]);
  const companies = fs.readFileSync(path.join(serverDir, 'lib', 'companies.mjs'), 'utf8');
  for (const m of companies.matchAll(/'(root_[a-z_]+|cs.[a-z]+)'/g)) used.add(m[1]);
  for (const g of ['machine', 'postgres', 'app', 'config']) used.add(`group.${g}`);
  for (const part of ['database', 'settings', 'files']) used.add(`backup.part.${part}`);
  for (const label of ['manual', 'auto', 'before-restore', 'before-update']) used.add(`label.${label}`);
  const missing = [...used].filter((k) => !(k in TEXTS.en));
  assert.deepEqual(missing, []);
  setLanguage('id');
  assert.equal(t('started', { port: 4028 }), 'ETNA berjalan (http://127.0.0.1:4028).');
  setLanguage('en');
  assert.equal(t('nope.key', {}, 'fallback'), 'fallback');
});

test('PostgreSQL settings: localhost and the port are appended once, the last setting wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etna-pgconf-'));
  try {
    fs.writeFileSync(path.join(dir, 'postgresql.conf'), "#listen_addresses = 'localhost'\nport = 5432\nmax_connections = 100\n");
    configureCluster(dir, 5433);
    configureCluster(dir, 5434);
    const text = fs.readFileSync(path.join(dir, 'postgresql.conf'), 'utf8');
    assert.equal(text.split('ETNA (ETNA-SETUP.bat)').length, 2);
    assert.equal(clusterPort(dir), 5434);
    assert.equal(listenAddresses(dir), 'localhost');
    fs.appendFileSync(path.join(dir, 'postgresql.conf'), "listen_addresses = '*'\n");
    assert.equal(listenAddresses(dir), '*');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('company folders: shared defaults, an assigned folder, and ETNA\'s own folders refused', async () => {
  const { companyLocations, folderName, companyFolderProblem } = await import('../../scripts/server/lib/companies.mjs');
  const ws = '11111111-2222-3333-4444-555555555555';
  const shared = companyLocations('D:\\ETNA', ws, null);
  assert.equal(shared.documents, path.join('D:\\ETNA', 'documents', ws));
  assert.equal(shared.imports, path.join('D:\\ETNA', 'companies', ws, 'imports'));
  const own = companyLocations('D:\\ETNA', ws, 'E:\\ETNAStorage\\PT Batu');
  assert.equal(own.documents, path.join('E:\\ETNAStorage\\PT Batu', 'documents'));
  assert.equal(own.tmp, path.join('E:\\ETNAStorage\\PT Batu', 'tmp'));
  assert.equal(folderName('PT. Batu: Jaya / Tbk.'), 'PT. Batu Jaya Tbk');
  assert.equal(companyFolderProblem('E:\\ETNAStorage\\PT Batu', 'D:\\ETNA'), null);
  assert.equal(companyFolderProblem('D:\\ETNA\\companies\\x', 'D:\\ETNA'), null);
  assert.equal(companyFolderProblem('D:\\ETNA\\postgres\\x', 'D:\\ETNA'), 'cs.reserved');
  assert.equal(companyFolderProblem('D:\\ETNA', 'D:\\ETNA'), 'cs.reserved');
  assert.equal(companyFolderProblem('E:\\', 'D:\\ETNA'), 'root_is_drive');
  // The app resolves the same places.
  const { companyFolder } = await import('../../src/server/documents/storage.ts');
  const before = process.env.ETNA_DATA_ROOT;
  process.env.ETNA_DATA_ROOT = 'D:\\ETNA';
  try {
    assert.equal(companyFolder(ws, null, 'imports'), shared.imports);
    assert.equal(companyFolder(ws, 'E:\\ETNAStorage\\PT Batu', 'documents'), own.documents);
  } finally {
    if (before === undefined) delete process.env.ETNA_DATA_ROOT;
    else process.env.ETNA_DATA_ROOT = before;
  }
});

test('etna.bat: the one launcher at the root, CRLF, and a bootstrap Windows PowerShell 5.1 reads as UTF-8', () => {
  const root = path.resolve(serverDir, '..', '..');
  const launchers = fs.readdirSync(root).filter((n) => /\.(bat|cmd)$/i.test(n));
  assert.deepEqual(launchers, ['etna.bat']);
  const bat = fs.readFileSync(path.join(root, 'etna.bat'), 'utf8');
  assert.equal(bat.replace(/\r\n/g, '').includes('\n'), false);
  assert.match(bat, /bootstrap\.ps1/);
  const boot = fs.readFileSync(path.join(serverDir, 'bootstrap.ps1'));
  // Without a BOM, Windows PowerShell 5.1 reads the file as ANSI and breaks on non-ASCII text.
  assert.deepEqual([...boot.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = boot.toString('utf8');
  assert.match(text, /\$PgSha256 = '[0-9a-f]{64}'/);
  assert.match(text, /\$PgUrl = "https:\/\/get\.enterprisedb\.com\//);
  // Never a password or a machine-wide policy change in the bootstrap.
  assert.doesNotMatch(text, /Set-ExecutionPolicy|PGPASSWORD|superpassword|ConvertTo-SecureString/i);
});

test('data root: never the source or package folder, inside it, or around it', async () => {
  const { appFolderProblem } = await import('../../scripts/server/lib/layout.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'etna-root-'));
  try {
    const source = path.join(base, 'ETNA');
    fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), '{}');
    const pkgApp = path.join(base, 'dist', 'ETNA-1', 'app');
    fs.mkdirSync(pkgApp, { recursive: true });
    fs.writeFileSync(path.join(base, 'dist', 'ETNA-1', 'etna.bat'), '');
    assert.equal(appFolderProblem(source, source), 'root_is_app');
    assert.equal(appFolderProblem(path.join(source, 'data'), source), 'root_is_app');
    assert.equal(appFolderProblem(base, source), 'root_is_app');
    assert.equal(appFolderProblem(path.join(base, 'dist', 'ETNA-1'), pkgApp), 'root_is_app');
    assert.equal(appFolderProblem(path.join(base, 'ETNA-Server'), pkgApp), null);
    assert.equal(appFolderProblem(path.join(base, 'ETNA-Server'), source), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
