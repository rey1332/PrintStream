# Developing ETNA locally

How to run ETNA on a developer machine, make changes, and test them. Putting
ETNA on servers is a separate guide: [INSTALL-SERVER.md](INSTALL-SERVER.md)
(Indonesian).

Commands are for **PowerShell** in the project folder unless noted.

## 1. Requirements

- **Node.js 24 LTS** (the version CI uses).
- **PostgreSQL 18** for running the app. Any port works; the examples use the
  default 5432. Tests do **not** need it: they use an in-memory PostgreSQL
  (`@electric-sql/pglite`).
- Keep the project in a plain local folder (for example `C:\ETNA`), not in
  OneDrive or another synced folder: `.env.local` holds keys, and sync clients
  fight with `node_modules` and `.next`.

```powershell
npm ci
```

## 2. One-time database setup

### 2a. Owner role and database

In pgAdmin (Query Tool, as `postgres`) run **one line at a time**. pgAdmin
wraps several lines in one transaction, and `CREATE DATABASE` cannot run
inside one.

```sql
CREATE ROLE etna_owner LOGIN CREATEROLE PASSWORD 'choose-a-strong-password';
```
```sql
CREATE DATABASE etna OWNER etna_owner;
```

`etna_owner` is not a superuser. Only if you will import data with
`scripts/db/transfer.mjs` (section 7) also run
`GRANT SET ON PARAMETER session_replication_role TO etna_owner;`.

### 2b. Schema, app roles and `.env.local`

```powershell
$s = Read-Host "etna_owner password" -AsSecureString
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
$env:MIGRATION_DATABASE_URL = "postgres://etna_owner@localhost:5432/etna"
node scripts/setup-local.mjs
```

This applies `db/bootstrap` and every file in `db/migrations`, gives the
`etna_app` and `etna_auth` roles random passwords, and writes `.env.local`
(app connections, `MFA_ENCRYPTION_KEY`, `SESSION_HINT_SECRET`). All settings
are described in [CONFIGURATION.md](CONFIGURATION.md).

One database and one `.env.local` belong together. A `.env.local` copied from
another machine will not work against a new database; `setup-local.mjs`
refuses to overwrite one unless you pass `--force` (which also makes a new
`MFA_ENCRYPTION_KEY`, so only use it while nobody has two-factor enrolled).

### 2c. First account

There is no self sign-up.

```powershell
$env:ADMIN_DATABASE_URL = $env:MIGRATION_DATABASE_URL
node scripts/admin/users.mjs create-user --email you@example.com --name "Your Name"
```

The temporary password is shown once. Change it after signing in under
**ERP → Settings → Change password**.

## 3. Running the app

| Command | What it does |
|---|---|
| `npm run dev` | Development server with hot reload on <http://localhost:4028/erp/login> |
| `npm run build` then `npm start` | Production build, served on 127.0.0.1:4028 only |
| <http://localhost:4028/api/health> | `200` with `"database":"ok"` when the app reaches PostgreSQL |

Both servers listen on 127.0.0.1 only. Do not change that to reach ETNA from
another device; use a tunnel or a reverse proxy as in INSTALL-SERVER.md.

`NEXT_PUBLIC_ERP_WORKSPACES` is read at build time: rebuild after changing it.

## 4. Checks before you push

| Command | Runs |
|---|---|
| `npm run type-check` | TypeScript (`tsc --noEmit`) |
| `npm run test:unit` | Unit tests (`tests/unit`) |
| `npm run test:db` | Database tests against in-memory PostgreSQL (`tests/db`): every migration, RLS, functions, auth |
| `node tests/i18n/scan.mjs` | Finds UI text that is not translated |
| `npm run i18n:tables` | After editing `src/lib/i18n/messages`: writes the browser's per-language tables (`src/lib/i18n/tables`). A page loads only its language's table (`src/lib/i18n/source.client.ts`); the server reads the messages themselves. `npm run test:unit` fails while the tables are out of date |
| `npm run format:check` | Prettier on `src/` |
| `npm run lint` | ESLint (Next.js rules) |
| `npm run check` | Type-check, all tests, i18n scan and format check together |
| `npm run verify` | Everything CI ran: `check`, lint, a production build and `npm audit` for critical issues. **Run it before every release** |

The GitHub repository was removed in October 2026, so
[.github/workflows/ci.yml](../../.github/workflows/ci.yml) no longer runs
anywhere. `npm run verify` runs the same steps locally; nothing else checks
a change before it is released.

## 5. Changing the database

Every schema change is a new, additive migration plus a rollback script:

```powershell
npm run db:new -- short_name
```

This creates `db/migrations/<timestamp>_short_name.sql` and
`db/rollback/rollback_<timestamp>_short_name.sql`, named to sort after every
existing migration.

Rules the runner (`scripts/db/migrator.mjs`) enforces:

- **Never edit a migration that has been applied anywhere**, including
  `db/bootstrap/0000_postgres_bootstrap.sql`. The runner stores a checksum of
  each applied file and stops if one changed. Fix mistakes with a new
  migration.
- A pending file that sorts before one already applied is refused.
- Nothing is granted by default. Grant `EXECUTE` on functions the app calls
  explicitly, and add them to `tests/db/securityHardening.test.mjs`.
- The runner refuses to bootstrap a Supabase database.

Apply pending migrations to your local database:

