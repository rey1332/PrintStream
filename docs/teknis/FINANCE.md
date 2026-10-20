# Cash, bank and fixed assets

| What | Where in ETNA | Who |
|---|---|---|
| **Cash and bank accounts** with their balances | Cash & bank → Accounts | `payments` (Owner, Admin, Finance) |
| **Transfers** between them | Cash & bank → Transfers | `payments` |
| **Bank statements**: import, match, reconcile | Cash & bank → Reconciliation | `payments` |
| **Fixed assets** and monthly depreciation | Fixed assets | `payments` |

| Piece | File |
|---|---|
| Database | `db/migrations/20261012000054_erp_finance.sql` |
| Rollback | `db/rollback/rollback_20261012000054_erp_finance.sql` |
| Bank CSV reader (BCA, Mandiri, BRI, BNI, any CSV) | `src/lib/finance/bankCsv.ts` |
| Browser service | `src/app/erp/lib/financeService.ts` |
| UI | `src/app/erp/cash-bank/`, `src/app/erp/fixed-assets/` |
| Tests | `tests/db/cashBankAssets.test.mjs`, `tests/unit/bankCsv.test.mjs` |

## 1. Cash and bank accounts

Every cash or bank account is a ledger account of its own (codes `1001`
to `1099`). The first account is the ledger's **Cash and bank (1000)**,
which every payment went to before; payments and cash-book entries that do
not name an account still go there.

- **Payments** (Payments → Record payment) and **supplier bill payments**
  (Tax → Supplier bills → Pay) ask which account the money went through as
  soon as there is more than one. The account of a recorded payment cannot
  change: void the payment and record it again.
- **Transfers** (bank to petty cash, between banks) post
  `Dr to-account / Cr from-account`. A transfer can be voided once; not while
  a bank statement line is matched to it.
- An account can be **closed** when its balance is zero; the default account
  cannot be closed.

## 2. Bank statements and reconciliation

1. Download the account's transactions as **CSV** from internet or business
   banking (KlikBCA / myBCA, Livin' / MCM Mandiri, BRImo / IBBIZ, BNIdirect).
2. Cash & bank → Reconciliation → choose the account → **Import statement**.
   The bank is recognised from the file (or choose it); for any other CSV,
   choose the columns: one amount column (plus a D/K or DB/CR column if the
   bank uses one) or separate debit and credit columns. Dates without a year
   (BCA's `01/10`) take the year from the file's period line.
3. ETNA keeps each line once per account, so importing a file again, or two
   files that overlap, adds nothing twice. Pending lines (`PEND`) are left out.
4. Lines are **matched automatically** to ledger lines on the account's ledger
   account with the same amount within three days, when there is exactly one.
5. For each open line:
   - **Match**: choose the ledger line (same amount, within a month);
   - **Post to the books**: bank charges, interest, a transfer nobody
     recorded. It is posted against the account you choose (Bank charges
     `6520` is offered for money out, Other income for money in) and matched;
   - **Not in the books**: a line the bank reversed itself, or one from
     before the books started; a reason is required.

The summary explains the difference between the bank's balance (the last
balance in the statement) and the books on the last day of the month:

```
bank balance = book balance + open bank lines − book lines not at the bank
```

"In the books, not at the bank" lists entries on the account from the first
statement line on that no line is matched to: cheques not cashed yet, or
entries to check. The account is reconciled when the unexplained difference
is 0 and no line is open.

## 3. Fixed assets

| Field | Notes |
|---|---|
| Category | Heavy equipment, vehicle, machinery, building, land, office, other |
| Cost, residual value | Residual value below the cost (often 0) |
| Useful life | Months; the tax groups are offered (group 1: 4 years, 2: 8, 3: 16, 4: 20; permanent buildings 20) |
| Method | Straight line, declining balance (default rate: twice the straight-line rate, e.g. 50% a year for 4 years), or none (land) |
| How it was paid | Paid from a cash account, owed to the seller (Accounts payable), owned before the books started (Opening balance equity, with the depreciation already taken), or already in the books (nothing posted) |

- **Post depreciation** posts every month not posted yet, for every active
  asset, up to the month chosen, one entry per asset and month
  (`Dr Depreciation expense 6500 / Cr Accumulated depreciation 1590`), dated
  the last day of the month. Running it again posts nothing twice. The last
  month of the life takes what is left down to the residual value.
- **Sell or scrap**: depreciation is posted through the month of the date,
  then the asset leaves the books; proceeds go to the chosen account and the
  difference to the book value to **Gain on disposal (4200)** or **Loss on
  disposal (6510)**.
- **Void**: only an asset with no depreciation posted (entered by mistake);
  its purchase entry is reversed.
- **Existing assets**: choose "owned before the books started", the month
  ETNA starts depreciating it (after the lock date), the months already
  depreciated and the depreciation already taken.

The useful lives offered are those of the Indonesian tax groups
(PMK 72/2023). The commercial books may use other lives; the fiscal
depreciation for the annual return (SPT Tahunan) is worked out from them by
the tax adviser.
