-- Decimal quantities and units of measure.
--
-- Quantities were whole numbers (INTEGER) everywhere, so 23.475 m³ or 12.38
-- ton could not be recorded. They become NUMERIC(14,3) (three decimals:
-- kilograms in a ton, liters in a cubic meter) in products, order lines,
-- receipts and deliveries, stock movements, reservations, warehouses and
-- transfers, and in every function that reads or writes them.
--
-- Products get a unit (m³, liter, ton, kg, truckload, piece, hour, day) and an
-- optional density in ton per m³. erp_unit_convert() converts between units
-- of the same kind (kg ↔ ton, liter ↔ m³) and, with a density, between mass
-- and volume (ton ↔ m³). Order lines keep the unit they were ordered in.
-- The app converts what a person types into the product's unit; stock is
-- always kept in the product's unit.
--
-- Rollback: db/rollback/rollback_20261012000015_erp_decimal_quantities_units.sql

-- ─── 1. Units ─────────────────────────────────────────────────────────────────

-- The units ETNA knows; keep in sync with src/lib/units.ts.
CREATE OR REPLACE FUNCTION public.erp_unit_valid(p_unit TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_unit IN ('m3', 'l', 'ton', 'kg', 'rit', 'pcs', 'hour', 'day');
$$;

-- p_qty in p_from expressed in p_to, or NULL when they cannot be converted.
-- Mass: kg, ton (1000 kg). Volume: l, m3 (1000 l). Mass ↔ volume needs the
-- density in ton per m³ (= kg per liter). Other units only convert to
-- themselves.
CREATE OR REPLACE FUNCTION public.erp_unit_convert(p_qty NUMERIC, p_from TEXT, p_to TEXT, p_density NUMERIC DEFAULT NULL)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  from_kind TEXT := CASE WHEN p_from IN ('kg', 'ton') THEN 'mass' WHEN p_from IN ('l', 'm3') THEN 'volume' END;
  to_kind TEXT := CASE WHEN p_to IN ('kg', 'ton') THEN 'mass' WHEN p_to IN ('l', 'm3') THEN 'volume' END;
  base NUMERIC; -- kg for mass, liters for volume
BEGIN
  IF p_qty IS NULL OR p_from IS NULL OR p_to IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_from = p_to THEN
    RETURN p_qty;
  END IF;
  IF from_kind IS NULL OR to_kind IS NULL THEN
    RETURN NULL;
  END IF;
  base := p_qty * CASE p_from WHEN 'ton' THEN 1000 WHEN 'm3' THEN 1000 ELSE 1 END;
  IF from_kind <> to_kind THEN
    IF p_density IS NULL OR p_density <= 0 THEN
      RETURN NULL;
    END IF;
    base := CASE WHEN from_kind = 'mass' THEN base / p_density ELSE base * p_density END;
  END IF;
  RETURN base / CASE p_to WHEN 'ton' THEN 1000 WHEN 'm3' THEN 1000 ELSE 1 END;
END;
$$;

ALTER TABLE public.erp_products
  ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'pcs',
  ADD COLUMN IF NOT EXISTS density NUMERIC(10, 4);
ALTER TABLE public.erp_products DROP CONSTRAINT IF EXISTS erp_products_unit_check;
ALTER TABLE public.erp_products ADD CONSTRAINT erp_products_unit_check CHECK (unit IN ('m3', 'l', 'ton', 'kg', 'rit', 'pcs', 'hour', 'day'));
ALTER TABLE public.erp_products DROP CONSTRAINT IF EXISTS erp_products_density_check;
ALTER TABLE public.erp_products ADD CONSTRAINT erp_products_density_check CHECK (density IS NULL OR (density > 0 AND density <= 30));

ALTER TABLE public.erp_sales_order_items ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'pcs';
ALTER TABLE public.erp_purchase_order_items ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'pcs';
ALTER TABLE public.erp_sales_order_items DROP CONSTRAINT IF EXISTS erp_sales_order_items_unit_check;
ALTER TABLE public.erp_sales_order_items ADD CONSTRAINT erp_sales_order_items_unit_check CHECK (unit IN ('m3', 'l', 'ton', 'kg', 'rit', 'pcs', 'hour', 'day'));
ALTER TABLE public.erp_purchase_order_items DROP CONSTRAINT IF EXISTS erp_purchase_order_items_unit_check;
ALTER TABLE public.erp_purchase_order_items ADD CONSTRAINT erp_purchase_order_items_unit_check CHECK (unit IN ('m3', 'l', 'ton', 'kg', 'rit', 'pcs', 'hour', 'day'));

-- ─── 2. Columns ───────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.erp_inventory_stock;
DROP VIEW IF EXISTS public.erp_product_availability;

-- Triggers limited to a quantity column (UPDATE OF current_stock) block the
-- type change: they are kept aside and recreated unchanged afterwards.
CREATE TEMP TABLE erp_qty_triggers ON COMMIT DROP AS
SELECT t.tgname, t.tgrelid::regclass AS tbl, pg_get_triggerdef(t.oid) AS def
  FROM pg_trigger t
 WHERE NOT t.tgisinternal
   AND EXISTS (
     SELECT 1 FROM unnest(t.tgattr::smallint[]) AS k(attnum)
       JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum
      WHERE (t.tgrelid, a.attname) IN (
        ('public.erp_products'::regclass, 'current_stock'), ('public.erp_products'::regclass, 'min_stock'),
        ('public.erp_products'::regclass, 'max_stock'),
        ('public.erp_sales_order_items'::regclass, 'qty'), ('public.erp_sales_order_items'::regclass, 'qty_delivered'),
        ('public.erp_purchase_order_items'::regclass, 'qty'), ('public.erp_purchase_order_items'::regclass, 'qty_received'),
        ('public.erp_stock_movements'::regclass, 'quantity'), ('public.erp_stock_reservations'::regclass, 'qty_reserved'),
        ('public.erp_stock_reservations'::regclass, 'qty_open'), ('public.erp_fulfillment_event_lines'::regclass, 'quantity'),
        ('public.erp_warehouse_stock'::regclass, 'quantity'), ('public.erp_stock_transfers'::regclass, 'quantity')));

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT * FROM erp_qty_triggers LOOP
    EXECUTE format('DROP TRIGGER %I ON %s', t.tgname, t.tbl);
  END LOOP;
END;
$$;

-- The line subtotals are generated from qty; they are rebuilt after the type change.
ALTER TABLE public.erp_sales_order_items DROP COLUMN IF EXISTS subtotal;
ALTER TABLE public.erp_purchase_order_items DROP COLUMN IF EXISTS subtotal;

ALTER TABLE public.erp_products
  ALTER COLUMN current_stock TYPE NUMERIC(14, 3),
  ALTER COLUMN min_stock TYPE NUMERIC(14, 3),
  ALTER COLUMN max_stock TYPE NUMERIC(14, 3);
ALTER TABLE public.erp_sales_order_items
  ALTER COLUMN qty TYPE NUMERIC(14, 3),
  ALTER COLUMN qty_delivered TYPE NUMERIC(14, 3);
ALTER TABLE public.erp_purchase_order_items
  ALTER COLUMN qty TYPE NUMERIC(14, 3),
  ALTER COLUMN qty_received TYPE NUMERIC(14, 3);
ALTER TABLE public.erp_stock_movements ALTER COLUMN quantity TYPE NUMERIC(14, 3);
ALTER TABLE public.erp_stock_reservations
  ALTER COLUMN qty_reserved TYPE NUMERIC(14, 3),
  ALTER COLUMN qty_open TYPE NUMERIC(14, 3);
ALTER TABLE public.erp_fulfillment_event_lines ALTER COLUMN quantity TYPE NUMERIC(14, 3);
ALTER TABLE public.erp_warehouse_stock ALTER COLUMN quantity TYPE NUMERIC(14, 3);
ALTER TABLE public.erp_stock_transfers ALTER COLUMN quantity TYPE NUMERIC(14, 3);

ALTER TABLE public.erp_sales_order_items
  ADD COLUMN subtotal NUMERIC GENERATED ALWAYS AS (round(qty * price, 2)) STORED;
ALTER TABLE public.erp_purchase_order_items
  ADD COLUMN subtotal NUMERIC GENERATED ALWAYS AS (round(qty * price, 2)) STORED;

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT * FROM erp_qty_triggers LOOP
    EXECUTE t.def;
  END LOOP;
END;
$$;

-- As before, with numeric quantities and the product's unit.
CREATE VIEW public.erp_product_availability WITH (security_invoker = true) AS
SELECT p.id AS product_id,
       p.user_id,
       p.workspace_id,
       p.current_stock AS on_hand,
       COALESCE(r.reserved, 0)::NUMERIC(14, 3) AS reserved,
       (p.current_stock - COALESCE(r.reserved, 0))::NUMERIC(14, 3) AS available,
       p.unit
  FROM public.erp_products p
  LEFT JOIN (
    SELECT s.product_id, sum(s.qty_open) AS reserved
      FROM public.erp_stock_reservations s
     WHERE s.status = 'active'
     GROUP BY s.product_id
  ) r ON r.product_id = p.id;

CREATE VIEW public.erp_inventory_stock WITH (security_invoker = true) AS
SELECT p.id,
       p.user_id,
       p.workspace_id,
       p.name,
       p.sku,
       p.category,
       p.created_at,
       p.current_stock,
       p.min_stock,
       p.max_stock,
       COALESCE(NULLIF(p.avg_cost, 0), NULLIF(p.purchase_price, 0), 0)::NUMERIC(15, 4) AS unit_cost,
       COALESCE(r.reserved, 0)::NUMERIC(14, 3) AS reserved,
       (p.current_stock - COALESCE(r.reserved, 0))::NUMERIC(14, 3) AS available,
       round(p.current_stock * COALESCE(NULLIF(p.avg_cost, 0), NULLIF(p.purchase_price, 0), 0), 2) AS stock_value,
       (p.current_stock - COALESCE(r.reserved, 0)) <= p.min_stock AS needs_reorder,
       GREATEST(0, p.max_stock - p.current_stock + COALESCE(r.reserved, 0))::NUMERIC(14, 3) AS suggested_qty,
       p.unit
  FROM public.erp_products p
  LEFT JOIN (
    SELECT s.product_id, sum(s.qty_open) AS reserved
      FROM public.erp_stock_reservations s
     WHERE s.status = 'active'
     GROUP BY s.product_id
  ) r ON r.product_id = p.id;

REVOKE ALL ON public.erp_product_availability, public.erp_inventory_stock FROM PUBLIC, anon;
GRANT SELECT ON public.erp_product_availability, public.erp_inventory_stock TO authenticated;

-- ─── 3. Functions ─────────────────────────────────────────────────────────────

-- Rewrites a function from its current definition. Each pair is
-- (text to find, replacement); a pair that matches nothing stops the migration,
-- so a function that changed since is never half-converted.
CREATE OR REPLACE FUNCTION pg_temp.erp_patch(p_fn REGPROCEDURE, p_pairs TEXT[])
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  body TEXT := pg_get_functiondef(p_fn);
  i INTEGER;
BEGIN
  FOR i IN 1 .. COALESCE(array_length(p_pairs, 1), 0) BY 2 LOOP
    IF position(p_pairs[i] IN body) = 0 THEN
      RAISE EXCEPTION 'erp_patch: % does not contain: %', p_fn, p_pairs[i];
    END IF;
    body := replace(body, p_pairs[i], p_pairs[i + 1]);
  END LOOP;
  RETURN body;
END;
$$;

DO $$
BEGIN
  -- Same signature: replaced in place.
  EXECUTE pg_temp.erp_patch('public.erp__apply_purchase_receipt(public.erp_purchase_orders, jsonb, uuid, text, text)'::regprocedure,
    ARRAY['l(item_id UUID, qty INTEGER)', 'l(item_id UUID, qty NUMERIC)']);
  EXECUTE pg_temp.erp_patch('public.erp__apply_sales_delivery(public.erp_sales_orders, jsonb, uuid, text, text)'::regprocedure,
    ARRAY['l(item_id UUID, qty INTEGER)', 'l(item_id UUID, qty NUMERIC)',
          'stock_now INTEGER;', 'stock_now NUMERIC;',
          'line.product_name, stock_now, line.qty;', 'line.product_name, trim_scale(stock_now), trim_scale(line.qty);']);
  EXECUTE pg_temp.erp_patch('public.erp__reserve_sales_order(uuid)'::regprocedure,
    ARRAY['reserved_elsewhere INTEGER;', 'reserved_elsewhere NUMERIC;',
          'available INTEGER;', 'available NUMERIC;',
          '::INTEGER AS qty', ' AS qty',
          'need.name, GREATEST(available, 0), need.qty;', 'need.name, trim_scale(GREATEST(available, 0)), trim_scale(need.qty);']);
  EXECUTE pg_temp.erp_patch('public.erp__validate_fulfillment_lines(text, uuid, jsonb)'::regprocedure,
    ARRAY['line_qty INTEGER;', 'line_qty NUMERIC;',
          'remaining INTEGER;', 'remaining NUMERIC;',
          '(line->>''qty'')::INTEGER', 'round((line->>''qty'')::NUMERIC, 3)',
          'item_name, GREATEST(remaining, 0);', 'item_name, trim_scale(GREATEST(remaining, 0));']);
  EXECUTE pg_temp.erp_patch('public.erp_products_stock_ledger()'::regprocedure,
    ARRAY['DECLARE delta INTEGER;', 'DECLARE delta NUMERIC;']);
  EXECUTE pg_temp.erp_patch('public.erp_reverse_fulfillment_event(uuid, text, uuid)'::regprocedure,
    ARRAY['stock_now INTEGER;', 'stock_now NUMERIC;',
          'line.product_name, stock_now;', 'line.product_name, trim_scale(stock_now);']);
  EXECUTE pg_temp.erp_patch('public.erp_wh__resync(uuid)'::regprocedure,
    ARRAY['placed INTEGER;', 'placed NUMERIC;']);
  -- Values of fractional quantities are rounded to cents before posting, so
  -- each line of the journal entry is in cents and it still balances.
  EXECUTE pg_temp.erp_patch('public.erp_gl__post_fulfillment(uuid)'::regprocedure,
    ARRAY['SELECT tax_rate INTO rate FROM public.erp_purchase_orders WHERE id = ev.purchase_order_id;',
          'stock_value := round(stock_value, 2); other_value := round(other_value, 2); SELECT tax_rate INTO rate FROM public.erp_purchase_orders WHERE id = ev.purchase_order_id;',
          'jsonb_build_object(''key'', ''cogs'', ''debit'', stock_value),', 'jsonb_build_object(''key'', ''cogs'', ''debit'', round(stock_value, 2)),',
          'jsonb_build_object(''key'', ''inventory'', ''credit'', stock_value));', 'jsonb_build_object(''key'', ''inventory'', ''credit'', round(stock_value, 2)));']);
  -- Order lines: three decimals, rounded line totals, and the unit.
  EXECUTE pg_temp.erp_patch('public.erp__insert_order_items(text, uuid, uuid, jsonb)'::regprocedure,
    ARRAY['item_qty INTEGER;', 'item_qty NUMERIC;
  item_unit TEXT;',
          '(item->>''qty'')::INTEGER', 'round((item->>''qty'')::NUMERIC, 3)',
          'SELECT name INTO canonical_product_name FROM public.erp_products', 'SELECT name, unit INTO canonical_product_name, item_unit FROM public.erp_products',
          'IF canonical_product_name = '''' THEN RAISE EXCEPTION ''Product name is required''; END IF;',
          'IF canonical_product_name = '''' THEN RAISE EXCEPTION ''Product name is required''; END IF;
      item_unit := CASE WHEN public.erp_unit_valid(item->>''unit'') THEN item->>''unit'' ELSE ''pcs'' END;',
          'order_total := order_total + item_qty * item_price;', 'order_total := order_total + round(item_qty * item_price, 2);',
          '(sales_order_id, product_id, product_name, qty, price)', '(sales_order_id, product_id, product_name, qty, price, unit)',
          '(purchase_order_id, product_id, product_name, qty, price)', '(purchase_order_id, product_id, product_name, qty, price, unit)',
          'VALUES (p_order_id, item_product_id, canonical_product_name, item_qty, item_price);', 'VALUES (p_order_id, item_product_id, canonical_product_name, item_qty, item_price, item_unit);']);

  -- New argument or result types: created next to the old ones, which are then dropped.
  EXECUTE pg_temp.erp_patch('public.erp__change_stock(uuid, integer)'::regprocedure,
    ARRAY['p_delta integer)', 'p_delta numeric)',
          ' RETURNS integer', ' RETURNS numeric',
          'DECLARE next_stock INTEGER;', 'DECLARE next_stock NUMERIC;']);
  EXECUTE pg_temp.erp_patch('public.erp_wh__apply(uuid, uuid, integer)'::regprocedure,
    ARRAY['p_delta integer)', 'p_delta numeric)',
          'remaining INTEGER :=', 'remaining NUMERIC :=',
          'take INTEGER;', 'take NUMERIC;']);
  EXECUTE pg_temp.erp_patch('public.erp_sync__set_stock(public.erp_products, integer, text, timestamp with time zone)'::regprocedure,
    ARRAY['p_level integer,', 'p_level numeric,',
          'DECLARE delta INTEGER :=', 'DECLARE delta NUMERIC :=']);
  EXECUTE pg_temp.erp_patch('public.erp_transfer_stock(uuid, uuid, uuid, integer, text)'::regprocedure,
    ARRAY['p_quantity integer,', 'p_quantity numeric,',
          'available INTEGER;', 'available NUMERIC;',
          'COALESCE(available, 0), p.name;', 'trim_scale(COALESCE(available, 0)), p.name;',
          'IF p_quantity IS NULL OR p_quantity <= 0 THEN', 'p_quantity := round(p_quantity, 3);
  IF p_quantity IS NULL OR p_quantity <= 0 THEN']);
  EXECUTE pg_temp.erp_patch('public.erp_adjust_stock(uuid, public.stock_movement_type, integer, text)'::regprocedure,
    ARRAY['p_quantity integer,', 'p_quantity numeric,',
          'IF p_quantity IS NULL OR p_quantity <= 0 THEN', 'p_quantity := round(p_quantity, 3);
  IF p_quantity IS NULL OR p_quantity <= 0 THEN']);
END;
$$;

DROP FUNCTION public.erp__change_stock(UUID, INTEGER);
DROP FUNCTION public.erp_wh__apply(UUID, UUID, INTEGER);
DROP FUNCTION public.erp_sync__set_stock(public.erp_products, INTEGER, TEXT, TIMESTAMPTZ);
DROP FUNCTION public.erp_transfer_stock(UUID, UUID, UUID, INTEGER, TEXT);
DROP FUNCTION public.erp_adjust_stock(UUID, public.stock_movement_type, INTEGER, TEXT);

-- Products sync their unit and density between ERPs too.
CREATE OR REPLACE FUNCTION public.erp_sync__fields(p_entity TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_entity
    WHEN 'customers' THEN ARRAY['name', 'email', 'phone', 'address', 'city']
    WHEN 'suppliers' THEN ARRAY['name', 'email', 'phone', 'address', 'city']
    WHEN 'products' THEN ARRAY['name', 'sku', 'category', 'purchase_price', 'selling_price', 'min_stock', 'max_stock', 'unit', 'density']
  END;
$$;

-- ─── 4. Grants ────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.erp__change_stock(UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_wh__apply(UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__set_stock(public.erp_products, NUMERIC, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_transfer_stock(UUID, UUID, UUID, NUMERIC, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_adjust_stock(UUID, public.stock_movement_type, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_transfer_stock(UUID, UUID, UUID, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_adjust_stock(UUID, public.stock_movement_type, NUMERIC, TEXT) TO authenticated;
-- For the app and later functions (the CHECK constraints list the units themselves).
REVOKE ALL ON FUNCTION public.erp_unit_valid(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_unit_convert(NUMERIC, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_unit_valid(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_unit_convert(NUMERIC, TEXT, TEXT, NUMERIC) TO authenticated;
