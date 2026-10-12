-- ─── ERP inventory reservations, partial fulfillment, status rules ───────────
-- Additive and backward compatible:
--   * Sales orders reserve stock when created or when their draft items change.
--     Availability = on-hand stock − active reservations, checked under a row
--     lock on each product (locked in id order) so concurrent orders cannot
--     reserve the same units.
--   * Purchase receipts and sales deliveries can be recorded per line in
--     several events. Every event carries a client request id; retrying the
--     same request returns the original event and never moves stock twice.
--   * The legacy "mark received" / "mark delivered" paths still work: their
--     triggers now move only the quantities that have not been moved yet, so
--     mixing partial events with the old buttons cannot duplicate stock.
--   * Status transitions are enforced by triggers; cancellations need a reason
--     and corrections are recorded as reversal events, never as deletions.
--   * Direct edits of erp_products.current_stock (the product form) now write a
--     matching stock movement so history and on-hand stock stay consistent.

-- ─── 1. Columns ───────────────────────────────────────────────────────────────

ALTER TABLE public.erp_sales_order_items ADD COLUMN IF NOT EXISTS qty_delivered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.erp_purchase_order_items ADD COLUMN IF NOT EXISTS qty_received INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.erp_sales_orders
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE public.erp_purchase_orders
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE public.erp_stock_movements
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_id UUID;

-- One movement per fulfillment line: the database refuses a duplicate even if
-- application code were retried incorrectly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_stock_movements_source
  ON public.erp_stock_movements(source_type, source_id) WHERE source_id IS NOT NULL;

-- Completed orders have, by definition, moved their full quantities.
UPDATE public.erp_sales_order_items i
SET qty_delivered = GREATEST(i.qty, 0)
FROM public.erp_sales_orders o
WHERE o.id = i.sales_order_id AND o.status = 'delivered' AND i.qty_delivered = 0;

UPDATE public.erp_purchase_order_items i
SET qty_received = GREATEST(i.qty, 0)
FROM public.erp_purchase_orders o
WHERE o.id = i.purchase_order_id AND o.status = 'received' AND i.qty_received = 0;

DO $$ BEGIN
  ALTER TABLE public.erp_sales_order_items
    ADD CONSTRAINT erp_sales_order_items_qty_delivered_check
    CHECK (qty_delivered >= 0 AND qty_delivered <= GREATEST(qty, 0)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.erp_sales_order_items VALIDATE CONSTRAINT erp_sales_order_items_qty_delivered_check;

DO $$ BEGIN
  ALTER TABLE public.erp_purchase_order_items
    ADD CONSTRAINT erp_purchase_order_items_qty_received_check
    CHECK (qty_received >= 0 AND qty_received <= GREATEST(qty, 0)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.erp_purchase_order_items VALIDATE CONSTRAINT erp_purchase_order_items_qty_received_check;

-- ─── 2. Tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.erp_stock_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.erp_products(id) ON DELETE CASCADE,
  sales_order_id UUID NOT NULL REFERENCES public.erp_sales_orders(id) ON DELETE CASCADE,
  -- Deliberately not a foreign key: a table referencing both erp_sales_orders
  -- and erp_sales_order_items could be read by PostgREST as a many-to-many
  -- junction and make the existing `items:erp_sales_order_items(*)` embed
  -- ambiguous for current and older clients. Rows still cascade with their
  -- order; lines are only deleted while a draft is edited, after release.
  sales_order_item_id UUID,
  qty_reserved INTEGER NOT NULL CHECK (qty_reserved > 0),
  qty_open INTEGER NOT NULL CHECK (qty_open >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'released')),
  release_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (qty_open <= qty_reserved)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_stock_reservations_item
  ON public.erp_stock_reservations(sales_order_item_id);
CREATE INDEX IF NOT EXISTS idx_erp_stock_reservations_product_active
  ON public.erp_stock_reservations(product_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_erp_stock_reservations_order
  ON public.erp_stock_reservations(sales_order_id);

CREATE TABLE IF NOT EXISTS public.erp_fulfillment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('purchase_receipt', 'sales_delivery')),
  purchase_order_id UUID REFERENCES public.erp_purchase_orders(id) ON DELETE CASCADE,
  sales_order_id UUID REFERENCES public.erp_sales_orders(id) ON DELETE CASCADE,
  request_id UUID UNIQUE,
  is_reversal BOOLEAN NOT NULL DEFAULT false,
  reverses_event_id UUID REFERENCES public.erp_fulfillment_events(id) ON DELETE SET NULL,
  reversed_by_event_id UUID REFERENCES public.erp_fulfillment_events(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'purchase_receipt' AND purchase_order_id IS NOT NULL AND sales_order_id IS NULL)
    OR (kind = 'sales_delivery' AND sales_order_id IS NOT NULL AND purchase_order_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_erp_fulfillment_events_po ON public.erp_fulfillment_events(purchase_order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_erp_fulfillment_events_so ON public.erp_fulfillment_events(sales_order_id, created_at);

CREATE TABLE IF NOT EXISTS public.erp_fulfillment_event_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.erp_fulfillment_events(id) ON DELETE CASCADE,
  purchase_order_item_id UUID REFERENCES public.erp_purchase_order_items(id) ON DELETE SET NULL,
  sales_order_item_id UUID REFERENCES public.erp_sales_order_items(id) ON DELETE SET NULL,
  product_id UUID REFERENCES public.erp_products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_erp_fulfillment_event_lines_event ON public.erp_fulfillment_event_lines(event_id);

DROP TRIGGER IF EXISTS trg_erp_assign_workspace ON public.erp_stock_reservations;
CREATE TRIGGER trg_erp_assign_workspace BEFORE INSERT OR UPDATE OF user_id, workspace_id
  ON public.erp_stock_reservations FOR EACH ROW EXECUTE FUNCTION public.erp_assign_workspace();
DROP TRIGGER IF EXISTS trg_erp_assign_workspace ON public.erp_fulfillment_events;
CREATE TRIGGER trg_erp_assign_workspace BEFORE INSERT OR UPDATE OF user_id, workspace_id
  ON public.erp_fulfillment_events FOR EACH ROW EXECUTE FUNCTION public.erp_assign_workspace();

ALTER TABLE public.erp_stock_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_fulfillment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_fulfillment_event_lines ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.erp_stock_reservations, public.erp_fulfillment_events,
  public.erp_fulfillment_event_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_stock_reservations, public.erp_fulfillment_events,
  public.erp_fulfillment_event_lines TO authenticated;

DROP POLICY IF EXISTS erp_stock_reservations_read ON public.erp_stock_reservations;
CREATE POLICY erp_stock_reservations_read ON public.erp_stock_reservations
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid())
         OR (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, 'read')));

