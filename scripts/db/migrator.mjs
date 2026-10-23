import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const BOOTSTRAP_DIR = path.join(root, 'db/bootstrap');
export const MIGRATIONS_DIR = path.join(root, 'db/migrations');

export function checksum(sql) {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export function listMigrations({ bootstrapDir = BOOTSTRAP_DIR, migrationsDir = MIGRATIONS_DIR } = {}) {
  const read = (dir, prefix) =>
    fs.readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => {
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        return { name: `${prefix}/${file}`, sql, checksum: checksum(sql) };
      });
  return [...read(bootstrapDir, 'bootstrap'), ...read(migrationsDir, 'migrations')];
}

export async function looksLikeSupabase(client) {
  const { rows } = await client.query(
    `select exists (select 1 from pg_roles where rolname in ('supabase_admin', 'supabase_auth_admin', 'authenticator'))
         or to_regclass('auth.flow_state') is not null
         or to_regclass('auth.identities') is not null as supabase`
  );
  return rows[0]?.supabase === true;
}

async function ensureMetaTable(client) {
  // Own schema, not `public`: the default privileges there would expose it.
  await client.exec(`
    CREATE SCHEMA IF NOT EXISTS etna_meta;
    REVOKE ALL ON SCHEMA etna_meta FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS etna_meta.schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export function plan(migrations, applied) {
  const appliedByName = new Map(applied.map((row) => [row.name, row.checksum]));
  const changed = migrations.filter((m) => appliedByName.has(m.name) && appliedByName.get(m.name) !== m.checksum);
  const pending = migrations.filter((m) => !appliedByName.has(m.name));
  const lastApplied = applied
    .map((row) => row.name)
    .filter((name) => name.startsWith('migrations/'))
    .sort()
    .at(-1);
  const outOfOrder = lastApplied
    ? pending.filter((m) => m.name.startsWith('migrations/') && m.name < lastApplied)
    : [];
  return { pending, changed, outOfOrder, lastApplied };
}

// Several app servers may update at once (psctl cluster): one migrates at a
// time, the others wait and then find nothing left to apply.
const MIGRATION_LOCK = 7428190351;

export async function migrate(client, options = {}) {
  if (options.dryRun) return migrateLocked(client, options);
  await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
  try {
    return await migrateLocked(client, options);
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
  }
}

async function migrateLocked(client, { dryRun = false, log = () => {}, migrations = listMigrations() } = {}) {
  if (await looksLikeSupabase(client)) {
    throw new Error('This database is a Supabase project. The plain-PostgreSQL bootstrap must not be applied to it.');
  }
  if (!dryRun) await ensureMetaTable(client);
  const { rows: applied } = dryRun && !(await metaTableExists(client))
    ? { rows: [] }
    : await client.query('select name, checksum from etna_meta.schema_migrations');
  const { pending, changed, outOfOrder, lastApplied } = plan(migrations, applied);
  if (changed.length > 0) {
    throw new Error(`Applied migrations changed on disk: ${changed.map((m) => m.name).join(', ')}`);
  }
  if (outOfOrder.length > 0) {
    throw new Error(
      `Migrations sort before ${lastApplied}, which is already applied: ${outOfOrder.map((m) => m.name).join(', ')}. ` +
      'Rename them so they sort last (npm run db:new -- <name> picks the next name). Nothing was changed.'
    );
  }
  if (dryRun) return pending.map((m) => m.name);

  const done = [];
  for (const migration of pending) {
    log(`applying ${migration.name}`);
    await client.exec('BEGIN');
    try {
      await client.exec(migration.sql);
      await client.query('insert into etna_meta.schema_migrations (name, checksum) values ($1, $2)', [migration.name, migration.checksum]);
      await client.exec('COMMIT');
    } catch (error) {
      await client.exec('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${migration.name} failed: ${error.message}`);
    }
    done.push(migration.name);
  }
  return done;
}

async function metaTableExists(client) {
  const { rows } = await client.query(`select to_regclass('etna_meta.schema_migrations') is not null as present`);
  return rows[0]?.present === true;
}
