# Configuration

ETNA reads its settings from environment variables. On every machine they live
in **`.env.local`** in the app folder, which Next.js loads at start-up and
which Git ignores (`.gitignore`: `.env.*`). [`.env.example`](../.env.example)
is the committed template; it never holds real values.

## Environments

Each environment has its **own** database, roles, passwords and keys. Never
copy `.env.local` from one environment to another, and never point a local or
staging app at the production database.

| | Development | Staging | Production |
|---|---|---|---|
| Machine | developer PC | app server, `C:\ETNA-staging` | app server, `C:\ETNA` |
| App port | 4028 (`npm run dev`) | 4029 (`etna-server.cmd 4029`) | 4028 (`etna-server.cmd`) |
| Reached through | localhost | Caddy, `https://staging.…` | Cloudflare Tunnel, `https://erp.…` |
| Database | local PostgreSQL | DB server, PostgreSQL service on port **5433**, database `etna_staging` | DB server, PostgreSQL service on port **5432**, database `etna` |
| `TRUST_PROXY` | unset | `1` | `cloudflare` |
| DB connection | plain, localhost | TLS, `sslmode=verify-full` | TLS, `sslmode=verify-full` |
| In-app backup + user accounts (`ETNA_BACKUP_*`) | optional | unset | **unset** |
| `.env.local` written by | `scripts/setup-local.mjs` | `scripts/setup-local.mjs` | `scripts/setup-local.mjs` |
| Copy of `.env.local` in a password manager | recommended | yes | **yes** |

Staging and production must run in **separate PostgreSQL services**. The role
names (`etna_app`, `etna_auth`, `anon`, `authenticated`) are fixed in
`db/bootstrap` and roles belong to the whole service, so a second database
in the production service would share, and on setup reset, production's
passwords.

## App settings (`.env.local`)