DROP POLICY IF EXISTS erp_fulfillment_events_read ON public.erp_fulfillment_events;
CREATE POLICY erp_fulfillment_events_read ON public.erp_fulfillment_events
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid())
         OR (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, 'read')));

DROP POLICY IF EXISTS erp_fulfillment_event_lines_read ON public.erp_fulfillment_event_lines;
CREATE POLICY erp_fulfillment_event_lines_read ON public.erp_fulfillment_event_lines
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.erp_fulfillment_events e WHERE e.id = event_id));

-- On-hand, reserved, and available stock per product (RLS of the caller applies).
CREATE OR REPLACE VIEW public.erp_product_availability
WITH (security_invoker = true) AS
SELECT
  p.id AS product_id,
  p.user_id,
  p.workspace_id,
  p.current_stock AS on_hand,
  COALESCE(r.reserved, 0)::INTEGER AS reserved,
  (p.current_stock - COALESCE(r.reserved, 0))::INTEGER AS available
FROM public.erp_products p
LEFT JOIN (
  SELECT product_id, SUM(qty_open) AS reserved
  FROM public.erp_stock_reservations
  WHERE status = 'active'
  GROUP BY product_id
) r ON r.product_id = p.id;

REVOKE ALL ON public.erp_product_availability FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_product_availability TO authenticated;

-- ─── 3. Stock ledger primitives ──────────────────────────────────────────────

