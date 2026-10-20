# Industry templates, modules and Indonesian payroll

ETNA is used by more than one kind of business. Features for one industry are
**modules** an ERP switches on; the core (sales, purchasing, stock, invoices,
accounting, HR) is the same for everyone.

## Industry and modules

Every ERP has an industry, chosen when it is created (Add modules → Create a
new ERP, or by ETNA's admins: `/admin/workspaces` → New company). The Owner or
an Admin changes it under **Settings → Industry and modules**.

| Industry | Modules switched on | New products start in |
|---|---|---|
| General | — | pcs |
| Quarry & mining | Weighbridge, Production, Equipment & fuel | m³ |
| Trading / distribution | — (purchasing, warehouses and deliveries are core) | pcs |
| Manufacturing | Production, Equipment & fuel | pcs |

Single modules can be switched on or off afterwards. A module that is off is
hidden from the menu and refuses new records; nothing already recorded is
deleted. Migration: `db/migrations/20261012000023_erp_industry_modules.sql`.

## Weighbridge (Site operations → Weighbridge)

For selling by the truckload.

1. **Weigh in**: plate number (a new plate registers the truck), driver,
   customer (or a walk-in name), product, weight in kg — usually the empty
   truck. The ticket gets its number, `WB/2026/0001`.
2. **Weigh out**: the second weight (or the truck's stored empty weight). The
   net weight becomes the product's quantity: kg, ton, m³ or liter (m³ and
   liter through the product's **density**, ton per m³ — set it under
   Products), or 1 truckload (`rit`). Stock goes out and the cost of goods is
   posted. Print the ticket: it is also the delivery note.
3. **Invoice tickets**: one invoice per customer and period, a line per
   product and price, with the sales tax rate. Voiding that invoice frees the
   tickets to be invoiced again.

Price: the last price this customer paid for the product, else the product's
selling price; only roles with sales rights change it.

**Credit limit** (Customers → edit): open invoices plus tickets not yet
invoiced may not go above it. A truck over the limit is stopped at the first
weighing; the Owner or an Admin can let it through with a reason, which stays
on the ticket.

Weighing needs the fulfillment right: Owner, Admin or **Inventory** (give
weighbridge operators the Inventory role). Cancelling an open ticket: its
operator; a completed one: Owner or Admin (stock and cost are reversed).
Weights are typed in; a scale connected to the PC is not read yet.

Migration: `20261012000024_erp_weighbridge.sql`.

## Production (Site operations → Production)

A production run records, for a day and shift: the products made and the
stockpile each goes to (stockpiles are warehouses — create them under
Inventory), optionally the material used from stock, operating hours and
downtime. Runs are numbered `PRD/2026/0001`; the page shows totals per
product, output per operating hour and a per-day table.

**Valuation**: stock is valued at each product's cost (average cost, else its
purchase / cost price). For a quarry set each product's cost price to its
production cost per unit; production costs actually paid (wages, fuel, parts)
stay in expenses, and the difference is posted to Inventory adjustments.

Recording: Owner, Admin, Inventory. Reversing (with a reason): Owner or Admin.
Migration: `20261012000025_erp_production.sql`.

## Equipment & fuel (Site operations → Equipment & fuel)

Machines (excavators, loaders, dump trucks, crushers, gensets) with an hour
meter and a service interval. Per machine log:

- **Hours**: a meter reading; the hours worked since the last one.
- **Fuel**: liters from a fuel product counted in liters (e.g. "Solar",
  bought through purchase orders into stock). Stock goes out; its cost is
  posted as an operating expense. The page shows liters per hour.
- **Service**: what was done and at which reading; the countdown to the next
  service starts again. The cost is for the record — pay it as a purchase or
  expense.

Reversing an entry (Owner or Admin) puts the meter, last service and fuel
back. Migration: `20261012000026_erp_equipment.sql`.

## Payroll: monthly and daily pay, Indonesian rules

**Employees → Pay terms** (every ERP): paid per hour (attendance, as before),
per day worked (daily rate), or a **monthly salary** with a fixed allowance
(tunjangan tetap). A monthly salary is paid once per calendar month — the
month of the payroll run's last day — prorated by working days in the month
the employee joined, less unpaid leave.

**Payroll → Payroll rules → Indonesia** adds, per employee:

- **Overtime** for daily and monthly employees by PP 35/2021: hourly wage =
  monthly wage / 173; working days 1.5× the first hour, 2× after; rest days
  and holidays 2× (first 7 hours on a 6-day week, 8 on a 5-day week), 3× the
  next hour, 4× after.
- **BPJS Ketenagakerjaan**: JHT 3.7% company + 2% employee; JP 2% + 1% up to
  the JP wage cap; JKK (rate of the risk group — a quarry is usually 1.74%)
  and JKM 0.30%, company only. **BPJS Kesehatan** 4% + 1% between the floor
  (UMK, optional) and the cap. Per employee, BPJS TK / JP / Kesehatan can be
  switched off (e.g. not enrolled, or over the JP age).
- **PPh 21** (PP 58/2023, PMK 168/2023): monthly employees at the TER rate of
  their category (A/B/C from the PTKP status) on gross pay including the
  company's JKK, JKM and BPJS Kesehatan. In **December** the year is
  recalculated with Article 17 rates (gross − 5% job expenses up to
  Rp 6,000,000 − employee JHT/JP − PTKP) less what was withheld, so December
  can be a refund. Daily and hourly employees (pegawai tidak tetap): 0% up to
  Rp 450,000 a day, 0.5% up to Rp 2,500,000 a day.
- **THR**: tick "Include THR" on the run (once a calendar year): monthly wage
  × months of service / 12, from one month of service.

PPh 21 and BPJS post to their own accounts (2310 PPh 21 payable, 2320 BPJS
payable). The JP and Kesehatan caps and the JKK rate are settings because they
change by regulation (JP: every March; Rp 11,086,300 from March 2026).

Not covered: the 20% surcharge for employees without NPWP/NIK (record their
NIK), severance (pesangon), and the e-Bupot / Coretax report files. Have the
first runs checked by your tax adviser.

Migration: `20261012000027_erp_hr_indonesia.sql`; tests with worked examples:
`tests/db/hrIndonesia.test.mjs`.
