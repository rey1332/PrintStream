#!/usr/bin/env node
// Account administration for the app's Settings page. Started by
// src/server/userAdmin.ts (never by a user): reads one JSON request on stdin,
// writes one JSON line on stdout.
//
//   { "action": "list" }
//   { "action": "create", "email": "ana@company.com", "name": "Ana" }
//
// Connects as the schema owner with the connection saved by
// `npm run db:backup -- setup` (ETNA_BACKUP_DATABASE_URL; the password stays in
// the PostgreSQL password file) and calls the etna_admin functions from
// db/migrations/20261002000000_admin_user_functions.sql.

import pg from 'pg';
import { config, loadEnvFile } from '../db/backup-core.mjs';

loadEnvFile();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
}

const cfg = config();
if (!cfg.configured) {
  fail('not_configured');
} else {
  const client = new pg.Client({ connectionString: cfg.url, application_name: 'etna-user-admin' });
  try {
    const request = await readRequest();
    await client.connect();
    if (request.action === 'list') {
      const { rows } = await client.query(
        `select email, full_name, created_at, last_sign_in_at, locked, devices_2fa, active_sessions
           from etna_admin.users order by created_at`
      );
      console.log(JSON.stringify({ ok: true, users: rows }));
    } else if (request.action === 'create') {
      const email = typeof request.email === 'string' ? request.email.trim() : '';
      const name = typeof request.name === 'string' ? request.name.trim().slice(0, 120) : '';
      if (!EMAIL.test(email) || email.length > 254) {
        fail('invalid_email');
      } else {
        // The database generates the temporary password, so it never passes
        // through a query text or a log.
        const { rows } = await client.query('select * from etna_admin.create_user($1, $2)', [email, name || null]);
        console.log(JSON.stringify({ ok: true, email: rows[0].email, temporaryPassword: rows[0].temporary_password }));
      }
    } else {
      fail('invalid');
    }
  } catch (error) {
    // 23505 = account already exists; everything else stays out of the answer.
    fail(error && error.code === '23505' ? 'exists' : 'failed');
  } finally {
    await client.end().catch(() => {});
  }
}
