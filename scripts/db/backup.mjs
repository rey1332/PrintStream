#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import pg from 'pg';
import {
  ROOT,
  backup,
  backupIfDue,
  config,
  listBackups,
  loadEnvFile,
  parseUrl,
  pgpassPath,
  restore,
  upsertPgpass,
} from './backup-core.mjs';

loadEnvFile();
const [command = 'backup', ...rest] = process.argv.slice(2).filter((a) => a !== '--json' && a !== '--yes');
const json = process.argv.includes('--json');
const out = (data, text) => console.log(json ? JSON.stringify(data) : text);

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Echo nothing while the password is typed.
      rl._writeToOutput = (s) => {
        if (s.includes(question)) process.stdout.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function setEnv(values) {
  const file = path.join(ROOT, '.env.local');
  let lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const at = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

async function setup() {
  const current = config();
  const fallback = process.env.MIGRATION_DATABASE_URL || 'postgres://etna_owner@localhost:3000/etna';
  const urlInput = (await ask(`Owner connection without password [${current.url || fallback.replace(/:[^:@/]*@/, '@')}]: `)) || current.url || fallback;
  const url = new URL(urlInput);
  url.password = '';
  const target = parseUrl(url.toString());
  const password = await ask(`Password for ${target.user} (not shown): `, { hidden: true });
  if (!password) throw new Error('No password given. Nothing was changed.');

  // Check before writing anything.
  // Separate fields: with a connection string, its (empty) password wins over `password`.
  const client = new pg.Client({
    host: target.host,
    port: Number(target.port),
    database: target.database,
    user: target.user,
    password,
  });
  await client.connect();
  await client.query('select 1');
  await client.end();

  const dir = (await ask(`Backup folder [${current.dir}]: `)) || current.dir;
  const admins = (await ask(`E-mail addresses that may back up and restore in the app (comma separated) [${process.env.ETNA_ADMIN_EMAILS || ''}]: `))
    || process.env.ETNA_ADMIN_EMAILS || '';

  const pgpass = pgpassPath();
  fs.mkdirSync(path.dirname(pgpass), { recursive: true });
  const existing = fs.existsSync(pgpass) ? fs.readFileSync(pgpass, 'utf8') : '';
  fs.writeFileSync(pgpass, upsertPgpass(existing, { ...target, password }), { mode: 0o600 });
  fs.mkdirSync(path.resolve(dir), { recursive: true });
  setEnv({
    ETNA_BACKUP_DATABASE_URL: url.toString(),
    ETNA_BACKUP_DIR: path.resolve(dir),
    ETNA_ADMIN_EMAILS: admins.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).join(','),
  });
  console.log(`Saved the password in ${pgpass} (only for this ${process.platform === 'win32' ? 'Windows' : 'system'} user).`);
  console.log('Saved the connection (without password), folder and admins in .env.local.');
  console.log('Restart ETNA so the app sees the new settings. Migrations no longer need PGPASSWORD.');
}

function needConfig() {
  const cfg = config();
  if (!cfg.configured) {
    throw new Error('Backups are not set up. Run: npm run db:backup -- setup');
  }
  return cfg;
}

try {
  if (command === 'setup') {
    await setup();
  } else if (command === 'list') {
    const cfg = config();
    const backups = listBackups(cfg.dir);
    out({ ok: true, configured: cfg.configured, dir: cfg.dir, backups },
      backups.length ? backups.map((b) => `${b.name}  ${(b.size / 1048576).toFixed(1)} MB`).join('\n') : 'No backups yet.');
  } else if (command === 'auto') {
    // For a scheduled task (e.g. hourly): quiet until backups are set up.
    if (!config().configured) {
      out({ ok: true, backup: null, configured: false }, 'Backups are not set up.');
      process.exit(0);
    }
    const made = await backupIfDue(needConfig());
    out({ ok: true, backup: made }, made ? `Backed up to ${made.name}` : 'The last backup is less than a day old.');
  } else if (command === 'backup') {
    const made = await backup(needConfig(), 'manual');
    out({ ok: true, backup: made }, `Backed up to ${made.name}`);
  } else if (command === 'restore') {
    const name = rest[0];
    if (!json && !process.argv.includes('--yes')) {
      const answer = await ask(`This replaces EVERYTHING in the database with ${name}. Type RESTORE to continue: `);
      if (answer !== 'RESTORE') throw new Error('Not confirmed. Nothing was changed.');
    }
    const result = await restore(needConfig(), name);
    out({ ok: true, ...result }, `Restored ${result.restored}. The previous state is in ${result.safetyBackup}.`);
  } else {
    throw new Error(`Unknown command ${command}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(message);
  process.exitCode = 1;
}
