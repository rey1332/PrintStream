# ERP ontology and cross-ERP search (ERP → Search)

A business-object layer over ETNA's existing ERP tables, and a search page
built on it. It is a description of the data, not a second copy: every object
is an existing table, every relationship an existing column, and search reads
the tables themselves.

| Piece | File |
|---|---|
| Registry: objects, properties, relationships, links, role presets | `src/lib/ontology/registry.ts` |
| Query parsing and request validation | `src/lib/ontology/query.ts` |
| SQL for properties and relationships (server only) | `src/server/ontology/sql.ts` |
| Service: runs everything as the user, access log | `src/server/ontology/service.ts` |
| API | `POST /api/erp/ontology/search`, `POST /api/erp/ontology/record` |
| Database: search function, indexes, access log | `db/migrations/20261005000000_erp_ontology_search.sql` |
| Page | `src/app/erp/search/page.tsx` |
| Tests | `tests/db/ontology.test.mjs` |

The registry has no database client in it; the SQL is plain PostgreSQL (no
Supabase APIs), run through ETNA's own executor.

## 1. Data model map

All objects are owned by a workspace (`workspace_id`) and read under row-level
security by area (`erp_can_read(workspace, area)`, which also enforces the
workspace two-factor rule; see docs/teknis/ROLES.md): Owner, Admin and Finance read
everything, Sales and Inventory only their areas. People always see their own
rows (`user_id`). Order, receipt and journal lines have no workspace of their
own and are read through their parent.

| Object (type key) | Table | Reference shown | Searched fields |
|---|---|---|---|
| Supplier (`supplier`) | `erp_suppliers` | `SUP-` + id prefix | name, email, phone, city, address |
| Customer (`customer`) | `erp_customers` | `CUS-` + id prefix | name, email, phone, city, address |
| Product (`product`) | `erp_products` | `PRD-` + id prefix | name, SKU, category |
| Purchase order (`purchaseOrder`) | `erp_purchase_orders` | `PO-` + id prefix | supplier, notes, cancel reason |
| Goods receipt (`goodsReceipt`) | `erp_fulfillment_events` (`kind = 'purchase_receipt'`) | `GR-` + id prefix | note, reason, the order's supplier/notes |
| Sales order (`salesOrder`) | `erp_sales_orders` | `SO-` + id prefix | customer, notes, cancel reason |
| Delivery (`delivery`) | `erp_fulfillment_events` (`kind = 'sales_delivery'`) | `DN-` + id prefix | note, reason, the order's customer/notes |
| Invoice (`invoice`) | `erp_invoices` | `INV-` + id prefix | customer, void reason |
| Payment (`payment`) | `erp_payments` | `PAY-` + id prefix | party, method, note, void reason |
| Cash transaction (`cashTransaction`) | `erp_transactions` | `TRX-` + id prefix | category, description |
| Journal entry (`journalEntry`) | `erp_journal_entries` | `JE-<entry no>` | memo |
| Ledger account (`glAccount`) | `erp_gl_accounts` | account code | code, name |
| Stock movement (`stockMovement`) | `erp_stock_movements` | `MOV-` + id prefix | product, note |

Typing a reference also finds the records that point to it: a purchase order's
reference finds its receipts and payments, a sales order's its invoice and
deliveries, an invoice's or payment's its journal entries.

### Relationships

| From | Relationship | To | Backed by |
|---|---|---|---|
| Supplier | purchase orders | Purchase order | `erp_purchase_orders.supplier_id` |
| Customer | sales orders, invoices | Sales order, Invoice | `customer_id` on each |
| Product | purchase orders, sales orders | orders | order lines (`product_id`) |
| Product | goods receipts, deliveries | receipt / delivery | `erp_fulfillment_event_lines.product_id` |
| Product | stock movements | Stock movement | `erp_stock_movements.product_id` |
| Purchase order | supplier | Supplier | `supplier_id` |
| Purchase order | products | Product | `erp_purchase_order_items` |
| Purchase order | goods receipts | Goods receipt | `erp_fulfillment_events.purchase_order_id` |
| Purchase order | payments | Payment | `erp_payments.purchase_order_id` |
| Goods receipt / Delivery | order, products, reverses, reversed by | … | `purchase_order_id` / `sales_order_id`, event lines, `reverses_event_id`, `reversed_by_event_id` |
| Sales order | customer, products, deliveries, invoices | … | `customer_id`, lines, `sales_order_id` |
| Invoice | customer, sales order, payments | … | `customer_id`, `sales_order_id`, `erp_payments.invoice_id` |
| Payment | invoice, purchase order, cash transaction | … | `invoice_id`, `purchase_order_id`, `transaction_id` |
| Cash transaction | payment | Payment | `source_payment_id` |
| Invoice, Payment, Cash transaction, Goods receipt, Delivery, Stock movement | journal entries | Journal entry | `erp_journal_entries.source_type` + `source_id` |
| Journal entry | accounts | Ledger account | `erp_journal_lines` |
| Journal entry | source document | one of the above | `source_type` decides the table |
| Journal entry | reverses / reversed by | Journal entry | `reverses_entry_id` |
| Ledger account | journal entries | Journal entry | `erp_journal_lines.account_id` |

### Schema gaps and ambiguities (not changed by this work)

- **No document numbers.** Orders, invoices and payments have only UUIDs. The
  reference shown is a type prefix plus the first 8 characters of the id — the
  same short form the Payments page already uses. Adding real numbering would
  be a separate change to the business tables.
