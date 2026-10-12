#!/usr/bin/env node
// Account administration as the schema owner (ADMIN_DATABASE_URL):
//
//   list
//   create-user     --email a@b.com [--name "Ana"] [--password-stdin]
//   set-password    --email a@b.com [--password-stdin]   (ends all sessions)
//   revoke-sessions --email a@b.com
//   reset-mfa       --email a@b.com                      (ends all sessions)
//   lock            --email a@b.com [--until 2027-01-01] (ends all sessions)
//   unlock          --email a@b.com
//   list-admins
//   grant-admin     --email a@b.com [--role super_admin|support|auditor]
//   revoke-admin    --email a@b.com
//
// Without --password-stdin a random temporary password is shown once. Every
// change is recorded in the security log (etna_platform.security_events) in
// the same transaction, with the database role that made it.

import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const [command, ...rest] = process.argv.slice(2);
const options = {};
for (let i = 0; i < rest.length; i += 1) {
  const key = rest[i];
  if (!key.startsWith('--')) continue;
  const next = rest[i + 1];
  if (next === undefined || next.startsWith('--')) options[key.slice(2)] = true;
  else { options[key.slice(2)] = next; i += 1; }
}

function usage(message) {
  if (message) console.error(message);
  console.error('Commands: list | create-user | set-password | revoke-sessions | reset-mfa | lock | unlock | list-admins | grant-admin | revoke-admin  (see the header of this file)');
  process.exit(2);
}

const url = process.env.ADMIN_DATABASE_URL;
if (!url) usage('Set ADMIN_DATABASE_URL (schema owner). Nothing was changed.');
if (!command) usage();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function email() {
  const value = typeof options.email === 'string' ? options.email.trim() : '';
  if (!EMAIL.test(value)) usage('Give a valid --email.');
  return value;
}

async function readPassword() {
  if (!options['password-stdin']) return { password: randomBytes(12).toString('base64url'), generated: true };
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (password.length < 10) usage('Passwords need at least 10 characters.');
  return { password, generated: false };
}

const client = new pg.Client({ connectionString: url, application_name: 'etna-users-cli' });

// One security-log entry, inside the command's transaction.
const logEvent = (type, address, metadata = {}) =>
  client.query('select etna_admin.log_event($1, $2, $3)', [type, address, JSON.stringify(metadata)]);

async function userId(address) {
  const { rows } = await client.query('select id from auth.users where lower(email) = lower($1)', [address]);
  if (!rows[0]) throw new Error(`No account for ${address}`);
  return rows[0].id;
}

