import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../../db/migrations');

export function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema extensions;
create extension pgcrypto with schema extensions;
create schema auth;
create table auth.users (
  id uuid primary key, instance_id uuid, aud text, role text, email text, encrypted_password text,
  email_confirmed_at timestamptz, created_at timestamptz, updated_at timestamptz,
  raw_user_meta_data jsonb, raw_app_meta_data jsonb, is_sso_user bool, is_anonymous bool,
  confirmation_token text, confirmation_sent_at timestamptz, recovery_token text, recovery_sent_at timestamptz,
  email_change_token_new text, email_change text, email_change_sent_at timestamptz,
  email_change_token_current text, email_change_confirm_status int, reauthentication_token text,
  reauthentication_sent_at timestamptz, phone text, phone_change text, phone_change_token text,
  phone_change_sent_at timestamptz
);
create table auth.mfa_factors (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, friendly_name text,
  factor_type text not null default 'totp', status text not null default 'unverified',
  created_at timestamptz default now(), updated_at timestamptz default now()
);
-- As on Supabase: the legacy per-claim setting, else the claims JSON.
create function auth.uid() returns uuid language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                     (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema auth, public, extensions to anon, authenticated;
grant execute on all functions in schema auth to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export async function createDb(options = {}) {
  const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
  if ((options.target ?? 'postgres') === 'postgres') {
    const { listMigrations, migrate } = await import('../../scripts/db/migrator.mjs');
    const migrations = listMigrations().filter(
      (m) => !options.through || m.name.startsWith('bootstrap/') || path.basename(m.name).slice(0, options.through.length) <= options.through
    );
    await migrate({ exec: (sql) => db.exec(sql), query: (sql, params) => db.query(sql, params) }, { migrations });
    return db;
  }
  await db.exec(SUPABASE_STUBS);
  await applyMigrations(db, { through: options.through });
  return db;
}

export async function applyMigrations(db, { after, through } = {}) {
  // `after` / `through` are timestamp prefixes such as '20260925050000'.
  for (const file of migrationFiles()) {
    if (after && file.slice(0, after.length) <= after) continue;
    if (through && file.slice(0, through.length) > through) break;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${error.message}`);
    }
  }
}

let userCounter = 0;

export async function createUser(db, name) {
  userCounter += 1;
  const id = (await db.query('select gen_random_uuid() as id')).rows[0].id;
  const email = `${name}.${userCounter}@example.test`;
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, jsonb_build_object('full_name', $3::text))`,
    [id, email, name]
  );
  return { id, email, name };
}

export async function asUser(db, user, fn) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user.id]);
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      // `user.aal` simulates a session after (aal2) or before (aal1) the second factor.
      // Two-factor by default: Owners, Admins and Finance of shared ERPs need it
      // (20261012000022); tests of the first step pass aal: 'aal1'.
      JSON.stringify({ sub: user.id, email: user.email, role: 'authenticated', aal: user.aal ?? 'aal2' }),
    ]);
    const q = async (sql, params = []) => (await tx.query(sql, params)).rows;
    return fn(q);
  });
}

export async function run(db, user, sql, params = []) {
  return asUser(db, user, (q) => q(sql, params));
}

export async function runOnPath(db, user, path, sql, params = []) {
  return asUser(db, user, async (q) => {
    await q(`select set_config('request.path', $1, true)`, [path]);
    return q(sql, params);
  });
}

export async function admin(db, sql, params = []) {
  return (await db.query(sql, params)).rows;
}

export async function expectError(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    if (pattern && !pattern.test(error.message)) {
      throw new Error(`Expected error matching ${pattern}, got: ${error.message}`);
    }
    return error;
  }
  throw new Error(`Expected an error matching ${pattern}, but the call succeeded`);
}

export function items(...lines) {
  return JSON.stringify(
    lines.map(([product_id, qty, price = 10]) => ({ product_id, qty, price, product_name: '' }))
  );
}
