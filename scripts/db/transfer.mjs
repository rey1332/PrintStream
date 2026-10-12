#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import pg from 'pg';
import { looksLikeSupabase } from './migrator.mjs';
import {
  authSummary, decryptBuffer, encryptBuffer, importData, listTables, orphanCheck, readAuth, readTable, tableChecksums,
} from './transfer-core.mjs';

const [command, ...args] = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name}. Nothing was changed.`);
    process.exit(2);
  }
  return value;
}

async function connect(url) {
  const client = new pg.Client({ connectionString: url, application_name: 'etna-transfer' });
  await client.connect();
  // JSON text from PostgreSQL carries the values; keep the driver from reinterpreting dates.
  return client;
}

function sealWith(keyBase64) {
  const key = Buffer.from(keyBase64 || '', 'base64');
  if (key.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes, base64');
  // Same format as src/server/auth/secret-box.ts: v1.<iv>.<tag>.<ciphertext>
  return (plain) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
  };
}

async function exportCommand() {
  const out = option('out');
  if (!out) throw new Error('Give --out <folder> (outside the repository)');
  const passphrase = need('ETNA_TRANSFER_PASSPHRASE');
  const client = await connect(need('SOURCE_DATABASE_URL'));
  try {
    fs.mkdirSync(path.join(out, 'tables'), { recursive: true });
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await listTables(client);
    const manifest = { format: 'etna-transfer-1', exportedAt: new Date().toISOString(), source: (await looksLikeSupabase(client)) ? 'supabase' : 'postgres', tables: {}, auth: null };
    for (const table of tables) {
      const rows = [];
      await readTable(client, table, (batch) => { rows.push(...batch); });
      // JSON Lines of PostgreSQL's own row text (exact numbers), encrypted.
      fs.writeFileSync(path.join(out, 'tables', `${table.name}.jsonl.enc`), encryptBuffer(Buffer.from(rows.join('\n')), passphrase));
      manifest.tables[table.name] = { rows: rows.length, columns: table.columns.map((c) => c.name) };
      console.log(`exported ${table.name}: ${rows.length}`);
    }
    const sums = await tableChecksums(client, tables);
    for (const [name, sum] of Object.entries(sums)) manifest.tables[name].checksum = sum.checksum;
    const auth = await readAuth(client);
    fs.writeFileSync(path.join(out, 'auth.json.enc'), encryptBuffer(Buffer.from(JSON.stringify(auth)), passphrase));
    manifest.auth = { ...(await authSummary(client)), devicesWithSecret: auth.factors.filter((f) => f.status === 'verified' && f.secret).length };
    await client.query('COMMIT');
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`Done: ${tables.length} tables, ${manifest.auth.users} users. Manifest: ${path.join(out, 'manifest.json')}`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function importCommand() {
  const dir = option('in');
  if (!dir) throw new Error('Give --in <folder>');
  const unportableMfa = option('unportable-mfa') ?? 'lock';
  if (!['lock', 'drop'].includes(unportableMfa)) throw new Error('--unportable-mfa must be lock or drop');
  const passphrase = need('ETNA_TRANSFER_PASSPHRASE');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'etna-transfer-1') throw new Error('Unknown export format');
  const auth = JSON.parse(decryptBuffer(fs.readFileSync(path.join(dir, 'auth.json.enc')), passphrase).toString('utf8'));
  const tables = new Map();
  for (const name of Object.keys(manifest.tables)) {
    const text = decryptBuffer(fs.readFileSync(path.join(dir, 'tables', `${name}.jsonl.enc`)), passphrase).toString('utf8');
    tables.set(name, text ? text.split('\n') : []);
  }

  const client = await connect(need('MIGRATION_DATABASE_URL'));
  try {
    if (await looksLikeSupabase(client)) throw new Error('The target is a Supabase project; import only into the new database');
    const report = await importData(client, { auth, tables }, { sealSecret: sealWith(process.env.MFA_ENCRYPTION_KEY), unportableMfa, log: (l) => console.log(l) });
    console.log(JSON.stringify(report, null, 2));

    const orphans = await orphanCheck(client);
    const targetTables = (await listTables(client)).filter((t) => manifest.tables[t.name]);
    const shared = new Map(targetTables.map((t) => [t.name, manifest.tables[t.name].columns.filter((c) => t.columns.some((tc) => tc.name === c))]));
    const sums = await tableChecksums(client, targetTables, shared);
    const mismatches = Object.entries(manifest.tables)
      .filter(([name, m]) => !sums[name] || sums[name].rows !== m.rows || sums[name].checksum !== m.checksum)
      .map(([name, m]) => ({ table: name, sourceRows: m.rows, targetRows: sums[name]?.rows ?? null }));
    if (orphans.length) console.error('Foreign keys pointing nowhere:', JSON.stringify(orphans));
    if (mismatches.length) console.error('Tables that differ from the export:', JSON.stringify(mismatches));
    if (orphans.length || mismatches.length) process.exitCode = 1;
    else console.log(`Import verified: ${Object.keys(manifest.tables).length} tables match the export checksums; no orphaned references.`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function reconcileCommand() {
  const source = await connect(need('SOURCE_DATABASE_URL'));
  const target = await connect(need('TARGET_DATABASE_URL'));
  try {
    const sourceTables = await listTables(source);
    const targetTables = new Map((await listTables(target)).map((t) => [t.name, t]));
    const shared = new Map();
    for (const t of sourceTables) {
      const other = targetTables.get(t.name);
      shared.set(t.name, other ? t.columns.map((c) => c.name).filter((c) => other.columns.some((o) => o.name === c)) : []);
    }
    const a = await tableChecksums(source, sourceTables, shared);
    const b = await tableChecksums(target, sourceTables.filter((t) => targetTables.has(t.name)), shared);
    const rows = sourceTables.map((t) => ({
      table: t.name,
      source: a[t.name].rows,
      target: b[t.name]?.rows ?? 'missing',
      equal: b[t.name] ? a[t.name].checksum === b[t.name].checksum : false,
    }));
    console.table(rows);
    const authA = await authSummary(source);
    const authB = await authSummary(target);
    console.log(`users: ${authA.users} → ${authB.users} (${authA.users_checksum === authB.users_checksum ? 'same ids and emails' : 'DIFFERENT'})`);
    if (rows.some((r) => !r.equal) || authA.users_checksum !== authB.users_checksum) process.exitCode = 1;
  } finally {
    await source.end().catch(() => {});
    await target.end().catch(() => {});
  }
}

try {
  if (command === 'export') await exportCommand();
  else if (command === 'import') await importCommand();
  else if (command === 'reconcile') await reconcileCommand();
  else {
    console.error('Usage: transfer.mjs export --out <dir> | import --in <dir> [--unportable-mfa lock|drop] | reconcile');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
