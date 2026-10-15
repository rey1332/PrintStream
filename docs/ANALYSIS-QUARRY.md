# ETNA for a mid-size Indonesian stone quarry: analysis and what to add

Date: 4 October 2026. Based on reading the whole codebase (≈64,000 lines in
`src/`, 48 database migrations, scripts, docs and tests), the live local
database schema, and the target you described:

- A mid-size Indonesian stone quarry. It runs a weighbridge and sales,
  production and stockpiles, heavy equipment and fuel, and permits, royalties
  and safety.
- It needs PPN / e-Faktur, PPh 21 with BPJS, and PPh 23 withholding.
- You host ETNA yourself. The company's staff use it on laptops and phones.

Nothing was changed in the code for this report.

> **Status, 4 October 2026 (later the same day).** The bugs in §4 have been
> fixed:
>
> | Bug | Fix |
> |---|---|
> | 1. Customer/supplier balance typed in | Calculated from documents (`erp_party_balances`, migration 16) |
> | 2. Whole-number quantities | Three decimals plus units and ton↔m³ conversion (migration 15) |
> | 3. Payroll defaults | JKK 1.74%, no 0% PPh 21, warning shown |
> | 4. Reports load every row | Totalled in the database (`erp_reports_summary`, migration 17) |
> | 5. Manual invoices without lines | Invoice lines (`erp_invoice_lines`, migration 18) |
> | 6. Old function versions callable | Revoked; the app uses only current versions (migration 19) |
> | 7. Settings per owner | Not a bug: every ERP has its own owner account; a test now pins it |
> | 8. Three-ERP limit for admins | Platform admins exempt (migration 20) |
> | 9. No delivery note | Numbered surat jalan (SJ) and goods receipts (GR), printable (migration 21) |
> | 10. No code/unit on prints | Product code and unit on printed orders, invoices and delivery notes |
> | 11. Naming drift | Package renamed to `etna`, README wording fixed |
>
> Safety (§5): S2 `npm run verify` replaces CI; S3 two-factor is required
> for Owners, Admins and Finance of shared ERPs (migration 22); S10 the dead
> `origin` remote is removed. **S1 (off-site copy of the code) was skipped
> on request and is still the biggest risk.** `npm audit` reports 6 high
> issues in build tools (Tailwind's `braces`, Next's bundled `postcss`);
> fixing them needs Tailwind 4 / Next 16.
>
> The feature work in §3 (weighbridge, production, equipment, tax,
> payroll) is still to do.

Priority: **P0** = needed before the quarry can run on ETNA, **P1** = needed
in the first months, **P2** = later / nice to have. Effort (one developer):
**S** = days, **M** = 1–3 weeks, **L** = a month or more.

---

## 1. Summary: the ten most important points

1. **Quantities are whole numbers everywhere** (`INTEGER` in products, stock,
   orders, deliveries, movements, transfers). A quarry sells 23.47 tonnes, not
   23. There is also **no unit of measure** (ton, m³, rit) and no ton↔m³
   conversion. This blocks almost everything else and must come first. (P0, L)
2. **No weighbridge.** There are no tickets (gross / tare / net), truck plates,
   drivers or tare register, no printed delivery note (*surat jalan*), and no
   link from a weighing to the sales order and stock. This is the heart of a
   quarry's day. (P0, L)
3. **No production or stockpiles.** There is nothing for blasting, crushing
   (boulder in, split 1/2, 2/3, *abu batu* out), yields or stockpile surveys.
   Stock only comes from purchases and manual adjustments. (P0, L)
4. **No equipment, maintenance or fuel.** There is no register of excavators,
   dump trucks and crushers, no hour meters, service schedules, spare parts or
   *solar* issued per unit. Equipment and fuel are usually the quarry's
   biggest costs. (P1, L)
5. **Indonesian tax is only partly there.** There is one PPN rate per ERP.
   Missing are: invoice lines (e-Faktur needs them), customer NPWP / NITKU,
   faktur numbers, Coretax export, supplier faktur (PPN masukan), PPh 23,
   and Pajak MBLB. (P0 for PPN and MBLB, P1 for the rest; M–L)