| Variable | Purpose | Required? | Example format | Where used | Secret? |
|---|---|---|---|---|---|
| `DATABASE_URL` | Connection of the app server role `etna_app`; every request runs as the signed-in user under row-level security | **Yes** | `postgres://etna_app:PW@10.0.0.20:5432/etna?sslmode=verify-full&sslrootcert=C:/ETNA-certs/db-ca.crt` | `src/server/config.ts` | **Yes** (password) |
| `AUTH_DATABASE_URL` | Connection of the sign-in role `etna_auth` (users, sessions, two-factor) | **Yes** | as above, user `etna_auth` | `src/server/config.ts` | **Yes** |
| `WORKER_DATABASE_URL` | Connection of the TERMINAL worker's role `etna_worker` (job queue, dataset tables, imports, schedules). Written by `etna.bat` (also on update) and `scripts/setup-local.mjs` | Yes, for TERMINAL (without it the worker does not start and background jobs wait) | as above, user `etna_worker` | `scripts/server/worker.mjs`, `scripts/server/run.mjs` | **Yes** |
| `ETNA_WORKER_CONCURRENCY` | Jobs the worker runs at once (1–8; one per company at a time) | No (default 2) | `3` | `scripts/server/worker.mjs` | No |
| `MFA_ENCRYPTION_KEY` | AES-256 key that encrypts stored two-factor secrets; TERMINAL connection secrets use a key derived from it. Losing it forces every user to enroll again and every connection to be given its password or key again | **Yes** | 32 random bytes, base64 (44 characters) | `src/server/auth/secret-box.ts`, `scripts/db/transfer.mjs` | **Yes** |
| `SESSION_HINT_SECRET` | Signs the session hint cookie read by the middleware. Changing it signs everyone out | **Yes** | at least 32 random characters | `src/server/config.ts` | **Yes** |
| `TRUST_PROXY` | Which client IP to use for sign-in limits: `1` = last `X-Forwarded-For` entry (behind a proxy that overwrites it, e.g. Caddy), `cloudflare` = `CF-Connecting-IP`. Unset = headers ignored, limits per account | Behind a proxy or tunnel | `1` or `cloudflare` | `src/server/auth/request.ts` | No |
| `NEXT_PUBLIC_ERP_WORKSPACES` | Several ERPs per account, teams, sync between ERPs. **Read at build time** and sent to browsers | No (default on) | `off` | `src/app/erp/lib/workspace.ts`, ERP API routes | No (public) |
| `ETNA_PUBLIC_URL` | The address people open ETNA at, used in password reset and invite links made in `/admin` (docs/ADMIN.md). Unset = the address the admin used | Behind a proxy or tunnel | `https://erp.example.com` | `src/server/admin/request.ts` | No |
| `ETNA_DATA_ROOT` | One folder for everything an installed server keeps (written by `etna.bat`, `deploy/linux/install.sh` and the Docker setup): `documents`, `backups`, `logs` default to folders in it, and the Windows server manager keeps `app`, `config` and `postgres` there (`scripts/server/lib/layout.mjs`) | No (servers installed with `etna.bat` or on Linux) | `D:\ETNA`, `/var/lib/etna`, `/data` (container) | `src/server/documents/storage.ts`, `scripts/db/backup-core.mjs`, `src/server/admin/system.ts`, `scripts/server/` | No |
| `ETNA_HOST`, `ETNA_PORT` | Where the app listens when started by `scripts/server/env-run.mjs` (Linux: systemd units and the container). The service's environment wins over `etna.env` for these two | No (default `127.0.0.1` and `4028`; the container uses `0.0.0.0`) | `127.0.0.1`, `4028` | `scripts/server/env-run.mjs` | No |
| `PGPASSFILE` | PostgreSQL password file for the schema owner (in-app backup). `etna.bat` sets `<ETNA_DATA_ROOT>\config\pgpass.conf` | No (default `%APPDATA%\postgresql\pgpass.conf`) | `D:\ETNA\config\pgpass.conf` | `pg`, `scripts/db/backup-core.mjs` | The file it names holds the owner password |
| `ETNA_DOCUMENTS_DIR` | Folder for uploaded documents | No (default `<ETNA_DATA_ROOT>\documents`, else `storage/documents`) | `D:\etna-documents` | `src/server/documents/storage.ts` | No (but the folder holds business files) |
| `ETNA_BACKUP_DATABASE_URL` | Schema owner connection **without password**, for Settings → Backup and Settings → User accounts. The password is in the Windows user's `pgpass.conf` | No. **Leave unset on servers** | `postgres://etna_owner@localhost:5432/etna` | `scripts/db/backup-core.mjs`, `scripts/admin/users-api.mjs` (started by `src/server/backup.ts`, `src/server/userAdmin.ts`) | Sensitive: grants owner access together with `pgpass.conf` |
| `ETNA_BACKUP_DIR` | Folder for backups (in-app dumps; `etna.bat` full backups go in its `full` subfolder) | No (default `<ETNA_DATA_ROOT>\backups`, else `storage/backups`) | `D:\etna-backup` | `scripts/db/backup-core.mjs` | No (the folder holds the whole database) |
| `ETNA_ADMIN_EMAILS` | Accounts that may use in-app backup/restore and account administration (two-factor required) | Only with `ETNA_BACKUP_DATABASE_URL` | `admin@example.com,ops@example.com` | `src/server/backup.ts`, `src/server/userAdmin.ts` | No |
| `RESEND_API_KEY` | Sends workflow approval e-mails through Resend | No | `re_…` | `src/app/api/erp/workflows/route.ts` | **Yes** |
| `EMAIL_FROM` | Sender of those e-mails (both settings are needed to send) | With `RESEND_API_KEY` | `ETNA <etna@example.com>` | `src/app/api/erp/workflows/route.ts` | No |
| `SMTP_HOST` | Mail server for ETNA's own e-mail: invitation and password links from `/admin`, test e-mails (docs/ADMIN.md). Unset = e-mail off, links are copied by hand | No | `smtp.gmail.com` | `src/server/mail/mailer.ts` | No |
| `SMTP_PORT` | `587` (STARTTLS, default) or `465` (TLS). Plain connections are refused | No | `587` | `src/server/mail/mailer.ts` | No |
| `SMTP_SECURE` | `true` for port 465 | With port 465 | `true` | `src/server/mail/mailer.ts` | No |
| `SMTP_USER` | Mail account name (usually its address) | With most servers | `erp@example.co.id` | `src/server/mail/mailer.ts` | No |
| `SMTP_PASSWORD` | Its password; for Gmail / Google Workspace an *app password* (two-step verification on, then Security → App passwords) | With `SMTP_USER` | 16 characters | `src/server/mail/mailer.ts` | **Yes** |
| `SMTP_FROM` | Sender shown to recipients (default `SMTP_USER`) | No | `ETNA <erp@example.co.id>` | `src/server/mail/mailer.ts` | No |
| `EXCHANGE_RATE_PROVIDER` | `frankfurter` (default) fetches rates on the server; `off` = manual rates only | No | `off` | `src/server/currency/frankfurter.ts` | No |
| `FRANKFURTER_URL` | Frankfurter API address | No | `https://api.frankfurter.dev/v2` | `src/server/currency/frankfurter.ts` | No |
| `FRANKFURTER_PROVIDERS` | Limit to one Frankfurter source instead of blended rates | No | `ECB` | `src/server/currency/frankfurter.ts` | No |
| `DIST_DIR` | Build output folder | No (default `.next`) | `.next-verify` | `next.config.mjs` | No |