```powershell
$env:MIGRATION_DATABASE_URL = "postgres://etna_owner@localhost:5432/etna"   # plus PGPASSWORD
npm run db:migrate              # or: npm run db:migrate -- --dry-run
```

Release order for staging and production: [OPERATIONS.md](OPERATIONS.md)
section 2.

## 6. Accounts and local backups

`scripts/admin/users.mjs` (with `ADMIN_DATABASE_URL` = the owner, plus
`PGPASSWORD`):

| Task | Command |
|---|---|
| List accounts | `node scripts/admin/users.mjs list` |
| New account | `node scripts/admin/users.mjs create-user --email … --name "…"` |
| New temporary password (ends all sessions) | `node scripts/admin/users.mjs set-password --email …` |
| Sign out everywhere | `node scripts/admin/users.mjs revoke-sessions --email …` |
| Lost phone, no recovery codes | `node scripts/admin/users.mjs reset-mfa --email …` |
| Lock / unlock | `node scripts/admin/users.mjs lock --email …` / `unlock --email …` |

The same actions exist as SQL functions (`etna_admin.create_user(...)` and so
on), listed in INSTALL-SERVER.md section 12.

On a developer machine you may enable the in-app backup and account pages:

```powershell
npm run db:backup -- setup     # asks for the owner password, backup folder and admin e-mails
npm run db:backup -- backup    # one backup now
npm run db:backup -- list
npm run db:backup -- restore <file name>   # replaces the whole database; asks for RESTORE
```

`setup` stores the owner password in this Windows user's
`%APPDATA%\postgresql\pgpass.conf` and adds `ETNA_BACKUP_DATABASE_URL`,
`ETNA_BACKUP_DIR` and `ETNA_ADMIN_EMAILS` to `.env.local`. Production servers
deliberately do not do this (see CONFIGURATION.md).

## 7. Copying data between ETNA databases

`scripts/db/transfer.mjs` exports a database to an encrypted folder, imports
it into an **empty** ETNA database and compares both. It runs as the owner on
both sides (password via `PGPASSWORD`).

```powershell
$env:ETNA_TRANSFER_PASSPHRASE = "<long secret sentence, at least 16 characters>"
$env:SOURCE_DATABASE_URL = "postgres://etna_owner@OLD-HOST:PORT/etna"
node scripts/db/transfer.mjs export --out C:\etna-export

$env:MIGRATION_DATABASE_URL = "postgres://etna_owner@NEW-HOST:PORT/etna"
$env:MFA_ENCRYPTION_KEY = "<MFA_ENCRYPTION_KEY of the OLD .env.local>"
node scripts/db/transfer.mjs import --in C:\etna-export

$env:TARGET_DATABASE_URL = $env:MIGRATION_DATABASE_URL
node scripts/db/transfer.mjs reconcile
Remove-Item -Recurse -Force C:\etna-export
```

- The new `.env.local` must use the **old** `MFA_ENCRYPTION_KEY`, or enrolled
  authenticators stop working.
- `import` refuses a target that already has users; `reconcile` must show
  `equal = true` for every table. Users sign in again once.
- Copy the documents folder (`storage/documents` or `ETNA_DOCUMENTS_DIR`) as
  well; the database holds only document names and checksums.
- The export side can also read from the old Supabase project (see
  [BACKEND_MIGRATION.md](BACKEND_MIGRATION.md)).

## 8. Project layout

| Path | Contents |
|---|---|
| `src/app` | Next.js App Router: pages (`/`, `/login`, `/mfa`, `/erp/**`) and API routes (`/api/**`) |
| `src/server` | Server-only code: auth, data layer (`/api/data` executor with RLS), backup, currency, ontology, console |
| `src/lib` | Shared client/server code: data client, i18n, analytics, workflow engine, currency, UI mode |
| `src/components` | Shared React components |
| `src/middleware.ts` | Redirects signed-out visitors to the login pages |
| `db/bootstrap` | Roles and the `auth` schema for plain PostgreSQL (applied first, once) |
| `db/migrations`, `db/rollback` | Schema history and the matching rollback scripts |
| `scripts/db` | Migration runner, new-migration helper, backup, transfer |
| `scripts/admin` | Account administration (command line and the in-app page) |
| `scripts/server` | Windows server scripts: app service, database backup, Caddy config |
| `scripts/setup-local.mjs` | First-time schema + app roles + `.env.local` |
| `tests/unit`, `tests/db`, `tests/i18n` | Tests (Node test runner) |
| `public` | Static files (logo, favicon) |
| `storage` | Runtime data, not in Git: uploaded documents, logs, local backups |

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `password authentication failed for user "etna_app"` | `.env.local` does not match this database. For a new, empty database: rerun `node scripts/setup-local.mjs --force` (with `MIGRATION_DATABASE_URL` and `PGPASSWORD`), then create a user again. |
| `role "etna_app" does not exist` | Setup was never run on this database (section 2b). |
| `ConfigError: DATABASE_URL is not set` | No `.env.local` in the project folder. |
| `/api/health` shows `"database":"unreachable"` | PostgreSQL is stopped, the port in `.env.local` is wrong, or the logins no longer match. |
| `Applied migrations changed on disk` | An applied migration file was edited. Restore it from Git and put the change in a new migration. |
| `Read-Host` / `$env:` lines fail | You are in cmd, not PowerShell. In cmd use `set NAME=value`. |
| Pages break after pulling new code | Apply new migrations (section 5). |
