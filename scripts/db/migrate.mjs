#!/usr/bin/env node

import pg from 'pg';
import { migrate } from './migrator.mjs';
import { NO_OWNER, loadOwnerUrl } from './owner.mjs';

const dryRun = process.argv.includes('--dry-run');
// MIGRATION_DATABASE_URL, else the owner connection saved in .env.local.
const url = loadOwnerUrl();
if (!url) {
  console.error(NO_OWNER);
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
const adapter = {
  exec: (sql) => client.query(sql),
  query: (sql, params) => client.query(sql, params),
};

try {
  await client.connect();
  const names = await migrate(adapter, { dryRun, log: (line) => console.log(line) });
  if (names.length === 0) console.log('Database is up to date.');
  else console.log(`${dryRun ? 'Pending' : 'Applied'}: ${names.length} migration(s)${dryRun ? `\n  ${names.join('\n  ')}` : ''}`);
} catch (error) {
  // Messages come from PostgreSQL or the runner; they do not contain the URL.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
