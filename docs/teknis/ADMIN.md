# Admin panel and security log

The internal admin panel at `/admin` is for ETNA's own staff (platform
admins), not for clients. Owning or administering an ERP never makes anyone a
platform admin. To everyone else `/admin` is an ordinary 404.

The panel contains a dashboard, admin roles, the security log, accounts
(create, disable, sessions, password links, two-factor reset), workspaces
(suspend, reactivate, who has access) and the Terms & Conditions (versions,
publishing, who accepted).

## Roles

| Role | Reads | Can change |
|---|---|---|
| `super_admin` | Everything | Everything, including other admins' accounts, admin roles, suspending workspaces, access to workspaces, and the Terms & Conditions |
| `support` | Everything | Ordinary accounts: create, disable/enable, end sessions, password links, two-factor reset |
| `auditor` | Everything | Nothing |
| `security_officer` | Everything an auditor reads, plus the data-access log | Retention bounds, legal holds, and the second confirmation of a company's deletion; never accounts or access |

Every admin needs two-factor turned on (ERP → Settings) before the panel
opens. Every change also needs a two-factor code entered in the last 10
minutes; the panel asks for one when it is needed. Nobody can change their
own role, disable their own account or reset their own two-factor, so there is
always at least one super admin. Support cannot act on an admin's account, so
it cannot take one over.

The database checks all of this itself (`etna_platform._require_admin`,
`etna_platform._target`); the panel only hides buttons that would be refused.

### The first super admin

From a terminal, as the schema owner (as for any account work):

Use the host and port from `DATABASE_URL` in `.env.local` (`scripts/setup-local.mjs`
may have chosen a port other than 5432). The owner's password comes from
`PGPASSWORD` or, if `setup-local` saved it, from `%APPDATA%\postgresql\pgpass.conf`.

```powershell
node scripts/admin/users.mjs grant-admin --email you@example.com              # super_admin
node scripts/admin/users.mjs grant-admin --email ops@example.com --role auditor
node scripts/admin/users.mjs list-admins
node scripts/admin/users.mjs revoke-admin --email ops@example.com
```

Or in pgAdmin: `select etna_admin.grant_platform_admin('you@example.com');`.
After that, super admins manage the other admins under `/admin/admins`.

`ETNA_ADMIN_EMAILS` (Settings → Backup and Settings → User accounts) is a
separate, older mechanism and is unchanged.

The owner connection comes from `.env.local` (saved by `node scripts/setup-local.mjs`
or `npm run db:backup -- setup`) and its password from your PostgreSQL password
file, so nothing has to be set. Another database: set `ADMIN_DATABASE_URL` first
(cmd: `set "ADMIN_DATABASE_URL=postgres://..."`). On Linux: `sudo psctl users …`.

## Dashboard (`/admin`)

Every admin role sees it. A switch picks the last 24 hours, 7 days or 30 days.
All figures come from data ETNA already keeps (accounts, workspaces, the
security log, the ERP audit trail); nothing is collected for the dashboard.

| Panel | Shows |
|---|---|
| Accounts | All accounts; signed in during the period; new; disabled; without two-factor; admins |
| Workspaces | All workspaces; with changes during the period (any audited record created, changed or deleted); new; shared; suspended |
| Sign-ins | Successful and failed sign-ins, wrong two-factor codes, blocked attempts, password links that did not work. Each opens the security log filtered |
| Terms not yet accepted | Accounts that have not accepted the current version (and how many of them are enabled) |
| Charts | Per hour (24 hours) or per day, in the admin's time zone: sign-ins vs. failures, new accounts |
| Most failed attempts | The 5 accounts (the address typed, also when no such account exists) and the 5 IP addresses with the most failed passwords / codes. IP addresses need `TRUST_PROXY` |
| Access changes | The latest admin roles granted, changed or revoked, and workspace members added, removed, leaving or changing role |
| Admin actions | The latest actions by admins in the panel or from the command line |
| System status | Whether the database answers and how fast; PostgreSQL version and size; whether every migration this app version ships is applied; the last backup; size and retention of the security log; app uptime |

