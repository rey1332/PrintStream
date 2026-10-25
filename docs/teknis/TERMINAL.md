# PrintStream Terminal

Terminal is the data module of PrintStream (by ETNA): **datasets**,
**imports**, **pipelines** and **connections**, run in the background by a
separate worker. A Terminal is one of two things:

- **A Terminal on its own** (Dashboard → Add modules → PrintStream Terminal →
  _New Terminal_): its own members, roles and invitations (**Members** on the
  Terminal screen), no ERP needed, and it does not use one of the account's
  three ERP slots (an account belongs to at most 10 Terminals). Its Owner can
  delete it (with the password). It never appears among the ERPs.
- **An ERP's Terminal**: added to an ERP by its Owner or an Admin, working with
  that ERP's members and data. Removing it hides Terminal and stops new jobs,
  writes and scheduled runs; nothing is deleted, and adding it again brings
  everything back.

Both are listed under **Terminal** in the Dashboard sidebar and open on their
own screen (`/terminal`), which remembers its own choice: opening a Terminal
never opens or switches an ERP.

It replaces Workflows: every existing workflow is now a pipeline (same tables,
same editor at `/erp/workflows/[id]`), and ERPs that had workflows start with
Terminal added. `/erp/workflows` and `/erp/terminal` lead to `/terminal`.

This document covers phase 1 (P1) and the connectors of phase 2 (P2) built so
far. AI and approvals (P3–P4) are designed in the specification but not built yet.

## What a company can do

