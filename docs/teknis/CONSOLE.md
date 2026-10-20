# ETNA in-app console

ETNA's own command console (not the browser's developer tools). One console
for the whole app, mounted once in the root layout
(`src/components/console/ConsoleHost.tsx`), so it keeps its history across
page changes.

## Who can use it

Decided by the server for every request (`src/server/console/access.ts`), for
the ERP workspace in use:

- **Finance** members — allowed.
- **Owners** — allowed when the workspace is shared (at least one other active
  member). Every account owns a private personal workspace; owning one's own
  solo workspace does not grant the console.
- Everyone else (Admin, Sales, Inventory, Viewer) — not available. The console
  does not render, and `/api/console` refuses their requests.

This grants console use only; it changes no other permission. With two-factor
enabled, the console needs a verified (second-step) session.

## Opening it

- **Desktop:** press the backtick key (`` ` ``). Not while typing in a field
  (input, textarea, select, editable text); IME composition and key repeat are
  ignored. `Esc` or backtick closes it.
- **Phones and tablets:** the console button in the page header (terminal
  icon), shown only to users with access. The console opens as a bottom sheet.

## Commands

| Command | Action |
|---------|--------|
| `ver` | ETNA version (from `package.json`, served by `/api/console`) |
| `whoami` | Your name and console role (no email) |
| `stat`, `export` | KPI metrics of the dashboard on screen (copy as JSON) |
| `calc <expr>` | Arithmetic (a parser; nothing is evaluated as code) |
| `test` | Checks that the app and your session respond |
| `d_*` + `CONFIRM` | Delete your own records of one type (server-side, audited) |
| `r_erp`, `r_settings`, … | Navigation; `r_logout`, `r_reload`, `r_quit` |
| `help`, `man <cmd>` | Full reference |

App events (dashboard loads, realtime connection) also appear in the console
(`src/lib/console-logger.ts`).

## Security

- Commands are an allowlist. `ver`, `whoami` and the `d_*` data commands run
  on the server (`/api/console`, `src/server/console/commands.ts`), which checks
  access on every request; data changes run as the user under row-level
  security and are recorded in the audit log. Financial records and the audit
  log cannot be deleted at all.
- No `eval`, shell commands or SQL. Output never contains file paths,
  environment values, emails, stack traces or database detail.
- The console's code is part of the app bundle like any page; what it can
  reveal or change is decided by the server, not by hiding it. Add new server
  capabilities as allowlisted commands in `commands.ts`, never as client-only
  shortcuts.
- Pages hand the console their metrics with `useConsolePageContext`
  (`src/lib/console/bridge.ts`).