- **No supplier bills.** Purchasing has no accounts-payable invoice; a purchase
  order is paid directly (`erp_payments.purchase_order_id`). "A purchase order's
  invoice" does not exist to link to.
- **Payments name their party as text.** `erp_payments.party` is free text; a
  payment links to a supplier or customer only through its purchase order or
  invoice, so supplier → payments is not a relationship.
- **No separate Purchasing role.** Purchasing and receiving belong to the
  Inventory role; the Purchasing search preset is attached to it.
- **Roles read by area.** Each type's registry `area` decides who may search
  and open it (the same rule as the RLS policies); Sales and Inventory see only
  their types, and relationships to other areas are not followed. Role presets
  narrow what is searched by default within that.
- **Pages have no per-record address.** Links open the module page with
  `?focus=<id>`; the page highlights the row (`useFocusedRecord`). The journal
  opens on the entry's date (`?entry=&date=`), a ledger account as a filtered
  journal (`?account=`).
- Not in the ontology: warehouses and per-warehouse stock, stock transfers and
  reservations, approval requests, audit logs.

## 2. How search works

1. The API validates the request (types from the registry, filters valid for
   the type, text length) and signs the transaction in as the user: the
   `authenticated` role, the user's claims, the two-factor check and a 15 s
   statement timeout — the same setup as ETNA's data API.
2. It resolves the workspace role (`erp_workspace_role`); non-members are
   refused, and each object type needs its registry area.
3. For each type, `erp_ontology_search` returns matching ids and a count
   (capped at 101). It is `SECURITY DEFINER`: it checks
   `erp_can_read(workspace, erp_ontology_area(type))` itself, then searches with the
   trigram and date indexes. Its SQL fragments are constants chosen by type;
   user input is only ever a bind parameter.
4. The rows are then read **by id, as the user**, so row-level security
   applies to every row returned (and to the order/receipt/journal lines used
   for totals).
5. Related records are read as the user too, within the same workspace.
   Relationships to types the role may not read are not followed.

Why step 3 is a definer function: under RLS PostgreSQL evaluates the policy
function for each row before any non-leakproof filter such as `ILIKE`, so a
text search read every row of the workspace (measured ~400 ms per type at
200k rows). Checking the permission once and returning only ids keeps RLS
authoritative for what is actually shown.

**No derived data.** There is no search table or projection to synchronise:
new, changed, cancelled and deleted records are found (or not) immediately,
and the indexes are maintained by PostgreSQL. Nothing needs rebuilding after a
restore; `REINDEX` is enough if an index is ever damaged.

## 3. Security and audit

- Every request needs a signed-in session and a same-site origin (`withAuth`).
- Workspace isolation: every statement is limited to the requested workspace,
  after the membership check, and RLS applies on top. A record id from another
  workspace answers "not found" — identical to a missing record.
- Counts, related records and link targets come from the same checked reads,
  so they reveal nothing the user could not open in the module pages.
- Owner, workspace and acting-user columns are never returned.
- `erp_access_log` records each search (object types, number of results) and
  each record view (type and id) with the workspace and the person — never the
  search text or field values. People see their own entries; owners and
  admins (the `audit` permission) see the workspace's. Nobody can write or
  delete entries directly; `erp_log_access` writes them. Review it with the
  other audit logs (docs/teknis/OPERATIONS.md).
- Search is read-only. Changes still go through the module pages and their
  validated business functions.

## 4. Performance (measured)

PostgreSQL 16, one workspace with 200k purchase orders, 200k invoices, 200k
payments, 50k suppliers, 50k customers, 50k receipts, 100k journal entries
(200k lines on one account), plus a second workspace of the same size; run as
a member through the real service code:

| Request | Time |
|---|---|
| All 13 types, rare word | 35 ms |
| All 13 types, word matching every order ("supplier") | 17 ms |
| All 13 types, a reference (`PO-…`) | 35 ms |
| Purchase orders, page 3 of a common word | 6 ms |
| Purchase orders by status and month, no text | 4 ms |
| Supplier with 50k purchase orders, with related records | 5 ms |
| Ledger account with 200k journal lines, with related records | 6 ms |

Words shorter than 3 characters cannot use the trigram indexes (80–200 ms per
type at this size), so searching several types needs at least 3 characters;
one type accepts 2. `pg_trgm` is a trusted extension the database owner can
create; where it is unavailable the migration skips the text indexes and
search still works, slower.

The migration also rewrote the two order-line "own records" policies from
`IN (SELECT …)` to an equivalent `EXISTS (…)`: the old form hashed every order
the user owned before reading any line (270 ms for 20 orders at 200k orders),
which slowed the order pages as well.

## 5. Adding a module or relationship

1. Add the object to `ONTOLOGY_TYPES` and `ONTOLOGY` in the registry
   (table, permission, reference style, properties, page link, relations).
2. Add its property SQL and relationship conditions to `TYPE_SQL` /
   `RELATION_SQL` in `src/server/ontology/sql.ts` (and the reverse
   relationship on the other object).
3. Add a `WHEN '<type>'` branch to `erp_ontology_search` in a **new**
   migration (table, text expression, status, date, order) with a matching
   trigram index and a `(workspace_id, <date>)` index.
4. Add labels to `src/lib/i18n/messages/ontology.ts` and, if the module page
   lists records, `useFocusedRecord` on it.
5. `tests/db/ontology.test.mjs` then checks that registry and SQL agree and
   that every property and relationship query runs against the schema; add a
   test with real records created through the business functions.

A relationship is only added when a column backs it. Text matches (such as a
payment's party name) are not relationships.