6. **Payroll does not fit Indonesian rules yet:**
   - It is hourly only: no monthly salary (*gaji pokok*).
   - PPh 21 is a 0% placeholder; there is no TER.
   - BPJS is a flat percentage with no wage caps.
   - JKK defaults to 0.24% (the lowest risk group). A quarry is a high-risk
     workplace.
   - Overtime is a flat hourly rate, not the statutory 1.5× / 2× of 1/173 of
     the monthly wage.
   - There is no THR. (P0, M–L)
7. **Bug: customer and supplier "Balance" is a typed-in number** (from the
   form or a CSV import), never calculated from invoices and payments. It will
   show wrong receivables. (P0, S)
8. **Only one cash/bank account in the books (1000).** There are no separate
   BCA / Mandiri / petty cash accounts, no bank reconciliation, no supplier
   bills, no expenses with withholding, and no AR/AP aging or customer
   statements. (P0–P1, M)
9. **The source code now exists only on this PC.** The GitHub repo is gone, so
   there is no off-site copy of the code and CI no longer runs. Fix this
   before anything else. (P0, S)
10. **Hosting for a real client is not ready yet.** Missing are: e-mail (or
    WhatsApp) sending, error alerts, an off-site backup copy, a tested restore,
    a data-processing agreement with the quarry (UU PDP) and a phone-friendly
    weighbridge screen that tolerates bad signal. (P0–P1, M)

What ETNA already does well is a strong base to build on:
- security (row-level security, two-factor, the audit trails, the admin panel)
- double-entry accounting, multi-currency, roles
- HR attendance and leave, documents, and workspaces with sync

The work ahead is mostly **adding the quarry's own operations and Indonesian
compliance** on top. Little needs rewriting.

---

## 2. What ETNA has today

| Area | What exists | Fit for the quarry |
|---|---|---|
| Accounts & security | Own sign-in, TOTP 2FA, recovery codes, sessions, no self sign-up, admin panel (`/admin`) with roles, security log, T&C, dashboard | Good |
| Workspaces | Several ERPs per account (max 3), members with roles Owner / Admin / Finance / Sales / Inventory, invitations, sync between ERPs | Good. Roles are generic, though; see §3.10 |
| Master data | Customers, suppliers, products (name, SKU, category, prices, min/max stock) | Missing units, NPWP, credit limits, price lists, trucks, sites |
| Inventory | Stock movements, warehouses, transfers, reservations, average cost | Whole numbers only; no production |
| Purchasing | PO → approval (threshold, e-mail approvers) → receipts → payment | OK; no supplier bills / faktur masukan |
| Sales | Sales order → deliveries → invoice from order → payment | No quotations, deposits, weighbridge, or periodic invoicing from tickets |
| Invoices | Manual invoice = one amount plus a tax rate; invoice from a sales order; void | No line items on manual invoices, no credit notes, no e-Faktur data |
| Accounting | Chart of accounts, automatic journals, manual journals, reversal, lock date, trial balance, P&L, balance sheet | Good base; one cash account; no cost centers, budgets or fixed assets |
| HR | Employees (hourly / overtime rate), clock in/out, corrections, holidays, leave, payroll with allowances / deductions / employer items, payslips, journal | Hourly only; Indonesian payroll rules missing (§3.6) |
| Reports | Cash flow, expenses, invoices, payments, inventory, audit log; analysis workflows; ERP search | Computed in the browser from all rows (§4.4); no daily production / sales report |
| Documents | Upload / download with checksums, limits | Good |
| Print | Invoice, payment, PO, SO, payslip | Missing: surat jalan, weighbridge ticket, faktur pajak layout |
| Admin / ops | Migrations with checksums, rollbacks, backups (pg_dump), health check, install guide (Windows + Cloudflare Tunnel) | Good docs; gaps in §5 |

---

## 3. Missing features for the quarry

### 3.1 Units and decimal quantities (P0, L), the foundation

- Change every quantity column from `INTEGER` to `NUMERIC(14,3)`:
  - `erp_products.current_stock`, `min_stock`, `max_stock`
  - order and receipt lines (`qty`, `qty_received`, `qty_delivered`)
  - `erp_stock_movements.quantity`, `erp_stock_transfers.quantity`,
    `erp_warehouse_stock.quantity`
  - reservations
  - `erp_fulfillment_event_lines.quantity`
  - the views (`erp_inventory_stock`, `erp_product_availability`)
  - every function that takes `INTEGER` quantities (`erp_adjust_stock`,
    `erp_transfer_stock`, the receipt and delivery functions)
  - the TypeScript forms
