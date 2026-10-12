# PrintStream TERMINAL

TERMINAL is the data module of PrintStream (by ETNA): **datasets**,
**imports**, **pipelines** and **connections**, run in the background by a
separate worker. A TERMINAL is one of two things:

* **A TERMINAL on its own** (Dashboard → Add modules → PrintStream TERMINAL →
  *New TERMINAL*): its own members, roles and invitations (**Members** on the
  TERMINAL screen), no ERP needed, and it does not use one of the account's
  three ERP slots (an account belongs to at most 10 TERMINALs). Its Owner can
  delete it (with the password). It never appears among the ERPs.
* **An ERP's TERMINAL**: added to an ERP by its Owner or an Admin, working with
  that ERP's members and data. Removing it hides TERMINAL and stops new jobs,
  writes and scheduled runs; nothing is deleted, and adding it again brings
  everything back.

Both are listed under **TERMINAL** in the Dashboard sidebar and open on their
own screen (`/terminal`), which remembers its own choice: opening a TERMINAL
never opens or switches an ERP.

It replaces Workflows: every existing workflow is now a pipeline (same tables,
same editor at `/erp/workflows/[id]`), and ERPs that had workflows start with
TERMINAL added. `/erp/workflows` and `/erp/terminal` lead to `/terminal`.

This document covers phase 1 (P1) and the connectors of phase 2 (P2) built so
far. AI and approvals (P3–P4) are designed in the specification but not built yet.

## What a company can do