-- The only way RPCs change on-hand stock. The flag tells the product ledger
-- trigger that the caller writes its own (linked) stock movement.
CREATE OR REPLACE FUNCTION public.erp__change_stock(p_product_id UUID, p_delta INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE next_stock INTEGER;
BEGIN
  PERFORM set_config('erp.stock_write', 'on', true);
  UPDATE public.erp_products
  SET current_stock = current_stock + p_delta, updated_at = now()
  WHERE id = p_product_id
  RETURNING current_stock INTO next_stock;
  PERFORM set_config('erp.stock_write', 'off', true);
  IF next_stock IS NULL THEN RAISE EXCEPTION 'Order product not found'; END IF;
  RETURN next_stock;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_products_stock_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_stock < 0
     AND (TG_OP = 'INSERT' OR NEW.current_stock IS DISTINCT FROM OLD.current_stock) THEN
    RAISE EXCEPTION 'Stock cannot be negative';
  END IF;
  RETURN NEW;
END;
$$;

-- Manual edits of current_stock (product form, imports) get a movement row so
-- the history always explains the on-hand quantity.
CREATE OR REPLACE FUNCTION public.erp_products_stock_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE delta INTEGER;
BEGIN
  IF current_setting('erp.stock_write', true) = 'on' OR current_setting('erp.maintenance', true) = 'on' THEN
    RETURN NULL;
  END IF;
  delta := NEW.current_stock - CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE OLD.current_stock END;
  IF delta = 0 THEN RETURN NULL; END IF;

  INSERT INTO public.erp_stock_movements
    (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, created_by)
  VALUES
    (NEW.user_id, NEW.id, NEW.name,
     CASE WHEN delta > 0 THEN 'in'::public.stock_movement_type ELSE 'out'::public.stock_movement_type END,
     abs(delta), CURRENT_DATE,
     CASE WHEN TG_OP = 'INSERT' THEN 'Opening stock (product created)' ELSE 'Manual stock edit on product record' END,
     'product_edit', auth.uid());
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.erp__change_stock(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_products_stock_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_products_stock_ledger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_erp_products_stock_guard ON public.erp_products;
CREATE TRIGGER trg_erp_products_stock_guard
  BEFORE INSERT OR UPDATE OF current_stock ON public.erp_products
  FOR EACH ROW EXECUTE FUNCTION public.erp_products_stock_guard();

DROP TRIGGER IF EXISTS trg_erp_products_stock_ledger ON public.erp_products;
CREATE TRIGGER trg_erp_products_stock_ledger
  AFTER INSERT OR UPDATE OF current_stock ON public.erp_products
  FOR EACH ROW EXECUTE FUNCTION public.erp_products_stock_ledger();

CREATE OR REPLACE FUNCTION public.erp_adjust_stock(
  p_product_id UUID,
  p_movement_type public.stock_movement_type,
  p_quantity INTEGER,
  p_note TEXT DEFAULT ''
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE product_row public.erp_products%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero'; END IF;
  SELECT * INTO product_row FROM public.erp_products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  PERFORM public.erp__authorize(product_row.user_id, product_row.workspace_id, 'inventory', 'Product');

  IF p_movement_type = 'out' AND product_row.current_stock < p_quantity THEN
    RAISE EXCEPTION 'Insufficient stock';
  END IF;

  PERFORM public.erp__change_stock(product_row.id, CASE WHEN p_movement_type = 'in' THEN p_quantity ELSE -p_quantity END);
  INSERT INTO public.erp_stock_movements
    (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, created_by)
  VALUES
    (product_row.user_id, product_row.id, product_row.name, p_movement_type, p_quantity, CURRENT_DATE,
     left(COALESCE(p_note, ''), 500), 'manual_adjustment', auth.uid());
END;
$$;

-- ─── 4. Reservations ─────────────────────────────────────────────────────────

-- (Re)reserves the open quantity of every product line of a sales order.
-- Products are locked in id order (deadlock-free); the availability sum runs
-- after the lock, so it includes reservations committed by concurrent orders.
CREATE OR REPLACE FUNCTION public.erp__reserve_sales_order(p_sales_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  order_row public.erp_sales_orders%ROWTYPE;
  need RECORD;
  reserved_elsewhere INTEGER;
  available INTEGER;
BEGIN
  SELECT * INTO order_row FROM public.erp_sales_orders WHERE id = p_sales_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales order not found'; END IF;

  FOR need IN
    SELECT prod.id AS product_id, prod.name, prod.current_stock, wanted.qty
    FROM (
      SELECT i.product_id, SUM(GREATEST(i.qty - i.qty_delivered, 0))::INTEGER AS qty
      FROM public.erp_sales_order_items i
      WHERE i.sales_order_id = p_sales_order_id AND i.product_id IS NOT NULL
      GROUP BY i.product_id
    ) wanted
    JOIN public.erp_products prod ON prod.id = wanted.product_id
    ORDER BY prod.id
    FOR UPDATE OF prod
  LOOP
    SELECT COALESCE(SUM(r.qty_open), 0) INTO reserved_elsewhere
    FROM public.erp_stock_reservations r
    WHERE r.product_id = need.product_id AND r.status = 'active' AND r.sales_order_id <> p_sales_order_id;
    available := need.current_stock - reserved_elsewhere;
    IF need.qty > available THEN
      RAISE EXCEPTION 'Insufficient available stock for % (available %, requested %)',
        need.name, GREATEST(available, 0), need.qty;
    END IF;
  END LOOP;

  INSERT INTO public.erp_stock_reservations
    (workspace_id, user_id, product_id, sales_order_id, sales_order_item_id, qty_reserved, qty_open)
  SELECT order_row.workspace_id, order_row.user_id, i.product_id, i.sales_order_id, i.id,
         i.qty - i.qty_delivered, i.qty - i.qty_delivered
  FROM public.erp_sales_order_items i
  WHERE i.sales_order_id = p_sales_order_id AND i.product_id IS NOT NULL AND i.qty - i.qty_delivered > 0
  ON CONFLICT (sales_order_item_id) DO UPDATE
  SET qty_reserved = EXCLUDED.qty_reserved, qty_open = EXCLUDED.qty_open,
      status = 'active', release_reason = '', updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.erp__release_reservations(p_sales_order_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.erp_stock_reservations
  SET status = 'released', qty_open = 0, release_reason = left(COALESCE(p_reason, ''), 500), updated_at = now()
  WHERE sales_order_id = p_sales_order_id AND status = 'active';
$$;

REVOKE ALL ON FUNCTION public.erp__reserve_sales_order(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__release_reservations(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ─── 5. Order line parsing ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp__insert_order_items(
  p_kind TEXT, p_order_id UUID, p_workspace_id UUID, p_items JSONB
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  item JSONB;
  item_product_id UUID;
  canonical_product_name TEXT;
  item_qty INTEGER;
  item_price NUMERIC(15,2);
  order_total NUMERIC(15,2) := 0;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Order items must be an array'; END IF;
  IF jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'An order must contain between 1 and 200 items';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    BEGIN
      item_qty := (item->>'qty')::INTEGER;
      item_price := (item->>'price')::NUMERIC(15,2);
      item_product_id := NULLIF(item->>'product_id', '')::UUID;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid % order item', CASE WHEN p_kind = 'sales' THEN 'sales' ELSE 'purchase' END;
    END;
    IF item_qty IS NULL OR item_qty <= 0 OR item_price IS NULL OR item_price < 0 THEN
      RAISE EXCEPTION 'Item quantity must be positive and price cannot be negative';
    END IF;
    IF item_product_id IS NOT NULL THEN
      SELECT name INTO canonical_product_name FROM public.erp_products
      WHERE id = item_product_id AND workspace_id = p_workspace_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Product not found for this account'; END IF;
    ELSE
      canonical_product_name := left(trim(COALESCE(item->>'product_name', '')), 200);
      IF canonical_product_name = '' THEN RAISE EXCEPTION 'Product name is required'; END IF;
    END IF;
    order_total := order_total + item_qty * item_price;
    IF p_kind = 'sales' THEN
      INSERT INTO public.erp_sales_order_items (sales_order_id, product_id, product_name, qty, price)
      VALUES (p_order_id, item_product_id, canonical_product_name, item_qty, item_price);
    ELSE
      INSERT INTO public.erp_purchase_order_items (purchase_order_id, product_id, product_name, qty, price)
      VALUES (p_order_id, item_product_id, canonical_product_name, item_qty, item_price);
    END IF;
  END LOOP;
  RETURN order_total;
END;
$$;

REVOKE ALL ON FUNCTION public.erp__insert_order_items(TEXT, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;

-- ─── 6. Order creation / editing ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_create_sales_order_v2(
  p_workspace_id UUID,
  p_customer_id UUID,
  p_customer_name TEXT,
  p_order_date DATE,
  p_notes TEXT,
  p_items JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  workspace UUID;
  owner UUID;
  new_order_id UUID;
  canonical_customer_name TEXT;
  order_total NUMERIC(15,2);
BEGIN
  workspace := public.erp__resolve_workspace(p_workspace_id, 'sales');
  SELECT owner_id INTO owner FROM public.erp_workspaces WHERE id = workspace;

  IF p_customer_id IS NOT NULL THEN
    SELECT name INTO canonical_customer_name FROM public.erp_customers
    WHERE id = p_customer_id AND workspace_id = workspace;
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this account'; END IF;
  ELSE
    canonical_customer_name := left(trim(COALESCE(p_customer_name, '')), 200);
    IF canonical_customer_name = '' THEN RAISE EXCEPTION 'Customer name is required'; END IF;
  END IF;

  INSERT INTO public.erp_sales_orders
    (user_id, workspace_id, created_by, customer_id, customer_name, order_date, status, total, notes)
  VALUES
    (owner, workspace, auth.uid(), p_customer_id, canonical_customer_name,
     COALESCE(p_order_date, CURRENT_DATE), 'draft', 0, left(COALESCE(p_notes, ''), 2000))
  RETURNING id INTO new_order_id;

  order_total := public.erp__insert_order_items('sales', new_order_id, workspace, p_items);
  UPDATE public.erp_sales_orders SET total = order_total WHERE id = new_order_id;
  PERFORM public.erp__reserve_sales_order(new_order_id);
  RETURN new_order_id;
END;
$$;

-- Legacy signature (older clients): now also reserves stock.
CREATE OR REPLACE FUNCTION public.erp_create_sales_order(
  p_customer_id UUID,
  p_customer_name TEXT,
  p_order_date DATE,
  p_notes TEXT,
  p_items JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.erp_create_sales_order_v2(NULL, p_customer_id, p_customer_name, p_order_date, p_notes, p_items);
END;
$$;

-- Replaces the items of a draft order and re-reserves stock atomically. If
-- the new quantities are not available, nothing changes.
CREATE OR REPLACE FUNCTION public.erp_update_sales_order_items(
  p_sales_order_id UUID,
  p_items JSONB,
  p_notes TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  order_row public.erp_sales_orders%ROWTYPE;
  order_total NUMERIC(15,2);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO order_row FROM public.erp_sales_orders WHERE id = p_sales_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales order not found'; END IF;
  PERFORM public.erp__authorize(order_row.user_id, order_row.workspace_id, 'sales', 'Sales order');
  IF order_row.status <> 'draft' THEN RAISE EXCEPTION 'Only draft sales orders can be edited'; END IF;

  PERFORM public.erp__release_reservations(order_row.id, 'Order items changed');
  DELETE FROM public.erp_sales_order_items WHERE sales_order_id = order_row.id;
  order_total := public.erp__insert_order_items('sales', order_row.id, order_row.workspace_id, p_items);
  UPDATE public.erp_sales_orders
  SET total = order_total, notes = COALESCE(left(p_notes, 2000), notes), updated_at = now()
  WHERE id = order_row.id;
  PERFORM public.erp__reserve_sales_order(order_row.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_create_purchase_order_v2(
  p_workspace_id UUID,
  p_supplier_id UUID,
  p_supplier_name TEXT,
  p_order_date DATE,
  p_notes TEXT,
  p_items JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  workspace UUID;
  owner UUID;
  new_order_id UUID;
  canonical_supplier_name TEXT;
  order_total NUMERIC(15,2);
  config public.erp_approval_settings%ROWTYPE;
BEGIN
  workspace := public.erp__resolve_workspace(p_workspace_id, 'purchasing');
  SELECT owner_id INTO owner FROM public.erp_workspaces WHERE id = workspace;

  IF p_supplier_id IS NOT NULL THEN
    SELECT name INTO canonical_supplier_name FROM public.erp_suppliers
    WHERE id = p_supplier_id AND workspace_id = workspace;
    IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found for this account'; END IF;
  ELSE
    canonical_supplier_name := left(trim(COALESCE(p_supplier_name, '')), 200);
    IF canonical_supplier_name = '' THEN RAISE EXCEPTION 'Supplier name is required'; END IF;
  END IF;

  INSERT INTO public.erp_purchase_orders
    (user_id, workspace_id, created_by, supplier_id, supplier_name, order_date, status, total, notes)
  VALUES
    (owner, workspace, auth.uid(), p_supplier_id, canonical_supplier_name,
     COALESCE(p_order_date, CURRENT_DATE), 'pending', 0, left(COALESCE(p_notes, ''), 2000))
  RETURNING id INTO new_order_id;

  order_total := public.erp__insert_order_items('purchase', new_order_id, workspace, p_items);
  UPDATE public.erp_purchase_orders SET total = order_total WHERE id = new_order_id;

  -- The insert trigger saw a zero total; create the threshold approval now.
  SELECT * INTO config FROM public.erp_approval_settings WHERE owner_id = owner;
  IF FOUND AND config.po_approval_threshold > 0
     AND order_total >= config.po_approval_threshold
     AND cardinality(config.approver_emails) > 0 THEN
    INSERT INTO public.erp_approval_requests
      (owner_id, requested_by, purchase_order_id, supplier_name, admin_email, amount, approver_emails)
    VALUES
      (owner, auth.uid(), new_order_id, canonical_supplier_name,
       config.admin_email, order_total, config.approver_emails)
    ON CONFLICT (purchase_order_id) DO NOTHING;
  END IF;
  RETURN new_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_create_purchase_order(
  p_supplier_id UUID,
  p_supplier_name TEXT,
  p_order_date DATE,
  p_notes TEXT,
  p_items JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.erp_create_purchase_order_v2(NULL, p_supplier_id, p_supplier_name, p_order_date, p_notes, p_items);
END;
$$;

-- ─── 7. Fulfillment (partial receiving / delivery) ───────────────────────────

-- Validates requested lines against the remaining quantities (under a lock on
-- the order items) and returns them as [{item_id, qty}].
CREATE OR REPLACE FUNCTION public.erp__validate_fulfillment_lines(p_kind TEXT, p_order_id UUID, p_lines JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  line JSONB;
  line_item UUID;
  line_qty INTEGER;
  remaining INTEGER;
  item_name TEXT;
  seen UUID[] := ARRAY[]::UUID[];
  result JSONB := '[]'::JSONB;
BEGIN
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) < 1 OR jsonb_array_length(p_lines) > 200 THEN
    RAISE EXCEPTION 'Provide between 1 and 200 lines';
  END IF;

  FOR line IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    BEGIN
      line_item := (line->>'item_id')::UUID;
      line_qty := (line->>'qty')::INTEGER;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid line';
    END;
    IF line_item IS NULL OR line_qty IS NULL OR line_qty <= 0 THEN
      RAISE EXCEPTION 'Each line needs an item and a positive quantity';
    END IF;
    IF line_item = ANY(seen) THEN RAISE EXCEPTION 'Each order line may appear only once'; END IF;
    seen := seen || line_item;

    IF p_kind = 'sales_delivery' THEN
      SELECT i.qty - i.qty_delivered, i.product_name INTO remaining, item_name
      FROM public.erp_sales_order_items i
      WHERE i.id = line_item AND i.sales_order_id = p_order_id
      FOR UPDATE;
    ELSE
      SELECT i.qty - i.qty_received, i.product_name INTO remaining, item_name
      FROM public.erp_purchase_order_items i
      WHERE i.id = line_item AND i.purchase_order_id = p_order_id
      FOR UPDATE;
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'Line does not belong to this order'; END IF;
    IF line_qty > remaining THEN
      RAISE EXCEPTION 'Quantity for % exceeds the remaining % units', item_name, GREATEST(remaining, 0);
    END IF;
    result := result || jsonb_build_array(jsonb_build_object('item_id', line_item, 'qty', line_qty));
  END LOOP;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp__apply_sales_delivery(
  p_order public.erp_sales_orders, p_lines JSONB, p_request_id UUID, p_note TEXT, p_movement_note TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_event_id UUID;
  new_line_id UUID;
  line RECORD;
  stock_now INTEGER;
BEGIN
  INSERT INTO public.erp_fulfillment_events
    (workspace_id, user_id, kind, sales_order_id, request_id, note, created_by)
  VALUES
    (p_order.workspace_id, p_order.user_id, 'sales_delivery', p_order.id, p_request_id,
     left(COALESCE(p_note, ''), 500), auth.uid())
  RETURNING id INTO new_event_id;

  FOR line IN
    SELECT i.id AS item_id, i.product_id, i.product_name, l.qty
    FROM jsonb_to_recordset(p_lines) AS l(item_id UUID, qty INTEGER)
    JOIN public.erp_sales_order_items i ON i.id = l.item_id AND i.sales_order_id = p_order.id
    ORDER BY i.product_id NULLS LAST, i.id
  LOOP
    IF line.product_id IS NOT NULL THEN
      -- Preserved from the original delivery rule: never ship more than is on hand.
      SELECT current_stock INTO stock_now FROM public.erp_products WHERE id = line.product_id FOR UPDATE;
      IF stock_now IS NULL THEN RAISE EXCEPTION 'Order product not found'; END IF;
      IF stock_now < line.qty THEN
        RAISE EXCEPTION 'Insufficient stock for % (available %, required %)', line.product_name, stock_now, line.qty;
      END IF;
      PERFORM public.erp__change_stock(line.product_id, -line.qty);
    END IF;

    INSERT INTO public.erp_fulfillment_event_lines (event_id, sales_order_item_id, product_id, product_name, quantity)
    VALUES (new_event_id, line.item_id, line.product_id, line.product_name, line.qty)
    RETURNING id INTO new_line_id;

    IF line.product_id IS NOT NULL THEN
      INSERT INTO public.erp_stock_movements
        (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, source_id, created_by)
      VALUES
        (p_order.user_id, line.product_id, line.product_name, 'out', line.qty, CURRENT_DATE,
         p_movement_note, 'fulfillment_line', new_line_id, auth.uid());
    END IF;

    UPDATE public.erp_sales_order_items SET qty_delivered = qty_delivered + line.qty WHERE id = line.item_id;
    UPDATE public.erp_stock_reservations
    SET qty_open = GREATEST(qty_open - line.qty, 0),
        status = CASE WHEN qty_open - line.qty <= 0 THEN 'consumed' ELSE 'active' END,
        updated_at = now()
    WHERE sales_order_item_id = line.item_id AND status = 'active';
  END LOOP;
  RETURN new_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp__apply_purchase_receipt(
  p_order public.erp_purchase_orders, p_lines JSONB, p_request_id UUID, p_note TEXT, p_movement_note TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_event_id UUID;
  new_line_id UUID;
  line RECORD;
BEGIN
  INSERT INTO public.erp_fulfillment_events
    (workspace_id, user_id, kind, purchase_order_id, request_id, note, created_by)
  VALUES
    (p_order.workspace_id, p_order.user_id, 'purchase_receipt', p_order.id, p_request_id,
     left(COALESCE(p_note, ''), 500), auth.uid())
  RETURNING id INTO new_event_id;

  FOR line IN
    SELECT i.id AS item_id, i.product_id, i.product_name, l.qty
    FROM jsonb_to_recordset(p_lines) AS l(item_id UUID, qty INTEGER)
    JOIN public.erp_purchase_order_items i ON i.id = l.item_id AND i.purchase_order_id = p_order.id
    ORDER BY i.product_id NULLS LAST, i.id
  LOOP
    IF line.product_id IS NOT NULL THEN
      PERFORM 1 FROM public.erp_products WHERE id = line.product_id FOR UPDATE;
      PERFORM public.erp__change_stock(line.product_id, line.qty);
    END IF;

    INSERT INTO public.erp_fulfillment_event_lines (event_id, purchase_order_item_id, product_id, product_name, quantity)
    VALUES (new_event_id, line.item_id, line.product_id, line.product_name, line.qty)
    RETURNING id INTO new_line_id;

    IF line.product_id IS NOT NULL THEN
      INSERT INTO public.erp_stock_movements
        (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, source_id, created_by)
      VALUES
        (p_order.user_id, line.product_id, line.product_name, 'in', line.qty, CURRENT_DATE,
         p_movement_note, 'fulfillment_line', new_line_id, auth.uid());
    END IF;

    UPDATE public.erp_purchase_order_items SET qty_received = qty_received + line.qty WHERE id = line.item_id;
  END LOOP;
  RETURN new_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.erp__validate_fulfillment_lines(TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__apply_sales_delivery(public.erp_sales_orders, JSONB, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__apply_purchase_receipt(public.erp_purchase_orders, JSONB, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.erp_record_sales_delivery(
  p_sales_order_id UUID, p_lines JSONB, p_request_id UUID, p_note TEXT DEFAULT ''
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  order_row public.erp_sales_orders%ROWTYPE;
  existing RECORD;
  valid_lines JSONB;
  new_event_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'A request id is required'; END IF;
  SELECT * INTO order_row FROM public.erp_sales_orders WHERE id = p_sales_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales order not found'; END IF;
  PERFORM public.erp__authorize(order_row.user_id, order_row.workspace_id, 'fulfillment', 'Sales order');

  -- Checked under the order lock: a concurrent retry waits, then finds this.
  SELECT id, sales_order_id, is_reversal INTO existing FROM public.erp_fulfillment_events WHERE request_id = p_request_id;
  IF FOUND THEN
    IF existing.sales_order_id IS DISTINCT FROM order_row.id OR existing.is_reversal THEN
      RAISE EXCEPTION 'This request id was already used for a different operation';
    END IF;
    RETURN existing.id;
  END IF;

  IF order_row.status <> 'invoiced' THEN RAISE EXCEPTION 'Only invoiced sales orders can be delivered'; END IF;
  valid_lines := public.erp__validate_fulfillment_lines('sales_delivery', order_row.id, p_lines);
  new_event_id := public.erp__apply_sales_delivery(order_row, valid_lines, p_request_id, p_note,
    'Delivery for SO#' || order_row.id::TEXT);

  IF NOT EXISTS (SELECT 1 FROM public.erp_sales_order_items WHERE sales_order_id = order_row.id AND qty_delivered < qty) THEN
    UPDATE public.erp_sales_orders SET status = 'delivered', updated_at = now() WHERE id = order_row.id;
  END IF;
  RETURN new_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_record_purchase_receipt(
  p_purchase_order_id UUID, p_lines JSONB, p_request_id UUID, p_note TEXT DEFAULT ''
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  order_row public.erp_purchase_orders%ROWTYPE;
  existing RECORD;
  valid_lines JSONB;
  new_event_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'A request id is required'; END IF;
  SELECT * INTO order_row FROM public.erp_purchase_orders WHERE id = p_purchase_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  PERFORM public.erp__authorize(order_row.user_id, order_row.workspace_id, 'receiving', 'Purchase order');

  SELECT id, purchase_order_id, is_reversal INTO existing FROM public.erp_fulfillment_events WHERE request_id = p_request_id;
  IF FOUND THEN
    IF existing.purchase_order_id IS DISTINCT FROM order_row.id OR existing.is_reversal THEN
      RAISE EXCEPTION 'This request id was already used for a different operation';
    END IF;
    RETURN existing.id;
  END IF;

  IF order_row.status <> 'approved' THEN RAISE EXCEPTION 'Only approved purchase orders can be received'; END IF;
  valid_lines := public.erp__validate_fulfillment_lines('purchase_receipt', order_row.id, p_lines);
  new_event_id := public.erp__apply_purchase_receipt(order_row, valid_lines, p_request_id, p_note,
    'Receipt for PO#' || order_row.id::TEXT);

  IF NOT EXISTS (SELECT 1 FROM public.erp_purchase_order_items WHERE purchase_order_id = order_row.id AND qty_received < qty) THEN
    UPDATE public.erp_purchase_orders SET status = 'received', updated_at = now() WHERE id = order_row.id;
  END IF;
  RETURN new_event_id;
END;
$$;

-- Legacy full-status triggers: move only what has not been moved yet.
CREATE OR REPLACE FUNCTION public.erp_so_inventory_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE remaining JSONB;
BEGIN
  IF NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM 'delivered' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('item_id', i.id, 'qty', i.qty - i.qty_delivered)), '[]'::JSONB)
    INTO remaining
    FROM public.erp_sales_order_items i
    WHERE i.sales_order_id = NEW.id AND i.qty - i.qty_delivered > 0;

    IF jsonb_array_length(remaining) > 0 THEN
      PERFORM public.erp__apply_sales_delivery(NEW, remaining, NULL,
        'Remaining quantities delivered with the order status change',
        'Auto: Sales Order delivered - SO#' || NEW.id::TEXT);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_po_inventory_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE remaining JSONB;
BEGIN
  IF NEW.status = 'received' AND OLD.status IS DISTINCT FROM 'received' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('item_id', i.id, 'qty', i.qty - i.qty_received)), '[]'::JSONB)
    INTO remaining
    FROM public.erp_purchase_order_items i
    WHERE i.purchase_order_id = NEW.id AND i.qty - i.qty_received > 0;

    IF jsonb_array_length(remaining) > 0 THEN
      PERFORM public.erp__apply_purchase_receipt(NEW, remaining, NULL,
        'Remaining quantities received with the order status change',
        'Auto: Purchase Order received - PO#' || NEW.id::TEXT);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_update_purchase_order_status(
  p_purchase_order_id UUID,
  p_status TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE order_row public.erp_purchase_orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_status NOT IN ('approved', 'received') THEN RAISE EXCEPTION 'Invalid purchase order transition'; END IF;
  SELECT * INTO order_row FROM public.erp_purchase_orders WHERE id = p_purchase_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  PERFORM public.erp__authorize(order_row.user_id, order_row.workspace_id,
    CASE WHEN p_status = 'approved' THEN 'purchasing' ELSE 'receiving' END, 'Purchase order');
  IF (p_status = 'approved' AND order_row.status <> 'pending')
     OR (p_status = 'received' AND order_row.status <> 'approved') THEN
    RAISE EXCEPTION 'Invalid purchase order transition';
  END IF;
  UPDATE public.erp_purchase_orders SET status = p_status::public.po_status
  WHERE id = order_row.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_deliver_sales_order(p_sales_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE order_row public.erp_sales_orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO order_row FROM public.erp_sales_orders WHERE id = p_sales_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only invoiced sales orders can be delivered'; END IF;
  PERFORM public.erp__authorize(order_row.user_id, order_row.workspace_id, 'fulfillment', 'Sales order');
  IF order_row.status <> 'invoiced' THEN
    RAISE EXCEPTION 'Only invoiced sales orders can be delivered';
  END IF;
  UPDATE public.erp_sales_orders SET status = 'delivered' WHERE id = order_row.id;
END;
$$;

-- ─── 8. Status transition rules ──────────────────────────────────────────────
-- Purchase orders: pending → approved → received; pending/approved → cancelled.
-- Sales orders:    draft → invoiced → delivered;   draft/invoiced → cancelled.
-- Stepping back (received → approved, delivered → invoiced) happens only
-- inside erp_reverse_fulfillment_event, which records a reversal event.
-- Keep in sync with src/app/erp/lib/erpRules.ts.

CREATE OR REPLACE FUNCTION public.erp_guard_po_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('received', 'cancelled'))
    OR (OLD.status = 'received' AND NEW.status = 'approved' AND current_setting('erp.correction', true) = 'on')
  ) THEN
    RAISE EXCEPTION 'Purchase order cannot move from % to %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'cancelled' AND char_length(trim(COALESCE(NEW.cancel_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'A reason is required to cancel a purchase order';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_guard_so_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('invoiced', 'cancelled'))
    OR (OLD.status = 'invoiced' AND NEW.status IN ('delivered', 'cancelled'))
    OR (OLD.status = 'delivered' AND NEW.status = 'invoiced' AND current_setting('erp.correction', true) = 'on')
  ) THEN
    RAISE EXCEPTION 'Sales order cannot move from % to %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'cancelled' AND char_length(trim(COALESCE(NEW.cancel_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'A reason is required to cancel a sales order';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_guard_po_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_guard_so_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_po_status ON public.erp_purchase_orders;
CREATE TRIGGER trg_guard_po_status
  BEFORE UPDATE OF status ON public.erp_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.erp_guard_po_status();

DROP TRIGGER IF EXISTS trg_guard_so_status ON public.erp_sales_orders;
CREATE TRIGGER trg_guard_so_status
  BEFORE UPDATE OF status ON public.erp_sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.erp_guard_so_status();

-- ─── 9. Cancellation ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_cancel_sales_order(p_sales_order_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  order_row public.erp_sales_orders%ROWTYPE;
  invoice public.erp_invoices%ROWTYPE;
  reason TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO order_row FROM public.erp_sales_orders WHERE id = p_sales_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales order not found'; END IF;
  PERFORM public.erp__authorize(order_row.user_id, order_row.workspace_id, 'sales', 'Sales order');
  IF order_row.status = 'cancelled' THEN RETURN; END IF;
  reason := public.erp__require_reason(p_reason, 'cancel a sales order');

  IF order_row.status = 'delivered'
     OR EXISTS (SELECT 1 FROM public.erp_sales_order_items WHERE sales_order_id = order_row.id AND qty_delivered > 0) THEN
    RAISE EXCEPTION 'Orders with deliveries cannot be cancelled; reverse the deliveries first';
  END IF;

  IF order_row.status = 'invoiced' THEN
    PERFORM public.erp__authorize(order_row.user_id, order_row.workspace_id, 'invoicing', 'Sales order');
    SELECT * INTO invoice FROM public.erp_invoices WHERE sales_order_id = order_row.id FOR UPDATE;
    IF FOUND THEN
      IF EXISTS (SELECT 1 FROM public.erp_payments WHERE invoice_id = invoice.id AND voided_at IS NULL) THEN
        RAISE EXCEPTION 'Void the payments recorded on this order''s invoice first';
      END IF;
      IF invoice.status <> 'void' THEN
        UPDATE public.erp_invoices
        SET status = 'void', payment_state = 'void', voided_at = now(), voided_by = auth.uid(),
            void_reason = 'Sales order cancelled: ' || reason
        WHERE id = invoice.id;
      END IF;
    END IF;
  END IF;

  PERFORM public.erp__release_reservations(order_row.id, 'Order cancelled: ' || reason);
  UPDATE public.erp_sales_orders
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = reason, updated_at = now()
  WHERE id = order_row.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_cancel_purchase_order(p_purchase_order_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  order_row public.erp_purchase_orders%ROWTYPE;
  reason TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO order_row FROM public.erp_purchase_orders WHERE id = p_purchase_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  PERFORM public.erp__authorize(order_row.user_id, order_row.workspace_id, 'purchasing', 'Purchase order');
  IF order_row.status = 'cancelled' THEN RETURN; END IF;
  reason := public.erp__require_reason(p_reason, 'cancel a purchase order');

  IF order_row.status = 'received'
     OR EXISTS (SELECT 1 FROM public.erp_purchase_order_items WHERE purchase_order_id = order_row.id AND qty_received > 0) THEN
    RAISE EXCEPTION 'Orders with received goods cannot be cancelled; reverse the receipts first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.erp_payments WHERE purchase_order_id = order_row.id AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'Void the payments recorded on this purchase order first';
  END IF;

  UPDATE public.erp_approval_requests
  SET status = 'rejected', decision_note = left('Purchase order cancelled: ' || reason, 1000),
      decided_by_email = lower(COALESCE(auth.jwt() ->> 'email', '')), decided_at = now()
  WHERE purchase_order_id = order_row.id AND status = 'pending';

  UPDATE public.erp_purchase_orders
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = reason, updated_at = now()
  WHERE id = order_row.id;
END;
$$;

-- ─── 10. Corrections: reversing a receipt or delivery ────────────────────────
-- Writes a reversal event with opposite stock movements, restores the order
-- line quantities (and reservations for sales), and steps the order status
-- back if it had been completed. Idempotent per request id.

CREATE OR REPLACE FUNCTION public.erp_reverse_fulfillment_event(p_event_id UUID, p_reason TEXT, p_request_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  original public.erp_fulfillment_events%ROWTYPE;
  po_row public.erp_purchase_orders%ROWTYPE;
  so_row public.erp_sales_orders%ROWTYPE;
  existing RECORD;
  reason TEXT;
  line RECORD;
  stock_now INTEGER;
  reversal_id UUID;
  reversal_line_id UUID;
  owner UUID;
  workspace UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'A request id is required'; END IF;

  SELECT * INTO original FROM public.erp_fulfillment_events WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fulfillment event not found'; END IF;

  -- Lock the order first (same order as the forward path), then the event.
  IF original.kind = 'purchase_receipt' THEN
    SELECT * INTO po_row FROM public.erp_purchase_orders WHERE id = original.purchase_order_id FOR UPDATE;
    PERFORM public.erp__authorize(po_row.user_id, po_row.workspace_id, 'receiving', 'Purchase order');
    owner := po_row.user_id; workspace := po_row.workspace_id;
  ELSE
    SELECT * INTO so_row FROM public.erp_sales_orders WHERE id = original.sales_order_id FOR UPDATE;
    PERFORM public.erp__authorize(so_row.user_id, so_row.workspace_id, 'fulfillment', 'Sales order');
    owner := so_row.user_id; workspace := so_row.workspace_id;
  END IF;
  SELECT * INTO original FROM public.erp_fulfillment_events WHERE id = p_event_id FOR UPDATE;

  SELECT id, reverses_event_id INTO existing FROM public.erp_fulfillment_events WHERE request_id = p_request_id;
  IF FOUND THEN
    IF existing.reverses_event_id IS DISTINCT FROM original.id THEN
      RAISE EXCEPTION 'This request id was already used for a different operation';
    END IF;
    RETURN existing.id;
  END IF;

  IF original.is_reversal THEN RAISE EXCEPTION 'A reversal cannot be reversed; record a new receipt or delivery instead'; END IF;
  IF original.reversed_by_event_id IS NOT NULL THEN RAISE EXCEPTION 'This event has already been reversed'; END IF;
  reason := public.erp__require_reason(p_reason, 'reverse a receipt or delivery');

  IF original.kind = 'purchase_receipt' AND po_row.status NOT IN ('approved', 'received') THEN
    RAISE EXCEPTION 'This purchase order can no longer be corrected';
  END IF;
  IF original.kind = 'sales_delivery' AND so_row.status NOT IN ('invoiced', 'delivered') THEN
    RAISE EXCEPTION 'This sales order can no longer be corrected';
  END IF;

  INSERT INTO public.erp_fulfillment_events
    (workspace_id, user_id, kind, purchase_order_id, sales_order_id, request_id, is_reversal,
     reverses_event_id, reason, note, created_by)
  VALUES
    (workspace, owner, original.kind, original.purchase_order_id, original.sales_order_id, p_request_id, true,
     original.id, reason, 'Reversal of event ' || original.id::TEXT, auth.uid())
  RETURNING id INTO reversal_id;

  FOR line IN
    SELECT * FROM public.erp_fulfillment_event_lines
    WHERE event_id = original.id
    ORDER BY product_id NULLS LAST, id
  LOOP
    IF line.product_id IS NOT NULL THEN
      SELECT current_stock INTO stock_now FROM public.erp_products WHERE id = line.product_id FOR UPDATE;
      IF stock_now IS NULL THEN RAISE EXCEPTION 'Order product not found'; END IF;
      IF original.kind = 'purchase_receipt' AND stock_now < line.quantity THEN
        RAISE EXCEPTION 'Cannot reverse the receipt of %: only % units are on hand', line.product_name, stock_now;
      END IF;
      PERFORM public.erp__change_stock(line.product_id,
        CASE WHEN original.kind = 'purchase_receipt' THEN -line.quantity ELSE line.quantity END);
    END IF;

    INSERT INTO public.erp_fulfillment_event_lines
      (event_id, purchase_order_item_id, sales_order_item_id, product_id, product_name, quantity)
    VALUES
      (reversal_id, line.purchase_order_item_id, line.sales_order_item_id, line.product_id, line.product_name, line.quantity)
    RETURNING id INTO reversal_line_id;

    IF line.product_id IS NOT NULL THEN
      INSERT INTO public.erp_stock_movements
        (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, source_id, created_by)
      VALUES
        (owner, line.product_id, line.product_name,
         CASE WHEN original.kind = 'purchase_receipt' THEN 'out'::public.stock_movement_type ELSE 'in'::public.stock_movement_type END,
         line.quantity, CURRENT_DATE,
         CASE WHEN original.kind = 'purchase_receipt' THEN 'Reversal of receipt' ELSE 'Reversal of delivery' END || ': ' || reason,
         'fulfillment_line', reversal_line_id, auth.uid());
    END IF;

    IF original.kind = 'purchase_receipt' AND line.purchase_order_item_id IS NOT NULL THEN
      UPDATE public.erp_purchase_order_items SET qty_received = qty_received - line.quantity
      WHERE id = line.purchase_order_item_id;
    ELSIF original.kind = 'sales_delivery' AND line.sales_order_item_id IS NOT NULL THEN
      UPDATE public.erp_sales_order_items SET qty_delivered = qty_delivered - line.quantity
      WHERE id = line.sales_order_item_id;
      IF line.product_id IS NOT NULL THEN
        INSERT INTO public.erp_stock_reservations
          (workspace_id, user_id, product_id, sales_order_id, sales_order_item_id, qty_reserved, qty_open)
        VALUES (workspace, owner, line.product_id, original.sales_order_id, line.sales_order_item_id, line.quantity, line.quantity)
        ON CONFLICT (sales_order_item_id) DO UPDATE
        SET qty_reserved = GREATEST(public.erp_stock_reservations.qty_reserved,
                                    public.erp_stock_reservations.qty_open + EXCLUDED.qty_open),
            qty_open = public.erp_stock_reservations.qty_open + EXCLUDED.qty_open,
            status = 'active', release_reason = '', updated_at = now();
      END IF;
    END IF;
  END LOOP;

  UPDATE public.erp_fulfillment_events SET reversed_by_event_id = reversal_id WHERE id = original.id;

  PERFORM set_config('erp.correction', 'on', true);
  IF original.kind = 'purchase_receipt' AND po_row.status = 'received' THEN
    UPDATE public.erp_purchase_orders SET status = 'approved', updated_at = now() WHERE id = po_row.id;
  ELSIF original.kind = 'sales_delivery' AND so_row.status = 'delivered' THEN
    UPDATE public.erp_sales_orders SET status = 'invoiced', updated_at = now() WHERE id = so_row.id;
  END IF;
  PERFORM set_config('erp.correction', 'off', true);

  RETURN reversal_id;
END;
$$;

-- ─── 11. Grants ───────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.erp_adjust_stock(UUID, public.stock_movement_type, INTEGER, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_create_sales_order_v2(UUID, UUID, TEXT, DATE, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_create_sales_order(UUID, TEXT, DATE, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_update_sales_order_items(UUID, JSONB, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_create_purchase_order_v2(UUID, UUID, TEXT, DATE, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_create_purchase_order(UUID, TEXT, DATE, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_record_sales_delivery(UUID, JSONB, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_record_purchase_receipt(UUID, JSONB, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_update_purchase_order_status(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_deliver_sales_order(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_cancel_sales_order(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_cancel_purchase_order(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_reverse_fulfillment_event(UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_adjust_stock(UUID, public.stock_movement_type, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_sales_order_v2(UUID, UUID, TEXT, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_sales_order(UUID, TEXT, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_update_sales_order_items(UUID, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_purchase_order_v2(UUID, UUID, TEXT, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_purchase_order(UUID, TEXT, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_record_sales_delivery(UUID, JSONB, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_record_purchase_receipt(UUID, JSONB, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_update_purchase_order_status(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_deliver_sales_order(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_cancel_sales_order(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_cancel_purchase_order(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_reverse_fulfillment_event(UUID, TEXT, UUID) TO authenticated;

-- ─── 12. Backfill reservations for orders that are still open ────────────────
-- Existing open orders are reserved as they stand, without rejecting them:
-- any shortfall they already had shows up as negative availability instead
-- of blocking the migration or the users who created them.

INSERT INTO public.erp_stock_reservations
  (workspace_id, user_id, product_id, sales_order_id, sales_order_item_id, qty_reserved, qty_open)
SELECT o.workspace_id, o.user_id, i.product_id, o.id, i.id, i.qty - i.qty_delivered, i.qty - i.qty_delivered
FROM public.erp_sales_order_items i
JOIN public.erp_sales_orders o ON o.id = i.sales_order_id
WHERE o.status IN ('draft', 'invoiced') AND i.product_id IS NOT NULL AND i.qty - i.qty_delivered > 0
ON CONFLICT (sales_order_item_id) DO NOTHING;