| Area        | What it is                                                                                                                                                                                                                                                                                                                                                          | Who (default roles)                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Datasets    | Tables the company defines: typed columns (text, whole number, number, yes/no, date, date and time, JSON), a key, sensitive and hidden columns, a folder, workspace or restricted access                                                                                                                                                                            | Owner, Admin; Finance views, imports, edits and exports |
| Grid        | Page through rows, sort, add, change (double-click) and remove rows (deleted for good after 7 days)                                                                                                                                                                                                                                                                 | `datasets.edit`                                         |
| Imports     | Upload CSV/TSV/TXT (up to the company's limit, 200 MB by default) or Excel (50 MB). The worker detects encoding, separator, header, `1.234,56` vs `1,234.56` and column types; the user maps columns to a new dataset, an existing one (add, update by key, replace) or an ERP list (customers, suppliers, products). Rows that do not fit are kept with the reason | `datasets.import` (+ the ERP permission for ERP lists)  |
| Pipelines   | The visual editor, in its own window (`/pipelines/[id]`, no ERP around it), with **Dataset** (read), **Write to dataset** and the unified-data nodes below. Runs in the editor never write; **Run now**, schedules and chains run the published version in the background and write                                                                                 | `pipelines.*`                                           |
| Schedules   | Daily, weekly, monthly, every N minutes (≥ 5), or cron; in the schedule's time zone; three failures in a row switch it off                                                                                                                                                                                                                                          | `pipelines.schedule`                                    |
| Chains      | "Then run…": pipelines that run after another succeeds; loops are refused                                                                                                                                                                                                                                                                                           | `pipelines.schedule`                                    |
| Jobs        | What the worker did, with errors; queued and running jobs can be cancelled                                                                                                                                                                                                                                                                                          | anyone who started them, `pipelines.disable`            |
| Command bar | **Ctrl+K** (⌘K) jumps to datasets, pipelines and tabs                                                                                                                                                                                                                                                                                                               | everyone                                                |

Uploads are CSV files (`.csv`) only; Excel files imported before stay readable.

### Nodes for unified data

The palette groups them (and has a search box). They run alike in the editor
and in background runs (`src/lib/workflow/unifyNodes.ts`).

| Group           | Nodes                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Combine & Clean | Stack Tables (two tables by column name, optional source column), Remove Duplicates (by key, keep first or last), Fill Missing (value, previous, zero, average), Change Type (text, number, whole number, date incl. dd/mm/yyyy, yes/no; unreadable values left empty and counted), Clean Text (trim, single spaces, case), Split Column, Combine Columns |
| Match Records   | Lookup (columns from a second table by equal key), Fuzzy Match (names written differently: legal forms such as PT/CV/Tbk, punctuation and word order ignored; a score from 0 to 1 and a threshold; at most 4 million comparisons), Standardize Values (`from=to; from=to`)                                                                                |
| Reshape         | Pivot (at most 200 new columns), Unpivot, Running Values (running total or count, row number, rank, previous value, change, % of group total; per group, in an order), Date Part, Date Difference                                                                                                                                                         |
| Data Quality    | Profile Columns, Check Rules (outputs _Valid_ and _Not valid_, the latter with `_reason`: missing, not a number or date, out of range, not an allowed value, duplicate key), Find Outliers (IQR or z-score; `is_outlier`, `outlier_score`)                                                                                                                |

### Syncing with ERPs (a Terminal on its own)

**Linked ERPs** on the Terminal screen lists the ERPs this Terminal's
pipelines may use. Linking needs both _Add connectors and credentials_ in the
Terminal and being the ERP's Owner or an Admin (two-factor on both sides);
either side can unlink, and both activity logs record it.

- ERP source nodes (ERP Data, ERP Summary, Customers, Invoices…) have an
  **ERP** setting: this workspace, or a linked ERP.
- **Add to ERP list** (output) adds rows to a linked ERP's customers,
  suppliers or products (master data only, as imports). Columns are matched
  to the list's fields by name; `name` is required. A row whose name
  (products: SKU) is already there is skipped, or updated with _update
  them_. At most 20,000 rows a run. Only background runs write; the editor
  shows how many rows would be added.
- Every read and write runs as the person running the pipeline, with their
  rights in the ERP: a member of the Terminal who is not a member of the ERP
  reads nothing from it.

## Security model

- **Every request is the user's own session.** The app and the worker set role
  `authenticated` and the user's claims; row-level security and the ERP's rules
  decide. A job runs with the rights (and two-factor level) of the user who
  asked for it, a schedule with its creator's, a chain with whoever linked it.
- **One real table per dataset** (`ps_data.ds_<id>`, columns `c_<n>` named by
  the server, never by users). Tables are created and changed only by the
  worker through fixed functions in `ps_admin`, owned by the role `etna_ddl`;
  the app's role never runs DDL.
- **Users never read a table directly**: only the view `ps_data.dsv_<id>`,
  which leaves out hidden columns and removed rows and masks sensitive columns
  unless the user has _See sensitive data_ **and** a two-factor session. The
  tables have row-level security enabled and forced, checked against
  `ps_can_access_dataset` (role permission, plus the list for restricted
  datasets).
- **Writes** go through `ps_rows_*` functions that check the permission again,
  keep the row count, refuse growth when the storage quota is full (manual
  edits are always allowed) and tag each row with its source, so a retried
  import or run first removes what its earlier attempt wrote.
- **Nobody grants more than they hold** on a restricted list.
- **Everything is logged**: dataset reads, exports, imports and pipeline writes
  in the data-access log; schema, access, schedule and import events in the
  workspace activity log.
- **Exports** (CSV) need `datasets.export` and a two-factor session.

## Connections to other ERPs (P2)

**Terminal → Connections** links another ERP and copies its lists into
datasets: customers, suppliers, products, sales invoices and purchase
invoices, with the same columns whatever the ERP (`src/lib/terminal/connectors.ts`).

| ERP              | How PrintStream signs in                                                           | "Changed since"                                    | Built from                                                             |
| ---------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| Odoo (13+)       | JSON-RPC; database, user, API key                                                  | `write_date`                                       | Odoo's external API docs                                               |
| SAP Business One | Service Layer `/Login`; company DB, user, password; optional pinned certificate    | `UpdateDate` (a day is read again, updated by key) | Service Layer OData conventions                                        |
| Accurate Online  | OAuth with the company's Accurate developer app; database chosen after authorising | `filter.lastUpdate`                                | Accurate's published API and OpenAPI; some field names to confirm live |
| Jurnal by Mekari | Mekari HMAC (client ID and secret from Mekari)                                     | none (full read every run)                         | Mekari's HMAC docs; list paths and fields to confirm live              |

**Until each has been tested against a live account, treat it as not yet
verified.** Errors name what went wrong (sign-in refused, unknown list,
server down).

- **Who:** members with _Add connectors and credentials_ (and a two-factor
  sign-in) add, change and remove connections; _Use approved connectors_
  sees them and runs syncs. Terminal must be added to the ERP.
- **Secrets** (passwords, API keys, OAuth tokens) are sealed with AES-256-GCM
  by the app (`src/server/vault.ts`, key derived from `MFA_ENCRYPTION_KEY`)
  and stored apart (`etna_platform.connection_secrets`), readable only by the
  worker. They are never shown again; to change one, type it again.
- **Network guard** (`src/server/connectors/http.ts`): only public internet
  addresses over HTTPS; the address checked is the address connected to;
  30 s per request, 50 MB answers, 5 requests a second, three retries.
  Internal servers (e.g. an SAP B1 server in the client's network) must be
  listed by a super admin in **Admin → Governance → Connector networks**
  (every company) or **Tunnels** (one company, one host:port; see
  [TUNNELS.md](TUNNELS.md)); loopback and cloud metadata addresses are always
  refused. Headers (keys, tokens, signatures) go to the first origin only: a
  redirect to another origin is followed without them.
- **Syncs** run in the worker as the person who started or scheduled them,
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

- **Key**: rows are updated by it (a table's one-column primary key is
  proposed). Without a key every run reads everything and replaces the rows.
- **"Changed" column** (a date, time or whole number, with a key): later runs
  read only rows with a value at or after the last one seen (the boundary row
  is read again and updated, never doubled); a full read every few days also
  removes rows the database no longer has.

A connection can have any number of these syncs, each into its own dataset.

- **A query** is any SQL the database accepts as one statement in a
  read-only transaction; adding one needs _Add connectors and credentials_
  and a two-factor sign-in, and the query is kept in the activity log.
  Syncing a table needs _Use approved connectors_.
- **Use a database user that may only read what PrintStream should see.**
  Every read is also read-only (the session's default and the transaction),
  with a 5-minute statement limit.
- **Network and TLS:** the host is checked like an ERP's (public addresses
  only, unless listed under _Connector networks_). TLS is required and the
  certificate verified ("verify-full"; a CA certificate can be given for
  private CAs; "verify-ca" skips only the host name). No encryption is
  allowed only for internal hosts ETNA allows.
- Timestamps without a time zone are read as Western Indonesian Time
  (UTC+7) in the dataset. Database error messages are not kept, only their
  kind (sign-in refused, not allowed to read, query refused, TLS failed…).

## REST APIs (P2)

A connection of kind **REST API (any)** reads any web API that answers in
JSON (`src/server/connectors/rest.ts`, `src/lib/terminal/restSource.ts`). The
connection holds the base address and the sign-in; **Sync an endpoint** adds
one endpoint at a time, each into its own dataset.

- **Sign-in:** none; an API key (header or query parameter); a bearer token;
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
- **Templates** (GitHub, Stripe, Shopify, Notion) only fill in the forms;
  they have not been checked against each service.
- **Endpoints:** GET, or POST with a JSON body sent with every request ("POST
  as query"). A POST endpoint could change something in a careless API, so
  syncing one needs _Add connectors and credentials_ and a two-factor sign-in,
  like a database query; a GET needs _Use approved connectors_.
- **Wizard:** 1. the endpoint (picked from the connection's OpenAPI
  description, JSON, OpenAPI 3 or Swagger 2, which also suggests where the
  records are, the paging and the columns; or an example; or typed); 2. where
  the records are and how it pages, checked by reading the first page; 3. the
  columns (nested objects become `a.b` columns up to three levels, lists are
  kept as JSON text; fields the first page lacks come from the OpenAPI
  description), the key and the "changed" column.
- **Pages:** page number and size; offset and limit (the offset moves by what
  came back, so an API that gives fewer than asked skips nothing); cursor /
  next token (from the answer, or `$last.<field>` of the last record); next
  page address in the answer; HTTP `Link: rel="next"`. Parameters go in the
  query or, for POST, in the body. Without a "more pages" field a page shorter
  than the longest so far is the last. A next address on another origin, or a
  cursor, address or page seen before, stops the run with an error.
- **Limits:** the guard's (30 s a request, three retries, 5 requests a
  second, 50 MB an answer), 10,000 pages and 2 hours a run.
- **Incremental and deletions:** with a key, a "changed" column and the API's
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

- **Pages:** a list of paths or addresses on the site (up to 100), or the
  site's sitemap (a sitemap index is followed one level; an optional text
  filter keeps matching addresses); HTML pages can also follow a "next page"
  link given as a CSS selector. At most 1,000 pages a run (100 by default).
- **What to read:** an HTML table (the header row names the columns), repeated
  items (an item selector and fields: a selector inside the item and the text
  or an attribute; links and images become full addresses), JSON-LD
  (schema.org data, optionally only some `@type`s), an RSS or Atom feed (id,
  title, link, published, updated, author, summary, category), or a JSON, CSV
  or XML file. Every row keeps the address it came from (`_url`).
- **Manners:** robots.txt is read first and obeyed (the PrintStream group, else
  `*`; a robots.txt that answers with a server error stops the run); one
  request a second, or the site's Crawl-delay up to 10 s; pages, links and
  redirects stay on the site, through the network guard.
- **Change detection:** each run reads everything and hashes it; when the hash
  is the last run's, the dataset is left as it is. Otherwise rows are updated
  by the key (or replaced without one) and rows no longer found are marked
  removed. At most 200,000 rows a run.
- Syncing needs _Use approved connectors_. Use it only for sites whose terms
  allow it.

Not yet verified against live sites: tested with simulated sites only.

## Spreadsheets online (P2)

A connection of kind **Google Sheets / Excel online**
(`db/migrations/20261012000063_terminal_sheets.sql`,
`src/server/connectors/sheets.ts`, `src/lib/terminal/sheetSource.ts`) reads
tabs of spreadsheets into datasets, so nobody exports and uploads a file every
week. **Sync a sheet** takes the sheet's address, a tab (the first one, or for
Google the tab in the address, when empty), an optional range (`A1:H500`) and
the header row; it reads the sheet once to show the columns and a few rows.

