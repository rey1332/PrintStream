-- ─── Inventory costing, purchase tax and warehouses ─────────────────────────
-- Additive; nothing changes for existing users until they use the features.
--
-- 1. Moving-average cost. Products carry avg_cost, updated on every purchase
--    receipt (and its reversal). Each receipt/delivery line records the unit
--    cost used, so cost of goods sold is auditable. Deliveries and stock
--    adjustments are valued at the average cost (purchase price as a fallback
--    until the first receipt).
-- 2. Purchase tax (input VAT/PPN). Purchase orders carry a tax rate (the
--    workspace default when created; 0 unless set). The order total becomes
--    net + tax; receipts post Dr Inventory/Expenses (net) + Dr Input tax,
--    Cr Accounts payable (gross). Approval thresholds keep using the net total.
-- 3. Warehouses. Every owner gets a default warehouse holding all existing
--    stock. Stock per warehouse follows every change of on-hand quantity
--    (receipts add to the default warehouse; issues take from the default one
--    first, then others). Stock can be transferred between warehouses.
--
-- Rollback: supabase/snippets/rollback_20260930000000_erp_inventory_costing.sql

-- ─── 1. Moving-average cost ───────────────────────────────────────────────────

ALTER TABLE public.erp_products ADD COLUMN IF NOT EXISTS avg_cost NUMERIC(15,4) NOT NULL DEFAULT 0;
ALTER TABLE public.erp_fulfillment_event_lines ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(15,4);

