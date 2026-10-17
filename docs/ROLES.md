# Workspace roles

Every member of a workspace has one role. The database enforces it for every
read and write (row-level security and the ERP functions); the app only hides
what the role cannot open.

| Role | Reads | Can do |
|---|---|---|
| Owner | Everything | Everything, including members, base currency, reopening closed periods |
| Admin | Everything | Everything except the owner's own rights; invites Finance, Sales, Inventory |
| Finance | Everything | Invoices, payments, exchange rates, manual journals |
| Sales | Customers, sales orders (and their deliveries), invoices; the product list and stock availability needed for an order | Customers, sales orders, invoicing |
| Inventory | Suppliers, products, stock, purchase orders and goods receipts, the sales orders it delivers | Suppliers, products, stock, purchasing, receiving, delivery |

**Two-factor.** In an ERP that other people use (a created ERP, or a
personal ERP shared with at least one other member), Owners, Admins and
Finance must be signed in with two-factor; without it the database gives them
nothing in that ERP and the app says how to turn it on
(`20261012000022_erp_role_two_factor.sql`). Sales and Inventory need it only
where the Owner switched on two-factor for everyone. A personal ERP used
alone does not ask for it.

Sales and Inventory do not see the dashboard, payments, cash flow, accounting,
Terminal pipelines or reports; ERP → Search offers them only their own record types.
Every member can read the settings their forms need (base currency, tax rates,
exchange rates).

The **Viewer** role was retired in `20261007000000_erp_role_scopes.sql`:
pending viewer invitations were revoked and active viewers removed from their
workspaces (history kept, `status = 'removed'`, reason "Viewer role retired",
one entry each in the workspace audit trail). Their accounts were not changed;
the owner can invite them again with another role.

## Permissions

A role is a set of permissions. The five built-in roles above are presets;
the Owner (and members with *Create and edit roles*) can also make **custom
roles** for their ERP from any of these permissions (ERP → Settings → Members
→ Manage roles). The database checks the permission, never the role name.

| Permission | Owner | Admin | Finance | Sales | Inventory |
|---|:-:|:-:|:-:|:-:|:-:|
| `read` Read all ERP data 🔒 | ✓ | ✓ | ✓ |  |  |
| `customers` Customers | ✓ | ✓ |  | ✓ |  |
| `suppliers` Suppliers | ✓ | ✓ |  |  | ✓ |
| `products` Products | ✓ | ✓ |  |  | ✓ |
| `inventory` Stock | ✓ | ✓ |  |  | ✓ |
| `sales` Sales orders | ✓ | ✓ |  | ✓ |  |
| `invoicing` Invoices 🔒 | ✓ | ✓ | ✓ | ✓ |  |
| `fulfillment` Deliveries | ✓ | ✓ |  |  | ✓ |
| `purchasing` Purchase orders | ✓ | ✓ |  |  | ✓ |
| `receiving` Goods receipts | ✓ | ✓ |  |  | ✓ |
| `payments` Payments 🔒 | ✓ | ✓ | ✓ |  |  |
| `members` Invite and manage members 🔒 | ✓ | ✓ |  |  |  |
| `audit` See workspace activity 🔒 | ✓ | ✓ |  |  |  |
| `roles.manage` Create and edit roles 🔒 | ✓ |  |  |  |  |
| `policies.manage` Set policies (AI data, approvals) 🔒 | ✓ | ✓ |  |  |  |
| `storage.view` See storage use | ✓ | ✓ | ✓ |  |  |
| `integrations.manage` Add connectors and credentials 🔒 | ✓ | ✓ |  |  |  |
| `integrations.use` Use approved connectors | ✓ | ✓ | ✓ |  |  |
| `datasets.view` Open datasets | ✓ | ✓ | ✓ |  |  |
| `datasets.query` Query and filter datasets | ✓ | ✓ | ✓ |  |  |
| `datasets.import` Import files | ✓ | ✓ | ✓ |  |  |
| `datasets.edit` Edit rows | ✓ | ✓ | ✓ |  |  |
| `datasets.schema` Change columns | ✓ | ✓ | ✓ |  |  |
| `datasets.export` Export data 🔒 | ✓ | ✓ | ✓ |  |  |
| `datasets.share` Share and restrict datasets | ✓ | ✓ |  |  |  |
| `datasets.delete` Delete datasets | ✓ | ✓ |  |  |  |
| `data.sensitive` See sensitive fields unmasked 🔒 | ✓ |  |  |  |  |
| `pipelines.view` Open pipelines and runs | ✓ | ✓ | ✓ |  |  |
| `pipelines.create` Create pipelines | ✓ | ✓ | ✓ |  |  |
| `pipelines.edit` Edit pipelines | ✓ | ✓ | ✓ |  |  |
| `pipelines.run` Run pipelines | ✓ | ✓ | ✓ |  |  |
| `pipelines.schedule` Schedule pipelines | ✓ | ✓ |  |  |  |
| `pipelines.publish` Publish pipeline versions | ✓ | ✓ |  |  |  |
| `pipelines.disable` Disable pipelines | ✓ | ✓ |  |  |  |
| `pipelines.delete` Delete pipelines | ✓ | ✓ |  |  |  |
| `approvals.decide` Approve high-impact actions 🔒 | ✓ | ✓ |  |  |  |