ETNA has no store of application errors; they are in the server output.
Super admins also get two shortcuts on the dashboard: **Grant admin access**
(as under `/admin/admins`) and **Grant workspace access** (below).

## Accounts (`/admin/users`)

Every sign-in account, searchable by e-mail or name, filtered by disabled,
closed, without two-factor, or admins, and sorted by newest, oldest, last
sign-in or e-mail. Each row shows the account's ERPs with its role in each,
when it was created and last signed in, and a menu with the actions below
that the admin may take. Internal "container" accounts that back ERPs
created from Add modules are not people and are not listed. An account's page
shows its sessions (IP, browser, last active), workspaces and roles,
authenticators and remaining recovery codes, recent password links, and its
security log.

| Action | What happens |
|---|---|
| New account | Created **without a password**, with an invite link (valid 72 hours) that the admin passes on. The person chooses their own password. Its personal ERP is created as for any account |
| Disable (reason required) | Cannot sign in; every session ends; open password links are cancelled |
| Enable | Can sign in again |
| Sign out everywhere / end one session | The sessions end; the account stays enabled |
| Password reset link | A one-time link valid 24 hours. Using it ends every session of the account and clears its failed sign-ins; two-factor stays as it was |
| Reset two-factor (note required) | Removes all authenticators and recovery codes and ends every session. Confirm who the person is outside ETNA first; the note saying how is kept in the security log |
| Close account (super admin; reason and the e-mail typed again) | See below. Cannot be undone |

### Closing an account

ETNA does not delete accounts. Business records (customers, invoices, stock
movements, documents, workflows …) point at the account that wrote them, and
deleting it would delete them. **Close account** is the "delete" instead:

- The account can never sign in again: blocked, password removed, every
  session ended, open password links cancelled, authenticators and recovery
  codes removed.
- It leaves every ERP (each ERP's activity shows "by ETNA staff" with the
  reason), and the invitation codes it made are revoked.
- Its name and e-mail are replaced (`Closed account`,
  `closed-…@closed.etna.invalid`), so the address can be used for a new
  account. Its own personal ERP is renamed `Closed account`.
- Its records stay where they are. The security log keeps the original
  address (`ACCOUNT_CLOSED`, with the reason); the log is append-only.
- No other admin action works on a closed account afterwards.

Refused for your own account, for a platform admin (revoke the role first),
and for the Owner of an ERP that other people still use: transfer the
ownership first (below). A personal ERP cannot change hands; remove its other
members instead.

### Password links

- No temporary passwords. ETNA makes a random 256-bit token, puts it in the
  link and stores only its SHA-256 hash. The link is shown to the admin once.
  Send it through a channel you trust; e-mail delivery can be added later.
- The token goes after `#` (`/reset-password#token=…`), so it is not sent to
  the server with the page request and does not appear in proxy or Cloudflare
  logs. The page removes it from the address bar right after reading it.
- A link works once. A newer link, a completed reset, disabling the account,
  or the person changing their own password cancels open links.
- Links are built from `ETNA_PUBLIC_URL` (docs/teknis/CONFIGURATION.md) when it is
  set, otherwise from the address the admin used. Set it behind a tunnel or
  proxy.

## Workspaces (`/admin/workspaces`)

Every ERP: each account's own, and those created from Add modules (shown with
the account that created them). A workspace page shows its members and
roles, last change, two-factor requirement, suspension history and its
security log.

### Access to a workspace

Super admins can give an existing account a role in any workspace (Admin,
Finance, Sales or Inventory), change that role, or remove the access, from
the workspace's page or the dashboard. Each change needs a reason and a fresh
two-factor code.

- Never your own access: another super admin must give it, so nobody can
  quietly open a client's data to themselves. Removing your own access is
  allowed.
- Never the Owner: the Owner's access and role cannot be changed, and nobody
  is made Owner this way.
- The ERP's limit on how many ERPs an account may belong to (three)
  applies to client accounts. Platform admins are exempt, so they can be
  given access to as many client ERPs as they support.
- The client sees the change in its own workspace activity ("by ETNA staff"),
  and it is in the security log (`WORKSPACE_MEMBER_ADDED`,
  `WORKSPACE_ROLE_CHANGED`, `WORKSPACE_MEMBER_REMOVED`, actor kind admin, with
  the reason).