- Add a **unit** to each product (ton, m³, rit/truckload, liter, pcs, kg).
  Add an optional **density** (ton per m³) so a sale in m³ can be stocked in
  tons, and the reverse.
- This touches the costing, ledger and fulfillment functions. Do it as one
  careful migration with tests before any other quarry feature.

### 3.2 Weighbridge and sales (P0, L)

- **Trucks and drivers**:
  - plate number, owner (company / customer / transporter), registered tare
    with a date, max load, driver name and phone
  - optional link to a transporter (supplier) for hauling costs
- **Weighbridge ticket**:
  - number, date/time in and out, truck, driver, customer, product, site /
    stockpile, gross, tare, net
  - price, link to the sales order
  - operator, notes, optional photo of the truck and load (phone camera)
- **Rules**:
  - net = gross − tare
  - warn when the tare differs from the registered tare by more than X%
  - warn on overload
  - a ticket cannot be edited after printing; only cancelled with a reason,
    and the cancellation is audited
  - ticket numbers have no gaps
- **Posting**: a completed ticket becomes a delivery on the sales order
  (stock out) automatically.
- **Print** the ticket and the *surat jalan* (A5 or thermal 80 mm), with a QR
  code to verify them.
- **Scale connection** (later, P2): read the scale indicator over RS-232 or
  USB with the browser's Web Serial API on the weighbridge PC. Until then,
  manual entry with a photo of the indicator.
- **Commercial terms** quarries use:
  - price per customer, product and delivery terms (*loco* / ex-pit vs.
    *franco* / delivered, with hauling charged per rit or per ton-km)
  - customer **deposits** / prepayment drawn down per truck
  - **credit limits**: block new tickets for a customer over limit or overdue
  - **periodic invoicing**: one invoice per customer per week or month from
    all their tickets, with the ticket list attached
  - quotations (*penawaran*) and contracts (agreed tonnage and price per
    period)
- **Reports**: daily sales per product, customer and truck; rit per truck;
  tonnes by hour (queue planning); delivered vs. contracted.

### 3.3 Production and stockpiles (P0, L)

- **Sites / pits and stockpiles.** Warehouses already exist and can carry a
  type: pit, stockpile, crusher feed, workshop.
- **Production entry per shift**:
  - input: tonnes of boulder (from pit or stockpile)
  - outputs: tonnes per product (split 1/2, 2/3, 3/5, abu batu, sirtu…)
  - crusher hours, downtime with reasons, operator
  - the stock moves in one posting
- **Yield and cost per ton**: output mix vs. input; cost of the shift (fuel,
  labour, wear parts, power) spread over the tonnes produced.
- **Blasting log**:
  - date, location, holes, explosives and detonators used, the blaster
    (*juru ledak*), result, incidents
  - explosives stock is controlled: keep a separate in/out register for
    explosives, with who issued and received
- **Stockpile surveys**: record a measured volume (e.g. drone or survey) and
  post the difference to the book stock as an adjustment, with a reason and
  approval.
- **Daily production report** (*laporan harian produksi*): per crusher,
  product and shift, plus a month-to-date view.

### 3.4 Heavy equipment, maintenance and fuel (P1, L)

- **Equipment register**:
  - excavators, wheel loaders, dump trucks, crushers, gensets
  - owned vs. rented, with the rental supplier, rate and PPh 23
- **Hour meter (HM) / kilometer readings** per day; **utilisation** and
  **availability** (working, standby, breakdown).
- **Maintenance**:
  - service intervals (every 250 / 500 HM…) with due warnings
  - work orders with spare parts and labour
  - breakdown history
- **Spare parts** as normal products in a workshop warehouse; issue them to a
  work order or a unit.
- **Fuel (solar)**:
  - tank stock (receipts from the supplier)
  - issues per unit with HM at refuelling and liters
  - liters per hour per unit, with alerts on unusual consumption (fuel theft
    is a classic quarry problem)
- **Cost per unit per month**: fuel, parts, rental, operator.

### 3.5 Permits, royalties, safety, environment (P1, M)

