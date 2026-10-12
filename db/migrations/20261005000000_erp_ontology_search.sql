-- ─── ERP ontology search ────────────────────────────────────────────────────
-- Cross-ERP search (ERP → Search). The ontology registry
-- (src/lib/ontology/registry.ts) describes the business objects; this file
-- gives the database what it needs to search them quickly and safely.
--
-- No data is copied: there is no search table to keep in sync. Search reads
-- the ERP tables themselves, helped by indexes that PostgreSQL maintains with
-- every insert, update and delete.
--
-- Why a SECURITY DEFINER function: row-level security evaluates its policy
-- (erp_has_permission, per row) before any filter that is not leakproof, and
-- ILIKE is not, so under RLS a text search reads every row of the workspace
-- (measured: ~400 ms per type at 200k rows). erp_ontology_search checks the
-- caller's permission for the workspace ONCE, with the same function the RLS
-- policies use (read permission, including the workspace two-factor rule),
-- then finds matching ids through the indexes. It returns ids only; the app
-- then reads the rows as the user, so RLS still applies to every returned row.
--
-- Also: erp_access_log, a metadata-only record of searches and record views
-- (no search text, no field values), and a faster but equivalent form of the
-- two order-line "own records" policies (section 2b).
--
-- Additive only. Index builds lock writes on the table while they run
-- (seconds on large tables): apply outside business hours.
--
-- Rollback: db/rollback/rollback_20261005000000_erp_ontology_search.sql

