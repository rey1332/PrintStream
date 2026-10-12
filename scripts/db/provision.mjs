// Prepares an ETNA database for the app, as its schema owner: applies the
// migrations and gives the app's two login roles (etna_app, etna_auth) and the
// TERMINAL worker's (etna_worker) new random passwords. Shared by scripts/setup-local.mjs and etna.bat
// (scripts/server/manager.mjs).

import { randomBytes } from 'node:crypto';
import { migrate } from './migrator.mjs';

/** Runs the migrations; returns the app connection strings with new passwords. */
export async function provision(client, ownerUrl, { log = () => {} } = {}) {
  const applied = await migrate(
    { exec: (sql) => client.query(sql), query: (sql, params) => client.query(sql, params) },
    { log }
  );
  const urls = {};
  for (const role of ['etna_app', 'etna_auth', 'etna_worker']) urls[role] = await newLogin(client, ownerUrl, role);
  return { applied, DATABASE_URL: urls.etna_app, AUTH_DATABASE_URL: urls.etna_auth, WORKER_DATABASE_URL: urls.etna_worker };
}

/** Gives a login role a new random password; returns its connection string. */
export async function newLogin(client, ownerUrl, role) {
  const password = randomBytes(24).toString('base64url');
  // ALTER ROLE cannot take a bind parameter; format(%L) quotes the literal safely.
  const { rows } = await client.query(`select format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) as sql`, [role, password]);
  await client.query(rows[0].sql);
  const u = new URL(ownerUrl);
  u.username = role;
  u.password = password;
  return u.toString();
}

/** The two app secrets: two-factor encryption key and session hint secret. */
export function newAppKeys() {
  return {
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SESSION_HINT_SECRET: randomBytes(32).toString('base64url'),
  };
}