🔒 = sensitive: a role holding one of these needs two-factor sign-in in a
shared ERP, and a custom role with one of them cannot switch two-factor off.

* **Nobody gives more than they hold.** Inviting, changing a member's role,
  creating a custom role and sharing a restricted dataset or pipeline are all
  refused when they would hand out a permission the person does not have
  (`erp__can_grant`, `ps_set_item_access`).
* **Restricted items.** A dataset or pipeline can be *restricted*: then only
  the members, roles and custom roles on its list may open it, each with the
  permissions ticked there. Owners always have access.
* **Sensitive columns** of a dataset are masked (`••••0002`) unless the reader
  has *See sensitive fields unmasked* **and** signed in with two-factor; every
  unmasked read is in the data-access log.
* **Exports** (ERP lists and datasets) need a two-factor session.
* **Terminal** must be added to the ERP (Dashboard → Add modules) before any
  dataset, import or pipeline permission does anything.

ETNA's own staff (platform roles: super admin, support, auditor, **security
officer**) are not members of an ERP. A super admin can open a company only
through a time-boxed staff session (reason, ticket, at most 8 hours, the Owner
is e-mailed), which acts with the Owner's rights and is logged; see
`docs/ADMIN.md`.

## Where it lives

| Piece | File |
|---|---|
| Roles and permissions | `erp_role_permissions`, `erp_all_permissions`, `erp_sensitive_permissions`, custom roles (`db/migrations/20261012000030_workspace_custom_roles.sql`) |
| Restricted lists, masking | `ps_can_access_dataset`, `ps_can_access_pipeline`, `ps_item_grants` (`20261012000036`, `20261012000038`) |
| Read areas | `erp_read_grants(area)`, `erp_can_read(workspace, area)` — same file |
| App mirror (parity-tested) | `ROLE_PERMISSIONS`, `PERMISSIONS`, `SENSITIVE_PERMISSIONS`, `READ_AREAS` in `src/app/erp/lib/erpRules.ts` |
| Menu and page guard | `src/app/erp/components/shell/nav.ts`, `RoleGuard.tsx` |
| Tests | `tests/db/roleScopes.test.mjs`, `tests/db/customRoles.test.mjs`, `tests/db/terminalDatasets.test.mjs`, `tests/unit/erpRules.test.mjs` |
| Rollback | `db/rollback/rollback_20261007000000_erp_role_scopes.sql` |

Read areas: `customers`, `suppliers`, `products` (also Sales), `stock`,
`purchase_orders` (also receipts), `sales_orders` (also deliveries), `invoices`,
`payments`, `books` (cash, ledger: `read` only).