`NODE_ENV` is set by Next.js (`next dev` / `next build`); do not set it by
hand.

The app fails at start-up with `ConfigError: … is not set` when a required
setting is missing, and with `MFA_ENCRYPTION_KEY must be 32 bytes` when the key
is malformed.

## Command-line settings (set in the shell, never stored)

| Variable | Purpose | Used by | Secret? |
|---|---|---|---|
| `MIGRATION_DATABASE_URL` | Schema owner (`etna_owner`) connection for migrations and first setup | `npm run db:migrate`, `scripts/setup-local.mjs`, `scripts/db/transfer.mjs import` | No (no password in it) |
| `ADMIN_DATABASE_URL` | Schema owner connection for account administration | `scripts/admin/users.mjs` | No |
| `PGPASSWORD` | The owner's password for that one command window | the scripts above (read by the `pg` driver) | **Yes**: close the window afterwards |
| `PGPASSFILE` | Other location for the PostgreSQL password file | `scripts/db/backup-core.mjs` | No |
| `SOURCE_DATABASE_URL`, `TARGET_DATABASE_URL` | Source and target of a data transfer | `scripts/db/transfer.mjs` | No |
| `ETNA_TRANSFER_PASSPHRASE` | Encrypts a transfer export (at least 16 characters) | `scripts/db/transfer.mjs` | **Yes** |
| `PGBIN` | PostgreSQL `bin` folder if not the default | `scripts/server/etna-db-backup.cmd` | No |

## Database connections across the network

The `pg` driver reads TLS settings from the URL. Use
`sslmode=verify-full&sslrootcert=<path to the server certificate>`, which
encrypts **and** checks that the certificate belongs to that address.
`scripts/setup-local.mjs` copies these parameters from
`MIGRATION_DATABASE_URL` into `DATABASE_URL` and `AUTH_DATABASE_URL`.

- Do not use `sslmode=require` or `no-verify`: the `pg` driver warns that
  `require` will change meaning, and `no-verify` accepts any server.
- In cmd, quote the whole assignment because the URL contains `&`:
  `set "MIGRATION_DATABASE_URL=postgres://…?sslmode=verify-full&sslrootcert=…"`.
- Use forward slashes in `sslrootcert` (`C:/ETNA-certs/db-ca.crt`).

## Why production leaves `ETNA_BACKUP_*` unset

`npm run db:backup -- setup` stores the schema owner's password in
`pgpass.conf` on the machine that runs it, and the app uses that connection for
in-app backup, restore and account creation. On an internet-facing server,
that would let a compromise of the app process act as the owner of the whole
database. Production therefore:

- runs backups **on the database server** (`scripts/server/etna-db-backup.cmd`,
  INSTALL-SERVER.md section 4);
- manages accounts with the `etna_admin.*` SQL functions or
  `scripts/admin/users.mjs` with the password typed per session
  (INSTALL-SERVER.md section 12).

## Rotating secrets

| Secret | How | Effect |
|---|---|---|
| `etna_app` / `etna_auth` password | `ALTER ROLE etna_app PASSWORD '…'` as the owner, update `.env.local`, restart ETNA | none for users |
| `SESSION_HINT_SECRET` | new random value, restart | everyone signs in again |
| `MFA_ENCRYPTION_KEY` | cannot simply be replaced: stored secrets must be re-encrypted, or every user re-enrolls (`reset-mfa`) and every TERMINAL connection gets its secret again | see OPERATIONS.md section 6 |
| `etna_owner` password | `ALTER ROLE etna_owner PASSWORD '…'` as `postgres`, update `pgpass.conf` on the database server (backups) | migrations and account scripts need the new password |
| `RESEND_API_KEY` | new key in Resend, update `.env.local`, restart | none |
