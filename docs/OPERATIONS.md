# ETNA operations runbook

How to run ETNA safely for a real business: environments, releasing database
changes, backups, monitoring, accounts and incidents. ETNA runs on plain
PostgreSQL with its own sign-in (history: docs/BACKEND_MIGRATION.md).
Installing servers, updating and rolling back step by step:
docs/INSTALL-SERVER.md. Local development: docs/DEVELOPMENT.md. Settings:
docs/CONFIGURATION.md.

## 1. Environments

| Environment | Database | App | Purpose |
|---|---|---|---|
| **Local** | in-memory PostgreSQL for tests; a local server for `npm run dev` | `npm run dev` | development |
| **Staging** | own PostgreSQL service (port 5433) on the database server | `C:\ETNA-staging` on the app server, port 4029, behind Caddy | try migrations and releases before production |
| **Production** | PostgreSQL service on port 5432 on the database server | `C:\ETNA` on the app server, port 4028, behind the Cloudflare Tunnel | real data |

- Never point a local or staging app at the production database.
- Each environment has its own roles, passwords, `MFA_ENCRYPTION_KEY` and
  `SESSION_HINT_SECRET` (see docs/CONFIGURATION.md). `.env*` files are not
  committed.
- Staging and production need separate PostgreSQL services, not two databases
  in one: the role names are fixed, and roles are shared by every database of
  a service.

## 2. Releasing changes

Every database change is an additive migration in `db/migrations`, tested by
`npm test` against an in-memory PostgreSQL, with a rollback script in
`db/rollback`. Create both with `npm run db:new -- <name>`: the new file always
sorts after the last migration. The runner refuses a pending file that sorts
before one already applied (a fresh database would apply it in a different
order) and grants nothing by default — grant EXECUTE on client functions
explicitly and list them in `tests/db/securityHardening.test.mjs`.

Order for every release:

1. `npm test`, `npx tsc --noEmit`, `npx next build` pass (CI runs them).
2. Take a backup (section 3).
3. `npm run db:migrate` on **staging** (as the schema owner); run the app
   against staging and check the changed screens.
4. `npm run db:migrate` on **production**. The runner applies each file once,
   in its own transaction, records checksums in `etna_meta.schema_migrations`
   and stops if an applied file was edited.
5. Deploy the app.
6. Watch `/api/health` and error logs for 30 minutes.

Rollback: redeploy the previous app build (`git checkout <previous commit>`,
`npm ci`, `npm run build`, restart). Run a rollback script only if the schema
itself must go back, after the previous app is live, and read its header
first — some remove data that only the new feature used. Rollback scripts do
not touch `etna_meta.schema_migrations`: delete the migration's row there too
(`name = 'migrations/<file>.sql'`), or it will never be applied again.
Commands: docs/INSTALL-SERVER.md sections 14–15.

## 3. Backups and recovery

- Daily `pg_dump -Fc` of the database, run on the database server by
  `scripts/server/etna-db-backup.cmd` (14 daily plus 12 monthly copies), and
  copied encrypted **outside** the database server.
- If the database is a managed service, also enable its point-in-time recovery.
- Back up the documents folder (`ETNA_DOCUMENTS_DIR`, default
  `storage/documents`) at the same time as the database: the database holds
  only the documents' names and checksums, the files live on disk. A file
  missing or changed on disk is refused at download, never served.
- Back up `.env.local` / the production secrets in a password manager: without
  `MFA_ENCRYPTION_KEY` every user must enroll their authenticator again.
- Test a restore into staging at least once per quarter; a backup that was
  never restored is not a backup (the steps are below; CI runs the same cycle
  on every change).

### Off-site backups

`scripts/db/offsite.mjs` writes one encrypted file per run to another disk, a
NAS or a network share (`ETNA_OFFSITE_DIR`): the database dump, the uploaded
documents and company folders, and the settings file (`etna.env`, with the
two-factor key) when given with `--settings`. It needs no passphrase to make a
backup, only to open one: the data is encrypted with a public key, and the
private key, protected by your passphrase, travels inside every file. A
backup file plus the passphrase is all a restore needs; anything changed in
the file is refused.

1. **Once:** make the keys, and keep the passphrase in a password manager:

   ```bash
   node scripts/db/offsite.mjs keys --dir /etc/etna         # Linux
   node scripts\db\offsite.mjs keys --dir D:\ETNA\config    # Windows
   ```

