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

- **Business analysis** (`src/lib/workflow/analyticsNodes.ts`), rows in and
  rows out like the other steps, so their results feed charts and datasets:
  - *Pareto (ABC)*: one row per item, summed, largest first, with `rank`,
    `share_pct`, `cumulative_pct` and `abc_class`. An item is A while the
    share before it is under the A line (80 % by default), B under the B line
    (95 %), else C.
  - *RFM Segments*: one row per customer (each input row is one order) with
    `recency_days`, `frequency`, `monetary`, scores 1–5 by fifths, and a
    segment: Champions, Loyal, New, At risk, Lost, Needs attention. *As of*
    empty: the newest date in the data, so an old export reads sensibly.
  - *Aging*: from a due date (terms 0) or an invoice date plus payment terms,
    `days_overdue` and `aging_bucket` (`current`, `d1_30`, `d31_60`, `d61_90`,
    `d90_plus`) per row, or with *Per party* one row per customer/supplier with
    the amounts per bucket, `total` and `oldest_days`. *As of* empty: today.
  - *Cohort Retention*: customers by their first week, month or quarter, and
    how many are active in each later period (`retention_pct`).
  - *Compare Periods*: sum, average, count, minimum or maximum per day, week
    (from Monday), month, quarter or year, optionally per group. Every period
    from the first to the last is present (a month without sales is 0), with
    `previous`, `change`, `change_pct`, `last_year`, `yoy_pct`, `moving_avg`
    and `running_total`. Dates may be days or `YYYY-MM` months. At most
    100,000 rows.
  - *Correlation*: Pearson correlation of every pair of numeric columns (all
    of them, up to 30, when none are listed), with the number of pairs and a
    strength label. A strong correlation does not show cause.
  - *Quantiles*: the quantile group (1 = smallest values) and percentile of
    each row's value.
  - *Find Outliers* compares each value with its own group when *Group by*
    (`partitionBy`) is set, e.g. a large order is normal for one customer and
    unusual for another.

- **JavaScript** (`tf.code`, `db/migrations/20261012000061_pipeline_code.sql`):
  a step whose code a member writes, as the body of a function of `rows`,
  `columns` and `h` (helpers: `num`, `round`, `sum`, `avg`, `groupBy`, `date`,
  `daysBetween`) that returns an array of rows. See "Code step" below.

The editor shows each field's business name, module, type, meaning and how it
relates to the source, before and after running.

## Code step

- **Off by default.** The Owner switches it on per workspace (Terminal →
  Pipelines, two-factor); switching it off stops code steps at the next run,
  nothing else. Both are in the workspace audit log.
- **Who writes code.** The permission *Write pipeline code*
  (`pipelines.code`): the Owner has it; custom roles may be given it (it
  needs two-factor); Admins do not have it. A trigger on `workflows` checks
  every save that adds or changes a code step (removing one needs no right),
  and writes the change to the audit log with the code's SHA-256 and length.
  MCP connections never add or change code; they keep what a person wrote.
- **Where it runs.** `src/server/workflow/codeRunner.ts` starts
  `scripts/server/code-sandbox.mjs` for each step: a separate Node.js process
  with an **empty environment** (no database addresses, keys or paths), killed
  past its time. Inside it the code runs in **QuickJS** (WebAssembly): only the
  rows, column names and helpers exist — no `require`/`import` of modules, no
  `process`, files, network or timers. Limits: 10 seconds (interrupt handler),
  128 MB of memory, 1 MB of stack, 100,000 rows in and out, 200 columns.
- **Results.** An array of objects; nested values become JSON text, columns
  keep the first-seen order, kept columns keep their type and lineage.
  `console.log` lines (up to 50) show as notices. Errors give the line of the
  member's own code. The step's columns are known only after a run.

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