- **Google, anyone with the link:** nothing to sign in. The tab is read as
  CSV (`/export?format=csv&gid=…`, or `/gviz/tq` for a named tab). A private
  sheet answers with a sign-in page, which is reported as *not shared*.
- **Google, service account:** the sheet is shared (Viewer) with a service
  account; its JSON key is sealed in the vault. Each run signs a JWT for the
  read-only Sheets scope, and reads the values unformatted (numbers stay
  numbers) with dates as shown.
- **Microsoft (OneDrive for work, SharePoint):** an app registration in
  Microsoft Entra with the **Files.Read.All** application permission (admin
  consent); tenant, client id and secret (sealed). The workbook is found from
  its sharing link (Graph `/shares/u!…/driveItem`) and read with the workbook
  API: the used range or the given range, with number formats, so date cells
  become dates (Excel serial days). Personal OneDrive accounts are not
  supported.
- **Rows:** the header row names the columns (trimmed, unique: "Ton",
  "Ton (2)"; empty names become "Column 4"); rows above it and empty rows are
  left out. Columns mixing numbers and numeric text are read as numbers. At
  most 100,000 rows and 2,000,000 cells a sheet.
- **Change detection:** like a website, each run hashes what it read and
  leaves the dataset as it is when nothing changed; with a key column rows are
  updated in place, without one they are replaced.