### Transferring ownership

**Make Owner** (super admin, reason, fresh two-factor code) on a member of an
ERP created from Add modules or New company. Its books belong to its internal
account, so only the roles change: that member becomes Owner and the
previous Owner, if still a member, becomes Admin. The new Owner must already
be a member (give access first), must not be you, and must not be disabled.
A personal ERP keeps its books under its person and cannot be transferred.
Logged as `WORKSPACE_OWNER_CHANGED` and in the ERP's activity.

### Suspending

**Suspend** (super admin, reason required) closes the workspace to everyone:

- `erp_workspace_role()` returns no role for a suspended workspace, so every
  ERP function that checks a role or permission refuses it.
- A restrictive row-level policy, `erp_workspace_not_suspended`, sits on every
  table that has a `workspace_id` (except the membership list). It is ANDed
  with all other policies, including older "manage own rows" ones, so no row
  of a suspended workspace can be read or written through the app. A test
  fails if a new table with `workspace_id` lacks it. Add it in the migration
  that creates the table.
- Members keep their accounts and their other ERPs. The ERP shows them a
  "suspended" notice instead of the pages (Settings stays open for their own
  account).
- Optionally the suspension also disables every member's account (not
  platform admins, not you) and ends their sessions. Reactivating can enable
  exactly those accounts again.

### Staff access to a client's ERP

When support needs to look inside a company, a super admin opens a **staff
session** from the workspace page (Governance → Staff access): a reason (at
least 10 characters), the support ticket, and how long, 1 to 8 hours, with a
fresh two-factor code. During the session the staff member acts with the
**Owner's rights** in that ERP; the ERP shows them a violet banner, the
Owner is e-mailed, the ERP's activity shows "by ETNA staff", and the session
is in the security log (`STAFF_ACCESS_STARTED`, `STAFF_ACCESS_ENDED`). E-mails are sent
when e-mail is set up (see E-mail below). It ends
by itself or when ended early.

### Ending a company's service (termination)

1. A super admin starts it (Governance → End service): a reason and an
   **export period** of 7 to 90 days. Only company ERPs (not a person's own).
   The company is suspended at once; its Owner is told by e-mail and sees a
   notice in the ERP.
2. During the export period the **Owner** can prepare and download one file
   with everything the company stored: every ERP list and every Terminal
   dataset (gzip JSON; passwords, hashes and tokens are left out). The worker
   builds it; each download is in the data-access log
   (`20261012000040_company_export.sql`).
3. After the export period a **security officer** who is not the person who
   started it confirms the deletion by typing the company's name. A company
   on legal hold cannot be confirmed.
4. The worker deletes the company's records and its files (documents,
   imports, exports). Audit trails, the membership history and the security
   log stay; `WORKSPACE_DATA_DELETED` lists what went.

Until step 3 a super admin can cancel.

### Retention and legal holds (`/admin/governance`)

How long each log is kept has platform bounds set by a super admin or
security officer; each company's Owner (or a member with *Set policies*)
chooses within them in ERP → Settings.

| Log | Minimum | Maximum | Default |
|---|---|---|---|
| Security log | 365 days | forever | forever |
| Data-access log | 90 days | 730 days | 365 days |
| ERP activity (workspace audit) | 365 days | forever | forever |
| Pipeline run history | 30 days | 730 days | 180 days |
| Streaming raw events | 7 days | 365 days | 30 days |

A **legal hold** (security officer, reason, optional end date) stops all
purging and deletion for a company until it is released. The worker purges
past-retention entries daily.

### Data-access log (`/admin/access-log`)

Every read of business data is recorded apart from the security log, in a
table partitioned by month: who (user, ETNA staff, schedule or system), which
company, what (ERP list, dataset, document, export), the operation, the row
count, which sensitive fields were shown unmasked, and the request. Nobody can
change or delete entries; only the retention purge removes old months. Owners
and members with *See workspace activity* read their own company's entries
in ERP → Settings.

### Storage per company

