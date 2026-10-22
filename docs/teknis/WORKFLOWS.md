# Workflows (ERP → Automation → Workflows)

Analysis workflows over the workspace's ERP data. A workflow is a graph of
steps saved in the database (`workflows`), with numbered immutable versions
(`workflow_versions`) and a run history (`workflow_runs`). Runs happen on the
server, read-only: no step writes ERP data.

## Data a workflow can read

Only what is listed in the analytics catalog (`src/lib/analytics/catalog.ts`),
which `tests/db/catalog.test.mjs` checks against the migrated schema:

| Module | Entities |
|---|---|
| Master data | Customers, Suppliers |
| Sales | Sales orders, Sales order lines |
| Purchasing | Purchase orders, Purchase order lines |
| Inventory | Products, Stock movements |
| Finance | Invoices, Payments, Cash transactions |
| Accounting | Ledger accounts, Journal entries, Journal lines |

Relations are many-to-one only (an invoice's customer, a line's product or
account), so adding a related record's fields never duplicates rows. Owner,
workspace and acting-user columns and internal bookkeeping links are never
exposed. Warehouses, per-warehouse stock, approvals and audit logs are not in
the catalog.

## Steps

- **ERP Data** – rows of one entity plus related fields, with typed filters and
  sort, up to 5,000 rows (the result says when more rows match).
- **ERP Summary** – groups (up to 3; dates by day, month, quarter or year) and
  totals (records, distinct values, sum, average, minimum, maximum) computed by
  the database over *every* matching record. Each row carries `record_count`,
  and selecting a row lists the records it counted (drill-down).
- Select & rename, filter, sort, limit, calculated field (arithmetic only,
  never code), join, aggregate, data-quality validation, branch, describe,
  fit distribution.
- Outputs: table, KPI, bar and line charts, CSV download, named dataset.
- **Chart** (`out.chart`, `src/lib/workflow/chartData.ts`): one node for bar,
  stacked bar, line, area, stacked area, bars + lines (one axis, never two
  scales), pie, donut, scatter, histogram, heatmap and pivot table. Settings:
  the x column, value columns (up to 8; empty with *count* counts rows), an
  optional column that splits a value into series, aggregation, order, bins,
  number format (number, short, currency, percent) and a title. The data is
  shaped on the server with the same currency and repeated-value rules as
  Aggregate, so only the points leave it: at most 8 series (the palette's
  colours; the rest fold into *Other*), 50 bar categories, 1,000 points over
  time, 2,000 scatter points (evenly sampled), 40 × 40 heatmap cells. Series
  colours are `--series-1…8` (src/styles/tailwind.css), checked for
  colour-blind separation on the light and dark surfaces; every chart has a
  legend (two or more series), a table view and an *Open large* view.

The editor shows each field's business name, module, type, meaning and how it
relates to the source, before and after running.

## Auto-refresh

**Auto-refresh 1 min** in the editor's toolbar runs the workflow again on the
server every minute while the page is open and its tab visible, so results
follow the ERP data within about a minute. It is near real-time, not push:
nothing runs when the page is closed or in the background.

- It re-runs what was run last: the saved draft, or the published version.
  It never saves; with unsaved changes or problems in the draft it pauses.
- Each refresh is an ordinary run by the signed-in user (same permissions,
  workspace checks and limits), recorded with trigger `auto_refresh`. The run
  history hides these unless *Show auto-refresh runs* is ticked.
- The database refuses an auto-refresh less than 45 seconds after the same
  user's previous one of that workflow (several tabs share one per minute) and
  keeps only the newest 100 finished auto-refresh runs per user and workflow.
  Manual runs are never removed.
- Three failed refreshes in a row turn it off.

Each refresh costs one run: with summaries (computed by the database) this is
cheap; ERP Data steps read up to 5,000 rows each time.

## Rules that keep numbers honest

- A related record's value repeats on every row that links to it (a customer's
  balance on each of their invoices). Sums and averages of such columns are
  refused, in the editor and on the server; summaries only sum the base
  record's own amounts.
- Joins refuse a right side with repeated keys (it would multiply rows), and
  keys that identify different kinds of record or have different types.
- Amounts in a document's own currency (invoice and payment totals) are never
  added across currencies: such a group is left empty with a notice. Group by
  currency or use the base-currency amount.
- Summaries leave out voided and cancelled records unless asked to include them.
- Totals computed from an ERP Data step that did not read every matching row
  are marked *partial*.
- Averages, minimums and maximums of no values are empty, not 0.

## Security

- Every request needs a signed-in session; changes must come from this site.
- A run reads data in the workflow's workspace with the runner's own role:
  membership and the read permission of every entity are checked
  (`resolveScopeFor`), then the statements run as the `authenticated` database
  role with the user's claims, so row-level security applies as well.
  Summaries and drill-down are parameterised SQL whose table and column names
  come only from the catalog (`src/server/analytics/summary-sql.ts`).
- Members of a workspace can open, run and duplicate its workflows; only the
  creator edits them. People outside the workspace cannot see, run or drill into
  them.
- Run history stores status, start and end time, version, who started it,
  trigger (manual or auto-refresh), row count, data-quality counts and per-step metadata with
  error keys — never result rows. A retried request with the same id is not run
  twice; at most 3 runs per user at a time; runs stop starting steps after 8 s.
- Server logs carry only error codes (`[analytics query]`, `[analytics summary]`).

## Not supported

- **Python steps.** Running user code safely needs an isolated sandbox
  (separate container or micro-VM per run, no network, no database or secret
  access, CPU/memory/time limits, a fixed library set) fed only with the
  workspace-scoped rows of the run. ETNA's deployment (a Next.js server and
  PostgreSQL) has no such sandbox, so Python is not offered; Python must never
  run in the browser or in the Next.js server.
- Scheduled or event-triggered runs, and push updates when ERP data changes
  (runs are started by a person, or by auto-refresh while the editor is open).
- Steps that change ERP data. If added, they must call the existing ERP
  business functions (validation, permissions, audit trail), never write tables.
- Links that open one specific record in an ERP page (pages have no per-record
  address); drill-down lists the records and links to the module's page.