2. **Every night:** with `OFFSITE_DATABASE_URL` (the schema owner; its
   password from `PGPASSWORD` or the PostgreSQL password file),
   `ETNA_OFFSITE_DIR`, `ETNA_OFFSITE_KEY` (the `.pub.pem` file) and
   optionally `ETNA_OFFSITE_KEEP` (default 14):

   ```bash
   node scripts/db/offsite.mjs run --settings /etc/etna/etna.env
   ```

   - Linux: `etna-offsite.timer` (docs/INSTALL-LINUX.md, A6).
   - Docker: `docker compose --profile offsite run --rm offsite` from cron
     (docs/INSTALL-LINUX.md, B5).
   - Windows: a Task Scheduler task at night running
     `node <ETNA_DATA_ROOT>\app\current\scripts\db\offsite.mjs run --settings <ETNA_DATA_ROOT>\config\etna.env`
     as an account that may read `<ETNA_DATA_ROOT>`, with the settings above
     as its environment and the owner password in that account's
     `%APPDATA%\postgresql\pgpass.conf`. A share (`\\nas\backup\etna`) works as
     `ETNA_OFFSITE_DIR`.

   A failed run logs `[offsite] backup failed`, which error alerts e-mail.

3. **Check a backup** (monthly at least; opens it and checks every file, and
   reads the dump's table of contents):

   ```bash
   node scripts/db/offsite.mjs list
   node scripts/db/offsite.mjs verify etna-offsite-20261015-031500.etnabak
   ```

4. **Restore** (quarterly into staging; for real into production after an
   incident). The database goes into a database prepared with the same ETNA
   version (`scripts/setup-local.mjs` or `npm run db:migrate` on an empty
   database owned by `etna_owner`); stop the app and the worker first:

   ```bash
   node scripts/db/offsite.mjs restore etna-offsite-20261015-031500.etnabak \
     --to /tmp/etna-restored --database postgres://etna_owner@localhost:5432/etna_staging
   ```

   Then copy `files/documents` and `files/companies` from the folder into the
   server's `ETNA_DATA_ROOT`, and use `settings/etna.env` (its
   `MFA_ENCRYPTION_KEY` and `SESSION_HINT_SECRET`) for the restored server.
- Financial records cannot be deleted through the app or API. The reset in
  Settings still can, for the active ERP only: the Owner, with the password
  checked on the server (sign-in lockout applies), the confirmation phrase and
  two-factor when enrolled (`/api/erp/reset`, `erp_reset_workspace`). The audit
  log is kept and the reset is recorded (`workspace.reset`); restrict who holds
  owner accounts.

## 4. Monitoring

- **Uptime:** monitor `GET /api/health` every minute. `200` = app and database
  reachable; `503` = degraded.
- **Errors:** ETNA e-mails them itself (see *Error alerts* below). The tags
  in the server log are `[API Error]`, `[auth]`, `[data]`, `[db]`,
  `[analytics query]`, `[analytics summary]`, `[ontology]`, `[currency]`,
  `[Export`, `[workspace]`, `[worker]` and `[health]`.
  Workflow runs are listed in `workflow_runs` (see docs/WORKFLOWS.md).

### Error alerts

With SMTP set up (`SMTP_HOST`, docs/CONFIGURATION.md) and
`ETNA_ALERT_EMAILS=you@example.com,ops@example.com` in the settings (else the
server admins in `ETNA_ADMIN_EMAILS` get them), the app and the Terminal
worker e-mail every error they log:

- the first e-mail a minute after the first error, then at most one every 15
  minutes per process, each listing every kind of error with a count and the
  time of the first and last;
- only the tag and error codes, never error messages or values (they can
  quote business data). The full lines stay in the server log;
- the worker checks the app's `/api/health` every minute and reports when it
  has not answered three times in a row (in Docker it checks
  `ETNA_HEALTH_URL=http://app:4028/api/health`).

A server that is down cannot send anything: keep an external uptime check on
`/api/health` as well (any free uptime monitor).
- **Database:** watch CPU, connections and slow queries; add an index before a
  query becomes slow, not after.
- **Security:** review `erp_workspace_audit_log` (membership, two-factor,
  recovery codes, renames), `erp_audit_log` (record changes), `erp_access_log`
  (ERP → Search: who searched which record types and opened which records;
  never the search text — see docs/ONTOLOGY.md), `erp_currency_audit` (base
  currency confirmations, exchange rates added or imported — see
  docs/CURRENCY.md) and repeated failures in
  `auth.login_attempts` and `auth.mfa_attempts` weekly.

## 5. Accounts and security checklist

- **Proprietary code** (see `LICENSE`, copyright BettyWhite). A private GitHub
  repository limits who can read the repository; it does not hide the frontend.
  JavaScript sent to browsers can be read in
  developer tools even without source maps, which production builds do not
  ship. Keep secrets, keys and business rules that must stay confidential on
  the server, never in client components or `NEXT_PUBLIC_*` variables.

- **In-app console** (backtick on any page; header button on phones): only for
  Finance members and Owners of shared workspaces, checked by `/api/console` on
  every request (see docs/CONSOLE.md). Its data commands run on the server as
  the user, so row-level security, table grants and the audit triggers decide
  what happens. Its delete commands clear master data in the workspace it is
  open in; financial records and the audit log cannot be deleted through it
  (or any API).