Each company has a storage quota (default: none; a super admin sets a default
and per-company quotas on the workspace page, or *unlimited*). Everything
counts: uploaded documents, import files, exports, Terminal datasets and an
estimate of the ERP's own records, measured every 6 hours. Passing 80, 90 and
100 % is logged (`STORAGE_WARNING`); the Owner sees use against the quota in
ERP → Settings. When full, new uploads, imports and pipeline
writes are refused, but **daily ERP work is never blocked**. The largest
upload is 200 MB (CSV) and 50 MB (Excel) by default. The Owner can ask for
more from ERP → Settings (once a day); requests appear on the dashboard.
On a server, the server manager (`node scripts\server\manager.mjs`) → Company storage can give a company its own folder on
another drive.

## New client company (`/admin/workspaces` → New company)

Super admin, with a fresh two-factor code. One form makes an ERP for a client
company with its **industry** (General, Quarry & mining, Trading,
Manufacturing — it switches on the modules) and its **Owner**:

- an e-mail address without an account gets a new account and a one-time
  invitation link (shown once; also e-mailed when e-mail is set up and the box
  is ticked);
- an existing account gets the ERP among its ERPs, within its ERP limit.

Nobody can make themselves Owner. The ERP has its own books, like any ERP
created from Add modules. It is in the security log (`COMPANY_CREATED`).

## ERP usage, industry and modules (workspace page)