- Syncing needs _Use approved connectors_; every request goes through the
  network guard.

Not yet verified against live Google or Microsoft accounts: tested with
simulated answers only.

## Remote MCP servers (P2, read)

A connection of kind **MCP server (remote)** is a Model Context Protocol
server reached over **Streamable HTTP** (`src/server/connectors/mcp.ts`,
`src/lib/terminal/mcpSource.ts`). PrintStream speaks the protocol itself
through the network guard (no MCP library opens its own connections); the
older HTTP+SSE transport is not supported.

- **Sign-in:** none, a bearer token, an API key header, or OAuth2 with consent
  (PKCE; the token names the server, RFC 8707). Authorisation addresses and
  the client ID left empty are found when **Authorise** is pressed: the
  server's protected resource metadata, its authorization server's metadata,
  and dynamic client registration (`src/server/connectors/mcpAuth.ts`).
- **Tools:** testing the connection (or **Tools → Ask the server again**)
  lists the server's tools with their input schemas and read-only hints into
  `ps_mcp_tools`, each with a fingerprint of everything the server says about
  it. A member with _Add connectors and credentials_ and a two-factor sign-in
  approves a tool **for reading**; the approval holds only while the
  fingerprint is the same, so a server that changes a tool's description or
  schema loses the approval until someone approves it again. Approvals are in
  the activity log. Tools that act (risk tiers above "read") come with the
  approvals of phase 4.
- **Descriptions** are the server's own words: shown as quoted text, never
  followed as instructions (no model reads them in P2).
- **Syncs** call one approved tool with fixed arguments, or read one
  resource, every run; results become records (structured content, else JSON
  text, else one row per text item; images are not kept). Rows are updated by
  the key or replaced, and rows no longer returned are marked removed. The
  dataset's lineage names the connection and the sync.

Not yet verified against a live MCP server: tested with simulated servers.

## Intelligence (P3): insights and AI

**Terminal → Insights** analyses a dataset; **Terminal → AI** sets up who may
help and with what (`src/lib/terminal/stats.ts`, `insights.ts`,
`aiProviders.ts`; `src/server/ai/providers.ts`, `src/server/terminal/aiJobs.ts`).

