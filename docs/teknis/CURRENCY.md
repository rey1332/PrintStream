# Currencies and exchange rates

ETNA keeps three currency ideas apart:

| Concept | Where it lives | Who changes it | Effect |
|---|---|---|---|
| **Transaction currency** | `currency` on each invoice, payment, purchase order, sales order and goods receipt (`NULL` = the base currency) | Whoever creates the document | The document's own amounts are in it, forever |
| **Base (accounting) currency** | `erp_accounting_settings.base_currency`, per workspace owner | The owner only, through Settings → Currencies | The ledger, reports and stored base amounts are in it |
| **Display currency** | This browser only (`localStorage` key `etna.displayCurrency`) | Each person | Extra converted totals on the dashboard and reports, marked `≈`; never stored with a record |

| Piece | File |
|---|---|
| Database: currency list, rates, lock, preview, foreign orders, FX settlement | `db/migrations/20261006000000_erp_currency_rates.sql` |
| Rollback | `db/rollback/rollback_20261006000000_erp_currency_rates.sql` |
| Provider (Frankfurter), server only | `src/server/currency/frankfurter.ts` |
| Service: runs everything as the user | `src/server/currency/service.ts` |
| API | `POST /api/erp/currency` (`settings`, `preview`, `confirm`, `rates`, `addRate`, `lookup`, `fetch`) |
| Browser client, display preference, exact conversion | `src/lib/currency/client.ts` |
| UI: Settings → Currencies, currency and rate fields | `src/app/erp/components/CurrencySettings.tsx`, `CurrencyFields.tsx` |
| Tests | `tests/db/currencyRates.test.mjs`, `tests/unit/currencyProvider.test.mjs`, `tests/unit/currencyConvert.test.mjs` |

## 1. What every foreign-currency document stores

| Column | Meaning |
|---|---|
| `total` / `amount` | Original amount in the document currency (NUMERIC) |
| `currency` | ISO 4217 code (`NULL` = base currency) |
| `fx_rate` | 1 unit of `currency` in the base currency, NUMERIC(24,12) |
| `fx_rate_date` | Effective date of the rate used |
| `fx_rate_source` | `rate_table` (stored rate for the date), `manual` (typed in for this document) or `document` (taken from the invoice/order being paid or reversed); `NULL` on documents made before rates were tracked |
| `fx_rate_id` | The stored rate row, when one was used |
| `base_total` / `base_amount` | Generated: `round(amount × fx_rate, 2)`; never typed in |

Amounts are never rewritten: changing settings, adding rates or confirming the
base currency does not touch any stored amount or ledger line.

## 2. Exchange rates

- Table `erp_exchange_rates` (per workspace owner): pair, rate, effective date,
  source (`manual` or `frankfurter`), provider label, retrieval time, note, who
  added it. **Append-only**: a correction is a new row; updates are refused.
- Who may add rates by hand: Owner, Admin and Finance (the `payments`
  permission). Who may fetch from the provider: anyone who can create a
  currency document (invoicing, payments, purchasing or sales). Everyone who
  can read the workspace can look rates up.
- Lookup (`erp_exchange_rate_lookup`): the latest rate on or before the date
  (newest entry for that date wins); the inverse pair is used when it is more
  recent. A rate older than **7 days** before the document date is never used
  automatically: the form says so and asks for a fetch or a manual rate.
- Financial recognition uses the rate of the transaction date: an invoice its
  invoice date, a payment its payment date, a goods receipt its receipt date.
  The order-date rate on a purchase/sales order is for reference and approvals.
- No rate is ever invented or hard-coded. With no usable rate, the document is
  refused with `No exchange rate from X to Y on or before <date>`.

### Provider (Frankfurter)

Rates come from `https://api.frankfurter.dev/v2` (free, no key) and are fetched
by the server only, when a document needs a missing rate or from Settings →
Currencies → Fetch. Each fetched rate is stored with its date, the provider
label (e.g. `Frankfurter (ECB)` or `Frankfurter (blend)`) and the retrieval
time. The provider import function only runs when called by this server route.

| Variable | Default | Meaning |
|---|---|---|
| `EXCHANGE_RATE_PROVIDER` | `frankfurter` | `off` = manual rates only |
| `FRANKFURTER_URL` | `https://api.frankfurter.dev/v2` | Self-hosted Frankfurter, if any |
| `FRANKFURTER_PROVIDERS` | *(blend)* | Limit to one source, e.g. `ECB` |

Requests time out after 8 s. Logs carry only `[currency] provider status <code>`
or `[currency] provider unreachable`, never URLs with parameters or rates.

## 3. Base currency: preview, confirmation, lock

Older workspaces stored amounts without a currency code, and the base currency
defaulted to `USD` whether or not anyone chose it. ETNA does not guess.

