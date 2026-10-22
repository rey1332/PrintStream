# PrintStream

**Version 1.0.1** · by ETNA (Enterprise Transformation & Intelligence Architecture)

PrintStream is where a company's day-to-day work and its data live together.
Sales, purchasing, stock, accounting, tax, HR and payroll sit next to the tools
you use to understand them: datasets, pipelines, charts and SQL. You run it on
your own server, so your data stays with you.

> Looking for the Indonesian guide (install, daily use, backup, moving
> servers)? Start at **[docs/PANDUAN.md](docs/PANDUAN.md)**.
> Technical notes live in [docs/teknis/](docs/teknis/).

---

## Why it exists

Most companies end up with their numbers scattered across an ERP, a few
spreadsheets and someone's inbox. Answering a simple question ("which
customers are paying late, and is it getting worse?") means exporting,
copying and hoping nothing changed in between.

PrintStream keeps the records and the analysis in one place, under one set of
permissions, so the answer is a pipeline you build once and rerun whenever
you want.

## What you can do with it

**Run the business**

- Sales, purchasing, inventory, accounting, tax, HR and payroll modules.
- Several companies (workspaces) on one server, each fully separated.
- Roles such as Owner, Admin and Finance, plus custom roles with exactly the
  rights you choose.
- A dashboard with receivables, revenue and trends at a glance.

**Understand the data**

- Import files, connect databases and APIs, and keep it all as datasets.
- Build pipelines visually: filter, join, aggregate, pivot, then schedule them.
- Twelve chart types inside a pipeline, from bar, line and area to scatter,
  histogram, heatmap and pivot tables, shaped on the server so large data
  stays fast.
- A JavaScript step for logic that doesn't fit a box: scoring, tiered rules,
  cleaning messy imports. It runs in a sandbox with no network, files or
  server access, and it stays off until the Owner switches it on.
- A Query Tool for when SQL is simply quicker.

**Work with AI assistants, safely**

- Connect Claude or another assistant through MCP. It can read datasets,
  profile them and draft pipelines for you.
- You choose, per connection, which tools it may use and which datasets it
  may see. Assistants can never write code steps.

**Stay in control**

- Password plus two-factor sign-in; sensitive actions require two-factor.
- Every important change goes into an audit log.
- One command for backups, encrypted off-site copies, restores and moving
  to a new server.

## How it fits together

```
Browser ──► PrintStream app ──► PostgreSQL
                 │                  (row-level security per workspace)
                 ├──► Worker        (imports, pipelines, schedules)
                 └──► Data folder   (documents, uploaded files)
```

Access is checked twice: the app checks who you are and what your role allows,
then PostgreSQL checks again with row-level security, so one company never
sees another's rows, even if the app had a bug.

## Getting started

| Where                      | What to read                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu Server (production) | [docs/PANDUAN.md §3](docs/PANDUAN.md#3-pasang-di-ubuntu-server-untuk-dipakai-kantor): `install.sh`, then manage it with `psctl` |
| Windows (development)      | [docs/PANDUAN.md §4](docs/PANDUAN.md#4-pasang-di-windows-pc-development)                                                        |
| Updating                   | [docs/PANDUAN.md §6](docs/PANDUAN.md#6-update-ke-versi-baru)                                                                    |

Built with Next.js, PostgreSQL and Node.js. No cloud service is required:
sign-in, two-factor and your business data never leave your server.

## What's next

We're honest about what isn't there yet:

- Ready-made connectors for other ERPs.
- Machine learning in pipelines (forecasting, anomaly detection).
- Several app servers sharing one database, for larger offices.

## What's new in 1.0.1

- Chart node in pipelines, with twelve chart kinds.
- Sandboxed JavaScript step, switched on by the Owner and fully audited.
- Per-connection MCP access: choose the tools and the data.
- A denser ERP dashboard.

---

Proprietary software © 2026 ETNA. See [LICENSE](LICENSE).