- **Sign-in limits.** Passwords: 5 wrong tries per account per 2 minutes,
  counted one at a time even for parallel requests. Two-factor codes: 5 wrong
  codes per account per 15 minutes. Behind a reverse proxy that overwrites
  `X-Forwarded-For`, set `TRUST_PROXY=1`: limits then apply per account and
  network (5), per account overall (20) and per network (30), so a stranger
  cannot lock the owner out from elsewhere. Behind a Cloudflare Tunnel set
  `TRUST_PROXY=cloudflare` instead (the address comes from
  `CF-Connecting-IP`; only while ETNA listens on 127.0.0.1). Without either
  the headers are ignored.
- **Password checks hold no database connection.** bcrypt runs outside any
  transaction, a few at a time per server with a short queue; beyond it a
  sign-in is answered "too many attempts" at once, before any database work
  (`src/server/slots.ts`). Connections are waited for at most 10 seconds.
- **Fair use of the database.** Each user runs at most 3 queries at once
  through `/api/data` (the rest wait their turn), so one user's slow searches
  cannot take every connection.
- **Request bodies** are read with a size limit while they arrive (JSON 1 MB,
  uploads 10 MB plus the form; sign-in and settings forms 10 KB), also when a
  client sends no Content-Length (`src/server/http/body.ts`).
- **In-app backup and account administration** exist only where
  `npm run db:backup -- setup` was run (`ETNA_BACKUP_DATABASE_URL`), which
  stores the owner password on that machine. Production servers leave them
  off (docs/CONFIGURATION.md); there, backups run on the database server and
  accounts are managed with `etna_admin.*` / `scripts/admin/users.mjs`.
  Where they are on: only `ETNA_ADMIN_EMAILS` who completed two-factor in the
  session may back up or restore (a restore also needs the password), and the
  same people see Settings → User accounts. The web roles still cannot insert
  into `auth.users`: that route runs `scripts/admin/users-api.mjs` as the
  owner. The temporary password is generated by the database and shown once.
- **Listening address.** `npm start`, `npm run dev` and
  `scripts/server/etna-server.cmd` listen on 127.0.0.1 only. Reach ETNA from
  elsewhere through a reverse proxy or a tunnel, never by opening the port.
- **Callable database functions.** Signed-in users can call only the functions
  the app uses (`20261011000000_erp_security_hardening`, checked by
  `tests/db/securityHardening.test.mjs`); anonymous visitors only the
  pre-request check. New functions are callable by nobody until a migration
  grants them explicitly.
- The data API never returns PostgreSQL DETAIL/HINT (they can contain whole
  rows) and answers unexpected database errors with a generic message; only the
  error code is logged (`[db] <code>`). State-changing API routes refuse
  cross-site requests (Origin check) in addition to SameSite cookies.

- **No self sign-up.** Accounts are created by an administrator with
  `scripts/admin/users.mjs` (create-user, set-password, revoke-sessions,
  reset-mfa, lock/unlock). Hand over temporary passwords through a separate
  channel. Each of these is recorded in the security log; platform admins
  (`grant-admin`) read it under `/admin` (docs/ADMIN.md). Enforced server-side: `/api/auth` refuses sign-up actions (403),
  and the app's database roles (`etna_auth`, `etna_app`, `anon`,
  `authenticated`) cannot insert into `auth.users`
  (migration `20261003000000_auth_no_self_signup`). Workspace access codes only
  add an existing, signed-in account to a workspace.
- Users change their own password in ERP → Settings → Change password (current
  password required, at least 10 characters, a second step first when 2FA is
  on). Their other sessions end; wrong current passwords count towards the
  sign-in lockout.
- Users keep their recovery codes (shown once when two-factor is turned on) and
  can add a second authenticator device. A user with neither is locked out
  until an administrator runs `reset-mfa` — confirm the person's identity out of
  band first and write down who asked, when and how they were verified.
- Every owner and admin has two-factor authentication on; workspaces that hold
  real data require it for all members (Workspace panel → Security).
- The app connects as `etna_app` / `etna_auth`, which have no rights of their
  own beyond what row-level security allows. The schema owner's password is
  never stored on the production app server: it is typed per session for
  migrations and kept only in the database server's `pgpass.conf` for backups.
- Close accounting periods (Accounting → Settings → lock date) after each
  month-end review.
- Keep dependencies current: CI fails on critical `npm audit` findings.

## 6. Incidents

1. Stop the damage: take the app offline (maintenance page) or end the
   affected users' sessions (`scripts/admin/users.mjs revoke-sessions` / `lock`).
2. Preserve evidence: export audit logs (including
   `etna_platform.security_events`) before changing anything.
3. Restore from backup into staging first, verify, then production.
4. Rotate credentials that may be exposed (role passwords; a new
   `SESSION_HINT_SECRET` signs everyone out — `MFA_ENCRYPTION_KEY` can only be
   replaced by re-encrypting the stored secrets).
5. Write down what happened and which check would have caught it.
