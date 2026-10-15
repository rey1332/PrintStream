# Indonesian tax

ETNA prepares the documents a PKP company files every month; it does not
file them. The approved faktur numbers and bukti potong numbers come back
from DJP's systems (Coretax, e-Bupot Unifikasi) and are typed into ETNA.

| What | Where in ETNA | Goes to |
|---|---|---|
| **e-Faktur keluaran** (PPN on sales) | Tax → e-Faktur: pick a month's invoices, download the XML | Coretax → e-Faktur → Pajak Keluaran → Impor (XML) |
| **Supplier bills** with PPN masukan and **PPh 23 withheld** | Tax → Supplier bills | e-Bupot Unifikasi (PPh 23 CSV as a worksheet) |
| **PPh 23 withheld by a customer** | Tax → e-Faktur → the invoice's "PPh 23 withheld" button | Kept as Prepaid PPh 23, credited in the annual return |
| **Monthly summary** | Tax → Summary | A check against SPT Masa PPN and the e-Bupot returns |

| Piece | File |
|---|---|
| Database: tax data, e-Faktur, supplier bills, PPh 23, summary | `db/migrations/20261012000053_erp_indonesian_tax.sql` |
| Rollback | `db/rollback/rollback_20261012000053_erp_indonesian_tax.sql` |
| Coretax XML builder | `src/server/tax/coretax.ts` |
| API (two-factor session required) | `POST /api/erp/tax/coretax`, `POST /api/erp/tax/pph23` |
| Browser service | `src/app/erp/lib/taxService.ts` |
| UI | `src/app/erp/tax/page.tsx`, `src/app/erp/tax/dialogs.tsx`, `src/app/erp/components/PartyTaxFields.tsx` |
| Tests | `tests/db/indonesianTax.test.mjs`, `tests/unit/coretax.test.mjs` |

## 1. Tax data

| Record | Fields |
|---|---|
| Customer / supplier | ID type (`npwp`, `nik`, `passport`, `other`), the ID, NITKU, PKP or not, name and address as on tax documents |
| Company profile | NPWP (16 digits) and **NITKU** (22 digits: NPWP + 6-digit branch code, `000000` for the head office) |
| Product | Coretax goods / services code (6 digits) and whether it is goods (`A`) or a service (`B`) |

NPWP and NIK are 16 digits; an old 15-digit NPWP is written with a leading
`0`. Tax IDs are personal data: they are excluded from analytics and only
leave ETNA in the two exports below, which need a two-factor session.

## 2. e-Faktur for Coretax

Each taxed invoice has a **transaction code**:

| Code | When | DPP and PPN on the faktur |
|---|---|---|
| `04` (default at 11%) | Most sales under the 12% regime (PMK 131/2024) | DPP nilai lain = 11/12 × price; PPN = 12% of it (= 11% of the price) |
| `01` (default at other rates) | Full DPP | PPN = the invoice's rate × price |

Any code from `01` to `10` can be chosen on Tax → e-Faktur until the faktur
is approved.

Export: Tax → e-Faktur → choose the month → select invoices → **Download
XML**. The file is checked first; nothing is marked exported if it cannot be
made. It is refused when:

- the company's NPWP or NITKU is missing or the wrong length;
- a buyer has no tax ID (an NPWP buyer needs a valid NPWP);
- an invoice has no lines;
- the PPN on the faktur would differ from the PPN the invoice booked by more
  than 1 rupiah per line (rounding up to that is taken on the largest line).

After Coretax approves the fakturs, enter each **faktur number** (17 digits)
and date on Tax → e-Faktur. A buyer without NPWP is written with TIN
`0000000000000000` and their NIK, passport or other ID as the document.

## 3. Supplier bills and PPh 23

A supplier bill is for services, rent and other expenses (stock purchases go
through purchase orders and goods receipts). Recording one posts:

```
Dr Expense account          DPP
Dr Input tax (PPN masukan)  PPN
    Cr Accounts payable         DPP + PPN − PPh 23
    Cr PPh 23 payable (2330)    PPh 23
```

- **Pay** a bill from the bill (an outgoing payment: Dr Accounts payable,
  Cr Cash). Partial payments are fine.
- **Void** only an unpaid bill (Owner or Admin); its entry is reversed.
- **Bukti potong**: after creating it in e-Bupot Unifikasi, enter its number
  and date on the bill.
- **PPh 23 CSV** (Tax → Supplier bills → Export): one row per bill with
  PPh 23 in the period, with the supplier's NPWP / NIK, NITKU, tax object
  code, DPP, rate and amount, as a worksheet for e-Bupot.

The usual rate is 2%. Without an NPWP the rate is doubled: choose 4% in the
bill dialog (it does not switch by itself).

## 4. PPh 23 withheld by a customer

When a customer pays an invoice less PPh 23 (hauling, rental, services),
record the withheld part from the invoice's row on Tax → e-Faktur: it settles that much of the
invoice as a payment with method `pph23`:

```
Dr Prepaid PPh 23 (1320)    withheld
    Cr Accounts receivable      withheld
```

The dialog asks for the customer's bukti potong number.

## 5. Monthly summary

Tax → Summary shows, per month, from the ledger: PPN keluaran, PPN masukan,
PPh 21 withheld, PPh 23 withheld (payable) and PPh 23 withheld from us
(prepaid), plus the number of bills with PPh 23 and how many have a bukti
potong. It is a check before filing, not a return.

## 6. Before the first real import

The Coretax XML follows DJP's published import template as of 2025. Check
these against the template on your Coretax account and fix
`src/server/tax/coretax.ts` if they differ:

- [ ] Element names (`TaxInvoiceBulk`, `ListOfGoodService`, `BuyerAdress`
  as spelled in the template, ...).
- [ ] Unit codes (`UNIT_CODES`: ton, kg, litre, m³, pcs, day, hour; a truck
  trip is "other").
- [ ] The goods / services codes on your products.
- [ ] The PPh 23 tax object codes you use (e.g. `24-104-14` for other
  services) in e-Bupot.

Import one invoice to Coretax as a draft first and compare it with the
invoice before importing a whole month.