Every admin sees what an ERP holds (customers, products, documents, invoices,
weigh tickets, production runs, machines …). A super admin can change its
industry and modules with a reason (`WORKSPACE_MODULES_CHANGED`; also in the
ERP's own audit trail). Owners and Admins change them themselves under ERP →
Settings → Industry and modules.

## ERP limit per account (account page)

An account may belong to 3 ERPs. A super admin can set another limit (1–100)
for one account, e.g. an owner of a group of companies, or put it back to the
default (`ACCOUNT_ERP_LIMIT_CHANGED`). Platform admins have no limit.

## Announcements (`/admin/announcements`)

Super admins and support publish a banner shown at the top of the ERP — to
everyone or to one ERP (its ID from the workspace page) — from a start time to
an optional end (info, warning or maintenance). People can hide a banner on
their own device. Withdrawing ends it at once.

## System & backups (`/admin/system`)

Database response time and size, free disk space on the backup drive, the
list of backups, and the e-mail set-up. A super admin can run a backup now
(where in-app backups are configured, docs/teknis/CONFIGURATION.md); every role can
send a test e-mail. Both need a fresh two-factor code and are logged.

**Copy backups somewhere else regularly** (USB drive, cloud folder): a backup
on the same computer is lost with it.

## E-mail

With `SMTP_*` set (docs/teknis/CONFIGURATION.md) invitation links, password links and
new company invitations can be e-mailed (Indonesian and English); the link is
still shown in the panel, so a failed e-mail loses nothing. ETNA sends over
TLS only.

## Exports and sign-in history

Accounts, workspaces and the security log (with the filters on screen) export
to CSV — every admin role, with a fresh two-factor code; each export is logged
(`ADMIN_EXPORT`). Cells that a spreadsheet would run as a formula are
neutralised. The account page shows the account's sign-ins, two-factor checks
and sign-outs with IP address and device.

## Terms & Conditions (`/admin/terms`, `/terms`)

ETNA ships **no** legal text. Until a super admin publishes a version, nobody
is asked to accept anything.

- **Versions.** A super admin writes a draft: a version name (for example
  `2026-10-01 v1.0`) and the text in English (required), Indonesian and
  Chinese (optional; readers see English when their language is missing).
  The text is plain text, shown exactly as written. A new draft starts with
  `[PLACEHOLDER - NOT LEGAL TEXT]`, and a draft containing `[PLACEHOLDER`
  cannot be published. Drafts can be previewed, edited and deleted.
- **Publishing** makes the draft the current version (the newest published
  one). From then on it can never be changed or deleted (a database trigger
  refuses it, also for the schema owner). To change the terms, publish a new
  version: every account must then accept again.
- **Acceptance, enforced by the database.** `erp_check_request()`, which runs
  at the start of every request the app makes as a signed-in user, refuses all
  data (`HINT terms_required`) until the account has accepted the current
  version. Admins too. In the browser, every page sends such an account to
  `/terms` (after sign-in and two-factor); the database check holds even if
  that is skipped.
- On `/terms` the person reads the text, ticks "I have read and accept" and
  accepts, or declines and is signed out. Accepting is possible only for the
  current version: if a newer one was published while the page was open, they
  are asked to read it first. `/terms` is also readable without signing in.
- **The record** (`etna_platform.terms_acceptances`, one row per account and
  version, permanent): account and e-mail at that moment, version, time,
  the language shown, method (checkbox and button), the active workspace (only
  if the account was a member), session, IP address and browser. It answers
  "which version did this account accept, when, and for which workspace". An
  account's page shows its history; `/admin/terms` shows how many accepted
  each version and lists the accounts that have not accepted the current one.
- Security log: `TERMS_DRAFT_SAVED`, `TERMS_DRAFT_DELETED`, `TERMS_PUBLISHED`
  (admins), `TERMS_ACCEPTED`, `TERMS_DECLINED` (accounts).

The wording, the languages offered, and whether storing IP addresses with
an acceptance is appropriate are legal decisions: confirm them with your
legal adviser.

## Security log

`etna_platform.security_events` has one row per event:

| When | Events |
|---|---|
| Sign-in | `LOGIN_SUCCEEDED`, `LOGIN_FAILED` (reason: unknown account, wrong password, disabled), `LOGIN_RATE_LIMITED`, `LOGOUT` |
| Password | `PASSWORD_CHANGED`, `PASSWORD_CHANGE_FAILED`, `PASSWORD_CHECK_FAILED` (wrong password before a reset or deleting an ERP), `PASSWORD_RESET_COMPLETED`, `PASSWORD_RESET_FAILED` (a link that does not work) |
| Two-factor | `MFA_FACTOR_ADDED`, `MFA_FACTOR_REMOVED`, `MFA_CHALLENGE_SUCCEEDED`, `MFA_CHALLENGE_FAILED`, `MFA_RATE_LIMITED` |
| Admin panel | `ADMIN_REAUTHENTICATED`, `ADMIN_REAUTH_FAILED`, `ADMIN_ROLE_GRANTED`, `ADMIN_ROLE_CHANGED`, `ADMIN_ROLE_REVOKED`, `USER_CREATED`, `USER_DISABLED` (with the reason), `USER_ENABLED`, `SESSIONS_REVOKED`, `ADMIN_PASSWORD_RESET_INITIATED`, `MFA_RESET` (with the verification note), `WORKSPACE_SUSPENDED` (with the reason), `WORKSPACE_REACTIVATED` |
| Command line / pgAdmin | `USER_CREATED`, `ADMIN_PASSWORD_SET`, `SESSIONS_REVOKED`, `MFA_RESET`, `USER_DISABLED`, `USER_ENABLED`, `SECURITY_LOG_RETENTION_CHANGED`, `SECURITY_LOG_PURGED` |
| Workspaces (copied from each ERP's own activity) | `WORKSPACE_MEMBER_ADDED`, `WORKSPACE_ROLE_CHANGED`, `WORKSPACE_MEMBER_REMOVED`, `WORKSPACE_MEMBER_LEFT` (by members, or by admins with `via: etna_admin`), `ERP_RESET` (scope and what was removed), `ERP_EMPTIED`, `ERP_DELETED` |

Each row records the time, result, who acted (the user, an admin, or `db:<role>`
for the command line), which account was affected, the session, IP address,
browser and a small JSON `metadata` object. It never stores passwords,
two-factor codes, secrets or session tokens; tests check this.

IP addresses come from `TRUST_PROXY` (docs/teknis/CONFIGURATION.md). Without it they
are empty.

### Tamper resistance

- No application role (`etna_app`, `etna_auth`, `anon`, `authenticated`) can
  read, change or delete the table directly. Admins read it through
  `etna_platform.admin_security_events`, and the sign-in server writes only
  sign-in events through `etna_platform.log_auth_event`.
- A trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`, even for the schema
  owner. The only exception is the retention purge below.
- Rows have no foreign keys, so deleting an account or a workspace leaves its
  history in place.
- Limits: the schema owner and PostgreSQL superusers can still disable the
  trigger. Keep those passwords off the app server (docs/teknis/OPERATIONS.md) and
  back up the database.

### ERP audit trails

Each ERP keeps its own trail: `erp_audit_log` (every audited record created,
changed or deleted, with the before/after values), `erp_workspace_audit_log`
(members, invitations, settings, resets) and `erp_currency_audit`. These are
kept when an ERP is reset or emptied, and since phase 4 also when a created
ERP or an account is deleted: the tables have no foreign keys to accounts or
workspaces any more, so their rows stay with the ids they had. Members lose
the trail of a deleted ERP together with the ERP; the database owner can still
read it. These rows contain record contents (customer names, amounts):
include them in what the privacy notice says ETNA keeps.

### Retention

The log is kept **forever** by default. To keep it for a limited time (at
least 30 days), set the period and run the purge regularly, for example from
the database server's backup task. Both steps are recorded in the log.

```sql
select etna_admin.set_security_log_retention(365);   -- or NULL for forever
select etna_admin.purge_security_events();           -- deletes older entries
```

Storing IP addresses and browser details is personal data. Choose the
retention period with whoever handles data protection for ETNA (for
Indonesia, UU PDP No. 27/2022) and say in the Terms & Conditions / privacy
notice what is kept and for how long.

## Where it lives

| Piece | File |
|---|---|
| Roles, security log | `db/migrations/20261012000011_platform_admin_security_log.sql` |
| Accounts, workspaces, suspension, password links | `db/migrations/20261012000012_platform_admin_users_workspaces.sql` |
| Rollbacks (run newest first) | `db/rollback/` |
| Sign-in events, re-authentication, password links | `src/server/auth/service.ts`; `/api/auth/password-link`, `/api/auth/set-password` |
| Admin service and request checks | `src/server/admin/` |
| API | `src/app/api/admin/platform/` (`me`, `reauth`, `admins`, `events`, `users`, `workspaces`, `terms`, `dashboard`, `system`) |
| Pages | `src/app/admin/`, `src/app/reset-password/` |
| Suspended-ERP notice | `src/app/erp/components/shell/SuspendedNotice.tsx` |
| Command line | `scripts/admin/users.mjs` (`grant-admin`, `revoke-admin`, `list-admins`) |
| Terms & Conditions | `db/migrations/20261012000013_platform_terms.sql`; `src/app/terms/`, `src/app/admin/terms/`, `src/components/terms/` (`TermsGate` in the root layout) |
| Dashboard, workspace access, kept audit trails | `db/migrations/20261012000014_platform_admin_dashboard.sql`; `src/server/admin/system.ts`; `/api/admin/platform/dashboard`, `/api/admin/platform/system`; `src/app/admin/page.tsx`, `src/app/admin/components/GrantDialogs.tsx` |
| Governance: security officer, staff access, retention, legal holds, termination | `db/migrations/20261012000032_platform_governance.sql`; `src/server/admin/governance.ts`; `/api/admin/platform/governance`, `/api/admin/platform/workspaces/[id]/governance`; `src/app/admin/governance/`, `src/app/admin/components/GovernancePanels.tsx` |
| Data-access log | `db/migrations/20261012000033_data_access_log.sql`; `/api/admin/platform/access-log`; `src/app/admin/access-log/` |
| Storage quotas | `db/migrations/20261012000034_storage_quotas.sql` |
| Company export | `db/migrations/20261012000040_company_export.sql`; `/api/erp/company-export`; `src/app/erp/components/shell/GovernanceBanner.tsx` |
| Tests | `tests/db/platformGovernance.test.mjs`, `tests/db/dataAccessLog.test.mjs`, `tests/db/storageQuotas.test.mjs`, `tests/db/companyExport.test.mjs`, `tests/db/platformAdmin.test.mjs`, `tests/db/securityEvents.test.mjs`, `tests/db/adminUsersWorkspaces.test.mjs`, `tests/db/terms.test.mjs`, `tests/db/adminDashboard.test.mjs` |

Each admin request is checked three times: the `/admin` layout and every API
route look up the caller's role; the database functions check the role, the
two-factor session and, for changes, the re-authentication; and the database
grants allow nothing else.