DO $$
BEGIN
  PERFORM set_config('erp.maintenance', 'on', true);
  UPDATE public.erp_products SET avg_cost = purchase_price WHERE avg_cost = 0 AND purchase_price > 0;
  PERFORM set_config('erp.maintenance', 'off', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp__unit_cost(p_product_id UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(NULLIF(avg_cost, 0), purchase_price, 0) FROM public.erp_products WHERE id = p_product_id;
$$;

-- Unit cost of a receipt (PO price) or delivery (current average) line.
CREATE OR REPLACE FUNCTION public.erp_fulfillment_line_cost()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.unit_cost IS NULL THEN
    IF NEW.purchase_order_item_id IS NOT NULL THEN
      SELECT price INTO NEW.unit_cost FROM public.erp_purchase_order_items WHERE id = NEW.purchase_order_item_id;
    ELSIF NEW.product_id IS NOT NULL THEN
      NEW.unit_cost := public.erp__unit_cost(NEW.product_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Receipts move the average towards the purchase price. Stock has already
-- been changed when the line is written.
CREATE OR REPLACE FUNCTION public.erp_update_average_cost()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  reversal BOOLEAN;
  p public.erp_products;
  before_qty NUMERIC;
  new_avg NUMERIC;
BEGIN
  IF NEW.purchase_order_item_id IS NULL OR NEW.product_id IS NULL OR NEW.unit_cost IS NULL THEN RETURN NULL; END IF;
  SELECT is_reversal INTO reversal FROM public.erp_fulfillment_events WHERE id = NEW.event_id;
  SELECT * INTO p FROM public.erp_products WHERE id = NEW.product_id FOR UPDATE;
  IF NOT FOUND OR p.current_stock <= 0 THEN RETURN NULL; END IF;
  IF reversal THEN
    before_qty := p.current_stock + NEW.quantity;
    new_avg := (before_qty * COALESCE(NULLIF(p.avg_cost, 0), NEW.unit_cost) - NEW.quantity * NEW.unit_cost) / p.current_stock;
  ELSE
    before_qty := p.current_stock - NEW.quantity;
    new_avg := (GREATEST(before_qty, 0) * COALESCE(NULLIF(p.avg_cost, 0), NEW.unit_cost) + NEW.quantity * NEW.unit_cost)
               / (GREATEST(before_qty, 0) + NEW.quantity);
  END IF;
  UPDATE public.erp_products SET avg_cost = round(GREATEST(new_avg, 0), 4) WHERE id = p.id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.erp__unit_cost(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_fulfillment_line_cost() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_update_average_cost() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_erp_fulfillment_line_cost ON public.erp_fulfillment_event_lines;
CREATE TRIGGER trg_erp_fulfillment_line_cost BEFORE INSERT ON public.erp_fulfillment_event_lines
  FOR EACH ROW EXECUTE FUNCTION public.erp_fulfillment_line_cost();
DROP TRIGGER IF EXISTS trg_erp_update_average_cost ON public.erp_fulfillment_event_lines;
CREATE TRIGGER trg_erp_update_average_cost AFTER INSERT ON public.erp_fulfillment_event_lines
  FOR EACH ROW EXECUTE FUNCTION public.erp_update_average_cost();

-- ─── 2. Purchase tax ─────────────────────────────────────────────────────────

ALTER TABLE public.erp_purchase_orders
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE public.erp_accounting_settings
  ADD COLUMN IF NOT EXISTS purchase_tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_purchase_orders_tax_check') THEN
    ALTER TABLE public.erp_purchase_orders ADD CONSTRAINT erp_purchase_orders_tax_check
      CHECK (tax_rate BETWEEN 0 AND 100 AND tax_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_accounting_settings_purchase_tax_check') THEN
    ALTER TABLE public.erp_accounting_settings ADD CONSTRAINT erp_accounting_settings_purchase_tax_check
      CHECK (purchase_tax_rate BETWEEN 0 AND 100);
  END IF;
END;
$$;

-- New orders take the default rate; whenever the ERP functions set the order
-- total from its lines (always the net amount), the tax is added on top.
CREATE OR REPLACE FUNCTION public.erp_apply_purchase_tax()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE rate NUMERIC;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.tax_rate = 0 THEN
      SELECT purchase_tax_rate INTO rate FROM public.erp_accounting_settings WHERE user_id = NEW.user_id;
      NEW.tax_rate := COALESCE(rate, 0);
    END IF;
  ELSIF NEW.total IS NOT DISTINCT FROM OLD.total THEN
    RETURN NEW;
  END IF;
  IF NEW.tax_rate > 0 THEN
    NEW.tax_amount := round(NEW.total * NEW.tax_rate / 100, 2);
    NEW.total := NEW.total + NEW.tax_amount;
  ELSE
    NEW.tax_amount := 0;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_apply_purchase_tax() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_erp_purchase_tax ON public.erp_purchase_orders;
CREATE TRIGGER trg_erp_purchase_tax BEFORE INSERT OR UPDATE OF total ON public.erp_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.erp_apply_purchase_tax();

-- Posting of receipts and deliveries at the recorded unit costs, with input
-- tax on receipts (replaces the version in 20260929000000).
CREATE OR REPLACE FUNCTION public.erp_gl__post_fulfillment(p_event_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ev public.erp_fulfillment_events;
  stock_value NUMERIC := 0;
  other_value NUMERIC := 0;
  rate NUMERIC := 0;
  tax NUMERIC := 0;
  lines JSONB;
  memo TEXT;
BEGIN
  SELECT * INTO ev FROM public.erp_fulfillment_events WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF ev.is_reversal AND ev.reverses_event_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.erp_journal_entries WHERE user_id = ev.user_id AND source_key = ev.kind || ':' || ev.reverses_event_id) THEN
    RETURN public.erp_gl__reverse(ev.user_id, ev.kind || ':' || ev.reverses_event_id, ev.created_at::DATE,
      'Reversal of ' || replace(ev.kind, '_', ' '), ev.kind, ev.id, ev.kind || ':' || ev.id);
  END IF;

  IF ev.kind = 'purchase_receipt' THEN
    SELECT COALESCE(SUM(l.quantity * COALESCE(l.unit_cost, i.price)) FILTER (WHERE l.product_id IS NOT NULL), 0),
           COALESCE(SUM(l.quantity * COALESCE(l.unit_cost, i.price)) FILTER (WHERE l.product_id IS NULL), 0)
    INTO stock_value, other_value
    FROM public.erp_fulfillment_event_lines l
    JOIN public.erp_purchase_order_items i ON i.id = l.purchase_order_item_id
    WHERE l.event_id = ev.id;
    SELECT tax_rate INTO rate FROM public.erp_purchase_orders WHERE id = ev.purchase_order_id;
    tax := round((stock_value + other_value) * COALESCE(rate, 0) / 100, 2);
    lines := jsonb_build_array(
      jsonb_build_object('key', 'inventory', 'debit', stock_value),
      jsonb_build_object('key', 'expenses', 'debit', other_value),
      jsonb_build_object('key', 'tax_in', 'debit', tax),
      jsonb_build_object('key', 'ap', 'credit', stock_value + other_value + tax));
    memo := 'Goods received';
  ELSE
    SELECT COALESCE(SUM(l.quantity * COALESCE(l.unit_cost, public.erp__unit_cost(l.product_id))), 0) INTO stock_value
    FROM public.erp_fulfillment_event_lines l
    WHERE l.event_id = ev.id AND l.product_id IS NOT NULL;
    lines := jsonb_build_array(
      jsonb_build_object('key', 'cogs', 'debit', stock_value),
      jsonb_build_object('key', 'inventory', 'credit', stock_value));
    memo := 'Goods delivered (cost)';
  END IF;

  IF ev.is_reversal THEN
    SELECT jsonb_agg(jsonb_build_object('key', x->>'key', 'debit', x->'credit', 'credit', x->'debit')) INTO lines
    FROM jsonb_array_elements(lines) x;
    memo := 'Reversal: ' || memo;
  END IF;

  RETURN public.erp_gl__post(ev.user_id, ev.created_at::DATE, memo, ev.kind, ev.id, ev.kind || ':' || ev.id, lines);
END;
$$;

-- Stock adjustments at average cost (replaces the version in 20260929000000).
CREATE OR REPLACE FUNCTION public.erp_gl__on_stock_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  value NUMERIC;
  opening BOOLEAN;
BEGIN
  IF NEW.source_type IS NULL OR NEW.source_type NOT IN ('manual_adjustment', 'product_edit') THEN RETURN NULL; END IF;
  value := round(COALESCE(public.erp__unit_cost(NEW.product_id), 0) * NEW.quantity, 2);
  IF value = 0 THEN RETURN NULL; END IF;
  opening := NEW.note LIKE 'Opening stock%';
  PERFORM public.erp_gl__post(NEW.user_id, NEW.movement_date,
    CASE WHEN opening THEN 'Opening stock: ' ELSE 'Stock adjustment: ' END || NEW.product_name,
    CASE WHEN opening THEN 'opening_stock' ELSE 'stock_adjustment' END, NEW.id, 'stock:' || NEW.id,
    CASE WHEN NEW.movement_type::TEXT = 'in'
      THEN public.erp_gl__pair('inventory', CASE WHEN opening THEN 'opening' ELSE 'inventory_adjust' END, value)
      ELSE public.erp_gl__pair('inventory_adjust', 'inventory', value) END);
  RETURN NULL;
END;
$$;

-- New products start with their purchase price as average cost.
CREATE OR REPLACE FUNCTION public.erp_products_initial_cost()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.avg_cost = 0 AND NEW.purchase_price > 0 THEN NEW.avg_cost := NEW.purchase_price; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_products_initial_cost() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_erp_products_initial_cost ON public.erp_products;
CREATE TRIGGER trg_erp_products_initial_cost BEFORE INSERT ON public.erp_products
  FOR EACH ROW EXECUTE FUNCTION public.erp_products_initial_cost();

-- Settings functions gain the default purchase tax rate.
DROP FUNCTION IF EXISTS public.erp_accounting_settings_get(UUID);
CREATE FUNCTION public.erp_accounting_settings_get(p_workspace_id UUID)
RETURNS TABLE (base_currency TEXT, lock_date DATE, sales_tax_rate NUMERIC, purchase_tax_rate NUMERIC, can_manage BOOLEAN, can_post BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE owner UUID := public.erp_gl__scope(p_workspace_id);
BEGIN
  PERFORM public.erp_gl__seed(owner);
  RETURN QUERY
  SELECT s.base_currency, s.lock_date, s.sales_tax_rate, s.purchase_tax_rate,
         owner = auth.uid() OR (p_workspace_id IS NOT NULL AND public.erp_has_permission(p_workspace_id, 'members')),
         owner = auth.uid() OR (p_workspace_id IS NOT NULL AND public.erp_has_permission(p_workspace_id, 'payments'))
  FROM public.erp_accounting_settings s WHERE s.user_id = owner;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_accounting_settings_get(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_accounting_settings_get(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_set_purchase_tax_rate(p_workspace_id UUID, p_rate NUMERIC)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE owner UUID := public.erp_gl__scope(p_workspace_id, CASE WHEN p_workspace_id IS NULL THEN 'read' ELSE 'members' END);
BEGIN
  IF p_rate IS NULL OR p_rate < 0 OR p_rate > 100 THEN
    RAISE EXCEPTION 'Tax rate must be between 0 and 100 percent' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.erp_gl__seed(owner);
  UPDATE public.erp_accounting_settings SET purchase_tax_rate = p_rate, updated_at = now(), updated_by = auth.uid()
  WHERE user_id = owner;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_set_purchase_tax_rate(UUID, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_set_purchase_tax_rate(UUID, NUMERIC) TO authenticated;

-- ─── 3. Warehouses ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.erp_warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL,
  code TEXT NOT NULL CHECK (code ~ '^[0-9A-Za-z._-]{1,20}$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, code)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_warehouses_default ON public.erp_warehouses(user_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS public.erp_warehouse_stock (
  warehouse_id UUID NOT NULL REFERENCES public.erp_warehouses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.erp_products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (warehouse_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_erp_warehouse_stock_product ON public.erp_warehouse_stock(product_id);

CREATE TABLE IF NOT EXISTS public.erp_stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE SET NULL,
  product_id UUID REFERENCES public.erp_products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  from_warehouse_id UUID NOT NULL REFERENCES public.erp_warehouses(id),
  to_warehouse_id UUID NOT NULL REFERENCES public.erp_warehouses(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_warehouse_id <> to_warehouse_id)
);
CREATE INDEX IF NOT EXISTS idx_erp_stock_transfers_user ON public.erp_stock_transfers(user_id, created_at DESC);

DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['erp_warehouses', 'erp_stock_transfers'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_erp_assign_workspace ON public.%I', target);
    EXECUTE format(
      'CREATE TRIGGER trg_erp_assign_workspace BEFORE INSERT OR UPDATE OF user_id, workspace_id ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.erp_assign_workspace()', target);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%s ON public.%I', target, target);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_%s AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn()', target, target);
  END LOOP;
END;
$$;

ALTER TABLE public.erp_warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_warehouse_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_stock_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_warehouses, public.erp_warehouse_stock, public.erp_stock_transfers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_warehouses, public.erp_warehouse_stock, public.erp_stock_transfers TO authenticated;

DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['erp_warehouses', 'erp_stock_transfers'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', target || '_read', target);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ('
      'user_id = (SELECT auth.uid()) OR (workspace_id IS NOT NULL AND public.erp_has_permission(workspace_id, ''read'')))',
      target || '_read', target);
  END LOOP;
END;
$$;
DROP POLICY IF EXISTS erp_warehouse_stock_read ON public.erp_warehouse_stock;
CREATE POLICY erp_warehouse_stock_read ON public.erp_warehouse_stock
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.erp_warehouses w WHERE w.id = warehouse_id));

-- The owner's default warehouse (created on first use).
CREATE OR REPLACE FUNCTION public.erp_wh__default(p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE wh UUID;
BEGIN
  SELECT id INTO wh FROM public.erp_warehouses WHERE user_id = p_user_id AND is_default;
  IF wh IS NULL THEN
    INSERT INTO public.erp_warehouses (user_id, code, name, is_default)
    VALUES (p_user_id, 'MAIN', 'Main warehouse', true)
    ON CONFLICT DO NOTHING;
    SELECT id INTO wh FROM public.erp_warehouses WHERE user_id = p_user_id AND is_default;
  END IF;
  RETURN wh;
END;
$$;

-- Applies a change of on-hand quantity to the warehouses: additions go to the
-- default warehouse; removals come from the default first, then the others.
CREATE OR REPLACE FUNCTION public.erp_wh__apply(p_user_id UUID, p_product_id UUID, p_delta INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  default_wh UUID := public.erp_wh__default(p_user_id);
  remaining INTEGER := -p_delta;
  row RECORD;
  take INTEGER;
BEGIN
  IF p_delta = 0 THEN RETURN; END IF;
  IF p_delta > 0 THEN
    INSERT INTO public.erp_warehouse_stock (warehouse_id, product_id, quantity) VALUES (default_wh, p_product_id, p_delta)
    ON CONFLICT (warehouse_id, product_id) DO UPDATE SET quantity = erp_warehouse_stock.quantity + p_delta;
    RETURN;
  END IF;
  FOR row IN
    SELECT s.warehouse_id, s.quantity FROM public.erp_warehouse_stock s
    JOIN public.erp_warehouses w ON w.id = s.warehouse_id
    WHERE s.product_id = p_product_id AND w.user_id = p_user_id AND s.quantity > 0
    ORDER BY w.is_default DESC, w.code
    FOR UPDATE OF s
  LOOP
    EXIT WHEN remaining <= 0;
    take := LEAST(row.quantity, remaining);
    UPDATE public.erp_warehouse_stock SET quantity = quantity - take
    WHERE warehouse_id = row.warehouse_id AND product_id = p_product_id;
    remaining := remaining - take;
  END LOOP;
  -- Product stock itself never goes negative, so this only happens if the
  -- warehouse rows were out of step; keep them consistent with the total.
  IF remaining > 0 THEN
    PERFORM public.erp_wh__resync(p_product_id);
  END IF;
END;
$$;

-- Rebuilds a product's warehouse rows so they add up to its on-hand stock.
CREATE OR REPLACE FUNCTION public.erp_wh__resync(p_product_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.erp_products;
  placed INTEGER;
BEGIN
  SELECT * INTO p FROM public.erp_products WHERE id = p_product_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(SUM(quantity), 0) INTO placed FROM public.erp_warehouse_stock WHERE product_id = p.id;
  IF placed > p.current_stock THEN
    -- Too much placed: clear non-default rows first is not safe; reset to the default warehouse.
    DELETE FROM public.erp_warehouse_stock WHERE product_id = p.id;
    placed := 0;
  END IF;
  IF p.current_stock > placed THEN
    INSERT INTO public.erp_warehouse_stock (warehouse_id, product_id, quantity)
    VALUES (public.erp_wh__default(p.user_id), p.id, p.current_stock - placed)
    ON CONFLICT (warehouse_id, product_id) DO UPDATE SET quantity = erp_warehouse_stock.quantity + (p.current_stock - placed);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_wh__on_product_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.erp_wh__apply(NEW.user_id, NEW.id,
    NEW.current_stock - CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE OLD.current_stock END);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_wh__default(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_wh__apply(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_wh__resync(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_wh__on_product_stock() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_erp_wh_product_stock ON public.erp_products;
CREATE TRIGGER trg_erp_wh_product_stock AFTER INSERT OR UPDATE OF current_stock ON public.erp_products
  FOR EACH ROW EXECUTE FUNCTION public.erp_wh__on_product_stock();

CREATE OR REPLACE FUNCTION public.erp_create_warehouse(p_workspace_id UUID, p_code TEXT, p_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner UUID := public.erp_gl__scope(p_workspace_id, CASE WHEN p_workspace_id IS NULL THEN 'read' ELSE 'inventory' END);
  new_id UUID;
BEGIN
  PERFORM public.erp_wh__default(owner);
  IF EXISTS (SELECT 1 FROM public.erp_warehouses WHERE user_id = owner AND code = btrim(p_code)) THEN
    RAISE EXCEPTION 'A warehouse with code % already exists', btrim(p_code) USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.erp_warehouses (user_id, code, name) VALUES (owner, btrim(p_code), btrim(p_name))
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_transfer_stock(
  p_product_id UUID, p_from_warehouse UUID, p_to_warehouse UUID, p_quantity INTEGER, p_note TEXT DEFAULT ''
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.erp_products;
  available INTEGER;
  new_id UUID;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero'; END IF;
  IF p_from_warehouse = p_to_warehouse THEN RAISE EXCEPTION 'Choose two different warehouses'; END IF;
  SELECT * INTO p FROM public.erp_products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  PERFORM public.erp__authorize(p.user_id, p.workspace_id, 'inventory', 'Product');
  IF (SELECT count(*) FROM public.erp_warehouses
      WHERE id IN (p_from_warehouse, p_to_warehouse) AND user_id = p.user_id AND is_active) <> 2 THEN
    RAISE EXCEPTION 'Warehouse not found';
  END IF;
  PERFORM public.erp_wh__resync(p.id);
  SELECT quantity INTO available FROM public.erp_warehouse_stock
  WHERE warehouse_id = p_from_warehouse AND product_id = p.id FOR UPDATE;
  IF COALESCE(available, 0) < p_quantity THEN
    RAISE EXCEPTION 'Only % units of % are in that warehouse', COALESCE(available, 0), p.name;
  END IF;
  UPDATE public.erp_warehouse_stock SET quantity = quantity - p_quantity
  WHERE warehouse_id = p_from_warehouse AND product_id = p.id;
  INSERT INTO public.erp_warehouse_stock (warehouse_id, product_id, quantity) VALUES (p_to_warehouse, p.id, p_quantity)
  ON CONFLICT (warehouse_id, product_id) DO UPDATE SET quantity = erp_warehouse_stock.quantity + p_quantity;
  INSERT INTO public.erp_stock_transfers
    (user_id, product_id, product_name, from_warehouse_id, to_warehouse_id, quantity, note, created_by)
  VALUES (p.user_id, p.id, p.name, p_from_warehouse, p_to_warehouse, p_quantity, left(COALESCE(p_note, ''), 500), auth.uid())
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_create_warehouse(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_transfer_stock(UUID, UUID, UUID, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_create_warehouse(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_transfer_stock(UUID, UUID, UUID, INTEGER, TEXT) TO authenticated;

-- Existing stock starts in each owner's default warehouse.
DO $$
DECLARE r RECORD;
BEGIN
  PERFORM set_config('erp.maintenance', 'on', true);
  FOR r IN SELECT id FROM public.erp_products WHERE current_stock > 0 LOOP
    PERFORM public.erp_wh__resync(r.id);
  END LOOP;
  PERFORM set_config('erp.maintenance', 'off', true);
END;
$$;