- **Permit register**:
  - IUP / SIPB, environmental permits (AMDAL / UKL-UPL), explosives permits,
    KIR and STNK of trucks, operator certificates (SIO)
  - expiry dates, reminders and the attached documents (ETNA already has
    documents)
- **Pajak MBLB** (regional tax on non-metal minerals and rocks):
  - monthly volume per mineral type × *harga patokan* set by the regency, ×
    the rate from the local Perda, plus the provincial *opsen* where
    applicable
  - rates and base prices must be **configurable per site and period**
  - output: the monthly report and the journal (expense / payable)
  - Confirm the exact basis (extracted vs. sold volume) with the client's
    tax adviser and the local Bapenda.
- **Production vs. permitted / planned volume** (RKAB or permit limits): warn
  when approaching the limit.
- **K3 (safety)**:
  - incidents and near misses with severity, investigation and corrective
    actions
  - inspections and checklists, toolbox talks
  - APD (PPE) issued per employee
  - days without lost-time injury on the dashboard
  - Reports for the KTT (*Kepala Teknik Tambang*).
- **Environment**: monitoring entries (dust, water, noise), reclamation areas
  and the *jaminan reklamasi* amount, all with documents.

### 3.6 Indonesian payroll (P0, M–L)

| Gap | What to add |
|---|---|
| Hourly pay only | Monthly salaried staff (*gaji pokok*) and daily workers (*harian lepas*), plus fixed and variable allowances (meal, transport, site, position) |
| Overtime is a flat hourly rate | Statutory overtime (PP 35/2021): hourly wage = 1/173 of the monthly wage. Working days: 1.5× the first hour, 2× after that. Rest days and holidays have their own scale. Keep a manual override for daily workers |
| PPh 21 is a 0% placeholder | PPh 21 by **TER** (PP 58/2023) monthly, categories A/B/C from PTKP status, December recalculation on the annual rate. Needs employee **NIK, NPWP, PTKP status** (TK/0…K/3) |
| BPJS flat %, no caps | BPJS Kesehatan (4% + 1%) on wages up to the cap. JHT 3.7% + 2%. JP 2% + 1% up to the JP wage cap (updated every year). **JKK by risk group** (0.24 / 0.54 / 0.89 / 1.27 / 1.74%): set the company's group; a quarry is high risk. JKM 0.3%. Make caps and rates settings with an effective date |
| No THR | THR (one month's wage, prorated after 1 month of service) in a separate run before Lebaran |
| Reports | BPJS contribution lists, PPh 21 monthly and the annual 1721-A1 per employee, bank transfer file (CSV for the company's bank) |
| Shifts | Rosters for day and night shifts at the crusher and pit; attendance against the roster |

Rates and caps change: store them as settings with an effective date, not in
code. Have the client's payroll / tax adviser confirm the setup before the
first live run.

### 3.7 Tax: PPN, e-Faktur / Coretax, PPh 23 (P0–P1, M–L)

- **Invoice lines** on every invoice (product, quantity, unit, price,
  discount, DPP, PPN). Today a manual invoice is one amount. e-Faktur needs
  lines.
- **Customer tax data**: NPWP (16 digits) / NIK, NITKU, tax address, and
  whether the customer is a PKP.
- **PPN rules**:
  - transaction codes (01, 02, 03, 04, 07, 08…)
  - DPP vs. *DPP nilai lain* (11/12) from the 12% regime
  - PPN on **advances / deposits**
- **e-Faktur via Coretax**: export the month's sales invoices in the Coretax
  import format (XML), and store the faktur number once approved.
  Credit-note-style corrections (*faktur pengganti* / returns).
- **Supplier bills** (purchase invoices) with the supplier's faktur number and
  date, so PPN masukan is claimed from a real faktur. Today input tax is
  booked at goods receipt, without a faktur.
- **PPh 23 withholding** (equipment rental, services, transport):
  - withhold on the supplier bill (2%, higher without NPWP under the old
    rules; confirm the current rule)
  - post *PPh 23 payable*
  - produce the *bukti potong* data for e-Bupot Unifikasi
  - Also the reverse: customers withholding PPh 23 from the quarry's hauling
    services.
- **Monthly tax summary**: PPN out vs. in, PPh 21, PPh 23, MBLB, with the
  journals.

### 3.8 Finance gaps (P0–P1, M)

- **Several cash and bank accounts** (BCA, Mandiri, site petty cash). Choose
  the account on each payment and receipt; bank transfers between them.
- **Bank reconciliation**: import the bank statement (CSV) and match it with
  payments.
- **Supplier bills and expenses**: repair, rental, fuel, utilities, permits,
  with PPh 23 and attachments. Today an expense is a bare "transaction" with a
  category.
- **Receivables**:
  - AR / AP aging (0–30, 31–60, 61–90, >90 days)
  - customer statements (*rekening koran*), collection reminders
  - credit notes and returns, instead of only voiding
- **Cost centers** (pit, crusher, transport, workshop, office) on journals,
  bills and payroll, so the client sees cost per ton per stage.
- **Fixed assets and depreciation** for the heavy equipment, crushers and
  buildings: book and fiscal groups, monthly depreciation journal, disposals.
- **Budget vs. actual** per cost center and month (P2).
- **Month-end close checklist** using the existing lock date.

### 3.9 Phones, offline and notifications (P1, M)

- **Phone screens for the site**: weighbridge operator, fuel issue, HM
  reading, production entry, incident report. Large buttons, camera upload,
  few fields. The current pages are responsive tables, not field forms.
- **Unreliable signal**: make it a PWA, with an offline queue for tickets and
  fuel issues, synced later with conflict checks. At the very least, the
  weighbridge must keep working when the internet drops. If not offline, a
  small local server at the weighbridge.
- **Notifications** by e-mail and, more useful in Indonesia, **WhatsApp**
  (through a WhatsApp Business API provider):
  - invoice sent
  - overdue reminders
  - approval requests
  - permit expiry, service due, unusual fuel use
  - password links (today an admin copies them by hand)

### 3.10 Roles for the quarry (P1, S–M)

Today's roles (Owner, Admin, Finance, Sales, Inventory) do not match the
quarry's jobs. Add roles, or permission sets, for:
- weighbridge operator (create tickets only)
- production supervisor
- workshop / maintenance
- fuel man
- HSE / K3
- site manager (read everything at their site)
- management (read only, dashboards)

Consider **per-site** restrictions if the company has more than one pit.

### 3.11 Management dashboard and reports (P1, M)

Daily and monthly, per site:
- tonnes produced and sold
- stock per stockpile
- revenue and average price per ton
- cost per ton (fuel, labour, maintenance, MBLB)
- equipment availability
- receivables overdue
- safety: days without accident

Exportable to Excel and PDF.

---

## 4. Bugs and broken or weak workflows

1. **Customer / supplier "Balance" is not real** (P0, S).
   - `erp_customers.balance` and `erp_suppliers.balance` are only set by the
     form and the CSV import (`customers/page.tsx`); nothing updates them from
     invoices or payments. The list shows these numbers as balances.
   - Fix: calculate them (open invoices − payments, in the base currency) in a
     view or function, and drop the editable field. Keep the old value as
     "opening balance" with a journal to the opening-balance account.
2. **Whole-number quantities** (§3.1): every tonnage entry is rounded or
   refused today. (P0)
3. **Payroll defaults are wrong for a quarry** (P0, S for the quick part):
   - `PayItemsDialog.tsx` suggests JKK 0.24% (lowest risk), BPJS without wage
     caps, and PPh 21 at 0%.
   - Until §3.6 is built, change the suggestions and show a clear warning that
     PPh 21 is not computed.
4. **Reports load every row into the browser** (P1, M).
   - `reports/page.tsx` and `cash-flow/page.tsx` call `getAll` for all
     transactions, invoices, payments and products. `fetchAll` pages through
     them 1,000 at a time.
   - With hundreds of weighbridge tickets a day this becomes slow on laptops
     and unusable on phones.
   - Fix: move reports to database functions that return totals, as
     `erp_dashboard_metrics` and `erp_list_summary` already do.
5. **Manual invoices have no lines** (P0 with §3.7): `erp_create_invoice_v5`
   takes only a subtotal and a tax rate.
6. **Old function versions are still callable** (P2, S).
   - These include `erp_create_invoice` v1–v4, `erp_create_purchase_order`
     v1–v2, `erp_create_sales_order` v1–v2, `erp_issue_invoice_from_sales_order`
     v1, `erp_record_purchase_receipt` v1 and `erp_hr_payroll_runs` v1.
   - Once nothing calls them, drop them in a migration. That means less to
     secure and test.
7. **Settings still stored per owner, not per ERP** (P2, S).
   - `erp_settings` and `erp_approval_settings` are keyed by owner;
     `erp_reset_workspace` deletes them by owner. The code comment says "until
     an owner can have several ERPs", which is now the case.
   - Move them to `workspace_id` so one ERP's reset can never touch another's
     settings.
8. **Three-ERP limit per account** (`MAX_ERPS_PER_ACCOUNT = 3`) (P1, S).
   - Fine for clients, but it also applies when an admin is granted access to
     client workspaces. You, as the host supporting several clients, will hit
     it.
   - Exempt platform admins, or make the limit a setting.
9. **No delivery note** (§3.2): goods leave the quarry without a *surat jalan*
   from the system.
10. **Product names copied onto order lines** (`product_name`) are fine for
    history, but there is no product code / unit on printed documents.
    Check the print layouts once units exist.
11. **Docs and naming drift** (P2, S):
    - the README and DEVELOPMENT guide use port 5432, while your setup uses
      3000
    - `package.json` still says "bettywhite" / "BettyWhite ERP Platform"
    - the README calls ETNA an "EIP and Data Analytic platform"

I did not find failing tests: all 325 database tests and 91 unit tests pass,
the type-check and lint are clean, and the build succeeds. The issues above
are design gaps and wrong data, not crashes.

---

## 5. Security and data safety

What is already strong:
- row-level security in the database for every request, with the browser
  never talking to PostgreSQL
- bcrypt, sessions with idle / maximum lifetimes, `httpOnly` / `SameSite`
  cookies
- TOTP 2FA with recovery codes, sign-in rate limits
- the CSP, HSTS and `X-Frame-Options` headers, Origin checks
- body size limits; uploads with an extension allow-list, checksum, download
  as attachment with `nosniff`
- append-only audit trails, the platform security log, admin re-authentication
- an allow-list of callable functions, with tests

What to add or decide:

| # | Item | Priority |
|---|---|---|
| S1 | **Off-site copy of the source code** now that GitHub is gone: a private repo elsewhere, or an encrypted backup of `C:\ETNA` (without `.env.local`) to another disk / cloud, at least weekly. Losing this PC today loses ETNA | **P0** |
| S2 | **Run the checks locally** before every release, since CI is gone: `npm run check` and `npm run build` | P0 |
| S3 | **Require two-factor for the quarry's workspace** (the setting exists) and for every Owner / Admin / Finance account | P0 |
| S4 | **Data-processing agreement** with the quarry: you host their data (UU PDP No. 27/2022). Covers what is stored, retention (the security log and kept ERP audit trails keep personal data forever by your choice), backups, access by your admins, breach notification within 3×24 hours | P0 |
| S5 | **Off-site encrypted backups** of the database **and** the documents folder, and a **restore test** (quarterly). `.env.local` (especially `MFA_ENCRYPTION_KEY`) stored in a password manager | P0 |
| S6 | **Weighbridge integrity**: no edit after print, gap-free numbers, photo evidence, tare checks, operator accountability (§3.2). Weighbridge fraud is the main money risk in a quarry | P0 with §3.2 |
| S7 | ~~Shorter sessions for admins and finance (e.g. 8 hours idle) and an automatic sign-out on shared PCs (weighbridge)~~ Done (20261012000052): 8 hours idle for company owners, admins, finance and platform admins; "This is a shared computer" at sign-in signs out after 15 minutes | P1 |
| S8 | Error alerts: send `[db]`, `[auth]`, `[admin]` and other error lines and `/api/health` failures to you (e-mail or Telegram / WhatsApp) | P1 |
| S9 | Malware scan of uploaded documents (e.g. ClamAV) since staff will upload files from phones | P2 |
| S10 | Remove the dead `origin` remote (`github.com/rey1332/ETNA`) or point it at the new backup location | P2 |

---

## 6. Operations and hosting readiness (you host it)

| Need | Today | To do |
|---|---|---|
| Server | Install guide for Windows + PostgreSQL + Cloudflare Tunnel (docs/INSTALL-SERVER.md) | Decide where it runs (your PC is not a server). A small VPS or a dedicated machine with UPS. Separate DB and app if possible, as the guide describes |
| Domain and TLS | Via Cloudflare | Set `ETNA_PUBLIC_URL`, `TRUST_PROXY=cloudflare` |
| Staging | Described in the docs | Keep a staging copy for trying migrations before the client's data |
| Backups | Daily `pg_dump` script on the DB server | Off-site copy, documents folder too, restore test (S5) |
| Monitoring | `/api/health` | External uptime check (e.g. a free uptime monitor) plus error alerts (S8) |
| E-mail / WhatsApp | Only Resend for workflow approvals | Provider for password links, invoices, reminders (§3.9) |
| Updates | Migrations + rollback scripts; release order in OPERATIONS.md | A maintenance window agreed with the client; announce downtime |
| Support | Admin panel with accounts, workspaces, security log | Written support process: who may ask for a password reset, how identity is checked (the 2FA reset already requires a note) |
| Data import | CSV import for master data; `scripts/db/transfer.mjs` | Opening balances (stock per stockpile, receivables, payables, fixed assets, employees) in one guided import |
| Training | — | Short Indonesian guides per role (weighbridge, production, finance) |
| Performance | Fine for small data | Reports on the server (bug 4); indexes on tickets by date / customer / truck once added |

---

## 7. Suggested order

**Status (October 2026):** done since this report — industry templates and
modules per ERP (ETNA stays general; quarry features are modules), the
weighbridge with credit limits and invoicing from tickets, production into
stockpiles, equipment hours / fuel / services, monthly and daily pay with the
Indonesian payroll rules (PPh 21 TER, BPJS with caps, overtime, THR), and in
the admin panel new client companies, ERP limits, usage and modules,
announcements, system and backups, e-mail (SMTP) and CSV exports. See
docs/INDUSTRY-MODULES.md and docs/ADMIN.md. Still open from the list below:
PPN / Coretax export, supplier bills with PPh 23, Pajak MBLB, permits and K3,
fixed assets, bank reconciliation, offline weighbridge and a connected scale,
notifications, and the off-site code backup.

1. **Safety first (days):**
   - off-site code backup, local checks, remove the dead remote
   - fix the customer / supplier balance bug
   - correct the payroll defaults and add a warning
2. **Foundation (≈ 1 month):**
   - decimal quantities and units of measure
   - invoice lines
   - several bank accounts
   - customer tax data
3. **Quarry core (≈ 2 months):**
   - trucks and the weighbridge, surat jalan, deposits and credit limits,
     periodic invoicing
   - production and stockpiles, daily report
4. **Compliance (≈ 1–2 months):**
   - Indonesian payroll (TER, BPJS caps and JKK group, monthly / daily wages,
     overtime, THR)
   - PPN / Coretax export, supplier bills with faktur masukan and PPh 23
   - Pajak MBLB
5. **Operations depth:**
   - equipment, maintenance, fuel
   - permits and K3
   - fixed assets, cost centers, bank reconciliation, aging
6. **Field and hosting polish:**
   - phone screens and offline weighbridge
   - WhatsApp / e-mail notifications, error alerts
   - management dashboard, quarry roles

---

## 8. To confirm with the client (and their adviser)

These shape the design; please get answers before building the related part:

- **Products and units:**
  - their exact product list and the units they sell in (ton, m³, rit)
  - whether they invoice on weighbridge weight or on truck volume
- **Weighbridge:**
  - how many weighbridges and sites
  - the scale indicator model (for a later scale connection)
- **Customers and contracts:** cash customers vs. contract customers, deposit
  practice, credit terms.
- **Pajak MBLB:**
  - the regency / province of the IUP
  - the basis (extracted or sold volume)
  - the current *harga patokan* and rate
- **Tax status:** PKP status, PPN treatment of their products, whether
  customers withhold PPh 23 or PPh 22 from them.
- **Payroll:**
  - salary structure (monthly, daily, piece-rate per rit for drivers)
  - shift patterns, BPJS JKK risk group, payroll bank
- **Equipment:** owned vs. rented equipment, and how fuel is stored and
  issued.
- **Reports to the government** (ESDM / Dinas / Bapenda) and their formats.
- **Users:** how many, which roles, and who uses phones on site.