async function main() {
  await client.connect();
  switch (command) {
    case 'list': {
      const { rows } = await client.query(
        `select u.email, u.created_at, u.last_sign_in_at, u.banned_until,
                (select count(*) from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified')::int as devices,
                (select count(*) from auth.sessions s where s.user_id = u.id and s.revoked_at is null and s.expires_at > now())::int as sessions
           from auth.users u order by u.created_at`
      );
      console.table(rows.map((r) => ({
        email: r.email,
        created: new Date(r.created_at).toISOString().slice(0, 10),
        lastSignIn: r.last_sign_in_at ? new Date(r.last_sign_in_at).toISOString().slice(0, 16) : '',
        locked: r.banned_until && new Date(r.banned_until) > new Date() ? 'yes' : '',
        devices2fa: r.devices,
        sessions: r.sessions,
      })));
      break;
    }
    case 'create-user': {
      const address = email();
      const { password, generated } = await readPassword();
      const hash = await bcrypt.hash(password, 12);
      const name = typeof options.name === 'string' ? options.name.slice(0, 120) : address.split('@')[0];
      await client.query('begin');
      await client.query(
        `insert into auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
         values ($1, $2, jsonb_build_object('full_name', $3::text), now())`,
        [address, hash, name]
      );
      await logEvent('USER_CREATED', address, { temporary_password: generated });
      await client.query('commit');
      console.log(`Created ${address}.`);
      if (generated) console.log(`Temporary password (shown once): ${password}`);
      break;
    }
    case 'set-password': {
      const address = email();
      const id = await userId(address);
      const { password, generated } = await readPassword();
      await client.query('begin');
      await client.query('update auth.users set encrypted_password = $2, updated_at = now() where id = $1', [id, await bcrypt.hash(password, 12)]);
      const { rowCount: ended } = await client.query('update auth.sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      await logEvent('ADMIN_PASSWORD_SET', address, { temporary_password: generated, sessions_ended: ended });
      await client.query('commit');
      console.log(`Password changed for ${address}; all sessions ended.`);
      if (generated) console.log(`Temporary password (shown once): ${password}`);
      break;
    }
    case 'revoke-sessions': {
      const address = email();
      const id = await userId(address);
      await client.query('begin');
      const { rowCount } = await client.query('update auth.sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      await logEvent('SESSIONS_REVOKED', address, { sessions_ended: rowCount });
      await client.query('commit');
      console.log(`Ended ${rowCount} session(s).`);
      break;
    }
    case 'reset-mfa': {
      const address = email();
      const id = await userId(address);
      await client.query('begin');
      const { rowCount: devices } = await client.query('delete from auth.mfa_factors where user_id = $1', [id]);
      await client.query(`delete from public.erp_mfa_recovery_codes where user_id = $1`, [id]).catch(() => {});
      await client.query('update auth.sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      await logEvent('MFA_RESET', address, { devices_removed: devices });
      await client.query('commit');
      console.log(`Removed ${devices} authenticator(s) for ${address}; recovery codes and sessions cleared.`);
      console.log('Confirm the person\'s identity out of band before doing this, and write down who asked and how they were verified.');
      break;
    }
    case 'lock': {
      const address = email();
      const id = await userId(address);
      const until = typeof options.until === 'string' ? new Date(options.until) : new Date('9999-12-31T00:00:00Z');
      if (Number.isNaN(until.getTime())) usage('Give --until as an ISO date.');
      await client.query('begin');
      await client.query('update auth.users set banned_until = $2 where id = $1', [id, until.toISOString()]);
      await client.query('update auth.sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      await logEvent('USER_DISABLED', address, { until: until.toISOString() });
      await client.query('commit');
      console.log(`Locked until ${until.toISOString()}; sessions ended.`);
      break;
    }
    case 'unlock': {
      const address = email();
      const id = await userId(address);
      await client.query('begin');
      await client.query('update auth.users set banned_until = null where id = $1', [id]);
      await logEvent('USER_ENABLED', address);
      await client.query('commit');
      console.log('Unlocked.');
      break;
    }
    case 'list-admins': {
      const { rows } = await client.query(
        `select u.email, a.role, a.granted_at,
                exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified') as two_factor
           from etna_platform.admins a join auth.users u on u.id = a.user_id order by a.role, u.email`
      );
      console.table(rows.map((r) => ({
        email: r.email,
        role: r.role,
        since: new Date(r.granted_at).toISOString().slice(0, 10),
        twoFactor: r.two_factor ? 'yes' : 'NO — cannot use /admin yet',
      })));
      break;
    }
    case 'grant-admin': {
      const address = email();
      const role = typeof options.role === 'string' ? options.role : 'super_admin';
      if (!['super_admin', 'support', 'auditor'].includes(role)) usage('Give --role super_admin, support or auditor.');
      await client.query('select etna_admin.grant_platform_admin($1, $2)', [address, role]);
      console.log(`${address} is now ${role}. They need two-factor turned on to open /admin.`);
      break;
    }
    case 'revoke-admin': {
      const address = email();
      const { rows } = await client.query('select etna_admin.revoke_platform_admin($1) as removed', [address]);
      console.log(rows[0].removed ? `${address} is no longer an admin.` : `${address} was not an admin.`);
      break;
    }
    default:
      usage(`Unknown command: ${command}`);
  }
}

try {
  await main();
} catch (error) {
  await client.query('rollback').catch(() => {});
  // PostgreSQL / script messages only; they do not contain the connection URL.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
