#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsDir = path.join(root, 'db/migrations');
const rollbackDir = path.join(root, 'db/rollback');

const name = (process.argv[2] || '').trim().toLowerCase();
if (!/^[a-z][a-z0-9_]{2,60}$/.test(name)) {
  console.error('Usage: npm run db:new -- <name>   (lower case letters, digits and _; e.g. erp_payroll)');
  process.exit(2);
}

const stamp = (date) => date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
const fromStamp = (s) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`);

const last = fs.readdirSync(migrationsDir).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort().at(-1);
let next = stamp(new Date());
if (last && last.slice(0, 14) >= next) next = stamp(new Date(fromStamp(last.slice(0, 14)).getTime() + 1000));

const file = `${next}_${name}.sql`;
const migration = path.join(migrationsDir, file);
const rollback = path.join(rollbackDir, `rollback_${file}`);

fs.writeFileSync(migration, `-- ${name.replace(/_/g, ' ')}.
--
-- What this changes and why. Grant EXECUTE explicitly on every function
-- clients may call (nothing is granted by default) and add it to the list in
-- tests/db/securityHardening.test.mjs.
--
-- Rollback: db/rollback/rollback_${file}

`, { flag: 'wx' });
fs.writeFileSync(rollback, `-- Rollback for ${file}.
-- Run only after redeploying an app version from before this change.

BEGIN;

COMMIT;
`, { flag: 'wx' });

console.log(`Created db/migrations/${file}`);
console.log(`Created db/rollback/rollback_${file}`);