| Area | What it is | Who (default roles) |
|---|---|---|
| Datasets | Tables the company defines: typed columns (text, whole number, number, yes/no, date, date and time, JSON), a key, sensitive and hidden columns, a folder, workspace or restricted access | Owner, Admin; Finance views, imports, edits and exports |
| Grid | Page through rows, sort, add, change (double-click) and remove rows (deleted for good after 7 days) | `datasets.edit` |
| Imports | Upload CSV/TSV/TXT (up to the company's limit, 200 MB by default) or Excel (50 MB). The worker detects encoding, separator, header, `1.234,56` vs `1,234.56` and column types; the user maps columns to a new dataset, an existing one (add, update by key, replace) or an ERP list (customers, suppliers, products). Rows that do not fit are kept with the reason | `datasets.import` (+ the ERP permission for ERP lists) |
| Pipelines | The visual editor, in its own window (`/pipelines/[id]`, no ERP around it), with **Dataset** (read), **Write to dataset** and the unified-data nodes below. Runs in the editor never write; **Run now**, schedules and chains run the published version in the background and write | `pipelines.*` |
| Schedules | Daily, weekly, monthly, every N minutes (≥ 5), or cron; in the schedule's time zone; three failures in a row switch it off | `pipelines.schedule` |
| Chains | "Then run…": pipelines that run after another succeeds; loops are refused | `pipelines.schedule` |
| Jobs | What the worker did, with errors; queued and running jobs can be cancelled | anyone who started them, `pipelines.disable` |
| Command bar | **Ctrl+K** (⌘K) jumps to datasets, pipelines and tabs | everyone |

Uploads are CSV files (`.csv`) only; Excel files imported before stay readable.

### Nodes for unified data

The palette groups them (and has a search box). They run alike in the editor
and in background runs (`src/lib/workflow/unifyNodes.ts`).

| Group | Nodes |
|---|---|
| Combine & Clean | Stack Tables (two tables by column name, optional source column), Remove Duplicates (by key, keep first or last), Fill Missing (value, previous, zero, average), Change Type (text, number, whole number, date incl. dd/mm/yyyy, yes/no; unreadable values left empty and counted), Clean Text (trim, single spaces, case), Split Column, Combine Columns |
| Match Records | Lookup (columns from a second table by equal key), Fuzzy Match (names written differently: legal forms such as PT/CV/Tbk, punctuation and word order ignored; a score from 0 to 1 and a threshold; at most 4 million comparisons), Standardize Values (`from=to; from=to`) |
| Reshape | Pivot (at most 200 new columns), Unpivot, Running Values (running total or count, row number, rank, previous value, change, % of group total; per group, in an order), Date Part, Date Difference |
| Data Quality | Profile Columns, Check Rules (outputs *Valid* and *Not valid*, the latter with `_reason`: missing, not a number or date, out of range, not an allowed value, duplicate key), Find Outliers (IQR or z-score; `is_outlier`, `outlier_score`) |

### Syncing with ERPs (a TERMINAL on its own)

**Linked ERPs** on the TERMINAL screen lists the ERPs this TERMINAL's
pipelines may use. Linking needs both *Add connectors and credentials* in the
TERMINAL and being the ERP's Owner or an Admin (two-factor on both sides);
either side can unlink, and both activity logs record it.

* ERP source nodes (ERP Data, ERP Summary, Customers, Invoices…) have an
  **ERP** setting: this workspace, or a linked ERP.
* **Add to ERP list** (output) adds rows to a linked ERP's customers,
  suppliers or products (master data only, as imports). Columns are matched
  to the list's fields by name; `name` is required. A row whose name
  (products: SKU) is already there is skipped, or updated with *update
  them*. At most 20,000 rows a run. Only background runs write; the editor
  shows how many rows would be added.
* Every read and write runs as the person running the pipeline, with their
  rights in the ERP: a member of the TERMINAL who is not a member of the ERP
  reads nothing from it.

## Security model

* **Every request is the user's own session.** The app and the worker set role
  `authenticated` and the user's claims; row-level security and the ERP's rules
  decide. A job runs with the rights (and two-factor level) of the user who
  asked for it, a schedule with its creator's, a chain with whoever linked it.
* **One real table per dataset** (`ps_data.ds_<id>`, columns `c_<n>` named by
  the server, never by users). Tables are created and changed only by the
  worker through fixed functions in `ps_admin`, owned by the role `etna_ddl`;
  the app's role never runs DDL.
* **Users never read a table directly**: only the view `ps_data.dsv_<id>`,
  which leaves out hidden columns and removed rows and masks sensitive columns
  unless the user has *See sensitive data* **and** a two-factor session. The
  tables have row-level security enabled and forced, checked against
  `ps_can_access_dataset` (role permission, plus the list for restricted
  datasets).
* **Writes** go through `ps_rows_*` functions that check the permission again,
  keep the row count, refuse growth when the storage quota is full (manual
  edits are always allowed) and tag each row with its source, so a retried
  import or run first removes what its earlier attempt wrote.
* **Nobody grants more than they hold** on a restricted list.
* **Everything is logged**: dataset reads, exports, imports and pipeline writes
  in the data-access log; schema, access, schedule and import events in the
  workspace activity log.
* **Exports** (CSV) need `datasets.export` and a two-factor session.

## Connections to other ERPs (P2)

**TERMINAL → Connections** links another ERP and copies its lists into
datasets: customers, suppliers, products, sales invoices and purchase
invoices, with the same columns whatever the ERP (`src/lib/terminal/connectors.ts`).

| ERP | How PrintStream signs in | "Changed since" | Built from |
|---|---|---|---|
| Odoo (13+) | JSON-RPC; database, user, API key | `write_date` | Odoo's external API docs |
| SAP Business One | Service Layer `/Login`; company DB, user, password; optional pinned certificate | `UpdateDate` (a day is read again, updated by key) | Service Layer OData conventions |
| Accurate Online | OAuth with the company's Accurate developer app; database chosen after authorising | `filter.lastUpdate` | Accurate's published API and OpenAPI; some field names to confirm live |
| Jurnal by Mekari | Mekari HMAC (client ID and secret from Mekari) | none (full read every run) | Mekari's HMAC docs; list paths and fields to confirm live |

**Until each has been tested against a live account, treat it as not yet
verified.** Errors name what went wrong (sign-in refused, unknown list,
server down).

* **Who:** members with *Add connectors and credentials* (and a two-factor
  sign-in) add, change and remove connections; *Use approved connectors*
  sees them and runs syncs. TERMINAL must be added to the ERP.
* **Secrets** (passwords, API keys, OAuth tokens) are sealed with AES-256-GCM
  by the app (`src/server/vault.ts`, key derived from `MFA_ENCRYPTION_KEY`)
  and stored apart (`etna_platform.connection_secrets`), readable only by the
  worker. They are never shown again; to change one, type it again.
* **Network guard** (`src/server/connectors/http.ts`): only public internet
  addresses over HTTPS; the address checked is the address connected to;
  30 s per request, 50 MB answers, 5 requests a second, three retries.
  Internal servers (e.g. an SAP B1 server in the client's network) must be
  listed by a super admin in **Admin → Governance → Connector networks**
  (every company) or **Tunnels** (one company, one host:port; see
  [TUNNELS.md](TUNNELS.md)); loopback and cloud metadata addresses are always
  refused. Headers (keys, tokens, signatures) go to the first origin only: a
  redirect to another origin is followed without them.
* **Syncs** run in the worker as the person who started or scheduled them,
  through the same row functions as imports. Incremental runs update rows by
  id; a full read every few days (and every run for Jurnal) marks removed the
  rows the ERP no longer has. Schedules work as for pipelines; three failures
  in a row switch one off.

## Database sources (P2)

A connection of kind **PostgreSQL database** reads another PostgreSQL
database (`src/server/connectors/postgres.ts`, `src/lib/terminal/dbSource.ts`).
**Sync a table or query** asks the worker for the tables and views the
database user may read, then for a table's (or query's) columns; the user
checks each column's type and picks:

* **Key**: rows are updated by it (a table's one-column primary key is
  proposed). Without a key every run reads everything and replaces the rows.
* **"Changed" column** (a date, time or whole number, with a key): later runs
  read only rows with a value at or after the last one seen (the boundary row
  is read again and updated, never doubled); a full read every few days also
  removes rows the database no longer has.

A connection can have any number of these syncs, each into its own dataset.

* **A query** is any SQL the database accepts as one statement in a
  read-only transaction; adding one needs *Add connectors and credentials*
  and a two-factor sign-in, and the query is kept in the activity log.
  Syncing a table needs *Use approved connectors*.
* **Use a database user that may only read what PrintStream should see.**
  Every read is also read-only (the session's default and the transaction),
  with a 5-minute statement limit.
* **Network and TLS:** the host is checked like an ERP's (public addresses
  only, unless listed under *Connector networks*). TLS is required and the
  certificate verified ("verify-full"; a CA certificate can be given for
  private CAs; "verify-ca" skips only the host name). No encryption is
  allowed only for internal hosts ETNA allows.
* Timestamps without a time zone are read as Western Indonesian Time
  (UTC+7) in the dataset. Database error messages are not kept, only their
  kind (sign-in refused, not allowed to read, query refused, TLS failed…).

## REST APIs (P2)

A connection of kind **REST API (any)** reads any web API that answers in
JSON (`src/server/connectors/rest.ts`, `src/lib/terminal/restSource.ts`). The
connection holds the base address and the sign-in; **Sync an endpoint** adds
one endpoint at a time, each into its own dataset.

* **Sign-in:** none; an API key (header or query parameter); a bearer token;
  Basic; OAuth2 client credentials (tokens fetched, kept sealed, renewed, and
  fetched again after a 401); OAuth2 authorisation code (**Authorise** sends
  the person to the provider's consent page with PKCE and a sealed state; the
  callback is `<ETNA address>/api/terminal/connectors/oauth`, which must be
  registered at the provider; refresh tokens are kept sealed and renewed;
  **Revoke access** revokes them at the provider when it has a revocation
  address, and forgets them); signed requests (an HMAC over a template of the
  request with placeholders such as `{method}`, `{path}`, `{timestamp}`,
  `{body_sha256}`, sent in headers you write, or Mekari's rules). Extra
  headers (plain or secret) and a client certificate for mutual TLS work with
  any of them, as does a pinned server certificate.
* **Templates** (GitHub, Stripe, Shopify, Notion) only fill in the forms;
  they have not been checked against each service.
* **Endpoints:** GET, or POST with a JSON body sent with every request ("POST
  as query"). A POST endpoint could change something in a careless API, so
  syncing one needs *Add connectors and credentials* and a two-factor sign-in,
  like a database query; a GET needs *Use approved connectors*.
* **Wizard:** 1. the endpoint (picked from the connection's OpenAPI
  description, JSON, OpenAPI 3 or Swagger 2, which also suggests where the
  records are, the paging and the columns; or an example; or typed); 2. where
  the records are and how it pages, checked by reading the first page; 3. the
  columns (nested objects become `a.b` columns up to three levels, lists are
  kept as JSON text; fields the first page lacks come from the OpenAPI
  description), the key and the "changed" column.
* **Pages:** page number and size; offset and limit (the offset moves by what
  came back, so an API that gives fewer than asked skips nothing); cursor /
  next token (from the answer, or `$last.<field>` of the last record); next
  page address in the answer; HTTP `Link: rel="next"`. Parameters go in the
  query or, for POST, in the body. Without a "more pages" field a page shorter
  than the longest so far is the last. A next address on another origin, or a
  cursor, address or page seen before, stops the run with an error.
* **Limits:** the guard's (30 s a request, three retries, 5 requests a
  second, 50 MB an answer), 10,000 pages and 2 hours a run.
* **Incremental and deletions:** with a key, a "changed" column and the API's
  "changed since" parameter, later runs send the newest value seen and update
  rows by key; a full read every few days (and every run otherwise) marks
  removed the records the API no longer returns. Without a key every run
  replaces the rows.

Not yet verified against live APIs: everything above is tested with
simulated APIs only.

## Websites (P2)

A connection of kind **Website** is one site (its origin); **Sync from the
site** reads its public pages, feeds or files as the server sends them. No
JavaScript runs (`src/server/connectors/web.ts`, `src/lib/terminal/webSource.ts`,
and a small HTML/XML reader with CSS selectors in `src/lib/terminal/html.ts`).

* **Pages:** a list of paths or addresses on the site (up to 100), or the
  site's sitemap (a sitemap index is followed one level; an optional text
  filter keeps matching addresses); HTML pages can also follow a "next page"
  link given as a CSS selector. At most 1,000 pages a run (100 by default).
* **What to read:** an HTML table (the header row names the columns), repeated
  items (an item selector and fields: a selector inside the item and the text
  or an attribute; links and images become full addresses), JSON-LD
  (schema.org data, optionally only some `@type`s), an RSS or Atom feed (id,
  title, link, published, updated, author, summary, category), or a JSON, CSV
  or XML file. Every row keeps the address it came from (`_url`).
* **Manners:** robots.txt is read first and obeyed (the PrintStream group, else
  `*`; a robots.txt that answers with a server error stops the run); one
  request a second, or the site's Crawl-delay up to 10 s; pages, links and
  redirects stay on the site, through the network guard.
* **Change detection:** each run reads everything and hashes it; when the hash
  is the last run's, the dataset is left as it is. Otherwise rows are updated
  by the key (or replaced without one) and rows no longer found are marked
  removed. At most 200,000 rows a run.
* Syncing needs *Use approved connectors*. Use it only for sites whose terms
  allow it.

Not yet verified against live sites: tested with simulated sites only.

## Remote MCP servers (P2, read)

A connection of kind **MCP server (remote)** is a Model Context Protocol
server reached over **Streamable HTTP** (`src/server/connectors/mcp.ts`,
`src/lib/terminal/mcpSource.ts`). PrintStream speaks the protocol itself
through the network guard (no MCP library opens its own connections); the
older HTTP+SSE transport is not supported.

* **Sign-in:** none, a bearer token, an API key header, or OAuth2 with consent
  (PKCE; the token names the server, RFC 8707). Authorisation addresses and
  the client ID left empty are found when **Authorise** is pressed: the
  server's protected resource metadata, its authorization server's metadata,
  and dynamic client registration (`src/server/connectors/mcpAuth.ts`).
* **Tools:** testing the connection (or **Tools → Ask the server again**)
  lists the server's tools with their input schemas and read-only hints into
  `ps_mcp_tools`, each with a fingerprint of everything the server says about
  it. A member with *Add connectors and credentials* and a two-factor sign-in
  approves a tool **for reading**; the approval holds only while the
  fingerprint is the same, so a server that changes a tool's description or
  schema loses the approval until someone approves it again. Approvals are in
  the activity log. Tools that act (risk tiers above "read") come with the
  approvals of phase 4.
* **Descriptions** are the server's own words: shown as quoted text, never
  followed as instructions (no model reads them in P2).
* **Syncs** call one approved tool with fixed arguments, or read one
  resource, every run; results become records (structured content, else JSON
  text, else one row per text item; images are not kept). Rows are updated by
  the key or replaced, and rows no longer returned are marked removed. The
  dataset's lineage names the connection and the sync.

Not yet verified against a live MCP server: tested with simulated servers.

## Intelligence (P3): insights and AI

**TERMINAL → Insights** analyses a dataset; **TERMINAL → AI** sets up who may
help and with what (`src/lib/terminal/stats.ts`, `insights.ts`,
`aiProviders.ts`; `src/server/ai/providers.ts`, `src/server/terminal/aiJobs.ts`).

* **Statistics first.** A forecast (Holt's linear smoothing, 95% interval),
  anomalies (rolling median and modified z-score above 3.5) or a profile
  (counts, distinct values, ranges, top values of non-sensitive text) is
  computed by the worker from the dataset as the person who asked (row-level
  security, masking and the data-access log apply). Periods without rows count
  as 0 for sums and counts. Each result is a **decision** (`ps_decisions`):
  inputs, method and version, numbered evidence, output and confidence.
* **AI narrative, optional.** Anthropic, OpenAI, Azure OpenAI, Ollama or any
  OpenAI-compatible endpoint, behind one interface, with capabilities and
  prices as declared. The narrative only explains the evidence, cites it by
  id, and is always labelled **AI inference** with its provider and model.
  The prompt fences company data as data, never instructions.
* **Deny by default (R-18).** A provider sees a dataset only once a member
  with *Set policies* and two-factor allows it, sensitive columns one by one;
  it gets aggregates and statistics, and real rows only up to the number the
  policy allows (none by default). **Before a run** the disclosure shows the
  provider, model, columns, sensitive columns, rows and estimated cost; a run
  that is not allowed does not start. Every call is metered (`ps_ai_usage`)
  and in the data-access log (kind `ai`, operation `send`, with the sensitive
  columns sent).
* **Keys.** Workspace keys are added by members with *Add connectors and
  credentials* and two-factor, sealed like connector secrets. A provider may
  let members add their own key, used only for runs they start themselves.
* **Budget (R-46).** A monthly limit set by the workspace; without one the
  workspace's keys are not used, and a run that would go over it is refused.
  Members' own keys are not counted.
* **People (R-42).** Analyses of datasets about people (marked so under the
  dataset's **Meaning**, or using sensitive columns) are flagged and, unless
  the Owner chose otherwise, sent for human review. Anyone who sees a decision
  can ask for a review; a member with *Decide approvals* other than the person
  who ran it records it. Legal advice is recommended before automating.
* **Meaning (R-44).** A dataset's **Meaning** tab maps it to one of the ERP's
  entity types (`src/lib/ontology`) or a type of the company's own, with its
  key and links to other datasets (`ps_dataset_entities`); narratives get it.
* **Local models.** Ollama on ETNA's own server is reachable only at
  addresses a super admin lists in **Admin → Governance → Local AI servers**.
* **Market data (R-43)** comes from APIs the company connects itself (REST
  connections); PrintStream ships no vendor list.

Not yet verified against live AI providers: tested with simulated providers.

## The worker

`scripts/server/worker.mjs` signs in as `etna_worker` (`WORKER_DATABASE_URL`).
On a server, the `\ETNA\Server` task's runner (`run.mjs`) starts it beside the
app and restarts it if it stops; **etna.bat → Health check** shows whether it
reports and whether jobs wait too long. Locally: `npm run worker`.

* Jobs are claimed under a 60-second lease kept by a heartbeat; a lost
  worker's jobs go back to the queue (up to 3 attempts, with backoff). One job
  per company at a time, so a company's jobs run in order.
* Maintenance it queues itself: data-access log partitions and retention
  purge (daily), removed dataset rows past 7 days and import files 30 days
  after the import (daily), storage measurement (every 6 hours), company
  deletions confirmed by the security officer (hourly).
* It needs Node.js 22.6 or newer (it runs the server's TypeScript sources
  directly; 22.18+ without a flag). On older Node.js it exits with code 3 and
  `run.mjs` tries again hourly.
* `ETNA_WORKER_DEBUG=1` logs error messages (they can contain data: only
  while investigating).

## Files

Uploads are streamed to `<company folder>\imports\<id>.csv|xlsx` (the
company's own storage folder from **etna.bat → Company storage**, else
`<ETNA_DATA_ROOT>\companies\<id>\imports`) after room is reserved against the
company's quota.

## Database

| Migration | Contents |
|---|---|
| `20261012000035_terminal_jobs` | Job queue, schedules, chains, worker functions (`ps_worker`) |
| `20261012000036_terminal_datasets` | `etna_ddl`, `ps_data`/`ps_admin`, dataset metadata, access, masking, row functions, provisioning |
| `20261012000037_terminal_imports` | Imports and rejected rows |
| `20261012000038_terminal_pipelines` | Pipeline access and on/off, background runs tied to the worker's job |
| `20261012000039_terminal_module` | TERMINAL added per ERP (`erp_set_terminal`); off, no new jobs, writes or scheduled runs |
| `20261012000040_company_export` | The Owner's export of a company being terminated |
| `20261012000041_terminal_connectors` | Connections, sealed secrets, syncs, connector networks |
| `20261012000042_terminal_db_sources` | PostgreSQL connections; syncs of tables and queries |
| `20261012000043_terminal_spaces` | TERMINALs on their own (`erp_workspaces.kind`), their limit apart from ERPs' |
| `20261012000044_terminal_erp_links` | Links from a TERMINAL to ERPs (`ps_erp_links`) |
| `20261012000046_terminal_rest_tunnels` | REST API connections and endpoint syncs; tunnels allowed per company (`etna_platform.network_allowlist`) |
| `20261012000047_terminal_web` | Website connections and their syncs |
| `20261012000048_terminal_mcp` | MCP connections, their tools and approvals (`ps_mcp_tools`) |
| `20261012000049_terminal_ai` | AI providers and keys, data policies, budget and usage, decisions, dataset meaning, local AI servers |

Each has a rollback in `db/rollback/` (apply them newest first; rolling back
036 drops every dataset).