- **Statistics first.** A forecast (Holt's linear smoothing, 95% interval),
  anomalies (rolling median and modified z-score above 3.5) or a profile
  (counts, distinct values, ranges, top values of non-sensitive text) is
  computed by the worker from the dataset as the person who asked (row-level
  security, masking and the data-access log apply). Periods without rows count
  as 0 for sums and counts. Each result is a **decision** (`ps_decisions`):
  inputs, method and version, numbered evidence, output and confidence.
- **AI narrative, optional.** Anthropic, OpenAI, Azure OpenAI, Ollama or any
  OpenAI-compatible endpoint, behind one interface, with capabilities and
  prices as declared. The narrative only explains the evidence, cites it by
  id, and is always labelled **AI inference** with its provider and model.
  The prompt fences company data as data, never instructions.
- **Deny by default (R-18).** A provider sees a dataset only once a member
  with _Set policies_ and two-factor allows it, sensitive columns one by one;
  it gets aggregates and statistics, and real rows only up to the number the
  policy allows (none by default). **Before a run** the disclosure shows the
  provider, model, columns, sensitive columns, rows and estimated cost; a run
  that is not allowed does not start. Every call is metered (`ps_ai_usage`)
  and in the data-access log (kind `ai`, operation `send`, with the sensitive
  columns sent).
- **Keys.** Workspace keys are added by members with _Add connectors and
  credentials_ and two-factor, sealed like connector secrets. A provider may
  let members add their own key, used only for runs they start themselves.
- **Budget (R-46).** A monthly limit set by the workspace; without one the
  workspace's keys are not used, and a run that would go over it is refused.
  Members' own keys are not counted.
- **People (R-42).** Analyses of datasets about people (marked so under the
  dataset's **Meaning**, or using sensitive columns) are flagged and, unless
  the Owner chose otherwise, sent for human review. Anyone who sees a decision
  can ask for a review; a member with _Decide approvals_ other than the person
  who ran it records it. Legal advice is recommended before automating.
- **Meaning (R-44).** A dataset's **Meaning** tab maps it to one of the ERP's
  entity types (`src/lib/ontology`) or a type of the company's own, with its
  key and links to other datasets (`ps_dataset_entities`); narratives get it.
- **Local models.** Ollama on ETNA's own server is reachable only at
  addresses a super admin lists in **Admin → Governance → Local AI servers**.
- **Market data (R-43)** comes from APIs the company connects itself (REST
  connections); PrintStream ships no vendor list.

Not yet verified against live AI providers: tested with simulated providers.

## Jobs and what needs attention

- **Jobs** (Overview → Recent jobs, and the Jobs tab): the same work that
  ended the same way in a row is one line with a count (×8), opened to see
  each. A line says why a job failed (the error in words) or who cancelled it.
  **Run again** queues a new job with the same work for a failed or cancelled
  pipeline run, sync, connection or AI provider check, export or file
  analysis; it needs the permission to start that job, and a retry already
  waiting is reused (`ps_retry_job`). The Jobs tab filters by failed or
  cancelled, waiting or running, succeeded, and by kind.
- **Needs attention** (Overview): the background worker not running while
  jobs or schedules wait (it reports every 30 seconds), jobs waiting for a
  turn, pipelines whose last run failed, schedules that are late or were
  switched off after three failures, failing or stopped syncs, and datasets a
  sync or a pipeline keeps up to date that have not changed for a week. Each
  links to where to fix it. Everything is read with the member's rights.

## Query Tool (read-only SQL)

The Terminal opens as a database workbench laid out like pgAdmin 4's Query
Tool: the Object Explorer on the left (datasets and their columns, ERPs and
the lists the member may read there, PostgreSQL connections and their tables,
pipelines, the Terminal's other screens), the
Query Tool in the middle, and the Terminal's other screens as tabs beside it.
The colours follow the app's light or dark theme.

- **Layout**: the connection bar (what to query, its state, test again),
  Query / Query History (searchable, filtered by status and by what a run was
  on), the editor's tools (open and save a .sql file, find, comment, format,
  execute, explain, explain analyze, stop, save results as CSV, Scratch Pad,
  help), the SQL editor (CodeMirror 6: line numbers, PostgreSQL highlighting,
  completion of the target's table and column names, search) with the
  Scratch Pad beside it, and Data Output / Messages / Notifications below,
  then the status bar (rows, time, line and column, line endings). The
  dividers are dragged (or moved with the arrow keys when focused) and
  remembered; the Object Explorer and the Scratch Pad can be hidden (in a
  narrow window they start hidden).
- **Keys**: Ctrl+Enter or F5 runs the selection, or the statement at the
  cursor (statements are split at semicolons outside quotes, comments and
  dollar quotes); F7 explains; Ctrl+S saves the editor as a .sql file; Ctrl+F
  finds; Ctrl+/ comments lines; Shift+Alt+F formats the selection or the
  whole query (clauses, lists and conditions on their own lines, subqueries
  indented, keywords in capitals; quoted text, names and comments untouched;
  one undo step). In the results: click, Shift+click, arrows, Ctrl+A; Ctrl+C
  copies as tab-separated text (whole rows with the column names);
  double-click or Enter opens a cell's whole value (JSON laid out). The
  result can be searched and sorted by a column (numbers as numbers, NULL
  last) in the browser, on the rows kept. NULL is shown as [null], apart from
  an empty text.
- **What a query runs on** — never PrintStream's own database: row-level
  security there relies on session settings that SQL could change.
  - **This Terminal's datasets** (`datasets.query`): the worker copies the
    datasets the query names (each is a table named like the dataset, in
    "quotes" when it has capitals or spaces), as the member sees them (masked
    columns stay masked, datasets they may not query are skipped, each read is
    in the data-access log), into a new in-memory PostgreSQL (PGlite) in its
    own thread, runs the query read-only there and ends the thread. Up to
    100,000 rows per dataset and 500,000 in all are copied; Messages says when
    a dataset was larger (the result then covers the copied rows only).
  - **An ERP** (`datasets.query` in the Terminal, a member of the ERP, its
    two-factor rule): the Terminal's own ERP (a Terminal inside an ERP) or one
    it is linked to. Its lists are the analytics catalog's
    (`src/lib/analytics/catalog.ts`) under snake_case names — `customers`,
    `suppliers`, `products`, `sales_orders`, `sales_order_items`,
    `purchase_orders`, `purchase_order_items`, `invoices`, `payments`,
    `transactions`, `stock_movements`, `gl_accounts`, `journal_entries`,
    `journal_lines` — with the catalog's fields only (no owner, actor or
    personal tax columns). The worker reads the lists the query names as the
    member, with their rights in that ERP (the role's permission per list,
    row-level security), into the same sandbox, with the same limits; each
    list read is in the ERP's data-access log (`erp_list`). The selector and
    the Object Explorer show only the lists the member's role may read.
  - **A PostgreSQL connection** (`integrations.manage`, two-factor session):
    the connection's own database, in a read-only transaction (the session is
    read-only too) with a 60-second statement limit, through the same network
    guard and TLS rules as its syncs. NOTICEs are shown in Messages,
    notifications that arrive during the query in Notifications. Each run is in
    the data-access log.
- **Results**: at most 2,000 rows (and 16 MB) are kept and shown; Data Output
  and the status bar say when there were more. Column names and PostgreSQL
  types are shown; dates and times as PostgreSQL writes them. Errors come back
  as PostgreSQL gave them (message, detail, hint, SQL state, position), and the
  editor marks the place.
- **Running**: every query is a worker job (`sql.datasets`, `sql.connection`),
  so the background worker must run; the Query Tool says when it does not.
  Stop cancels the job (a connection's session is ended, the sandbox thread
  stopped). A query has 60 seconds (90 with loading the datasets). At most one
  job per company runs at a time, so a long query delays that company's other
  jobs.
- **History and retention** (`ps_sql_runs`, `db/migrations/20261012000058_terminal_query_tool.sql`;
  each member's own only): the newest 200 queries per member and Terminal
  (SQL, target, state, rows, time); a result, its messages and its error are
  kept for an hour, then removed.
- **Not supported**: changing data (INSERT/UPDATE/DELETE and DDL fail as
  read-only), several statements in one run, LISTEN across queries, graphical
  plans (plans are shown as text), formatting SQL.

## MCP access for AI assistants

An AI assistant (Claude on the web, Claude Desktop and the apps, Claude Code,
Cursor, any MCP client) can work with a Terminal over MCP: read its
pipelines, runs and datasets, analyse datasets, and, when allowed, build
pipelines (see "Building pipelines with an AI assistant" below). It connects
in one of two ways:

- **Connect with sign-in (OAuth)**, for Claude's connectors: in Claude,
  Settings → Connectors → Add custom connector, URL
  `https://<server>/api/mcp`, then Connect. PrintStream's sign-in opens; the
  member signs in (two-factor where the role needs it), sees which app asks
  and where it returns to, chooses the Terminal and approves. The app then
  appears under **Terminal → AI → MCP access → Connected apps**, where it can
  be disconnected.
- **An access token**, for clients that cannot sign in: **Terminal → AI → MCP
  access → New access token**, sent as `Authorization: Bearer psmcp_…`.

The server must be reachable over HTTPS at a public address for Claude's
connectors (they call it from Anthropic's servers): a reverse proxy or a
tunnel, with `ETNA_PUBLIC_URL` set to that address and `TRUST_PROXY`
(`cloudflare` behind Cloudflare, else `1`).

- **Endpoint**: `POST https://<server>/api/mcp` (Streamable HTTP, JSON
  responses, no event stream), header `Authorization: Bearer psmcp_…`.
  Claude Code: `claude mcp add --transport http printstream https://<server>/api/mcp --header "Authorization: Bearer psmcp_…"`.
- **Tools that read**: `list_pipelines`, `get_pipeline` (steps with their
  configuration and connections, draft or a published version, schedule,
  chains, the draft's revision), `list_pipeline_runs`, `get_pipeline_run`
  (each step: ok, time, rows, warnings, error code; no row data),
  `list_datasets`, `preview_dataset` (at most 50 rows), `list_node_types`,
  `list_erp_fields`, `validate_pipeline`, `test_pipeline`, `profile_dataset`,
  `analyze_dataset`, `get_terminal_health`.
- **Tools that write** (only for a token or connection allowed to build
  pipelines; others are not offered them): `create_pipeline`,
  `update_pipeline`.
- **What it may use** (`db/migrations/20261012000060_mcp_scopes.sql`): each
  token and connected app can be limited to some tools and, optionally, to
  some datasets and pipelines: chosen when the token is made (tools only on
  the consent page) and changed later by its owner under **Terminal → AI →
  MCP access → Change access**. Outside its scope a dataset or pipeline does
  not exist for the assistant: lists leave it out, reads say "not found", a
  graph that names it is refused, and the health report shows only what it
  may see. The database checks the writes again (the tool, the pipeline and
  every dataset of the graph). A pipeline the assistant creates joins its
  list, so it can keep editing it. Tokens and apps made before have no
  scope and keep everything.
- **Rights**: the member's own, in that Terminal only: row-level security and
  the masking views as in the app, restricted pipelines hidden, dataset
  previews in the data-access log. A token needs `pipelines.view`; where the
  role needs two-factor, the token must be made in a two-factor session.
- **Tokens** (`ps_mcp_tokens`): shown once, stored as a SHA-256 hash, 1 to 365
  days, at most 10 active per member and Terminal. A member revokes their own;
  someone with `members` revokes anyone's. A token stops working when it is
  revoked or expires, when the account is banned, or when the member leaves.
  Only the auth server role looks tokens up (`auth.mcp_token_use`).
- **Limits**: 120 calls a minute per token; 30 bad tokens a minute per
  address. Requests from a web page of another origin are refused.
- **OAuth** (`db/migrations/20261012000056_mcp_oauth.sql`,
  `src/server/mcp/oauth.ts`): discovery at
  `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-authorization-server` (the 401 of `/api/mcp` points to
  them), dynamic client registration at `POST /api/oauth/register`, the
  consent page `/oauth/authorize`, and `POST /api/oauth/token`
  (`authorization_code` with PKCE S256 only, `refresh_token`). Clients may
  register only Claude's callback (`https://claude.ai/api/mcp/auth_callback`,
  `https://claude.com/…`) and loopback addresses (`http://localhost:*`,
  `http://127.0.0.1:*`); `ETNA_MCP_OAUTH_REDIRECTS` adds others (exact, or a
  prefix ending in `/`, e.g. `cursor://anysphere.cursor-retrieval/`). Codes
  last 10 minutes and work once (a second use ends the connection); access
  tokens last an hour; refresh tokens last 30 days, renew on use (at most a
  year) and rotate (an old one used again ends the connection). Only hashes
  are stored. Registration: 10 an hour per address; token endpoint: 60 a
  minute per address.

### Building pipelines with an AI assistant

Writing is chosen per connection, off by default: **Also let it build
pipelines** when a token is made, or on the consent page when Claude
connects (shown only where the member has `pipelines.create` or
`pipelines.edit`). It cannot be switched on later: make a new token or
connect again. The lists show such connections as **Builds pipelines**.

- **Drafts only.** `create_pipeline` saves a new pipeline owned by the
  member; `update_pipeline` changes the draft of a pipeline the member made
  (as in the editor, only one's own), given the `draft_revision` read with
  `get_pipeline`, so a draft saved since in the editor is never overwritten.
  Neither publishes: background runs, schedules and chains only use published
  versions, so nothing an assistant builds runs on its own. The editor shows
  **Draft by <app>** until a person publishes the draft as it is.
- **The graph** an assistant writes is nodes `{id, type, label, config}` and
  edges `{from, to, from_port}`; configurations are merged over each node
  type's defaults, dataset sources get the dataset's columns, steps keep
  their place on the canvas and new ones are laid out left to right
  (`src/server/mcp/builder.ts`). Unusable graphs (unknown types, edges to
  nothing) are refused; other problems are saved with the draft and returned
  in words, as the editor shows them.
- **Test runs** (`test_pipeline`, for every connection): the saved draft or
  an unsaved graph runs once as the member and writes nothing (write steps
  report what they would write); a few rows of each final step come back.
  60 seconds at most, 10 test runs per 10 minutes per token.
- **Insights**: `profile_dataset` (every column over all rows) and
  `analyze_dataset` (trend with anomalies or a forecast per period), the same
  statistics as Terminal insights; the assistant explains them. Both are in
  the data-access log (`via: mcp`), and sensitive columns stay masked as in
  the app.
- **Checks in the database** (`db/migrations/20261012000057_mcp_pipeline_builder.sql`):
  `ps_mcp_pipeline_create` and `ps_mcp_pipeline_update` refuse a token that
  is not the caller's, revoked, expired, of a revoked connection, not allowed
  to write or of a suspended workspace, and check `pipelines.create` /
  `pipelines.edit`, two-factor and the draft's revision; at most 100
  pipelines a day per member through MCP. `workflows.mcp_client`,
  `mcp_edited_at` and `mcp_token_id` record the last write.

## The worker

`scripts/server/worker.mjs` signs in as `etna_worker` (`WORKER_DATABASE_URL`).
On a server, the `\ETNA\Server` task's runner (`run.mjs`) starts it beside the
app and restarts it if it stops; **the server manager → Health check** shows whether it
reports and whether jobs wait too long. Locally: `npm run worker`.

- Jobs are claimed under a 60-second lease kept by a heartbeat; a lost
  worker's jobs go back to the queue (up to 3 attempts, with backoff). One job
  per company at a time, so a company's jobs run in order.
- Maintenance it queues itself: data-access log partitions and retention
  purge (daily), removed dataset rows past 7 days and import files 30 days
  after the import (daily), storage measurement (every 6 hours), company
  deletions confirmed by the security officer (hourly).
- It needs Node.js 22.6 or newer (it runs the server's TypeScript sources
  directly; 22.18+ without a flag). On older Node.js it exits with code 3 and
  `run.mjs` tries again hourly.
- `ETNA_WORKER_DEBUG=1` logs error messages (they can contain data: only
  while investigating).

## Files

Uploads are streamed to `<company folder>\imports\<id>.csv|xlsx` (the
company's own storage folder from **the server manager → Company storage**, else
`<ETNA_DATA_ROOT>\companies\<id>\imports`) after room is reserved against the
company's quota.

## Database

| Migration                                 | Contents                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `20261012000035_terminal_jobs`            | Job queue, schedules, chains, worker functions (`ps_worker`)                                             |
| `20261012000036_terminal_datasets`        | `etna_ddl`, `ps_data`/`ps_admin`, dataset metadata, access, masking, row functions, provisioning         |
| `20261012000037_terminal_imports`         | Imports and rejected rows                                                                                |
| `20261012000038_terminal_pipelines`       | Pipeline access and on/off, background runs tied to the worker's job                                     |
| `20261012000039_terminal_module`          | Terminal added per ERP (`erp_set_terminal`); off, no new jobs, writes or scheduled runs                  |
| `20261012000040_company_export`           | The Owner's export of a company being terminated                                                         |
| `20261012000041_terminal_connectors`      | Connections, sealed secrets, syncs, connector networks                                                   |
| `20261012000042_terminal_db_sources`      | PostgreSQL connections; syncs of tables and queries                                                      |
| `20261012000043_terminal_spaces`          | Terminals on their own (`erp_workspaces.kind`), their limit apart from ERPs'                             |
| `20261012000044_terminal_erp_links`       | Links from a Terminal to ERPs (`ps_erp_links`)                                                           |
| `20261012000046_terminal_rest_tunnels`    | REST API connections and endpoint syncs; tunnels allowed per company (`etna_platform.network_allowlist`) |
| `20261012000047_terminal_web`             | Website connections and their syncs                                                                      |
| `20261012000048_terminal_mcp`             | MCP connections, their tools and approvals (`ps_mcp_tools`)                                              |
| `20261012000049_terminal_ai`              | AI providers and keys, data policies, budget and usage, decisions, dataset meaning, local AI servers     |
| `20261012000055_terminal_jobs_health_mcp` | Job retries and who cancelled, the worker's last report, MCP access tokens                               |
| `20261012000056_mcp_oauth`                | Signing in to MCP with OAuth: clients, codes, connections (grants)                                       |
| `20261012000057_mcp_pipeline_builder`     | MCP connections that may build pipelines (drafts only)                                                   |
| `20261012000058_terminal_query_tool`      | The Query Tool: runs and history (`ps_sql_runs`), its jobs                                               |
| `20261025084448_terminal_query_erp`       | The Query Tool on an ERP: a run's ERP (`erp_workspace_id`), starting one checks the link and membership  |

Each has a rollback in `db/rollback/` (apply them newest first; rolling back
036 drops every dataset).