-- ─── 1. Trigram extension (optional) ─────────────────────────────────────────
-- pg_trgm is a trusted extension (the database owner can create it). Where it
-- is unavailable the text indexes are skipped: search still works, slower.
DO $$
DECLARE
  ext_schema TEXT;
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm is not available (%): text search runs without trigram indexes', SQLERRM;
  END;

  SELECT n.nspname INTO ext_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm';
  IF ext_schema IS NULL THEN RETURN; END IF;

  -- One index per table over the same expression erp_ontology_search matches.
  EXECUTE format($i$CREATE INDEX IF NOT EXISTS idx_erp_suppliers_search_trgm ON public.erp_suppliers USING gin (
    (coalesce(name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(city, '') || ' ' || coalesce(address, '')) %I.gin_trgm_ops)$i$, ext_schema);
  EXECUTE format($i$CREATE INDEX IF NOT EXISTS idx_erp_customers_search_trgm ON public.erp_customers USING gin (
    (coalesce(name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(city, '') || ' ' || coalesce(address, '')) %I.gin_trgm_ops)$i$, ext_schema);
  EXECUTE format($i$CREATE INDEX IF NOT EXISTS idx_erp_products_search_trgm ON public.erp_products USING gin (
    (coalesce(name, '') || ' ' || coalesce(sku, '') || ' ' || coalesce(category, '')) %I.gin_trgm_ops)$i$, ext_schema);
  EXECUTE format($i$CREATE INDEX IF NOT EXISTS idx_erp_purchase_orders_search_trgm ON public.erp_purchase_orders USING gin (
    (coalesce(supplier_name, '') || ' ' || coalesce(notes, '') || ' ' || coalesce(cancel_reason, '')) %I.gin_trgm_ops)$i$, ext_schema);
  EXECUTE format($i$CREATE INDEX IF NOT EXISTS idx_erp_sales_orders_search_trgm ON public.erp_sales_orders USING gin (
    (coalesce(customer_name, '') || ' ' || coalesce(notes, '') || ' ' || coalesce(cancel_reason, '')) %I.gin_trgm_ops)$i$, ext_schema);
  EXECUTE format($i$CREATE INDEX IF NOT EXISTS idx_erp_invoices_search_trgm ON public.erp_invoices USING gin (
    (coalesce(customer_name, '') || ' ' || coalesce(void_reason, '')) %I.gin_trgm_ops)$i$, ext_schema);
  EXECUTE format($i$CREATE INDEX IF NOT EXISTS idx_erp_payments_search_trgm ON public.erp_payments USING gin (
    (coalesce(party, '') || ' ' || coalesce(method, '') || ' ' || coalesce(note, '') || ' ' || coalesce(void_reason, '')) %I.gin_trgm_ops)$i$, ext_schema);
  EXECUTE format($i$CREATE INDEX IF NOT EXISTS idx_erp_transactions_search_trgm ON public.erp_transactions USING gin (
    (coalesce(category, '') || ' ' || coalesce(description, '')) %I.gin_trgm_ops)$i$, ext_schema);
  EXECUTE format($i$CREATE INDEX IF NOT EXISTS idx_erp_journal_entries_search_trgm ON public.erp_journal_entries USING gin (
    (coalesce(memo, '')) %I.gin_trgm_ops)$i$, ext_schema);
  EXECUTE format($i$CREATE INDEX IF NOT EXISTS idx_erp_gl_accounts_search_trgm ON public.erp_gl_accounts USING gin (
    (coalesce(code, '') || ' ' || coalesce(name, '')) %I.gin_trgm_ops)$i$, ext_schema);
  EXECUTE format($i$CREATE INDEX IF NOT EXISTS idx_erp_stock_movements_search_trgm ON public.erp_stock_movements USING gin (
    (coalesce(product_name, '') || ' ' || coalesce(note, '')) %I.gin_trgm_ops)$i$, ext_schema);
  EXECUTE format($i$CREATE INDEX IF NOT EXISTS idx_erp_fulfillment_events_search_trgm ON public.erp_fulfillment_events USING gin (
    (coalesce(note, '') || ' ' || coalesce(reason, '')) %I.gin_trgm_ops)$i$, ext_schema);
END;
$$;

-- ─── 2. Ordering and relationship indexes ─────────────────────────────────────
-- Newest-first (or by name) within a workspace, so a common word still returns
-- its first page without sorting every match.
CREATE INDEX IF NOT EXISTS idx_erp_suppliers_ws_name ON public.erp_suppliers(workspace_id, name, id);
CREATE INDEX IF NOT EXISTS idx_erp_customers_ws_name ON public.erp_customers(workspace_id, name, id);
CREATE INDEX IF NOT EXISTS idx_erp_products_ws_name ON public.erp_products(workspace_id, name, id);
CREATE INDEX IF NOT EXISTS idx_erp_purchase_orders_ws_date ON public.erp_purchase_orders(workspace_id, order_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_erp_sales_orders_ws_date ON public.erp_sales_orders(workspace_id, order_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_erp_invoices_ws_date ON public.erp_invoices(workspace_id, invoice_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_erp_payments_ws_date ON public.erp_payments(workspace_id, payment_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_erp_transactions_ws_date ON public.erp_transactions(workspace_id, transaction_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_erp_stock_movements_ws_date ON public.erp_stock_movements(workspace_id, movement_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_erp_fulfillment_events_ws_kind ON public.erp_fulfillment_events(workspace_id, kind, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_erp_gl_accounts_ws_code ON public.erp_gl_accounts(workspace_id, code, id);

-- Foreign keys that related-record lookups follow and had no index.
CREATE INDEX IF NOT EXISTS idx_erp_invoices_customer_id ON public.erp_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_erp_purchase_order_items_product ON public.erp_purchase_order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_erp_sales_order_items_product ON public.erp_sales_order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_erp_fulfillment_event_lines_product ON public.erp_fulfillment_event_lines(product_id);
CREATE INDEX IF NOT EXISTS idx_erp_stock_movements_product ON public.erp_stock_movements(product_id, movement_date DESC);
CREATE INDEX IF NOT EXISTS idx_erp_journal_entries_source_id ON public.erp_journal_entries(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_erp_payments_transaction_id ON public.erp_payments(transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_erp_transactions_source_payment ON public.erp_transactions(source_payment_id) WHERE source_payment_id IS NOT NULL;

-- Statistics for the new expression indexes, so the planner can tell a rare
-- word (use the text index) from a common one (walk the date index).
ANALYZE public.erp_suppliers, public.erp_customers, public.erp_products, public.erp_purchase_orders,
  public.erp_sales_orders, public.erp_invoices, public.erp_payments, public.erp_transactions,
  public.erp_journal_entries, public.erp_gl_accounts, public.erp_stock_movements, public.erp_fulfillment_events;

-- ─── 2b. Order-line policies: same rule, per-row lookup ───────────────────────
-- The "own records" policies on order lines were written as
--   purchase_order_id IN (SELECT id FROM erp_purchase_orders WHERE user_id = auth.uid())
-- which makes PostgreSQL hash every order the user owns before reading any
-- line (measured: 270 ms to read 20 orders' lines for a user with 200k
-- orders; this also slowed the Purchase and Sales order pages). The EXISTS
-- form below admits exactly the same rows (the order id is unique, and a NULL
-- order id matches neither form) and looks up one order per line.
ALTER POLICY "users_manage_own_erp_purchase_order_items" ON public.erp_purchase_order_items
  USING (EXISTS (SELECT 1 FROM public.erp_purchase_orders o WHERE o.id = purchase_order_id AND o.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.erp_purchase_orders o WHERE o.id = purchase_order_id AND o.user_id = auth.uid()));
ALTER POLICY "users_manage_own_erp_sales_order_items" ON public.erp_sales_order_items
  USING (EXISTS (SELECT 1 FROM public.erp_sales_orders o WHERE o.id = sales_order_id AND o.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.erp_sales_orders o WHERE o.id = sales_order_id AND o.user_id = auth.uid()));

-- ─── 3. Search ────────────────────────────────────────────────────────────────
-- Ids of the records of one object type that match, newest first (or by
-- name/code), plus how many match (counted up to 101).
--
--   p_workspace_id  the workspace (read permission required), or NULL for the
--                   caller's own records when workspaces are off
--   p_type          object type key from the ontology registry
--   p_patterns      ILIKE patterns (already escaped by the app); every one
--                   must match the record's text
--   p_id_from/to    a reference typed as the start of an id (uuid range)
--   p_number        a journal entry number
--   p_statuses      status values to keep
--   p_date_from/to  inclusive date range on the type's main date
--
-- Every SQL fragment below is a constant chosen by p_type; user input only
-- ever travels as a bind parameter.
CREATE OR REPLACE FUNCTION public.erp_ontology_search(
  p_workspace_id UUID, p_type TEXT, p_patterns TEXT[], p_id_from UUID, p_id_to UUID, p_number INTEGER,
  p_statuses TEXT[], p_date_from DATE, p_date_to DATE, p_limit INTEGER, p_offset INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tbl TEXT; txt TEXT; extra TEXT := 'TRUE'; status_expr TEXT := 'NULL::text'; date_expr TEXT; order_expr TEXT;
  ref_extra TEXT := 'FALSE'; number_expr TEXT := NULL;
  -- Receipts and deliveries also match their order's text.
  order_table TEXT := NULL; order_fk TEXT; order_txt TEXT; order_matches INTEGER;
  scope TEXT; text_cond TEXT := 'TRUE'; ref_cond TEXT := 'FALSE'; where_sql TEXT;
  ids JSONB; total INTEGER;
  n INTEGER := COALESCE(array_length(p_patterns, 1), 0);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  -- The same check the read policies make (membership, role, two-factor rule).
  IF p_workspace_id IS NOT NULL AND NOT public.erp_has_permission(p_workspace_id, 'read') THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF n > 5 OR EXISTS (SELECT 1 FROM unnest(p_patterns) p WHERE p IS NULL OR char_length(p) > 210)
     OR COALESCE(array_length(p_statuses, 1), 0) > 20
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 50 OR p_offset IS NULL OR p_offset < 0 OR p_offset > 5000
     OR (p_id_from IS NULL) <> (p_id_to IS NULL) THEN
    RAISE EXCEPTION 'Invalid search' USING ERRCODE = '22023';
  END IF;

  CASE p_type
    WHEN 'supplier' THEN
      tbl := 'public.erp_suppliers';
      txt := $x$(coalesce(t.name, '') || ' ' || coalesce(t.email, '') || ' ' || coalesce(t.phone, '') || ' ' || coalesce(t.city, '') || ' ' || coalesce(t.address, ''))$x$;
      date_expr := 't.created_at::date'; order_expr := 't.name, t.id';
    WHEN 'customer' THEN
      tbl := 'public.erp_customers';
      txt := $x$(coalesce(t.name, '') || ' ' || coalesce(t.email, '') || ' ' || coalesce(t.phone, '') || ' ' || coalesce(t.city, '') || ' ' || coalesce(t.address, ''))$x$;
      date_expr := 't.created_at::date'; order_expr := 't.name, t.id';
    WHEN 'product' THEN
      tbl := 'public.erp_products';
      txt := $x$(coalesce(t.name, '') || ' ' || coalesce(t.sku, '') || ' ' || coalesce(t.category, ''))$x$;
      date_expr := 't.created_at::date'; order_expr := 't.name, t.id';
    WHEN 'purchaseOrder' THEN
      tbl := 'public.erp_purchase_orders';
      txt := $x$(coalesce(t.supplier_name, '') || ' ' || coalesce(t.notes, '') || ' ' || coalesce(t.cancel_reason, ''))$x$;
      status_expr := 't.status::text'; date_expr := 't.order_date'; order_expr := 't.order_date DESC, t.id';
    WHEN 'goodsReceipt' THEN
      tbl := 'public.erp_fulfillment_events';
      extra := $x$t.kind = 'purchase_receipt'$x$;
      txt := $x$(coalesce(t.note, '') || ' ' || coalesce(t.reason, ''))$x$;
      -- A receipt also matches its purchase order's supplier and reference.
      order_table := 'public.erp_purchase_orders'; order_fk := 'purchase_order_id';
      order_txt := $x$(coalesce(o.supplier_name, '') || ' ' || coalesce(o.notes, '') || ' ' || coalesce(o.cancel_reason, ''))$x$;
      ref_extra := 't.purchase_order_id BETWEEN $4 AND $5';
      status_expr := $x$CASE WHEN t.is_reversal THEN 'reversal' WHEN t.reversed_by_event_id IS NOT NULL THEN 'reversed' ELSE 'posted' END$x$;
      date_expr := 't.created_at::date'; order_expr := 't.created_at DESC, t.id';
    WHEN 'salesOrder' THEN
      tbl := 'public.erp_sales_orders';
      txt := $x$(coalesce(t.customer_name, '') || ' ' || coalesce(t.notes, '') || ' ' || coalesce(t.cancel_reason, ''))$x$;
      status_expr := 't.status::text'; date_expr := 't.order_date'; order_expr := 't.order_date DESC, t.id';
    WHEN 'delivery' THEN
      tbl := 'public.erp_fulfillment_events';
      extra := $x$t.kind = 'sales_delivery'$x$;
      txt := $x$(coalesce(t.note, '') || ' ' || coalesce(t.reason, ''))$x$;
      order_table := 'public.erp_sales_orders'; order_fk := 'sales_order_id';
      order_txt := $x$(coalesce(o.customer_name, '') || ' ' || coalesce(o.notes, '') || ' ' || coalesce(o.cancel_reason, ''))$x$;
      ref_extra := 't.sales_order_id BETWEEN $4 AND $5';
      status_expr := $x$CASE WHEN t.is_reversal THEN 'reversal' WHEN t.reversed_by_event_id IS NOT NULL THEN 'reversed' ELSE 'posted' END$x$;
      date_expr := 't.created_at::date'; order_expr := 't.created_at DESC, t.id';
    WHEN 'invoice' THEN
      tbl := 'public.erp_invoices';
      txt := $x$(coalesce(t.customer_name, '') || ' ' || coalesce(t.void_reason, ''))$x$;
      ref_extra := 't.sales_order_id BETWEEN $4 AND $5';
      status_expr := 't.status::text'; date_expr := 't.invoice_date'; order_expr := 't.invoice_date DESC, t.id';
    WHEN 'payment' THEN
      tbl := 'public.erp_payments';
      txt := $x$(coalesce(t.party, '') || ' ' || coalesce(t.method, '') || ' ' || coalesce(t.note, '') || ' ' || coalesce(t.void_reason, ''))$x$;
      -- Typing an invoice's or purchase order's reference finds its payments.
      ref_extra := '(t.invoice_id BETWEEN $4 AND $5 OR t.purchase_order_id BETWEEN $4 AND $5)';
      status_expr := $x$CASE WHEN t.voided_at IS NOT NULL THEN 'void' ELSE t.payment_type::text END$x$;
      date_expr := 't.payment_date'; order_expr := 't.payment_date DESC, t.id';
    WHEN 'cashTransaction' THEN
      tbl := 'public.erp_transactions';
      txt := $x$(coalesce(t.category, '') || ' ' || coalesce(t.description, ''))$x$;
      status_expr := 't.transaction_type::text'; date_expr := 't.transaction_date'; order_expr := 't.transaction_date DESC, t.id';
    WHEN 'journalEntry' THEN
      tbl := 'public.erp_journal_entries';
      txt := $x$(coalesce(t.memo, ''))$x$;
      number_expr := 't.entry_no = $6';
      ref_extra := 't.source_id BETWEEN $4 AND $5';
      status_expr := 't.source_type'; date_expr := 't.entry_date'; order_expr := 't.entry_date DESC, t.entry_no DESC, t.id';
    WHEN 'glAccount' THEN
      tbl := 'public.erp_gl_accounts';
      txt := $x$(coalesce(t.code, '') || ' ' || coalesce(t.name, ''))$x$;
      status_expr := 't.account_type'; date_expr := 't.created_at::date'; order_expr := 't.code, t.id';
    WHEN 'stockMovement' THEN
      tbl := 'public.erp_stock_movements';
      txt := $x$(coalesce(t.product_name, '') || ' ' || coalesce(t.note, ''))$x$;
      ref_extra := 't.product_id BETWEEN $4 AND $5';
      status_expr := 't.movement_type::text'; date_expr := 't.movement_date'; order_expr := 't.movement_date DESC, t.id';
    ELSE
      RAISE EXCEPTION 'Unknown object type' USING ERRCODE = '22023';
  END CASE;

  scope := CASE WHEN p_workspace_id IS NULL THEN 't.user_id = auth.uid()' ELSE 't.workspace_id = $1' END;

  IF n > 0 THEN
    FOR i IN 1..n LOOP
      text_cond := text_cond || format(' AND (%s ILIKE $3[%s]', txt, i);
      IF order_table IS NOT NULL THEN
        -- Few matching orders: their ids, then the index on the order column.
        -- Many (a common word): check each receipt's order while walking
        -- receipts newest first, which stops as soon as the page is full.
        EXECUTE format('SELECT count(*)::int FROM (SELECT 1 FROM %s o WHERE %s AND %s ILIKE $2 LIMIT 2001) x',
          order_table, CASE WHEN p_workspace_id IS NULL THEN 'o.user_id = auth.uid()' ELSE 'o.workspace_id = $1' END, order_txt)
        INTO order_matches USING p_workspace_id, p_patterns[i];
        text_cond := text_cond || CASE WHEN order_matches <= 2000
          THEN format(' OR t.%s = ANY (ARRAY(SELECT o.id FROM %s o WHERE %s AND %s ILIKE $3[%s]))',
                      order_fk, order_table, replace(scope, 't.', 'o.'), order_txt, i)
          ELSE format(' OR EXISTS (SELECT 1 FROM %s o WHERE o.id = t.%s AND %s ILIKE $3[%s])',
                      order_table, order_fk, order_txt, i) END;
      END IF;
      text_cond := text_cond || ')';
    END LOOP;
  END IF;
  IF p_id_from IS NOT NULL THEN
    ref_cond := ref_cond || ' OR t.id BETWEEN $4 AND $5 OR ' || ref_extra;
  END IF;
  IF p_number IS NOT NULL AND number_expr IS NOT NULL THEN
    ref_cond := ref_cond || ' OR ' || number_expr;
  END IF;

  where_sql := format('%s AND %s AND ((%s) OR %s) AND ($7::text[] IS NULL OR %s = ANY($7)) AND ($8::date IS NULL OR %s >= $8) AND ($9::date IS NULL OR %s <= $9)',
    scope, extra,
    -- With no words, only a reference or number can match (if given).
    CASE WHEN n = 0 AND (p_id_from IS NOT NULL OR p_number IS NOT NULL) THEN 'FALSE' ELSE text_cond END,
    ref_cond, status_expr, date_expr, date_expr);

  EXECUTE format('SELECT COALESCE(jsonb_agg(id), ''[]''::jsonb) FROM (SELECT t.id FROM %s t WHERE %s ORDER BY %s LIMIT $10 OFFSET $11) x',
    tbl, where_sql, order_expr)
  INTO ids
  USING p_workspace_id, NULL::int, p_patterns, p_id_from, p_id_to, p_number, p_statuses, p_date_from, p_date_to, p_limit, p_offset;

  EXECUTE format('SELECT count(*)::int FROM (SELECT 1 FROM %s t WHERE %s LIMIT 101) x', tbl, where_sql)
  INTO total
  USING p_workspace_id, NULL::int, p_patterns, p_id_from, p_id_to, p_number, p_statuses, p_date_from, p_date_to;

  RETURN jsonb_build_object('ids', ids, 'total', total);
END;
$$;

REVOKE ALL ON FUNCTION public.erp_ontology_search(UUID, TEXT, TEXT[], UUID, UUID, INTEGER, TEXT[], DATE, DATE, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_ontology_search(UUID, TEXT, TEXT[], UUID, UUID, INTEGER, TEXT[], DATE, DATE, INTEGER, INTEGER) TO authenticated;

-- ─── 4. Access log ────────────────────────────────────────────────────────────
-- Who searched which object types, and who opened which record's related
-- records, in which workspace. Never the search text or any field value.
CREATE TABLE IF NOT EXISTS public.erp_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL,
  actor_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('search', 'view')),
  object_types TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(object_types) <= 20),
  object_id UUID,
  result_count INTEGER CHECK (result_count IS NULL OR result_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_erp_access_log_workspace ON public.erp_access_log(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_erp_access_log_actor ON public.erp_access_log(actor_id, created_at DESC);

ALTER TABLE public.erp_access_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_access_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_access_log TO authenticated;

-- People see their own entries; owners and admins (audit permission) see the workspace's.
DROP POLICY IF EXISTS erp_access_log_read ON public.erp_access_log;
CREATE POLICY erp_access_log_read ON public.erp_access_log
  FOR SELECT TO authenticated
  USING (actor_id = auth.uid() OR (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, 'audit')));

CREATE OR REPLACE FUNCTION public.erp_log_access(
  p_workspace_id UUID, p_action TEXT, p_object_types TEXT[], p_object_id UUID, p_result_count INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NOT NULL AND NOT public.erp_has_permission(p_workspace_id, 'read') THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('search', 'view')
     OR COALESCE(cardinality(p_object_types), 0) > 20
     OR EXISTS (SELECT 1 FROM unnest(p_object_types) x WHERE x !~ '^[a-zA-Z]{1,40}$') THEN
    RAISE EXCEPTION 'Invalid access log entry' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.erp_access_log (workspace_id, actor_id, action, object_types, object_id, result_count)
  VALUES (p_workspace_id, auth.uid(), p_action, COALESCE(p_object_types, '{}'), p_object_id, p_result_count);
END;
$$;

REVOKE ALL ON FUNCTION public.erp_log_access(UUID, TEXT, TEXT[], UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_log_access(UUID, TEXT, TEXT[], UUID, INTEGER) TO authenticated;