1. **Preview (dry run)** — Settings → Currencies → *Review existing records*
   (`erp_currency_preview`). Per table: rows without a currency code, their
   sum, first/last date, how many were recorded after the settings were last
   saved (so their currency is certain), and foreign-currency rows. Status:
   - `noRecords` — nothing recorded yet; the owner may pick any currency;
   - `unambiguous` — every base-currency row was recorded after the base
     currency was last saved; confirming locks it;
   - `needsDecision` — some rows predate the last save (or the base currency
     was never chosen): the owner must check the totals and say which
     currency they are in.
2. **Confirm** (`erp_confirm_base_currency`, owner only, with the row count seen
   in the preview — a changed count is refused so nobody confirms stale
   numbers). Confirming records the currency, who confirmed and when, and
   **does not rewrite anything**. It is logged in `erp_currency_audit`.
3. **Lock** — once confirmed and records exist, the base currency cannot
   change. Before that, only the owner can change it, and only while there are
   no financial records; a direct table update is refused.
4. Re-declaring a different currency for the legacy rows is refused while
   foreign-currency documents exist (their rates are relative to the old
   base).

**Reconciliation**: the preview's per-table sums are the reconciliation
figures. They must match the same totals before and after confirmation (they
do: nothing is rewritten), and the trial balance is unchanged.

**Recovery plan**: confirmation writes two columns and one audit row. If the
wrong currency was confirmed on a workspace with no foreign documents, an
operator can clear `base_currency_confirmed_at`/`_by` for that owner and the
owner confirms again; amounts were never changed, so nothing else needs
restoring. For the whole feature, see the rollback script (§7).

## 4. Documents

- **Invoices**: currency picker + rate for the invoice date (stored rate, or
  entered). Lists show the original amount and, below it, `= base amount · at
  rate` with the rate date and source.
- **Payments**: always in the currency of the invoice or purchase order they
  settle (a different currency is refused); rate for the payment date.
- **Purchase orders**: in any currency. Product purchase prices (base
  currency) are converted into the order currency at the order rate when a
  product is picked. Approval thresholds compare the base equivalent.
  Each receipt values stock at the receipt-date rate
  (`unit_cost = round(price × rate, 4)`); a reversal uses the original line's
  cost. Payments release the payable at the receipts' value-weighted rate and
  post the difference to **4200 Exchange gains/losses**.
- **Sales orders**: in any currency; invoicing a foreign order asks for (or
  looks up) today's rate. Receivables settle at the invoice rate, differences
  to 4200.
- **Settlement**: when a document is fully settled in its own currency, any
  residual base-currency balance (rounding across several payments/receipts)
  is cleared to 4200 as an `fx_settlement` journal entry; it is reversed if
  the document becomes unsettled (e.g. a payment is voided).

## 5. Totals, reports, exports, workflows

- Nothing adds amounts across currencies without converting them. Totals on
  the order pages, reports and dashboard use each document's stored base
  amount. Dashboard payables/commitments for foreign purchase orders use the
  order's rate (an estimate); the ledger is the figure of record.
- Workflow summaries refuse to sum a document-currency field unless grouped by
  currency (`currencyGroupRequired`); base amount fields sum freely.
- Exports fill in the currency code for documents in the base currency and
  add a `base_currency` column to every table with amounts.
- Display currency: the dashboard and report KPIs can show a converted figure
  under the base amount, marked `≈`, with the rate, its date and source.
  Without a usable rate nothing is converted and the page says so.

## 6. Formatting and rounding

- Amounts show the ISO code wherever the symbol is ambiguous (`$`, `¥`, `kr`,
  `R`, `Rs`, `Fr`, …): `USD 1,000.00`, `SGD 1,000.00`.
- Minor units come from ISO 4217 (`erp_currencies`, 162 codes): 0 for JPY,
  KRW, VND…, 3 for BHD, KWD…, 2 otherwise.
- Stored base amounts are rounded half away from zero to 2 decimals
  (PostgreSQL `round`). Display conversion uses exact decimal arithmetic with
  the same rounding, to the display currency's minor units.

### Known limits

- The ledger keeps 2 decimals, so a 3-decimal currency (KWD, BHD…) cannot be
  the base currency; it can be a transaction currency.
- Browsers format IDR with 0 decimals; stored values keep 2.
- `balance` columns on customers and suppliers are not used by ETNA and are
  not converted.

## 7. Operations

- Logs: `[currency]` (provider status or error code only).
- Review `erp_currency_audit` (base confirmed/changed, rates added, provider
  imports) with the other audit logs.
- Rollback: `db/rollback/rollback_20261006000000_erp_currency_rates.sql`
  refuses while foreign-currency orders or `fx_settlement` entries exist;
  otherwise it restores the previous functions, drops the rate tables and
  provenance columns, and keeps every amount, currency and rate on invoices
  and payments (`fx_rate` stays NUMERIC(24,12)).
